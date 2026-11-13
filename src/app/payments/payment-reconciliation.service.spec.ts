import { BadGatewayException, Logger } from '@nestjs/common';
import {
  PaymentAttemptStatus,
  PaymentProvider,
  PaymentReconciliationIncidentType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { OutboxService } from '../durable/outbox.service';
import type { InvoicesService } from '../invoices/invoices.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { VnpayService } from './vnpay.service';
import { MomoService } from './momo.service';
import type { PayosService } from './payos.service';
import { VnpayApiException } from './vnpay-api.exception';
import type {
  VnpayApiFailureCode,
  VnpayApiDiagnostics,
} from '../../common/types';
import { DomainEventBusService } from '../durable/domain-event-bus.service';

describe('PaymentReconciliationService', () => {
  const attempt = {
    id: 'attempt-id',
    provider: PaymentProvider.VNPAY,
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
      totalAmount: new Prisma.Decimal('100000'),
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
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    paymentRefund: { findMany: jest.fn() },
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
    isFinalPaymentFailure: VnpayService.prototype.isFinalPaymentFailure,
  };
  const momo = {
    assertConfigured: jest.fn(),
    queryTransaction: jest.fn(),
    isFinalPaymentFailure: MomoService.prototype.isFinalPaymentFailure,
  };
  const payos = { assertConfigured: jest.fn(), queryTransaction: jest.fn() };
  const service = new PaymentReconciliationService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    invoices as unknown as InvoicesService,
    outbox as unknown as OutboxService,
    vnpay as unknown as VnpayService,
    momo as unknown as MomoService,
    payos as unknown as PayosService,
    new DomainEventBusService(),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.paymentAttempt.findUnique
      .mockResolvedValueOnce({
        id: attempt.id,
        provider: PaymentProvider.VNPAY,
      })
      .mockResolvedValueOnce(attempt);
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.paymentRefund.findMany.mockResolvedValue([]);
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

  afterEach(() => jest.restoreAllMocks());

  it.each<[VnpayApiFailureCode, VnpayApiDiagnostics, number, 'warn' | 'error']>(
    [
      ['VNPAY_API_TIMEOUT', {}, 0, 'warn'],
      ['VNPAY_API_NETWORK_ERROR', { networkCode: 'ENOTFOUND' }, 0, 'warn'],
      [
        'VNPAY_API_SIGNATURE_MISSING',
        {
          providerHttpStatus: 200,
          providerResponseCode: '02',
          verification: 'missing',
        },
        0,
        'error',
      ],
      [
        'VNPAY_API_SIGNATURE_INVALID',
        { providerHttpStatus: 200, verification: 'invalid' },
        0,
        'error',
      ],
      ['VNPAY_NOT_CONFIGURED', {}, 0, 'error'],
      ['VNPAY_API_TIMEOUT', {}, 4, 'error'],
    ],
  )(
    'logs %s once at %s completed queries and keeps financial state safe',
    async (code, diagnostics, count, level) => {
      const pending = {
        ...attempt,
        status: PaymentAttemptStatus.PENDING,
        reconciliationAttempts: count,
      };
      const state =
        count >= 4
          ? PaymentAttemptStatus.REQUIRES_REVIEW
          : PaymentAttemptStatus.PENDING;
      const nextReconcileAt = count >= 4 ? null : new Date(Date.now() + 60_000);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prisma.paymentAttempt.findMany.mockResolvedValue([
        { id: attempt.id, provider: PaymentProvider.VNPAY },
      ]);
      prisma.paymentAttempt.findUnique.mockReset().mockResolvedValue(pending);
      tx.paymentAttempt.findUnique.mockResolvedValue(pending);
      tx.paymentAttempt.update.mockResolvedValue({
        ...pending,
        status: state,
        reconciliationAttempts: count + 1,
        nextReconcileAt,
      });
      vnpay.queryTransaction.mockRejectedValueOnce(
        new VnpayApiException(code, diagnostics),
      );

      await expect(service.reconcileDue()).resolves.toEqual({
        claimed: 1,
        processed: 0,
        failed: 1,
      });

      expect(warn.mock.calls.length + error.mock.calls.length).toBe(1);
      expect((level === 'warn' ? warn : error).mock.calls[0]).toEqual([
        expect.objectContaining({
          event: 'payment.reconciliation.provider_failed',
          provider: 'VNPAY',
          paymentAttemptId: attempt.id,
          providerRequestId: expect.any(String),
          failureCode: code,
          ...diagnostics,
          durationMs: expect.any(Number),
          reconciliationAttempts: count + 1,
          status: state,
          nextReconcileAt: nextReconcileAt?.toISOString() ?? null,
        }),
      ]);
      expect(tx.paymentProviderRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorMessage: expect.stringContaining(code),
          }),
        }),
      );
      const data = tx.paymentAttempt.update.mock.calls[0][0].data;
      if (count < 4) expect(data).not.toHaveProperty('status');
      else expect(data.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
      expect(prisma.paymentProviderRequest.update).not.toHaveBeenCalled();
      expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
      expect(vnpay.queryTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it('logs an unexpected persistence error instead of hiding it as an already-reported provider error', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    prisma.paymentAttempt.findMany.mockResolvedValue([
      { id: attempt.id, provider: PaymentProvider.VNPAY },
    ]);
    prisma.paymentAttempt.findUnique.mockReset().mockResolvedValue(attempt);
    vnpay.queryTransaction.mockRejectedValueOnce(
      new VnpayApiException('VNPAY_API_TIMEOUT'),
    );
    tx.paymentProviderRequest.update.mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    await expect(service.reconcileDue()).resolves.toEqual({
      claimed: 1,
      processed: 0,
      failed: 1,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.reconciliation.failed',
        provider: 'VNPAY',
        paymentAttemptId: attempt.id,
        failureCode: 'PAYMENT_RECONCILIATION_FAILED',
      }),
      expect.stringContaining('storage unavailable'),
    );
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
  });

  it.each([
    ['PAID', 100000, 0, false, PaymentAttemptStatus.SUCCEEDED],
    ['UNDERPAID', 50000, 50000, false, PaymentAttemptStatus.EXPIRED],
    ['PAID', 100001, -1, false, PaymentAttemptStatus.REQUIRES_REVIEW],
    ['CANCELLED', 0, 100000, false, PaymentAttemptStatus.FAILED],
    ['CANCELLED', 50000, 50000, false, PaymentAttemptStatus.REQUIRES_REVIEW],
    ['PAID', 100000, 0, true, PaymentAttemptStatus.REQUIRES_REVIEW],
  ])(
    'reconciles payOS %s with paid amount %s safely',
    async (status, amountPaid, amountRemaining, invoiceChanged, expected) => {
      const current = {
        ...attempt,
        provider: PaymentProvider.PAYOS,
        merchantReference: '1000000000',
        providerPaymentLinkId: 'a'.repeat(32),
        invoice: {
          ...attempt.invoice,
          paymentStatus: invoiceChanged
            ? PaymentStatus.VOIDED
            : PaymentStatus.UNPAID,
        },
      };
      prisma.paymentAttempt.findUnique
        .mockReset()
        .mockResolvedValueOnce({
          id: current.id,
          provider: PaymentProvider.PAYOS,
        })
        .mockResolvedValueOnce(current);
      tx.paymentAttempt.findUnique.mockResolvedValue(current);
      payos.queryTransaction.mockResolvedValue({
        id: 'a'.repeat(32),
        orderCode: 1000000000,
        amount: 100000,
        amountPaid,
        amountRemaining,
        status,
        transactions: amountPaid
          ? [{ reference: 'BANK-1', amount: amountPaid }]
          : [],
      });
      const result = await service.reconcileAttempt(current.id, 'manager-id');
      expect(result?.status).toBe(expected);
      expect(invoices.completeOnlinePayment).toHaveBeenCalledTimes(
        expected === PaymentAttemptStatus.SUCCEEDED ? 1 : 0,
      );
      expect(vnpay.queryTransaction).not.toHaveBeenCalled();
      expect(momo.queryTransaction).not.toHaveBeenCalled();
    },
  );

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

  it.each(['04', '07'])(
    'quarantines VNPay status %s instead of releasing the payment',
    async (transactionStatus) => {
      vnpay.queryTransaction.mockResolvedValueOnce({
        request: {},
        response: {
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: transactionStatus,
          vnp_TxnRef: attempt.merchantReference,
          vnp_Amount: '10000000',
          vnp_TransactionType: '01',
        },
      });
      const result = await service.reconcileAttempt(attempt.id, 'manager-id');
      expect(result?.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
      expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
      expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it('auto-resolves only transient incidents after a successful query', async () => {
    await service.reconcileAttempt(attempt.id, 'manager-id');
    expect(tx.paymentReconciliationIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentAttemptId: attempt.id,
          paymentRefundId: null,
          status: 'OPEN',
          type: {
            in: [
              PaymentReconciliationIncidentType.STALE_ATTEMPT,
              PaymentReconciliationIncidentType.PROVIDER_UNAVAILABLE,
            ],
          },
        },
      }),
    );
  });

  it.each([
    [1006, PaymentAttemptStatus.FAILED],
    [10, PaymentAttemptStatus.EXPIRED],
    [7000, PaymentAttemptStatus.EXPIRED],
    [9000, PaymentAttemptStatus.EXPIRED],
    [12345, PaymentAttemptStatus.EXPIRED],
  ])(
    'reconciles MoMo code %s without guessing a final outcome',
    async (code, expected) => {
      const current = { ...attempt, provider: PaymentProvider.MOMO };
      prisma.paymentAttempt.findUnique
        .mockReset()
        .mockResolvedValueOnce({
          id: attempt.id,
          provider: PaymentProvider.MOMO,
        })
        .mockResolvedValueOnce(current);
      tx.paymentAttempt.findUnique.mockResolvedValue(current);
      momo.queryTransaction.mockResolvedValueOnce({
        request: {},
        response: { resultCode: code },
      });
      const result = await service.reconcileAttempt(attempt.id, 'manager-id');
      expect(result?.status).toBe(expected);
      expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    },
  );

  it('records a provider conflict without demoting a confirmed payment', async () => {
    const confirmed = {
      ...attempt,
      status: PaymentAttemptStatus.SUCCEEDED,
      providerTransactionNo: 'CONFIRMED-TRANSACTION',
      invoice: {
        ...attempt.invoice,
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      },
    };
    tx.paymentAttempt.findUnique.mockResolvedValue(confirmed);
    tx.paymentAttempt.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...confirmed, ...data }),
    );

    const result = await service.reconcileAttempt(attempt.id, 'manager-id');

    expect(result?.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(result?.providerTransactionNo).toBe('CONFIRMED-TRANSACTION');
    expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
  });

  it('confirms a matching MoMo query without calling VNPay', async () => {
    prisma.paymentAttempt.findUnique
      .mockReset()
      .mockResolvedValueOnce({ id: attempt.id, provider: PaymentProvider.MOMO })
      .mockResolvedValueOnce({ ...attempt, provider: PaymentProvider.MOMO });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.MOMO,
    });
    momo.queryTransaction.mockResolvedValue({
      request: {
        partnerCode: 'TESTSHOP',
        orderId: 'PA123',
        requestId: 'query-id',
      },
      response: {
        partnerCode: 'TESTSHOP',
        orderId: 'PA123',
        requestId: 'query-id',
        resultCode: 0,
        amount: 100000,
        transId: 123456789,
        message: 'Successful.',
      },
    });

    const result = await service.reconcileAttempt(attempt.id, 'manager-id');

    expect(vnpay.queryTransaction).not.toHaveBeenCalled();
    expect(momo.queryTransaction).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(invoices.completeOnlinePayment).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'mismatch', 'timeout'])(
    'retries a %s against fresh state without querying the provider twice',
    async (outcome) => {
      const pending = { ...attempt, reconciliationAttempts: 4 };
      const confirmed = {
        ...pending,
        status: PaymentAttemptStatus.SUCCEEDED,
        providerTransactionNo: 'CONFIRMED-TRANSACTION',
        invoice: { ...attempt.invoice, paymentStatus: PaymentStatus.PAID },
      };
      tx.paymentAttempt.findUnique
        .mockReset()
        .mockResolvedValueOnce(pending)
        .mockResolvedValue(confirmed);
      tx.paymentAttempt.update
        .mockReset()
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Concurrent confirmation', {
            code: 'P2034',
            clientVersion: Prisma.prismaVersion.client,
          }),
        )
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...confirmed, ...data }),
        );
      if (outcome === 'timeout') {
        vnpay.queryTransaction.mockRejectedValueOnce(new Error('Timeout'));
      } else {
        vnpay.queryTransaction.mockResolvedValueOnce({
          request: {},
          response: {
            vnp_ResponseCode: '00',
            vnp_TransactionStatus: outcome === 'failure' ? '02' : '00',
            vnp_TxnRef: 'PA123',
            vnp_Amount: outcome === 'mismatch' ? '9999999' : '10000000',
            vnp_TransactionType: '01',
          },
        });
      }
      const result = service.reconcileAttempt(attempt.id, 'manager-id');
      if (outcome === 'timeout') {
        await expect(result).rejects.toThrow(BadGatewayException);
      } else {
        await expect(result).resolves.toMatchObject({
          status: PaymentAttemptStatus.SUCCEEDED,
          providerTransactionNo: 'CONFIRMED-TRANSACTION',
        });
      }
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(vnpay.queryTransaction).toHaveBeenCalledTimes(1);
      expect(tx.paymentAttempt.update.mock.calls[1][0].data).not.toHaveProperty(
        'status',
      );
      expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    },
  );
});
