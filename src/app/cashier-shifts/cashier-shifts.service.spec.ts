import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CashExpenseRequestStatus,
  CashFlowType,
  FundType,
  PaymentMethod,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';
import { IdempotencyService } from '../durable/idempotency.service';
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
      cashExpenseRequest: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      cashHandover: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      paymentAttempt: {
        count: jest.fn().mockResolvedValue(0),
      },
      paymentRefund: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue({ value: 500000 }),
      },
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
        { provide: IdempotencyService, useValue: {} },
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

  it('snapshots the ledger balance when opening a shift', async () => {
    tx.fund.findFirst.mockResolvedValue({
      id: 'fund-id',
      type: FundType.CASH,
      balance: new Prisma.Decimal('100000'),
    });
    tx.cashierShift.create.mockImplementation(({ data }: any) => ({
      id: 'shift-id',
      ...data,
    }));

    const shift = await service.open('employee-id', {
      fundId: 'fund-id',
      startingCash: '95000',
    });

    expect(shift.expectedStartingCash.toString()).toBe('100000');
    expect(shift.openingDifference.toString()).toBe('-5000');
  });

  it('does not open a shift while its fund has a pending handover', async () => {
    tx.fund.findFirst.mockResolvedValue({
      id: 'fund-id',
      type: FundType.CASH,
      balance: new Prisma.Decimal('100000'),
    });
    tx.cashHandover.findFirst.mockResolvedValue({ id: 'handover-id' });

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

  it('requires approval at the configured expense threshold', async () => {
    ledger.requireOpenShift.mockResolvedValue({
      id: 'shift-id',
      fundId: 'fund-id',
    });
    tx.systemSetting.findFirst.mockResolvedValue({ value: 100000 });
    tx.cashExpenseRequest.create.mockResolvedValue({ id: 'request-id' });
    tx.fund.findUniqueOrThrow.mockResolvedValue({
      balance: new Prisma.Decimal('500000'),
    });

    const result = await service.addMovement('employee-id', {
      type: CashFlowType.EXPENSE,
      amount: '100000',
      description: 'Emergency equipment repair',
    });

    expect(result.movement).toBeNull();
    expect(result.expenseRequest).toEqual({ id: 'request-id' });
    expect(tx.fund.updateMany).not.toHaveBeenCalled();
    expect(tx.cashTransaction.create).not.toHaveBeenCalled();
  });

  it('does not allow employees to approve their own expense request', async () => {
    tx.cashExpenseRequest.findUnique.mockResolvedValue({
      id: 'request-id',
      status: CashExpenseRequestStatus.PENDING,
      requestedById: 'employee-id',
      shiftId: 'shift-id',
      fundId: 'fund-id',
      amount: new Prisma.Decimal('200000'),
      shift: {
        id: 'shift-id',
        status: ShiftStatus.OPEN,
        fundId: 'fund-id',
      },
      fund: { id: 'fund-id', type: FundType.CASH, deletedAt: null },
    });

    await expect(
      service.approveExpenseRequest('request-id', 'employee-id', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(tx.fund.updateMany).not.toHaveBeenCalled();
  });

  it('calculates the expected cash and discrepancy when closing a shift', async () => {
    const openShift = {
      id: 'shift-id',
      employeeId: 'employee-id',
      fundId: 'fund-id',
      status: ShiftStatus.OPEN,
      startingCash: new Prisma.Decimal('100000'),
      expectedStartingCash: new Prisma.Decimal('100000'),
      openingDifference: new Prisma.Decimal(0),
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
      expectedStartingCash: new Prisma.Decimal(0),
    });
    tx.orderSession.count.mockResolvedValue(1);

    await expect(
      service.close('employee-id', { reportedEndingCash: '0' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashierShift.updateMany).not.toHaveBeenCalled();
  });

  it('does not close a shift with pending expense requests', async () => {
    tx.cashierShift.findFirst.mockResolvedValue({ id: 'shift-id' });
    tx.cashExpenseRequest.count.mockResolvedValue(1);

    await expect(
      service.close('employee-id', { reportedEndingCash: '0' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.orderSession.count).not.toHaveBeenCalled();
  });

  it('does not close a shift with pending online payments', async () => {
    tx.cashierShift.findFirst.mockResolvedValue({ id: 'shift-id' });
    tx.paymentAttempt.count.mockResolvedValue(1);

    await expect(
      service.close('employee-id', { reportedEndingCash: '0' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.orderSession.count).not.toHaveBeenCalled();
    expect(tx.cashierShift.updateMany).not.toHaveBeenCalled();
  });

  it('requires an explanation for a material closing discrepancy', async () => {
    tx.cashierShift.findFirst.mockResolvedValue({
      id: 'shift-id',
      expectedStartingCash: new Prisma.Decimal('100000'),
    });
    tx.orderSession.count.mockResolvedValue(0);
    tx.invoice.groupBy.mockResolvedValue([]);
    tx.cashTransaction.groupBy.mockResolvedValue([]);
    tx.systemSetting.findFirst.mockResolvedValue({ value: 1000 });

    await expect(
      service.close('employee-id', { reportedEndingCash: '95000' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.cashierShift.updateMany).not.toHaveBeenCalled();
  });
});
