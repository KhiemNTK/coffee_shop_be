import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { BankStatementEntryDirection, PrismaClient } from '@prisma/client';
import { BankReconciliationService } from '../src/app/cashier-shifts/bank-reconciliation.service';
import { PaymentReconciliationService } from '../src/app/payments/payment-reconciliation.service';
import { GetPaymentIncidentsDto } from '../src/app/payments/dto';
import { PaymentRefundsService } from '../src/app/payments/payment-refunds.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Reconciliation recovery (isolated PostgreSQL)', () => {
  const databaseName = `reconciliation_${randomUUID().replaceAll('-', '')}_test`;
  const employeeId = randomUUID();
  const reviewerId = randomUUID();
  const fundId = randomUUID();
  let admin: PrismaClient | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let service: BankReconciliationService;
  const statement = {
    fundId,
    sourceFileName: 'statement.json',
    statementFrom: new Date('2026-10-01T00:00:00Z'),
    statementTo: new Date('2026-10-02T00:00:00Z'),
    entries: [
      {
        externalId: 'BANK-001',
        direction: BankStatementEntryDirection.CREDIT,
        amount: '80000',
        transactionDate: new Date('2026-10-01T12:00:00Z'),
      },
    ],
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
      'Only use a dedicated loopback test database.',
    );
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: url.href }, stdio: 'pipe' },
    );
    prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
    const position = await prisma.position.create({
      data: { name: 'Recovery test', salary: 0 },
    });
    await prisma.employee.create({
      data: {
        id: employeeId,
        positionId: position.id,
        fullName: 'Recovery test',
        email: 'recovery@example.test',
        username: 'recovery-test',
        password: 'unused',
      },
    });
    await prisma.employee.create({
      data: {
        id: reviewerId,
        positionId: position.id,
        fullName: 'Refund reviewer',
        email: 'reviewer@example.test',
        username: 'refund-reviewer',
        password: 'unused',
      },
    });
    await prisma.fund.create({
      data: { id: fundId, name: 'Recovery bank', type: 'BANK' },
    });
    service = new BankReconciliationService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
    );
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (created)
      await admin?.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin?.$disconnect();
  });

  it('commits one import, one entry and one import audit for concurrent identical requests', async () => {
    const results = await Promise.all([
      service.createImport(employeeId, statement),
      service.createImport(employeeId, statement),
    ]);
    expect(results[0].statementImport.id).toBe(results[1].statementImport.id);
    expect(await prisma!.bankStatementImport.count()).toBe(1);
    expect(await prisma!.bankStatementEntry.count()).toBe(1);
    expect(
      await prisma!.actionLog.count({
        where: { actionType: 'BANK_STATEMENT_IMPORTED' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma!.fund.findUniqueOrThrow({ where: { id: fundId } })
      ).balance.toFixed(2),
    ).toBe('0.00');
  });

  it('recovers a lost reply without mutations and rejects overlaps with changed amounts', async () => {
    const auditCount = await prisma!.actionLog.count();
    const result = await service.recoverImport(employeeId, {
      ...statement,
      sourceFileName: 'renamed.json',
    });
    expect(result.replayed).toBe(true);
    expect(await prisma!.actionLog.count()).toBe(auditCount);
    await expect(
      service.createImport(employeeId, {
        ...statement,
        entries: [{ ...statement.entries[0], amount: '81000' }],
      }),
    ).rejects.toThrow(ConflictException);
    expect(await prisma!.bankStatementImport.count()).toBe(1);
  });

  it('executes bounded incident searches, including UUID and enum terms, on PostgreSQL', async () => {
    const payments = new PaymentReconciliationService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (const keyword of ['INV-2026', 'stale', randomUUID()]) {
      expect(
        await payments.findIncidents(
          GetPaymentIncidentsDto.schema.parse({
            keyword,
            status: 'OPEN',
            page: 2,
          }),
        ),
      ).toMatchObject({ list: [], totalItems: 0 });
    }
  });

  async function paidPayment() {
    const now = new Date();
    const shift = await prisma!.cashierShift.create({
      data: {
        employeeId,
        openedAt: new Date(now.getTime() - 60_000),
        status: 'CLOSED',
        closedAt: now,
        actualEndingCash: 0,
        reportedEndingCash: 0,
      },
    });
    const session = await prisma!.orderSession.create({ data: { employeeId } });
    const invoice = await prisma!.invoice.create({
      data: {
        invoiceNumber: randomUUID(),
        subTotal: '100000',
        totalAmount: '100000',
        paymentStatus: 'PAID',
        paymentMethod: 'TRANSFER',
        employeeId,
        orderSessionId: session.id,
        shiftId: shift.id,
      },
    });
    const attempt = await prisma!.paymentAttempt.create({
      data: {
        invoiceId: invoice.id,
        shiftId: shift.id,
        createdById: employeeId,
        provider: 'VNPAY',
        status: 'SUCCEEDED',
        amount: '100000',
        merchantReference: randomUUID(),
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        providerTransactionNo: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
        completedAt: new Date(),
      },
    });
    return { invoice, attempt };
  }

  async function uncertainRefund() {
    const { invoice, attempt } = await paidPayment();
    const refund = await prisma!.paymentRefund.create({
      data: {
        paymentAttemptId: attempt.id,
        requestedById: employeeId,
        type: 'PARTIAL',
        status: 'REQUIRES_REVIEW',
        amount: '20000',
        reason: 'Provider result unknown',
        idempotencyKey: randomUUID(),
        requestHash: 'b'.repeat(64),
        providerRequestId: randomUUID(),
      },
    });
    await prisma!.paymentReconciliationIncident.create({
      data: {
        paymentAttemptId: attempt.id,
        paymentRefundId: refund.id,
        type: 'PROVIDER_UNAVAILABLE',
        title: 'Uncertain refund',
        details: {},
        deduplicationKey: randomUUID(),
      },
    });
    return {
      invoice,
      refund,
      input: {
        expectedUpdatedAt: refund.updatedAt.toISOString(),
        expectedAmount: '20000',
        outcome: 'SUCCEEDED' as const,
        providerReference: randomUUID(),
        evidenceReference: 'Provider support case TEST-123',
        resolutionNote:
          'Verified the exact refund request and amount with the provider.',
      },
    };
  }

  it('commits one refund verification, invoice update, audit and outbox under concurrent reviewers', async () => {
    const { refund, invoice, input } = await uncertainRefund();
    const refunds = new PaymentRefundsService(
      prisma as never,
      new PaginationUtilService(),
      new OutboxService(),
      {} as never,
    );
    const results = await Promise.allSettled([
      refunds.reconcileRefund(refund.id, reviewerId, input),
      refunds.reconcileRefund(refund.id, reviewerId, input),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      (await prisma!.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe('PARTIALLY_REFUNDED');
    expect(
      (
        await prisma!.paymentRefund.findUniqueOrThrow({
          where: { id: refund.id },
        })
      ).status,
    ).toBe('SUCCEEDED');
    expect(
      await prisma!.outboxEvent.count({
        where: {
          aggregateId: refund.id,
          eventName: 'PAYMENT_REFUND_RECONCILED',
        },
      }),
    ).toBe(1);
    expect(
      await prisma!.actionLog.count({
        where: {
          actionType: 'PAYMENT_REFUND_MANUALLY_RECONCILED',
          details: { path: ['paymentRefundId'], equals: refund.id },
        },
      }),
    ).toBe(1);
    expect(
      await prisma!.paymentProviderRequest.count({
        where: { paymentRefundId: refund.id },
      }),
    ).toBe(0);
  });

  it('rolls back refund state, invoice and audit when durable event recording fails', async () => {
    const { refund, invoice, input } = await uncertainRefund();
    const failedOutbox = {
      enqueue: () => {
        throw new Error('Injected durable storage failure');
      },
    };
    const refunds = new PaymentRefundsService(
      prisma as never,
      new PaginationUtilService(),
      failedOutbox as never,
      {} as never,
    );
    await expect(
      refunds.reconcileRefund(refund.id, reviewerId, input),
    ).rejects.toThrow('Injected durable storage failure');
    expect(
      (await prisma!.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe('PAID');
    expect(
      (
        await prisma!.paymentRefund.findUniqueOrThrow({
          where: { id: refund.id },
        })
      ).status,
    ).toBe('REQUIRES_REVIEW');
    expect(
      await prisma!.actionLog.count({
        where: { details: { path: ['paymentRefundId'], equals: refund.id } },
      }),
    ).toBe(0);
  });

  it('never overwrites a completed manual verification with a late provider response', async () => {
    const { invoice, attempt } = await paidPayment();
    let received!: () => void;
    let respond!: () => void;
    const called = new Promise<void>((resolve) => {
      received = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const provider = {
      assertApiConfigured: () => undefined,
      refundTransaction: async () => {
        received();
        await responseGate;
        return {
          request: {},
          response: {
            vnp_TxnRef: attempt.merchantReference,
            vnp_Amount: '2000000',
            vnp_TransactionType: '03',
            vnp_ResponseCode: '00',
            vnp_TransactionStatus: '02',
            vnp_TransactionNo: 'LATE-PROVIDER-RESPONSE',
          },
        };
      },
    };
    const refunds = new PaymentRefundsService(
      prisma as never,
      new PaginationUtilService(),
      new OutboxService(),
      provider as never,
    );
    const pending = refunds.createRefund(attempt.id, employeeId, {
      amount: '20000',
      reason: 'Late response verification test',
      idempotencyKey: randomUUID(),
    });
    // Attach the rejection handler before releasing the provider gate.
    const completed = pending.then(
      (value) => ({ value, failed: false }),
      () => ({ value: null, failed: true }),
    );
    await called;
    const processing = await prisma!.paymentRefund.findFirstOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    const review = await prisma!.paymentRefund.update({
      where: { id: processing.id },
      data: { status: 'REQUIRES_REVIEW', reconciliationLockedAt: null },
    });
    try {
      await refunds.reconcileRefund(review.id, reviewerId, {
        expectedUpdatedAt: review.updatedAt.toISOString(),
        expectedAmount: '20000',
        outcome: 'SUCCEEDED',
        providerReference: 'MANUAL-VERIFIED-123',
        evidenceReference: 'Provider support case TEST-123',
        resolutionNote:
          'Verified the exact refund request and amount with provider evidence.',
      });
    } finally {
      respond();
    }
    expect((await completed).failed).toBe(true);
    expect(
      await prisma!.paymentRefund.findUniqueOrThrow({
        where: { id: review.id },
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      providerTransactionNo: 'MANUAL-VERIFIED-123',
    });
    expect(
      (await prisma!.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe('PARTIALLY_REFUNDED');
  });
});
