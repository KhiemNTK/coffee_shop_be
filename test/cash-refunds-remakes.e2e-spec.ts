import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CashFlowType,
  FundType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
  ShiftStatus,
} from '@prisma/client';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { CashierShiftsService } from '../src/app/cashier-shifts/cashier-shifts.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';
import { CashRefundsService } from '../src/app/invoices/cash-refunds.service';
import { CreateCashRefundDto } from '../src/app/invoices/dto';
import { KitchenRoutingService } from '../src/app/kitchen/kitchen-routing.service';
import { OrderPolicyService } from '../src/app/orders/order-policy.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { PrintingService } from '../src/app/printing/printing.service';
import { queryProfitability } from '../src/app/reports/profitability.query';
import { queryOnlineOrderJourney } from '../src/app/reports/online-order-journey.query';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Cash refunds and order remakes (real PostgreSQL)', () => {
  const prisma = new PrismaService();
  const db = prisma.getExtendedClient();
  const outbox = new OutboxService();
  const ledger = new CashierShiftLedgerService();
  const pagination = new PaginationUtilService();
  const idempotency = new IdempotencyService(db);
  const refunds = new CashRefundsService(
    db,
    ledger,
    idempotency,
    outbox,
    pagination,
  );
  const shifts = new CashierShiftsService(db, pagination, ledger, idempotency);
  const orders = new OrdersService(
    db,
    outbox,
    new OrderPolicyService(),
    new InventoryConsumptionService(outbox),
    ledger,
    new KitchenRoutingService({} as PrintingService),
    pagination,
    new ConfigService({
      JWT_SECRET: 'test-only-pickup-secret-at-least-32-chars',
    }),
    idempotency,
  );
  const menuIds: string[] = [];
  const ingredientIds: string[] = [];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const items = await prisma.orderItem.findMany({
      where: { orderSessionId: { in: sessionIds } },
      select: { id: true },
    });
    const cashRefunds = await prisma.cashRefund.findMany({
      where: { invoice: { orderSessionId: { in: sessionIds } } },
      select: { id: true },
    });
    const remakes = await prisma.orderRemake.findMany({
      where: { originalItem: { orderSessionId: { in: sessionIds } } },
      select: { id: true },
    });
    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateId: {
          in: [
            ...sessionIds,
            ...items.map(({ id }) => id),
            ...cashRefunds.map(({ id }) => id),
            ...remakes.map(({ id }) => id),
          ],
        },
      },
    });
    await prisma.menuItem.updateMany({
      where: { id: { in: menuIds } },
      data: { deletedAt: new Date(), isAvailable: false },
    });
    await prisma.inventoryItem.updateMany({
      where: { id: { in: ingredientIds } },
      data: { deletedAt: new Date() },
    });
    await prisma.orderItem.updateMany({
      where: {
        orderSessionId: { in: sessionIds },
        serveStatus: {
          in: [ServeStatus.PENDING, ServeStatus.COOKING, ServeStatus.READY],
        },
      },
      data: { serveStatus: ServeStatus.CANCELLED },
    });
  });

  async function fixture() {
    const suffix = randomUUID();
    const from = new Date(Date.UTC(1991, 0, 1) + randomInt(365 * 86_400_000));
    const to = new Date(from.getTime() + 1);
    const position = await prisma.position.create({
      data: { name: `Refund ${suffix}`, salary: 0 },
    });
    const employee = await prisma.employee.create({
      data: {
        email: `${suffix}@cash-test.example`,
        username: `cash-${suffix}`,
        fullName: 'Test manager',
        password: 'not-a-real-password',
        positionId: position.id,
      },
    });
    const fund = await prisma.fund.create({
      data: { name: `Cash ${suffix}`, type: FundType.CASH, balance: 1000 },
    });
    const shift = await prisma.cashierShift.create({
      data: {
        employeeId: employee.id,
        fundId: fund.id,
        startingCash: 1000,
        expectedStartingCash: 1000,
      },
    });
    const session = await prisma.orderSession.create({
      data: {
        employeeId: employee.id,
        shiftId: shift.id,
        sessionStatus: SessionStatus.COMPLETED,
      },
    });
    sessionIds.push(session.id);
    const station = await prisma.kitchenStation.create({
      data: {
        code: `R-${suffix}`,
        name: `Kitchen ${suffix}`,
        prepSlaSeconds: 600,
      },
    });
    const category = await prisma.menuCategory.create({
      data: { name: `Menu ${suffix}` },
    });
    const menu = await prisma.menuItem.create({
      data: {
        name: `Coffee ${suffix}`,
        categoryId: category.id,
        kitchenStationId: station.id,
        price: 50,
      },
    });
    menuIds.push(menu.id);
    const unit = await prisma.unit.create({ data: { name: `Unit ${suffix}` } });
    const inventoryCategory = await prisma.inventoryCategory.create({
      data: { name: `Ingredients ${suffix}` },
    });
    const ingredient = await prisma.inventoryItem.create({
      data: {
        name: `Ingredient ${suffix}`,
        categoryId: inventoryCategory.id,
        unitId: unit.id,
        stock: 20,
        averageUnitCost: 10,
      },
    });
    ingredientIds.push(ingredient.id);
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `CASH-${suffix}`,
        employeeId: employee.id,
        shiftId: shift.id,
        orderSessionId: session.id,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PAID,
        subTotal: 100,
        totalAmount: 100,
        createdAt: from,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        menuItemId: menu.id,
        orderSessionId: session.id,
        invoiceId: invoice.id,
        isPaid: true,
        priceAtTime: 50,
        quantity: 2,
        recipeSnapshottedAt: new Date(),
        recipeIngredients: {
          create: { inventoryItemId: ingredient.id, quantityPerItem: 1 },
        },
      },
    });
    await orders.updateItemStatus(item.id, employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(item.id, employee.id, {
      serveStatus: ServeStatus.READY,
    });
    await orders.handoffTakeawayItem(item.id, employee.id);
    await db.$transaction((tx) =>
      ledger.recordCashInvoice(tx, {
        shift: { id: shift.id, fundId: fund.id },
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        employeeId: employee.id,
        amount: new Prisma.Decimal(100),
      }),
    );
    return {
      employee,
      fund,
      shift,
      session,
      station,
      menu,
      ingredient,
      invoice,
      item,
      from,
      to,
    };
  }

  const refundDto = (amount: string) => ({
    amount,
    reason: 'Customer refund requested',
    idempotencyKey: randomUUID(),
  });

  it('rejects malformed money and unknown fields at the API boundary', () => {
    for (const amount of ['0', '-1', '1.001', 'NaN', '1e3']) {
      expect(
        CreateCashRefundDto.schema.safeParse(refundDto(amount)).success,
      ).toBe(false);
    }
    expect(
      CreateCashRefundDto.schema.safeParse({
        ...refundDto('25'),
        employeeId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('posts partial/full refunds once and retains replay protection after idempotency cleanup', async () => {
    const f = await fixture();
    const dto = refundDto('25');
    const first = await refunds.create(f.invoice.id, f.employee.id, dto);
    expect(
      (
        await refunds.create(f.invoice.id, f.employee.id, {
          ...dto,
          amount: '25.00',
        })
      ).id,
    ).toBe(first.id);
    await prisma.idempotencyRequest.deleteMany({
      where: { employeeId: f.employee.id, operation: 'invoice.cash-refund' },
    });
    expect((await refunds.create(f.invoice.id, f.employee.id, dto)).id).toBe(
      first.id,
    );
    await expect(
      refunds.create(f.invoice.id, f.employee.id, { ...dto, amount: '26' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    await refunds.create(f.invoice.id, f.employee.id, refundDto('75'));
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.REFUNDED);
    expect(
      (
        await prisma.fund.findUniqueOrThrow({ where: { id: f.fund.id } })
      ).balance.toFixed(2),
    ).toBe('1000.00');
    expect(
      await prisma.cashRefund.count({ where: { invoiceId: f.invoice.id } }),
    ).toBe(2);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateType: 'CashRefund', aggregateId: first.id },
      }),
    ).toBe(1);
    expect(
      (await refunds.find(f.invoice.id, { page: 1, itemPerPage: 20 }))
        .totalItems,
    ).toBe(2);
    const profitability = await db.$transaction((tx) =>
      queryProfitability(tx, f, new Date()),
    );
    expect(profitability).toMatchObject({
      refundCount: 2,
      refundAmount: '100.00',
      netReceipts: '0.00',
    });
    const shift = await shifts.getCurrent(f.employee.id);
    expect(shift?.reconciliation.cashRefundAmount.toFixed(2)).toBe('100.00');
    expect(shift?.reconciliation.manualExpense.toFixed(2)).toBe('0.00');
    expect(shift?.reconciliation.actualEndingCash.toFixed(2)).toBe('1000.00');
  });

  it('prevents concurrent refunds from exceeding the paid amount', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      refunds.create(f.invoice.id, f.employee.id, refundDto('60')),
      refunds.create(f.invoice.id, f.employee.id, refundDto('60')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const total = await prisma.cashRefund.aggregate({
      where: { invoiceId: f.invoice.id },
      _sum: { amount: true },
    });
    expect(total._sum.amount?.toFixed(2)).toBe('60.00');
    expect(
      (
        await prisma.fund.findUniqueOrThrow({ where: { id: f.fund.id } })
      ).balance.toFixed(2),
    ).toBe('1040.00');
  });

  it('rolls back fund/invoice/audit when outbox insertion fails', async () => {
    const f = await fixture();
    const auditCount = await prisma.actionLog.count({
      where: { employeeId: f.employee.id },
    });
    jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('50')),
    ).rejects.toThrow('outbox unavailable');
    expect(
      await prisma.cashRefund.count({ where: { invoiceId: f.invoice.id } }),
    ).toBe(0);
    expect(
      await prisma.actionLog.count({ where: { employeeId: f.employee.id } }),
    ).toBe(auditCount);
    expect(
      (
        await prisma.fund.findUniqueOrThrow({ where: { id: f.fund.id } })
      ).balance.toFixed(2),
    ).toBe('1100.00');
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.PAID);
  });

  it('rejects inactive actors, uncollected invoices, missing ledgers and insufficient funds', async () => {
    const f = await fixture();
    await prisma.employee.update({
      where: { id: f.employee.id },
      data: { isActive: false },
    });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await prisma.employee.update({
      where: { id: f.employee.id },
      data: { isActive: true },
    });
    await prisma.orderItem.update({
      where: { id: f.item.id },
      data: { serveStatus: ServeStatus.READY },
    });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toThrow('handed off');
    await prisma.orderItem.update({
      where: { id: f.item.id },
      data: { serveStatus: ServeStatus.SERVED },
    });
    await prisma.fund.update({
      where: { id: f.fund.id },
      data: { balance: 10 },
    });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toThrow('Insufficient');
    await prisma.cashTransaction.deleteMany({
      where: { invoiceId: f.invoice.id },
    });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toThrow('ledger');
    expect(
      await prisma.cashRefund.count({ where: { invoiceId: f.invoice.id } }),
    ).toBe(0);
  });

  it('does not use cash refunds for bank payments or closed shifts', async () => {
    const f = await fixture();
    await prisma.invoice.update({
      where: { id: f.invoice.id },
      data: { paymentMethod: PaymentMethod.TRANSFER },
    });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toThrow('cash invoice');
    await prisma.invoice.update({
      where: { id: f.invoice.id },
      data: { paymentMethod: PaymentMethod.CASH },
    });
    await shifts.close(f.employee.id, { reportedEndingCash: '1100' });
    await expect(
      refunds.create(f.invoice.id, f.employee.id, refundDto('25')),
    ).rejects.toThrow('open cashier shift');
  });

  it('pays refunds from the current shift without rewriting a closed sales shift', async () => {
    const f = await fixture();
    await shifts.close(f.employee.id, { reportedEndingCash: '1100' });
    const current = await prisma.cashierShift.create({
      data: {
        employeeId: f.employee.id,
        fundId: f.fund.id,
        startingCash: 1100,
        expectedStartingCash: 1100,
      },
    });
    const refund = await refunds.create(
      f.invoice.id,
      f.employee.id,
      refundDto('50'),
    );
    expect(refund.cashTransaction.shiftId).toBe(current.id);
    const shift = await shifts.getCurrent(f.employee.id);
    expect(shift.reconciliation.cashSales.toFixed(2)).toBe('0.00');
    expect(shift.reconciliation.actualEndingCash.toFixed(2)).toBe('1050.00');
    const closed = await prisma.cashierShift.findUniqueOrThrow({
      where: { id: f.shift.id },
    });
    expect(closed.actualEndingCash?.toFixed(2)).toBe('1100.00');
  });

  it('serializes refund against shift closing without posting into a closed shift', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      refunds.create(f.invoice.id, f.employee.id, refundDto('50')),
      shifts.close(f.employee.id, { reportedEndingCash: '1100' }),
    ]);
    const shift = await prisma.cashierShift.findUniqueOrThrow({
      where: { id: f.shift.id },
    });
    expect(shift.status).toBe(ShiftStatus.CLOSED);
    const count = await prisma.cashRefund.count({
      where: { invoiceId: f.invoice.id },
    });
    expect(shift.actualEndingCash?.toFixed(2)).toBe(
      count ? '1050.00' : '1100.00',
    );
    expect(results[1].status).toBe('fulfilled');
  });

  it('creates one nonbillable replacement, snapshots the old recipe and accounts for waste exactly once', async () => {
    const f = await fixture();
    const dto = {
      reason: 'Incorrect drink prepared',
      idempotencyKey: randomUUID(),
    };
    const remake = await orders.remakeItem(f.item.id, f.employee.id, dto);
    expect(remake.replacementItem).toMatchObject({
      invoiceId: null,
      isPaid: true,
      quantity: 2,
      serveStatus: ServeStatus.PENDING,
    });
    expect(
      new Prisma.Decimal(remake.replacementItem.priceAtTime).isZero(),
    ).toBe(true);
    expect((await orders.remakeItem(f.item.id, f.employee.id, dto)).id).toBe(
      remake.id,
    );
    await prisma.idempotencyRequest.deleteMany({
      where: { employeeId: f.employee.id, operation: 'order-item.remake' },
    });
    expect((await orders.remakeItem(f.item.id, f.employee.id, dto)).id).toBe(
      remake.id,
    );
    await expect(
      orders.remakeItem(f.item.id, f.employee.id, {
        ...dto,
        reason: 'Different reason',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      orders.remakeItem(f.item.id, f.employee.id, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const replacementId = remake.replacementItemId;
    const added = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: remake.id, eventName: 'order.items.added' },
    });
    const ticket = await prisma.kitchenTicketItem.findUniqueOrThrow({
      where: { orderItemId: replacementId },
    });
    expect(added.payload).toMatchObject({
      sessionId: f.session.id,
      orderItemIds: [replacementId],
      kitchenTicketIds: [ticket.ticketId],
    });
    await orders.updateItemStatus(replacementId, f.employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(replacementId, f.employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: f.ingredient.id },
        })
      ).stock.toFixed(4),
    ).toBe('16.0000');
    expect(
      await prisma.inventoryWaste.count({ where: { orderItemId: f.item.id } }),
    ).toBe(1);
    expect(
      await prisma.inventoryTransaction.count({
        where: { orderItemId: replacementId },
      }),
    ).toBe(1);
    expect(
      await prisma.kitchenTicketItem.count({
        where: { orderItemId: replacementId },
      }),
    ).toBe(1);
    await orders.updateItemStatus(replacementId, f.employee.id, {
      serveStatus: ServeStatus.READY,
    });
    const handoff = await orders.getHandoffItems({ page: 1, itemPerPage: 100 });
    expect(handoff.list.some((item) => item.id === replacementId)).toBe(true);
    await orders.handoffTakeawayItem(replacementId, f.employee.id);
    await prisma.inventoryWaste.updateMany({
      where: { orderItemId: f.item.id },
      data: { createdAt: f.from },
    });
    const scoped = await db.$transaction((tx) =>
      queryProfitability(tx, f, new Date()),
    );
    expect(scoped).toMatchObject({
      soldItemCount: 1,
      ingredientCost: '20.00',
      wasteCost: '20.00',
      estimatedGrossProfit: '60.00',
      netReceipts: '100.00',
    });
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: f.invoice.id },
      include: { orderItems: true },
    });
    expect(invoice.orderItems).toHaveLength(1);
    expect(invoice.totalAmount.toFixed(2)).toBe('100.00');
  });

  it('does not double-create a replacement under concurrent manager requests', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      orders.remakeItem(f.item.id, f.employee.id, {
        reason: 'Incorrect drink',
        idempotencyKey: randomUUID(),
      }),
      orders.remakeItem(f.item.id, f.employee.id, {
        reason: 'Incorrect drink',
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(
      failure?.status === 'rejected' &&
        failure.reason instanceof ConflictException,
    ).toBe(true);
    expect(
      await prisma.orderRemake.count({ where: { originalItemId: f.item.id } }),
    ).toBe(1);
  });

  it('rolls back a remake when kitchen routing fails', async () => {
    const f = await fixture();
    jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      orders.remakeItem(f.item.id, f.employee.id, {
        reason: 'Incorrect drink',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('outbox unavailable');
    expect(
      await prisma.orderRemake.count({ where: { originalItemId: f.item.id } }),
    ).toBe(0);
    expect(
      await prisma.inventoryWaste.count({ where: { orderItemId: f.item.id } }),
    ).toBe(0);
    expect(
      await prisma.orderItem.count({ where: { orderSessionId: f.session.id } }),
    ).toBe(1);
    expect(
      await prisma.kitchenTicket.count({
        where: { orderSessionId: f.session.id },
      }),
    ).toBe(0);
  });

  it('uses the original recipe and rolls back COOKING on insufficient stock', async () => {
    const f = await fixture();
    await prisma.menuItemIngredient.create({
      data: {
        menuItemId: f.menu.id,
        inventoryItemId: f.ingredient.id,
        quantity: 9,
      },
    });
    const remake = await orders.remakeItem(f.item.id, f.employee.id, {
      reason: 'Incorrect drink',
      idempotencyKey: randomUUID(),
    });
    await prisma.inventoryItem.update({
      where: { id: f.ingredient.id },
      data: { stock: 1 },
    });
    await expect(
      orders.updateItemStatus(remake.replacementItemId, f.employee.id, {
        serveStatus: ServeStatus.COOKING,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: remake.replacementItemId },
        })
      ).serveStatus,
    ).toBe(ServeStatus.PENDING);
    expect(
      await prisma.inventoryTransaction.count({
        where: { orderItemId: remake.replacementItemId },
      }),
    ).toBe(0);
    await prisma.inventoryItem.update({
      where: { id: f.ingredient.id },
      data: { stock: 4 },
    });
    await orders.updateItemStatus(remake.replacementItemId, f.employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: f.ingredient.id },
        })
      ).stock.toFixed(4),
    ).toBe('2.0000');
  });

  it('blocks remaking an item on a refunded invoice or without an active station', async () => {
    const f = await fixture();
    await prisma.kitchenStation.update({
      where: { id: f.station.id },
      data: { isActive: false },
    });
    await expect(
      orders.remakeItem(f.item.id, f.employee.id, {
        reason: 'Incorrect drink',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('active');
    await prisma.kitchenStation.update({
      where: { id: f.station.id },
      data: { isActive: true },
    });
    await refunds.create(f.invoice.id, f.employee.id, refundDto('100'));
    await expect(
      orders.remakeItem(f.item.id, f.employee.id, {
        reason: 'Incorrect drink',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('paid invoice');
  });

  it('records waste without restocking a cancelled prepared remake', async () => {
    const f = await fixture();
    const remake = await orders.remakeItem(f.item.id, f.employee.id, {
      reason: 'Incorrect drink',
      idempotencyKey: randomUUID(),
    });
    await orders.updateItemStatus(remake.replacementItemId, f.employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.cancelItem(remake.replacementItemId, f.employee.id, {
      reason: 'Customer left before remake was ready',
    });
    expect(
      await prisma.inventoryWaste.count({
        where: { orderItemId: remake.replacementItemId },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.inventoryItem.findUniqueOrThrow({
          where: { id: f.ingredient.id },
        })
      ).stock.toFixed(4),
    ).toBe('16.0000');
  });

  it('keeps collected online journeys collected and deducts cash refunds', async () => {
    const f = await fixture();
    await prisma.onlineOrderRequest.create({
      data: {
        clientRequestId: randomUUID(),
        pickupName: 'Test pickup',
        phoneNumber: '0901234567',
        quotedSubtotal: 100,
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        status: 'ACCEPTED',
        reviewedById: f.employee.id,
        reviewedAt: f.from,
        orderSessionId: f.session.id,
        createdAt: f.from,
      },
    });
    const remake = await orders.remakeItem(f.item.id, f.employee.id, {
      reason: 'Incorrect drink',
      idempotencyKey: randomUUID(),
    });
    await refunds.create(f.invoice.id, f.employee.id, refundDto('25'));
    const [journey] = await queryOnlineOrderJourney(
      db,
      { ...f, timeZone: 'UTC', granularity: 'day' },
      new Date(),
    );
    expect(Number(journey.collectedCount)).toBe(1);
    expect(journey.netReceipts.toFixed(2)).toBe('75.00');
    await orders.updateItemStatus(remake.replacementItemId, f.employee.id, {
      serveStatus: ServeStatus.COOKING,
    });
    await orders.updateItemStatus(remake.replacementItemId, f.employee.id, {
      serveStatus: ServeStatus.READY,
    });
    await orders.handoffTakeawayItem(remake.replacementItemId, f.employee.id);
    expect(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: remake.replacementItemId },
        })
      ).serveStatus,
    ).toBe(ServeStatus.SERVED);
    expect(
      await prisma.cashTransaction.count({
        where: { invoiceId: f.invoice.id, type: CashFlowType.INCOME },
      }),
    ).toBe(1);
  });
});
