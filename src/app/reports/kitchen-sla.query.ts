import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type {
  ReportKitchenBottleneckRow,
  ReportKitchenSlaRow,
  ReportQueryPeriod,
} from '../../common/types';

function kitchenTicketFacts(period: ReportQueryPeriod, stationId?: string) {
  return Prisma.sql`
    WITH ticket_facts AS (
      SELECT t."createdAt", t."dueAt", s."id" AS "stationId",
             s."code" AS "stationCode", s."name" AS "stationName",
             items."itemCount", items."activeCount", items."waitingCount", items."lastReadyAt",
             items."orderedUnits"
      FROM "KitchenTicket" t
      JOIN "KitchenStation" s ON s."id" = t."stationId"
      JOIN LATERAL (
        SELECT COUNT(*) AS "itemCount",
               COUNT(*) FILTER (WHERE oi."serveStatus" <> 'CANCELLED') AS "activeCount",
               COUNT(*) FILTER (WHERE oi."serveStatus" <> 'CANCELLED' AND oi."readyAt" IS NULL) AS "waitingCount",
               MAX(oi."readyAt") FILTER (WHERE oi."serveStatus" <> 'CANCELLED') AS "lastReadyAt",
               COALESCE(SUM(ti."quantity"), 0)::bigint AS "orderedUnits"
        FROM "KitchenTicketItem" ti
        JOIN "OrderItem" oi ON oi."id" = ti."orderItemId"
        WHERE ti."ticketId" = t."id"
      ) items ON TRUE
      WHERE t."createdAt" >= ${period.from} AND t."createdAt" < ${period.to}
        ${stationId ? Prisma.sql`AND t."stationId" = ${stationId}` : Prisma.empty}
    )
  `;
}

function kitchenSlaAggregates(asOf: Date) {
  return Prisma.sql`
           COUNT(*)::bigint AS "ticketCount",
           COUNT(*) FILTER (WHERE f."activeCount" > 0 AND f."waitingCount" = 0)::bigint AS "completedCount",
           COUNT(*) FILTER (WHERE f."activeCount" > 0 AND f."waitingCount" = 0 AND f."lastReadyAt" > f."dueAt")::bigint AS "lateCompletedCount",
           COUNT(*) FILTER (WHERE f."activeCount" > 0 AND f."waitingCount" > 0 AND f."dueAt" < ${asOf})::bigint AS "overdueOpenCount",
           AVG(EXTRACT(EPOCH FROM f."lastReadyAt" - f."createdAt")) FILTER
             (WHERE f."activeCount" > 0 AND f."waitingCount" = 0 AND f."lastReadyAt" >= f."createdAt")::float8 AS "averageTicketToReadySeconds",
           percentile_cont(0.95) WITHIN GROUP
             (ORDER BY EXTRACT(EPOCH FROM f."lastReadyAt" - f."createdAt")) FILTER
             (WHERE f."activeCount" > 0 AND f."waitingCount" = 0 AND f."lastReadyAt" >= f."createdAt") AS "p95TicketToReadySeconds"
  `;
}

export function queryKitchenSla(
  prisma: ExtendedPrismaClient,
  period: ReportQueryPeriod,
  asOf: Date,
  stationId?: string,
) {
  return prisma.$queryRaw<ReportKitchenSlaRow[]>(Prisma.sql`
    ${kitchenTicketFacts(period, stationId)}
    SELECT f."stationId", f."stationCode", f."stationName",
           ${kitchenSlaAggregates(asOf)}
    FROM ticket_facts f
    GROUP BY f."stationId", f."stationCode", f."stationName"
    ORDER BY "overdueOpenCount" DESC, "lateCompletedCount" DESC, f."stationCode" ASC
  `);
}

export function queryKitchenBottlenecks(
  prisma: ExtendedPrismaClient,
  period: ReportQueryPeriod,
  asOf: Date,
  stationId?: string,
) {
  return prisma.$queryRaw<ReportKitchenBottleneckRow[]>(Prisma.sql`
    ${kitchenTicketFacts(period, stationId)}
    SELECT date_trunc('hour', f."createdAt" AT TIME ZONE 'UTC', ${period.timeZone}) AS "bucketStartAt",
           f."stationId", f."stationCode", f."stationName",
           ${kitchenSlaAggregates(asOf)},
           COALESCE(SUM(f."orderedUnits"), 0)::bigint AS "orderedUnitCount",
           COUNT(*) FILTER (WHERE f."activeCount" > 0 AND f."waitingCount" > 0)::bigint AS "openNowCount",
           COUNT(*) FILTER (WHERE f."itemCount" > 0 AND f."activeCount" = 0)::bigint AS "cancelledTicketCount"
    FROM ticket_facts f
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, f."stationCode", f."stationId"
  `);
}
