import { randomUUID } from 'node:crypto';
import {
  BankStatementEntryDirection,
  BankStatementMatchStatus,
  CashExpenseRequestStatus,
  FundType,
  PaymentAttemptStatus,
  PaymentMethod,
  PaymentReconciliationIncidentStatus,
  PaymentRefundStatus,
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
  let pendingSettlementBaselineCount = 0;
  let pendingSettlementBaselineAmount = new Prisma.Decimal(0);
  let overdueSettlementBaselineCount = 0;
  let overdueSettlementBaselineAmount = new Prisma.Decimal(0);
  let settledDepositBaselineCount = 0;
  let settledDepositBaselineAmount = new Prisma.Decimal(0);
  let unmatchedStatementBaselineCount = 0;
  let unmatchedStatementBaselineAmount = new Prisma.Decimal(0);
  let mismatchedStatementBaselineCount = 0;
  let mismatchedStatementBaselineAmount = new Prisma.Decimal(0);
  let currentPendingAttemptBaselineCount = 0;
  let currentPendingAttemptBaselineAmount = new Prisma.Decimal(0);
  let stalePendingAttemptBaselineCount = 0;
  let stalePendingAttemptBaselineAmount = new Prisma.Decimal(0);
  let successfulAttemptBaselineCount = 0;
  let successfulAttemptBaselineAmount = new Prisma.Decimal(0);
  let failedAttemptBaselineCount = 0;
  let failedAttemptBaselineAmount = new Prisma.Decimal(0);
  let reviewAttemptBaselineCount = 0;
  let reviewAttemptBaselineAmount = new Prisma.Decimal(0);
  let successfulRefundBaselineCount = 0;
  let successfulRefundBaselineAmount = new Prisma.Decimal(0);
  let reviewRefundBaselineCount = 0;
  let reviewRefundBaselineAmount = new Prisma.Decimal(0);
  let openReconciliationIncidentBaselineCount = 0;
  let webhookExceptionBaselineCount = 0;

  beforeAll(async () => {
    const [
      pendingHandoverBaseline,
      approvedHandoverBaseline,
      pendingSettlementBaseline,
      overdueSettlementBaseline,
      settledDepositBaseline,
      unmatchedStatementBaseline,
      mismatchedStatementBaseline,
      currentPendingAttemptBaseline,
      stalePendingAttemptBaseline,
      successfulAttemptBaseline,
      failedAttemptBaseline,
      reviewAttemptBaseline,
      successfulRefundBaseline,
      reviewRefundBaseline,
      openReconciliationIncidentBaseline,
      webhookExceptionBaseline,
    ] = await Promise.all([
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
      prisma.cashHandover.aggregate({
        where: { settlementStatus: 'PENDING' },
        _count: true,
        _sum: { transferAmount: true },
      }),
      prisma.cashHandover.aggregate({
        where: {
          settlementStatus: 'PENDING',
          settlementDueAt: { lt: new Date() },
        },
        _count: true,
        _sum: { transferAmount: true },
      }),
      prisma.cashHandover.aggregate({
        where: {
          settlementStatus: 'SETTLED',
          settledAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lt: new Date('2026-06-03T00:00:00.000Z'),
          },
        },
        _count: true,
        _sum: { transferAmount: true },
      }),
      prisma.bankStatementEntry.aggregate({
        where: {
          direction: BankStatementEntryDirection.CREDIT,
          matchStatus: BankStatementMatchStatus.UNMATCHED,
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.bankStatementEntry.aggregate({
        where: {
          direction: BankStatementEntryDirection.CREDIT,
          matchStatus: BankStatementMatchStatus.MISMATCH,
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentAttempt.aggregate({
        where: {
          status: PaymentAttemptStatus.PENDING,
          expiresAt: { gt: new Date() },
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentAttempt.aggregate({
        where: {
          status: PaymentAttemptStatus.PENDING,
          expiresAt: { lte: new Date() },
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentAttempt.aggregate({
        where: {
          status: PaymentAttemptStatus.SUCCEEDED,
          completedAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lt: new Date('2026-06-03T00:00:00.000Z'),
          },
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentAttempt.aggregate({
        where: {
          status: PaymentAttemptStatus.FAILED,
          completedAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lt: new Date('2026-06-03T00:00:00.000Z'),
          },
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentAttempt.aggregate({
        where: { status: PaymentAttemptStatus.REQUIRES_REVIEW },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentRefund.aggregate({
        where: {
          status: PaymentRefundStatus.SUCCEEDED,
          completedAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lt: new Date('2026-06-03T00:00:00.000Z'),
          },
        },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentRefund.aggregate({
        where: { status: PaymentRefundStatus.REQUIRES_REVIEW },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.paymentReconciliationIncident.count({
        where: { status: PaymentReconciliationIncidentStatus.OPEN },
      }),
      prisma.paymentWebhookEvent.count({
        where: {
          receivedAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lt: new Date('2026-06-03T00:00:00.000Z'),
          },
          processingCode: {
            in: ['01', '04', '99', '02_PAYMENT_STATE_CONFLICT'],
          },
        },
      }),
    ]);
    pendingHandoverBaselineCount = pendingHandoverBaseline._count;
    pendingHandoverBaselineAmount =
      pendingHandoverBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    approvedHandoverBaselineCount = approvedHandoverBaseline._count;
    approvedHandoverBaselineAmount =
      approvedHandoverBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    pendingSettlementBaselineCount = pendingSettlementBaseline._count;
    pendingSettlementBaselineAmount =
      pendingSettlementBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    overdueSettlementBaselineCount = overdueSettlementBaseline._count;
    overdueSettlementBaselineAmount =
      overdueSettlementBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    settledDepositBaselineCount = settledDepositBaseline._count;
    settledDepositBaselineAmount =
      settledDepositBaseline._sum.transferAmount ?? new Prisma.Decimal(0);
    unmatchedStatementBaselineCount = unmatchedStatementBaseline._count;
    unmatchedStatementBaselineAmount =
      unmatchedStatementBaseline._sum.amount ?? new Prisma.Decimal(0);
    mismatchedStatementBaselineCount = mismatchedStatementBaseline._count;
    mismatchedStatementBaselineAmount =
      mismatchedStatementBaseline._sum.amount ?? new Prisma.Decimal(0);
    currentPendingAttemptBaselineCount = currentPendingAttemptBaseline._count;
    currentPendingAttemptBaselineAmount =
      currentPendingAttemptBaseline._sum.amount ?? new Prisma.Decimal(0);
    stalePendingAttemptBaselineCount = stalePendingAttemptBaseline._count;
    stalePendingAttemptBaselineAmount =
      stalePendingAttemptBaseline._sum.amount ?? new Prisma.Decimal(0);
    successfulAttemptBaselineCount = successfulAttemptBaseline._count;
    successfulAttemptBaselineAmount =
      successfulAttemptBaseline._sum.amount ?? new Prisma.Decimal(0);
    failedAttemptBaselineCount = failedAttemptBaseline._count;
    failedAttemptBaselineAmount =
      failedAttemptBaseline._sum.amount ?? new Prisma.Decimal(0);
    reviewAttemptBaselineCount = reviewAttemptBaseline._count;
    reviewAttemptBaselineAmount =
      reviewAttemptBaseline._sum.amount ?? new Prisma.Decimal(0);
    successfulRefundBaselineCount = successfulRefundBaseline._count;
    successfulRefundBaselineAmount =
      successfulRefundBaseline._sum.amount ?? new Prisma.Decimal(0);
    reviewRefundBaselineCount = reviewRefundBaseline._count;
    reviewRefundBaselineAmount =
      reviewRefundBaseline._sum.amount ?? new Prisma.Decimal(0);
    openReconciliationIncidentBaselineCount =
      openReconciliationIncidentBaseline;
    webhookExceptionBaselineCount = webhookExceptionBaseline;

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
      currentPendingBankSettlementCount: pendingSettlementBaselineCount,
      currentPendingBankSettlementAmount:
        pendingSettlementBaselineAmount.toFixed(2),
      overdueBankSettlementCount: overdueSettlementBaselineCount,
      overdueBankSettlementAmount: overdueSettlementBaselineAmount.toFixed(2),
      settledBankDepositCount: settledDepositBaselineCount,
      settledBankDepositAmount: settledDepositBaselineAmount.toFixed(2),
      currentUnmatchedBankStatementEntryCount: unmatchedStatementBaselineCount,
      currentUnmatchedBankStatementEntryAmount:
        unmatchedStatementBaselineAmount.toFixed(2),
      currentMismatchedBankStatementEntryCount:
        mismatchedStatementBaselineCount,
      currentMismatchedBankStatementEntryAmount:
        mismatchedStatementBaselineAmount.toFixed(2),
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
    const completedAttemptCount =
      successfulAttemptBaselineCount + failedAttemptBaselineCount;
    expect(report.paymentOperations).toEqual({
      currentPendingAttemptCount: currentPendingAttemptBaselineCount,
      currentPendingAttemptAmount:
        currentPendingAttemptBaselineAmount.toFixed(2),
      stalePendingAttemptCount: stalePendingAttemptBaselineCount,
      stalePendingAttemptAmount: stalePendingAttemptBaselineAmount.toFixed(2),
      successfulAttemptCount: successfulAttemptBaselineCount,
      successfulAttemptAmount: successfulAttemptBaselineAmount.toFixed(2),
      failedAttemptCount: failedAttemptBaselineCount,
      failedAttemptAmount: failedAttemptBaselineAmount.toFixed(2),
      requiresReviewAttemptCount: reviewAttemptBaselineCount,
      requiresReviewAttemptAmount: reviewAttemptBaselineAmount.toFixed(2),
      successfulRefundCount: successfulRefundBaselineCount,
      successfulRefundAmount: successfulRefundBaselineAmount.toFixed(2),
      reviewRefundCount: reviewRefundBaselineCount,
      reviewRefundAmount: reviewRefundBaselineAmount.toFixed(2),
      openReconciliationIncidentCount: openReconciliationIncidentBaselineCount,
      successRatePercent:
        completedAttemptCount === 0
          ? '0.00'
          : (
              (successfulAttemptBaselineCount / completedAttemptCount) *
              100
            ).toFixed(2),
      webhookExceptionCount: webhookExceptionBaselineCount,
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
