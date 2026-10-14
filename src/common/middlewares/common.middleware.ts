import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestContextMiddleware } from './request-context.middleware';
import { httpLocaleMiddleware } from '../i18n/http-locale';
import { httpLoggingMiddleware } from './http-logging.middleware';

export const applyMiddlewares = (app: INestApplication) => {
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  app.use(httpLoggingMiddleware);
  app.use(httpLocaleMiddleware);
};
