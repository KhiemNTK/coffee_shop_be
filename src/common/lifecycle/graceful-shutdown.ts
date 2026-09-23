import { Logger, type INestApplication } from '@nestjs/common';

interface ShutdownLogger {
  log(message: unknown): void;
  error(message: unknown): void;
}

export interface GracefulShutdownOptions {
  timeoutMs: number;
  cleanup?: () => Promise<void>;
  exit?: (code: number) => void;
  logger?: ShutdownLogger;
}

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export function createGracefulShutdownHandler(
  app: Pick<INestApplication, 'close'>,
  options: GracefulShutdownOptions,
) {
  const logger = options.logger ?? new Logger('GracefulShutdown');
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | undefined;

  return (signal: ShutdownSignal): Promise<void> => {
    shutdownPromise ??= runShutdown(app, signal, options, logger, exit);
    return shutdownPromise;
  };
}

export function registerGracefulShutdown(
  app: Pick<INestApplication, 'close'>,
  options: GracefulShutdownOptions,
) {
  const shutdown = createGracefulShutdownHandler(app, options);
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

async function runShutdown(
  app: Pick<INestApplication, 'close'>,
  signal: ShutdownSignal,
  options: GracefulShutdownOptions,
  logger: ShutdownLogger,
  exit: (code: number) => void,
) {
  logger.log({ event: 'application.shutdown.started', signal });
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      closeResources(app, options.cleanup),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Graceful shutdown timed out')),
          options.timeoutMs,
        );
      }),
    ]);
    logger.log({ event: 'application.shutdown.completed', signal });
  } catch (error) {
    logger.error({
      event: 'application.shutdown.failed',
      signal,
      error: error instanceof Error ? error.message : String(error),
    });
    exit(1);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeResources(
  app: Pick<INestApplication, 'close'>,
  cleanup?: () => Promise<void>,
) {
  let closeError: unknown;
  try {
    await app.close();
  } catch (error) {
    closeError = error;
  }

  try {
    await cleanup?.();
  } catch (error) {
    closeError ??= error;
  }

  if (closeError) {
    throw closeError instanceof Error
      ? closeError
      : new Error('Resource shutdown failed', { cause: closeError });
  }
}
