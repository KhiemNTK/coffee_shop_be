import { ConflictException, Logger } from '@nestjs/common';
import {
  PaymentAttemptStatus,
  PaymentProvider,
  PaymentRefundStatus,
  PaymentRefundType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { OutboxService } from '../durable/outbox.service';
import { PaymentRefundsService } from './payment-refunds.service';
import type { VnpayService } from './vnpay.service';

describe('PaymentRefundsService', () => {
  const amount = new Prisma.Decimal('100000');
  const refund = {
    id: 'refund-id',
    type: PaymentRefundType.FULL,
    status: PaymentRefundStatus.PENDING,
    amount,
    reason: 'Customer request',
    idempotencyKey: 'refund-key',
    requestHash: 'request-hash',
    providerRequestId: 'provider-request-id',
    providerTransactionNo: null,
    providerResponseCode: null,
    providerTransactionStatus: null,
    providerMessage: null,
    lastError: null,
    requestedAt: new Date(),
    completedAt: null,
    reconciliationLockedAt: null,
    updatedAt: new Date(),
    paymentAttemptId: 'attempt-id',
    requestedById: 'employee-id',
    requestedBy: { id: 'employee-id', fullName: 'Manager' },
    paymentAttempt: {
      id: 'attempt-id',
      status: PaymentAttemptStatus.SUCCEEDED,
      amount,
      merchantReference: 'PA123',
      providerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      providerTransactionNo: 'VNP-PAYMENT-1',
      invoice: {
        id: 'invoice-id',
        invoiceNumber: 'INV-001',
        paymentStatus: PaymentStatus.PAID,
      },
    },
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    paymentAttempt: { findUnique: jest.fn() },
    paymentRefund: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    paymentProviderRequest: {
      create: jest.fn(),
      update: jest.fn(),
    },
    paymentReconciliationIncident: { upsert: jest.fn() },
    invoice: { updateMany: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const prisma = {
    paymentRefund: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const outbox = { enqueue: jest.fn() };
  const vnpay = {
    assertApiConfigured: jest.fn(),
    refundTransaction: jest.fn(),
  };
  const service = new PaymentRefundsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    outbox as unknown as OutboxService,
    vnpay as unknown as VnpayService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.paymentRefund.findUnique.mockReset();
    tx.paymentRefund.aggregate.mockReset();
    prisma.paymentRefund.findUnique.mockResolvedValue(null);
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt-id',
      status: PaymentAttemptStatus.SUCCEEDED,
      amount,
      providerTransactionNo: 'VNP-PAYMENT-1',
      invoice: { paymentStatus: PaymentStatus.PAID },
    });
    tx.paymentRefund.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(refund);
    tx.paymentRefund.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } })
      .mockResolvedValueOnce({ _sum: { amount } });
    tx.paymentRefund.create.mockResolvedValue(refund);
    tx.paymentRefund.updateMany.mockResolvedValue({ count: 1 });
    tx.paymentRefund.update.mockImplementation(
      ({ data }: { data: { status: PaymentRefundStatus } }) =>
        Promise.resolve({ ...refund, ...data }),
    );
    tx.paymentProviderRequest.create.mockResolvedValue({ id: 'request-row' });
    tx.invoice.updateMany.mockResolvedValue({ count: 1 });
    vnpay.refundTransaction.mockResolvedValue({
      request: { vnp_RequestId: 'provider-request-id' },
      response: {
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'VNP-REFUND-1',
        vnp_TxnRef: 'PA123',
        vnp_Amount: '10000000',
        vnp_TransactionType: '02',
        vnp_Message: 'Success',
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reserves and completes a full refund without exceeding the payment', async () => {
    const result = await service.createRefund('attempt-id', 'employee-id', {
      amount: '100000.00',
      reason: 'Customer request',
      idempotencyKey: 'refund-key',
    });

    expect(vnpay.refundTransaction).toHaveBeenCalledTimes(1);
    expect(tx.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paymentStatus: PaymentStatus.REFUNDED },
      }),
    );
    expect(result.status).toBe(PaymentRefundStatus.SUCCEEDED);
  });

  it('rejects a refund that exceeds the unreserved balance', async () => {
    tx.paymentRefund.aggregate.mockReset().mockResolvedValue({
      _sum: { amount: new Prisma.Decimal('60000') },
    });

    await expect(
      service.createRefund('attempt-id', 'employee-id', {
        amount: '50000.00',
        reason: 'Customer request',
        idempotencyKey: 'refund-key',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(vnpay.refundTransaction).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain provider refund automatically', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    vnpay.refundTransaction.mockRejectedValue(new Error('timeout'));

    const result = await service.createRefund('attempt-id', 'employee-id', {
      amount: '100000.00',
      reason: 'Customer request',
      idempotencyKey: 'refund-key',
    });

    expect(result.status).toBe(PaymentRefundStatus.REQUIRES_REVIEW);
    expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
    expect(vnpay.refundTransaction).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      'VNPay refund request refund-id is uncertain.',
    );
  });

  it('quarantines a signed provider response for another transaction', async () => {
    vnpay.refundTransaction.mockResolvedValue({
      request: { vnp_RequestId: 'provider-request-id' },
      response: {
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'VNP-REFUND-1',
        vnp_TxnRef: 'ANOTHER-PAYMENT',
        vnp_Amount: '10000000',
        vnp_TransactionType: '02',
        vnp_Message: 'Success',
      },
    });

    const result = await service.createRefund('attempt-id', 'employee-id', {
      amount: '100000.00',
      reason: 'Customer request',
      idempotencyKey: 'refund-key',
    });

    expect(result.status).toBe(PaymentRefundStatus.REQUIRES_REVIEW);
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
  });
});
