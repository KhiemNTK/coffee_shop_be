import { ConflictException } from '@nestjs/common';
import { CashFlowType, FundType, Prisma, ShiftStatus } from '@prisma/client';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';

describe('CashierShiftLedgerService', () => {
  const service = new CashierShiftLedgerService();

  it('returns a recoverable state conflict when no shift is open', async () => {
    const tx = {
      cashierShift: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as ExtendedPrismaTransactionClient;

    await expect(
      service.requireOpenShift(tx, 'employee-id'),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CASHIER_SHIFT_REQUIRED' },
    });
  });

  it('rejects a shift without an active cash fund', async () => {
    const tx = {
      cashierShift: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'shift-id',
          fundId: 'fund-id',
          fund: { type: FundType.BANK, deletedAt: null },
          status: ShiftStatus.OPEN,
        }),
      },
    } as unknown as ExtendedPrismaTransactionClient;

    await expect(
      service.requireOpenShift(tx, 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.requireOpenShift(tx, 'employee-id'),
    ).rejects.toMatchObject({
      response: { code: 'CASHIER_SHIFT_FUND_INVALID' },
    });
  });

  it('records one invoice income and increments the fund balance', async () => {
    const tx = {
      cashTransaction: { create: jest.fn() },
      fund: { update: jest.fn() },
    } as unknown as ExtendedPrismaTransactionClient;
    const amount = new Prisma.Decimal('45000');

    await service.recordCashInvoice(tx, {
      shift: { id: 'shift-id', fundId: 'fund-id' },
      invoiceId: 'invoice-id',
      invoiceNumber: 'INV-001',
      employeeId: 'employee-id',
      amount,
    });

    expect(tx.cashTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: CashFlowType.INCOME,
        amount,
        fundId: 'fund-id',
        shiftId: 'shift-id',
        invoiceId: 'invoice-id',
      }),
    });
    expect(tx.fund.update).toHaveBeenCalledWith({
      where: { id: 'fund-id' },
      data: { balance: { increment: amount } },
    });
  });
});
