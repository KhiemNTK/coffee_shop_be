import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { catchError, Observable, throwError } from 'rxjs';
import { trace } from '@opentelemetry/api';
import type { EmployeeInfo } from '../../common/types';
import type { RequestWithContext } from '../../common/middlewares/request-context.middleware';
import {
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpRequestsTotal,
} from '../../common/observability/metrics';

type LoggedRequest = RequestWithContext & { employee?: EmployeeInfo };

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<LoggedRequest>();
    const res = http.getResponse<Response>();
    const startedAt = performance.now();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const ignoredRequest =
      req.path === '/metrics' || req.path.endsWith('/health/live');
    let completed = false;
    let failure: { name: string; code?: string } | undefined;

    if (!ignoredRequest) httpRequestsInFlight.inc();

    const completeRequest = (connectionClosed: boolean) => {
      if (completed) return;
      completed = true;
      const durationSeconds = (performance.now() - startedAt) / 1000;
      const route = this.routeLabel(req);
      const clientAborted = connectionClosed && !res.writableEnded;
      const requestFailed = Boolean(failure) || clientAborted;
      const statusCode = clientAborted ? '499' : String(res.statusCode);

      if (!ignoredRequest) {
        httpRequestsInFlight.dec();
        httpRequestsTotal.inc({
          method: req.method,
          route,
          status_code: statusCode,
        });
        httpRequestDurationSeconds.observe(
          { method: req.method, route, status_code: statusCode },
          durationSeconds,
        );
      }

      const logContext = {
        event: requestFailed ? 'http.request.failed' : 'http.request.completed',
        requestId: req.requestId,
        traceId,
        method: req.method,
        path: req.path,
        route,
        statusCode: Number(statusCode),
        durationMs: Math.round(durationSeconds * 100_000) / 100,
        employeeId: req.employee?.employeeId,
        ...(failure
          ? { error: failure }
          : clientAborted
            ? { error: { name: 'ClientAbort' } }
            : {}),
      };

      if (requestFailed) {
        this.logger.error(logContext);
      } else if (!ignoredRequest) {
        this.logger.log(logContext);
      }
    };

    res.once('finish', () => completeRequest(false));
    res.once('close', () => completeRequest(true));

    return next.handle().pipe(
      catchError((error: unknown) => {
        failure = {
          name: error instanceof Error ? error.name : 'UnknownError',
          code: this.getErrorCode(error),
        };
        return throwError(() => error);
      }),
    );
  }

  private getErrorCode(error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }
    return undefined;
  }

  private routeLabel(request: LoggedRequest) {
    const routePath = (request.route as { path?: unknown } | undefined)?.path;
    if (typeof routePath === 'string') return routePath;
    return 'unmatched';
  }
}
