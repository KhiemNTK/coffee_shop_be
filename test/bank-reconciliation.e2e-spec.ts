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

  it('rolls settlement back when ignore wins after the reconciliation snapshot', async () => {
    const reference = `race-${randomUUID()}`;
    const handover = await createPendingBankDeposit('120');
    await handovers.registerDeposit(handover.id, requesterId, {
      bankReference: reference,
      evidenceReference: 'receipts/race.pdf',
    });
    const statement = await prisma.bankStatementImport.create({
      data: {
        fundId: bankFundId,
        importedById: reviewerId,
        sourceFileName: 'race.csv',
        checksum: randomUUID(),
        statementFrom: new Date(Date.now() - 60_000),
        statementTo: new Date(Date.now() + 60_000),
        entries: {
          create: {
            fundId: bankFundId,
            externalId: randomUUID(),
            amount: 120,
            direction: BankStatementEntryDirection.CREDIT,
            transactionDate: new Date(),
            bankReference: reference.toUpperCase(),
          },
        },
      },
      include: { entries: true },
    });
    const before = await prisma.fund.findUniqueOrThrow({
      where: { id: bankFundId },
    });
    let reached!: () => void;
    let release!: () => void;
    const reachedSettlement = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settle = handovers.settleInTransaction.bind(handovers);
    const spy = jest
      .spyOn(handovers, 'settleInTransaction')
      .mockImplementationOnce(async (...args) => {
        reached();
        await resume;
        return settle(...args);
      });
    const pending = reconciliation.reconcile(statement.id, reviewerId);
    try {
      await Promise.race([
        reachedSettlement,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Settlement barrier was not reached')),
            3000,
          ).unref();
        }),
      ]);
      await reconciliation.ignoreEntry(statement.entries[0].id, reviewerId, {
        reason: 'Not a shop deposit',
      });
      release();
      await pending;
      expect(
        (
          await prisma.fund.findUniqueOrThrow({ where: { id: bankFundId } })
        ).balance.equals(before.balance),
      ).toBe(true);
      expect(
        (
          await prisma.cashHandover.findUniqueOrThrow({
            where: { id: handover.id },
          })
        ).settlementStatus,
      ).toBe(CashHandoverSettlementStatus.PENDING);
      expect(
        (
          await prisma.bankStatementEntry.findUniqueOrThrow({
            where: { id: statement.entries[0].id },
          })
        ).matchStatus,
      ).toBe(BankStatementMatchStatus.IGNORED);
    } finally {
      release();
      await pending.catch(() => undefined);
      spy.mockRestore();
    }
  });

  it('rolls money and settlement audit back if linking the statement fails', async () => {
    const reference = `rollback-${randomUUID()}`;
    const handover = await createPendingBankDeposit('180');
    await handovers.registerDeposit(handover.id, requesterId, {
      bankReference: reference,
      evidenceReference: 'receipts/rollback.pdf',
    });
    const statement = await prisma.bankStatementImport.create({
      data: {
        fundId: bankFundId,
        importedById: reviewerId,
        sourceFileName: 'rollback.csv',
        checksum: randomUUID(),
        statementFrom: new Date(Date.now() - 60_000),
        statementTo: new Date(Date.now() + 60_000),
        entries: {
          create: {
            fundId: bankFundId,
            externalId: randomUUID(),
            amount: 180,
            direction: BankStatementEntryDirection.CREDIT,
            transactionDate: new Date(),
            bankReference: reference.toUpperCase(),
          },
        },
      },
      include: { entries: true },
    });
    const before = await prisma.fund.findUniqueOrThrow({
      where: { id: bankFundId },
    });
    const failing = prisma.$extends({
      query: {
        bankStatementEntry: {
          updateMany({ args, query }) {
            if (args.data.matchStatus === BankStatementMatchStatus.MATCHED)
              throw new Error('Fixture link failure');
            return query(args);
          },
        },
      },
    });
    const service = new BankReconciliationService(
      failing,
      pagination,
      handovers,
    );
    await expect(service.reconcile(statement.id, reviewerId)).rejects.toThrow(
      'Fixture link failure',
    );
    expect(
      (
        await prisma.fund.findUniqueOrThrow({ where: { id: bankFundId } })
      ).balance.equals(before.balance),
    ).toBe(true);
    expect(
      (
        await prisma.cashHandover.findUniqueOrThrow({
          where: { id: handover.id },
        })
      ).settlementStatus,
    ).toBe(CashHandoverSettlementStatus.PENDING);
    expect(
      await prisma.actionLog.count({
        where: {
          actionType: 'CASH_HANDOVER_SETTLED',
          details: { path: ['handoverId'], equals: handover.id },
        },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.bankStatementEntry.findUniqueOrThrow({
          where: { id: statement.entries[0].id },
        })
      ).matchStatus,
    ).toBe(BankStatementMatchStatus.UNMATCHED);
  });

  it('queues amount mismatches and replays the exact statement without importing twice', async () => {
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

    const replay = await reconciliation.createImport(reviewerId, dto);
    expect(replay).toMatchObject({
      statementImport: { id: result.statementImport.id },
      replayed: true,
    });
    await expect(
      reconciliation.createImport(reviewerId, {
        ...dto,
        entries: [{ ...dto.entries[0], amount: '298' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
