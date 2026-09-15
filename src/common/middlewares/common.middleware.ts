import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestContextMiddleware } from './request-context.middleware';

export const applyMiddlewares = (app: INestApplication) => {
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestContextMiddleware);
};
