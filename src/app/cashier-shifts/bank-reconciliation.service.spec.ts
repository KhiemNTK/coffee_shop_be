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
      findMany: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    cashHandover: { findFirst: jest.fn() },
    actionLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const cashHandoversService = {
    settle: jest.fn(),
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
    jest.clearAllMocks();
    prisma.employee.findFirst.mockResolvedValue({ id: 'manager-id' });
    prisma.bankStatementImport.findUnique.mockResolvedValue({
      id: 'import-id',
      fundId: 'bank-fund-id',
    });
    prisma.bankStatementEntry.findMany.mockResolvedValue([entry]);
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
    cashHandoversService.settle.mockResolvedValue({ id: 'handover-id' });
  });

  it('settles and links only an exact fund, reference, and amount match', async () => {
    const result = await service.reconcile('import-id', 'manager-id');

    expect(cashHandoversService.settle).toHaveBeenCalledWith(
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

    expect(cashHandoversService.settle).not.toHaveBeenCalled();
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
    cashHandoversService.settle.mockRejectedValue(
      new ConflictException('Already settled'),
    );
    prisma.cashHandover.findFirst
      .mockResolvedValueOnce({
        id: 'handover-id',
        status: CashHandoverStatus.APPROVED,
        settlementStatus: CashHandoverSettlementStatus.PENDING,
        transferAmount: new Prisma.Decimal('80000'),
        evidenceReference: 'receipts/bank-ref-001.pdf',
        bankStatementEntry: null,
      })
      .mockResolvedValueOnce({
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
