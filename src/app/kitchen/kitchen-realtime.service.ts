import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type MessageEvent,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { interval, map, merge, Observable, Subject } from 'rxjs';
import type { KitchenRealtimeEvent } from '../../common/types';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { ORDER_EVENTS } from '../orders/events/order.events';

const CHANNEL = 'coffee-shop:kitchen-events';
const HEARTBEAT_MS = 15_000;
const KITCHEN_EVENT_NAMES = [
  ORDER_EVENTS.ITEMS_ADDED,
  ORDER_EVENTS.ITEM_STATUS_UPDATED,
  ORDER_EVENTS.SESSION_CANCELLED,
  ORDER_EVENTS.SESSION_TABLE_TRANSFERRED,
  ORDER_EVENTS.SESSIONS_MERGED,
  ORDER_EVENTS.SESSION_SPLIT,
  ORDER_EVENTS.TABLE_CLEARED,
] as const;

@Injectable()
export class KitchenRealtimeService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(KitchenRealtimeService.name);
  private readonly events = new Subject<KitchenRealtimeEvent>();
  private readonly publisher?: Redis;
  private readonly subscriber?: Redis;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    config: ConfigService,
    private readonly eventBus: DomainEventBusService,
  ) {
    const redisUrl = config.get<string>('REDIS_URL');
    if (!redisUrl) return;
    const options = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    } as const;
    this.publisher = new Redis(redisUrl, options);
    this.subscriber = new Redis(redisUrl, options);
  }

  onModuleInit() {
    for (const eventName of KITCHEN_EVENT_NAMES) {
      this.unsubscribe.push(
        this.eventBus.on(eventName, (payload) =>
          this.publishRefresh(eventName, payload),
        ),
      );
    }
  }

  async onApplicationBootstrap() {
    if (!this.publisher || !this.subscriber) return;

    this.subscriber.on('message', (_channel, message) => {
      try {
        this.events.next(JSON.parse(message) as KitchenRealtimeEvent);
      } catch {
        this.logger.warn('Ignored malformed kitchen realtime message.');
      }
    });
    this.subscriber.on('ready', () => {
      void this.subscriber?.subscribe(CHANNEL).catch((error) => {
        this.logger.warn(
          `Kitchen realtime subscribe failed: ${this.errorMessage(error)}`,
        );
      });
    });
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    } catch (error) {
      this.logger.warn(
        `Kitchen realtime Redis unavailable: ${this.errorMessage(error)}`,
      );
    }
  }

  onModuleDestroy() {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
    this.events.complete();
  }

  stream(): Observable<MessageEvent> {
    return merge(
      this.events.pipe(
        map((event) => ({
          type: 'kitchen.refresh',
          id: event.eventId,
          retry: 5_000,
          data: event,
        })),
      ),
      interval(HEARTBEAT_MS).pipe(
        map(() => ({
          type: 'heartbeat',
          data: { occurredAt: new Date().toISOString() },
        })),
      ),
    );
  }

  private async publishRefresh(eventName: string, payload: unknown) {
    const source = this.objectPayload(payload);
    const event: KitchenRealtimeEvent = {
      eventId:
        typeof source.eventId === 'string' ? source.eventId : randomUUID(),
      eventName,
      occurredAt:
        typeof source.occurredAt === 'string'
          ? source.occurredAt
          : new Date().toISOString(),
    };

    if (this.publisher?.status === 'ready') {
      try {
        await this.publisher.publish(CHANNEL, JSON.stringify(event));
        return;
      } catch (error) {
        this.logger.warn(
          `Kitchen realtime publish failed: ${this.errorMessage(error)}`,
        );
      }
    }
    this.events.next(event);
  }

  private objectPayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
