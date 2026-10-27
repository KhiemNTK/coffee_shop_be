import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { NextFunction, Response } from 'express';
import type { RequestWithContext } from '../middlewares/request-context.middleware';
import type { HttpResponseLocals } from '../types';
import { formatApiResponse } from '../utils/api-util/api-response';
import { resolveApiLocale } from '../i18n/http-locale';
import { localizeApiErrors } from '../i18n/error-messages';

export function registerHttpDrain(
  app: Pick<INestApplication, 'use' | 'getHttpServer'>,
) {
  let draining = false;
  let pending: Promise<void> | undefined;
  app.use(
    (
      request: RequestWithContext,
      response: Response<unknown, HttpResponseLocals>,
      next: NextFunction,
    ) => {
      if (!draining) {
        response.once('finish', () => {
          // A request active at server.close() can become an idle keep-alive later.
          if (draining) (app.getHttpServer() as Server).closeIdleConnections();
        });
        return next();
      }
      response.locals.httpError = {
        name: 'ServiceUnavailableException',
        code: 'SERVICE_DRAINING',
      };
      response.setHeader('Connection', 'close');
      response.setHeader('Retry-After', '1');
      response.status(503).json(
        formatApiResponse({
          code: 'SERVICE_DRAINING',
          requestId: request.requestId,
          errors: localizeApiErrors(
            [{ message: 'Service is restarting. Please retry shortly.' }],
            resolveApiLocale(request),
            'SERVICE_DRAINING',
          ),
        }),
      );
    },
  );

  return () => {
    draining = true;
    pending ??= new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer() as Server;
      server.close((error?: NodeJS.ErrnoException) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    return pending;
  };
}
