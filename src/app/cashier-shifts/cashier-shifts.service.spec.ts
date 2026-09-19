import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CashFlowType,
  FundType,
  PaymentMethod,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';
import { CashierShiftsService } from './cashier-shifts.service';

describe('CashierShiftsService', () => {
  let service: CashierShiftsService;
  let prisma: any;
  let tx: any;
  let ledger: { requireOpenShift: jest.Mock };

  beforeEach(async () => {
    tx = {
      employee: {
        findFirst: jest.fn().mockResolvedValue({ id: 'employee-id' }),
      },
      fund: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      cashierShift: {
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      orderSession: { count: jest.fn() },
      invoice: { groupBy: jest.fn() },
      cashTransaction: { create: jest.fn(), groupBy: jest.fn() },
      actionLog: { create: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    ledger = { requireOpenShift: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CashierShiftsService,
        PaginationUtilService,
        { provide: PRISMA_SERVICE_TOKEN, useValue: prisma },
        { provide: CashierShiftLedgerService, useValue: ledger },
      ],
    }).compile();

    service = module.get(CashierShiftsService);
  });

  it('rejects opening a shift against a non-cash fund', async () => {
    tx.fund.findFirst.mockResolvedValue({ id: 'fund-id', type: FundType.BANK });

    await expect(
      service.open('employee-id', {
        fundId: 'fund-id',
        startingCash: '100000',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashierShift.create).not.toHaveBeenCalled();
  });

  it('does not create an expense when the fund balance is insufficient', async () => {
    ledger.requireOpenShift.mockResolvedValue({
      id: 'shift-id',
      fundId: 'fund-id',
    });
    tx.fund.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.addMovement('employee-id', {
        type: CashFlowType.EXPENSE,
        amount: '200000',
        description: 'Petty cash expense',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashTransaction.create).not.toHaveBeenCalled();
  });

  it('calculates the expected cash and discrepancy when closing a shift', async () => {
    const openShift = {
      id: 'shift-id',
      employeeId: 'employee-id',
      fundId: 'fund-id',
      status: ShiftStatus.OPEN,
      startingCash: new Prisma.Decimal('100000'),
      reportedEndingCash: null,
      actualEndingCash: null,
      employee: { id: 'employee-id', fullName: 'Cashier' },
      fund: {
        id: 'fund-id',
        name: 'Main drawer',
        type: FundType.CASH,
        balance: new Prisma.Decimal('100000'),
      },
    };
    tx.cashierShift.findFirst.mockResolvedValue(openShift);
    tx.orderSession.count.mockResolvedValue(0);
    tx.invoice.groupBy.mockResolvedValue([
      {
        paymentMethod: PaymentMethod.CASH,
        _count: { _all: 1 },
        _sum: { totalAmount: new Prisma.Decimal('50000') },
      },
      {
        paymentMethod: PaymentMethod.TRANSFER,
        _count: { _all: 1 },
        _sum: { totalAmount: new Prisma.Decimal('20000') },
      },
    ]);
    tx.cashTransaction.groupBy.mockResolvedValue([
      {
        type: CashFlowType.INCOME,
        _sum: { amount: new Prisma.Decimal('10000') },
      },
      {
        type: CashFlowType.EXPENSE,
        _sum: { amount: new Prisma.Decimal('5000') },
      },
    ]);
    tx.cashierShift.updateMany.mockResolvedValue({ count: 1 });
    tx.cashierShift.findUniqueOrThrow.mockResolvedValue({
      ...openShift,
      status: ShiftStatus.CLOSED,
      reportedEndingCash: new Prisma.Decimal('160000'),
      actualEndingCash: new Prisma.Decimal('155000'),
    });

    const result = await service.close('employee-id', {
      reportedEndingCash: '160000',
    });

    expect(result.reconciliation.actualEndingCash.toString()).toBe('155000');
    expect(result.reconciliation.difference.toString()).toBe('5000');
    expect(tx.cashierShift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actualEndingCash: new Prisma.Decimal('155000'),
        }),
      }),
    );
  });

  it('does not close a shift with active order sessions', async () => {
    tx.cashierShift.findFirst.mockResolvedValue({
      id: 'shift-id',
      startingCash: new Prisma.Decimal(0),
    });
    tx.orderSession.count.mockResolvedValue(1);

    await expect(
      service.close('employee-id', { reportedEndingCash: '0' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashierShift.updateMany).not.toHaveBeenCalled();
  });
});
