import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PayOS } from '@payos/node';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAttemptStatus,
  PaymentProvider,
  FundType,
  PaymentMethod,
  PaymentRefundStatus,
  PaymentRefundType,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ServeStatus,
  SessionStatus,
  ShiftStatus,
  TableStatus,
} from '@prisma/client';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { InvoiceNumberService } from '../src/app/invoices/invoice-number.service';
import { InvoicePolicyService } from '../src/app/invoices/invoice-policy.service';
import { InvoicesService } from '../src/app/invoices/invoices.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { PaymentsService } from '../src/app/payments/payments.service';
import { PaymentRefundsService } from '../src/app/payments/payment-refunds.service';
import { VnpayService } from '../src/app/payments/vnpay.service';
import { MomoService } from '../src/app/payments/momo.service';
import { PaymentProviderFactory } from '../src/app/payments/payment-provider.factory';
import { PayosService } from '../src/app/payments/payos.service';
import { PaymentReconciliationService } from '../src/app/payments/payment-reconciliation.service';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import type { PromotionCalculatorService } from '../src/app/promotions/services/promotion-calculator.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../src/common/utils/query-util/query-util.service';
import { ORDER_EVENTS } from '../src/app/orders/events/order.events';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';

describe('VNPay payment lifecycle (e2e)', () => {
  const prisma = new PrismaClient();
  const extendedPrisma = prisma as unknown as ExtendedPrismaClient;
  const pagination = new PaginationUtilService();
  const ledger = new CashierShiftLedgerService();
  const outbox = new OutboxService();
  const config = new ConfigService({
    VNPAY_TMN_CODE: 'COFFEE01',
    VNPAY_HASH_SECRET: 'sandbox-secret-123456789',
    VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    VNPAY_RETURN_URL: 'https://coffee.example.com/payment/vnpay/return',
    VNPAY_ATTEMPT_TTL_MINUTES: 15,
    MOMO_PARTNER_CODE: 'TESTSHOP',
    MOMO_ACCESS_KEY: 'access-key',
    MOMO_SECRET_KEY: 'momo-sandbox-secret-123456789',
    MOMO_API_URL: 'https://test-payment.momo.vn',
    MOMO_REDIRECT_URL: 'https://shop.example.com/payment/momo/return',
    MOMO_IPN_URL: 'https://api.example.com/api/v1/payments/momo/ipn',
    MOMO_API_TIMEOUT_MS: 30_000,
    PAYOS_CLIENT_ID: 'fixture-client-id-not-a-real-credential',
    PAYOS_API_KEY: 'fixture-api-key-not-a-real-credential',
    PAYOS_CHECKSUM_KEY: 'fixture-checksum-key-not-a-real-credential',
    PAYOS_RETURN_URL: 'https://coffee.example.com/payment/payos/return',
    PAYOS_API_TIMEOUT_MS: 5000,
    JWT_SECRET: 'fixture-return-secret-not-a-real-credential',
  });
  const invoices = new InvoicesService(
    extendedPrisma,
    pagination,
    new QueryUtilService(),
    new InvoicePolicyService(),
    new InvoiceNumberService(),
    new IdempotencyService(extendedPrisma),
    outbox,
    {} as PromotionCalculatorService,
    ledger,
    new InventoryConsumptionService(outbox),
  );
  const payments = new PaymentsService(
    extendedPrisma,
    config,
    pagination,
    ledger,
    invoices,
    outbox,
    new VnpayService(config),
    new PaymentProviderFactory(
      new VnpayService(config),
      new MomoService(config),
      new PayosService(config),
    ),
    new MomoService(config),
    new PayosService(config),
  );
  const refundGateway = {
    assertApiConfigured: jest.fn(),
    refundTransaction: jest.fn(),
  };
  const paymentRefunds = new PaymentRefundsService(
    extendedPrisma,
    pagination,
    outbox,
    refundGateway as unknown as VnpayService,
  );
  const suffix = randomUUID();
  const invoiceIds: string[] = [];
  const sessionIds: string[] = [];
  const tableIds: string[] = [];
  let positionId: string;
  let employeeId: string;
  let secondEmployeeId: string;
  let fundId: string;
  let secondFundId: string;
  let shiftId: string;
  let secondShiftId: string;
  let categoryId: string;

  const createUnpaidInvoice = async (amount: string) => {
    const table = await prisma.diningTable.create({
      data: {
        name: `Payment table ${randomUUID()} ${suffix}`,
        status: TableStatus.OCCUPIED,
      },
    });
    tableIds.push(table.id);
    const session = await prisma.orderSession.create({
      data: {
        employeeId,
        tableId: table.id,
        shiftId,
        sessionStatus: SessionStatus.ACTIVE,
      },
    });
    sessionIds.push(session.id);
    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Payment item ${randomUUID()} ${suffix}`,
        price: new Prisma.Decimal(amount),
        categoryId,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `PAY-${randomUUID()}`,
        subTotal: new Prisma.Decimal(amount),
        totalAmount: new Prisma.Decimal(amount),
        paymentMethod: PaymentMethod.TRANSFER,
        paymentStatus: PaymentStatus.UNPAID,
        orderSessionId: session.id,
        employeeId,
      },
    });
    invoiceIds.push(invoice.id);
    await prisma.orderItem.create({
      data: {
        quantity: 1,
        priceAtTime: new Prisma.Decimal(amount),
        serveStatus: ServeStatus.SERVED,
        orderSessionId: session.id,
        menuItemId: menuItem.id,
        invoiceId: invoice.id,
      },
    });
    return { invoice, session, table, menuItemId: menuItem.id };
  };

  const signIpn = (input: {
    merchantReference: string;
    amount: Prisma.Decimal;
    transactionNo: string;
    responseCode?: string;
    transactionStatus?: string;
  }) => {
    const params: Record<string, string> = {
      vnp_TmnCode: 'COFFEE01',
      vnp_TxnRef: input.merchantReference,
      vnp_Amount: input.amount.mul(100).toFixed(0),
      vnp_ResponseCode: input.responseCode ?? '00',
      vnp_TransactionStatus: input.transactionStatus ?? '00',
      vnp_TransactionNo: input.transactionNo,
    };
    const search = new URLSearchParams();
    Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, value]) => search.append(key, value));
    return {
      ...params,
      vnp_SecureHash: createHmac('sha512', 'sandbox-secret-123456789')
        .update(search.toString())
        .digest('hex'),
    };
  };

  const signMomo = (fields: Record<string, string>) =>
    createHmac('sha256', 'momo-sandbox-secret-123456789')
      .update(
        Object.entries(fields)
          .map(([key, value]) => `${key}=${value}`)
          .join('&'),
      )
      .digest('hex');

  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(database.hostname) &&
        database.pathname.endsWith('_test'),
      'Use a dedicated loopback test database, never the business database.',
    );
    const position = await prisma.position.create({
      data: { name: `Payment Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `payment-${suffix}@example.com`,
        username: `payment-${suffix}`,
        fullName: 'Payment Cashier',
        password: 'not-used-in-payment-tests',
        positionId,
      },
    });
    employeeId = employee.id;
    const secondEmployee = await prisma.employee.create({
      data: {
        email: `payment-second-${suffix}@example.com`,
        username: `payment-second-${suffix}`,
        fullName: 'Second Payment Cashier',
        password: 'not-used-in-payment-tests',
        positionId,
      },
    });
    secondEmployeeId = secondEmployee.id;
    const fund = await prisma.fund.create({
      data: {
        name: `Payment Fund ${suffix}`,
        type: FundType.CASH,
        balance: new Prisma.Decimal(0),
      },
    });
    fundId = fund.id;
    const secondFund = await prisma.fund.create({
      data: {
        name: `Second Payment Fund ${suffix}`,
        type: FundType.CASH,
        balance: new Prisma.Decimal(0),
      },
    });
    secondFundId = secondFund.id;
    const category = await prisma.menuCategory.create({
      data: { name: `Payment Category ${suffix}` },
    });
    categoryId = category.id;
    const shift = await prisma.cashierShift.create({
      data: {
        employeeId,
        fundId,
        status: ShiftStatus.OPEN,
        startingCash: new Prisma.Decimal(0),
        expectedStartingCash: new Prisma.Decimal(0),
        openingDifference: new Prisma.Decimal(0),
      },
    });
    shiftId = shift.id;
    const secondShift = await prisma.cashierShift.create({
      data: {
        employeeId: secondEmployeeId,
        fundId: secondFundId,
        status: ShiftStatus.OPEN,
        startingCash: new Prisma.Decimal(0),
        expectedStartingCash: new Prisma.Decimal(0),
        openingDifference: new Prisma.Decimal(0),
      },
    });
    secondShiftId = secondShift.id;
  });

  afterAll(async () => {
    try {
      const attempts = await prisma.paymentAttempt.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: { id: true },
      });
      const attemptIds = attempts.map(({ id }) => id);
      const refunds = await prisma.paymentRefund.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const refundIds = refunds.map(({ id }) => id);
      await prisma.paymentReconciliationIncident.deleteMany({
        where: { paymentAttemptId: { in: attemptIds } },
      });
      await prisma.paymentProviderRequest.deleteMany({
        where: { paymentAttemptId: { in: attemptIds } },
      });
      await prisma.paymentRefund.deleteMany({
        where: { paymentAttemptId: { in: attemptIds } },
      });
      await prisma.paymentWebhookEvent.deleteMany({
        where: { paymentAttempt: { invoiceId: { in: invoiceIds } } },
      });
      await prisma.paymentAttempt.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: { in: [...invoiceIds, ...attemptIds, ...refundIds] },
        },
      });
      await prisma.idempotencyRequest.deleteMany({
        where: { employeeId: { in: [employeeId, secondEmployeeId] } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderSessionId: { in: sessionIds } },
      });
      await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await prisma.orderSession.deleteMany({
        where: { id: { in: sessionIds } },
      });
      await prisma.menuItem.deleteMany({
        where: { name: { contains: suffix } },
      });
      await prisma.menuCategory.deleteMany({ where: { id: categoryId } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({
          where: { employeeId: { in: [employeeId, secondEmployeeId] } },
        });
      });
      await prisma.cashierShift.deleteMany({
        where: { id: { in: [shiftId, secondShiftId] } },
      });
      await prisma.fund.deleteMany({
        where: { id: { in: [fundId, secondFundId] } },
      });
      await prisma.diningTable.deleteMany({ where: { id: { in: tableIds } } });
      await prisma.employee.deleteMany({
        where: { id: { in: [employeeId, secondEmployeeId] } },
      });
      await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it.each(['failure', 'mismatch', 'timeout'])(
    'preserves an IPN success racing a reconciliation %s',
    async (outcome) => {
      const { invoice } = await createUnpaidInvoice('100000');
      const attempt = await payments.createAttempt(
        invoice.id,
        employeeId,
        '127.0.0.1',
        {
          idempotencyKey: randomUUID(),
          locale: 'vn',
          closeSessionAfterPayment: true,
        },
      );
      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { reconciliationAttempts: 4 },
      });
      let release!: () => void;
      let signalRead!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      let reads = 0;
      const gatedPrisma = prisma.$extends({
        query: {
          paymentAttempt: {
            async findUnique({ args, query }) {
              const result = await query(args);
              // The first included read is outside the transaction; pause the next snapshot read.
              if (
                args.where.id === attempt.id &&
                args.include &&
                ++reads === 2
              ) {
                signalRead();
                await gate;
              }
              return result;
            },
          },
        },
      });
      const gateway = {
        assertApiConfigured: jest.fn(),
        queryTransaction: jest.fn(),
        isFinalPaymentFailure: VnpayService.prototype.isFinalPaymentFailure,
      };
      if (outcome === 'timeout') {
        gateway.queryTransaction.mockRejectedValue(
          new Error('Provider timeout'),
        );
      } else {
        gateway.queryTransaction.mockResolvedValue({
          request: {},
          response: {
            vnp_ResponseCode: '00',
            vnp_TransactionStatus: outcome === 'failure' ? '02' : '00',
            vnp_TxnRef: attempt.merchantReference,
            vnp_Amount: outcome === 'mismatch' ? '9999999' : '10000000',
            vnp_TransactionType: '01',
          },
        });
      }
      const reconciliation = new PaymentReconciliationService(
        gatedPrisma as unknown as ExtendedPrismaClient,
        pagination,
        invoices,
        outbox,
        gateway as unknown as VnpayService,
        new MomoService(config),
        new PayosService(config),
        new DomainEventBusService(),
      );
      const running = reconciliation
        .reconcileAttempt(attempt.id, employeeId)
        .then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Snapshot was not read')),
              2_000,
            );
          }),
        ]);
        const ipn = await payments.handleVnpayIpn(
          signIpn({
            merchantReference: attempt.merchantReference,
            amount: attempt.amount,
            transactionNo: `RACE-${randomUUID()}`,
          }),
        );
        expect(ipn.RspCode).toBe('00');
        release();
        const settled = await running;
        if (outcome === 'timeout') expect(settled.error).toBeInstanceOf(Error);
        else {
          expect(settled.error).toBeUndefined();
          expect(settled.result?.status).toBe(PaymentAttemptStatus.SUCCEEDED);
        }
        const stored = await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
          include: { invoice: true },
        });
        expect(stored.status).toBe(PaymentAttemptStatus.SUCCEEDED);
        expect(stored.providerTransactionNo).toMatch(/^RACE-/);
        expect(stored.invoice.paymentStatus).toBe(PaymentStatus.PAID);
        expect(gateway.queryTransaction).toHaveBeenCalledTimes(1);
        expect(
          await prisma.outboxEvent.count({
            where: {
              aggregateId: invoice.id,
              eventName: ORDER_EVENTS.INVOICE_PAID,
            },
          }),
        ).toBe(1);
      } finally {
        if (deadline) clearTimeout(deadline);
        release();
        await running;
      }
    },
    15_000,
  );

  it.each(['full', 'split', 'overpaid'])(
    'handles payOS %s payments through PostgreSQL and Redis exactly once',
    async (scenario) => {
      const redis = new URL(process.env.REDIS_URL ?? '');
      assert(
        ['localhost', '127.0.0.1'].includes(redis.hostname) &&
          ['/14', '/15'].includes(redis.pathname),
        'Use isolated Redis DB 14/15 for payment tests.',
      );
      const checksumKey = config.getOrThrow<string>('PAYOS_CHECKSUM_KEY');
      const signer = new PayOS({
        clientId: 'fixture',
        apiKey: 'fixture',
        checksumKey,
        logLevel: 'off',
      });
      const linkId = randomUUID().replaceAll('-', '');
      let orderCode = 0;
      let returnState: string | null = null;
      let queryCount = 0;
      let amountPaid = 0;
      let transactions: Array<{ reference: string; amount: number }> = [];
      const signed = async (data: Record<string, unknown>) =>
        Response.json({
          code: '00',
          data,
          signature: await signer.crypto.createSignatureFromObj(
            data,
            checksumKey,
          ),
        });
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url, options) => {
          const requestUrl =
            typeof url === 'string' || url instanceof URL
              ? new URL(url)
              : new URL(url.url);
          expect(requestUrl.origin).toBe('https://api-merchant.payos.vn');
          if (options?.method === 'POST') {
            if (orderCode)
              return Response.json({ code: '201', desc: 'already exists' });
            if (typeof options.body !== 'string')
              throw new Error('Expected JSON request');
            const body = JSON.parse(options.body) as {
              orderCode: number;
              returnUrl: string;
            };
            orderCode = body.orderCode;
            returnState = new URL(body.returnUrl).searchParams.get('state');
            return signed({
              paymentLinkId: linkId,
              orderCode,
              amount: 35000,
              currency: 'VND',
              status: 'PENDING',
              checkoutUrl: `https://pay.payos.vn/web/${linkId}`,
            });
          }
          queryCount++;
          return signed({
            id: linkId,
            orderCode,
            amount: 35000,
            amountPaid,
            amountRemaining: 35000 - amountPaid,
            status:
              amountPaid >= 35000
                ? 'PAID'
                : amountPaid
                  ? 'UNDERPAID'
                  : 'PENDING',
            transactions,
          });
        });
      const bus = new DomainEventBusService();
      const reconciliation = new PaymentReconciliationService(
        extendedPrisma,
        pagination,
        invoices,
        outbox,
        new VnpayService(config),
        new MomoService(config),
        new PayosService(config),
        bus,
      );
      const dispatcher = new OutboxDispatcherService(
        extendedPrisma,
        new ConfigService({
          REDIS_URL: redis.href,
          OUTBOX_POLL_INTERVAL_MS: 0,
        }),
        bus,
      );
      const waitUntil = async (predicate: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('payOS outbox consumer did not finish');
      };
      const webhook = async (reference: string, amount: number) => {
        const data = {
          orderCode,
          amount,
          currency: 'VND',
          paymentLinkId: linkId,
          reference,
          code: '00',
          desc: 'success',
          description: 'Coffee',
          accountNumber: 'private-bank-account',
          transactionDateTime: '2026-10-12 12:00:00',
        };
        return {
          code: '00',
          desc: 'success',
          success: true,
          data,
          signature: await signer.crypto.createSignatureFromObj(
            data,
            checksumKey,
          ),
        };
      };
      try {
        const { invoice } = await createUnpaidInvoice('35000');
        const dto = {
          provider: PaymentProvider.PAYOS,
          idempotencyKey: randomUUID(),
          locale: 'vn' as const,
          closeSessionAfterPayment: true,
        };
        const attempts = await Promise.all([
          payments.createAttempt(invoice.id, employeeId, '127.0.0.1', dto),
          payments.createAttempt(invoice.id, employeeId, '127.0.0.1', dto),
        ]);
        expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1);
        const attempt = attempts[0];
        expect(Number.isSafeInteger(Number(attempt.merchantReference))).toBe(
          true,
        );
        expect(
          await payments.inspectPayosReturn({
            orderCode: String(orderCode),
            status: 'PAID',
          }),
        ).toEqual({ signatureValid: false, attempt: null });
        expect(
          (
            await payments.inspectPayosReturn({
              state: returnState ?? '',
              status: 'PAID',
            })
          ).attempt?.status,
        ).toBe(PaymentAttemptStatus.PENDING);
        reconciliation.onModuleInit();
        await dispatcher.onApplicationBootstrap();
        const firstAmount =
          scenario === 'split'
            ? 15000
            : scenario === 'overpaid'
              ? 35001
              : 35000;
        amountPaid = firstAmount;
        transactions = [{ reference: 'BANK-1', amount: firstAmount }];
        const first = await webhook('BANK-1', firstAmount);
        await expect(
          payments.handlePayosWebhook({ ...first, signature: '0'.repeat(64) }),
        ).rejects.toThrow();
        const queriesBefore = queryCount;
        await Promise.all([
          payments.handlePayosWebhook(first),
          payments.handlePayosWebhook(first),
        ]);
        expect(queryCount).toBe(queriesBefore);
        expect(
          await prisma.paymentWebhookEvent.count({
            where: { paymentAttemptId: attempt.id },
          }),
        ).toBe(1);
        await dispatcher.drainOnce();
        await waitUntil(
          async () =>
            queryCount > queriesBefore &&
            (await prisma.outboxEvent.count({
              where: {
                aggregateId: attempt.id,
                eventName: 'payos.payment.notified',
                status: 'PUBLISHED',
              },
            })) === 1,
        );
        if (scenario === 'split') {
          expect(
            (
              await prisma.invoice.findUniqueOrThrow({
                where: { id: invoice.id },
              })
            ).paymentStatus,
          ).toBe(PaymentStatus.UNPAID);
          amountPaid = 35000;
          transactions = [
            ...transactions,
            { reference: 'BANK-2', amount: 20000 },
          ];
          await payments.handlePayosWebhook(await webhook('BANK-2', 20000));
          await dispatcher.drainOnce();
        }
        const expected =
          scenario === 'overpaid'
            ? PaymentAttemptStatus.REQUIRES_REVIEW
            : PaymentAttemptStatus.SUCCEEDED;
        await waitUntil(
          async () =>
            (
              await prisma.paymentAttempt.findUniqueOrThrow({
                where: { id: attempt.id },
              })
            ).status === expected,
        );
        const result = await prisma.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
        });
        expect(result.paymentStatus).toBe(
          scenario === 'overpaid' ? PaymentStatus.UNPAID : PaymentStatus.PAID,
        );
        if (scenario !== 'overpaid') {
          await bus.publish('payos.payment.notified', {
            paymentAttemptId: attempt.id,
            paymentLinkId: linkId,
          });
          expect(
            (
              await prisma.paymentAttempt.findUniqueOrThrow({
                where: { id: attempt.id },
              })
            ).providerTransactionNo,
          ).toBe(linkId);
          const confirmations = await prisma.actionLog.findMany({
            where: {
              actionType: 'PAYMENT_RECONCILED',
              details: { path: ['paymentAttemptId'], equals: attempt.id },
            },
          });
          expect(confirmations).toHaveLength(1);
          expect(confirmations[0].details).toEqual(
            expect.objectContaining({ source: 'WEBHOOK' }),
          );
        }
        expect(
          await prisma.cashTransaction.count({
            where: { invoiceId: invoice.id },
          }),
        ).toBe(0);
        expect(
          JSON.stringify(
            await prisma.paymentWebhookEvent.findMany({
              where: { paymentAttemptId: attempt.id },
            }),
          ),
        ).not.toContain('private-bank-account');
      } finally {
        await dispatcher.onModuleDestroy();
        reconciliation.onModuleDestroy();
        fetchSpy.mockRestore();
      }
    },
    20000,
  );

  it('reserves pending ingredients before returning a payment URL and does not reserve twice on retry', async () => {
    const { invoice, menuItemId } = await createUnpaidInvoice('30000');
    const ingredient = await prisma.inventoryItem.create({
      data: {
        name: `Payment ingredient ${suffix}`,
        stock: '1',
        averageUnitCost: '100',
        unit: { create: { name: `Payment unit ${suffix}` } },
        category: { create: { name: `Payment ingredients ${suffix}` } },
      },
    });
    try {
      await prisma.menuItemIngredient.create({
        data: { menuItemId, inventoryItemId: ingredient.id, quantity: '1' },
      });
      await prisma.orderItem.updateMany({
        where: { invoiceId: invoice.id },
        data: { serveStatus: ServeStatus.PENDING },
      });
      const request = {
        idempotencyKey: randomUUID(),
        locale: 'vn' as const,
        closeSessionAfterPayment: false,
      };
      const attempt = await payments.createAttempt(
        invoice.id,
        employeeId,
        '127.0.0.1',
        request,
      );
      expect(attempt.paymentUrl).toBeTruthy();
      expect(
        (
          await prisma.inventoryItem.findUniqueOrThrow({
            where: { id: ingredient.id },
          })
        ).reservedStock.toString(),
      ).toBe('1');
      expect(
        await prisma.inventoryReservation.count({
          where: { inventoryItemId: ingredient.id },
        }),
      ).toBe(1);
      expect(
        (
          await payments.createAttempt(
            invoice.id,
            employeeId,
            '127.0.0.1',
            request,
          )
        ).id,
      ).toBe(attempt.id);
      expect(
        (
          await prisma.inventoryItem.findUniqueOrThrow({
            where: { id: ingredient.id },
          })
        ).reservedStock.toString(),
      ).toBe('1');
    } finally {
      const itemIds = (
        await prisma.orderItem.findMany({
          where: { invoiceId: invoice.id },
          select: { id: true },
        })
      ).map((item) => item.id);
      await prisma.$transaction((tx) =>
        new InventoryConsumptionService(outbox).releaseReservations(
          tx as never,
          itemIds,
        ),
      );
      await prisma.orderItemRecipeIngredient.deleteMany({
        where: { inventoryItemId: ingredient.id },
      });
      await prisma.menuItemIngredient.deleteMany({
        where: { inventoryItemId: ingredient.id },
      });
      await prisma.inventoryItem.delete({ where: { id: ingredient.id } });
      await prisma.unit.delete({ where: { id: ingredient.unitId } });
      await prisma.inventoryCategory.delete({
        where: { id: ingredient.categoryId },
      });
    }
  });

  it('finalizes a signed IPN exactly once without booking cash', async () => {
    const { invoice, session, table } = await createUnpaidInvoice('125000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: true,
      },
    );
    const ipn = signIpn({
      merchantReference: created.merchantReference,
      amount: invoice.totalAmount,
      transactionNo: `VNP-${randomUUID()}`,
    });

    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });

    const [paidInvoice, succeeded, paidItem, completedSession, emptyTable] =
      await Promise.all([
        prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
        prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: created.id },
        }),
        prisma.orderItem.findFirstOrThrow({
          where: { invoiceId: invoice.id },
        }),
        prisma.orderSession.findUniqueOrThrow({ where: { id: session.id } }),
        prisma.diningTable.findUniqueOrThrow({ where: { id: table.id } }),
      ]);
    expect(paidInvoice.paymentStatus).toBe(PaymentStatus.PAID);
    expect(paidInvoice.paymentMethod).toBe(PaymentMethod.TRANSFER);
    expect(succeeded.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(paidItem.isPaid).toBe(true);
    expect(completedSession.sessionStatus).toBe(SessionStatus.ACTIVE);
    expect(emptyTable.status).toBe(TableStatus.OCCUPIED);
    await expect(
      prisma.cashTransaction.count({ where: { invoiceId: invoice.id } }),
    ).resolves.toBe(0);
  });

  it('settles a signed MoMo IPN once and ignores a forged replay', async () => {
    const { invoice } = await createUnpaidInvoice('125000');
    const payUrl = 'https://test-payment.momo.vn/v2/gateway/pay?test=1';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((_url, init) => {
        const request = JSON.parse(init?.body as string) as {
          orderId: string;
          amount: number;
        };
        const response = {
          partnerCode: 'TESTSHOP',
          orderId: request.orderId,
          requestId: request.orderId,
          amount: request.amount,
          message: 'Successful.',
          resultCode: 0,
          payUrl,
          responseTime: 123456,
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...response,
              signature: signMomo({
                accessKey: 'access-key',
                amount: String(request.amount),
                orderId: request.orderId,
                partnerCode: 'TESTSHOP',
                payUrl,
                requestId: request.orderId,
                responseTime: '123456',
                resultCode: '0',
              }),
            }),
            { status: 200 },
          ),
        );
      });
    try {
      const created = await payments.createAttempt(
        invoice.id,
        employeeId,
        '127.0.0.1',
        {
          provider: PaymentProvider.MOMO,
          idempotencyKey: `momo-${randomUUID()}`,
          locale: 'vn',
          closeSessionAfterPayment: false,
        },
      );
      expect(created.paymentUrl).toBe(payUrl);
      const fields = {
        accessKey: 'access-key',
        amount: '125000',
        extraData: '',
        message: 'Successful.',
        orderId: created.merchantReference,
        orderInfo: `Thanh toan hoa don ${invoice.invoiceNumber}`,
        orderType: 'momo_wallet',
        partnerCode: 'TESTSHOP',
        payType: 'qr',
        requestId: created.merchantReference,
        responseTime: String(Date.now()),
        resultCode: '0',
        transId: String(Date.now()),
      };
      const callback = {
        ...fields,
        amount: 125000,
        responseTime: Number(fields.responseTime),
        resultCode: 0,
        transId: Number(fields.transId),
        signature: signMomo(fields),
      };
      await expect(
        payments.handleMomoIpn({ ...callback, amount: 1 }),
      ).rejects.toThrow();
      await payments.handleMomoIpn(callback);
      await payments.handleMomoIpn(callback);
      const lateFailureFields = {
        ...fields,
        resultCode: '1001',
        message: 'Insufficient funds.',
      };
      await payments.handleMomoIpn({
        ...callback,
        resultCode: 1001,
        message: lateFailureFields.message,
        signature: signMomo(lateFailureFields),
      });
      const [paid, attempt, events] = await Promise.all([
        prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
        prisma.paymentAttempt.findUniqueOrThrow({ where: { id: created.id } }),
        prisma.paymentWebhookEvent.count({
          where: { paymentAttemptId: created.id },
        }),
      ]);
      expect(paid.paymentStatus).toBe(PaymentStatus.PAID);
      expect(attempt.status).toBe(PaymentAttemptStatus.SUCCEEDED);
      expect(events).toBe(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('persists amount mismatches without mutating the invoice', async () => {
    const { invoice } = await createUnpaidInvoice('90000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    const ipn = signIpn({
      merchantReference: created.merchantReference,
      amount: new Prisma.Decimal('89999'),
      transactionNo: `VNP-${randomUUID()}`,
    });

    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '04',
      Message: 'Invalid amount',
    });
    const [unpaid, pending, event, incident] = await Promise.all([
      prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
      prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: created.id },
      }),
      prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
      }),
      prisma.paymentReconciliationIncident.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
      }),
    ]);
    expect(unpaid.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(pending.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
    expect(event.processingCode).toBe('04');
    expect(incident.status).toBe('OPEN');
  });

  it('flags a late provider success after another payment won the race', async () => {
    const { invoice } = await createUnpaidInvoice('95000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: '0',
        responseCode: '24',
        transactionStatus: '02',
      }),
    );
    const replacement = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `replacement-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: replacement.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `VNP-${randomUUID()}`,
      }),
    );
    const transactionNo = `VNP-${randomUUID()}`;
    const ipn = signIpn({
      merchantReference: created.merchantReference,
      amount: invoice.totalAmount,
      transactionNo,
    });

    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });
    const [attempt, event, incident] = await Promise.all([
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: created.id } }),
      prisma.paymentWebhookEvent.findFirstOrThrow({
        where: {
          paymentAttemptId: created.id,
          providerTransactionNo: transactionNo,
        },
      }),
      prisma.paymentReconciliationIncident.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
      }),
    ]);
    expect(attempt.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
    expect(event.processingCode).toBe('02_PAYMENT_STATE_CONFLICT');
    expect(incident.status).toBe('OPEN');
  });

  it('keeps expired attempts unresolved until the provider confirms their outcome', async () => {
    const { invoice } = await createUnpaidInvoice('85000');
    const dto = {
      idempotencyKey: `expired-${randomUUID()}`,
      locale: 'vn' as const,
      closeSessionAfterPayment: false,
    };
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      dto,
    );
    const expiresAt = new Date(Date.now() - 60_000);
    const startedAt = new Date(expiresAt.getTime() - 15 * 60_000);
    await prisma.paymentAttempt.update({
      where: { id: created.id },
      data: {
        createdAt: startedAt,
        providerCreatedAt: startedAt,
        expiresAt,
        nextReconcileAt: expiresAt,
      },
    });
    const expired = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      dto,
    );
    expect(expired.status).toBe(PaymentAttemptStatus.EXPIRED);
    expect(expired.paymentUrl).toBeNull();

    await expect(
      invoices.updatePayment(invoice.id, employeeId, {
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CASH,
        amountTendered: '85000',
        closeSessionAfterPayment: false,
      }),
    ).rejects.toThrow('unresolved online payment');
    await expect(
      invoices.voidInvoice(invoice.id, employeeId, {
        reason: 'Customer cancelled',
      }),
    ).rejects.toThrow('unresolved online payment');
    await expect(
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        ...dto,
        idempotencyKey: `new-${randomUUID()}`,
      }),
    ).rejects.toThrow('unresolved payment attempt');

    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `VNP-${randomUUID()}`,
      }),
    );
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.PAID);
    expect(
      await prisma.paymentAttempt.count({ where: { invoiceId: invoice.id } }),
    ).toBe(1);
    expect(
      await prisma.cashTransaction.count({ where: { invoiceId: invoice.id } }),
    ).toBe(0);
  });

  it('retains the original capture when conflicting signed successes arrive later', async () => {
    const { invoice } = await createUnpaidInvoice('75000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `confirmed-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    const transactionNo = `VNP-${randomUUID()}`;
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo,
      }),
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: new Prisma.Decimal('74000'),
        transactionNo,
      }),
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `OTHER-${randomUUID()}`,
      }),
    );

    const retained = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(retained.status).toBe(PaymentAttemptStatus.SUCCEEDED);
    expect(retained.providerTransactionNo).toBe(transactionNo);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.PAID);
    expect(
      await prisma.paymentReconciliationIncident.count({
        where: { paymentAttemptId: created.id, status: 'OPEN' },
      }),
    ).toBe(2);

    await prisma.paymentReconciliationIncident.create({
      data: {
        type: 'PROVIDER_UNAVAILABLE',
        deduplicationKey: `provider-unavailable:${created.id}`,
        title: 'Previous provider outage',
        details: {},
        paymentAttemptId: created.id,
      },
    });
    const queryTransaction = jest.fn().mockResolvedValue({
      request: {},
      response: {
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TxnRef: created.merchantReference,
        vnp_Amount: invoice.totalAmount.mul(100).toFixed(0),
        vnp_TransactionType: '01',
        vnp_TransactionNo: transactionNo,
      },
    });
    const reconciliation = new PaymentReconciliationService(
      extendedPrisma,
      pagination,
      invoices,
      outbox,
      {
        assertApiConfigured: jest.fn(),
        queryTransaction,
      } as unknown as VnpayService,
      new MomoService(config),
      new PayosService(config),
      new DomainEventBusService(),
    );
    await reconciliation.reconcileAttempt(created.id, employeeId);
    const incidents = await prisma.paymentReconciliationIncident.findMany({
      where: { paymentAttemptId: created.id },
      select: { type: true, status: true },
    });
    expect(incidents).toEqual(
      expect.arrayContaining([
        { type: 'PAYMENT_STATE_CONFLICT', status: 'OPEN' },
        { type: 'PROVIDER_PAYMENT_MISMATCH', status: 'OPEN' },
        { type: 'PROVIDER_UNAVAILABLE', status: 'RESOLVED' },
      ]),
    );
    expect(queryTransaction).toHaveBeenCalledTimes(1);
  });

  it('blocks another payment and cash settlement after a signed suspected-fraud IPN', async () => {
    const { invoice } = await createUnpaidInvoice('85000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: randomUUID(),
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `REVIEW-${randomUUID()}`,
        responseCode: '07',
        transactionStatus: '07',
      }),
    );
    const stored = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.status).toBe(PaymentAttemptStatus.REQUIRES_REVIEW);
    expect(stored.completedAt).toBeNull();
    await expect(
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        idempotencyKey: randomUUID(),
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
    ).rejects.toThrow('unresolved payment attempt');
    await expect(
      invoices.updatePayment(invoice.id, employeeId, {
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CASH,
        amountTendered: '85000',
        closeSessionAfterPayment: false,
      }),
    ).rejects.toThrow('unresolved');
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.UNPAID);
  });

  it('applies partial refunds idempotently and never exceeds the captured amount', async () => {
    const { invoice } = await createUnpaidInvoice('100000');
    const created = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: created.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `VNP-${randomUUID()}`,
      }),
    );
    refundGateway.refundTransaction.mockImplementation(
      (input: {
        requestId: string;
        merchantReference: string;
        amount: Prisma.Decimal;
        transactionType: string;
      }) =>
        Promise.resolve({
          request: { vnp_RequestId: input.requestId },
          response: {
            vnp_ResponseCode: '00',
            vnp_TransactionStatus: '00',
            vnp_TransactionNo: `RF-${randomUUID()}`,
            vnp_TxnRef: input.merchantReference,
            vnp_Amount: input.amount.mul(100).toFixed(0),
            vnp_TransactionType: input.transactionType,
            vnp_Message: 'Success',
          },
        }),
    );
    const firstKey = `refund-${randomUUID()}`;
    const first = await paymentRefunds.createRefund(created.id, employeeId, {
      amount: '40000.00',
      reason: 'Partial customer refund',
      idempotencyKey: firstKey,
    });
    const replay = await paymentRefunds.createRefund(created.id, employeeId, {
      amount: '40000.00',
      reason: 'Partial customer refund',
      idempotencyKey: firstKey,
    });
    const second = await paymentRefunds.createRefund(created.id, employeeId, {
      amount: '60000.00',
      reason: 'Refund remaining balance',
      idempotencyKey: `refund-${randomUUID()}`,
    });

    const refundedInvoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(first.type).toBe(PaymentRefundType.PARTIAL);
    expect(first.status).toBe(PaymentRefundStatus.SUCCEEDED);
    expect(replay.id).toBe(first.id);
    expect(second.type).toBe(PaymentRefundType.PARTIAL);
    expect(second.status).toBe(PaymentRefundStatus.SUCCEEDED);
    expect(refundedInvoice.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(refundGateway.refundTransaction).toHaveBeenCalledTimes(2);
  });

  it('reserves an uncertain refund balance and prevents another provider refund', async () => {
    const { invoice } = await createUnpaidInvoice('100000');
    const attempt = await payments.createAttempt(
      invoice.id,
      employeeId,
      '127.0.0.1',
      {
        idempotencyKey: randomUUID(),
        locale: 'vn',
        closeSessionAfterPayment: false,
      },
    );
    await payments.handleVnpayIpn(
      signIpn({
        merchantReference: attempt.merchantReference,
        amount: invoice.totalAmount,
        transactionNo: `REFUND-${randomUUID()}`,
      }),
    );
    refundGateway.refundTransaction.mockReset().mockResolvedValue({
      request: {},
      response: {
        vnp_ResponseCode: '98',
        vnp_TransactionStatus: '02',
        vnp_TxnRef: attempt.merchantReference,
        vnp_Amount: '10000000',
        vnp_TransactionType: '02',
      },
    });
    const dto = {
      amount: '100000.00',
      reason: 'Customer request',
      idempotencyKey: randomUUID(),
    };
    const result = await paymentRefunds.createRefund(
      attempt.id,
      employeeId,
      dto,
    );
    expect(result.status).toBe(PaymentRefundStatus.REQUIRES_REVIEW);
    expect(result.completedAt).toBeNull();
    await expect(
      paymentRefunds.createRefund(attempt.id, employeeId, dto),
    ).resolves.toMatchObject({ id: result.id });
    await expect(
      paymentRefunds.createRefund(attempt.id, employeeId, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('remaining refundable amount');
    expect(refundGateway.refundTransaction).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paymentStatus,
    ).toBe(PaymentStatus.PAID);
  });

  it('returns the same attempt for concurrent idempotent requests', async () => {
    const { invoice } = await createUnpaidInvoice('70000');
    const idempotencyKey = `payment-${randomUUID()}`;
    const results = await Promise.all([
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        idempotencyKey,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        idempotencyKey,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
    ]);

    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    await expect(
      prisma.paymentAttempt.count({ where: { invoiceId: invoice.id } }),
    ).resolves.toBe(1);
  });

  it('scopes idempotency keys to the employee', async () => {
    const [{ invoice: firstInvoice }, { invoice: secondInvoice }] =
      await Promise.all([
        createUnpaidInvoice('71000'),
        createUnpaidInvoice('72000'),
      ]);
    const idempotencyKey = `shared-${randomUUID()}`;

    const [first, second] = await Promise.all([
      payments.createAttempt(firstInvoice.id, employeeId, '127.0.0.1', {
        idempotencyKey,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
      payments.createAttempt(secondInvoice.id, secondEmployeeId, '127.0.0.1', {
        idempotencyKey,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
    ]);

    expect(first.id).not.toBe(second.id);
  });

  it('allows only one pending attempt when different keys race', async () => {
    const { invoice } = await createUnpaidInvoice('80000');
    const results = await Promise.allSettled([
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
      payments.createAttempt(invoice.id, employeeId, '127.0.0.1', {
        idempotencyKey: `payment-${randomUUID()}`,
        locale: 'vn',
        closeSessionAfterPayment: false,
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      prisma.paymentAttempt.count({
        where: {
          invoiceId: invoice.id,
          status: PaymentAttemptStatus.PENDING,
        },
      }),
    ).resolves.toBe(1);
  });
});
