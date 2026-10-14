import { Controller, Sse, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { get, type ClientRequest } from 'node:http';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { KitchenRealtimeService } from './kitchen-realtime.service';

@Controller('test-kitchen')
class StreamController {
  constructor(private readonly realtime: KitchenRealtimeService) {}

  @Sse('events')
  events() {
    return this.realtime.stream();
  }
}

describe('KitchenRealtimeService shutdown', () => {
  const createService = () =>
    new KitchenRealtimeService(
      { get: () => undefined } as unknown as ConfigService,
      new DomainEventBusService(),
    );

  it('ends active and late streams, including their heartbeat timers', () => {
    jest.useFakeTimers();
    const service = createService();
    const complete = jest.fn();
    try {
      service.stream().subscribe({ complete });
      service.stream().subscribe({ complete });
      expect(jest.getTimerCount()).toBe(2);
      service.onModuleDestroy();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
      service.stream().subscribe({ complete });
      expect(complete).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('closes the HTTP server while a kitchen SSE client remains connected', async () => {
    let app: INestApplication | undefined;
    let client: ClientRequest | undefined;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const module = await Test.createTestingModule({
        controllers: [StreamController],
        providers: [
          { provide: KitchenRealtimeService, useValue: createService() },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.listen(0, '127.0.0.1');
      const url = `${await app.getUrl()}/test-kitchen/events`;
      await new Promise<void>((resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('SSE did not open')),
          2_000,
        );
        client = get(url, (response) => {
          response.resume();
          clearTimeout(deadline);
          resolve();
        });
        client.on('error', reject);
      });
      await Promise.race([
        app.close(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('SSE prevented graceful shutdown')),
            7_000,
          );
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      client?.destroy();
      await app?.close();
    }
  }, 10_000);
});
