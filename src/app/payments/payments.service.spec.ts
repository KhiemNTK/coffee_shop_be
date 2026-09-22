import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAttemptStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import type { InvoicesService } from '../invoices/invoices.service';
import type { OutboxService } from '../durable/outbox.service';
import { PaymentsService } from './payments.service';
import type { VnpayService } from './vnpay.service';

describe('PaymentsService', () => {
  const tx = {
    employee: { findFirst: jest.fn() },
    invoice: { findUnique: jest.fn() },
    paymentAttempt: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    paymentWebhookEvent: { create: jest.fn(), update: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    paymentAttempt: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const ledger = { requireOpenShift: jest.fn() };
  const invoices = {
    completeOnlinePayment: jest.fn(),
  };
  const outbox = { enqueue: jest.fn() };
  const vnpay = {
    assertConfigured: jest.fn(),
    createPaymentUrl: jest.fn(),
    verifyCallback: jest.fn(),
  };
  const service = new PaymentsService(
    prisma as unknown as ExtendedPrismaClient,
    new ConfigService({ VNPAY_ATTEMPT_TTL_MINUTES: 15 }),
    new PaginationUtilService(),
    ledger as unknown as CashierShiftLedgerService,
    invoices as unknown as InvoicesService,
    outbox as unknown as OutboxService,
    vnpay as unknown as VnpayService,
  );
  const attempt = {
    id: 'attempt-id',
    provider: PaymentProvider.VNPAY,
    status: PaymentAttemptStatus.PENDING,
    amount: new Prisma.Decimal('100000'),
    currency: 'VND',
    merchantReference: 'PA123',
    idempotencyKey: 'idempotency-key',
    requestHash: 'request-hash',
    providerTransactionNo: null,
    failureCode: null,
    closeSessionAfterPayment: true,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    invoiceId: 'invoice-id',
    createdById: 'employee-id',
    shiftId: 'shift-id',
    invoice: {
      id: 'invoice-id',
      invoiceNumber: 'INV-001',
      totalAmount: new Prisma.Decimal('100000'),
      paymentStatus: PaymentStatus.UNPAID,
    },
    createdBy: { id: 'employee-id', fullName: 'Cashier' },
    shift: {
      id: 'shift-id',
      status: ShiftStatus.OPEN,
      openedAt: new Date(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.paymentAttempt.findUnique.mockResolvedValue(null);
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.paymentAttempt.findUnique.mockResolvedValue(null);
    tx.paymentAttempt.findFirst.mockResolvedValue(null);
    tx.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });
    tx.invoice.findUnique.mockResolvedValue({
      id: 'invoice-id',
      invoiceNumber: 'INV-001',
      totalAmount: new Prisma.Decimal('100000'),
      paymentStatus: PaymentStatus.UNPAID,
    });
    ledger.requireOpenShift.mockResolvedValue({ id: 'shift-id' });
    tx.paymentAttempt.create.mockResolvedValue(attempt);
    vnpay.createPaymentUrl.mockReturnValue('https://sandbox/payment');
  });

  it('creates one provider attempt tied to the current cashier shift', async () => {
    const result = await service.createAttempt(
      'invoice-id',
      'employee-id',
      '127.0.0.1',
      {
        idempotencyKey: 'idempotency-key',
        locale: 'vn',
        closeSessionAfterPayment: true,
      },
    );

    expect(ledger.requireOpenShift).toHaveBeenCalledWith(tx, 'employee-id');
    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: 'invoice-id',
          shiftId: 'shift-id',
          amount: new Prisma.Decimal('100000'),
        }),
      }),
    );
    expect(result.paymentUrl).toBe('https://sandbox/payment');
  });

  it('rejects an idempotency key reused with another request', async () => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      requestHash: 'different-request',
    });

    await expect(
      service.createAttempt('invoice-id', 'employee-id', '127.0.0.1', {
        idempotencyKey: 'idempotency-key',
        locale: 'vn',
        closeSessionAfterPayment: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an invalid IPN signature without querying payment state', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: false,
      params: {},
      payloadHash: 'payload-hash',
    });

    await expect(service.handleVnpayIpn({})).resolves.toEqual({
      RspCode: '97',
      Message: 'Invalid signature',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('finalizes a successful signed IPN and publishes after commit', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: true,
      payloadHash: 'payload-hash',
      params: {
        vnp_TxnRef: 'PA123',
        vnp_Amount: '10000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'VNP-001',
      },
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      invoice: { paymentStatus: PaymentStatus.UNPAID },
    });
    tx.paymentWebhookEvent.create.mockResolvedValue({ id: 'event-id' });
    const paidInvoice = {
      id: 'invoice-id',
      invoiceNumber: 'INV-001',
      orderSessionId: 'session-id',
      orderSession: { tableId: 'table-id' },
    };
    invoices.completeOnlinePayment.mockResolvedValue(paidInvoice);

    await expect(
      service.handleVnpayIpn({ vnp_SecureHash: 'signed' }),
    ).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(invoices.completeOnlinePayment).toHaveBeenCalledWith(tx, {
      invoiceId: 'invoice-id',
      employeeId: 'employee-id',
      shiftId: 'shift-id',
      closeSessionAfterPayment: true,
    });
  });
});
