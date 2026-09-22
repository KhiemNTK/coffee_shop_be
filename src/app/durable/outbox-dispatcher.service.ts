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
import { DomainEventBusService } from './domain-event-bus.service';

const QUEUE_NAME = 'domain-outbox';
const POLL_INTERVAL_MS = 1_000;
const LOCK_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;

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
    await this.worker?.close();
    await this.queue?.close();
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
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.queue = new Queue<ClaimedOutboxEvent, void, 'publish'>(QUEUE_NAME, {
      connection,
    });
    this.worker = new Worker<ClaimedOutboxEvent, void, 'publish'>(
      QUEUE_NAME,
      (job) => this.processJob(job),
      { connection, concurrency: 10 },
    );
    this.worker.on('error', (error) => {
      this.logger.error('Outbox worker error.', error.stack);
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

  private markPublished(id: string) {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxEventStatus.PROCESSING },
      data: {
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
  }

  private recordFailure(
    id: string,
    error: unknown,
    attempts: number,
    deadLetter: boolean,
  ) {
    if (deadLetter) {
      this.logger.error(
        `Outbox event ${id} moved to dead-letter after ${attempts} attempts: ${this.errorMessage(error)}`,
      );
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
}
