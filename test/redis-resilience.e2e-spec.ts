import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { KitchenRealtimeService } from '../src/app/kitchen/kitchen-realtime.service';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { ORDER_EVENTS } from '../src/app/orders/events/order.events';
import { HealthService } from '../src/app/health/health.service';

describe('Redis resilience (isolated Redis)', () => {
  const config = new ConfigService({
    NODE_ENV: 'test',
    REDIS_URL: process.env.REDIS_URL,
  });
  beforeAll(() => {
    const url = new URL(process.env.REDIS_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        (Number(url.port || 6379) !== 6379 || url.pathname === '/14'),
      'Use only an isolated loopback Redis on a non-default port or CI /14 database.',
    );
  });

  it('reads Redis readiness and memory with a dedicated health connection', async () => {
    const health = new HealthService(
      { $queryRaw: jest.fn().mockResolvedValue([]) } as never,
      config,
    );
    try {
      expect(await health.redisStatus()).toBe('up');
      expect((await health.readiness()).dependencies.redis).toBe('up');
      const memory = await health.redisMemory();
      expect(memory.used).toBeGreaterThan(0);
      expect(memory.limit).toBeGreaterThanOrEqual(0);
    } finally {
      health.onModuleDestroy();
    }
  });

  it('deduplicates Pub/Sub echo, signals subscriber loss and resumes remote refresh after reconnect', async () => {
    const firstBus = new DomainEventBusService();
    const secondBus = new DomainEventBusService();
    const first = new KitchenRealtimeService(config, firstBus);
    const second = new KitchenRealtimeService(config, secondBus);
    const firstMessages: MessageEvent[] = [];
    const secondMessages: MessageEvent[] = [];
    const one = first
      .stream()
      .subscribe((message) => firstMessages.push(message));
    const two = second
      .stream()
      .subscribe((message) => secondMessages.push(message));
    const relayState = () =>
      secondMessages
        .filter((message) => message.type === 'kitchen.connection')
        .at(-1)?.data;
    const refreshes = (messages: MessageEvent[], id: string) =>
      messages.filter(
        (message) => message.type === 'kitchen.refresh' && message.id === id,
      );
    async function until(check: () => boolean) {
      for (let index = 0; index < 100; index++) {
        if (check()) return;
        await sleep(20);
      }
      throw new Error('Redis realtime condition was not reached');
    }
    try {
      first.onModuleInit();
      second.onModuleInit();
      await first.onApplicationBootstrap();
      await second.onApplicationBootstrap();
      await until(
        () => (relayState() as { realtime: boolean })?.realtime === true,
      );
      const id = randomUUID();
      await firstBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, { eventId: id });
      await until(() => refreshes(secondMessages, id).length === 1);
      await sleep(50);
      expect(refreshes(firstMessages, id)).toHaveLength(1);
      const subscriber = Reflect.get(second, 'subscriber') as Redis;
      subscriber.disconnect();
      await until(
        () => (relayState() as { realtime: boolean })?.realtime === false,
      );
      const localId = randomUUID();
      await secondBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        eventId: localId,
      });
      expect(refreshes(secondMessages, localId)).toHaveLength(1);
      await subscriber.connect();
      await until(
        () => (relayState() as { realtime: boolean })?.realtime === true,
      );
      const recoveredId = randomUUID();
      await firstBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        eventId: recoveredId,
      });
      await until(() => refreshes(secondMessages, recoveredId).length === 1);
      expect(refreshes(firstMessages, recoveredId)).toHaveLength(1);
    } finally {
      one.unsubscribe();
      two.unsubscribe();
      first.onModuleDestroy();
      second.onModuleDestroy();
    }
  });
});
