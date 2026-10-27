import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { get } from 'node:http';
import { registerHttpDrain } from './http-drain';
import { createGracefulShutdownHandler } from './graceful-shutdown';

describe('HTTP draining boundary', () => {
  it('rejects late requests with localized support context and closes the listener only once', async () => {
    const use = jest.fn();
    let finish!: () => void;
    const server = {
      close: jest.fn((callback) => {
        finish = callback;
      }),
    };
    const drain = registerHttpDrain({
      use,
      getHttpServer: () => server,
    } as never);
    const middleware = use.mock.calls[0][0] as (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => void;
    const next = jest.fn();
    const req = { requestId: 'drain-request-id', acceptsLanguages: () => 'vi' };
    const res = {
      locals: {},
      setHeader: jest.fn(),
      once: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const pending = drain();
    expect(drain()).toBe(pending);
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SERVICE_DRAINING',
        requestId: 'drain-request-id',
        errors: [
          {
            message:
              'Dịch vụ đang khởi động lại. Vui lòng thử lại sau ít giây.',
          },
        ],
      }),
    );
    expect(server.close).toHaveBeenCalledTimes(1);
    finish();
    await pending;
  });

  it('propagates drain failures but accepts an already closed listener', async () => {
    for (const code of ['ERR_SERVER_NOT_RUNNING', 'EIO']) {
      const error = Object.assign(new Error(code), { code });
      const server = {
        close: (callback: (error: Error) => void) => callback(error),
      };
      const drain = registerHttpDrain({
        use: () => undefined,
        getHttpServer: () => server,
      } as never);
      if (code === 'ERR_SERVER_NOT_RUNNING')
        await expect(drain()).resolves.toBeUndefined();
      else await expect(drain()).rejects.toBe(error);
    }
  });

  it('finishes an actual in-flight HTTP command before stopping workers or destroying dependencies', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const order: string[] = [];
    const resource = {
      closed: false,
      onModuleDestroy() {
        this.closed = true;
        order.push('destroy');
      },
    };
    @Controller('drain-probe')
    class ProbeController {
      @Get()
      async command() {
        entered.resolve();
        await resume.promise;
        if (resource.closed) throw new ServiceUnavailableException();
        order.push('commit');
        return { committed: true };
      }
    }
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: 'fixture-resource', useValue: resource }],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    const drain = registerHttpDrain(app);
    let stopping: Promise<void> | undefined;
    let client: ReturnType<typeof get> | undefined;
    try {
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      const response = new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          client = get(`${url}/drain-probe`, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
            res.on('error', reject);
          });
          client.on('error', reject);
        },
      );
      await entered.promise;
      stopping = createGracefulShutdownHandler(app, {
        timeoutMs: 2000,
        beforeClose: async () => {
          await drain();
          order.push('worker');
        },
        logger: { log() {}, error() {} },
        exit(code) {
          throw new Error(`Unexpected exit: ${code}`);
        },
      })('SIGTERM');
      expect((app.getHttpServer() as Server).listening).toBe(false);
      expect(resource.closed).toBe(false);
      expect(order).toEqual([]);
      resume.resolve();
      expect(await response).toEqual({
        status: 200,
        body: '{"committed":true}',
      });
      await stopping;
      expect(order).toEqual(['commit', 'worker', 'destroy']);
    } finally {
      resume.resolve();
      client?.destroy();
      if (stopping) await stopping;
      else await app.close();
    }
  });
});
