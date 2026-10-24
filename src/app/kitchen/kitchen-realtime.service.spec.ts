import { Controller, Sse, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { get, type ClientRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  kitchenSseActiveConnections,
  metricsRegistry,
} from '../../common/observability/metrics';
import { ORDER_EVENTS } from '../orders/events/order.events';
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
  beforeEach(() => kitchenSseActiveConnections.set(0));
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
      expect(jest.getTimerCount()).toBe(4);
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
      expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(1);
      await Promise.race([
        app.close(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('SSE prevented graceful shutdown')),
            7_000,
          );
        }),
      ]);
      expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(0);
    } finally {
      if (deadline) clearTimeout(deadline);
      client?.destroy();
      await app?.close();
    }
  }, 10_000);

  it('counts actual subscriptions, handles duplicate unsubscribe and late shutdown subscriptions', async () => {
    const service = createService();
    const stream = service.stream();
    expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(0);
    const first = stream.subscribe();
    const second = stream.subscribe();
    expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(2);
    first.unsubscribe();
    first.unsubscribe();
    expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(1);
    service.onModuleDestroy();
    second.unsubscribe();
    service.stream().subscribe();
    expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(0);
    expect(await metricsRegistry.metrics()).toContain(
      'coffee_shop_kitchen_sse_active_connections',
    );
  });

  it('carries only validated station release snapshots and keeps legacy refreshes usable', async () => {
    const bus = new DomainEventBusService();
    const service = new KitchenRealtimeService(new ConfigService(), bus);
    const receive = jest.fn();
    service.onModuleInit();
    const subscription = service.stream().subscribe((message) => {
      if (message.type === 'kitchen.refresh') receive(message);
    });
    const stationId = randomUUID();
    const availableAt = new Date().toISOString();
    try {
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {
        eventId: randomUUID(),
        newTickets: [
          { stationId, availableAt, privateNote: 'must not leave the server' },
        ],
      });
      expect(receive.mock.calls[0][0].data.newTickets).toEqual([
        { stationId, availableAt },
      ]);
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {
        newTickets: [{ stationId: 'invalid', availableAt }],
      });
      expect(receive.mock.calls[1][0].data).not.toHaveProperty('newTickets');
      await bus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        newTickets: [{ stationId, availableAt }],
      });
      expect(receive.mock.calls[2][0].data).not.toHaveProperty('newTickets');
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {});
      expect(receive).toHaveBeenCalledTimes(4);
    } finally {
      subscription.unsubscribe();
      service.onModuleDestroy();
    }
  });

  it('renews every stream within one minute and stops forwarding events until guards run again', async () => {
    jest.useFakeTimers();
    const bus = new DomainEventBusService();
    const service = new KitchenRealtimeService(new ConfigService(), bus);
    service.onModuleInit();
    const receive = jest.fn();
    const complete = jest.fn();
    try {
      service.stream().subscribe({ next: receive, complete });
      await jest.advanceTimersByTimeAsync(59_999);
      expect(complete).not.toHaveBeenCalled();
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {});
      expect(receive.mock.lastCall?.[0].type).toBe('kitchen.refresh');
      await jest.advanceTimersByTimeAsync(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(receive.mock.lastCall?.[0].type).toBe('kitchen.renew');
      expect((await kitchenSseActiveConnections.get()).values[0].value).toBe(0);
      const count = receive.mock.calls.length;
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {});
      expect(receive).toHaveBeenCalledTimes(count);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('bounds Redis publish and subscribe commands without opening a connection', () => {
    const service = new KitchenRealtimeService(
      new ConfigService({ REDIS_URL: 'redis://127.0.0.1:6379' }),
      new DomainEventBusService(),
    );
    try {
      for (const key of ['publisher', 'subscriber']) {
        const redis = Reflect.get(service, key) as Redis;
        expect(redis.status).toBe('wait');
        expect(redis.options).toMatchObject({
          connectTimeout: 1_000,
          commandTimeout: 2_000,
          enableOfflineQueue: false,
        });
      }
    } finally {
      service.onModuleDestroy();
    }
  });

  it('delivers local refreshes while the subscriber is down and deduplicates its Redis echo', async () => {
    const bus = new DomainEventBusService();
    const service = new KitchenRealtimeService(new ConfigService(), bus);
    const publisher = {
      status: 'ready',
      publish: jest.fn().mockResolvedValue(0),
      disconnect: jest.fn(),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
    };
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const subscriber = {
      status: 'ready',
      subscribe: jest.fn().mockResolvedValue(1),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      on: jest.fn((name: string, handler: (...args: unknown[]) => void) =>
        handlers.set(name, handler),
      ),
    };
    Reflect.set(service, 'publisher', publisher);
    Reflect.set(service, 'subscriber', subscriber);
    const receive = jest.fn();
    service.onModuleInit();
    await service.onApplicationBootstrap();
    const subscription = service.stream().subscribe(receive);
    try {
      await bus.publish(ORDER_EVENTS.ITEMS_ADDED, {});
      const message = receive.mock.calls.find(
        ([message]) => message.type === 'kitchen.refresh',
      )![0];
      expect(message).toBeDefined();
      expect(receive.mock.lastCall?.[0]).toMatchObject({
        type: 'kitchen.connection',
        data: { realtime: false },
      });
      handlers.get('message')!('channel', JSON.stringify(message.data));
      expect(
        receive.mock.calls.filter(
          ([message]) => message.type === 'kitchen.refresh',
        ),
      ).toHaveLength(1);
      handlers.get('ready')!();
      await Promise.resolve();
      expect(receive.mock.lastCall?.[0]).toMatchObject({
        type: 'kitchen.connection',
        data: { realtime: true },
      });
      handlers.get('close')!();
      expect(receive.mock.lastCall?.[0]).toMatchObject({
        type: 'kitchen.connection',
        data: { realtime: false },
      });
    } finally {
      subscription.unsubscribe();
      service.onModuleDestroy();
    }
  });
});
