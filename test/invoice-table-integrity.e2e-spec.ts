import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import {
  PrismaClient,
  PaymentStatus,
  DiscountType,
  TableStatus,
} from '@prisma/client';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { InvoiceNumberService } from '../src/app/invoices/invoice-number.service';
import { InvoicePolicyService } from '../src/app/invoices/invoice-policy.service';
import { InvoicesService } from '../src/app/invoices/invoices.service';
import { readInvoiceSnapshot } from '../src/app/invoices/invoice-snapshot';
import { OrdersService } from '../src/app/orders/orders.service';
import { PrintingService } from '../src/app/printing/printing.service';
import { OrderPolicyService } from '../src/app/orders/order-policy.service';
import { TakeawayService } from '../src/app/orders/takeaway.service';
import { PromotionCalculatorService } from '../src/app/promotions/services/promotion-calculator.service';
import { PromotionPolicyService } from '../src/app/promotions/policies/promotion-policy.service';
import { PromotionsRepository } from '../src/app/promotions/repositories/promotions.repository';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Invoice and table integrity (isolated PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const prefix = `invoice-integrity-${randomUUID()}`;
  const ids: Record<string, string> = {};
  let invoices: InvoicesService;
  let orders: OrdersService;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use a dedicated loopback test database.',
    );
    const position = await prisma.position.create({
      data: { name: prefix, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        positionId: position.id,
        email: `${prefix}@example.test`,
        username: prefix,
        fullName: 'Invoice cashier',
        password: 'not-used-for-login',
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: prefix },
    });
    ids.category = category.id;
    const menu = await prisma.menuItem.create({
      data: { name: `${prefix}-coffee`, categoryId: category.id, price: 50000 },
    });
    ids.menu = menu.id;
    const outbox = new OutboxService();
    const idempotency = new IdempotencyService(prisma as never);
    const inventory = {
      reservePendingItems: async () => {},
      releaseReservations: async () => {},
    };
    invoices = new InvoicesService(
      prisma as never,
      {} as never,
      {} as never,
      new InvoicePolicyService(),
      new InvoiceNumberService(),
      idempotency,
      outbox,
      new PromotionCalculatorService(
        new PromotionsRepository(prisma as never),
        new PromotionPolicyService(),
      ),
      {} as never,
      inventory as never,
    );
    const pagination = new PaginationUtilService();
    orders = new OrdersService(
      prisma as never,
      outbox,
      new OrderPolicyService(),
      inventory as never,
      {} as never,
      {} as never,
      pagination,
      new TakeawayService(prisma as never, pagination, new ConfigService()),
      idempotency,
      new PrintingService(prisma as never, pagination, idempotency, invoices),
    );
  });

  afterAll(async () => {
    // This suite owns only its prefixed fixtures, never a business database.
    if (ids.employee) {
      const sessions = await prisma.orderSession.findMany({
        where: { employeeId: ids.employee },
        select: { id: true },
      });
      const sessionIds = sessions.map((session) => session.id);
      const tables = await prisma.diningTable.findMany({
        where: { name: { startsWith: prefix } },
        select: { id: true },
      });
      const bills = await prisma.invoice.findMany({
        where: { orderSessionId: { in: sessionIds } },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: {
            in: [
              ...sessionIds,
              ...bills.map((bill) => bill.id),
              ...Object.values(ids),
              ...tables.map((table) => table.id),
            ],
          },
        },
      });
      await prisma.orderItem.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.invoice.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.promotion.deleteMany({
        where: { name: { startsWith: prefix } },
      });
      await prisma.orderSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      await prisma.diningTable.deleteMany({
        where: { name: { startsWith: prefix } },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({ where: { employeeId: ids.employee } });
      });
      await prisma.menuItem.deleteMany({ where: { id: ids.menu } });
      await prisma.menuCategory.deleteMany({ where: { id: ids.category } });
      await prisma.employee.deleteMany({ where: { id: ids.employee } });
      await prisma.position.deleteMany({ where: { id: ids.position } });
    }
    await prisma.$disconnect();
  });

  async function fixture(quantity = 2) {
    const table = await prisma.diningTable.create({
      data: { name: `${prefix}-${randomUUID()}`, status: TableStatus.OCCUPIED },
    });
    const session = await prisma.orderSession.create({
      data: { tableId: table.id, employeeId: ids.employee },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: ids.menu,
        quantity,
        priceAtTime: 50000,
      },
    });
    return { table, session, item };
  }

  it('preserves voided items and table/name snapshots when operational rows are re-billed', async () => {
    const { table, session, item } = await fixture();
    const original = await invoices.createInvoice(ids.employee, {
      orderSessionId: session.id,
    });
    const snapshot = readInvoiceSnapshot(original.documentSnapshot)!;
    expect(snapshot.items[0]).toMatchObject({
      orderItemId: item.id,
      quantity: 2,
      unitPrice: '50000.00',
    });
    await invoices.voidInvoice(original.id, ids.employee, {
      reason: 'Reissue invoice',
    });
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }))
        .invoiceId,
    ).toBeNull();
    await prisma.menuItem.update({
      where: { id: ids.menu },
      data: { name: `${prefix}-renamed` },
    });
    await prisma.diningTable.update({
      where: { id: table.id },
      data: { name: `${prefix}-renamed-${randomUUID()}` },
    });
    const replacement = await invoices.createInvoice(ids.employee, {
      orderSessionId: session.id,
    });
    expect(replacement.id).not.toBe(original.id);
    const historical = await invoices.getInvoiceById(original.id);
    expect(historical.orderItems).toHaveLength(0);
    expect(historical.documentSnapshot).toEqual(snapshot);
    expect(historical.paymentStatus).toBe(PaymentStatus.VOIDED);
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId: ids.employee,
          actionType: 'INVOICE_VOIDED',
          details: { path: ['invoiceId'], equals: original.id },
        },
      }),
    ).toBe(1);
  });

  it('rejects a stale quote after a concurrent partial table split, without creating an invoice', async () => {
    const { session, item } = await fixture();
    const destination = await prisma.diningTable.create({
      data: { name: `${prefix}-${randomUUID()}` },
    });
    const quote = await invoices.quoteInvoice(ids.employee, {
      orderSessionId: session.id,
      orderItemIds: [item.id],
    });
    await orders.splitTable(
      {
        sourceOrderSessionId: session.id,
        destinationTableId: destination.id,
        itemsToMove: [
          {
            orderItemId: item.id,
            quantityToMove: 1,
            expectedOriginalQuantity: 2,
          },
        ],
      },
      ids.employee,
    );
    await expect(
      invoices.createInvoice(ids.employee, {
        orderSessionId: session.id,
        orderItemIds: [item.id],
        quoteFingerprint: quote.quoteFingerprint,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVOICE_QUOTE_CHANGED' } });
    expect(
      await prisma.invoice.count({ where: { orderSessionId: session.id } }),
    ).toBe(0);
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } }))
        .invoiceId,
    ).toBeNull();
    const fresh = await invoices.quoteInvoice(ids.employee, {
      orderSessionId: session.id,
    });
    const accepted = await invoices.createInvoice(ids.employee, {
      orderSessionId: session.id,
      quoteFingerprint: fresh.quoteFingerprint,
    });
    expect(accepted.totalAmount.toString()).toBe('50000');
  });

  it('keeps database snapshots immutable even when code tries to overwrite them', async () => {
    const { session } = await fixture(1);
    const invoice = await invoices.createInvoice(ids.employee, {
      orderSessionId: session.id,
    });
    await expect(
      prisma.invoice.update({
        where: { id: invoice.id },
        data: { documentSnapshot: { version: 1, items: [] } },
      }),
    ).rejects.toThrow();
    expect(
      (await invoices.getInvoiceById(invoice.id)).documentSnapshot,
    ).toEqual(invoice.documentSnapshot);
  });

  it('backfills legacy invoices with and without promotions, without inventing lost voided lines', async () => {
    const { session, item } = await fixture(1);
    const promotion = await prisma.promotion.create({
      data: {
        name: `${prefix}-promotion`,
        discountType: DiscountType.PERCENTAGE,
        discountValue: 10,
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2027-01-01T00:00:00Z'),
      },
    });
    const old = await prisma.invoice.create({
      data: {
        invoiceNumber: `${prefix}-legacy`,
        promotionId: promotion.id,
        orderSessionId: session.id,
        employeeId: ids.employee,
        subTotal: 50000,
        totalAmount: 50000,
      },
    });
    await prisma.orderItem.update({
      where: { id: item.id },
      data: { invoiceId: old.id },
    });
    const empty = await prisma.invoice.create({
      data: {
        invoiceNumber: `${prefix}-legacy-void`,
        orderSessionId: session.id,
        employeeId: ids.employee,
        subTotal: 10000,
        totalAmount: 10000,
        paymentStatus: PaymentStatus.VOIDED,
      },
    });
    const migration = readFileSync(
      'prisma/migrations/20261024100000_invoice_document_snapshot/migration.sql',
      'utf8',
    );
    const backfill = migration.slice(
      migration.indexOf('UPDATE "Invoice"'),
      migration.indexOf('ALTER TABLE "Invoice" ADD CONSTRAINT'),
    );
    // The real migration runs once; exclude already frozen documents in this fixture replay.
    await prisma.$executeRawUnsafe(
      backfill.replace(
        'WHERE s."id" = i."orderSessionId";',
        'WHERE s."id" = i."orderSessionId" AND i."documentSnapshot" IS NULL AND i."id" IN ($1, $2);',
      ),
      old.id,
      empty.id,
    );
    const restored = readInvoiceSnapshot(
      (await invoices.getInvoiceById(old.id)).documentSnapshot,
    )!;
    expect(restored).toMatchObject({
      source: 'LEGACY_BACKFILL',
      promotionName: promotion.name,
      items: [{ orderItemId: item.id }],
    });
    expect(
      readInvoiceSnapshot(
        (await invoices.getInvoiceById(empty.id)).documentSnapshot,
      )!.items,
    ).toEqual([]);
  });

  it('records the actual actor for table transfer, merge and clear', async () => {
    const { table, session } = await fixture(1);
    const destination = await prisma.diningTable.create({
      data: { name: `${prefix}-${randomUUID()}` },
    });
    await orders.transferTable(
      {
        sourceOrderSessionId: session.id,
        fromTableId: table.id,
        toTableId: destination.id,
      },
      ids.employee,
    );
    const source = await fixture(1);
    await orders.mergeTables(
      {
        sourceTableIds: [source.table.id],
        sourceOrderSessionIds: [source.session.id],
        destinationTableId: destination.id,
        destinationOrderSessionId: session.id,
      },
      ids.employee,
    );
    await orders.clearTable(
      destination.id,
      session.id,
      ids.employee,
      'Guests cancelled before preparation',
    );
    const audit = await prisma.actionLog.findMany({
      where: {
        employeeId: ids.employee,
        actionType: {
          in: [
            'ORDER_TABLE_TRANSFERRED',
            'ORDER_TABLES_MERGED',
            'ORDER_TABLE_CLEARED',
          ],
        },
      },
    });
    expect(new Set(audit.map((entry) => entry.actionType))).toEqual(
      new Set([
        'ORDER_TABLE_TRANSFERRED',
        'ORDER_TABLES_MERGED',
        'ORDER_TABLE_CLEARED',
      ]),
    );
    expect(
      audit.find((entry) => entry.actionType === 'ORDER_TABLE_CLEARED')
        ?.details,
    ).toMatchObject({
      reason: 'Guests cancelled before preparation',
      cancelledSessionId: session.id,
    });
  });

  it('rolls back table and outbox changes when the audit cannot be written', async () => {
    const { table, session } = await fixture(1);
    const destination = await prisma.diningTable.create({
      data: { name: `${prefix}-${randomUUID()}` },
    });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ActionLog" ADD CONSTRAINT invoice_test_audit_failure CHECK ("actionType" <> 'ORDER_TABLE_TRANSFERRED') NOT VALID`,
    );
    try {
      await expect(
        orders.transferTable(
          {
            sourceOrderSessionId: session.id,
            fromTableId: table.id,
            toTableId: destination.id,
          },
          ids.employee,
        ),
      ).rejects.toThrow();
      expect(
        (
          await prisma.orderSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).tableId,
      ).toBe(table.id);
      expect(
        (
          await prisma.diningTable.findUniqueOrThrow({
            where: { id: destination.id },
          })
        ).status,
      ).toBe(TableStatus.EMPTY);
      expect(
        await prisma.outboxEvent.count({ where: { aggregateId: session.id } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ActionLog" DROP CONSTRAINT invoice_test_audit_failure',
      );
    }
  });
});
