import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { seedActivity } from '../prisma/activity-data';
import { seedCatalog } from '../prisma/catalog-data';

jest.setTimeout(60_000);

describe('Local activity import (isolated PostgreSQL)', () => {
  const name = `activity_${randomUUID().replaceAll('-', '')}_test`;
  const options = { seed: 20261022, through: '2005-03-31' };
  let admin: PrismaClient | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
      'Use a dedicated loopback test database.',
    );
    admin = new PrismaClient({ datasources: { db: { url: url.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: { ...process.env, DATABASE_URL: url.href },
        stdio: 'pipe',
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
    await prisma.position.create({
      data: { name: 'Cashier', salary: 7000000 },
    });
    await seedCatalog(prisma, options.seed);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    try {
      if (created)
        await admin?.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin?.$disconnect();
    }
  });

  it('previews without writes and rolls back prior inserts when an existing fund conflicts', async () => {
    const db = prisma!;
    const before = await db.inventoryItem.findMany({ orderBy: { id: 'asc' } });
    const preview = await seedActivity(db, options);
    expect(preview.applied).toBe(false);
    expect(await db.employee.count()).toBe(0);
    expect(await db.customer.count()).toBe(0);
    expect(await db.invoice.count()).toBe(0);
    expect(await db.inventoryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    const conflict = await db.fund.create({
      data: { name: 'Quy thu ngan 02', type: 'CASH' },
    });
    await expect(seedActivity(db, options, true)).rejects.toThrow();
    expect(await db.employee.count()).toBe(0);
    expect(await db.actionLog.count()).toBe(0);
    expect(await db.inventoryItem.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    await db.fund.delete({ where: { id: conflict.id } });
  });

  it('commits coherent ledgers once and preserves all selling flags and external queues', async () => {
    const db = prisma!;
    const selling = await db.menuItem.findMany({
      select: { id: true, price: true, isAvailable: true },
      orderBy: { id: 'asc' },
    });
    const result = await seedActivity(db, options, true);
    expect(result.applied).toBe(true);
    expect(await db.customer.count()).toBe(50);
    expect(await db.cashierShift.count({ where: { status: 'CLOSED' } })).toBe(
      30,
    );
    expect(
      await db.purchaseReceipt.count({ where: { status: 'POSTED' } }),
    ).toBe(5);
    expect(
      await db.orderSession.count({ where: { sessionStatus: 'ACTIVE' } }),
    ).toBe(0);
    expect(await db.inventoryReservation.count()).toBe(0);
    expect(await db.outboxEvent.count()).toBe(0);
    expect(await db.paymentAttempt.count()).toBe(0);
    expect(await db.customerSession.count()).toBe(0);
    expect(await db.printJob.count()).toBe(0);
    expect(
      await db.menuItem.findMany({
        select: { id: true, price: true, isAvailable: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(selling);
    const [invalid] = await db.$queryRaw<
      Array<{ stock: bigint; invoices: bigint; cash: bigint; shifts: bigint }>
    >`
      SELECT
        (SELECT count(*) FROM "InventoryItem" i WHERE i."stock" <> COALESCE((
          SELECT sum(CASE WHEN t."type"='IMPORT' THEN t."quantity" ELSE -t."quantity" END)
          FROM "InventoryTransaction" t WHERE t."inventoryItemId"=i."id"),0)) AS stock,
        (SELECT count(*) FROM "Invoice" i WHERE i."totalAmount" <> (
          SELECT sum(o."priceAtTime"*o."quantity") FROM "OrderItem" o WHERE o."invoiceId"=i."id")) AS invoices,
        (SELECT count(*) FROM "Fund" f WHERE f."balance" <> (
          SELECT sum(CASE WHEN t."type"='INCOME' THEN t."amount" ELSE -t."amount" END)
          FROM "CashTransaction" t WHERE t."fundId"=f."id")) AS cash,
        (SELECT count(*) FROM "CashierShift" s WHERE s."actualEndingCash" <> s."expectedStartingCash" + COALESCE((
          SELECT sum(CASE WHEN t."type"='INCOME' THEN t."amount" ELSE -t."amount" END)
          FROM "CashTransaction" t WHERE t."shiftId"=s."id"),0)) AS shifts
    `;
    expect(invalid).toEqual({ stock: 0n, invoices: 0n, cash: 0n, shifts: 0n });
    const markers = await db.actionLog.findMany({
      where: { actionType: 'LOCAL_ACTIVITY_SEEDED' },
    });
    expect(markers).toHaveLength(1);
    const movements = await db.inventoryTransaction.count();
    const invoices = await db.invoice.count();
    const replay = await seedActivity(db, options, true);
    expect(replay).toMatchObject({ applied: false, alreadyApplied: true });
    expect(await db.inventoryTransaction.count()).toBe(movements);
    expect(await db.invoice.count()).toBe(invoices);
    await expect(
      seedActivity(db, { ...options, seed: 7 }, true),
    ).rejects.toThrow(/different parameters/);
    expect(
      await db.actionLog.findMany({
        where: { actionType: 'LOCAL_ACTIVITY_SEEDED' },
      }),
    ).toEqual(markers);
  });
});
