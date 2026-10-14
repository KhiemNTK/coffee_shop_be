import { EventEmitter } from 'node:events';
import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  httpRequestsInFlight,
  httpRequestsTotal,
} from '../observability/metrics';
import { httpLoggingMiddleware } from './http-logging.middleware';
import {
  requestContextMiddleware,
  type RequestWithContext,
} from './request-context.middleware';
import type { HttpResponseLocals } from '../types';

class RejectGuard {
  canActivate() {
    throw new ForbiddenException('Denied');
  }
}

@Controller('logging-probe')
@UseGuards(RejectGuard)
class ProbeController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('HTTP logging middleware', () => {
  afterEach(() => jest.restoreAllMocks());

  const fixture = (path: string, route?: string) => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
      locals: {},
    }) as unknown as Response<unknown, HttpResponseLocals>;
    const req = {
      method: 'GET',
      path,
      requestId: 'request-123',
      route: route ? { path: route } : undefined,
    } as unknown as RequestWithContext;
    return { req, res };
  };

  it('records a matched route exactly once across finish and close', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const increment = jest.spyOn(httpRequestsTotal, 'inc');
    const decrement = jest.spyOn(httpRequestsInFlight, 'dec');
    const { req, res } = fixture(
      '/orders/sessions/123',
      '/orders/sessions/:id',
    );
    const next = jest.fn();
    httpLoggingMiddleware(req, res, next);
    res.emit('finish');
    res.emit('close');
    expect(next).toHaveBeenCalledTimes(1);
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/orders/sessions/:id' }),
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not record liveness probe traffic', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const increment = jest.spyOn(httpRequestsTotal, 'inc');
    const inFlight = jest.spyOn(httpRequestsInFlight, 'inc');
    const { req, res } = fixture('/api/v1/health/live', '/api/v1/health/live');
    httpLoggingMiddleware(req, res, jest.fn());
    res.emit('finish');
    expect(inFlight).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])(
    'records guard HTTP %i responses before interceptors',
    (statusCode) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const increment = jest.spyOn(httpRequestsTotal, 'inc');
      const { req, res } = fixture('/protected', '/protected');
      httpLoggingMiddleware(req, res, jest.fn());
      res.statusCode = statusCode;
      res.locals.httpError = { name: 'Denied', code: 'POLICY_DENIED' };
      res.emit('finish');
      expect(increment).toHaveBeenCalledWith(
        expect.objectContaining({ status_code: String(statusCode) }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode,
          error: { name: 'Denied', code: 'POLICY_DENIED' },
        }),
      );
    },
  );

  it('counts an actual Nest guard rejection in the HTTP pipeline', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const increment = jest.spyOn(httpRequestsTotal, 'inc');
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [RejectGuard],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.use(requestContextMiddleware);
    app.use(httpLoggingMiddleware);
    try {
      await app.init();
      await request(app.getHttpServer() as App)
        .get('/logging-probe')
        .expect(403);
      expect(increment).toHaveBeenCalledWith(
        expect.objectContaining({ status_code: '403' }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'http.request.failed',
          requestId: expect.any(String),
          statusCode: 403,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('records aborted connections once and never logs request credentials or query strings', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const increment = jest.spyOn(httpRequestsTotal, 'inc');
    const { req, res } = fixture('/payments/payos/return');
    req.originalUrl = '/payments/payos/return?token=private-capability';
    req.headers = { authorization: 'Bearer private-token' };
    req.body = { password: 'private-password' };
    Object.assign(res, { writableEnded: false });
    httpLoggingMiddleware(req, res, jest.fn());
    res.emit('close');
    res.emit('finish');
    expect(increment).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 499 }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
  });
});
