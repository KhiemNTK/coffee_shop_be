import { WinstonModule } from 'nest-winston';
import { LoggerModule } from './logger.module';
import { runWithRequestContext } from '../../common/request-context';

describe('LoggerModule request correlation', () => {
  it.each([undefined, 'warn', 'debug'])(
    'uses log level %s with a console transport',
    (level) => {
      const previous = process.env.LOG_LEVEL;
      if (level === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = level;
      const create = jest
        .spyOn(WinstonModule, 'createLogger')
        .mockReturnValue({} as never);
      try {
        LoggerModule.createLogger();
        expect(create.mock.calls[0][0].level).toBe(level ?? 'info');
      } finally {
        if (previous === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = previous;
        create.mockRestore();
      }
    },
  );

  it('rejects unsupported levels even before Nest configuration is available', () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'trace';
    try {
      expect(() => LoggerModule.createLogger()).toThrow(
        'LOG_LEVEL must be one of',
      );
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  it('adds worker context to JSON logs and still redacts credentials', () => {
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const create = jest
      .spyOn(WinstonModule, 'createLogger')
      .mockReturnValue({} as never);
    try {
      LoggerModule.createLogger();
      const transports = create.mock.calls[0][0].transports;
      const transport = Array.isArray(transports) ? transports[0] : transports;
      const formatted = runWithRequestContext(
        {
          requestId: 'request-12345678',
          employeeId: 'actor-id',
          outboxEventId: 'event-id',
          eventName: 'order.invoice.paid',
        },
        () =>
          transport!.format!.transform(
            {
              level: 'error',
              message: 'Delivery failed',
              password: 'never-log',
              payload: { token: 'never-log' },
            },
            {},
          ),
      );
      const output = JSON.parse(
        String((formatted as Record<symbol, unknown>)[Symbol.for('message')]),
      ) as Record<string, unknown>;
      expect(output).toMatchObject({
        requestId: 'request-12345678',
        employeeId: 'actor-id',
        outboxEventId: 'event-id',
        password: '[REDACTED]',
        payload: { token: '[REDACTED]' },
      });
      expect(JSON.stringify(output)).not.toContain('never-log');
    } finally {
      if (environment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = environment;
      create.mockRestore();
    }
  });
});
