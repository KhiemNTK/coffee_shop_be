import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus, Prisma } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ClaimedOutboxEvent } from '../../common/types';
import { outboxDispatchTotal } from '../../common/observability/metrics';
import { runWithRequestContext } from '../../common/request-context';
import { readOutboxContext } from './outbox-context';
import { DomainEventBusService } from './domain-event-bus.service';
import {
  OutboxDeferredError,
  OutboxPermanentError,
} from './outbox-delivery.error';

const QUEUE_NAME = 'domain-outbox';
const POLL_INTERVAL_MS = 1_000;
const LOCK_TIMEOUT_MS = 90_000;
const LEASE_RENEW_INTERVAL_MS = 20_000;
const RECOVERY_INTERVAL_MS = 15_000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const REDIS_COMMAND_TIMEOUT_MS = 2_000;
const REDIS_CLOSE_TIMEOUT_MS = 3_000;
const RETENTION_BATCH_SIZE = 500;
const DAY_MS = 86_400_000;

@Injectable()
export class OutboxDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private queue?: Queue<ClaimedOutboxEvent, void, 'publish'>;
  private worker?: Worker<ClaimedOutboxEvent, void, 'publish'>;
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private stopping = false;
  private lastHousekeepingAt = 0;
  private lastRecoveryAt = 0;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly config: ConfigService,
    private readonly eventBus: DomainEventBusService,
  ) {}

  async onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) this.startBullMq(redisUrl);

    const pollInterval = this.config.get<number>(
      'OUTBOX_POLL_INTERVAL_MS',
      POLL_INTERVAL_MS,
    );
    if (pollInterval > 0) {
      this.timer = setInterval(() => void this.drainOnce(), pollInterval);
      this.timer.unref();
      await this.drainOnce();
    }
  }

  onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdownPromise ??= this.closeResources();
    return this.shutdownPromise;
  }

  private async closeResources() {
    await this.drainPromise;
    await this.closeRedisResource('worker', this.worker);
    await this.closeRedisResource('queue', this.queue);
  }

  drainOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.drainPromise ??= this.dispatchBatch().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async dispatchBatch() {
    let events: ClaimedOutboxEvent[] = [];
    let nextIndex = 0;
    try {
      if (Date.now() - this.lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        await this.recoverAbandonedEvents();
        this.lastRecoveryAt = Date.now();
      }
      await this.runHousekeepingIfNeeded();
      if (this.stopping) return;
      events = await this.claimBatch();
      while (nextIndex < events.length && !this.stopping) {
        const event = events[nextIndex];
        if (this.queue) {
          const enqueued = await this.enqueue(event);
          nextIndex++;
          if (!enqueued) break;
        } else {
          await this.deliverWithoutRedis(event);
          nextIndex++;
        }
      }
    } catch (error) {
      this.logger.error(
        'Outbox dispatch cycle failed.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      const unqueued = events.slice(nextIndex);
      if (unqueued.length) {
        try {
          await this.prisma.outboxEvent.updateMany({
            where: {
              status: OutboxEventStatus.ENQUEUED,
              OR: unqueued.map(({ id, lockedBy }) => ({ id, lockedBy })),
            },
            data: {
              status: OutboxEventStatus.PENDING,
              lockedAt: null,
              lockedBy: null,
              availableAt: new Date(Date.now() + POLL_INTERVAL_MS),
              lastError: this.stopping
                ? 'Outbox dispatcher stopped before enqueue.'
                : 'Outbox dispatch batch interrupted.',
            },
          });
        } catch (error) {
          this.logger.error(
            'Outbox unqueued claims release failed.',
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    }
  }

  private async runHousekeepingIfNeeded() {
    if (Date.now() - this.lastHousekeepingAt < HOUSEKEEPING_INTERVAL_MS) return;

    const now = new Date();
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "BusinessInsight" WHERE "expiresAt" < ${now}
        ORDER BY "expiresAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "BusinessInsight" r USING candidates c WHERE r."id" = c."id"
    `);
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "IdempotencyRequest"
        WHERE "status" = 'COMPLETED' AND "expiresAt" < ${now}
          -- Stock and cashier commands have no other durable replay identity.
          AND "operation" NOT LIKE 'inventory.stock.%'
          AND "operation" NOT LIKE 'cashier-shift.%'
        ORDER BY "expiresAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "IdempotencyRequest" r USING candidates c WHERE r."id" = c."id"
    `);
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "OutboxEvent"
        WHERE "status" = 'PUBLISHED' AND "publishedAt" < ${new Date(now.getTime() - 30 * DAY_MS)}
        ORDER BY "publishedAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "OutboxEvent" e USING candidates c WHERE e."id" = c."id"
    `);
    // Keep every still-valid token plus a grace window for replay detection and investigation.
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "AuthSession" WHERE "expiresAt" < ${new Date(now.getTime() - 30 * DAY_MS)}
        ORDER BY "expiresAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "AuthSession" s USING candidates c WHERE s."id" = c."id"
    `);
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "PasswordResetToken" WHERE "expiresAt" < ${new Date(now.getTime() - 7 * DAY_MS)}
        ORDER BY "expiresAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "PasswordResetToken" t USING candidates c WHERE t."id" = c."id"
    `);
    await this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "CustomerSession" WHERE "expiresAt" < ${now}
        ORDER BY "expiresAt", "id" LIMIT ${RETENTION_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM "CustomerSession" s USING candidates c WHERE s."id" = c."id"
    `);
    this.lastHousekeepingAt = now.getTime();
  }

  private startBullMq(redisUrl: string) {
    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      connectTimeout: 1_000,
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.queue = new Queue<ClaimedOutboxEvent, void, 'publish'>(QUEUE_NAME, {
      connection: {
        ...connection,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      },
    });
    this.worker = new Worker<ClaimedOutboxEvent, void, 'publish'>(
      QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 10,
      },
    );
    this.queue.on('error', (error) => {
      this.logger.error({
        event: 'outbox.queue.error',
        error: error.message,
      });
    });
    this.worker.on('error', (error) => {
      this.logger.error({
        event: 'outbox.worker.error',
        error: error.message,
      });
    });
    this.worker.on('failed', (job, error) => {
      const metadata = readOutboxContext(job?.data.context);
      this.logger.warn({
        event: 'outbox.job.failed',
        outboxEventId: job?.data.id,
        requestId:
          metadata.requestId ?? (job ? `outbox:${job.data.id}` : undefined),
        traceId: metadata.traceId,
        error: this.errorMessage(error),
      });
    });
  }

  private async claimBatch() {
    return this.prisma.$queryRaw<ClaimedOutboxEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "status" = 'PENDING'
          AND "availableAt" <= CURRENT_TIMESTAMP
        ORDER BY "occurredAt", "id"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" event
      SET
        "status" = 'ENQUEUED',
        "lockedAt" = CURRENT_TIMESTAMP,
        "lockedBy" = ${randomUUID()}
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING
        event."id",
        event."topic",
        event."eventName",
        event."aggregateType",
        event."aggregateId",
        event."payload",
        event."context",
        event."attempts",
        event."lockedBy",
        event."occurredAt"
    `);
  }

  private async enqueue(event: ClaimedOutboxEvent) {
    try {
      await this.withTimeout(this.queue!.waitUntilReady());
      const existing = await this.withTimeout(this.queue!.getJob(event.id));
      if (existing) {
        const state = await this.withTimeout(existing.getState());
        if (state === 'failed' || state === 'completed') {
          await this.withTimeout(existing.updateData(event));
          await this.withTimeout(
            existing.retry(state, { resetAttemptsMade: true }),
          );
        } else if (state === 'active') {
          // An older job must finish before this lease can reuse its retained ID.
          await this.release(
            event,
            'Waiting for the previous delivery job to finish.',
          );
        }
        if (state !== 'unknown') return true;
      }
      await this.withTimeout(
        this.queue!.add('publish', event, {
          jobId: event.id,
          attempts: MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
        }),
      );
      return true;
    } catch (error) {
      outboxDispatchTotal.inc({ outcome: 'enqueue_failed' });
      await this.release(event, error);
      return false;
    }
  }

  private async processJob(job: Job<ClaimedOutboxEvent, void, 'publish'>) {
    await this.deliver(job.data.id, job);
  }

  private deliverWithoutRedis(event: ClaimedOutboxEvent) {
    return this.deliver(event.id);
  }

  private async deliver(
    id: string,
    job?: Job<ClaimedOutboxEvent, void, 'publish'>,
  ) {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id } });
    if (
      !event ||
      (event.status !== OutboxEventStatus.ENQUEUED &&
        event.status !== OutboxEventStatus.PENDING)
    )
      return;
    const lockedBy = randomUUID();
    const claimed = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        status: event.status,
        lockedBy: event.lockedBy,
        attempts: event.attempts,
        availableAt: { equals: event.availableAt, lte: new Date() },
      },
      data: {
        status: OutboxEventStatus.PROCESSING,
        lockedBy,
        lockedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return;
    const delivery = { ...event, lockedBy };
    await this.withDeliveryLease(delivery, async () => {
      const attempt = event.attempts + 1;
      if (event.attempts >= MAX_ATTEMPTS) {
        await this.recordFailure(
          delivery,
          'Retry budget exhausted',
          event.attempts,
          true,
        );
        return;
      }
      try {
        await this.eventBus.publish(event.eventName, event.payload);
        await this.markPublished(delivery);
      } catch (error) {
        if (error instanceof OutboxDeferredError) {
          await this.release(delivery, error, error.retryAfterMs);
          return;
        }
        const span = trace.getActiveSpan();
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'OUTBOX_DELIVERY_FAILED',
        });
        const permanent = error instanceof OutboxPermanentError;
        const exhausted =
          attempt >= MAX_ATTEMPTS ||
          Boolean(
            job && job.attemptsMade + 1 >= (job.opts.attempts ?? MAX_ATTEMPTS),
          );
        await this.recordFailure(
          delivery,
          error,
          attempt,
          permanent || exhausted,
        );
        if (job && !permanent) throw error;
      }
    });
  }

  private withDeliveryLease<T>(
    event: ClaimedOutboxEvent,
    operation: () => Promise<T>,
  ) {
    const metadata = readOutboxContext(event.context);
    const parent = propagation.extract(ROOT_CONTEXT, metadata);
    return trace.getTracer('coffee-shop.outbox').startActiveSpan(
      'outbox.process',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'postgresql-outbox',
          'messaging.message.id': event.id,
          'messaging.destination.name': event.topic,
        },
      },
      parent,
      (span) =>
        context.with(trace.setSpan(parent, span), () =>
          runWithRequestContext(
            {
              requestId: metadata.requestId ?? `outbox:${event.id}`,
              employeeId: metadata.employeeId,
              traceId: metadata.traceId,
              outboxEventId: event.id,
              eventName: event.eventName,
              aggregateId: event.aggregateId,
            },
            async () => {
              let renewing: Promise<void> | undefined;
              const timer = setInterval(() => {
                renewing ??= this.prisma.outboxEvent
                  .updateMany({
                    where: {
                      id: event.id,
                      status: OutboxEventStatus.PROCESSING,
                      lockedBy: event.lockedBy,
                    },
                    data: { lockedAt: new Date() },
                  })
                  .then(() => {})
                  .catch((error: unknown) => {
                    this.logger.warn({
                      event: 'outbox.lease.renew_failed',
                      error: this.errorMessage(error),
                    });
                  })
                  .finally(() => {
                    renewing = undefined;
                  });
              }, LEASE_RENEW_INTERVAL_MS);
              timer.unref();
              try {
                return await operation();
              } finally {
                clearInterval(timer);
                await renewing;
                span.end();
              }
            },
          ),
        ),
    );
  }

  private async markPublished(event: ClaimedOutboxEvent) {
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: event.lockedBy,
      },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    if (result.count > 0) outboxDispatchTotal.inc({ outcome: 'published' });
    return result;
  }

  private async recordFailure(
    event: ClaimedOutboxEvent,
    error: unknown,
    attempts: number,
    deadLetter: boolean,
  ) {
    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: event.lockedBy,
      },
      data: {
        status: deadLetter
          ? OutboxEventStatus.DEAD_LETTER
          : OutboxEventStatus.PENDING,
        attempts,
        lastError: this.errorMessage(error),
        lockedAt: null,
        lockedBy: null,
        ...(!deadLetter
          ? { availableAt: new Date(Date.now() + 2 ** (attempts - 1) * 1_000) }
          : {}),
      },
    });
    if (result.count > 0) {
      outboxDispatchTotal.inc({
        outcome: deadLetter ? 'dead_letter' : 'retry',
      });
      if (deadLetter) {
        this.logger.error({
          event: 'outbox.event.dead_lettered',
          outboxEventId: event.id,
          eventName: event.eventName,
          aggregateId: event.aggregateId,
          attempts,
          error: this.errorMessage(error),
        });
      }
    }
    return result;
  }

  private release(event: ClaimedOutboxEvent, error: unknown, delayMs = 1_000) {
    return this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: {
          in: [OutboxEventStatus.ENQUEUED, OutboxEventStatus.PROCESSING],
        },
        lockedBy: event.lockedBy,
      },
      data: {
        status: OutboxEventStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
        lastError: this.errorMessage(error),
        availableAt: new Date(Date.now() + Math.max(1_000, delayMs)),
      },
    });
  }

  private recoverAbandonedEvents() {
    return this.prisma.outboxEvent.updateMany({
      where: {
        status: {
          in: [OutboxEventStatus.ENQUEUED, OutboxEventStatus.PROCESSING],
        },
        lockedAt: { lt: new Date(Date.now() - LOCK_TIMEOUT_MS) },
      },
      data: {
        status: OutboxEventStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
      },
    });
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2_000);
  }

  private async closeRedisResource(
    name: 'queue' | 'worker',
    resource?: {
      close(): Promise<void>;
      disconnect(): Promise<void>;
    },
  ) {
    if (!resource) return;
    try {
      await this.withTimeout(
        resource.close(),
        REDIS_CLOSE_TIMEOUT_MS,
        `Outbox ${name} close timed out`,
      );
    } catch (error) {
      this.logger.warn({
        event: 'outbox.redis.force_disconnect',
        resource: name,
        error: this.errorMessage(error),
      });
      await resource.disconnect();
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs = REDIS_COMMAND_TIMEOUT_MS,
    message = 'Outbox Redis operation timed out',
  ) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
