import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentMethod,
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

describe('InvoicesService', () => {
  let service: InvoicesService;
  let tx: any;
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
      employee: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
      orderSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'session-id',
          sessionStatus: SessionStatus.ACTIVE,
          tableId: null,
        }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'item-id',
            quantity: 1,
            priceAtTime: new Prisma.Decimal('45000'),
            serveStatus: ServeStatus.SERVED,
            isPaid: false,
            invoiceId: null,
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
        { provide: PromotionCalculatorService, useValue: {} },
        { provide: CashierShiftLedgerService, useValue: ledger },
      ],
    }).compile();

    service = module.get(InvoicesService);
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
});
