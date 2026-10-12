import { createHash } from 'node:crypto';
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
import type { MomoService } from './momo.service';
import type { PaymentProviderFactory } from './payment-provider.factory';
import type { PayosService } from './payos.service';

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
    paymentReconciliationIncident: { upsert: jest.fn() },
    actionLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    paymentAttempt: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
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
  const payos = {
    verifyCallback: jest.fn(),
    verifyReturnState: jest.fn(),
    assertAmount: jest.fn(),
    paymentLinkId: jest.fn(() => 'a'.repeat(32)),
  };
  const service = new PaymentsService(
    prisma as unknown as ExtendedPrismaClient,
    new ConfigService({ VNPAY_ATTEMPT_TTL_MINUTES: 15 }),
    new PaginationUtilService(),
    ledger as unknown as CashierShiftLedgerService,
    invoices as unknown as InvoicesService,
    outbox as unknown as OutboxService,
    vnpay as unknown as VnpayService,
    {
      get: jest.fn(() => vnpay),
      createPaymentUrl: jest.fn(() => 'https://sandbox/payment'),
    } as unknown as PaymentProviderFactory,
    {} as MomoService,
    payos as unknown as PayosService,
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
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 1 });
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

  it('does not leak a reconstructable payOS checkout handle through ordinary reads', async () => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.PAYOS,
      paymentUrl: `https://pay.payos.vn/web/${'a'.repeat(32)}`,
      providerPaymentLinkId: 'a'.repeat(32),
    });
    expect(await service.findAttempt(attempt.id)).toEqual(
      expect.objectContaining({
        paymentUrl: null,
        providerPaymentLinkId: null,
      }),
    );
  });

  it('allocates payOS order codes in PostgreSQL and persists the bound link ID', async () => {
    tx.$queryRaw.mockResolvedValue([{ code: 1000000000n }]);
    tx.paymentAttempt.create.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.PAYOS,
      merchantReference: '1000000000',
    });
    await service.createAttempt('invoice-id', 'employee-id', '127.0.0.1', {
      provider: PaymentProvider.PAYOS,
      idempotencyKey: 'payos-sequence-key',
      locale: 'vn',
      closeSessionAfterPayment: true,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantReference: '1000000000',
          provider: PaymentProvider.PAYOS,
        }),
      }),
    );
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerPaymentLinkId: 'a'.repeat(32),
        }),
      }),
    );
  });

  it('queues a verified payOS webhook durably without calling a provider or booking money', async () => {
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.PAYOS,
    });
    tx.paymentWebhookEvent.create.mockResolvedValue({ id: 'webhook-id' });
    payos.verifyCallback.mockResolvedValue({
      payloadHash: 'signed-payload',
      data: {
        orderCode: 1000000000,
        amount: 50000,
        currency: 'VND',
        paymentLinkId: 'a'.repeat(32),
        reference: 'BANK-PARTIAL',
        code: '00',
      },
    });
    await service.handlePayosWebhook({});
    expect(outbox.enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventName: 'payos.payment.notified',
        payload: {
          paymentAttemptId: attempt.id,
          paymentLinkId: 'a'.repeat(32),
        },
      }),
    );
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.update).not.toHaveBeenCalled();
  });

  it('acknowledges only exact webhook replays and ignores signed registration probes', async () => {
    payos.verifyCallback.mockResolvedValue({
      payloadHash: 'signed-payload',
      data: {
        orderCode: 1000000000,
        amount: 100000,
        currency: 'VND',
        paymentLinkId: 'a'.repeat(32),
        reference: 'BANK-1',
        code: '00',
      },
    });
    await service.handlePayosWebhook({});
    expect(tx.paymentWebhookEvent.create).not.toHaveBeenCalled();
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.PAYOS,
    });
    tx.paymentWebhookEvent.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.0',
        meta: { target: ['payloadHash'] },
      }),
    );
    await expect(service.handlePayosWebhook({})).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does not look up payOS returns without a valid capability or trust public status', async () => {
    payos.verifyReturnState.mockReturnValue(null);
    expect(
      await service.inspectPayosReturn({
        orderCode: '1000000000',
        status: 'PAID',
      }),
    ).toEqual({ signatureValid: false, attempt: null });
    expect(prisma.paymentAttempt.findUnique).not.toHaveBeenCalled();
    payos.verifyReturnState.mockReturnValue('1000000000');
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      provider: PaymentProvider.PAYOS,
      status: 'PENDING',
    });
    expect(
      (await service.inspectPayosReturn({ state: 'valid', status: 'PAID' }))
        .attempt?.status,
    ).toBe('PENDING');
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
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
    expect(prisma.paymentAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paymentUrl: 'https://sandbox/payment' },
      }),
    );
  });

  it('recovers the persisted link without requesting another provider payment', async () => {
    const saved = { ...attempt, paymentUrl: 'https://sandbox/payment' };
    prisma.paymentAttempt.findUnique.mockResolvedValue(saved);
    expect(await service.recoverPaymentLink(attempt.id)).toEqual(saved);
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    expect(vnpay.createPaymentUrl).not.toHaveBeenCalled();
  });

  it.each([
    { status: PaymentAttemptStatus.SUCCEEDED },
    { expiresAt: new Date(0) },
    { paymentUrl: null },
    { invoice: { ...attempt.invoice, paymentStatus: PaymentStatus.PAID } },
  ])('does not recover an unusable link %j', async (change) => {
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      paymentUrl: 'https://sandbox/payment',
      ...change,
    });
    await expect(service.recoverPaymentLink(attempt.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.paymentAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('discards a generated link when payment completes before URL persistence', async () => {
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });
    prisma.paymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...attempt,
      status: PaymentAttemptStatus.SUCCEEDED,
      paymentUrl: null,
    });
    const result = await service.createAttempt(
      attempt.invoiceId,
      attempt.createdById,
      '127.0.0.1',
      {
        idempotencyKey: 'another-key',
        locale: 'vn',
        closeSessionAfterPayment: true,
      },
    );
    expect(result.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(result.paymentUrl).toBeNull();
  });

  it.each([PaymentAttemptStatus.EXPIRED, PaymentAttemptStatus.REQUIRES_REVIEW])(
    'rejects a new payment attempt while an earlier payment is %s',
    async (status) => {
      tx.paymentAttempt.findFirst.mockResolvedValue({
        id: 'unresolved-attempt',
        status,
      });

      await expect(
        service.createAttempt('invoice-id', 'employee-id', '127.0.0.1', {
          idempotencyKey: 'new-payment-key',
          locale: 'vn',
          closeSessionAfterPayment: true,
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
      expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
      expect(ledger.requireOpenShift).not.toHaveBeenCalled();
    },
  );

  it('returns the committed success when an expiry update loses to an IPN', async () => {
    const dto = {
      idempotencyKey: 'idempotency-key',
      locale: 'vn' as const,
      closeSessionAfterPayment: true,
    };
    const expired = {
      ...attempt,
      expiresAt: new Date(Date.now() - 1000),
      requestHash: createHash('sha256')
        .update(
          JSON.stringify({
            invoiceId: attempt.invoiceId,
            provider: PaymentProvider.VNPAY,
            locale: dto.locale,
            bankCode: null,
            closeSessionAfterPayment: true,
          }),
        )
        .digest('hex'),
    };
    prisma.paymentAttempt.findUnique
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce({
        ...expired,
        status: PaymentAttemptStatus.SUCCEEDED,
      });
    prisma.paymentAttempt.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.createAttempt(
      attempt.invoiceId,
      attempt.createdById,
      '127.0.0.1',
      dto,
    );

    expect(result.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(result.paymentUrl).toBeNull();
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
  });

  it('keeps a confirmed payment immutable when a conflicting signed success arrives', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: true,
      payloadHash: 'conflicting-success',
      params: {
        vnp_TxnRef: attempt.merchantReference,
        vnp_Amount: '10000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'OTHER-TRANSACTION',
      },
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      status: PaymentAttemptStatus.SUCCEEDED,
      providerTransactionNo: 'CONFIRMED-TRANSACTION',
      invoice: { paymentStatus: PaymentStatus.PAID },
    });
    tx.paymentWebhookEvent.create.mockResolvedValue({ id: 'event-id' });

    await expect(service.handleVnpayIpn({})).resolves.toMatchObject({
      RspCode: '02',
    });
    expect(tx.paymentReconciliationIncident.upsert).toHaveBeenCalledTimes(1);
    expect(tx.paymentAttempt.update).toHaveBeenCalledWith({
      where: { id: attempt.id },
      data: { nextReconcileAt: null, reconciliationLockedAt: null },
    });
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
  });

  it('does not clear a review hold with a later signed VNPay callback', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: true,
      payloadHash: 'review-success',
      params: {
        vnp_TxnRef: attempt.merchantReference,
        vnp_Amount: '10000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'VNP-001',
      },
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      status: PaymentAttemptStatus.REQUIRES_REVIEW,
    });
    tx.paymentWebhookEvent.create.mockResolvedValue({ id: 'event-id' });

    await expect(service.handleVnpayIpn({})).resolves.toMatchObject({
      RspCode: '02',
    });
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.update).not.toHaveBeenCalled();
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

  it('rejects a valid VNPay callback targeting a MoMo attempt', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: true,
      payloadHash: 'cross-provider-payload',
      params: {
        vnp_TxnRef: attempt.merchantReference,
        vnp_Amount: '10000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'VNP-001',
      },
    });
    tx.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.MOMO,
    });
    tx.paymentWebhookEvent.create.mockResolvedValue({ id: 'event-id' });

    await expect(service.handleVnpayIpn({})).resolves.toEqual({
      RspCode: '01',
      Message: 'Order not found',
    });
    expect(invoices.completeOnlinePayment).not.toHaveBeenCalled();
    expect(tx.paymentAttempt.update).not.toHaveBeenCalled();
    expect(tx.paymentWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-id' },
      data: { processingCode: '01', processedAt: expect.any(Date) },
    });
  });

  it('does not expose another provider attempt on a signed VNPay return', async () => {
    vnpay.verifyCallback.mockReturnValue({
      isValid: true,
      params: { vnp_TxnRef: attempt.merchantReference },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      ...attempt,
      provider: PaymentProvider.MOMO,
    });

    await expect(service.inspectVnpayReturn({})).resolves.toEqual({
      signatureValid: true,
      responseCode: null,
      transactionStatus: null,
      attempt: null,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
