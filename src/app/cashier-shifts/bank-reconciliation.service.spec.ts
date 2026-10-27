import { ConflictException } from '@nestjs/common';
import {
  BankStatementEntryDirection,
  BankStatementMatchStatus,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  Prisma,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { CashHandoversService } from './cash-handovers.service';

describe('BankReconciliationService', () => {
  const prisma = {
    employee: { findFirst: jest.fn() },
    fund: { findFirst: jest.fn() },
    bankStatementImport: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    bankStatementEntry: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    cashHandover: { findFirst: jest.fn() },
    actionLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const cashHandoversService = {
    settleInTransaction: jest.fn(),
  };
  const service = new BankReconciliationService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
    cashHandoversService as unknown as CashHandoversService,
  );

  const entry = {
    id: 'entry-id',
    fundId: 'bank-fund-id',
    importId: 'import-id',
    direction: BankStatementEntryDirection.CREDIT,
    amount: new Prisma.Decimal('80000'),
    bankReference: 'BANK-REF-001',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    prisma.employee.findFirst.mockResolvedValue({ id: 'manager-id' });
    prisma.bankStatementImport.findUnique.mockResolvedValue({
      id: 'import-id',
      fundId: 'bank-fund-id',
    });
    prisma.bankStatementEntry.findMany.mockResolvedValue([entry]);
    prisma.bankStatementEntry.findUniqueOrThrow.mockResolvedValue({
      ...entry,
      matchStatus: BankStatementMatchStatus.UNMATCHED,
    });
    prisma.bankStatementEntry.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankStatementEntry.groupBy.mockResolvedValue([
      {
        matchStatus: BankStatementMatchStatus.MATCHED,
        _count: { _all: 1 },
        _sum: { amount: new Prisma.Decimal('80000') },
      },
    ]);
    prisma.cashHandover.findFirst.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.APPROVED,
      settlementStatus: CashHandoverSettlementStatus.PENDING,
      transferAmount: new Prisma.Decimal('80000'),
      evidenceReference: 'receipts/bank-ref-001.pdf',
      bankStatementEntry: null,
    });
    cashHandoversService.settleInTransaction.mockResolvedValue({
      id: 'handover-id',
    });
  });

  const statement = {
    fundId: 'bank-fund-id',
    sourceFileName: 'bank.json',
    statementFrom: new Date('2026-09-20T00:00:00Z'),
    statementTo: new Date('2026-09-21T00:00:00Z'),
    entries: [
      {
        externalId: 'bank-001',
        direction: BankStatementEntryDirection.CREDIT,
        amount: '80000',
        transactionDate: new Date('2026-09-20T12:00:00Z'),
      },
    ],
  };

  it('recovers the same canonical content without writing or reconciling again', async () => {
    const result = await service.recoverImport('manager-id', statement);
    expect(result).toMatchObject({
      statementImport: { id: 'import-id' },
      replayed: true,
    });
    const identity =
      prisma.bankStatementImport.findUnique.mock.calls[0][0].where;
    prisma.bankStatementImport.findUnique.mockClear();
    await service.createImport('manager-id', {
      ...statement,
      sourceFileName: 'renamed.json',
      entries: [
        { ...statement.entries[0], externalId: 'BANK-001', amount: '80000.00' },
      ],
    });
    expect(prisma.bankStatementImport.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: identity }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.bankStatementEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
  });

  it('does not turn a missing recovery into a new import', async () => {
    prisma.bankStatementImport.findUnique.mockResolvedValue(null);
    await expect(
      service.recoverImport('manager-id', statement),
    ).rejects.toMatchObject({
      response: { code: 'BANK_IMPORT_RECOVERY_NOT_FOUND' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers a concurrent checksum collision but rejects overlapping entries with different content', async () => {
    prisma.fund.findFirst.mockResolvedValue({ id: 'bank-fund-id' });
    prisma.bankStatementImport.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.bankStatementImport.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'original' });
    expect(await service.createImport('manager-id', statement)).toMatchObject({
      statementImport: { id: 'original' },
      replayed: true,
    });
    prisma.bankStatementImport.findUnique.mockResolvedValue(null);
    await expect(
      service.createImport('manager-id', {
        ...statement,
        entries: [{ ...statement.entries[0], amount: '90000' }],
      }),
    ).rejects.toThrow(ConflictException);
    expect(cashHandoversService.settleInTransaction).not.toHaveBeenCalled();
  });

  it('settles and links only an exact fund, reference, and amount match', async () => {
    const result = await service.reconcile('import-id', 'manager-id');

    expect(cashHandoversService.settleInTransaction).toHaveBeenCalledWith(
      prisma,
      'handover-id',
      'manager-id',
      {
        bankReference: 'BANK-REF-001',
        evidenceReference: 'receipts/bank-ref-001.pdf',
      },
    );
    expect(prisma.bankStatementEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'entry-id' }),
        data: expect.objectContaining({
          matchStatus: BankStatementMatchStatus.MATCHED,
          matchedHandoverId: 'handover-id',
        }),
      }),
    );
    expect(result).toEqual({
      UNMATCHED: { count: 0, amount: '0' },
      MATCHED: { count: 1, amount: '80000' },
      MISMATCH: { count: 0, amount: '0' },
      IGNORED: { count: 0, amount: '0' },
    });
  });

  it('marks an amount mismatch without settling the handover', async () => {
    prisma.cashHandover.findFirst.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.APPROVED,
      settlementStatus: CashHandoverSettlementStatus.PENDING,
      transferAmount: new Prisma.Decimal('70000'),
      evidenceReference: 'receipts/bank-ref-001.pdf',
      bankStatementEntry: null,
    });

    await service.reconcile('import-id', 'manager-id');

    expect(cashHandoversService.settleInTransaction).not.toHaveBeenCalled();
    expect(prisma.bankStatementEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: BankStatementMatchStatus.MISMATCH,
          mismatchReason: expect.stringContaining('Amount does not match'),
        }),
      }),
    );
  });

  it('recovers when settlement completed before the statement link', async () => {
    prisma.cashHandover.findFirst.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.APPROVED,
      settlementStatus: CashHandoverSettlementStatus.SETTLED,
      transferAmount: new Prisma.Decimal('80000'),
      evidenceReference: 'receipts/bank-ref-001.pdf',
      bankStatementEntry: null,
    });

    await service.reconcile('import-id', 'manager-id');

    expect(prisma.bankStatementEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: BankStatementMatchStatus.MATCHED,
          matchedHandoverId: 'handover-id',
        }),
      }),
    );
    expect(cashHandoversService.settleInTransaction).not.toHaveBeenCalled();
  });

  it('does not settle an entry ignored after the initial candidate scan', async () => {
    prisma.bankStatementEntry.findUniqueOrThrow.mockResolvedValue({
      ...entry,
      matchStatus: BankStatementMatchStatus.IGNORED,
    });
    await service.reconcile('import-id', 'manager-id');
    expect(cashHandoversService.settleInTransaction).not.toHaveBeenCalled();
    expect(prisma.bankStatementEntry.updateMany).not.toHaveBeenCalled();
  });

  it('never overwrites a match that wins the race against ignore', async () => {
    prisma.bankStatementEntry.findUnique.mockResolvedValue({
      ...entry,
      matchStatus: BankStatementMatchStatus.UNMATCHED,
    });
    prisma.bankStatementEntry.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.ignoreEntry(entry.id, 'manager-id', { reason: 'Not a deposit' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.bankStatementEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: entry.id,
          matchStatus: {
            in: [
              BankStatementMatchStatus.UNMATCHED,
              BankStatementMatchStatus.MISMATCH,
            ],
          },
        },
      }),
    );
    expect(prisma.actionLog.create).not.toHaveBeenCalled();
  });

  it('propagates infrastructure errors instead of labelling them a business mismatch', async () => {
    cashHandoversService.settleInTransaction.mockRejectedValue(
      new Error('Database unavailable'),
    );
    await expect(service.reconcile('import-id', 'manager-id')).rejects.toThrow(
      'Database unavailable',
    );
    expect(prisma.bankStatementEntry.updateMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate external IDs before opening a transaction', async () => {
    prisma.fund.findFirst.mockResolvedValue({ id: 'bank-fund-id' });
    const duplicateEntry = {
      externalId: 'txn-001',
      direction: BankStatementEntryDirection.CREDIT,
      amount: '80000',
      transactionDate: new Date('2026-09-20T01:00:00.000Z'),
      bankReference: 'bank-ref-001',
    };

    await expect(
      service.createImport('manager-id', {
        fundId: 'bank-fund-id',
        sourceFileName: 'statement.csv',
        statementFrom: new Date('2026-09-20T00:00:00.000Z'),
        statementTo: new Date('2026-09-21T00:00:00.000Z'),
        entries: [duplicateEntry, duplicateEntry],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
