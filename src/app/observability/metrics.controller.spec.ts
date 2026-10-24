import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'express';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  const token = 'strong-metrics-token-with-more-than-32-characters';

  const createController = () => {
    const metricsService = {
      isEnabled: jest.fn().mockReturnValue(true),
      contentType: 'text/plain',
      render: jest.fn().mockResolvedValue('metric 1\n'),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'METRICS_TOKEN') return token;
        if (key === 'NODE_ENV') return 'production';
        return fallback;
      }),
    };
    const responseMock = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    return {
      controller: new MetricsController(
        metricsService as unknown as MetricsService,
        config as unknown as ConfigService,
      ),
      metricsService,
      response: responseMock as unknown as Response,
      responseMock,
    };
  };

  it('rejects a scrape with an invalid production token', async () => {
    const { controller, response } = createController();

    await expect(controller.scrape('Bearer invalid', response)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('returns Prometheus text for an authorized scrape', async () => {
    const { controller, metricsService, response, responseMock } =
      createController();

    await controller.scrape(`Bearer ${token}`, response);

    expect(responseMock.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain',
    );
    expect(responseMock.send).toHaveBeenCalledWith('metric 1\n');
    expect(metricsService.render.mock.calls).toHaveLength(1);
  });

  it('keeps token protection but bypasses the global Redis limiter even during an outage', async () => {
    const storage = {
      increment: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };
    const { metricsService } = createController();
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          storage,
          throttlers: [{ ttl: 60_000, limit: 1 }],
        }),
      ],
      controllers: [MetricsController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            NODE_ENV: 'production',
            METRICS_TOKEN: token,
          }),
        },
        { provide: MetricsService, useValue: metricsService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      await request(app.getHttpServer() as App)
        .get('/metrics')
        .expect(401);
      await request(app.getHttpServer() as App)
        .get('/metrics')
        .set('Authorization', `Bearer ${token}`)
        .expect(200, 'metric 1\n');
      expect(storage.increment).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
