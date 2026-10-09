import { createHmac, randomUUID } from 'node:crypto';
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
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import type { PromotionCalculatorService } from '../src/app/promotions/services/promotion-calculator.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../src/common/utils/query-util/query-util.service';

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
    ),
    new MomoService(config),
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
    expect(completedSession.sessionStatus).toBe(SessionStatus.COMPLETED);
    expect(emptyTable.status).toBe(TableStatus.EMPTY);
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
    const ipn = signIpn({
      merchantReference: created.merchantReference,
      amount: invoice.totalAmount,
      transactionNo: `VNP-${randomUUID()}`,
    });

    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });
    const [attempt, event, incident] = await Promise.all([
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: created.id } }),
      prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
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
    await prisma.paymentAttempt.update({
      where: { id: created.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
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
    await expect(invoices.voidInvoice(invoice.id, employeeId)).rejects.toThrow(
      'unresolved online payment',
    );
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
