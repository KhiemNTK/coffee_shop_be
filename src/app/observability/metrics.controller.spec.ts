import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { MetricsController } from './metrics.controller';
import type { MetricsService } from './metrics.service';

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
});
