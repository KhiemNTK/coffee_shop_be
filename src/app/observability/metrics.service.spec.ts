import type { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { HealthService } from '../health/health.service';
import { MetricsService } from './metrics.service';
import type { BusinessInsightsService } from '../reports/business-insights.service';
import { Logger } from '@nestjs/common';

describe('MetricsService', () => {
  it('caches operational snapshots between nearby scrapes', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          postgresConnections: 5,
          postgresMaxConnections: 100,
          outboxPending: 2,
          outboxEnqueued: 1,
          outboxProcessing: 1,
          outboxDeadLetter: 0,
          outboxLagSeconds: 3,
          paymentAttemptsRequiringReview: 1,
          paymentRefundsRequiringReview: 0,
        },
      ]),
      paymentReconciliationIncident: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    const health = {
      redisStatus: jest.fn().mockResolvedValue('up'),
      redisMemory: jest.fn().mockResolvedValue({ used: 1024, limit: 4096 }),
    };
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    };
    const insights = { collectMetrics: jest.fn().mockResolvedValue(undefined) };
    const service = new MetricsService(
      prisma as unknown as ExtendedPrismaClient,
      health as unknown as HealthService,
      config as unknown as ConfigService,
      insights as unknown as BusinessInsightsService,
    );

    const first = await service.render();
    const second = await service.render();

    expect(first).toMatch(/coffee_shop_outbox_lag_seconds\{[^}]+\} 3/);
    expect(second).toContain('coffee_shop_payment_review_items');
    expect(first).toMatch(/coffee_shop_redis_memory_used_bytes\{[^}]+\} 1024/);
    expect(first).toMatch(/coffee_shop_redis_maxmemory_bytes\{[^}]+\} 4096/);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.paymentReconciliationIncident.groupBy).toHaveBeenCalledTimes(
      1,
    );
    expect(health.redisStatus).toHaveBeenCalledTimes(1);
    expect(health.redisMemory).toHaveBeenCalledTimes(1);
    expect(insights.collectMetrics).toHaveBeenCalledTimes(1);
  });

  it('keeps scrapes available when INFO permission is missing but PING works', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const service = new MetricsService(
        {
          $queryRaw: jest
            .fn()
            .mockRejectedValue(new Error('Fixture database unavailable')),
          paymentReconciliationIncident: {
            groupBy: jest.fn().mockResolvedValue([]),
          },
        } as never,
        {
          redisStatus: jest.fn().mockResolvedValue('up'),
          redisMemory: jest.fn().mockRejectedValue(new Error('NOPERM INFO')),
        } as never,
        {} as never,
        { collectMetrics: jest.fn().mockResolvedValue(undefined) } as never,
      );
      const text = await service.render();
      expect(text).toMatch(
        /coffee_shop_dependency_up\{[^}]*dependency="redis"[^}]*\} 1/,
      );
      expect(text).toMatch(
        /coffee_shop_metrics_collection_failures_total\{[^}]*collector="redis_memory"[^}]*\} [1-9]/,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('still serves scrape data and dependency failures when PostgreSQL and Redis are down', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const service = new MetricsService(
        {
          $queryRaw: jest
            .fn()
            .mockRejectedValue(new Error('Database unavailable')),
          paymentReconciliationIncident: {
            groupBy: jest.fn().mockResolvedValue([]),
          },
        } as never,
        { redisStatus: jest.fn().mockResolvedValue('down') } as never,
        { get: jest.fn((_key, fallback) => fallback) } as never,
        { collectMetrics: jest.fn().mockResolvedValue(undefined) } as never,
      );
      const text = await service.render();
      expect(text).toMatch(
        /coffee_shop_dependency_up\{[^}]*dependency="postgres"[^}]*\} 0/,
      );
      expect(text).toMatch(
        /coffee_shop_dependency_up\{[^}]*dependency="redis"[^}]*\} 0/,
      );
      expect(text).toMatch(
        /coffee_shop_metrics_collection_failures_total\{[^}]*collector="postgres"[^}]*\} [1-9]/,
      );
    } finally {
      logger.mockRestore();
    }
  });
});
