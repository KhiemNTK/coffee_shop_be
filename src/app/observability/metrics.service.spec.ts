import type { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { HealthService } from '../health/health.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('caches operational snapshots between nearby scrapes', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          postgresConnections: 5,
          postgresMaxConnections: 100,
          outboxPending: 2,
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
    const health = { redisStatus: jest.fn().mockResolvedValue('up') };
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    };
    const service = new MetricsService(
      prisma as unknown as ExtendedPrismaClient,
      health as unknown as HealthService,
      config as unknown as ConfigService,
    );

    const first = await service.render();
    const second = await service.render();

    expect(first).toMatch(/coffee_shop_outbox_lag_seconds\{[^}]+\} 3/);
    expect(second).toContain('coffee_shop_payment_review_items');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.paymentReconciliationIncident.groupBy).toHaveBeenCalledTimes(
      1,
    );
    expect(health.redisStatus).toHaveBeenCalledTimes(1);
  });
});
