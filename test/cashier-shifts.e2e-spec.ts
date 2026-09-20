import { randomUUID } from 'node:crypto';
import {
  CashExpenseRequestStatus,
  CashFlowType,
  FundType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  SettingValueType,
  SessionStatus,
} from '@prisma/client';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { CashierShiftsService } from '../src/app/cashier-shifts/cashier-shifts.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import {
  CashControlSettingDefaults,
  CashControlSettingKeys,
} from '../src/common/consts/cash-control-settings';

describe('Cashier shift ledger (e2e)', () => {
  const prisma = new PrismaClient();
  const ledger = new CashierShiftLedgerService();
  const shifts = new CashierShiftsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    ledger,
    new IdempotencyService(prisma as unknown as ExtendedPrismaClient),
  );
  const suffix = randomUUID();

  let positionId: string;
  let employeeOneId: string;
  let employeeTwoId: string;
  let mainFundId: string;
  let raceFundId: string;
  let approvalFundId: string;
  const previousSettings = new Map<
    string,
    Awaited<ReturnType<typeof prisma.systemSetting.findUnique>>
  >();

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Cashier Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;

    const [employeeOne, employeeTwo] = await Promise.all([
      prisma.employee.create({
        data: {
          email: `cashier-one-${suffix}@example.com`,
          username: `cashier-one-${suffix}`,
          fullName: 'Cashier One',
          password: 'not-used-in-cashier-tests',
          positionId,
        },
      }),
      prisma.employee.create({
        data: {
          email: `cashier-two-${suffix}@example.com`,
          username: `cashier-two-${suffix}`,
          fullName: 'Cashier Two',
          password: 'not-used-in-cashier-tests',
          positionId,
        },
      }),
    ]);
    employeeOneId = employeeOne.id;
    employeeTwoId = employeeTwo.id;

    for (const [key, value] of [
      [
        CashControlSettingKeys.EXPENSE_APPROVAL_THRESHOLD,
        CashControlSettingDefaults.EXPENSE_APPROVAL_THRESHOLD,
      ],
      [
        CashControlSettingKeys.SHIFT_DISCREPANCY_NOTE_THRESHOLD,
        CashControlSettingDefaults.SHIFT_DISCREPANCY_NOTE_THRESHOLD,
      ],
    ] as const) {
      const existing = await prisma.systemSetting.findUnique({
        where: { key },
      });
      previousSettings.set(key, existing);
      await prisma.systemSetting.upsert({
        where: { key },
        create: {
          key,
          value,
          valueType: SettingValueType.NUMBER,
          isSystem: true,
        },
        update: {
          value,
          valueType: SettingValueType.NUMBER,
          deletedAt: null,
        },
      });
    }

    const [mainFund, raceFund, approvalFund] = await Promise.all([
      prisma.fund.create({
        data: {
          name: `Main Drawer ${suffix}`,
          type: FundType.CASH,
          balance: new Prisma.Decimal('100000'),
        },
      }),
      prisma.fund.create({
        data: {
          name: `Race Drawer ${suffix}`,
          type: FundType.CASH,
        },
      }),
      prisma.fund.create({
        data: {
          name: `Approval Drawer ${suffix}`,
          type: FundType.CASH,
          balance: new Prisma.Decimal('1000000'),
        },
      }),
    ]);
    mainFundId = mainFund.id;
    raceFundId = raceFund.id;
    approvalFundId = approvalFund.id;
  });

  afterAll(async () => {
    try {
      const employeeIds = [employeeOneId, employeeTwoId].filter(Boolean);
      await prisma.cashExpenseRequest.deleteMany({
        where: { requestedById: { in: employeeIds } },
      });
      await prisma.cashTransaction.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.invoice.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.orderSession.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({
          where: { employeeId: { in: employeeIds } },
        });
      });
      await prisma.cashierShift.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.fund.deleteMany({
        where: {
          id: {
            in: [mainFundId, raceFundId, approvalFundId].filter(Boolean),
          },
        },
      });
      await prisma.employee.deleteMany({
        where: { id: { in: employeeIds } },
      });
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
      }
      for (const [key, previous] of previousSettings) {
        if (previous) {
          await prisma.systemSetting.update({
            where: { key },
            data: {
              value: previous.value as Prisma.InputJsonValue,
              valueType: previous.valueType,
              description: previous.description,
              isPublic: previous.isPublic,
              isSystem: previous.isSystem,
              deletedAt: previous.deletedAt,
            },
          });
        } else {
          await prisma.systemSetting.deleteMany({ where: { key } });
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('reconciles cash sales and manual movements in one shift', async () => {
    const shift = await shifts.open(employeeOneId, {
      fundId: mainFundId,
      startingCash: '100000',
    });
    await shifts.addMovement(employeeOneId, {
      type: CashFlowType.INCOME,
      amount: '10000',
      description: 'Additional float',
    });
    await shifts.addMovement(employeeOneId, {
      type: CashFlowType.EXPENSE,
      amount: '5000',
      description: 'Petty cash expense',
    });

    const session = await prisma.orderSession.create({
      data: {
        employeeId: employeeOneId,
        shiftId: shift.id,
        sessionStatus: SessionStatus.COMPLETED,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `CASHIER-${suffix}`,
        subTotal: new Prisma.Decimal('50000'),
        totalAmount: new Prisma.Decimal('50000'),
        amountTendered: new Prisma.Decimal('50000'),
        changeAmount: new Prisma.Decimal(0),
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PAID,
        orderSessionId: session.id,
        employeeId: employeeOneId,
        shiftId: shift.id,
      },
    });
    await prisma.$transaction((tx) =>
      ledger.recordCashInvoice(tx as never, {
        shift: { id: shift.id, fundId: mainFundId },
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        employeeId: employeeOneId,
        amount: invoice.totalAmount,
      }),
    );

    const closed = await shifts.close(employeeOneId, {
      reportedEndingCash: '154000',
      closingNote: 'One thousand short',
    });
    const [fund, invoiceTransactions] = await Promise.all([
      prisma.fund.findUniqueOrThrow({ where: { id: mainFundId } }),
      prisma.cashTransaction.count({ where: { invoiceId: invoice.id } }),
    ]);

    expect(closed.reconciliation.actualEndingCash.toString()).toBe('155000');
    expect(closed.reconciliation.difference.toString()).toBe('-1000');
    expect(fund.balance.toString()).toBe('155000');
    expect(invoiceTransactions).toBe(1);
  });

  it('allows only one concurrent open shift per cash fund', async () => {
    const results = await Promise.allSettled([
      shifts.open(employeeOneId, {
        fundId: raceFundId,
        startingCash: '0',
      }),
      shifts.open(employeeTwoId, {
        fundId: raceFundId,
        startingCash: '0',
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );

    const openShift = await prisma.cashierShift.findFirstOrThrow({
      where: { fundId: raceFundId, status: 'OPEN' },
    });
    await shifts.close(openShift.employeeId, { reportedEndingCash: '0' });
  });

  it('posts a large expense once after independent approval', async () => {
    const shift = await shifts.open(employeeOneId, {
      fundId: approvalFundId,
      startingCash: '990000',
    });
    expect(shift.expectedStartingCash.toString()).toBe('1000000');
    expect(shift.openingDifference.toString()).toBe('-10000');

    const pending = await shifts.addMovement(employeeOneId, {
      type: CashFlowType.EXPENSE,
      amount: '600000',
      description: 'Replace failed espresso machine pump',
    });
    expect(pending.movement).toBeNull();
    expect(pending.expenseRequest?.status).toBe(
      CashExpenseRequestStatus.PENDING,
    );

    const requestId = pending.expenseRequest!.id;
    const results = await Promise.allSettled([
      shifts.approveExpenseRequest(requestId, employeeTwoId, {
        note: 'Emergency repair approved',
      }),
      shifts.approveExpenseRequest(requestId, employeeTwoId, {
        note: 'Duplicate concurrent approval',
      }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );

    const [fund, request, transactions] = await Promise.all([
      prisma.fund.findUniqueOrThrow({ where: { id: approvalFundId } }),
      prisma.cashExpenseRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
      prisma.cashTransaction.count({
        where: { shiftId: shift.id, type: CashFlowType.EXPENSE },
      }),
    ]);
    expect(fund.balance.toString()).toBe('400000');
    expect(request.status).toBe(CashExpenseRequestStatus.APPROVED);
    expect(transactions).toBe(1);

    const closed = await shifts.close(employeeOneId, {
      reportedEndingCash: '390000',
      closingNote: 'Opening count was ten thousand short',
    });
    expect(closed.reconciliation.actualEndingCash.toString()).toBe('400000');
    expect(closed.reconciliation.difference.toString()).toBe('-10000');
  });

  it('rejects a negative fund balance at the database boundary', async () => {
    await expect(
      prisma.fund.update({
        where: { id: raceFundId },
        data: { balance: new Prisma.Decimal('-1') },
      }),
    ).rejects.toBeDefined();
  });
});
