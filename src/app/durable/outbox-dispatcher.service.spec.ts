import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { ClaimedOutboxEvent } from '../../common/types';
import { DomainEventBusService } from './domain-event-bus.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { getRequestContext } from '../../common/request-context';
import {
  OutboxDeferredError,
  OutboxPermanentError,
} from './outbox-delivery.error';

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomUUID: jest.fn(),
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('OutboxDispatcherService', () => {
  const executionLease = '00000000-0000-4000-8000-000000000099';
  const event = {
    id: 'event-id',
    topic: 'order',
    eventName: 'order.invoice.paid',
    aggregateType: 'Invoice',
    aggregateId: 'invoice-id',
    payload: { invoiceId: 'invoice-id' },
    attempts: 0,
    lockedBy: 'lease-id',
    availableAt: new Date(0),
    occurredAt: new Date(),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    outboxEvent: { updateMany: jest.fn(), findUnique: jest.fn() },
    idempotencyRequest: { deleteMany: jest.fn() },
  };
  const config = {
    get: jest.fn().mockReturnValue(undefined),
  };
  let eventBus: DomainEventBusService;
  let service: OutboxDispatcherService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(randomUUID).mockReturnValue(executionLease);
    config.get.mockReturnValue(undefined);
    prisma.$queryRaw.mockResolvedValue([event]);
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.ENQUEUED,
    });
    prisma.idempotencyRequest.deleteMany.mockResolvedValue({ count: 0 });
    eventBus = new DomainEventBusService();
    service = new OutboxDispatcherService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
      eventBus,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('publishes and acknowledges a claimed event without Redis', async () => {
    const listener = jest.fn();
    eventBus.on(event.eventName, listener);

    await service.drainOnce();

    expect(listener).toHaveBeenCalledWith(event.payload);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: executionLease,
      },
      data: expect.objectContaining({
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: expect.any(Date),
      }),
    });
  });

  it('bounds retention cleanup and never deletes undelivered outbox events', async () => {
    await service.drainOnce();
    const statements = prisma.$executeRaw.mock.calls.map(
      ([query]) => query.text as string,
    );
    expect(statements).toHaveLength(6);
    expect(statements[1]).toContain(
      '"operation" NOT LIKE \'inventory.stock.%\'',
    );
    expect(statements[1]).toContain('"operation" NOT LIKE \'cashier-shift.%\'');
    expect(
      statements.every((sql) => sql.includes('FOR UPDATE SKIP LOCKED')),
    ).toBe(true);
    expect(statements[2]).toContain('"status" = \'PUBLISHED\'');
    for (const [query] of prisma.$executeRaw.mock.calls)
      expect(query.values).toContain(500);
    await service.drainOnce();
    expect(statements[5]).toContain('CustomerSession');
    expect(statements[0]).toContain('BusinessInsight');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
  });

  it('decodes credentials and preserves TLS and DB when starting BullMQ', async () => {
    config.get.mockImplementation((key) =>
      key === 'REDIS_URL'
        ? 'rediss://staff%40coffee:p%40ss%3Aword%25@redis.example.test:6380/2'
        : 0,
    );
    await service.onApplicationBootstrap();
    const connection = expect.objectContaining({
      host: 'redis.example.test',
      port: 6380,
      db: 2,
      username: 'staff@coffee',
      password: 'p@ss:word%',
      tls: {},
    });
    expect(Queue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ connection }),
    );
    expect(Worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ connection }),
    );
    const queueOptions = jest.mocked(Queue).mock.calls[0][1];
    expect(queueOptions?.connection).toHaveProperty('commandTimeout', 2_000);
    const workerOptions = jest.mocked(Worker).mock.calls[0][2];
    expect(workerOptions?.connection).not.toHaveProperty('commandTimeout');
    await service.onModuleDestroy();
  });

  it('returns a failed event to pending with exponential backoff', async () => {
    eventBus.on(event.eventName, () => {
      throw new Error('temporary failure');
    });

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: executionLease,
      },
      data: expect.objectContaining({
        status: OutboxEventStatus.PENDING,
        attempts: 1,
        availableAt: expect.any(Date),
        lastError: 'temporary failure',
      }),
    });
  });

  it('moves a repeatedly failing event to dead-letter', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma.$queryRaw.mockResolvedValue([{ ...event, attempts: 4 }]);
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.ENQUEUED,
      attempts: 4,
    });
    eventBus.on(event.eventName, () => {
      throw new Error('permanent failure');
    });

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: executionLease,
      },
      data: expect.objectContaining({
        status: OutboxEventStatus.DEAD_LETTER,
        attempts: 5,
        lastError: 'permanent failure',
      }),
    });
    expect(errorLog).toHaveBeenCalledWith({
      event: 'outbox.event.dead_lettered',
      outboxEventId: event.id,
      eventName: event.eventName,
      aggregateId: event.aggregateId,
      attempts: 5,
      error: 'permanent failure',
    });
  });

  it('releases a claimed event when Redis enqueue is unavailable', async () => {
    const queue = {
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    (service as unknown as { queue: typeof queue }).queue = queue;

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: {
          in: [OutboxEventStatus.ENQUEUED, OutboxEventStatus.PROCESSING],
        },
        lockedBy: event.lockedBy,
      },
      data: expect.objectContaining({
        status: OutboxEventStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
        lastError: 'redis unavailable',
      }),
    });
  });

  it.each(['failed', 'completed'])(
    'retries a retained %s job rather than adding its duplicate ID',
    async (state) => {
      const job = {
        data: event,
        getState: jest.fn().mockResolvedValue(state),
        updateData: jest.fn().mockResolvedValue(undefined),
        retry: jest.fn().mockResolvedValue(undefined),
      };
      const queue = {
        waitUntilReady: jest.fn().mockResolvedValue(undefined),
        getJob: jest.fn().mockResolvedValue(job),
        add: jest.fn(),
      };
      (service as unknown as { queue: typeof queue }).queue = queue;
      await service.drainOnce();
      expect(job.updateData).toHaveBeenCalledWith(event);
      expect(job.retry).toHaveBeenCalledWith(state, {
        resetAttemptsMade: true,
      });
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'waiting', 'delayed'])(
    'leaves an existing %s job alone',
    async (state) => {
      const job = {
        data: event,
        getState: jest.fn().mockResolvedValue(state),
        retry: jest.fn(),
        updateData: jest.fn(),
      };
      const queue = {
        waitUntilReady: jest.fn().mockResolvedValue(undefined),
        getJob: jest.fn().mockResolvedValue(job),
        add: jest.fn(),
      };
      (service as unknown as { queue: typeof queue }).queue = queue;
      await service.drainOnce();
      expect(job.retry).not.toHaveBeenCalled();
      expect(job.updateData).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  const queuedJob = () =>
    ({ data: event, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job<
      ClaimedOutboxEvent,
      void,
      'publish'
    >;
  const processJob = (job: Job<ClaimedOutboxEvent, void, 'publish'>) =>
    (
      service as unknown as {
        processJob: (
          job: Job<ClaimedOutboxEvent, void, 'publish'>,
        ) => Promise<void>;
      }
    ).processJob(job);

  it('retries a failed database read without modifying an unowned event', async () => {
    prisma.outboxEvent.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(processJob(queuedJob())).rejects.toThrow(
      'database unavailable',
    );
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it.each(['redis', 'direct'])(
    'defers delivery without burning attempts or holding the worker (%s)',
    async (mode) => {
      eventBus.on(event.eventName, () => {
        throw new OutboxDeferredError(27_000);
      });
      const now = Date.now();
      if (mode === 'redis') await processJob(queuedJob());
      else await service.drainOnce();
      const updates = prisma.outboxEvent.updateMany.mock.calls.map(
        ([args]) => args,
      );
      const deferred = updates.find(
        (args) => args.data.lastError === 'Delivery deferred by rate limit.',
      );
      expect(deferred).toEqual({
        where: {
          id: event.id,
          status: {
            in: [OutboxEventStatus.ENQUEUED, OutboxEventStatus.PROCESSING],
          },
          lockedBy: executionLease,
        },
        data: {
          status: OutboxEventStatus.PENDING,
          lockedAt: null,
          lockedBy: null,
          lastError: 'Delivery deferred by rate limit.',
          availableAt: expect.any(Date),
        },
      });
      expect(deferred.data.availableAt.getTime()).toBeGreaterThanOrEqual(
        now + 27_000,
      );
      expect(deferred.data).not.toHaveProperty('attempts');
    },
  );

  it.each(['redis', 'direct'])(
    'dead-letters a permanent rejection once (%s)',
    async (mode) => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      eventBus.on(event.eventName, () => {
        throw new OutboxPermanentError('Invalid destination.');
      });
      if (mode === 'redis') await processJob(queuedJob());
      else await service.drainOnce();
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OutboxEventStatus.DEAD_LETTER,
            attempts: 1,
          }),
        }),
      );
      expect(log).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the database retry budget after a retained job is restarted', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.ENQUEUED,
      attempts: 4,
    });
    eventBus.on(event.eventName, () => {
      throw new Error('permanent failure');
    });
    await expect(processJob(queuedJob())).rejects.toThrow('permanent failure');
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.ENQUEUED,
        lockedBy: event.lockedBy,
        attempts: 4,
        availableAt: { equals: event.availableAt, lte: expect.any(Date) },
      },
      data: {
        status: OutboxEventStatus.PROCESSING,
        lockedBy: executionLease,
        lockedAt: expect.any(Date),
      },
    });
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: executionLease,
      },
      data: expect.objectContaining({
        attempts: 5,
        status: OutboxEventStatus.DEAD_LETTER,
      }),
    });
  });

  it('ignores a queued job whose lease was replaced by recovery', async () => {
    const listener = jest.fn();
    eventBus.on(event.eventName, listener);
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.PROCESSING,
      lockedBy: 'new-lease',
    });
    await processJob(queuedJob());
    expect(listener).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('releases a new lease while an older Redis job is still finishing', async () => {
    const job = {
      data: { ...event, lockedBy: 'old-lease' },
      getState: jest.fn().mockResolvedValue('active'),
      retry: jest.fn(),
      updateData: jest.fn(),
    };
    const queue = {
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(job),
      add: jest.fn(),
    };
    (service as unknown as { queue: typeof queue }).queue = queue;
    await service.drainOnce();
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: event.id,
          status: {
            in: [OutboxEventStatus.ENQUEUED, OutboxEventStatus.PROCESSING],
          },
          lockedBy: event.lockedBy,
        },
        data: expect.objectContaining({ status: OutboxEventStatus.PENDING }),
      }),
    );
    expect(job.retry).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
  });

  it('fences a delivery that loses its lease while the consumer is running', async () => {
    eventBus.on(event.eventName, () => undefined);
    prisma.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await processJob(queuedJob());
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockedBy: executionLease,
        },
      }),
    );
  });

  it.each(['readiness', 'getJob'])(
    'bounds an unresponsive Redis %s, releases the unqueued batch and permits the next drain',
    async (phase) => {
      jest.useFakeTimers();
      let finishRead!: (job: undefined) => void;
      const stalled = new Promise<undefined>((resolve) => {
        finishRead = resolve;
      });
      const queue = {
        waitUntilReady: jest.fn().mockResolvedValue(undefined),
        getJob: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockResolvedValue(undefined),
      };
      if (phase === 'readiness')
        queue.waitUntilReady.mockReturnValueOnce(stalled);
      else queue.getJob.mockReturnValueOnce(stalled);
      Reflect.set(service, 'queue', queue);
      const second = { ...event, id: 'second-event', lockedBy: 'second-lease' };
      prisma.$queryRaw.mockResolvedValue([event, second]);
      try {
        const drain = service.drainOnce();
        expect(service.drainOnce()).toBe(drain);
        await jest.advanceTimersByTimeAsync(2_000);
        await drain;
        expect(queue.add).not.toHaveBeenCalled();
        expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: event.id,
              status: { in: ['ENQUEUED', 'PROCESSING'] },
              lockedBy: event.lockedBy,
            },
            data: expect.objectContaining({
              status: 'PENDING',
              lastError: 'Outbox Redis operation timed out',
            }),
          }),
        );
        expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
          where: {
            status: 'ENQUEUED',
            OR: [{ id: second.id, lockedBy: second.lockedBy }],
          },
          data: {
            status: 'PENDING',
            lockedAt: null,
            lockedBy: null,
            availableAt: expect.any(Date),
            lastError: 'Outbox dispatch batch interrupted.',
          },
        });
        finishRead(undefined);
        await jest.advanceTimersByTimeAsync(0);
        expect(queue.add).not.toHaveBeenCalled();
        prisma.$queryRaw.mockResolvedValue([event]);
        await service.drainOnce();
        expect(queue.add).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('joins an in-flight enqueue, releases remaining claims and closes worker before queue', async () => {
    let finishRead!: (job: undefined) => void;
    const read = new Promise<undefined>((resolve) => {
      finishRead = resolve;
    });
    const order: string[] = [];
    const queue = {
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockReturnValue(read),
      add: jest.fn().mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      }),
      close: jest.fn().mockImplementation(() => {
        order.push('queue');
        return Promise.resolve();
      }),
      disconnect: jest.fn(),
    };
    const worker = {
      close: jest.fn().mockImplementation(() => {
        order.push('worker');
        return Promise.resolve();
      }),
      disconnect: jest.fn(),
    };
    Reflect.set(service, 'queue', queue);
    Reflect.set(service, 'worker', worker);
    const second = { ...event, id: 'unqueued' };
    prisma.$queryRaw.mockResolvedValue([event, second]);
    const drain = service.drainOnce();
    await new Promise(setImmediate);
    expect(queue.getJob).toHaveBeenCalledTimes(1);
    const shutdown = service.onModuleDestroy();
    expect(service.onModuleDestroy()).toBe(shutdown);
    await service.drainOnce();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.close).not.toHaveBeenCalled();
    finishRead(undefined);
    await shutdown;
    await drain;
    expect(order).toEqual(['enqueue', 'worker', 'queue']);
    await service.onModuleDestroy();
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.getJob).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'ENQUEUED',
          OR: [{ id: second.id, lockedBy: second.lockedBy }],
        },
        data: expect.objectContaining({
          status: 'PENDING',
          lastError: 'Outbox dispatcher stopped before enqueue.',
        }),
      }),
    );
  });

  it('does not claim after shutdown starts during a pending claim', async () => {
    let finishClaim!: (events: (typeof event)[]) => void;
    prisma.$queryRaw.mockReturnValue(
      new Promise<(typeof event)[]>((resolve) => {
        finishClaim = resolve;
      }),
    );
    const listener = jest.fn();
    eventBus.on(event.eventName, listener);
    const drain = service.drainOnce();
    await new Promise(setImmediate);
    const shutdown = service.onModuleDestroy();
    finishClaim([event]);
    await shutdown;
    await drain;
    await service.drainOnce();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'ENQUEUED',
          OR: [{ id: event.id, lockedBy: event.lockedBy }],
        },
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });

  it('renews a running execution without overlapping renewal queries and restores its request context', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    let finishRenewal!: (result: { count: number }) => void;
    prisma.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockImplementationOnce(
        () =>
          new Promise<{ count: number }>((resolve) => {
            finishRenewal = resolve;
          }),
      );
    const contextSeen = jest.fn();
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.ENQUEUED,
      context: { requestId: 'request-12345678', employeeId: 'employee-id' },
    });
    eventBus.on(event.eventName, async () => {
      contextSeen(getRequestContext());
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    try {
      const delivery = processJob(queuedJob());
      await jest.advanceTimersByTimeAsync(20_000);
      expect(contextSeen).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'request-12345678',
          employeeId: 'employee-id',
          outboxEventId: event.id,
        }),
      );
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
        where: { id: event.id, status: 'PROCESSING', lockedBy: executionLease },
        data: { lockedAt: expect.any(Date) },
      });
      await jest.advanceTimersByTimeAsync(20_000);
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(2);
      finishRenewal({ count: 1 });
      finish();
      await delivery;
      expect(jest.getTimerCount()).toBe(0);
      expect(getRequestContext()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('checks abandoned leases every 15 seconds independently of five-minute cleanup', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockResolvedValue([]);
    try {
      await service.drainOnce();
      await jest.advanceTimersByTimeAsync(15_000);
      await service.drainOnce();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
      const recovery = prisma.outboxEvent.updateMany.mock.calls.filter(
        ([args]) => args.where.lockedAt,
      );
      expect(recovery).toHaveLength(2);
      expect(recovery[1][0].where).toEqual({
        status: { in: ['ENQUEUED', 'PROCESSING'] },
        lockedAt: { lt: new Date(Date.now() - 90_000) },
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
