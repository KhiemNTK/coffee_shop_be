import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const createService = (nodeEnvironment: string) => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]) };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'NODE_ENV') return nodeEnvironment;
        if (key === 'REDIS_URL') return undefined;
        return fallback;
      }),
    };

    return new HealthService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
    );
  };

  it('reports Redis as disabled outside production when it is not configured', async () => {
    await expect(createService('test').readiness()).resolves.toEqual({
      status: 'ready',
      dependencies: { database: 'up', redis: 'disabled' },
    });
  });

  it('fails readiness when production Redis is not configured', async () => {
    await expect(createService('production').readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('reports a missing optional Redis dependency as disabled', async () => {
    await expect(createService('test').redisStatus()).resolves.toBe('disabled');
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection exhausted')),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'NODE_ENV') return 'test';
        if (key === 'REDIS_URL') return undefined;
        return fallback;
      }),
    };
    const service = new HealthService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
    );

    await expect(service.readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
