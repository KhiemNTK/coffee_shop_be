import { PaymentAttemptStatus, PaymentStatus, Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { OutboxService } from '../durable/outbox.service';
import type { InvoicesService } from '../invoices/invoices.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import type { VnpayService } from './vnpay.service';

describe('PaymentReconciliationService', () => {
  const attempt = {
    id: 'attempt-id',
    status: PaymentAttemptStatus.EXPIRED,
    amount: new Prisma.Decimal('100000'),
    currency: 'VND',
    merchantReference: 'PA123',
    idempotencyKey: 'payment-key',
    requestHash: 'request-hash',
    providerTransactionNo: null,
    failureCode: null,
    closeSessionAfterPayment: true,
    providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T00:15:00.000Z'),
    completedAt: new Date('2026-01-01T00:15:00.000Z'),
    lastReconciledAt: null,
    nextReconcileAt: new Date('2026-01-01T00:15:00.000Z'),
    reconciliationAttempts: 0,
    reconciliationLockedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:15:00.000Z'),
    invoiceId: 'invoice-id',
    createdById: 'employee-id',
    shiftId: 'shift-id',
    invoice: {
      id: 'invoice-id',
      invoiceNumber: 'INV-001',
      paymentStatus: PaymentStatus.UNPAID,
    },
  };
  const tx = {
    paymentAttempt: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    paymentProviderRequest: { update: jest.fn() },
    paymentReconciliationIncident: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    paymentAttempt: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    paymentProviderRequest: { create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const invoices = { completeOnlinePayment: jest.fn() };
  const outbox = { enqueue: jest.fn() };
  const vnpay = {
    assertApiConfigured: jest.fn(),
    queryTransaction: jest.fn(),
  };
  const service = new PaymentReconciliationService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    invoices as unknown as InvoicesService,
    outbox as unknown as OutboxService,
    vnpay as unknown as VnpayService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.paymentAttempt.findUnique
      .mockResolvedValueOnce({ id: attempt.id })
      .mockResolvedValueOnce(attempt);
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.paymentProviderRequest.create.mockResolvedValue({
      id: 'provider-request-id',
    });
    tx.paymentAttempt.findUnique.mockResolvedValue(attempt);
    tx.paymentAttempt.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...attempt, ...data }),
    );
    invoices.completeOnlinePayment.mockResolvedValue({ id: 'invoice-id' });
    vnpay.queryTransaction.mockResolvedValue({
      request: { vnp_RequestId: 'query-id' },
      response: {
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TxnRef: 'PA123',
        vnp_Amount: '10000000',
        vnp_TransactionNo: 'VNP-PAYMENT-1',
        vnp_TransactionType: '01',
      },
    });
  });

  it('repairs an expired local attempt when VNPay confirms payment', async () => {
    const result = await service.reconcileAttempt(attempt.id, 'manager-id');

    expect(invoices.completeOnlinePayment).toHaveBeenCalledWith(tx, {
      invoiceId: 'invoice-id',
      employeeId: 'employee-id',
      shiftId: 'shift-id',
      closeSessionAfterPayment: true,
    });
    expect(tx.paymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentAttemptStatus.SUCCEEDED,
          providerTransactionNo: 'VNP-PAYMENT-1',
        }),
      }),
    );
    expect(result?.status).toBe(PaymentAttemptStatus.SUCCEEDED);
  });

  it('opens an incident instead of mutating the invoice on amount mismatch', async () => {
    vnpay.queryTransaction.mockResolvedValue({
      request: { vnp_RequestId: 'query-id' },
      response: {
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TxnRef: 'PA123',
        vnp_Amount: '9999999',
        vnp_TransactionNo: 'VNP-PAYMENT-1',
        vnp_TransactionType: '01',
      },
    });

    const result = await service.reconcileAttempt(attempt.id, 'manager-id');

    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
  });
});
