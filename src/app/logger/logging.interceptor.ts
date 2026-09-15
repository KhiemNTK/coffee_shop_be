import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { catchError, Observable, throwError } from 'rxjs';
import type { EmployeeInfo } from '../../common/types';
import type { RequestWithContext } from '../../common/middlewares/request-context.middleware';

type LoggedRequest = RequestWithContext & { employee?: EmployeeInfo };

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<LoggedRequest>();
    const res = http.getResponse<Response>();
    const startedAt = performance.now();
    let failure: { name: string; code?: string } | undefined;

    res.once('finish', () => {
      const logContext = {
        event: failure ? 'http.request.failed' : 'http.request.completed',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        employeeId: req.employee?.employeeId,
        ...(failure ? { error: failure } : {}),
      };

      if (failure) {
        this.logger.error(logContext);
      } else {
        this.logger.log(logContext);
      }
    });

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
}
