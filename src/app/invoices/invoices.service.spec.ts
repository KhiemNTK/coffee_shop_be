import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentMethod,
  PaymentAttemptStatus,
  PaymentStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { OutboxService } from '../durable/outbox.service';
import { PromotionCalculatorService } from '../promotions/services/promotion-calculator.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePolicyService } from './invoice-policy.service';
import { InvoicesService } from './invoices.service';
import { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';

describe('InvoicesService', () => {
  let service: InvoicesService;
  let tx: any;
  let inventory: {
    reservePendingItems: jest.Mock;
    releaseReservations: jest.Mock;
  };
  let promotionCalculator: { calculateDiscountTx: jest.Mock };
  let ledger: {
    requireOpenShift: jest.Mock;
    recordCashInvoice: jest.Mock;
  };

  beforeEach(async () => {
    const finalInvoice = {
      id: 'invoice-id',
      invoiceNumber: 'INV-001',
      orderSessionId: 'session-id',
      paymentStatus: PaymentStatus.PAID,
      orderSession: { tableId: null },
    };
    tx = {
      employee: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ isActive: true, fullName: 'Cashier' }),
      },
      orderSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'session-id',
          sessionStatus: SessionStatus.ACTIVE,
          tableId: null,
        }),
      },
      orderItem: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'item-id',
            quantity: 1,
            priceAtTime: new Prisma.Decimal('45000'),
            serveStatus: ServeStatus.SERVED,
            isPaid: false,
            invoiceId: null,
            menuItemId: 'menu-id',
            menuItem: { id: 'menu-id', name: 'Coffee' },
            note: null,
            selectedOptions: [],
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      invoice: {
        create: jest.fn().mockResolvedValue({
          id: 'invoice-id',
          invoiceNumber: 'INV-001',
        }),
        findUnique: jest.fn().mockResolvedValue(finalInvoice),
      },
      outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'event-id' }) },
      actionLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    ledger = {
      requireOpenShift: jest
        .fn()
        .mockResolvedValue({ id: 'shift-id', fundId: 'fund-id' }),
      recordCashInvoice: jest.fn(),
    };
    const outbox = { enqueue: jest.fn() };
    inventory = {
      reservePendingItems: jest.fn().mockResolvedValue(undefined),
      releaseReservations: jest.fn().mockResolvedValue(undefined),
    };
    promotionCalculator = {
      calculateDiscountTx: jest.fn().mockResolvedValue({
        promotionId: 'promotion-id',
        discountAmount: new Prisma.Decimal('4500'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        InvoicePolicyService,
        { provide: PRISMA_SERVICE_TOKEN, useValue: prisma },
        { provide: PaginationUtilService, useValue: {} },
        { provide: QueryUtilService, useValue: {} },
        {
          provide: InvoiceNumberService,
          useValue: { generate: jest.fn().mockResolvedValue('INV-001') },
        },
        { provide: IdempotencyService, useValue: {} },
        { provide: OutboxService, useValue: outbox },
        { provide: PromotionCalculatorService, useValue: promotionCalculator },
        { provide: CashierShiftLedgerService, useValue: ledger },
        { provide: InventoryConsumptionService, useValue: inventory },
      ],
    }).compile();

    service = module.get(InvoicesService);
  });

  it.each(['quote', 'create', 'checkout'])(
    'rejects POS %s for online orders before writing invoices or cash',
    async (operation) => {
      tx.orderSession.findUnique.mockResolvedValue({
        id: 'session-id',
        sessionStatus: SessionStatus.ACTIVE,
        tableId: null,
        onlineOrderRequest: { id: 'request-id' },
      });
      const input = { orderSessionId: 'session-id' };
      const result =
        operation === 'quote'
          ? service.quoteInvoice('employee-id', input)
          : operation === 'create'
            ? service.createInvoice('employee-id', input)
            : service.checkoutInvoice('employee-id', {
                ...input,
                paymentMethod: PaymentMethod.CASH,
                amountTendered: '50000',
                closeSessionAfterPayment: true,
              });
      await expect(result).rejects.toMatchObject({
        status: 409,
        response: { code: 'ONLINE_ORDER_PICKUP_REQUIRED' },
      });
      expect(tx.invoice.create).not.toHaveBeenCalled();
      expect(ledger.requireOpenShift).not.toHaveBeenCalled();
      expect(inventory.reservePendingItems).not.toHaveBeenCalled();
    },
  );

  it('allows the transaction-owned online pickup checkout', async () => {
    tx.orderSession.findUnique.mockResolvedValue({
      id: 'session-id',
      sessionStatus: SessionStatus.ACTIVE,
      tableId: null,
      onlineOrderRequest: { id: 'request-id' },
    });
    await service.checkoutOnlinePickupInTransaction(
      tx as never,
      'employee-id',
      'session-id',
      '50000',
    );
    expect(tx.invoice.create).toHaveBeenCalledTimes(1);
    expect(ledger.recordCashInvoice).toHaveBeenCalledTimes(1);
  });

  it('rejects manual payment of a legacy online-order invoice', async () => {
    tx.invoice.findUnique.mockResolvedValue({
      id: 'invoice-id',
      paymentStatus: PaymentStatus.UNPAID,
      orderSession: { onlineOrderRequest: { id: 'request-id' } },
    });
    await expect(
      service.updatePayment('invoice-id', 'employee-id', {
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CASH,
        amountTendered: '50000',
        closeSessionAfterPayment: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'ONLINE_ORDER_PICKUP_REQUIRED' },
    });
    expect(ledger.requireOpenShift).not.toHaveBeenCalled();
  });

  it('keeps dine-in occupied even when all items are paid', async () => {
    tx.orderSession.findUnique.mockResolvedValue({
      id: 'session-id',
      tableId: 'table-id',
      sessionStatus: SessionStatus.ACTIVE,
    });
    await service.checkoutInvoice('employee-id', {
      orderSessionId: 'session-id',
      paymentMethod: PaymentMethod.CASH,
      amountTendered: '50000',
      closeSessionAfterPayment: true,
    });
    expect(tx.orderSession.updateMany).not.toHaveBeenCalled();
    expect(tx.orderItem.count).not.toHaveBeenCalled();
  });

  it('still closes fully paid takeaway sessions', async () => {
    await service.checkoutInvoice('employee-id', {
      orderSessionId: 'session-id',
      paymentMethod: PaymentMethod.CASH,
      amountTendered: '50000',
      closeSessionAfterPayment: true,
    });
    expect(tx.orderSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-id', sessionStatus: SessionStatus.ACTIVE },
      data: { sessionStatus: SessionStatus.COMPLETED },
    });
  });

  it('books a cash checkout against the paying employee open shift', async () => {
    await service.checkoutInvoice('employee-id', {
      orderSessionId: 'session-id',
      paymentMethod: PaymentMethod.CASH,
      amountTendered: '50000',
      closeSessionAfterPayment: false,
    });

    expect(tx.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shiftId: 'shift-id' }),
      }),
    );
    expect(ledger.recordCashInvoice).toHaveBeenCalledWith(tx, {
      shift: { id: 'shift-id', fundId: 'fund-id' },
      invoiceId: 'invoice-id',
      invoiceNumber: 'INV-001',
      employeeId: 'employee-id',
      amount: new Prisma.Decimal('45000'),
    });
  });

  it('quotes selected lines without invoice, ledger or item mutations', async () => {
    const quote = await service.quoteInvoice('employee-id', {
      orderSessionId: 'session-id',
      orderItemIds: ['item-id'],
      taxRate: '10',
    });
    expect(quote.orderItemIds).toEqual(['item-id']);
    expect(quote.totalAmount.toString()).toBe('49500');
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(ledger.requireOpenShift).not.toHaveBeenCalled();
    expect(inventory.reservePendingItems).not.toHaveBeenCalled();
  });

  it('takes an inventory commitment before recording any cash payment', async () => {
    await service.checkoutInvoice('employee-id', {
      orderSessionId: 'session-id',
      paymentMethod: PaymentMethod.CASH,
      amountTendered: '50000',
      closeSessionAfterPayment: false,
    });
    expect(inventory.reservePendingItems).toHaveBeenCalledWith(tx, {
      invoiceId: 'invoice-id',
    });
    expect(
      inventory.reservePendingItems.mock.invocationCallOrder[0],
    ).toBeLessThan(ledger.recordCashInvoice.mock.invocationCallOrder[0]);
  });

  it('captures the issued items independently of mutable operational rows', async () => {
    await service.createInvoice('employee-id', {
      orderSessionId: 'session-id',
    });
    const { data } = tx.invoice.create.mock.calls[0][0];
    expect(data.documentSnapshot).toMatchObject({
      version: 1,
      source: 'ISSUED',
      issuedByName: 'Cashier',
      items: [
        {
          orderItemId: 'item-id',
          name: 'Coffee',
          quantity: 1,
          unitPrice: '45000.00',
        },
      ],
    });
  });

  it('rejects a promotion changed after quote, before invoice, ledger or stock writes', async () => {
    const input = { orderSessionId: 'session-id', promotionId: 'promotion-id' };
    const quote = await service.quoteInvoice('employee-id', input);
    promotionCalculator.calculateDiscountTx.mockResolvedValue({
      promotionId: 'promotion-id',
      discountAmount: new Prisma.Decimal('2250'),
    });
    await expect(
      service.checkoutInvoice('employee-id', {
        ...input,
        quoteFingerprint: quote.quoteFingerprint,
        amountTendered: '50000',
        paymentMethod: PaymentMethod.CASH,
        closeSessionAfterPayment: false,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVOICE_QUOTE_CHANGED' } });
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(inventory.reservePendingItems).not.toHaveBeenCalled();
    expect(ledger.recordCashInvoice).not.toHaveBeenCalled();
  });

  it('accepts the same authoritative quote and rejects excess tax precision in direct calls', async () => {
    const input = { orderSessionId: 'session-id', taxRate: '8.13' };
    const quote = await service.quoteInvoice('employee-id', input);
    await service.createInvoice('employee-id', {
      ...input,
      quoteFingerprint: quote.quoteFingerprint,
    });
    expect(tx.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxRate: new Prisma.Decimal('8.13'),
          taxAmount: new Prisma.Decimal('3658.50'),
        }),
      }),
    );
    await expect(
      service.quoteInvoice('employee-id', { ...input, taxRate: '8.125' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('fails checkout before recording cash if the pending recipe cannot be held', async () => {
    inventory.reservePendingItems.mockRejectedValue(
      new ConflictException({ code: 'INVENTORY_INSUFFICIENT_STOCK' }),
    );
    await expect(
      service.checkoutInvoice('employee-id', {
        orderSessionId: 'session-id',
        paymentMethod: PaymentMethod.CASH,
        amountTendered: '50000',
        closeSessionAfterPayment: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ledger.recordCashInvoice).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('releases pending invoice holds when the invoice is voided', async () => {
    tx.invoice.findUnique.mockResolvedValue({
      id: 'invoice-id',
      paymentStatus: PaymentStatus.UNPAID,
      orderSession: { tableId: null },
      documentSnapshot: { version: 1 },
    });
    tx.invoice.update = jest.fn();
    tx.paymentAttempt = { findFirst: jest.fn().mockResolvedValue(null) };
    tx.orderItem.findMany.mockResolvedValue([{ id: 'pending-line' }]);
    await service.voidInvoice('invoice-id', 'employee-id', {
      reason: 'Duplicate invoice',
    });
    expect(inventory.releaseReservations).toHaveBeenCalledWith(tx, [
      'pending-line',
    ]);
    expect(
      inventory.releaseReservations.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (tx.orderItem.updateMany as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('keeps an accepted online commitment when voiding a legacy POS invoice', async () => {
    tx.invoice.findUnique.mockResolvedValue({
      id: 'invoice-id',
      paymentStatus: PaymentStatus.UNPAID,
      orderSession: { tableId: null, onlineOrderRequest: { id: 'request-id' } },
      documentSnapshot: { version: 1 },
    });
    tx.invoice.update = jest.fn();
    tx.paymentAttempt = { findFirst: jest.fn().mockResolvedValue(null) };
    tx.orderItem.findMany.mockResolvedValue([{ id: 'pending-line' }]);
    await service.voidInvoice('invoice-id', 'employee-id', {
      reason: 'Duplicate invoice',
    });
    expect(tx.orderItem.updateMany).toHaveBeenCalled();
    expect(inventory.releaseReservations).not.toHaveBeenCalled();
  });

  it('rejects quotes for already invoiced lines', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-id',
        quantity: 1,
        priceAtTime: new Prisma.Decimal('45000'),
        serveStatus: ServeStatus.SERVED,
        isPaid: false,
        invoiceId: 'existing-invoice',
      },
    ]);
    await expect(
      service.quoteInvoice('employee-id', {
        orderSessionId: 'session-id',
        orderItemIds: ['item-id'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('quotes promotions through the same authoritative calculator as checkout', async () => {
    const quote = await service.quoteInvoice('employee-id', {
      orderSessionId: 'session-id',
      promotionId: 'promotion-id',
      taxRate: '10',
    });
    expect(promotionCalculator.calculateDiscountTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        promotionId: 'promotion-id',
        subTotal: new Prisma.Decimal('45000'),
      }),
    );
    expect(quote.discountAmount.toString()).toBe('4500');
    expect(quote.totalAmount.toString()).toBe('44550');
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('keeps a pending invoice outside a shift until payment', async () => {
    await service.createInvoice('employee-id', {
      orderSessionId: 'session-id',
    });

    expect(ledger.requireOpenShift).not.toHaveBeenCalled();
    expect(ledger.recordCashInvoice).not.toHaveBeenCalled();
    expect(tx.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shiftId: null }),
      }),
    );
  });

  it('does not allow checkout to bypass provider confirmation for transfers', async () => {
    await expect(
      service.checkoutInvoice('employee-id', {
        orderSessionId: 'session-id',
        paymentMethod: PaymentMethod.TRANSFER,
        closeSessionAfterPayment: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ledger.requireOpenShift).not.toHaveBeenCalled();
  });

  it.each([
    PaymentAttemptStatus.PENDING,
    PaymentAttemptStatus.EXPIRED,
    PaymentAttemptStatus.REQUIRES_REVIEW,
  ])(
    'blocks manual payment and void while an online attempt is %s',
    async (status) => {
      tx.invoice.findUnique.mockResolvedValue({
        id: 'invoice-id',
        paymentStatus: PaymentStatus.UNPAID,
        orderSession: { tableId: null },
        orderItems: [],
      });
      tx.paymentAttempt = {
        findFirst: jest.fn().mockResolvedValue({ id: 'attempt-id', status }),
      };

      await expect(
        service.updatePayment('invoice-id', 'employee-id', {
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: PaymentMethod.CASH,
          amountTendered: '50000',
          closeSessionAfterPayment: true,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.voidInvoice('invoice-id', 'employee-id', {
          reason: 'Duplicate invoice',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.paymentAttempt.findFirst).toHaveBeenCalledWith({
        where: {
          invoiceId: 'invoice-id',
          status: {
            in: [
              PaymentAttemptStatus.PENDING,
              PaymentAttemptStatus.EXPIRED,
              PaymentAttemptStatus.REQUIRES_REVIEW,
            ],
          },
        },
        select: { id: true },
      });
      expect(ledger.requireOpenShift).not.toHaveBeenCalled();
      expect(ledger.recordCashInvoice).not.toHaveBeenCalled();
      expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    },
  );
});
