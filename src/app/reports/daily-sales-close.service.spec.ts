import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DailySalesCloseService } from './daily-sales-close.service';

describe('DailySalesCloseService', () => {
  const businessDate = '2026-01-01';
  const closedAt = new Date('2026-01-02T02:00:00.000Z');
  const close = {
    id: 'close-id',
    businessDate: new Date('2026-01-01T00:00:00.000Z'),
    timeZone: 'Asia/Ho_Chi_Minh',
    periodStart: new Date('2025-12-31T17:00:00.000Z'),
    periodEnd: new Date('2026-01-01T17:00:00.000Z'),
    closedAt,
    closedById: 'employee-id',
    snapshot: {
      estimatedGrossProfit: '70.00',
      refundCount: 0,
      refundAmount: '0.00',
    },
  };
  const noBlockers = {
    openShiftCount: 0n,
    unpaidInvoiceCount: 0n,
    unfinishedItemCount: 0n,
    uncertainPaymentCount: 0n,
    uncertainRefundCount: 0n,
    openIncidentCount: 0n,
  };
  const tx = {
    employee: { findFirst: jest.fn() },
    dailySalesClose: { findUnique: jest.fn(), create: jest.fn() },
    actionLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    dailySalesClose: { findUnique: jest.fn() },
  };
  let service: DailySalesCloseService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    prisma.$queryRaw.mockResolvedValue([
      { count: 0n, amount: new Prisma.Decimal(0) },
    ]);
    tx.employee.findFirst.mockResolvedValue({ id: 'employee-id' });
    tx.dailySalesClose.findUnique.mockResolvedValue(null);
    tx.dailySalesClose.create.mockResolvedValue(close);
    tx.actionLog.create.mockResolvedValue({ id: 'log-id' });
    service = new DailySalesCloseService(prisma as never);
  });

  it('creates one immutable snapshot using Vietnam business-day boundaries', async () => {
    tx.$queryRaw.mockResolvedValueOnce([noBlockers]).mockResolvedValueOnce([
      {
        paidInvoiceCount: 1n,
        grossSales: new Prisma.Decimal(100),
        discountAmount: new Prisma.Decimal(0),
        taxAmount: new Prisma.Decimal(10),
        refundCount: 0n,
        refundAmount: new Prisma.Decimal(0),
        netReceipts: new Prisma.Decimal(110),
        netSalesExTax: new Prisma.Decimal(100),
        ingredientCost: new Prisma.Decimal(25),
        wasteCost: new Prisma.Decimal(5),
        soldItemCount: 1n,
        itemsWithCostSnapshot: 1n,
        zeroCostSnapshotCount: 0n,
      },
    ]);

    const result = await service.close(businessDate, 'employee-id');

    expect(result.businessDate).toBe(businessDate);
    expect(result.refundDeltaSinceClose).toEqual({ count: 0, amount: '0.00' });
    expect(tx.dailySalesClose.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessDate: close.businessDate,
        periodStart: close.periodStart,
        periodEnd: close.periodEnd,
        snapshot: expect.objectContaining({
          estimatedGrossProfit: '70.00',
        }),
      }),
    });
    expect(tx.actionLog.create).toHaveBeenCalledTimes(1);
  });

  it('returns the original snapshot on an idempotent retry', async () => {
    tx.dailySalesClose.findUnique.mockResolvedValue(close);
    prisma.$queryRaw.mockResolvedValue([
      { count: 1n, amount: new Prisma.Decimal(25) },
    ]);

    const result = await service.close(businessDate, 'employee-id');

    expect(result.snapshot).toEqual(close.snapshot);
    expect(result.refundDeltaSinceClose).toEqual({ count: 1, amount: '25.00' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.dailySalesClose.create).not.toHaveBeenCalled();
  });

  it('rejects unresolved operations without writing a close', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      { ...noBlockers, uncertainRefundCount: 1n },
    ]);

    await expect(
      service.close(businessDate, 'employee-id'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.dailySalesClose.create).not.toHaveBeenCalled();
  });

  it('rejects an unfinished or invalid business day', async () => {
    await expect(
      service.close('2999-01-01', 'employee-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.get('2026-02-30')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns not found for an unclosed day', async () => {
    prisma.dailySalesClose.findUnique.mockResolvedValue(null);

    await expect(service.get(businessDate)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
