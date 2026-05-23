import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { LoggerModule } from './app/logger/logger.module';
import { Logger } from '@nestjs/common';
import { applyMiddlewares } from './common/middlewares/common.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: LoggerModule.createLogger(),
  });

  const {
    PORT = 3000,
    HOST = 'localhost',
    APP_PREFIX = '/api',
    APP_NAME = 'nestjs-app',
    NODE_ENV = 'development',
  } = process.env;

  applyMiddlewares(app);
  await app.listen(PORT, HOST);
  const protocol = NODE_ENV === 'production' ? 'https' : 'http';
  Logger.log(
    `Service is running at ${protocol}://${HOST}:${PORT}${APP_PREFIX}`,
    APP_NAME,
  );
}
void bootstrap();
