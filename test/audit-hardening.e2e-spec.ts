import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
  Prisma,
  PrismaClient,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import { DiningTablesService } from '../src/app/dining-tables/dining-tables.service';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { TakeawayService } from '../src/app/orders/takeaway.service';
import { OrderPolicyService } from '../src/app/orders/order-policy.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { PaymentsService } from '../src/app/payments/payments.service';
import { AuthorizationService } from '../src/app/authorization/authorization.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Audit hardening (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const databaseName = `hardening_${randomUUID().replaceAll('-', '')}_test`;
  let admin: PrismaClient | undefined;
  let base: PrismaService | undefined;
  let prisma: ExtendedPrismaClient;
  let orders: OrdersService;
  let employeeId: string;
  let created = false;
  const config = new ConfigService({
    JWT_SECRET: 'hardening-test-secret-not-for-production',
  });
  const outbox = new OutboxService();
  const pagination = new PaginationUtilService();

  beforeAll(async () => {
    const target = new URL(originalUrl ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use only a dedicated loopback test database.',
    );
    admin = new PrismaClient({ datasources: { db: { url: target.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: process.env, stdio: 'pipe' },
    );
    base = new PrismaService();
    await base.$connect();
    prisma = base.getExtendedClient();
    const position = await prisma.position.create({
      data: { name: 'Hardening fixture', salary: 0 },
    });
    const employee = await prisma.employee.create({
      data: {
        positionId: position.id,
        email: 'hardening@example.test',
        username: 'hardening',
        fullName: 'Hardening fixture',
        password: 'not-used-for-login',
      },
    });
    employeeId = employee.id;
    orders = new OrdersService(
      prisma,
      outbox,
      new OrderPolicyService(),
      {} as never,
      {} as never,
      {} as never,
      pagination,
      new TakeawayService(prisma, pagination, config),
      {} as never,
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await base?.$disconnect();
    } finally {
      if (originalUrl) process.env.DATABASE_URL = originalUrl;
      else delete process.env.DATABASE_URL;
      try {
        if (created)
          await admin?.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin?.$disconnect();
      }
    }
  });

  it('allows one concurrent transfer and rejects a stale transfer/clear after table reuse', async () => {
    const tables = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        prisma.diningTable.create({
          data: {
            name: `Transfer ${index}`,
            status: index === 0 ? TableStatus.OCCUPIED : TableStatus.EMPTY,
          },
        }),
      ),
    );
    const old = await prisma.orderSession.create({
      data: { tableId: tables[0].id, employeeId },
    });
    const results = await Promise.allSettled(
      tables.slice(1, 3).map((table) =>
        orders.transferTable(
          {
            sourceOrderSessionId: old.id,
            fromTableId: tables[0].id,
            toTableId: table.id,
          },
          employeeId,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const current = await prisma.orderSession.create({
      data: { tableId: tables[0].id, employeeId },
    });
    await prisma.diningTable.update({
      where: { id: tables[0].id },
      data: { status: TableStatus.OCCUPIED },
    });
    await expect(
      orders.transferTable(
        {
          sourceOrderSessionId: old.id,
          fromTableId: tables[0].id,
          toTableId: tables[3].id,
        },
        employeeId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      orders.clearTable(tables[0].id, old.id, employeeId, 'Customer cancelled'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await prisma.orderSession.findUnique({ where: { id: current.id } }),
    ).toMatchObject({
      tableId: tables[0].id,
      sessionStatus: SessionStatus.ACTIVE,
    });
    expect(
      await prisma.diningTable.findUnique({ where: { id: tables[3].id } }),
    ).toMatchObject({ status: TableStatus.EMPTY });
  });

  it('rejects merging into a different customer at the destination table', async () => {
    const source = await prisma.diningTable.create({
      data: { name: 'Merge source', status: TableStatus.OCCUPIED },
    });
    const target = await prisma.diningTable.create({
      data: { name: 'Merge target', status: TableStatus.OCCUPIED },
    });
    const sourceSession = await prisma.orderSession.create({
      data: { tableId: source.id, employeeId },
    });
    const oldTarget = await prisma.orderSession.create({
      data: {
        tableId: target.id,
        employeeId,
        sessionStatus: SessionStatus.COMPLETED,
      },
    });
    const newTarget = await prisma.orderSession.create({
      data: { tableId: target.id, employeeId },
    });
    await expect(
      orders.mergeTables(
        {
          sourceTableIds: [source.id],
          sourceOrderSessionIds: [sourceSession.id],
          destinationTableId: target.id,
          destinationOrderSessionId: oldTarget.id,
        },
        employeeId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await prisma.orderSession.findUnique({ where: { id: sourceSession.id } }),
    ).toMatchObject({ sessionStatus: SessionStatus.ACTIVE });
    expect(
      await prisma.orderSession.findUnique({ where: { id: newTarget.id } }),
    ).toMatchObject({ sessionStatus: SessionStatus.ACTIVE });
  });

  it('does not soft-delete a table claimed after its empty snapshot was read', async () => {
    const snapshot = await prisma.diningTable.create({
      data: { name: 'Delete race' },
    });
    await prisma.orderSession.create({
      data: { tableId: snapshot.id, employeeId },
    });
    await prisma.diningTable.update({
      where: { id: snapshot.id },
      data: { status: TableStatus.OCCUPIED },
    });
    const tables = new DiningTablesService({
      diningTable: {
        findFirst: () => Promise.resolve(snapshot),
        updateMany: (args: Prisma.DiningTableUpdateManyArgs) =>
          prisma.diningTable.updateMany(args),
      },
    } as never);
    await expect(tables.deleteTable(snapshot.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(
      await prisma.diningTable.findUnique({ where: { id: snapshot.id } }),
    ).toMatchObject({ status: TableStatus.OCCUPIED, deletedAt: null });
  });

  it('persists one payment URL and recovers it without calling the provider again', async () => {
    const fund = await prisma.fund.create({
      data: { name: 'Payment fixture', type: 'CASH', balance: 0 },
    });
    const shift = await prisma.cashierShift.create({
      data: { employeeId, fundId: fund.id, startingCash: 0 },
    });
    const session = await prisma.orderSession.create({ data: { employeeId } });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'RECOVERY-001',
        orderSessionId: session.id,
        employeeId,
        subTotal: 10,
        totalAmount: 10,
      },
    });
    const provider = {
      assertConfigured: jest.fn(),
      createPaymentUrl: jest
        .fn()
        .mockResolvedValue('https://sandbox.vnpayment.vn/payment?fixture=1'),
    };
    const payments = new PaymentsService(
      prisma,
      config,
      pagination,
      { requireOpenShift: () => Promise.resolve({ id: shift.id }) } as never,
      { reserveInvoiceStock: jest.fn().mockResolvedValue(undefined) } as never,
      outbox,
      provider as never,
      {
        get: () => provider,
        createPaymentUrl: provider.createPaymentUrl,
      } as never,
      {} as never,
      {} as never,
    );
    const attempt = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: randomUUID(),
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    expect(
      (
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        })
      ).paymentUrl,
    ).toBe(attempt.paymentUrl);
    expect((await payments.findAttempt(attempt.id)).paymentUrl).toBeNull();
    expect((await payments.recoverPaymentLink(attempt.id)).paymentUrl).toBe(
      attempt.paymentUrl,
    );
    expect(provider.createPaymentUrl).toHaveBeenCalledTimes(1);
    expect(
      await prisma.paymentAttempt.count({ where: { invoiceId: invoice.id } }),
    ).toBe(1);
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        providerTransactionNo: 'fixture-confirmed-transaction',
      },
    });
    await expect(
      payments.recoverPaymentLink(attempt.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('observes committed permission revocation without a cache invalidation call', async () => {
    const permission = await prisma.permission.create({
      data: { key: '/menu_read', name: 'Menu read' },
    });
    const role = await prisma.role.create({
      data: { name: 'Hardening reader' },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await prisma.employeeRole.create({ data: { roleId: role.id, employeeId } });
    const authorization = new AuthorizationService(prisma);
    expect(await authorization.getPermissionKeys(employeeId)).toEqual([
      '/menu_read',
    ]);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    expect(await authorization.getPermissionKeys(employeeId)).toEqual([]);
  });

  it('deduplicates grants and filters deleted roles/permissions in the flattened query', async () => {
    const active = await prisma.permission.create({
      data: { key: '/inventory_read', name: 'Active' },
    });
    const deleted = await prisma.permission.create({
      data: { key: '/menu_update', name: 'Deleted', deletedAt: new Date() },
    });
    const hidden = await prisma.permission.create({
      data: { key: '/orders_sessions_read', name: 'Deleted role grant' },
    });
    const a = await prisma.role.create({ data: { name: 'Active A' } });
    const b = await prisma.role.create({ data: { name: 'Active B' } });
    const c = await prisma.role.create({
      data: { name: 'Deleted C', deletedAt: new Date() },
    });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: a.id, permissionId: active.id },
        { roleId: b.id, permissionId: active.id },
        { roleId: b.id, permissionId: deleted.id },
        { roleId: c.id, permissionId: hidden.id },
      ],
    });
    await prisma.employeeRole.createMany({
      data: [a, b, c].map((role) => ({ employeeId, roleId: role.id })),
    });
    const authorization = new AuthorizationService(prisma);
    const grants = await authorization.getAuthorizationContext(employeeId);
    expect(grants.permissionKeys).toEqual(['/inventory_read']);
    expect(grants.roleNames).not.toContain(c.name);
    await prisma.employee.update({
      where: { id: employeeId },
      data: { isActive: false },
    });
    await expect(
      authorization.getAuthorizationContext(employeeId),
    ).rejects.toThrow();
    await prisma.employee.update({
      where: { id: employeeId },
      data: { isActive: true },
    });
  });

  it('cleans at most 500 published events and preserves pending/dead letters and valid auth tokens', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const event = {
      topic: 'test',
      eventName: 'test.retention',
      aggregateType: 'Fixture',
      aggregateId: 'retention',
      payload: {},
    };
    await prisma.outboxEvent.createMany({
      data: Array.from({ length: 501 }, () => ({
        ...event,
        status: 'PUBLISHED' as const,
        publishedAt: daysAgo(31),
      })),
    });
    const pending = await prisma.outboxEvent.create({
      data: {
        ...event,
        occurredAt: daysAgo(90),
        availableAt: new Date(Date.now() + 86_400_000),
      },
    });
    const dead = await prisma.outboxEvent.create({
      data: {
        ...event,
        status: 'DEAD_LETTER',
        occurredAt: daysAgo(90),
        lastError: 'fixture failure',
        attempts: 5,
      },
    });
    const old = await prisma.authSession.create({
      data: {
        employeeId,
        familyId: randomUUID(),
        refreshTokenHash: randomUUID(),
        expiresAt: daysAgo(31),
      },
    });
    const valid = await prisma.authSession.create({
      data: {
        employeeId,
        familyId: randomUUID(),
        refreshTokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: new Date(),
        revokeReason: 'REFRESH_ROTATED',
      },
    });
    const reset = await prisma.passwordResetToken.create({
      data: { employeeId, tokenHash: randomUUID(), expiresAt: daysAgo(8) },
    });
    const dispatcher = new OutboxDispatcherService(
      prisma,
      new ConfigService(),
      new DomainEventBusService(),
    );
    await dispatcher.drainOnce();
    expect(
      await prisma.outboxEvent.count({
        where: { status: 'PUBLISHED', publishedAt: { lt: daysAgo(30) } },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: pending.id } }),
    ).toMatchObject({ status: 'PENDING' });
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: dead.id } }),
    ).toMatchObject({ status: 'DEAD_LETTER' });
    expect(
      await prisma.authSession.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await prisma.authSession.findUnique({ where: { id: valid.id } }),
    ).not.toBeNull();
    expect(
      await prisma.passwordResetToken.findUnique({ where: { id: reset.id } }),
    ).toBeNull();
  });
});
