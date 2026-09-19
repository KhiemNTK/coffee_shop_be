import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, Prisma, ReservationStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    inventoryItem: { findMany: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() };
  const excelUtil = { generateExcel: jest.fn() };
  const query = {
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-01-03T00:00:00.000Z'),
    timeZone: 'Asia/Ho_Chi_Minh',
    granularity: 'day' as const,
    topLimit: 10,
    lowStockThreshold: 5,
  };
  let service: ReportsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    service = new ReportsService(
      prisma as unknown as ExtendedPrismaClient,
      excelUtil as unknown as ExcelUtilService,
    );
  });

  const mockDashboardRows = () => {
    tx.$queryRaw
      .mockResolvedValueOnce([
        {
          paidInvoiceCount: 2n,
          grossSales: new Prisma.Decimal('220000'),
          discountAmount: new Prisma.Decimal('20000'),
          taxAmount: new Prisma.Decimal('16000'),
          netRevenue: new Prisma.Decimal('216000'),
          averageTicket: new Prisma.Decimal('108000'),
          cancelledItemCount: 1n,
          wasteEntryCount: 1n,
          closedShiftCount: 2n,
          discrepantShiftCount: 1n,
          cashShortageAmount: new Prisma.Decimal('5000'),
          cashOverageAmount: new Prisma.Decimal('0'),
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket: '2026-01-01',
          paidInvoiceCount: 2n,
          netRevenue: new Prisma.Decimal('216000'),
        },
      ])
      .mockResolvedValueOnce([
        {
          paymentMethod: PaymentMethod.CASH,
          paidInvoiceCount: 2n,
          netRevenue: new Prisma.Decimal('216000'),
        },
      ])
      .mockResolvedValueOnce([
        {
          menuItemId: 'menu-item-id',
          name: 'Latte',
          categoryName: 'Coffee',
          quantitySold: 2n,
          grossSales: new Prisma.Decimal('220000'),
        },
      ])
      .mockResolvedValueOnce([
        {
          promotionId: 'promotion-id',
          name: 'New year',
          usageCount: 1n,
          discountAmount: new Prisma.Decimal('20000'),
          netRevenue: new Prisma.Decimal('108000'),
        },
      ])
      .mockResolvedValueOnce([
        { status: ReservationStatus.ARRIVED, reservationCount: 1n },
      ])
      .mockResolvedValueOnce([
        {
          inventoryItemId: 'inventory-item-id',
          name: 'Coffee beans',
          unitName: 'kg',
          wasteQuantity: new Prisma.Decimal('0.125'),
        },
      ]);
    tx.inventoryItem.findMany.mockResolvedValue([
      {
        id: 'inventory-item-id',
        name: 'Coffee beans',
        stock: new Prisma.Decimal('2.5'),
        unit: { name: 'kg' },
      },
    ]);
  };

  it('returns stable money strings and zero-filled enum breakdowns', async () => {
    mockDashboardRows();

    const result = await service.getDashboard(query);

    expect(result.summary).toEqual({
      paidInvoiceCount: 2,
      grossSales: '220000.00',
      discountAmount: '20000.00',
      taxAmount: '16000.00',
      netRevenue: '216000.00',
      averageTicket: '108000.00',
      cancelledItemCount: 1,
      wasteEntryCount: 1,
      closedShiftCount: 2,
      discrepantShiftCount: 1,
      cashShortageAmount: '5000.00',
      cashOverageAmount: '0.00',
    });
    expect(result.paymentMethods).toEqual([
      {
        paymentMethod: PaymentMethod.CASH,
        paidInvoiceCount: 2,
        netRevenue: '216000.00',
      },
      {
        paymentMethod: PaymentMethod.CARD,
        paidInvoiceCount: 0,
        netRevenue: '0.00',
      },
      {
        paymentMethod: PaymentMethod.TRANSFER,
        paidInvoiceCount: 0,
        netRevenue: '0.00',
      },
    ]);
    expect(result.reservations).toHaveLength(4);
    expect(result.lowStockItems[0].stock).toBe('2.5000');
    expect(result.inventoryWaste[0].wasteQuantity).toBe('0.1250');
  });

  it('rejects unbounded and invalid report ranges before querying', async () => {
    await expect(
      service.getDashboard({
        ...query,
        from: new Date('2024-01-01T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getDashboard({ ...query, from: query.to }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('limits hourly reports to 31 days', async () => {
    await expect(
      service.getDashboard({
        ...query,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-03-01T00:00:00.000Z'),
        granularity: 'hour',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reuses the bounded dashboard result for Excel export', async () => {
    mockDashboardRows();
    const workbook = { workbook: true };
    excelUtil.generateExcel.mockReturnValue(workbook);

    await expect(service.exportDashboard(query)).resolves.toBe(workbook);
    expect(excelUtil.generateExcel).toHaveBeenCalledWith({
      worksheets: expect.arrayContaining([
        expect.objectContaining({ sheetName: 'Summary' }),
        expect.objectContaining({ sheetName: 'Promotions' }),
        expect.objectContaining({ sheetName: 'Inventory Waste' }),
      ]),
    });
  });
});
