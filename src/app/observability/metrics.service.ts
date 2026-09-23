import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OutboxEventStatus,
  PaymentReconciliationIncidentStatus,
  PaymentReconciliationIncidentType,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import {
  dependencyUp,
  metricsCollectionFailuresTotal,
  metricsRegistry,
  outboxEvents,
  outboxLagSeconds,
  paymentReconciliationIncidents,
  paymentReviewItems,
  postgresConnections,
  postgresMaxConnections,
} from '../../common/observability/metrics';
import { HealthService } from '../health/health.service';

interface OperationalSnapshot {
  postgresConnections: number;
  postgresMaxConnections: number;
  outboxPending: number;
  outboxProcessing: number;
  outboxDeadLetter: number;
  outboxLagSeconds: number;
  paymentAttemptsRequiringReview: number;
  paymentRefundsRequiringReview: number;
}

const METRICS_CACHE_TTL_MS = 5_000;

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private lastRefreshAt = 0;
  private refreshPromise?: Promise<void>;
  private databaseAvailable?: boolean;
  private redisAvailable?: boolean;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly healthService: HealthService,
    private readonly config: ConfigService,
  ) {}

  get contentType() {
    return metricsRegistry.contentType;
  }

  isEnabled() {
    return this.config.get<boolean>('METRICS_ENABLED', true);
  }

  async render() {
    await this.refreshOperationalMetrics();
    return metricsRegistry.metrics();
  }

  private async refreshOperationalMetrics() {
    if (Date.now() - this.lastRefreshAt < METRICS_CACHE_TTL_MS) return;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.collectOperationalMetrics().finally(() => {
      this.lastRefreshAt = Date.now();
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async collectOperationalMetrics() {
    await Promise.all([
      this.collectDatabaseMetrics(),
      this.collectRedisMetric(),
    ]);
  }

  private async collectDatabaseMetrics() {
    try {
      const [rows, incidents] = await Promise.all([
        this.prisma.$queryRaw<OperationalSnapshot[]>(Prisma.sql`
          SELECT
            (SELECT COUNT(*)::int FROM pg_stat_activity) AS "postgresConnections",
            current_setting('max_connections')::int AS "postgresMaxConnections",
            (SELECT COUNT(*)::int FROM "OutboxEvent" WHERE "status" = 'PENDING') AS "outboxPending",
            (SELECT COUNT(*)::int FROM "OutboxEvent" WHERE "status" = 'PROCESSING') AS "outboxProcessing",
            (SELECT COUNT(*)::int FROM "OutboxEvent" WHERE "status" = 'DEAD_LETTER') AS "outboxDeadLetter",
            COALESCE((
              SELECT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - MIN("occurredAt"))::double precision
              FROM "OutboxEvent"
              WHERE "status" IN ('PENDING', 'PROCESSING')
            ), 0) AS "outboxLagSeconds",
            (SELECT COUNT(*)::int FROM "PaymentAttempt" WHERE "status" = 'REQUIRES_REVIEW') AS "paymentAttemptsRequiringReview",
            (SELECT COUNT(*)::int FROM "PaymentRefund" WHERE "status" = 'REQUIRES_REVIEW') AS "paymentRefundsRequiringReview"
        `),
        this.prisma.paymentReconciliationIncident.groupBy({
          by: ['type'],
          where: { status: PaymentReconciliationIncidentStatus.OPEN },
          _count: { _all: true },
        }),
      ]);

      const snapshot = rows[0];
      if (!snapshot)
        throw new Error('Operational metrics query returned no row');

      postgresConnections.set(snapshot.postgresConnections);
      postgresMaxConnections.set(snapshot.postgresMaxConnections);
      outboxEvents.reset();
      outboxEvents.set(
        { status: OutboxEventStatus.PENDING },
        snapshot.outboxPending,
      );
      outboxEvents.set(
        { status: OutboxEventStatus.PROCESSING },
        snapshot.outboxProcessing,
      );
      outboxEvents.set(
        { status: OutboxEventStatus.DEAD_LETTER },
        snapshot.outboxDeadLetter,
      );
      outboxLagSeconds.set(snapshot.outboxLagSeconds);
      paymentReviewItems.set(
        { kind: 'attempt' },
        snapshot.paymentAttemptsRequiringReview,
      );
      paymentReviewItems.set(
        { kind: 'refund' },
        snapshot.paymentRefundsRequiringReview,
      );

      paymentReconciliationIncidents.reset();
      for (const type of Object.values(PaymentReconciliationIncidentType)) {
        paymentReconciliationIncidents.set({ type }, 0);
      }
      for (const incident of incidents) {
        paymentReconciliationIncidents.set(
          { type: incident.type },
          incident._count._all,
        );
      }

      dependencyUp.set({ dependency: 'postgres' }, 1);
      this.logDependencyTransition('postgres', true);
    } catch (error) {
      dependencyUp.set({ dependency: 'postgres' }, 0);
      metricsCollectionFailuresTotal.inc({ collector: 'postgres' });
      this.logDependencyTransition('postgres', false, error);
    }
  }

  private async collectRedisMetric() {
    const status = await this.healthService.redisStatus();
    const available = status !== 'down';
    dependencyUp.set({ dependency: 'redis' }, available ? 1 : 0);
    if (!available) metricsCollectionFailuresTotal.inc({ collector: 'redis' });
    this.logDependencyTransition('redis', available);
  }

  private logDependencyTransition(
    dependency: 'postgres' | 'redis',
    available: boolean,
    error?: unknown,
  ) {
    const previous =
      dependency === 'postgres' ? this.databaseAvailable : this.redisAvailable;
    if (previous === available) return;

    if (dependency === 'postgres') this.databaseAvailable = available;
    else this.redisAvailable = available;

    const context = {
      event: 'dependency.status.changed',
      dependency,
      status: available ? 'up' : 'down',
      ...(error instanceof Error ? { error: error.message } : {}),
    };
    if (available) this.logger.log(context);
    else this.logger.error(context);
  }
}
