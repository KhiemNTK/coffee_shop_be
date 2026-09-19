import { randomUUID } from 'node:crypto';
import {
  CashFlowType,
  FundType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  SessionStatus,
} from '@prisma/client';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { CashierShiftsService } from '../src/app/cashier-shifts/cashier-shifts.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Cashier shift ledger (e2e)', () => {
  const prisma = new PrismaClient();
  const ledger = new CashierShiftLedgerService();
  const shifts = new CashierShiftsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    ledger,
  );
  const suffix = randomUUID();

  let positionId: string;
  let employeeOneId: string;
  let employeeTwoId: string;
  let mainFundId: string;
  let raceFundId: string;

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

    const [mainFund, raceFund] = await Promise.all([
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
    ]);
    mainFundId = mainFund.id;
    raceFundId = raceFund.id;
  });

  afterAll(async () => {
    try {
      const employeeIds = [employeeOneId, employeeTwoId].filter(Boolean);
      await prisma.cashTransaction.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.invoice.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.orderSession.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.actionLog.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.cashierShift.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.fund.deleteMany({
        where: { id: { in: [mainFundId, raceFundId].filter(Boolean) } },
      });
      await prisma.employee.deleteMany({
        where: { id: { in: employeeIds } },
      });
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
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

  it('rejects a negative fund balance at the database boundary', async () => {
    await expect(
      prisma.fund.update({
        where: { id: raceFundId },
        data: { balance: new Prisma.Decimal('-1') },
      }),
    ).rejects.toBeDefined();
  });
});
