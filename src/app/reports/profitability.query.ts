import { Prisma } from '@prisma/client';
import type {
  ExtendedPrismaTransactionClient,
  ReportProfitabilityRow,
  ReportQueryPeriod,
} from '../../common/types';

export async function queryProfitability(
  tx: ExtendedPrismaTransactionClient,
  period: Pick<ReportQueryPeriod, 'from' | 'to'>,
  asOf: Date,
) {
  const [row] = await tx.$queryRaw<ReportProfitabilityRow[]>(Prisma.sql`
    WITH invoice_cohort AS MATERIALIZED (
      SELECT i."id", i."subTotal", i."discountAmount", i."taxAmount", i."totalAmount"
      FROM "Invoice" i
      WHERE i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND i."createdAt" >= ${period.from}
        AND i."createdAt" < ${period.to}
    ), refunds AS (
      SELECT pa."invoiceId", COUNT(*)::bigint AS count, SUM(pr."amount") AS amount
      FROM "PaymentRefund" pr
      JOIN "PaymentAttempt" pa ON pa."id" = pr."paymentAttemptId"
      JOIN invoice_cohort i ON i."id" = pa."invoiceId"
      WHERE pr."status" = 'SUCCEEDED' AND pr."completedAt" <= ${asOf}
      GROUP BY pa."invoiceId"
    ), sales AS (
      SELECT
        COUNT(*)::bigint AS "paidInvoiceCount",
        COALESCE(SUM(i."subTotal"), 0)::numeric AS "grossSales",
        COALESCE(SUM(i."discountAmount"), 0)::numeric AS "discountAmount",
        COALESCE(SUM(i."taxAmount"), 0)::numeric AS "taxAmount",
        COALESCE(SUM(r.count), 0)::bigint AS "refundCount",
        COALESCE(SUM(COALESCE(r.amount, 0)), 0)::numeric AS "refundAmount",
        COALESCE(SUM(i."totalAmount" - COALESCE(r.amount, 0)), 0)::numeric AS "netReceipts",
        -- Refunds have no line-level tax split, so VAT is allocated pro rata.
        COALESCE(SUM(CASE
          WHEN i."totalAmount" = 0 THEN 0
          ELSE ROUND(
            GREATEST(i."totalAmount" - COALESCE(r.amount, 0), 0)
              * (i."totalAmount" - i."taxAmount") / i."totalAmount", 2
          )
        END), 0)::numeric AS "netSalesExTax"
      FROM invoice_cohort i
      LEFT JOIN refunds r ON r."invoiceId" = i."id"
    ), costs AS (
      SELECT
        COALESCE(SUM(s."totalCost"), 0)::numeric AS "ingredientCost",
        COUNT(*)::bigint AS "soldItemCount",
        COUNT(*) FILTER (WHERE s."snapshotCount" > 0)::bigint AS "itemsWithCostSnapshot",
        COUNT(*) FILTER (
          WHERE s."snapshotCount" > 0 AND s."totalCost" = 0
        )::bigint AS "zeroCostSnapshotCount"
      FROM "OrderItem" oi
      JOIN invoice_cohort i ON i."id" = oi."invoiceId"
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS "snapshotCount", SUM(ois."totalCost") AS "totalCost"
        FROM "OrderItemIngredientSnapshot" ois
        WHERE ois."orderItemId" = oi."id"
      ) s ON true
      WHERE oi."serveStatus" <> 'CANCELLED'
    ), waste AS (
      SELECT COALESCE(SUM(ROUND(iw."quantity" * ois."unitCost", 2)), 0)::numeric AS "wasteCost"
      FROM "InventoryWaste" iw
      JOIN "OrderItemIngredientSnapshot" ois
        ON ois."orderItemId" = iw."orderItemId"
       AND ois."inventoryItemId" = iw."inventoryItemId"
      WHERE iw."createdAt" >= ${period.from}
        AND iw."createdAt" < ${period.to}
    )
    SELECT sales.*, costs.*, waste.* FROM sales CROSS JOIN costs CROSS JOIN waste
  `);

  const money = (value?: Prisma.Decimal) =>
    (value ?? new Prisma.Decimal(0)).toFixed(2);
  const netSalesExTax = row?.netSalesExTax ?? new Prisma.Decimal(0);
  const ingredientCost = row?.ingredientCost ?? new Prisma.Decimal(0);
  const wasteCost = row?.wasteCost ?? new Prisma.Decimal(0);

  return {
    asOf: asOf.toISOString(),
    paidInvoiceCount: Number(row?.paidInvoiceCount ?? 0),
    grossSales: money(row?.grossSales),
    discountAmount: money(row?.discountAmount),
    taxAmount: money(row?.taxAmount),
    refundCount: Number(row?.refundCount ?? 0),
    refundAmount: money(row?.refundAmount),
    netReceipts: money(row?.netReceipts),
    estimatedNetSalesExTax: money(netSalesExTax),
    ingredientCost: money(ingredientCost),
    wasteCost: money(wasteCost),
    estimatedGrossProfit: money(
      netSalesExTax.minus(ingredientCost).minus(wasteCost),
    ),
    soldItemCount: Number(row?.soldItemCount ?? 0),
    itemsWithCostSnapshot: Number(row?.itemsWithCostSnapshot ?? 0),
    zeroCostSnapshotCount: Number(row?.zeroCostSnapshotCount ?? 0),
  };
}
