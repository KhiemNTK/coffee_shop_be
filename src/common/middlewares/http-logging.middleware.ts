import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedStaffRequest, HttpResponseLocals } from '../types';
import type { RequestWithContext } from './request-context.middleware';
import {
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpRequestsTotal,
} from '../observability/metrics';

const logger = new Logger('HttpLogging');

export function httpLoggingMiddleware(
  req: RequestWithContext & AuthenticatedStaffRequest,
  res: Response<unknown, HttpResponseLocals>,
  next: NextFunction,
) {
  const startedAt = performance.now();
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  const ignoredRequest =
    req.path === '/metrics' || req.path.endsWith('/health/live');
  let completed = false;
  if (!ignoredRequest) httpRequestsInFlight.inc();

  const completeRequest = (connectionClosed: boolean) => {
    if (completed) return;
    completed = true;
    const durationSeconds = (performance.now() - startedAt) / 1000;
    const matchedRoute = req.route as { path?: unknown } | undefined;
    const routePath = matchedRoute?.path;
    const route = typeof routePath === 'string' ? routePath : 'unmatched';
    const clientAborted = connectionClosed && !res.writableEnded;
    const statusCode = clientAborted ? 499 : res.statusCode;
    const failure = clientAborted
      ? { name: 'ClientAbort', code: 'HTTP_499' }
      : (res.locals.httpError ??
        (statusCode >= 400
          ? { name: 'HttpError', code: `HTTP_${statusCode}` }
          : undefined));

    if (!ignoredRequest) {
      httpRequestsInFlight.dec();
      const labels = {
        method: req.method,
        route,
        status_code: String(statusCode),
      };
      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
    }

    const logContext = {
      event: failure ? 'http.request.failed' : 'http.request.completed',
      requestId: req.requestId,
      traceId,
      method: req.method,
      path: req.path,
      route,
      statusCode,
      durationMs: Math.round(durationSeconds * 100_000) / 100,
      employeeId: req.employee?.employeeId,
      ...(failure ? { error: failure } : {}),
    };
    if (statusCode >= 500) logger.error(logContext);
    else if (failure) logger.warn(logContext);
    else if (!ignoredRequest) logger.log(logContext);
  };

  res.once('finish', () => completeRequest(false));
  res.once('close', () => completeRequest(true));
  next();
}
