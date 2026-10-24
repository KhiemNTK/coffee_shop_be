import { createGracefulShutdownHandler } from './graceful-shutdown';

describe('createGracefulShutdownHandler', () => {
  it('closes the application and cleanup exactly once', async () => {
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const logger = { log: jest.fn(), error: jest.fn() };
    const shutdown = createGracefulShutdownHandler(app, {
      timeoutMs: 1_000,
      cleanup,
      logger,
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('joins background workers before destroying consumer modules, within the same shutdown deadline', async () => {
    let stopped!: () => void;
    const beforeClose = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    );
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdownHandler(app, {
      timeoutMs: 1_000,
      beforeClose,
      cleanup,
      logger: { log: jest.fn(), error: jest.fn() },
    });
    const result = shutdown('SIGTERM');
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(app.close).not.toHaveBeenCalled();
    stopped();
    await result;
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('still closes the application and reports failure if stopping a worker fails', async () => {
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const exit = jest.fn();
    const shutdown = createGracefulShutdownHandler(app, {
      timeoutMs: 1_000,
      beforeClose: jest.fn().mockRejectedValue(new Error('worker stop failed')),
      cleanup,
      exit,
      logger: { log: jest.fn(), error: jest.fn() },
    });
    await shutdown('SIGTERM');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uses the failure exit code when shutdown exceeds its deadline', async () => {
    jest.useFakeTimers();
    const app = { close: jest.fn(() => new Promise<void>(() => undefined)) };
    const exit = jest.fn();
    const logger = { log: jest.fn(), error: jest.fn() };
    const shutdown = createGracefulShutdownHandler(app, {
      timeoutMs: 1_000,
      exit,
      logger,
    });

    const result = shutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(1_000);
    await result;

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('still flushes telemetry when application close fails', async () => {
    const app = {
      close: jest.fn().mockRejectedValue(new Error('close failed')),
    };
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const exit = jest.fn();
    const logger = { log: jest.fn(), error: jest.fn() };
    const shutdown = createGracefulShutdownHandler(app, {
      timeoutMs: 1_000,
      cleanup,
      exit,
      logger,
    });

    await shutdown('SIGTERM');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
