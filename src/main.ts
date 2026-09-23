import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { LoggerModule } from './app/logger/logger.module';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initApp } from './init';
import { NestExpressApplication } from '@nestjs/platform-express';
import { registerGracefulShutdown } from './common/lifecycle/graceful-shutdown';

export async function bootstrap(cleanup?: () => Promise<void>) {
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
  const shutdownTimeoutMs = config.get<number>('SHUTDOWN_TIMEOUT_MS', 10_000);
  await app.listen(port, host);
  registerGracefulShutdown(app, {
    timeoutMs: shutdownTimeoutMs,
    cleanup,
  });
  const protocol = nodeEnvironment === 'production' ? 'https' : 'http';
  Logger.log(
    `Service is running at ${protocol}://${host}:${port}${appPrefix}`,
    appName,
  );
  return app;
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    Logger.error(
      error instanceof Error ? error.stack : String(error),
      'Bootstrap',
    );
    process.exitCode = 1;
  });
}
