import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  BankStatementEntryDirection,
  BankStatementMatchStatus,
  CashHandoverSettlementStatus,
  FundType,
  Prisma,
  PrismaClient,
  ShiftStatus,
} from '@prisma/client';
import { BankReconciliationService } from '../src/app/cashier-shifts/bank-reconciliation.service';
import { CashHandoversService } from '../src/app/cashier-shifts/cash-handovers.service';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';

describe('Bank statement reconciliation (e2e)', () => {
  const prisma = new PrismaClient();
  const pagination = new PaginationUtilService();
  const handovers = new CashHandoversService(
    prisma as unknown as ExtendedPrismaClient,
    pagination,
  );
  const reconciliation = new BankReconciliationService(
    prisma as unknown as ExtendedPrismaClient,
    pagination,
    handovers,
  );
  const suffix = randomUUID();
  const fundIds: string[] = [];
  const shiftIds: string[] = [];
  let positionId: string;
  let requesterId: string;
  let reviewerId: string;
  let bankFundId: string;

  const createPendingBankDeposit = async (transferAmount: string) => {
    const sourceBalance = new Prisma.Decimal(transferAmount).plus(100);
    const sourceFund = await prisma.fund.create({
      data: {
        name: `Reconciliation source ${randomUUID()} ${suffix}`,
        type: FundType.CASH,
        balance: sourceBalance,
      },
    });
    fundIds.push(sourceFund.id);
    const shift = await prisma.cashierShift.create({
      data: {
        employeeId: requesterId,
        fundId: sourceFund.id,
        status: ShiftStatus.CLOSED,
        openedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
        closedAt: new Date(),
        startingCash: sourceBalance,
        expectedStartingCash: sourceBalance,
        openingDifference: new Prisma.Decimal(0),
        actualEndingCash: sourceBalance,
        reportedEndingCash: sourceBalance,
      },
    });
    shiftIds.push(shift.id);
    const pending = await handovers.create(requesterId, {
      shiftId: shift.id,
      destinationFundId: bankFundId,
      retainedCash: '100',
    });
    return handovers.approve(pending.id, reviewerId, {});
  };

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Reconciliation Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const [requester, reviewer, bankFund] = await Promise.all([
      prisma.employee.create({
        data: {
          email: `reconciliation-requester-${suffix}@example.com`,
          username: `reconciliation-requester-${suffix}`,
          fullName: 'Reconciliation Requester',
          password: 'not-used-in-reconciliation-tests',
          positionId,
        },
      }),
      prisma.employee.create({
        data: {
          email: `reconciliation-reviewer-${suffix}@example.com`,
          username: `reconciliation-reviewer-${suffix}`,
          fullName: 'Reconciliation Reviewer',
          password: 'not-used-in-reconciliation-tests',
          positionId,
        },
      }),
      prisma.fund.create({
        data: {
          name: `Reconciliation bank ${suffix}`,
          type: FundType.BANK,
        },
      }),
    ]);
    requesterId = requester.id;
    reviewerId = reviewer.id;
    bankFundId = bankFund.id;
    fundIds.push(bankFund.id);
  });

  afterAll(async () => {
    try {
      const employeeIds = [requesterId, reviewerId].filter(Boolean);
      await prisma.bankStatementEntry.deleteMany({
        where: { fundId: { in: fundIds } },
      });
      await prisma.bankStatementImport.deleteMany({
        where: { fundId: { in: fundIds } },
      });
      await prisma.cashHandover.deleteMany({
        where: { requestedById: { in: employeeIds } },
      });
      await prisma.cashTransaction.deleteMany({
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
        where: { id: { in: shiftIds } },
      });
      await prisma.fund.deleteMany({ where: { id: { in: fundIds } } });
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

  it('matches an exact credit once and remains idempotent on retry', async () => {
    const handover = await createPendingBankDeposit('400');
    await handovers.registerDeposit(handover.id, requesterId, {
      bankReference: 'bank-auto-match-001',
      evidenceReference: 'receipts/bank-auto-match-001.pdf',
    });
    const statementFrom = new Date(Date.now() - 60_000);
    const statementTo = new Date(Date.now() + 60_000);

    const result = await reconciliation.createImport(reviewerId, {
      fundId: bankFundId,
      sourceFileName: 'statement-exact.csv',
      statementFrom,
      statementTo,
      entries: [
        {
          externalId: 'bank-txn-exact-001',
          direction: BankStatementEntryDirection.CREDIT,
          amount: '400',
          transactionDate: new Date(),
          bankReference: 'bank-auto-match-001',
        },
        {
          externalId: 'bank-fee-001',
          direction: BankStatementEntryDirection.DEBIT,
          amount: '5',
          transactionDate: new Date(),
          description: 'Bank fee',
        },
      ],
    });

    const [settled, statementEntries, bankAfter] = await Promise.all([
      prisma.cashHandover.findUniqueOrThrow({ where: { id: handover.id } }),
      prisma.bankStatementEntry.findMany({
        where: { importId: result.statementImport.id },
        orderBy: { externalId: 'asc' },
      }),
      prisma.fund.findUniqueOrThrow({ where: { id: bankFundId } }),
    ]);
    expect(settled.settlementStatus).toBe(CashHandoverSettlementStatus.SETTLED);
    expect(bankAfter.balance.toString()).toBe('400');
    expect(
      statementEntries.map(({ matchStatus }) => matchStatus).sort(),
    ).toEqual([
      BankStatementMatchStatus.IGNORED,
      BankStatementMatchStatus.MATCHED,
    ]);

    await reconciliation.reconcile(result.statementImport.id, reviewerId);
    const bankAfterRetry = await prisma.fund.findUniqueOrThrow({
      where: { id: bankFundId },
    });
    expect(bankAfterRetry.balance.toString()).toBe('400');
  });

  it('queues amount mismatches and rejects a duplicate statement import', async () => {
    const handover = await createPendingBankDeposit('300');
    await handovers.registerDeposit(handover.id, requesterId, {
      bankReference: 'bank-auto-match-002',
      evidenceReference: 'receipts/bank-auto-match-002.pdf',
    });
    const dto = {
      fundId: bankFundId,
      sourceFileName: 'statement-mismatch.csv',
      statementFrom: new Date(Date.now() - 60_000),
      statementTo: new Date(Date.now() + 60_000),
      entries: [
        {
          externalId: 'bank-txn-mismatch-001',
          direction: BankStatementEntryDirection.CREDIT,
          amount: '299',
          transactionDate: new Date(),
          bankReference: 'bank-auto-match-002',
        },
      ],
    };

    const result = await reconciliation.createImport(reviewerId, dto);
    const [entry, pending, bankAfter] = await Promise.all([
      prisma.bankStatementEntry.findFirstOrThrow({
        where: { importId: result.statementImport.id },
      }),
      prisma.cashHandover.findUniqueOrThrow({ where: { id: handover.id } }),
      prisma.fund.findUniqueOrThrow({ where: { id: bankFundId } }),
    ]);
    expect(entry.matchStatus).toBe(BankStatementMatchStatus.MISMATCH);
    expect(entry.mismatchReason).toContain('Amount does not match');
    expect(pending.settlementStatus).toBe(CashHandoverSettlementStatus.PENDING);
    expect(bankAfter.balance.toString()).toBe('400');

    await expect(
      reconciliation.createImport(reviewerId, dto),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
