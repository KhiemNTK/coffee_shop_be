import { randomUUID } from 'node:crypto';
import {
  CashExpenseRequestStatus,
  FundType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ReservationStatus,
  ServeStatus,
  ShiftStatus,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import { ExcelUtilService } from '../src/common/utils/excel-util/excel-util.service';
import { ReportsService } from '../src/app/reports/reports.service';

describe('Reports queries (e2e)', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const occurredAt = new Date('2026-06-01T17:30:00.000Z');
  const service = new ReportsService(
    prisma as unknown as ExtendedPrismaClient,
    new ExcelUtilService(),
  );

  let positionId: string | undefined;
  let employeeId: string | undefined;
  let reviewerEmployeeId: string | undefined;
  let tableId: string | undefined;
  let menuCategoryId: string | undefined;
  let menuItemId: string | undefined;
  let promotionId: string | undefined;
  let orderSessionId: string | undefined;
  let invoiceId: string | undefined;
  let inventoryCategoryId: string | undefined;
  let unitId: string | undefined;
  let inventoryItemId: string | undefined;
  let fundId: string | undefined;
  let shiftId: string | undefined;
  const shiftIds: string[] = [];
  let pendingExpenseBaselineCount = 0;
  let pendingExpenseBaselineAmount = new Prisma.Decimal(0);
  let pendingHandoverBaselineCount = 0;
  let pendingHandoverBaselineAmount = new Prisma.Decimal(0);
  let approvedHandoverBaselineCount = 0;
  let approvedHandoverBaselineAmount = new Prisma.Decimal(0);

  beforeAll(async () => {
    const [pendingHandoverBaseline, approvedHandoverBaseline] =
      await Promise.all([
        prisma.cashHandover.aggregate({
          where: { status: 'PENDING' },
          _count: true,
          _sum: { transferAmount: true },
        }),
        prisma.cashHandover.aggregate({
          where: {
            status: 'APPROVED',
            resolvedAt: {
              gte: new Date('2026-06-01T00:00:00.000Z'),
              lt: new Date('2026-06-03T00:00:00.000Z'),
            },
          },
          _count: true,
          _sum: { transferAmount: true },
        }),
      ]);
    pendingHandoverBaselineCount = pendingHandoverBaseline._count;
    pendingHandoverBaselineAmount =
      pendingHandoverBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    approvedHandoverBaselineCount = approvedHandoverBaseline._count;
    approvedHandoverBaselineAmount =
      approvedHandoverBaseline._sum.transferAmount ?? new Prisma.Decimal(0);

    const position = await prisma.position.create({
      data: { name: `Report Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;

    const employee = await prisma.employee.create({
      data: {
        email: `report-${suffix}@example.com`,
        username: `report-${suffix}`,
        fullName: 'Report Test Employee',
        password: 'not-used-in-report-tests',
        positionId,
      },
    });
    employeeId = employee.id;

    const reviewer = await prisma.employee.create({
      data: {
        email: `report-reviewer-${suffix}@example.com`,
        username: `report-reviewer-${suffix}`,
        fullName: 'Report Test Reviewer',
        password: 'not-used-in-report-tests',
        positionId,
      },
    });
    reviewerEmployeeId = reviewer.id;

    const fund = await prisma.fund.create({
      data: {
        name: `Report Cash Fund ${suffix}`,
        type: FundType.CASH,
      },
    });
    fundId = fund.id;

    const shift = await prisma.cashierShift.create({
      data: {
        employeeId,
        fundId,
        status: ShiftStatus.CLOSED,
        openedAt: new Date(occurredAt.getTime() - 8 * 60 * 60 * 1000),
        closedAt: occurredAt,
        startingCash: new Prisma.Decimal('100'),
        expectedStartingCash: new Prisma.Decimal('100'),
        openingDifference: new Prisma.Decimal(0),
        actualEndingCash: new Prisma.Decimal('100'),
        reportedEndingCash: new Prisma.Decimal('90'),
      },
    });
    shiftId = shift.id;
    shiftIds.push(shift.id);

    const repeatedShortageShift = await prisma.cashierShift.create({
      data: {
        employeeId,
        fundId,
        status: ShiftStatus.CLOSED,
        openedAt: new Date(occurredAt.getTime() - 4 * 60 * 60 * 1000),
        closedAt: new Date(occurredAt.getTime() + 30 * 60 * 1000),
        startingCash: new Prisma.Decimal('90'),
        expectedStartingCash: new Prisma.Decimal('100'),
        openingDifference: new Prisma.Decimal('-10'),
        actualEndingCash: new Prisma.Decimal('100'),
        reportedEndingCash: new Prisma.Decimal('95'),
      },
    });
    shiftIds.push(repeatedShortageShift.id);

    const pendingExpenseBaseline = await prisma.cashExpenseRequest.aggregate({
      where: { status: CashExpenseRequestStatus.PENDING },
      _count: true,
      _sum: { amount: true },
    });
    pendingExpenseBaselineCount = pendingExpenseBaseline._count;
    pendingExpenseBaselineAmount =
      pendingExpenseBaseline._sum.amount ?? new Prisma.Decimal(0);

    const openShift = await prisma.cashierShift.create({
      data: {
        employeeId: reviewerEmployeeId,
        fundId,
        status: ShiftStatus.OPEN,
        startingCash: new Prisma.Decimal(0),
        expectedStartingCash: new Prisma.Decimal(0),
        openingDifference: new Prisma.Decimal(0),
      },
    });
    shiftIds.push(openShift.id);

    await prisma.cashExpenseRequest.createMany({
      data: [
        {
          amount: new Prisma.Decimal('30'),
          description: 'Rejected report test expense',
          status: CashExpenseRequestStatus.REJECTED,
          resolutionNote: 'Not a valid business expense',
          resolvedAt: occurredAt,
          createdAt: occurredAt,
          requestedById: employeeId,
          resolvedById: reviewerEmployeeId,
          shiftId: repeatedShortageShift.id,
          fundId,
        },
        {
          amount: new Prisma.Decimal('20'),
          description: 'Pending report test expense',
          status: CashExpenseRequestStatus.PENDING,
          requestedById: reviewerEmployeeId,
          shiftId: openShift.id,
          fundId,
        },
      ],
    });

    const table = await prisma.diningTable.create({
      data: { name: `Report Table ${suffix}` },
    });
    tableId = table.id;

    const menuCategory = await prisma.menuCategory.create({
      data: { name: `Report Menu Category ${suffix}` },
    });
    menuCategoryId = menuCategory.id;

    const menuItem = await prisma.menuItem.create({
      data: {
        name: `Report Latte ${suffix}`,
        price: new Prisma.Decimal('50'),
        categoryId: menuCategoryId,
      },
    });
    menuItemId = menuItem.id;

    const promotion = await prisma.promotion.create({
      data: {
        name: `Report Promotion ${suffix}`,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2027-01-01T00:00:00.000Z'),
        discountType: 'FIXED_AMOUNT',
        discountValue: new Prisma.Decimal('10'),
      },
    });
    promotionId = promotion.id;

    const orderSession = await prisma.orderSession.create({
      data: { employeeId, tableId, shiftId, createdAt: occurredAt },
    });
    orderSessionId = orderSession.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `REPORT-${suffix}`,
        subTotal: new Prisma.Decimal('100'),
        discountAmount: new Prisma.Decimal('10'),
        taxAmount: new Prisma.Decimal('7.2'),
        taxRate: new Prisma.Decimal('8'),
        totalAmount: new Prisma.Decimal('97.2'),
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PAID,
        orderSessionId,
        employeeId,
        shiftId,
        promotionId,
        createdAt: occurredAt,
      },
    });
    invoiceId = invoice.id;

    const soldOrderItem = await prisma.orderItem.create({
      data: {
        quantity: 2,
        priceAtTime: new Prisma.Decimal('50'),
        serveStatus: ServeStatus.SERVED,
        isPaid: true,
        orderSessionId,
        menuItemId,
        invoiceId,
        createdAt: occurredAt,
      },
    });
    await prisma.orderItem.create({
      data: {
        quantity: 1,
        priceAtTime: new Prisma.Decimal('50'),
        serveStatus: ServeStatus.CANCELLED,
        orderSessionId,
        menuItemId,
        createdAt: occurredAt,
      },
    });

    const inventoryCategory = await prisma.inventoryCategory.create({
      data: { name: `Report Inventory Category ${suffix}` },
    });
    inventoryCategoryId = inventoryCategory.id;

    const unit = await prisma.unit.create({
      data: { name: `Report Unit ${suffix}` },
    });
    unitId = unit.id;

    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        name: `Report Beans ${suffix}`,
        stock: new Prisma.Decimal('2.5'),
        categoryId: inventoryCategoryId,
        unitId,
      },
    });
    inventoryItemId = inventoryItem.id;

    await prisma.orderItemIngredientSnapshot.create({
      data: {
        orderItemId: soldOrderItem.id,
        inventoryItemId,
        inventoryItemName: inventoryItem.name,
        unitName: unit.name,
        quantityPerItem: new Prisma.Decimal('0.125'),
        totalQuantity: new Prisma.Decimal('0.25'),
      },
    });
    await prisma.inventoryWaste.create({
      data: {
        orderItemId: soldOrderItem.id,
        inventoryItemId,
        quantity: new Prisma.Decimal('0.25'),
        reason: 'Report test waste',
        employeeId,
        createdAt: occurredAt,
      },
    });

    await prisma.reservation.create({
      data: {
        customerName: 'Report Customer',
        phoneNumber: '0900000000',
        startsAt: occurredAt,
        endsAt: new Date(occurredAt.getTime() + 30 * 60 * 1000),
        status: ReservationStatus.ARRIVED,
        tableId,
        employeeId,
      },
    });
  });

  afterAll(async () => {
    try {
      if (inventoryItemId) {
        await prisma.inventoryWaste.deleteMany({ where: { inventoryItemId } });
        await prisma.orderItemIngredientSnapshot.deleteMany({
          where: { inventoryItemId },
        });
        await prisma.inventoryItem.deleteMany({
          where: { id: inventoryItemId },
        });
      }
      if (inventoryCategoryId) {
        await prisma.inventoryCategory.deleteMany({
          where: { id: inventoryCategoryId },
        });
      }
      if (unitId) await prisma.unit.deleteMany({ where: { id: unitId } });
      if (tableId) await prisma.reservation.deleteMany({ where: { tableId } });
      if (orderSessionId) {
        await prisma.orderItem.deleteMany({ where: { orderSessionId } });
      }
      if (invoiceId) {
        await prisma.invoice.deleteMany({ where: { id: invoiceId } });
      }
      if (orderSessionId) {
        await prisma.orderSession.deleteMany({
          where: { id: orderSessionId },
        });
      }
      if (shiftIds.length > 0) {
        await prisma.cashExpenseRequest.deleteMany({
          where: { shiftId: { in: shiftIds } },
        });
        await prisma.cashierShift.deleteMany({
          where: { id: { in: shiftIds } },
        });
      }
      if (fundId) await prisma.fund.deleteMany({ where: { id: fundId } });
      if (promotionId) {
        await prisma.promotion.deleteMany({ where: { id: promotionId } });
      }
      if (menuItemId) {
        await prisma.menuItem.deleteMany({ where: { id: menuItemId } });
      }
      if (menuCategoryId) {
        await prisma.menuCategory.deleteMany({
          where: { id: menuCategoryId },
        });
      }
      if (tableId) {
        await prisma.diningTable.deleteMany({ where: { id: tableId } });
      }
      if (employeeId) {
        const employeeIds = reviewerEmployeeId
          ? [employeeId, reviewerEmployeeId]
          : [employeeId];
        await prisma.employee.deleteMany({
          where: { id: { in: employeeIds } },
        });
      }
      if (positionId) {
        await prisma.position.deleteMany({ where: { id: positionId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('aggregates paid sales and operational insights in the requested time zone', async () => {
    const report = await service.getDashboard({
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-03T00:00:00.000Z'),
      timeZone: 'Asia/Ho_Chi_Minh',
      granularity: 'day',
      topLimit: 10,
      lowStockThreshold: 5,
    });

    expect(report.summary).toEqual({
      paidInvoiceCount: 1,
      grossSales: '100.00',
      discountAmount: '10.00',
      taxAmount: '7.20',
      netRevenue: '97.20',
      averageTicket: '97.20',
      cancelledItemCount: 1,
      wasteEntryCount: 1,
      closedShiftCount: 2,
      discrepantShiftCount: 2,
      cashShortageAmount: '15.00',
      cashOverageAmount: '0.00',
    });
    expect(report.trend).toEqual([
      {
        bucket: '2026-06-02',
        paidInvoiceCount: 1,
        netRevenue: '97.20',
      },
    ]);
    expect(report.topItems[0]).toEqual(
      expect.objectContaining({ quantitySold: 2, grossSales: '100.00' }),
    );
    expect(report.promotions[0]).toEqual(
      expect.objectContaining({ usageCount: 1, discountAmount: '10.00' }),
    );
    expect(
      report.reservations.find(
        ({ status }) => status === ReservationStatus.ARRIVED,
      )?.reservationCount,
    ).toBe(1);
    expect(report.lowStockItems[0]).toEqual(
      expect.objectContaining({ id: inventoryItemId, stock: '2.5000' }),
    );
    expect(report.inventoryWaste[0]).toEqual(
      expect.objectContaining({
        inventoryItemId,
        wasteQuantity: '0.2500',
      }),
    );
    expect(report.cashRisk.overview).toEqual({
      openingDiscrepantShiftCount: 1,
      openingShortageAmount: '10.00',
      openingOverageAmount: '0.00',
      repeatShortageEmployeeCount: 1,
      currentPendingExpenseRequestCount: pendingExpenseBaselineCount + 1,
      currentPendingExpenseRequestAmount: pendingExpenseBaselineAmount
        .plus(20)
        .toFixed(2),
      rejectedExpenseRequestCount: 1,
      rejectedExpenseRequestAmount: '30.00',
      currentPendingHandoverCount: pendingHandoverBaselineCount,
      currentPendingHandoverAmount: pendingHandoverBaselineAmount.toFixed(2),
      approvedHandoverCount: approvedHandoverBaselineCount,
      approvedHandoverAmount: approvedHandoverBaselineAmount.toFixed(2),
    });
    expect(report.cashRisk.varianceTrend).toEqual([
      {
        bucket: '2026-06-02',
        closedShiftCount: 2,
        discrepantShiftCount: 2,
        cashShortageAmount: '15.00',
        cashOverageAmount: '0.00',
      },
    ]);
    expect(report.cashRisk.employees[0]).toEqual({
      employeeId,
      employeeName: 'Report Test Employee',
      closedShiftCount: 2,
      shortageShiftCount: 2,
      shortageRatePercent: '100.00',
      overageShiftCount: 0,
      totalShortageAmount: '15.00',
      totalOverageAmount: '0.00',
      openingShortageAmount: '10.00',
      openingOverageAmount: '0.00',
    });
  });

  it('generates a bounded Excel workbook from the same report data', async () => {
    const workbook = await service.exportDashboard({
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-03T00:00:00.000Z'),
      timeZone: 'Asia/Ho_Chi_Minh',
      granularity: 'day',
      topLimit: 10,
      lowStockThreshold: 5,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });
});
