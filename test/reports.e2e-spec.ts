import { randomUUID } from 'node:crypto';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ReservationStatus,
  ServeStatus,
  ShiftStatus,
  FundType,
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

  beforeAll(async () => {
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
        actualEndingCash: new Prisma.Decimal('100'),
        reportedEndingCash: new Prisma.Decimal('90'),
      },
    });
    shiftId = shift.id;

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
      if (shiftId) {
        await prisma.cashierShift.deleteMany({ where: { id: shiftId } });
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
        await prisma.employee.deleteMany({ where: { id: employeeId } });
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
      closedShiftCount: 1,
      discrepantShiftCount: 1,
      cashShortageAmount: '10.00',
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
