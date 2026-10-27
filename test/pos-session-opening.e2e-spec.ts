import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { OrdersService } from '../src/app/orders/orders.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';

describe('POS session opening (isolated PostgreSQL)', () => {
  const databaseName = `pos_open_${randomUUID().replaceAll('-', '')}_test`;
  const employeeId = randomUUID();
  let admin: PrismaClient | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let orders: OrdersService;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: url.href }, stdio: 'pipe' },
    );
    prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
    const position = await prisma.position.create({
      data: { name: 'POS test', salary: 0 },
    });
    await prisma.employee.create({
      data: {
        id: employeeId,
        positionId: position.id,
        fullName: 'POS test',
        email: 'pos@example.test',
        username: 'pos-test',
        password: 'not-used-for-login',
      },
    });
    orders = new OrdersService(
      prisma as never,
      new OutboxService(),
      {} as never,
      {} as never,
      { findOpenShiftId: () => Promise.resolve(null) } as never,
      {} as never,
      {} as never,
      {} as never,
      new IdempotencyService(prisma as never),
      {} as never,
    );
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (created)
      await admin?.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin?.$disconnect();
  });

  it('replays a lost reply without creating another session or event', async () => {
    const key = randomUUID();
    const first = await orders.openSession({ employeeId }, key);
    const replay = await orders.openSession({ employeeId, tableId: null }, key);
    expect(replay.id).toBe(first.id);
    expect(await prisma!.orderSession.count()).toBe(1);
    expect(
      await prisma!.outboxEvent.count({ where: { aggregateId: first.id } }),
    ).toBe(1);
    await expect(
      orders.openSession({ employeeId, guestCount: 3 }, key),
    ).rejects.toThrow(ConflictException);
  });

  it('commits exactly one opening when two requests share the same key', async () => {
    const key = randomUUID();
    const results = await Promise.all([
      orders.openSession({ employeeId }, key),
      orders.openSession({ employeeId }, key),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(
      await prisma!.orderSession.count({ where: { id: results[0].id } }),
    ).toBe(1);
    expect(
      await prisma!.outboxEvent.count({
        where: { aggregateId: results[0].id },
      }),
    ).toBe(1);
  });

  it('rolls back the identity when the opening is rejected', async () => {
    const key = randomUUID();
    await expect(
      orders.openSession({ employeeId, tableId: randomUUID() }, key),
    ).rejects.toThrow();
    expect(await prisma!.idempotencyRequest.count({ where: { key } })).toBe(0);
    const session = await orders.openSession({ employeeId }, key);
    expect(session.id).toBeTruthy();
  });
});
