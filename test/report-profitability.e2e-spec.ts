import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  PaymentAttemptStatus,
  PaymentRefundStatus,
  PaymentStatus,
  ServeStatus,
} from '@prisma/client';
import { DailySalesCloseService } from '../src/app/reports/daily-sales-close.service';
import { queryProfitability } from '../src/app/reports/profitability.query';

describe('Daily sales profitability (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const ids: Record<string, string> = {};
  const period = {
    from: new Date('2020-01-01T00:00:00.000Z'),
    to: new Date('2020-01-02T00:00:00.000Z'),
  };

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Profitability position ${suffix}`, salary: 0 },
    });
    ids.position = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `profitability-${suffix}@example.com`,
        username: `profitability-${suffix}`,
        fullName: 'Profitability Test Employee',
        password: 'not-used-in-report-tests',
        positionId: position.id,
      },
    });
    ids.employee = employee.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Profitability category ${suffix}` },
    });
    ids.menuCategory = category.id;
    const item = await prisma.menuItem.create({
      data: {
        name: `Profitability item ${suffix}`,
        price: 100,
        categoryId: category.id,
      },
    });
    ids.menuItem = item.id;
    const inventoryCategory = await prisma.inventoryCategory.create({
      data: { name: `Profitability inventory ${suffix}` },
    });
    ids.inventoryCategory = inventoryCategory.id;
    const unit = await prisma.unit.create({
      data: { name: `Profitability unit ${suffix}` },
    });
    ids.unit = unit.id;
    const ingredient = await prisma.inventoryItem.create({
      data: {
        name: `Profitability ingredient ${suffix}`,
        categoryId: inventoryCategory.id,
        unitId: unit.id,
      },
    });
    ids.ingredient = ingredient.id;
    const session = await prisma.orderSession.create({
      data: { employeeId: employee.id },
    });
    ids.session = session.id;
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `PROFIT-${suffix}`,
        subTotal: 100,
        totalAmount: 110,
        taxAmount: 10,
        taxRate: 10,
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        orderSessionId: session.id,
        employeeId: employee.id,
        createdAt: new Date('2020-01-01T06:00:00.000Z'),
      },
    });
    ids.invoice = invoice.id;
    const soldItem = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: item.id,
        invoiceId: invoice.id,
        quantity: 1,
        priceAtTime: 100,
        serveStatus: ServeStatus.SERVED,
      },
    });
    ids.soldItem = soldItem.id;
    await prisma.orderItemIngredientSnapshot.create({
      data: {
        orderItemId: soldItem.id,
        inventoryItemId: ingredient.id,
        inventoryItemName: ingredient.name,
        unitName: unit.name,
        quantityPerItem: 1,
        totalQuantity: 1,
        unitCost: 30,
        totalCost: 30,
      },
    });
    const cancelledItem = await prisma.orderItem.create({
      data: {
        orderSessionId: session.id,
        menuItemId: item.id,
        quantity: 1,
        priceAtTime: 10,
        serveStatus: ServeStatus.CANCELLED,
      },
    });
    ids.cancelledItem = cancelledItem.id;
    await prisma.orderItemIngredientSnapshot.create({
      data: {
        orderItemId: cancelledItem.id,
        inventoryItemId: ingredient.id,
        inventoryItemName: ingredient.name,
        unitName: unit.name,
        quantityPerItem: 1,
        totalQuantity: 1,
        unitCost: 10,
        totalCost: 10,
      },
    });
    await prisma.inventoryWaste.create({
      data: {
        orderItemId: cancelledItem.id,
        inventoryItemId: ingredient.id,
        quantity: 1,
        reason: 'Cancelled after preparation',
        employeeId: employee.id,
        createdAt: new Date('2020-01-01T07:00:00.000Z'),
      },
    });
    const shift = await prisma.cashierShift.create({
      data: { employeeId: employee.id, startingCash: 0 },
    });
    ids.shift = shift.id;
    const attempt = await prisma.paymentAttempt.create({
      data: {
        status: PaymentAttemptStatus.SUCCEEDED,
        amount: 110,
        merchantReference: `PROFIT-${suffix}`,
        idempotencyKey: `attempt-${suffix}`,
        requestHash: 'test-request-hash',
        providerTransactionNo: `PROFIT-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        completedAt: new Date(),
        invoiceId: invoice.id,
        createdById: employee.id,
        shiftId: shift.id,
      },
    });
    ids.attempt = attempt.id;
    const refund = await prisma.paymentRefund.create({
      data: {
        status: PaymentRefundStatus.SUCCEEDED,
        type: 'PARTIAL',
        amount: 22,
        reason: 'Test refund',
        idempotencyKey: `refund-${suffix}`,
        requestHash: 'test-refund-hash',
        providerRequestId: `PROFIT-REFUND-${suffix}`,
        requestedAt: new Date('2020-01-01T13:00:00.000Z'),
        completedAt: new Date('2020-01-01T14:00:00.000Z'),
        paymentAttemptId: attempt.id,
        requestedById: employee.id,
      },
    });
    ids.refund = refund.id;
  });

  afterAll(async () => {
    try {
      if (ids.refund)
        await prisma.paymentRefund.delete({ where: { id: ids.refund } });
      if (ids.attempt)
        await prisma.paymentAttempt.delete({ where: { id: ids.attempt } });
      if (ids.shift)
        await prisma.cashierShift.delete({ where: { id: ids.shift } });
      if (ids.cancelledItem) {
        await prisma.inventoryWaste.deleteMany({
          where: { orderItemId: ids.cancelledItem },
        });
      }
      if (ids.soldItem || ids.cancelledItem) {
        await prisma.orderItemIngredientSnapshot.deleteMany({
          where: {
            orderItemId: {
              in: [ids.soldItem, ids.cancelledItem].filter(Boolean),
            },
          },
        });
        await prisma.orderItem.deleteMany({
          where: {
            id: { in: [ids.soldItem, ids.cancelledItem].filter(Boolean) },
          },
        });
      }
      if (ids.invoice)
        await prisma.invoice.delete({ where: { id: ids.invoice } });
      if (ids.session)
        await prisma.orderSession.delete({ where: { id: ids.session } });
      if (ids.ingredient)
        await prisma.inventoryItem.delete({ where: { id: ids.ingredient } });
      if (ids.inventoryCategory)
        await prisma.inventoryCategory.delete({
          where: { id: ids.inventoryCategory },
        });
      if (ids.unit) await prisma.unit.delete({ where: { id: ids.unit } });
      if (ids.menuItem)
        await prisma.menuItem.delete({ where: { id: ids.menuItem } });
      if (ids.menuCategory)
        await prisma.menuCategory.delete({ where: { id: ids.menuCategory } });
      if (ids.employee)
        await prisma.employee.delete({ where: { id: ids.employee } });
      if (ids.position)
        await prisma.position.delete({ where: { id: ids.position } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('allocates a partial refund pro rata and uses immutable ingredient costs', async () => {
    const [beforeRefund, afterRefund] = await prisma.$transaction(
      async (tx) => [
        await queryProfitability(
          tx as never,
          period,
          new Date('2020-01-01T12:00:00.000Z'),
        ),
        await queryProfitability(
          tx as never,
          period,
          new Date('2020-01-01T18:00:00.000Z'),
        ),
      ],
    );

    expect(beforeRefund).toMatchObject({
      refundCount: 0,
      netReceipts: '110.00',
      estimatedNetSalesExTax: '100.00',
      ingredientCost: '30.00',
      wasteCost: '10.00',
      estimatedGrossProfit: '60.00',
      soldItemCount: 1,
      itemsWithCostSnapshot: 1,
    });
    expect(afterRefund).toMatchObject({
      refundCount: 1,
      refundAmount: '22.00',
      netReceipts: '88.00',
      estimatedNetSalesExTax: '80.00',
      estimatedGrossProfit: '40.00',
    });
  });

  it('creates a close from real SQL and rolls it back with its audit log', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const scopedPrisma = {
          $transaction: (callback: (client: typeof tx) => Promise<unknown>) =>
            callback(tx),
          $queryRaw: tx.$queryRaw.bind(tx),
        };
        const service = new DailySalesCloseService(scopedPrisma as never);
        const result = await service.close('2020-01-01', ids.employee);
        expect(result.snapshot).toMatchObject({
          estimatedGrossProfit: '40.00',
        });
        expect(result.refundDeltaSinceClose).toEqual({
          count: 0,
          amount: '0.00',
        });
        throw new Error('rollback test fixture');
      }),
    ).rejects.toThrow('rollback test fixture');
    expect(await prisma.dailySalesClose.count()).toBe(0);
  });

  it('rejects updates to a closed snapshot at the database boundary', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const close = await tx.dailySalesClose.create({
          data: {
            businessDate: new Date('2020-01-01T00:00:00.000Z'),
            periodStart: new Date('2019-12-31T17:00:00.000Z'),
            periodEnd: new Date('2020-01-01T17:00:00.000Z'),
            closedAt: new Date('2020-01-02T00:00:00.000Z'),
            snapshot: { estimatedGrossProfit: '40.00' },
            closedById: ids.employee,
          },
        });
        await tx.dailySalesClose.update({
          where: { id: close.id },
          data: { snapshot: { estimatedGrossProfit: '999.00' } },
        });
      }),
    ).rejects.toThrow();
    expect(await prisma.dailySalesClose.count()).toBe(0);
  });
});
