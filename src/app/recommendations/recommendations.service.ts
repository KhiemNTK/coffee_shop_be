import { createHash } from 'node:crypto';
import { INVOICE_REFUNDS_SQL } from '../../common/prisma/invoice-refunds.query';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, ServeStatus, SessionStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { RecommendOnlineItemsDto } from './dto/recommendation.dto';
import {
  PUBLIC_MENU_SELECT,
  PUBLIC_MENU_WHERE,
} from '../menu/public-menu-query';
import {
  RECOMMENDATION_MIN_SUPPORT as MIN_PAIR_SUPPORT,
  RECOMMENDATION_PAIRS_PER_ANCHOR as MAX_PAIRS_PER_ANCHOR,
  RECOMMENDATION_LIMIT as MAX_RECOMMENDATIONS,
} from '../../common/consts/recommendations';
import { rankRecommendationCandidates } from './recommendation-ranking';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TRAINING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

type Variant = 'CONTROL' | 'TREATMENT';
type ExperimentRow = {
  variant: string;
  assignments: bigint;
  offersWithCandidates: bigint;
  requests: bigint;
  paidOrders: bigint;
  attachedOrders: bigint;
  revenue: Prisma.Decimal;
};

@Injectable()
export class RecommendationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecommendationsService.name);
  private refreshTimer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  onModuleInit() {
    this.startupTimer = setTimeout(
      () => void this.refreshInBackground(),
      1_000,
    );
    this.startupTimer.unref();
    this.refreshTimer = setInterval(
      () => void this.refreshInBackground(),
      REFRESH_INTERVAL_MS,
    );
    this.refreshTimer.unref();
  }

  onModuleDestroy() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private async refreshInBackground() {
    try {
      await this.refreshPairs();
    } catch (error) {
      this.logger.error('Recommendation pair refresh failed.', error);
    }
  }

  async refreshPairs(force = false) {
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(182746, 1) AS locked
        `;
        if (!lock?.locked) return false;
        if (!force) {
          const [latest] = await tx.$queryRaw<
            Array<{ refreshedAt: Date | null }>
          >`
            SELECT MAX("refreshedAt") AS "refreshedAt" FROM "MenuItemRecommendationPair"
          `;
          if (
            latest?.refreshedAt &&
            latest.refreshedAt.getTime() > now.getTime() - REFRESH_INTERVAL_MS
          ) {
            return false;
          }
        }

        // shortcut: partial refunds have no item attribution; retain non-cancelled lines until line-level refunds exist.
        await tx.$executeRaw`
          WITH eligible AS (
            SELECT DISTINCT oi."invoiceId", oi."menuItemId"
            FROM "OrderItem" oi
            JOIN "Invoice" i ON i."id" = oi."invoiceId"
            WHERE i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
              AND i."createdAt" >= ${new Date(now.getTime() - TRAINING_WINDOW_MS)}
              AND oi."serveStatus" <> 'CANCELLED'
          ), pairs AS (
            SELECT a."menuItemId" AS "anchorId", b."menuItemId" AS "candidateId",
                   COUNT(*)::integer AS support
            FROM eligible a
            JOIN eligible b ON b."invoiceId" = a."invoiceId"
                           AND b."menuItemId" <> a."menuItemId"
            GROUP BY a."menuItemId", b."menuItemId"
            HAVING COUNT(*) >= ${MIN_PAIR_SUPPORT}
          ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY "anchorId" ORDER BY support DESC, "candidateId"
            ) AS rank
            FROM pairs
          )
          INSERT INTO "MenuItemRecommendationPair"
            ("anchorId", "candidateId", "support", "refreshedAt")
          SELECT "anchorId", "candidateId", support, ${now}
          FROM ranked WHERE rank <= ${MAX_PAIRS_PER_ANCHOR}
          ON CONFLICT ("anchorId", "candidateId") DO UPDATE
            SET "support" = EXCLUDED."support", "refreshedAt" = EXCLUDED."refreshedAt"
        `;
        await tx.menuItemRecommendationPair.deleteMany({
          where: { refreshedAt: { lt: now } },
        });
        await tx.recommendationExposure.deleteMany({
          where: {
            createdAt: { lt: new Date(now.getTime() - TRAINING_WINDOW_MS) },
          },
        });
        return true;
      },
      { maxWait: 5_000, timeout: 120_000 },
    );
  }

  async recommendOnline({
    clientRequestId,
    menuItemIds,
  }: RecommendOnlineItemsDto) {
    const basketHash = createHash('sha256')
      .update(JSON.stringify([...menuItemIds].sort()))
      .digest('hex');
    const anchors = await this.availableItems(menuItemIds);
    if (anchors.length !== menuItemIds.length) {
      throw new NotFoundException('One or more menu items are unavailable.');
    }
    let exposure = await this.prisma.recommendationExposure.findUnique({
      where: { clientRequestId },
    });
    if (
      exposure?.basketHash !== undefined &&
      exposure.basketHash !== basketHash
    ) {
      throw new ConflictException(
        'Use a new client request ID after changing the cart.',
      );
    }

    if (!exposure) {
      const existingOrder = await this.prisma.onlineOrderRequest.findUnique({
        where: { clientRequestId },
        select: { id: true },
      });
      if (existingOrder) {
        throw new ConflictException(
          'Recommendations must be requested before checkout.',
        );
      }
      const variant: Variant =
        createHash('sha256').update(clientRequestId).digest()[0] % 2 === 0
          ? 'CONTROL'
          : 'TREATMENT';
      const candidateIds =
        variant === 'TREATMENT' ? await this.pickCandidates(menuItemIds) : [];
      try {
        exposure = await this.prisma.recommendationExposure.create({
          data: { clientRequestId, basketHash, variant, candidateIds },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
        exposure = await this.prisma.recommendationExposure.findUniqueOrThrow({
          where: { clientRequestId },
        });
        if (exposure.basketHash !== basketHash) {
          throw new ConflictException(
            'Use a new client request ID after changing the cart.',
          );
        }
      }
    }

    return {
      variant: exposure.variant,
      recommendations: await this.currentSuggestions(
        this.readCandidateIds(exposure.candidateIds),
      ),
    };
  }

  async recommendPos(sessionId: string) {
    const session = await this.prisma.orderSession.findUnique({
      where: { id: sessionId },
      select: {
        sessionStatus: true,
        orderItems: {
          where: { serveStatus: { not: ServeStatus.CANCELLED } },
          select: { menuItemId: true },
          distinct: ['menuItemId'],
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!session || session.sessionStatus !== SessionStatus.ACTIVE) {
      throw new NotFoundException('Active order session not found.');
    }
    const itemIds = session.orderItems.map((item) => item.menuItemId);
    return {
      recommendations: await this.currentSuggestions(
        await this.pickCandidates(itemIds),
      ),
    };
  }

  // Exposure-time cohort: paidOrders counts purchases even after a full refund.
  // attachedOrders counts non-cancelled candidate purchases, not items retained after refunds.
  // Refunds lack item attribution; revenue and its averages use current net invoice receipts.
  async getExperiment(from: Date, to: Date) {
    if (from.getTime() < Date.now() - TRAINING_WINDOW_MS) {
      throw new BadRequestException(
        'Recommendation metrics are retained for 90 days.',
      );
    }
    const rows = await this.prisma.$queryRaw<ExperimentRow[]>(Prisma.sql`
      WITH outcomes AS (
        SELECT e."variant", r."id" AS "requestId",
               jsonb_array_length(e."candidateIds") AS "candidateCount",
               COALESCE(paid."count", 0) > 0 AS paid,
               COALESCE(paid."revenue", 0)::numeric AS revenue,
               EXISTS (
                 SELECT 1 FROM "OrderItem" oi
                 JOIN "Invoice" i ON i."id" = oi."invoiceId"
                 WHERE oi."orderSessionId" = r."orderSessionId"
                   AND i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
                   AND oi."serveStatus" <> 'CANCELLED'
                   AND e."candidateIds" ? oi."menuItemId"
               ) AS attached
        FROM "RecommendationExposure" e
        LEFT JOIN "OnlineOrderRequest" r
          ON r."clientRequestId" = e."clientRequestId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS count,
                 COALESCE(SUM(i."totalAmount" - COALESCE(refunds."amount", 0)), 0)::numeric AS revenue
          FROM "Invoice" i
          LEFT JOIN LATERAL (
            SELECT SUM(pr."amount") AS "amount"
            FROM (${INVOICE_REFUNDS_SQL}) pr
            WHERE pr."invoiceId" = i."id" AND pr."status" = 'SUCCEEDED'
          ) refunds ON TRUE
          WHERE i."orderSessionId" = r."orderSessionId"
            AND i."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        ) paid ON TRUE
        WHERE e."createdAt" >= ${from} AND e."createdAt" < ${to}
      )
      SELECT "variant", COUNT(*) AS assignments,
             COUNT(*) FILTER (WHERE "variant" = 'TREATMENT' AND "candidateCount" > 0) AS "offersWithCandidates",
             COUNT("requestId") AS requests,
             COUNT(*) FILTER (WHERE paid) AS "paidOrders",
             COUNT(*) FILTER (WHERE paid AND attached) AS "attachedOrders",
             COALESCE(SUM(revenue), 0)::numeric AS revenue
      FROM outcomes GROUP BY "variant"
    `);
    return {
      from,
      to,
      variants: (['CONTROL', 'TREATMENT'] as const).map((variant) => {
        const row = rows.find((item) => item.variant === variant);
        const assignments = Number(row?.assignments ?? 0);
        const paidOrders = Number(row?.paidOrders ?? 0);
        return {
          variant,
          assignments,
          offersWithCandidates: Number(row?.offersWithCandidates ?? 0),
          requests: Number(row?.requests ?? 0),
          paidOrders,
          attachedOrders: Number(row?.attachedOrders ?? 0),
          revenue: (row?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
          paidConversionRate: assignments ? paidOrders / assignments : 0,
          attachedPaidOrderRate: paidOrders
            ? Number(row?.attachedOrders ?? 0) / paidOrders
            : 0,
          revenuePerAssignment: assignments
            ? row!.revenue.div(assignments).toFixed(2)
            : '0.00',
          averageOrderValue: paidOrders
            ? row!.revenue.div(paidOrders).toFixed(2)
            : '0.00',
        };
      }),
    };
  }

  private async pickCandidates(menuItemIds: string[]) {
    if (!menuItemIds.length) return [];
    const pairs = await this.prisma.menuItemRecommendationPair.findMany({
      where: {
        anchorId: { in: menuItemIds },
        candidateId: { notIn: menuItemIds },
      },
      select: { candidateId: true, support: true },
      orderBy: [{ support: 'desc' }, { candidateId: 'asc' }],
      take: menuItemIds.length * MAX_PAIRS_PER_ANCHOR,
    });
    const rankedIds = rankRecommendationCandidates(pairs);
    const available = await this.availableItems(rankedIds);
    const availableIds = new Set(available.map((item) => item.id));
    return rankedIds
      .filter((id) => availableIds.has(id))
      .slice(0, MAX_RECOMMENDATIONS);
  }

  private availableItems(
    ids: string[],
  ): Promise<Array<{ id: string; name: string; price: Prisma.Decimal }>> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.menuItem.findMany({
      where: {
        ...PUBLIC_MENU_WHERE,
        id: { in: ids },
      },
      select: { id: true, name: true, price: true },
    });
  }

  private async currentSuggestions(candidateIds: string[]) {
    if (!candidateIds.length) return [];
    const available = await this.prisma.menuItem.findMany({
      where: { ...PUBLIC_MENU_WHERE, id: { in: candidateIds } },
      select: PUBLIC_MENU_SELECT,
    });
    const byId = new Map(available.map((item) => [item.id, item] as const));
    return candidateIds.flatMap((id) => {
      const item = byId.get(id);
      return item
        ? [{ ...item, menuItemId: id, price: item.price.toFixed(2) }]
        : [];
    });
  }

  private readCandidateIds(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];
  }
}
