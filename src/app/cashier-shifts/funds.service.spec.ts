import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FundType, Prisma, ShiftStatus } from '@prisma/client';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { FundsService } from './funds.service';

describe('FundsService', () => {
  let service: FundsService;
  let tx: any;

  beforeEach(async () => {
    tx = {
      employee: {
        findFirst: jest.fn().mockResolvedValue({ id: 'employee-id' }),
      },
      fund: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      cashierShift: { findFirst: jest.fn() },
      cashHandover: { findFirst: jest.fn().mockResolvedValue(null) },
      bankStatementImport: { findFirst: jest.fn().mockResolvedValue(null) },
      actionLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FundsService,
        PaginationUtilService,
        { provide: PRISMA_SERVICE_TOKEN, useValue: prisma },
      ],
    }).compile();

    service = module.get(FundsService);
  });

  it('does not change the type of a fund used by an open shift', async () => {
    tx.fund.findFirst.mockResolvedValue({ id: 'fund-id', type: FundType.CASH });
    tx.cashierShift.findFirst.mockResolvedValue({
      id: 'shift-id',
      status: ShiftStatus.OPEN,
    });

    await expect(
      service.update('fund-id', 'employee-id', { type: FundType.BANK }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.fund.update).not.toHaveBeenCalled();
  });

  it('does not delete a fund with a non-zero balance', async () => {
    tx.fund.findFirst.mockResolvedValue({
      id: 'fund-id',
      balance: new Prisma.Decimal('1'),
    });

    await expect(
      service.remove('fund-id', 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.fund.update).not.toHaveBeenCalled();
  });

  it('does not change a fund type while a handover is pending', async () => {
    tx.fund.findFirst.mockResolvedValue({ id: 'fund-id', type: FundType.CASH });
    tx.cashHandover.findFirst.mockResolvedValue({ id: 'handover-id' });

    await expect(
      service.update('fund-id', 'employee-id', { type: FundType.BANK }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashierShift.findFirst).not.toHaveBeenCalled();
    expect(tx.fund.update).not.toHaveBeenCalled();
  });

  it('does not change the type of a fund with statement history', async () => {
    tx.fund.findFirst.mockResolvedValue({ id: 'fund-id', type: FundType.BANK });
    tx.bankStatementImport.findFirst.mockResolvedValue({ id: 'import-id' });

    await expect(
      service.update('fund-id', 'employee-id', { type: FundType.CASH }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.cashHandover.findFirst).not.toHaveBeenCalled();
    expect(tx.fund.update).not.toHaveBeenCalled();
  });
});
