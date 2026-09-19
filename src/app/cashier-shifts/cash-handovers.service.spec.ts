import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CashFlowType,
  CashHandoverStatus,
  FundType,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashHandoversService } from './cash-handovers.service';

describe('CashHandoversService', () => {
  const tx = {
    employee: { findFirst: jest.fn() },
    cashierShift: { findUnique: jest.fn(), findFirst: jest.fn() },
    fund: { findFirst: jest.fn(), updateMany: jest.fn() },
    cashHandover: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    cashTransaction: { create: jest.fn() },
    actionLog: { create: jest.fn() },
  };
  const executeTransaction = (
    callback: (client: typeof tx) => Promise<unknown>,
  ) => callback(tx);
  const prisma = {
    $transaction: jest.fn(executeTransaction),
  };
  const service = new CashHandoversService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.cashierShift.findFirst.mockResolvedValue(null);
  });

  it('snapshots a closed shift instead of accepting a transfer amount', async () => {
    tx.cashierShift.findUnique.mockResolvedValue({
      id: 'shift-id',
      employeeId: 'employee-id',
      status: ShiftStatus.CLOSED,
      fundId: 'source-fund-id',
      actualEndingCash: new Prisma.Decimal('100'),
      reportedEndingCash: new Prisma.Decimal('90'),
      fund: {
        id: 'source-fund-id',
        type: FundType.CASH,
        balance: new Prisma.Decimal('100'),
        deletedAt: null,
      },
    });
    tx.fund.findFirst.mockResolvedValue({ id: 'destination-fund-id' });
    tx.cashHandover.create.mockImplementation(({ data }: any) => ({
      id: 'handover-id',
      ...data,
    }));

    const result = await service.create('employee-id', {
      shiftId: 'shift-id',
      destinationFundId: 'destination-fund-id',
      retainedCash: '20',
    });

    expect(result.expectedCash.toString()).toBe('100');
    expect(result.countedCash.toString()).toBe('90');
    expect(result.varianceAmount.toString()).toBe('-10');
    expect(result.transferAmount.toString()).toBe('70');
  });

  it('does not allow the requester to approve their own handover', async () => {
    tx.cashHandover.findUnique.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.PENDING,
      requestedById: 'employee-id',
    });

    await expect(
      service.approve('handover-id', 'employee-id', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(tx.fund.updateMany).not.toHaveBeenCalled();
  });

  it('posts variance and balanced transfer entries exactly once', async () => {
    tx.cashHandover.findUnique.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.PENDING,
      requestedById: 'requester-id',
      shiftId: 'shift-id',
      sourceFundId: 'source-fund-id',
      destinationFundId: 'destination-fund-id',
      expectedCash: new Prisma.Decimal('100'),
      countedCash: new Prisma.Decimal('90'),
      varianceAmount: new Prisma.Decimal('-10'),
      retainedCash: new Prisma.Decimal('20'),
      transferAmount: new Prisma.Decimal('70'),
      sourceFund: {
        id: 'source-fund-id',
        type: FundType.CASH,
        deletedAt: null,
      },
      destinationFund: { id: 'destination-fund-id', deletedAt: null },
    });
    tx.fund.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.cashTransaction.create
      .mockResolvedValueOnce({ id: 'variance-transaction-id' })
      .mockResolvedValueOnce({ id: 'source-transaction-id' })
      .mockResolvedValueOnce({ id: 'destination-transaction-id' });
    tx.cashHandover.update.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.APPROVED,
    });

    await service.approve('handover-id', 'reviewer-id', {
      note: 'Cash counted and received',
    });

    expect(tx.fund.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'source-fund-id',
        deletedAt: null,
        balance: new Prisma.Decimal('100'),
      },
      data: { balance: new Prisma.Decimal('20') },
    });
    expect(tx.fund.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'destination-fund-id', deletedAt: null },
      data: { balance: { increment: new Prisma.Decimal('70') } },
    });
    const entries = tx.cashTransaction.create.mock.calls.map(
      ([input]) => input.data,
    );
    expect(entries.map(({ type }) => type)).toEqual([
      CashFlowType.EXPENSE,
      CashFlowType.EXPENSE,
      CashFlowType.INCOME,
    ]);
    expect(entries.map(({ amount }) => amount.toString())).toEqual([
      '10',
      '70',
      '70',
    ]);
  });

  it('does not approve against a stale source balance', async () => {
    tx.cashHandover.findUnique.mockResolvedValue({
      id: 'handover-id',
      status: CashHandoverStatus.PENDING,
      requestedById: 'requester-id',
      sourceFundId: 'source-fund-id',
      destinationFundId: 'destination-fund-id',
      expectedCash: new Prisma.Decimal('100'),
      varianceAmount: new Prisma.Decimal(0),
      retainedCash: new Prisma.Decimal('20'),
      transferAmount: new Prisma.Decimal('80'),
      sourceFund: {
        type: FundType.CASH,
        deletedAt: null,
      },
      destinationFund: { deletedAt: null },
    });
    tx.fund.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.approve('handover-id', 'reviewer-id', {}),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashTransaction.create).not.toHaveBeenCalled();
  });
});
