import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type {
  ReportOnlineOrderJourneyRow,
  ReportQueryPeriod,
} from '../../common/types';

export function queryOnlineOrderJourney(
  prisma: ExtendedPrismaClient,
  period: ReportQueryPeriod,
  asOf: Date,
) {
  // The cohort is anchored to request creation, not invoice creation; later refunds restate its receipts.
  return prisma.$queryRaw<ReportOnlineOrderJourneyRow[]>(Prisma.sql`
    WITH cohort AS (
      SELECT r."id", r."status", r."createdAt", r."expiresAt", r."reviewedAt",
             r."orderSessionId", r."quotedSubtotal", r."pickupAt", r."noShowAt"
      FROM "OnlineOrderRequest" r
      WHERE r."createdAt" >= ${period.from} AND r."createdAt" < ${period.to}
    ),
    item_state AS (
      SELECT oi."orderSessionId",
             BOOL_AND(oi."readyAt" IS NOT NULL) AS "allReadyAt",
             BOOL_AND(oi."isPaid") AS "allPaid",
             BOOL_AND(oi."serveStatus" = 'SERVED' AND oi."isPaid") AS "allCollected",
             MAX(oi."readyAt") AS "lastReadyAt"
      FROM "OrderItem" oi
      JOIN cohort r ON r."orderSessionId" = oi."orderSessionId"
      GROUP BY oi."orderSessionId"
    ),
    payments AS (
      SELECT i."orderSessionId", COUNT(*)::bigint AS "paidInvoiceCount",
             SUM(i."totalAmount" - COALESCE(refunds."amount", 0)) AS "netReceipts"
      FROM "Invoice" i
      JOIN cohort r ON r."orderSessionId" = i."orderSessionId"
      LEFT JOIN LATERAL (
        SELECT SUM(pr."amount") AS "amount"
        FROM "PaymentAttempt" pa
        JOIN "PaymentRefund" pr ON pr."paymentAttemptId" = pa."id"
        WHERE pa."invoiceId" = i."id" AND pr."status" = 'SUCCEEDED'
      ) refunds ON TRUE
      WHERE i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
      GROUP BY i."orderSessionId"
    ),
    journeys AS (
      SELECT r.*,
             to_char(r."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${period.timeZone}, 'YYYY-MM-DD') AS "day",
             (COALESCE(s."allReadyAt", FALSE) OR COALESCE(s."allCollected", FALSE)) AS "reachedReady",
             COALESCE(s."allPaid", FALSE) AS "allPaid",
             COALESCE(s."allCollected", FALSE) AS "allCollected",
             s."lastReadyAt",
             COALESCE(p."paidInvoiceCount", 0) AS "paidInvoiceCount",
             COALESCE(p."netReceipts", 0) AS "netReceipts"
      FROM cohort r
      LEFT JOIN item_state s ON s."orderSessionId" = r."orderSessionId"
      LEFT JOIN payments p ON p."orderSessionId" = r."orderSessionId"
    )
    SELECT CASE WHEN GROUPING("day") = 1 THEN NULL ELSE "day" END AS "bucket",
           COUNT(*)::bigint AS "submittedCount",
           COUNT(*) FILTER (WHERE "status" = 'PENDING' AND "expiresAt" > ${asOf})::bigint AS "pendingCount",
           COUNT(*) FILTER (WHERE "status" = 'PENDING' AND "expiresAt" <= ${asOf})::bigint AS "expiredCount",
           COUNT(*) FILTER (WHERE "orderSessionId" IS NOT NULL AND "reviewedAt" IS NOT NULL)::bigint AS "acceptedCount",
           COUNT(*) FILTER (WHERE "pickupAt" IS NOT NULL AND "orderSessionId" IS NOT NULL AND "reviewedAt" IS NOT NULL)::bigint AS "scheduledAcceptedCount",
           COUNT(*) FILTER (WHERE "pickupAt" IS NOT NULL AND "allCollected")::bigint AS "scheduledCollectedCount",
           COUNT(*) FILTER (WHERE "noShowAt" IS NOT NULL)::bigint AS "noShowCount",
           COUNT(*) FILTER (WHERE "status" = 'REJECTED')::bigint AS "rejectedCount",
           COUNT(*) FILTER (WHERE "status" = 'CANCELLED' AND "orderSessionId" IS NULL)::bigint AS "cancelledBeforeReviewCount",
           COUNT(*) FILTER (WHERE "status" = 'CANCELLED' AND "orderSessionId" IS NOT NULL)::bigint AS "cancelledAfterAcceptanceCount",
           COUNT(*) FILTER (WHERE "reachedReady")::bigint AS "readyCount",
           COUNT(*) FILTER (WHERE "allPaid" AND "paidInvoiceCount" > 0)::bigint AS "paidCount",
           COUNT(*) FILTER (WHERE "allCollected")::bigint AS "collectedCount",
           COALESCE(SUM("quotedSubtotal"), 0)::numeric AS "quotedDemand",
           COALESCE(SUM("netReceipts"), 0)::numeric AS "netReceipts",
           COALESCE(SUM("netReceipts") FILTER (WHERE "allCollected"), 0)::numeric AS "collectedNetReceipts",
           COUNT(*) FILTER (WHERE "reviewedAt" >= "createdAt")::bigint AS "reviewedCount",
           COALESCE(SUM(EXTRACT(EPOCH FROM "reviewedAt" - "createdAt")) FILTER (WHERE "reviewedAt" >= "createdAt"), 0)::numeric AS "reviewSeconds",
           COUNT(*) FILTER (WHERE "reachedReady" AND "lastReadyAt" >= "reviewedAt")::bigint AS "prepSampleCount",
           COALESCE(SUM(EXTRACT(EPOCH FROM "lastReadyAt" - "reviewedAt")) FILTER (WHERE "reachedReady" AND "lastReadyAt" >= "reviewedAt"), 0)::numeric AS "prepSeconds"
    FROM journeys
    GROUP BY ROLLUP("day")
    ORDER BY "bucket" NULLS FIRST
  `);
}
