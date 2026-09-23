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
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ClaimedOutboxEvent } from '../../common/types';
import { outboxDispatchTotal } from '../../common/observability/metrics';
import { DomainEventBusService } from './domain-event-bus.service';

const QUEUE_NAME = 'domain-outbox';
const POLL_INTERVAL_MS = 1_000;
const LOCK_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const REDIS_CLOSE_TIMEOUT_MS = 3_000;

@Injectable()
export class OutboxDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly workerId = randomUUID();
  private queue?: Queue<ClaimedOutboxEvent, void, 'publish'>;
  private worker?: Worker<ClaimedOutboxEvent, void, 'publish'>;
  private timer?: NodeJS.Timeout;
  private draining = false;

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

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([
      this.closeRedisResource('worker', this.worker),
      this.closeRedisResource('queue', this.queue),
    ]);
  }

  async drainOnce() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.recoverAbandonedEvents();
      const events = await this.claimBatch();
      for (const event of events) {
        if (this.queue) await this.enqueue(event);
        else await this.deliverWithoutRedis(event);
      }
      await this.prisma.idempotencyRequest.deleteMany({
        where: {
          status: 'COMPLETED',
          expiresAt: { lt: new Date() },
        },
      });
    } catch (error) {
      this.logger.error(
        'Outbox dispatch cycle failed.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.draining = false;
    }
  }

  private startBullMq(redisUrl: string) {
    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      connectTimeout: 1_000,
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.queue = new Queue<ClaimedOutboxEvent, void, 'publish'>(QUEUE_NAME, {
      connection: {
        ...connection,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
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
        "status" = 'PROCESSING',
        "lockedAt" = CURRENT_TIMESTAMP,
        "lockedBy" = ${this.workerId}
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING
        event."id",
        event."topic",
        event."eventName",
        event."aggregateType",
        event."aggregateId",
        event."payload",
        event."attempts",
        event."occurredAt"
    `);
  }

  private async enqueue(event: ClaimedOutboxEvent) {
    try {
      await this.queue!.add('publish', event, {
        jobId: event.id,
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      });
    } catch (error) {
      outboxDispatchTotal.inc({ outcome: 'enqueue_failed' });
      await this.release(event.id, error);
    }
  }

  private async processJob(job: Job<ClaimedOutboxEvent, void, 'publish'>) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: job.data.id },
    });
    if (!event || event.status !== OutboxEventStatus.PROCESSING) return;

    try {
      await this.eventBus.publish(event.eventName, event.payload);
      await this.markPublished(event.id);
    } catch (error) {
      const attempt = job.attemptsMade + 1;
      const finalAttempt = attempt >= (job.opts.attempts ?? MAX_ATTEMPTS);
      await this.recordFailure(event.id, error, attempt, finalAttempt);
      throw error;
    }
  }

  private async deliverWithoutRedis(event: ClaimedOutboxEvent) {
    try {
      await this.eventBus.publish(event.eventName, event.payload);
      await this.markPublished(event.id);
    } catch (error) {
      const attempt = event.attempts + 1;
      if (attempt >= MAX_ATTEMPTS) {
        await this.recordFailure(event.id, error, attempt, true);
      } else {
        outboxDispatchTotal.inc({ outcome: 'retry' });
        await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, status: OutboxEventStatus.PROCESSING },
          data: {
            status: OutboxEventStatus.PENDING,
            attempts: attempt,
            availableAt: new Date(Date.now() + 2 ** (attempt - 1) * 1_000),
            lockedAt: null,
            lockedBy: null,
            lastError: this.errorMessage(error),
          },
        });
      }
    }
  }

  private async markPublished(id: string) {
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxEventStatus.PROCESSING },
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

  private recordFailure(
    id: string,
    error: unknown,
    attempts: number,
    deadLetter: boolean,
  ) {
    if (deadLetter) {
      outboxDispatchTotal.inc({ outcome: 'dead_letter' });
      this.logger.error({
        event: 'outbox.event.dead_lettered',
        outboxEventId: id,
        attempts,
        error: this.errorMessage(error),
      });
    } else {
      outboxDispatchTotal.inc({ outcome: 'retry' });
    }
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxEventStatus.PROCESSING },
      data: {
        status: deadLetter
          ? OutboxEventStatus.DEAD_LETTER
          : OutboxEventStatus.PROCESSING,
        attempts,
        lastError: this.errorMessage(error),
        ...(deadLetter ? { lockedAt: null, lockedBy: null } : {}),
      },
    });
  }

  private release(id: string, error: unknown) {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxEventStatus.PROCESSING },
      data: {
        status: OutboxEventStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
        lastError: this.errorMessage(error),
        availableAt: new Date(Date.now() + 1_000),
      },
    });
  }

  private recoverAbandonedEvents() {
    return this.prisma.outboxEvent.updateMany({
      where: {
        status: OutboxEventStatus.PROCESSING,
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
    timeoutMs: number,
    message: string,
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
