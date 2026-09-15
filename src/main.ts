import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { LoggerModule } from './app/logger/logger.module';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initApp } from './init';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: LoggerModule.createLogger(),
    bodyParser: false,
  });

  initApp(app);
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);
  const host = config.get<string>('HOST', '0.0.0.0');
  const appPrefix = config.get<string>('APP_PREFIX', '/api/v1');
  const appName = config.get<string>('APP_NAME', 'coffee_shop_be');
  const nodeEnvironment = config.get<string>('NODE_ENV', 'development');
  await app.listen(port, host);
  const protocol = nodeEnvironment === 'production' ? 'https' : 'http';
  Logger.log(
    `Service is running at ${protocol}://${host}:${port}${appPrefix}`,
    appName,
  );
}
void bootstrap();
