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
import { z } from 'zod';
import {
  defer,
  BehaviorSubject,
  finalize,
  interval,
  map,
  merge,
  Observable,
  ReplaySubject,
  Subject,
  takeUntil,
  takeWhile,
  timer,
} from 'rxjs';
import type { KitchenRealtimeEvent } from '../../common/types';
import { kitchenSseActiveConnections } from '../../common/observability/metrics';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { ORDER_EVENTS } from '../orders/events/order.events';

const CHANNEL = 'coffee-shop:kitchen-events';
const HEARTBEAT_MS = 15_000;
const STREAM_LIFETIME_MS = 60_000;
const NewTicketsSchema = z
  .array(
    z.object({
      stationId: z.uuid(),
      availableAt: z.iso.datetime({ offset: true }),
    }),
  )
  .max(100);
const RealtimeEventSchema = z.object({
  eventId: z.uuid(),
  eventName: z.string().min(1).max(100),
  occurredAt: z.iso.datetime({ offset: true }),
  newTickets: NewTicketsSchema.optional().catch(undefined),
});
const KITCHEN_EVENT_NAMES = [
  ORDER_EVENTS.ITEMS_ADDED,
  ORDER_EVENTS.ITEM_STATUS_UPDATED,
  ORDER_EVENTS.SESSION_CANCELLED,
  ORDER_EVENTS.SESSION_COMPLETED,
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
  private readonly relayReady = new BehaviorSubject(true);
  private readonly seenEvents = new Set<string>();
  private subscribed = false;
  private readonly shutdown = new ReplaySubject<void>(1);
  private readonly publisher?: Redis;
  private readonly subscriber?: Redis;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    config: ConfigService,
    private readonly eventBus: DomainEventBusService,
  ) {
    const redisUrl = config.get<string>('REDIS_URL');
    if (!redisUrl) return;
    this.relayReady.next(false);
    const options = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      commandTimeout: 2_000,
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
        this.emitRefresh(RealtimeEventSchema.parse(JSON.parse(message)));
      } catch {
        this.logger.warn('Ignored malformed kitchen realtime message.');
      }
    });
    this.subscriber.on('ready', () => {
      this.subscribed = false;
      this.updateRelayStatus();
      void this.subscriber
        ?.subscribe(CHANNEL)
        .then(() => {
          this.subscribed = this.subscriber?.status === 'ready';
          this.updateRelayStatus();
        })
        .catch((error) => {
          this.logger.warn(
            `Kitchen realtime subscribe failed: ${this.errorMessage(error)}`,
          );
        });
    });
    for (const event of ['close', 'end', 'error']) {
      this.subscriber.on(event, () => {
        this.subscribed = false;
        this.updateRelayStatus();
      });
      this.publisher.on(event, () => this.setRelayStatus(false));
    }
    this.publisher.on('ready', () => this.updateRelayStatus());
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    } catch (error) {
      this.logger.warn(
        `Kitchen realtime Redis unavailable: ${this.errorMessage(error)}`,
      );
    }
  }

  onModuleDestroy() {
    this.shutdown.next();
    this.shutdown.complete();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
    this.relayReady.complete();
    this.seenEvents.clear();
    this.events.complete();
  }

  stream(): Observable<MessageEvent> {
    return defer(() => {
      kitchenSseActiveConnections.inc();
      return merge(
        this.relayReady.pipe(
          map((realtime) => ({
            type: 'kitchen.connection',
            data: { realtime },
          })),
        ),
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
            data: {
              occurredAt: new Date().toISOString(),
              realtime: this.relayReady.value,
            },
          })),
        ),
        timer(STREAM_LIFETIME_MS).pipe(
          map(() => ({ type: 'kitchen.renew', data: {} })),
        ),
      ).pipe(
        // Reopening the stream rechecks the session and permissions through the guards.
        takeWhile((event) => event.type !== 'kitchen.renew', true),
        takeUntil(this.shutdown),
        finalize(() => kitchenSseActiveConnections.dec()),
      );
    });
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
    if (eventName === ORDER_EVENTS.ITEMS_ADDED) {
      const tickets = NewTicketsSchema.safeParse(source.newTickets);
      if (tickets.success) event.newTickets = tickets.data;
    }

    this.emitRefresh(event);
    if (this.publisher?.status === 'ready') {
      try {
        await this.publisher.publish(CHANNEL, JSON.stringify(event));
        this.updateRelayStatus();
      } catch (error) {
        this.setRelayStatus(false);
        this.logger.warn(
          `Kitchen realtime publish failed: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private emitRefresh(event: KitchenRealtimeEvent) {
    if (this.seenEvents.has(event.eventId)) return;
    this.seenEvents.add(event.eventId);
    if (this.seenEvents.size > 500) {
      const oldest = this.seenEvents.values().next().value;
      if (typeof oldest === 'string') this.seenEvents.delete(oldest);
    }
    this.events.next(event);
  }

  private updateRelayStatus() {
    this.setRelayStatus(
      !this.publisher || (this.publisher.status === 'ready' && this.subscribed),
    );
  }

  private setRelayStatus(ready: boolean) {
    if (this.relayReady.value !== ready) this.relayReady.next(ready);
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
