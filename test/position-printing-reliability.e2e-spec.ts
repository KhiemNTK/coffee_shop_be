import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  ServeStatus,
  SessionStatus,
  TableStatus,
  PrismaClient,
} from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { runSerializableTransaction } from '../src/common/prisma/transaction.util';
import { PositionsService } from '../src/app/positions/positions.service';
import { EmployeesService } from '../src/app/employees/employees.service';
import { PrintingService } from '../src/app/printing/printing.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { OrderPolicyService } from '../src/app/orders/order-policy.service';
import { KitchenRoutingService } from '../src/app/kitchen/kitchen-routing.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';
import { OnlineOrdersService } from '../src/app/online-orders/online-orders.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Position and print reliability (isolated PostgreSQL)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const databaseName = `position_print_${randomUUID().replaceAll('-', '')}_test`;
  let base: PrismaService;
  let db: ExtendedPrismaClient;
  let admin: PrismaClient | undefined;
  let created = false;
  const suffix = randomUUID();
  const pagination = new PaginationUtilService();
  let positions: PositionsService;
  let employees: EmployeesService;
  let printing: PrintingService;
  let orders: OrdersService;
  let onlineOrders: OnlineOrdersService;
  let actorId: string;
  let deviceId: string;
  let ticketId: string;
  let itemId: string;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Dedicated loopback test DB required.',
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
    db = base.getExtendedClient();
    positions = new PositionsService(db, pagination, {} as never);
    employees = new EmployeesService(
      db,
      pagination,
      {} as never,
      { hash: () => Promise.resolve('unused-test-password') } as never,
    );
    printing = new PrintingService(db, pagination, {} as never, {} as never);
    const outbox = new OutboxService();
    const inventory = new InventoryConsumptionService(outbox);
    const idempotency = new IdempotencyService(db);
    orders = new OrdersService(
      db,
      outbox,
      new OrderPolicyService(),
      inventory,
      {} as never,
      new KitchenRoutingService(printing),
      pagination,
      {} as never,
      idempotency,
      printing,
    );
    onlineOrders = new OnlineOrdersService(
      db,
      orders,
      {} as never,
      inventory,
      idempotency,
      outbox,
      pagination,
      new ConfigService({ JWT_SECRET: 'isolated-print-order-test-secret' }),
      {} as never,
      {} as never,
      printing,
    );
    const position = await db.position.create({
      data: { name: `Actor ${suffix}`, salary: 0 },
    });
    const actor = await db.employee.create({
      data: {
        email: `${suffix}@example.test`,
        username: suffix,
        fullName: 'Print operator',
        password: 'not-a-login',
        positionId: position.id,
      },
    });
    actorId = actor.id;
    const device = await db.printDevice.create({
      data: {
        name: suffix,
        type: PrintDeviceType.KITCHEN,
        paperSize: '80mm',
        apiKeyHash: randomBytes(32).toString('hex'),
      },
    });
    deviceId = device.id;
    const station = await db.kitchenStation.create({
      data: { name: suffix, code: suffix, printDeviceId: deviceId },
    });
    const category = await db.menuCategory.create({ data: { name: suffix } });
    const menuItem = await db.menuItem.create({
      data: { name: suffix, price: 25000, categoryId: category.id },
    });
    const session = await db.orderSession.create({
      data: { employeeId: actorId },
    });
    const item = await db.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: menuItem.id,
        quantity: 1,
        priceAtTime: 25000,
      },
    });
    itemId = item.id;
    const ticket = await db.kitchenTicket.create({
      data: {
        stationId: station.id,
        orderSessionId: session.id,
        dueAt: new Date(Date.now() + 300_000),
        items: {
          create: { orderItemId: itemId, itemName: menuItem.name, quantity: 1 },
        },
      },
    });
    ticketId = ticket.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await base?.$disconnect();
    } finally {
      if (originalUrl) process.env.DATABASE_URL = originalUrl;
      else delete process.env.DATABASE_URL;
      try {
        if (created) {
          assert(/^position_print_[a-f0-9]{32}_test$/.test(databaseName));
          await admin!.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
        }
      } finally {
        await admin?.$disconnect();
      }
    }
  });

  const enqueue = async () =>
    base.$transaction((tx) =>
      printing.enqueueKitchenTicket(tx as never, {
        deviceId,
        kitchenTicketId: ticketId,
        availableAt: new Date(Date.now() - 1000),
        payload: {
          items: [{ orderItemId: itemId, name: 'Test coffee', quantity: 1 }],
        },
      }),
    );
  const device = () => ({
    id: deviceId,
    type: PrintDeviceType.KITCHEN,
    status: PrintDeviceStatus.READY,
  });

  it('serializes employee assignment against position soft deletion without leaving a deleted assignment', async () => {
    for (let i = 0; i < 4; i++) {
      const position = await positions.createPosition(
        { name: `Assignment ${suffix} ${i}`, salary: '8500000.01' },
        actorId,
      );
      const results = await Promise.allSettled([
        employees.createEmployee({
          email: `staff-${suffix}-${i}@example.test`,
          username: `staff-${suffix}-${i}`,
          fullName: 'Fixture staff',
          password: 'not-a-login',
          positionId: position.id,
          isActive: true,
        }),
        positions.deletePosition(position.id, actorId),
      ]);
      expect(
        results.filter((entry) => entry.status === 'fulfilled'),
      ).toHaveLength(1);
      const current = await base.position.findUniqueOrThrow({
        where: { id: position.id },
      });
      const assigned = await base.employee.count({
        where: { positionId: position.id, deletedAt: null },
      });
      expect(current.deletedAt === null || assigned === 0).toBe(true);
    }
  });

  it('moves an expired claim to review even without another claim, then accepts a late/repeated acknowledgement', async () => {
    const job = await enqueue();
    const claimed = (await printing.claimJobs(device(), { limit: 1 })).jobs[0];
    expect(claimed.id).toBe(job.id);
    await base.printJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await printing.recoverExpiredLeases();
    const review = await base.printJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(review.status).toBe(PrintJobStatus.REQUIRES_REVIEW);
    expect(
      (await printing.claimJobs(device(), { limit: 1 })).jobs,
    ).toHaveLength(0);
    await printing.completeJob(deviceId, job.id, claimed.leaseToken);
    const printed = await base.printJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    await printing.completeJob(deviceId, job.id, claimed.leaseToken);
    expect(
      (await base.printJob.findUniqueOrThrow({ where: { id: job.id } }))
        .printedAt,
    ).toEqual(printed.printedAt);
    await expect(
      printing.completeJob(deviceId, job.id, 'wrong-token'),
    ).rejects.toBeInstanceOf(ConflictException);
    await base.printJob.delete({ where: { id: job.id } });
  });

  it('requires operator review before retry and rejects an old lease after manual resolution', async () => {
    const job = await enqueue();
    const claim = (await printing.claimJobs(device(), { limit: 1 })).jobs[0];
    await printing.failJob(
      deviceId,
      job.id,
      claim.leaseToken,
      'Socket disconnected after sending bytes',
    );
    const review = await base.printJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(review.status).toBe(PrintJobStatus.REQUIRES_REVIEW);
    await expect(printing.retryJob(job.id, actorId, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    await printing.resolveJob(job.id, actorId, {
      outcome: 'NOT_PRINTED',
      reason: 'Checked spooler, no paper, agent stopped',
      expectedUpdatedAt: review.updatedAt.toISOString(),
    });
    await expect(
      printing.completeJob(deviceId, job.id, claim.leaseToken),
    ).rejects.toBeInstanceOf(ConflictException);
    await printing.retryJob(job.id, actorId, {});
    const next = (await printing.claimJobs(device(), { limit: 1 })).jobs[0];
    expect(next.leaseToken).not.toBe(claim.leaseToken);
    await printing.completeJob(deviceId, job.id, next.leaseToken);
    expect(
      await base.actionLog.count({
        where: { employeeId: actorId, actionType: 'PRINT_JOB_RESOLVED' },
      }),
    ).toBe(1);
    await base.printJob.delete({ where: { id: job.id } });
  });

  it('rolls back print cancellation when the business transaction fails', async () => {
    const job = await enqueue();
    await expect(
      base.$transaction(async (tx) => {
        await printing.cancelKitchenItems(
          tx as never,
          [itemId],
          actorId,
          'Cancel',
        );
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    expect(
      (await base.printJob.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe(PrintJobStatus.PENDING);
    await base.printJob.delete({ where: { id: job.id } });
  });

  it('does not requeue a cancelled original after a definite no-output failure', async () => {
    const job = await enqueue();
    const claimed = (await printing.claimJobs(device(), { limit: 1 })).jobs[0];
    await runSerializableTransaction(db, async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { serveStatus: ServeStatus.CANCELLED },
      });
      await printing.cancelKitchenItems(
        tx,
        [itemId],
        actorId,
        'Customer cancelled',
      );
    });
    await runSerializableTransaction(db, (tx) =>
      printing.cancelKitchenItems(tx, [itemId], actorId, 'Customer cancelled'),
    );
    expect(
      await base.printJob.count({
        where: {
          deduplicationKey: { startsWith: `KITCHEN_CANCELLATION:${job.id}:` },
        },
      }),
    ).toBe(1);
    await expect(
      printing.failJob(
        deviceId,
        job.id,
        claimed.leaseToken,
        'Printer never received data',
        'NOT_PRINTED',
      ),
    ).resolves.toEqual({ success: true, retrying: false });
    expect(
      (await base.printJob.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe(PrintJobStatus.CANCELLED);
    await base.printJob.deleteMany({ where: { kitchenTicketId: ticketId } });
    await base.orderItem.update({
      where: { id: itemId },
      data: { serveStatus: ServeStatus.PENDING },
    });
  });

  it('handles cancellation racing with claim: no stale pending job, or an explicit cancellation notice', async () => {
    for (let i = 0; i < 4; i++) {
      await base.orderItem.update({
        where: { id: itemId },
        data: { serveStatus: ServeStatus.PENDING },
      });
      const job = await enqueue();
      await Promise.all([
        runSerializableTransaction(db, async (tx) => {
          await tx.orderItem.update({
            where: { id: itemId },
            data: { serveStatus: ServeStatus.CANCELLED },
          });
          await printing.cancelKitchenItems(
            tx,
            [itemId],
            actorId,
            'Customer changed order',
          );
        }),
        printing.claimJobs(device(), { limit: 1 }),
      ]);
      const original = await base.printJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      if (original.status !== PrintJobStatus.CANCELLED) {
        expect(original.status).toBe(PrintJobStatus.PROCESSING);
        const notice = await base.printJob.findFirstOrThrow({
          where: {
            deduplicationKey: { startsWith: `KITCHEN_CANCELLATION:${job.id}:` },
          },
        });
        expect(notice.payload).toMatchObject({
          documentType: 'KITCHEN_CANCELLATION',
          originalJobId: job.id,
          items: [{ orderItemId: itemId }],
        });
      }
      expect(
        await base.printJob.count({
          where: { id: job.id, status: PrintJobStatus.PENDING },
        }),
      ).toBe(0);
      await base.printJob.deleteMany({ where: { kitchenTicketId: ticketId } });
    }
  });

  const createOrderFixture = async (dineIn: boolean) => {
    const originalTicket = await base.kitchenTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    const originalItem = await base.orderItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const table = dineIn
      ? await base.diningTable.create({
          data: { name: randomUUID(), status: TableStatus.OCCUPIED },
        })
      : null;
    const session = await base.orderSession.create({
      data: { employeeId: actorId, tableId: table?.id },
    });
    const item = await base.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: originalItem.menuItemId,
        quantity: 2,
        priceAtTime: 25000,
      },
    });
    const ticket = await base.kitchenTicket.create({
      data: {
        stationId: originalTicket.stationId,
        orderSessionId: session.id,
        dueAt: new Date(Date.now() + 300_000),
        items: {
          create: {
            orderItemId: item.id,
            itemName: 'Test coffee',
            quantity: 2,
          },
        },
      },
    });
    const job = await base.$transaction((tx) =>
      printing.enqueueKitchenTicket(tx as never, {
        deviceId,
        kitchenTicketId: ticket.id,
        payload: {
          orderSessionId: session.id,
          tableName: table?.name ?? null,
          items: [{ orderItemId: item.id, name: 'Test coffee', quantity: 2 }],
        },
      }),
    );
    return { table, session, item, ticket, job };
  };

  it('clears a table and cancels its unclaimed kitchen job atomically', async () => {
    const fixture = await createOrderFixture(true);
    const unit = await base.unit.create({ data: { name: randomUUID() } });
    const category = await base.inventoryCategory.create({
      data: { name: randomUUID() },
    });
    const ingredient = await base.inventoryItem.create({
      data: {
        name: randomUUID(),
        unitId: unit.id,
        categoryId: category.id,
        stock: 10,
        reservedStock: 2,
      },
    });
    await base.inventoryReservation.create({
      data: {
        orderItemId: fixture.item.id,
        inventoryItemId: ingredient.id,
        quantity: 2,
      },
    });
    await orders.clearTable(
      fixture.table!.id,
      fixture.session.id,
      actorId,
      'Customer left',
    );
    expect(
      (
        await base.orderItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).serveStatus,
    ).toBe(ServeStatus.CANCELLED);
    expect(
      (
        await base.orderSession.findUniqueOrThrow({
          where: { id: fixture.session.id },
        })
      ).sessionStatus,
    ).toBe(SessionStatus.CANCELLED);
    expect(
      (
        await base.diningTable.findUniqueOrThrow({
          where: { id: fixture.table!.id },
        })
      ).status,
    ).toBe(TableStatus.EMPTY);
    expect(
      (await base.printJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .status,
    ).toBe(PrintJobStatus.CANCELLED);
    expect(
      (await printing.claimJobs(device(), { limit: 10 })).jobs,
    ).toHaveLength(0);
    const remaining = await base.inventoryItem.findUniqueOrThrow({
      where: { id: ingredient.id },
    });
    expect(remaining.stock.toFixed()).toBe('10');
    expect(remaining.reservedStock.toFixed()).toBe('0');
    expect(
      await base.inventoryReservation.count({
        where: { orderItemId: fixture.item.id },
      }),
    ).toBe(0);
    await base.printJob.deleteMany({
      where: { kitchenTicketId: fixture.ticket.id },
    });
  });

  it('submits items once for concurrent retries and rejects reusing the key with a different basket', async () => {
    const fixture = await createOrderFixture(true);
    const dto = {
      idempotencyKey: randomUUID(),
      items: [{ menuItemId: fixture.item.menuItemId, quantity: 1 }],
    };
    const results = await Promise.allSettled([
      orders.addOrderItems(fixture.session.id, dto, actorId),
      orders.addOrderItems(fixture.session.id, dto, actorId),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      await base.orderItem.count({
        where: { orderSessionId: fixture.session.id },
      }),
    ).toBe(2);
    expect(
      await base.idempotencyRequest.count({
        where: {
          employeeId: actorId,
          operation: 'orders.add-items',
          key: dto.idempotencyKey,
        },
      }),
    ).toBe(1);
    await expect(
      orders.addOrderItems(
        fixture.session.id,
        {
          ...dto,
          items: [{ menuItemId: fixture.item.menuItemId, quantity: 3 }],
        },
        actorId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await base.printJob.deleteMany({
      where: { kitchenTicketId: fixture.ticket.id },
    });
  });

  it.each([
    PrintJobStatus.PROCESSING,
    PrintJobStatus.PRINTED,
    PrintJobStatus.REQUIRES_REVIEW,
  ])(
    'cancels an accepted online order with a %s print without losing its cancellation notice',
    async (status) => {
      const fixture = await createOrderFixture(false);
      const claim = (await printing.claimJobs(device(), { limit: 1 })).jobs[0];
      expect(claim.id).toBe(fixture.job.id);
      if (status === PrintJobStatus.PRINTED) {
        await printing.completeJob(deviceId, claim.id, claim.leaseToken);
      } else if (status === PrintJobStatus.REQUIRES_REVIEW) {
        await base.printJob.update({
          where: { id: claim.id },
          data: { leaseExpiresAt: new Date(Date.now() - 1000) },
        });
        await printing.recoverExpiredLeases();
      }
      const request = await base.onlineOrderRequest.create({
        data: {
          clientRequestId: randomUUID(),
          requestHash: randomBytes(32).toString('hex'),
          pickupName: 'Isolated fixture',
          phoneNumber: '0900000000',
          quotedSubtotal: 50000,
          expiresAt: new Date(Date.now() + 300_000),
          orderSessionId: fixture.session.id,
          status: 'ACCEPTED',
          reviewedAt: new Date(),
          reviewedById: actorId,
        },
      });
      await onlineOrders.cancelAccepted(
        request.id,
        actorId,
        'Customer cancelled',
      );
      await onlineOrders.cancelAccepted(
        request.id,
        actorId,
        'Customer cancelled',
      );
      const jobs = await base.printJob.findMany({
        where: { kitchenTicketId: fixture.ticket.id },
      });
      expect(jobs).toHaveLength(2);
      expect(jobs.find((job) => job.id === fixture.job.id)!.status).toBe(
        status,
      );
      expect(
        jobs.find((job) => job.id !== fixture.job.id)!.payload,
      ).toMatchObject({
        documentType: 'KITCHEN_CANCELLATION',
        originalJobId: fixture.job.id,
        items: [{ orderItemId: fixture.item.id, quantity: 2 }],
      });
      expect(
        (
          await base.orderSession.findUniqueOrThrow({
            where: { id: fixture.session.id },
          })
        ).sessionStatus,
      ).toBe(SessionStatus.CANCELLED);
      await base.printJob.deleteMany({
        where: { kitchenTicketId: fixture.ticket.id },
      });
    },
  );

  it('splits queued paper quantities and preserves the moved drink when the original line is cancelled', async () => {
    const fixture = await createOrderFixture(true);
    const destination = await base.diningTable.create({
      data: { name: randomUUID() },
    });
    await orders.splitTable(
      {
        sourceOrderSessionId: fixture.session.id,
        destinationTableId: destination.id,
        itemsToMove: [
          {
            orderItemId: fixture.item.id,
            expectedOriginalQuantity: 2,
            quantityToMove: 1,
          },
        ],
      },
      actorId,
    );
    const moved = await base.orderItem.findFirstOrThrow({
      where: { orderSession: { tableId: destination.id } },
    });
    expect(moved.quantity).toBe(1);
    const original = await base.printJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(original.payload).toMatchObject({
      items: [{ orderItemId: fixture.item.id, quantity: 1 }],
    });
    const movedJob = await base.printJob.findFirstOrThrow({
      where: {
        kitchenTicketId: fixture.ticket.id,
        id: { not: fixture.job.id },
      },
    });
    expect(movedJob.payload).toMatchObject({
      orderSessionId: moved.orderSessionId,
      tableName: destination.name,
      items: [{ orderItemId: moved.id, quantity: 1 }],
    });
    await orders.cancelItem(fixture.item.id, actorId, {
      reason: 'Original customer left',
    });
    expect(
      (await base.printJob.findUniqueOrThrow({ where: { id: fixture.job.id } }))
        .status,
    ).toBe(PrintJobStatus.CANCELLED);
    const claimed = await printing.claimJobs(device(), { limit: 10 });
    expect(claimed.jobs).toHaveLength(1);
    expect(claimed.jobs[0]).toMatchObject({
      id: movedJob.id,
      payload: { items: [{ orderItemId: moved.id, quantity: 1 }] },
    });
    await base.printJob.deleteMany({
      where: { kitchenTicketId: fixture.ticket.id },
    });
  });

  it('keeps partial split and printer claim consistent under a real database race', async () => {
    for (let i = 0; i < 3; i++) {
      const fixture = await createOrderFixture(true);
      const destination = await base.diningTable.create({
        data: { name: randomUUID() },
      });
      const [split, claim] = await Promise.allSettled([
        orders.splitTable(
          {
            sourceOrderSessionId: fixture.session.id,
            destinationTableId: destination.id,
            itemsToMove: [
              {
                orderItemId: fixture.item.id,
                expectedOriginalQuantity: 2,
                quantityToMove: 1,
              },
            ],
          },
          actorId,
        ),
        printing.claimJobs(device(), { limit: 10 }),
      ]);
      expect(claim.status).toBe('fulfilled');
      const item = await base.orderItem.findUniqueOrThrow({
        where: { id: fixture.item.id },
      });
      const jobs = await base.printJob.findMany({
        where: { kitchenTicketId: fixture.ticket.id },
      });
      if (split.status === 'fulfilled') {
        expect(item.quantity).toBe(1);
        expect(jobs).toHaveLength(2);
        for (const job of jobs)
          expect(job.payload).toMatchObject({ items: [{ quantity: 1 }] });
      } else {
        expect(split.reason).toBeInstanceOf(ConflictException);
        expect(item.quantity).toBe(2);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].payload).toMatchObject({
          items: [{ orderItemId: item.id, quantity: 2 }],
        });
        expect(
          (
            await base.diningTable.findUniqueOrThrow({
              where: { id: destination.id },
            })
          ).status,
        ).toBe(TableStatus.EMPTY);
        expect(
          await base.orderSession.count({ where: { tableId: destination.id } }),
        ).toBe(0);
        expect(
          (
            await base.kitchenTicketItem.findUniqueOrThrow({
              where: { orderItemId: item.id },
            })
          ).quantity,
        ).toBe(2);
      }
      await base.printJob.deleteMany({
        where: { kitchenTicketId: fixture.ticket.id },
      });
    }
  });
});
