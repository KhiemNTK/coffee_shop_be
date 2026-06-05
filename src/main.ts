import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { LoggerModule } from './app/logger/logger.module';
import { Logger } from '@nestjs/common';
import { initApp } from './init';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: LoggerModule.createLogger(),
    bodyParser: false,
  });

  const {
    PORT = 3000,
    HOST = 'localhost',
    APP_PREFIX = '/api',
    APP_NAME = 'nestjs-app',
    NODE_ENV = 'development',
  } = process.env;

  initApp(app);
  await app.listen(PORT, HOST);
  const protocol = NODE_ENV === 'production' ? 'https' : 'http';
  Logger.log(
    `Service is running at ${protocol}://${HOST}:${PORT}${APP_PREFIX}`,
    APP_NAME,
  );
}
void bootstrap();
