import { EventEmitter } from 'node:events';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { firstValueFrom, of } from 'rxjs';
import {
  httpRequestsInFlight,
  httpRequestsTotal,
} from '../../common/observability/metrics';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor', () => {
  afterEach(() => jest.restoreAllMocks());

  const createRequest = (path: string, route?: string) => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
    });
    const request = {
      method: 'GET',
      path,
      requestId: 'request-123',
      route: route ? { path: route } : undefined,
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;

    return { context, response: response as unknown as Response };
  };

  it('records a matched route once when both finish and close fire', async () => {
    const interceptor = new LoggingInterceptor();
    const logger = { log: jest.fn(), error: jest.fn() };
    Object.assign(interceptor, { logger });
    const inFlightIncrement = jest.spyOn(httpRequestsInFlight, 'inc');
    const requestIncrement = jest.spyOn(httpRequestsTotal, 'inc');
    const { context, response } = createRequest(
      '/api/v1/orders/sessions/123',
      '/api/v1/orders/sessions/:id',
    );

    await firstValueFrom(
      interceptor.intercept(context, {
        handle: () => of({ ok: true }),
      } as CallHandler),
    );
    response.emit('finish');
    response.emit('close');

    expect(inFlightIncrement).toHaveBeenCalledTimes(1);
    expect(requestIncrement).toHaveBeenCalledTimes(1);
    expect(requestIncrement).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/api/v1/orders/sessions/:id' }),
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('does not record liveness probe traffic', async () => {
    const interceptor = new LoggingInterceptor();
    const logger = { log: jest.fn(), error: jest.fn() };
    Object.assign(interceptor, { logger });
    const inFlightIncrement = jest.spyOn(httpRequestsInFlight, 'inc');
    const requestIncrement = jest.spyOn(httpRequestsTotal, 'inc');
    const { context, response } = createRequest(
      '/api/v1/health/live',
      '/api/v1/health/live',
    );

    await firstValueFrom(
      interceptor.intercept(context, {
        handle: () => of({ status: 'ok' }),
      } as CallHandler),
    );
    response.emit('finish');

    expect(inFlightIncrement).not.toHaveBeenCalled();
    expect(requestIncrement).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });
});
