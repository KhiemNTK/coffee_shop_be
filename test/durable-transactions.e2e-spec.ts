import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus, Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ClaimedOutboxEvent } from '../src/common/types';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithRequestContext } from '../src/common/request-context';
import { ManagementExceptionsService } from '../src/app/management-exceptions/management-exceptions.service';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { serializeDecimalResponse } from '../src/common/utils/decimal-response.util';

describe('Durable transaction platform (e2e)', () => {
  const basePrisma = new PrismaService();
  const prisma = basePrisma.getExtendedClient();
  const idempotency = new IdempotencyService(prisma);
  const outbox = new OutboxService();
  const eventBus = new DomainEventBusService();
  const suffix = randomUUID();
  let dispatcher: OutboxDispatcherService;
  let positionId: string;
  let employeeId: string;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(target.hostname) &&
        target.pathname.endsWith('_test'),
      'Use only an isolated loopback test database.',
    );
    if (!process.env.REDIS_URL) {
      throw new Error(
        'REDIS_URL is required for durable outbox integration tests',
      );
    }
    await basePrisma.$connect();
    const position = await prisma.position.create({
      data: { name: `Durable Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;
    const employee = await prisma.employee.create({
      data: {
        email: `durable-${suffix}@example.com`,
        username: `durable-${suffix}`,
        fullName: 'Durable Test Employee',
        password: 'not-used-in-durable-tests',
        positionId,
      },
    });
    employeeId = employee.id;
    dispatcher = new OutboxDispatcherService(
      prisma,
      new ConfigService({ REDIS_URL: process.env.REDIS_URL }),
      eventBus,
    );
    await dispatcher.onApplicationBootstrap();
  });

  afterAll(async () => {
    try {
      await dispatcher?.onModuleDestroy();
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { contains: suffix } },
      });
      await prisma.idempotencyRequest.deleteMany({ where: { employeeId } });
      await basePrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL app.allow_audit_log_mutation = 'on'",
        );
        await tx.actionLog.deleteMany({ where: { employeeId } });
      });
      await basePrisma.employee.delete({ where: { id: employeeId } });
      await basePrisma.position.delete({ where: { id: positionId } });
    } finally {
      await basePrisma.$disconnect();
    }
  });

  it('commits one side effect for concurrent requests with the same key', async () => {
    const key = `concurrent-${suffix}`;
    const operation = async (tx: Parameters<typeof outbox.enqueue>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'IDEMPOTENCY_TEST',
          details: { key },
        },
        select: { id: true },
      });
    };
    const input = {
      employeeId,
      operation: 'test.concurrent',
      key,
      request: { value: 1 },
    };

    const results = await Promise.all([
      idempotency.execute(input, operation),
      idempotency.execute(input, operation),
    ]);

    expect(results[0]).toEqual(results[1]);
    await expect(
      prisma.actionLog.count({
        where: { employeeId, actionType: 'IDEMPOTENCY_TEST' },
      }),
    ).resolves.toBe(1);
    await expect(
      idempotency.execute({ ...input, request: { value: 2 } }, operation),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists the same Decimal response shape returned over HTTP and replays it once', async () => {
    const input = {
      employeeId,
      operation: 'test.decimal',
      key: `decimal-${suffix}`,
      request: {},
    };
    const operation = jest.fn(
      async (tx: Parameters<typeof outbox.enqueue>[0]) => {
        const log = await tx.actionLog.create({
          data: { employeeId, actionType: 'DECIMAL_TEST', details: {} },
        });
        return {
          id: log.id,
          amount: new Prisma.Decimal('42.25'),
          nested: [new Prisma.Decimal(2)],
        };
      },
    );
    const first = await idempotency.execute(input, operation);
    const replay = await idempotency.execute(input, operation);
    expect(JSON.parse(JSON.stringify(serializeDecimalResponse(first)))).toEqual(
      replay,
    );
    expect(replay.amount).toBe(42.25);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rolls back an outbox event with its failed business transaction', async () => {
    const aggregateId = `rollback-${suffix}`;

    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, {
          topic: 'order',
          eventName: 'test.rolled-back',
          aggregateType: 'TestAggregate',
          aggregateId,
          payload: { aggregateId },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    await expect(
      prisma.outboxEvent.count({ where: { aggregateId } }),
    ).resolves.toBe(0);
  });

  it('requeues a dead letter once with an atomic audit and replays a lost response', async () => {
    const aggregateId = `manual-retry-${suffix}`;
    const created = await prisma.outboxEvent.create({
      data: {
        topic: 'order',
        eventName: `test.manual-retry.${suffix}`,
        aggregateType: 'TestAggregate',
        aggregateId,
        payload: { aggregateId },
        status: 'DEAD_LETTER',
        attempts: 5,
        lastError: 'consumer unavailable',
      },
    });
    const inbox = new ManagementExceptionsService(
      prisma,
      new PaginationUtilService(),
      idempotency,
    );
    const dto = {
      reason: 'Consumer has recovered',
      expectedAvailableAt: created.availableAt.toISOString(),
      idempotencyKey: `manual-retry-${suffix}`,
    };
    const results = await Promise.all([
      inbox.retryOutboxEvent(created.id, employeeId, dto),
      inbox.retryOutboxEvent(created.id, employeeId, dto),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await inbox.retryOutboxEvent(created.id, employeeId, dto)).toEqual(
      results[0],
    );
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId,
          actionType: 'OUTBOX_EVENT_RETRY',
          details: { path: ['outboxEventId'], equals: created.id },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: created.id } }),
    ).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        attempts: 0,
        payload: created.payload,
        lastError: created.lastError,
        lockedBy: null,
      }),
    );
    await expect(
      inbox.retryOutboxEvent(created.id, employeeId, {
        ...dto,
        reason: 'Different request',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      inbox.retryOutboxEvent(created.id, employeeId, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // A stale screen cannot retry a later dead-letter cycle of the same event.
    await prisma.outboxEvent.update({
      where: { id: created.id },
      data: {
        status: 'DEAD_LETTER',
        attempts: 5,
        availableAt: new Date(created.availableAt.getTime() + 1_000),
      },
    });
    await expect(
      inbox.retryOutboxEvent(created.id, employeeId, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts only one of two concurrent retry commands with different keys', async () => {
    const created = await prisma.outboxEvent.create({
      data: {
        topic: 'order',
        eventName: `test.retry-race.${suffix}`,
        aggregateType: 'TestAggregate',
        aggregateId: `retry-race-${suffix}`,
        payload: {},
        status: 'DEAD_LETTER',
        attempts: 5,
        lastError: 'Consumer unavailable',
      },
    });
    const inbox = new ManagementExceptionsService(
      prisma,
      new PaginationUtilService(),
      idempotency,
    );
    const dto = {
      reason: 'Consumer repaired',
      expectedAvailableAt: created.availableAt.toISOString(),
    };
    const results = await Promise.allSettled([
      inbox.retryOutboxEvent(created.id, employeeId, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
      inbox.retryOutboxEvent(created.id, employeeId, {
        ...dto,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.any(ConflictException) }),
    ]);
    expect(
      await prisma.actionLog.count({
        where: {
          employeeId,
          actionType: 'OUTBOX_EVENT_RETRY',
          details: { path: ['outboxEventId'], equals: created.id },
        },
      }),
    ).toBe(1);
  });

  it('publishes a manually retried dead letter behind a retained failed Redis job', async () => {
    const eventName = `test.manual-redis.${suffix}`;
    let fail = true;
    const listener = jest.fn(() => {
      if (fail) throw new Error('consumer failed');
    });
    const unsubscribe = eventBus.on(eventName, listener);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const queue = (
      dispatcher as unknown as {
        queue: Queue<ClaimedOutboxEvent, void, 'publish'>;
      }
    ).queue;
    const created = await prisma.outboxEvent.create({
      data: {
        topic: 'order',
        eventName,
        aggregateType: 'TestAggregate',
        aggregateId: `manual-redis-${suffix}`,
        payload: {},
        status: 'ENQUEUED',
        lockedAt: new Date(),
        lockedBy: 'original-lease',
      },
    });
    try {
      const job = await queue.add(
        'publish',
        { ...created, lockedBy: 'original-lease', payload: {} },
        { jobId: created.id, attempts: 1, removeOnFail: false },
      );
      const deadline = Date.now() + 10_000;
      while ((await job.getState()) !== 'failed') {
        if (Date.now() >= deadline)
          throw new Error('Redis job was not retained');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const failed = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(failed.status).toBe('DEAD_LETTER');
      const inbox = new ManagementExceptionsService(
        prisma,
        new PaginationUtilService(),
        idempotency,
      );
      await inbox.retryOutboxEvent(created.id, employeeId, {
        reason: 'Consumer repaired',
        expectedAvailableAt: failed.availableAt.toISOString(),
        idempotencyKey: randomUUID(),
      });
      fail = false;
      await dispatcher.drainOnce();
      expect(await waitForPublished(created.id)).toBe('PUBLISHED');
      expect(listener).toHaveBeenCalledTimes(2);
      await expect(
        inbox.retryOutboxEvent(created.id, employeeId, {
          reason: 'Consumer repaired',
          expectedAvailableAt: failed.availableAt.toISOString(),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      unsubscribe();
      log.mockRestore();
    }
  });

  it('rejects implicit soft deletion and rolls back explicit deletion with junction cleanup', async () => {
    const permission = await prisma.permission.create({
      data: { name: `Rollback ${suffix}`, key: `/rollback-${suffix}_read` },
    });
    const role = await prisma.role.create({
      data: { name: `Rollback ${suffix}` },
    });
    try {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      await expect(
        prisma.$transaction((tx) =>
          tx.permission.delete({ where: { id: permission.id } }),
        ),
      ).rejects.toThrow('use update/updateMany with deletedAt');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.rolePermission.deleteMany({
            where: { permissionId: permission.id },
          });
          await tx.permission.update({
            where: { id: permission.id },
            data: { deletedAt: new Date() },
          });
          throw new Error('rollback soft deletion');
        }),
      ).rejects.toThrow('rollback soft deletion');
      expect(
        await prisma.permission.findUnique({ where: { id: permission.id } }),
      ).toEqual(expect.objectContaining({ deletedAt: null }));
      expect(
        await prisma.rolePermission.count({
          where: { roleId: role.id, permissionId: permission.id },
        }),
      ).toBe(1);
    } finally {
      await basePrisma.rolePermission.deleteMany({
        where: { roleId: role.id },
      });
      await basePrisma.role.delete({ where: { id: role.id } });
      await basePrisma.permission.delete({ where: { id: permission.id } });
    }
  });

  it('recovers an abandoned event behind a retained failed Redis job', async () => {
    const aggregateId = `retained-${suffix}`;
    const eventName = `test.retained.${suffix}`;
    let fail = true;
    const listener = jest.fn(() => {
      if (fail) throw new Error('delivery failed');
    });
    const unsubscribe = eventBus.on(eventName, listener);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const queue = (
      dispatcher as unknown as {
        queue: Queue<ClaimedOutboxEvent, void, 'publish'>;
      }
    ).queue;
    const created = await prisma.outboxEvent.create({
      data: {
        topic: 'order',
        eventName,
        aggregateType: 'TestAggregate',
        aggregateId,
        payload: { aggregateId },
        status: OutboxEventStatus.ENQUEUED,
        lockedAt: new Date(),
        lockedBy: 'unavailable-dispatcher',
      },
    });
    try {
      const job = await queue.add(
        'publish',
        {
          ...created,
          lockedBy: 'unavailable-dispatcher',
          payload: { aggregateId },
        },
        { jobId: created.id, attempts: 1, removeOnFail: false },
      );
      const deadline = Date.now() + 10_000;
      while ((await job.getState()) !== 'failed') {
        if (Date.now() >= deadline)
          throw new Error('failed Redis job was not retained');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Reproduce the persisted state left when the final DB acknowledgement was lost.
      await prisma.outboxEvent.update({
        where: { id: created.id },
        data: {
          status: OutboxEventStatus.PROCESSING,
          attempts: 0,
          lockedAt: new Date(Date.now() - 16 * 60 * 1_000),
        },
      });
      fail = false;
      (dispatcher as unknown as { lastRecoveryAt: number }).lastRecoveryAt = 0;
      await dispatcher.drainOnce();
      expect(await waitForPublished(created.id)).toBe(
        OutboxEventStatus.PUBLISHED,
      );
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      log.mockRestore();
    }
  }, 30_000);

  it('delivers a committed event through Redis and marks it published', async () => {
    const aggregateId = `published-${suffix}`;
    const eventName = `test.published.${suffix}`;
    let unsubscribe: () => unknown = () => undefined;
    const received = new Promise<unknown>((resolve) => {
      unsubscribe = eventBus.on(eventName, resolve);
    });
    const created = await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        topic: 'order',
        eventName,
        aggregateType: 'TestAggregate',
        aggregateId,
        payload: { aggregateId },
      }),
    );

    try {
      await dispatcher.drainOnce();
      await expect(withTimeout(received, 10_000)).resolves.toEqual({
        aggregateId,
      });
      await expect(waitForPublished(created.id)).resolves.toBe(
        OutboxEventStatus.PUBLISHED,
      );
    } finally {
      unsubscribe();
    }
  }, 30_000);

  it('stores request IDs and rejects audit updates and deletes', async () => {
    const requestId = `request-${suffix}`;
    const log = await runWithRequestContext(
      { requestId },
      async () =>
        await prisma.$transaction((tx) =>
          tx.actionLog.create({
            data: {
              employeeId,
              actionType: 'AUDIT_IMMUTABILITY_TEST',
              details: { suffix },
            },
          }),
        ),
    );

    expect(log.requestId).toBe(requestId);
    await expect(
      prisma.actionLog.update({
        where: { id: log.id },
        data: { actionType: 'MUTATED' },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.actionLog.delete({ where: { id: log.id } }),
    ).rejects.toBeDefined();
  });

  async function waitForPublished(id: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      if (event.status === OutboxEventStatus.PUBLISHED) return event.status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('outbox acknowledgement timed out');
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('outbox delivery timed out')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
});
