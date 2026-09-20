import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAttemptStatus,
  FundType,
  PaymentMethod,
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
import { VnpayService } from '../src/app/payments/vnpay.service';
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
    new VnpayService(config),
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
      await prisma.paymentWebhookEvent.deleteMany({
        where: { paymentAttempt: { invoiceId: { in: invoiceIds } } },
      });
      await prisma.paymentAttempt.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: invoiceIds } },
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
    const [unpaid, pending, event] = await Promise.all([
      prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
      prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: created.id },
      }),
      prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
      }),
    ]);
    expect(unpaid.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(pending.status).toBe(PaymentAttemptStatus.PENDING);
    expect(event.processingCode).toBe('04');
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
    await prisma.$transaction([
      prisma.paymentAttempt.update({
        where: { id: created.id },
        data: {
          status: PaymentAttemptStatus.EXPIRED,
          completedAt: new Date(),
        },
      }),
      prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: PaymentMethod.CASH,
          amountTendered: invoice.totalAmount,
          changeAmount: new Prisma.Decimal(0),
          shiftId,
        },
      }),
    ]);
    const ipn = signIpn({
      merchantReference: created.merchantReference,
      amount: invoice.totalAmount,
      transactionNo: `VNP-${randomUUID()}`,
    });

    await expect(payments.handleVnpayIpn(ipn)).resolves.toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });
    const [attempt, event] = await Promise.all([
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: created.id } }),
      prisma.paymentWebhookEvent.findFirstOrThrow({
        where: { paymentAttemptId: created.id },
      }),
    ]);
    expect(attempt.status).toBe(PaymentAttemptStatus.EXPIRED);
    expect(event.processingCode).toBe('02_PAYMENT_STATE_CONFLICT');
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
