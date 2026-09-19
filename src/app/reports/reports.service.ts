import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, ReservationStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type {
  ExtendedPrismaTransactionClient,
  ReportCashRiskOverviewRow,
  ReportCashVarianceTrendRow,
  ReportEmployeeCashRiskRow,
  ReportInventoryWasteRow,
  ReportMenuItemRow,
  ReportPaymentMethodRow,
  ReportPromotionRow,
  ReportQueryPeriod,
  ReportReservationRow,
  ReportSummaryRow,
  ReportTrendRow,
} from '../../common/types';
import { ExcelUtilService } from '../../common/utils/excel-util/excel-util.service';
import { GetDashboardReportDto } from './dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_RANGE_MS = 366 * DAY_MS;
const MAX_HOURLY_RANGE_MS = 31 * DAY_MS;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly excelUtil: ExcelUtilService,
  ) {}

  async getDashboard(query: GetDashboardReportDto) {
    const period = this.resolvePeriod(query);
    const dashboard = await this.prisma.$transaction(
      async (tx) => {
        const summary = await this.getSummary(tx, period);
        const trend = await this.getTrend(tx, period);
        const paymentMethods = await this.getPaymentMethods(tx, period);
        const topItems = await this.getTopItems(tx, period, query.topLimit);
        const promotions = await this.getPromotions(tx, period, query.topLimit);
        const reservations = await this.getReservations(tx, period);
        const lowStockItems = await tx.inventoryItem.findMany({
          where: {
            deletedAt: null,
            stock: { lte: new Prisma.Decimal(query.lowStockThreshold) },
          },
          select: {
            id: true,
            name: true,
            stock: true,
            unit: { select: { name: true } },
          },
          orderBy: [{ stock: 'asc' }, { name: 'asc' }],
          take: query.topLimit,
        });
        const inventoryWaste = await this.getInventoryWaste(
          tx,
          period,
          query.topLimit,
        );
        const cashRisk = await this.getCashRisk(tx, period, query.topLimit);

        return {
          summary,
          trend,
          paymentMethods,
          topItems,
          promotions,
          reservations,
          lowStockItems: lowStockItems.map((item) => ({
            id: item.id,
            name: item.name,
            stock: item.stock.toFixed(4),
            unitName: item.unit.name,
          })),
          inventoryWaste,
          cashRisk,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 10_000,
      },
    );

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        timeZone: period.timeZone,
        granularity: period.granularity,
      },
      ...dashboard,
    };
  }

  async exportDashboard(query: GetDashboardReportDto) {
    const report = await this.getDashboard(query);

    return this.excelUtil.generateExcel({
      worksheets: [
        { sheetName: 'Summary', data: [report.summary] },
        { sheetName: 'Sales Trend', data: report.trend },
        { sheetName: 'Payment Methods', data: report.paymentMethods },
        { sheetName: 'Top Items', data: report.topItems },
        { sheetName: 'Promotions', data: report.promotions },
        { sheetName: 'Reservations', data: report.reservations },
        { sheetName: 'Low Stock', data: report.lowStockItems },
        { sheetName: 'Inventory Waste', data: report.inventoryWaste },
        { sheetName: 'Cash Risk Summary', data: [report.cashRisk.overview] },
        { sheetName: 'Cash Variance', data: report.cashRisk.varianceTrend },
        { sheetName: 'Employee Cash Risk', data: report.cashRisk.employees },
      ],
    });
  }

  private async getSummary(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const [row] = await tx.$queryRaw<ReportSummaryRow[]>(Prisma.sql`
      SELECT
        invoice_summary.*,
        shift_summary.*
      FROM (
        SELECT
          COUNT(*)::bigint AS "paidInvoiceCount",
          COALESCE(SUM(i."subTotal"), 0)::numeric AS "grossSales",
          COALESCE(SUM(i."discountAmount"), 0)::numeric AS "discountAmount",
          COALESCE(SUM(i."taxAmount"), 0)::numeric AS "taxAmount",
          COALESCE(SUM(i."totalAmount"), 0)::numeric AS "netRevenue",
          COALESCE(AVG(i."totalAmount"), 0)::numeric AS "averageTicket",
          (
            SELECT COUNT(*)::bigint
            FROM "OrderItem" oi
            WHERE oi."serveStatus" = 'CANCELLED'
              AND oi."createdAt" >= ${period.from}
              AND oi."createdAt" < ${period.to}
          ) AS "cancelledItemCount",
          (
            SELECT COUNT(*)::bigint
            FROM "InventoryWaste" iw
            WHERE iw."createdAt" >= ${period.from}
              AND iw."createdAt" < ${period.to}
          ) AS "wasteEntryCount"
        FROM "Invoice" i
        WHERE i."paymentStatus" = 'PAID'
          AND i."createdAt" >= ${period.from}
          AND i."createdAt" < ${period.to}
      ) invoice_summary
      CROSS JOIN (
        SELECT
          COUNT(*)::bigint AS "closedShiftCount",
          COUNT(*) FILTER (
            WHERE cs."reportedEndingCash" <> cs."actualEndingCash"
          )::bigint AS "discrepantShiftCount",
          COALESCE(SUM(GREATEST(
            cs."actualEndingCash" - cs."reportedEndingCash",
            0
          )), 0)::numeric AS "cashShortageAmount",
          COALESCE(SUM(GREATEST(
            cs."reportedEndingCash" - cs."actualEndingCash",
            0
          )), 0)::numeric AS "cashOverageAmount"
        FROM "CashierShift" cs
        WHERE cs."status" = 'CLOSED'
          AND cs."closedAt" >= ${period.from}
          AND cs."closedAt" < ${period.to}
      ) shift_summary
    `);

    return {
      paidInvoiceCount: Number(row?.paidInvoiceCount ?? 0),
      grossSales: this.money(row?.grossSales),
      discountAmount: this.money(row?.discountAmount),
      taxAmount: this.money(row?.taxAmount),
      netRevenue: this.money(row?.netRevenue),
      averageTicket: this.money(row?.averageTicket),
      cancelledItemCount: Number(row?.cancelledItemCount ?? 0),
      wasteEntryCount: Number(row?.wasteEntryCount ?? 0),
      closedShiftCount: Number(row?.closedShiftCount ?? 0),
      discrepantShiftCount: Number(row?.discrepantShiftCount ?? 0),
      cashShortageAmount: this.money(row?.cashShortageAmount),
      cashOverageAmount: this.money(row?.cashOverageAmount),
    };
  }

  private async getTrend(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const format =
      period.granularity === 'hour' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
    const rows = await tx.$queryRaw<ReportTrendRow[]>(Prisma.sql`
      SELECT
        to_char(
          date_trunc(
            ${period.granularity},
            i."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${period.timeZone}
          ),
          ${format}
        ) AS "bucket",
        COUNT(*)::bigint AS "paidInvoiceCount",
        COALESCE(SUM(i."totalAmount"), 0)::numeric AS "netRevenue"
      FROM "Invoice" i
      WHERE i."paymentStatus" = 'PAID'
        AND i."createdAt" >= ${period.from}
        AND i."createdAt" < ${period.to}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return rows.map((row) => ({
      bucket: row.bucket,
      paidInvoiceCount: Number(row.paidInvoiceCount),
      netRevenue: this.money(row.netRevenue),
    }));
  }

  private async getPaymentMethods(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const rows = await tx.$queryRaw<ReportPaymentMethodRow[]>(Prisma.sql`
      SELECT
        i."paymentMethod",
        COUNT(*)::bigint AS "paidInvoiceCount",
        COALESCE(SUM(i."totalAmount"), 0)::numeric AS "netRevenue"
      FROM "Invoice" i
      WHERE i."paymentStatus" = 'PAID'
        AND i."createdAt" >= ${period.from}
        AND i."createdAt" < ${period.to}
      GROUP BY i."paymentMethod"
      ORDER BY "netRevenue" DESC
    `);
    const byMethod = new Map(rows.map((row) => [row.paymentMethod, row]));

    return Object.values(PaymentMethod).map((paymentMethod) => {
      const row = byMethod.get(paymentMethod);
      return {
        paymentMethod,
        paidInvoiceCount: Number(row?.paidInvoiceCount ?? 0),
        netRevenue: this.money(row?.netRevenue),
      };
    });
  }

  private async getTopItems(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
    limit: number,
  ) {
    const rows = await tx.$queryRaw<ReportMenuItemRow[]>(Prisma.sql`
      SELECT
        mi."id" AS "menuItemId",
        mi."name",
        mc."name" AS "categoryName",
        SUM(oi."quantity")::bigint AS "quantitySold",
        COALESCE(SUM(oi."priceAtTime" * oi."quantity"), 0)::numeric AS "grossSales"
      FROM "OrderItem" oi
      JOIN "Invoice" i ON i."id" = oi."invoiceId"
      JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
      JOIN "MenuCategory" mc ON mc."id" = mi."categoryId"
      WHERE i."paymentStatus" = 'PAID'
        AND i."createdAt" >= ${period.from}
        AND i."createdAt" < ${period.to}
      GROUP BY mi."id", mi."name", mc."name"
      ORDER BY "grossSales" DESC, "quantitySold" DESC, mi."name" ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      menuItemId: row.menuItemId,
      name: row.name,
      categoryName: row.categoryName,
      quantitySold: Number(row.quantitySold),
      grossSales: this.money(row.grossSales),
    }));
  }

  private async getPromotions(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
    limit: number,
  ) {
    const rows = await tx.$queryRaw<ReportPromotionRow[]>(Prisma.sql`
      SELECT
        p."id" AS "promotionId",
        p."name",
        COUNT(i."id")::bigint AS "usageCount",
        COALESCE(SUM(i."discountAmount"), 0)::numeric AS "discountAmount",
        COALESCE(SUM(i."totalAmount"), 0)::numeric AS "netRevenue"
      FROM "Invoice" i
      JOIN "Promotion" p ON p."id" = i."promotionId"
      WHERE i."paymentStatus" = 'PAID'
        AND i."createdAt" >= ${period.from}
        AND i."createdAt" < ${period.to}
      GROUP BY p."id", p."name"
      ORDER BY "netRevenue" DESC, "usageCount" DESC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      promotionId: row.promotionId,
      name: row.name,
      usageCount: Number(row.usageCount),
      discountAmount: this.money(row.discountAmount),
      netRevenue: this.money(row.netRevenue),
    }));
  }

  private async getReservations(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const rows = await tx.$queryRaw<ReportReservationRow[]>(Prisma.sql`
      SELECT
        r."status",
        COUNT(*)::bigint AS "reservationCount"
      FROM "Reservation" r
      WHERE r."startsAt" >= ${period.from}
        AND r."startsAt" < ${period.to}
      GROUP BY r."status"
    `);
    const byStatus = new Map(rows.map((row) => [row.status, row]));

    return Object.values(ReservationStatus).map((status) => ({
      status,
      reservationCount: Number(byStatus.get(status)?.reservationCount ?? 0),
    }));
  }

  private async getInventoryWaste(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
    limit: number,
  ) {
    const rows = await tx.$queryRaw<ReportInventoryWasteRow[]>(Prisma.sql`
      SELECT
        ii."id" AS "inventoryItemId",
        ii."name",
        u."name" AS "unitName",
        COALESCE(SUM(iw."quantity"), 0)::numeric AS "wasteQuantity"
      FROM "InventoryWaste" iw
      JOIN "InventoryItem" ii ON ii."id" = iw."inventoryItemId"
      JOIN "Unit" u ON u."id" = ii."unitId"
      WHERE iw."createdAt" >= ${period.from}
        AND iw."createdAt" < ${period.to}
      GROUP BY ii."id", ii."name", u."name"
      ORDER BY "wasteQuantity" DESC, ii."name" ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      name: row.name,
      unitName: row.unitName,
      wasteQuantity: row.wasteQuantity.toFixed(4),
    }));
  }

  private async getCashRisk(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
    limit: number,
  ) {
    const overview = await this.getCashRiskOverview(tx, period);
    const varianceTrend = await this.getCashVarianceTrend(tx, period);
    const employees = await this.getEmployeeCashRisk(tx, period, limit);

    return { overview, varianceTrend, employees };
  }

  private async getCashRiskOverview(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const [row] = await tx.$queryRaw<ReportCashRiskOverviewRow[]>(Prisma.sql`
      SELECT
        shift_risk.*,
        expense_risk.*,
        handover_risk.*
      FROM (
        SELECT
          COUNT(*) FILTER (
            WHERE cs."openingDifference" <> 0
          )::bigint AS "openingDiscrepantShiftCount",
          COALESCE(SUM(GREATEST(-cs."openingDifference", 0)), 0)::numeric
            AS "openingShortageAmount",
          COALESCE(SUM(GREATEST(cs."openingDifference", 0)), 0)::numeric
            AS "openingOverageAmount",
          (
            SELECT COUNT(*)::bigint
            FROM (
              SELECT repeated_shift."employeeId"
              FROM "CashierShift" repeated_shift
              WHERE repeated_shift."status" = 'CLOSED'
                AND repeated_shift."closedAt" >= ${period.from}
                AND repeated_shift."closedAt" < ${period.to}
              GROUP BY repeated_shift."employeeId"
              HAVING COUNT(*) FILTER (
                WHERE repeated_shift."actualEndingCash"
                  > repeated_shift."reportedEndingCash"
              ) >= 2
            ) repeated_employee
          ) AS "repeatShortageEmployeeCount"
        FROM "CashierShift" cs
        WHERE cs."status" = 'CLOSED'
          AND cs."closedAt" >= ${period.from}
          AND cs."closedAt" < ${period.to}
      ) shift_risk
      CROSS JOIN (
        SELECT
          COUNT(*) FILTER (
            WHERE cer."status" = 'PENDING'
          )::bigint AS "currentPendingExpenseRequestCount",
          COALESCE(SUM(cer."amount") FILTER (
            WHERE cer."status" = 'PENDING'
          ), 0)::numeric AS "currentPendingExpenseRequestAmount",
          COUNT(*) FILTER (
            WHERE cer."status" = 'REJECTED'
              AND cer."resolvedAt" >= ${period.from}
              AND cer."resolvedAt" < ${period.to}
          )::bigint AS "rejectedExpenseRequestCount",
          COALESCE(SUM(cer."amount") FILTER (
            WHERE cer."status" = 'REJECTED'
              AND cer."resolvedAt" >= ${period.from}
              AND cer."resolvedAt" < ${period.to}
          ), 0)::numeric AS "rejectedExpenseRequestAmount"
        FROM "CashExpenseRequest" cer
        WHERE cer."status" = 'PENDING'
          OR (
            cer."status" = 'REJECTED'
            AND cer."resolvedAt" >= ${period.from}
            AND cer."resolvedAt" < ${period.to}
          )
      ) expense_risk
      CROSS JOIN (
        SELECT
          COUNT(*) FILTER (
            WHERE ch."status" = 'PENDING'
          )::bigint AS "currentPendingHandoverCount",
          COALESCE(SUM(ch."transferAmount") FILTER (
            WHERE ch."status" = 'PENDING'
          ), 0)::numeric AS "currentPendingHandoverAmount",
          COUNT(*) FILTER (
            WHERE ch."status" = 'APPROVED'
              AND ch."resolvedAt" >= ${period.from}
              AND ch."resolvedAt" < ${period.to}
          )::bigint AS "approvedHandoverCount",
          COALESCE(SUM(ch."transferAmount") FILTER (
            WHERE ch."status" = 'APPROVED'
              AND ch."resolvedAt" >= ${period.from}
              AND ch."resolvedAt" < ${period.to}
          ), 0)::numeric AS "approvedHandoverAmount"
        FROM "CashHandover" ch
        WHERE ch."status" = 'PENDING'
          OR (
            ch."status" = 'APPROVED'
            AND ch."resolvedAt" >= ${period.from}
            AND ch."resolvedAt" < ${period.to}
          )
      ) handover_risk
    `);

    return {
      openingDiscrepantShiftCount: Number(
        row?.openingDiscrepantShiftCount ?? 0,
      ),
      openingShortageAmount: this.money(row?.openingShortageAmount),
      openingOverageAmount: this.money(row?.openingOverageAmount),
      repeatShortageEmployeeCount: Number(
        row?.repeatShortageEmployeeCount ?? 0,
      ),
      currentPendingExpenseRequestCount: Number(
        row?.currentPendingExpenseRequestCount ?? 0,
      ),
      currentPendingExpenseRequestAmount: this.money(
        row?.currentPendingExpenseRequestAmount,
      ),
      rejectedExpenseRequestCount: Number(
        row?.rejectedExpenseRequestCount ?? 0,
      ),
      rejectedExpenseRequestAmount: this.money(
        row?.rejectedExpenseRequestAmount,
      ),
      currentPendingHandoverCount: Number(
        row?.currentPendingHandoverCount ?? 0,
      ),
      currentPendingHandoverAmount: this.money(
        row?.currentPendingHandoverAmount,
      ),
      approvedHandoverCount: Number(row?.approvedHandoverCount ?? 0),
      approvedHandoverAmount: this.money(row?.approvedHandoverAmount),
    };
  }

  private async getCashVarianceTrend(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
  ) {
    const format =
      period.granularity === 'hour' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
    const rows = await tx.$queryRaw<ReportCashVarianceTrendRow[]>(Prisma.sql`
      SELECT
        to_char(
          date_trunc(
            ${period.granularity},
            cs."closedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${period.timeZone}
          ),
          ${format}
        ) AS "bucket",
        COUNT(*)::bigint AS "closedShiftCount",
        COUNT(*) FILTER (
          WHERE cs."reportedEndingCash" <> cs."actualEndingCash"
        )::bigint AS "discrepantShiftCount",
        COALESCE(SUM(GREATEST(
          cs."actualEndingCash" - cs."reportedEndingCash",
          0
        )), 0)::numeric AS "cashShortageAmount",
        COALESCE(SUM(GREATEST(
          cs."reportedEndingCash" - cs."actualEndingCash",
          0
        )), 0)::numeric AS "cashOverageAmount"
      FROM "CashierShift" cs
      WHERE cs."status" = 'CLOSED'
        AND cs."closedAt" >= ${period.from}
        AND cs."closedAt" < ${period.to}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return rows.map((row) => ({
      bucket: row.bucket,
      closedShiftCount: Number(row.closedShiftCount),
      discrepantShiftCount: Number(row.discrepantShiftCount),
      cashShortageAmount: this.money(row.cashShortageAmount),
      cashOverageAmount: this.money(row.cashOverageAmount),
    }));
  }

  private async getEmployeeCashRisk(
    tx: ExtendedPrismaTransactionClient,
    period: ReportQueryPeriod,
    limit: number,
  ) {
    const rows = await tx.$queryRaw<ReportEmployeeCashRiskRow[]>(Prisma.sql`
      SELECT
        e."id" AS "employeeId",
        e."fullName" AS "employeeName",
        COUNT(*)::bigint AS "closedShiftCount",
        COUNT(*) FILTER (
          WHERE cs."actualEndingCash" > cs."reportedEndingCash"
        )::bigint AS "shortageShiftCount",
        COUNT(*) FILTER (
          WHERE cs."reportedEndingCash" > cs."actualEndingCash"
        )::bigint AS "overageShiftCount",
        COALESCE(SUM(GREATEST(
          cs."actualEndingCash" - cs."reportedEndingCash",
          0
        )), 0)::numeric AS "totalShortageAmount",
        COALESCE(SUM(GREATEST(
          cs."reportedEndingCash" - cs."actualEndingCash",
          0
        )), 0)::numeric AS "totalOverageAmount",
        COALESCE(SUM(GREATEST(-cs."openingDifference", 0)), 0)::numeric
          AS "openingShortageAmount",
        COALESCE(SUM(GREATEST(cs."openingDifference", 0)), 0)::numeric
          AS "openingOverageAmount"
      FROM "CashierShift" cs
      JOIN "Employee" e ON e."id" = cs."employeeId"
      WHERE cs."status" = 'CLOSED'
        AND cs."closedAt" >= ${period.from}
        AND cs."closedAt" < ${period.to}
      GROUP BY e."id", e."fullName"
      HAVING COUNT(*) FILTER (
        WHERE cs."reportedEndingCash" <> cs."actualEndingCash"
          OR cs."openingDifference" <> 0
      ) > 0
      ORDER BY "totalShortageAmount" DESC,
        "shortageShiftCount" DESC,
        e."fullName" ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => {
      const closedShiftCount = Number(row.closedShiftCount);
      const shortageShiftCount = Number(row.shortageShiftCount);

      return {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        closedShiftCount,
        shortageShiftCount,
        shortageRatePercent: (
          (shortageShiftCount / closedShiftCount) *
          100
        ).toFixed(2),
        overageShiftCount: Number(row.overageShiftCount),
        totalShortageAmount: this.money(row.totalShortageAmount),
        totalOverageAmount: this.money(row.totalOverageAmount),
        openingShortageAmount: this.money(row.openingShortageAmount),
        openingOverageAmount: this.money(row.openingOverageAmount),
      };
    });
  }

  private resolvePeriod(query: GetDashboardReportDto): ReportQueryPeriod {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 30 * DAY_MS);
    const duration = to.getTime() - from.getTime();

    if (duration <= 0) {
      throw new BadRequestException('from must be before to.');
    }
    if (duration > MAX_REPORT_RANGE_MS) {
      throw new BadRequestException('Report range cannot exceed 366 days.');
    }
    if (query.granularity === 'hour' && duration > MAX_HOURLY_RANGE_MS) {
      throw new BadRequestException('Hourly reports cannot exceed 31 days.');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: query.timeZone }).format();
    } catch {
      throw new BadRequestException('Invalid IANA time zone.');
    }

    return {
      from,
      to,
      timeZone: query.timeZone,
      granularity: query.granularity,
    };
  }

  private money(value?: Prisma.Decimal | null) {
    return (value ?? new Prisma.Decimal(0)).toFixed(2);
  }
}
