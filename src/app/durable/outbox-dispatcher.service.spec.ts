import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { ClaimedOutboxEvent } from '../../common/types';
import { DomainEventBusService } from './domain-event-bus.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

describe('OutboxDispatcherService', () => {
  const event = {
    id: 'event-id',
    topic: 'order',
    eventName: 'order.invoice.paid',
    aggregateType: 'Invoice',
    aggregateId: 'invoice-id',
    payload: { invoiceId: 'invoice-id' },
    attempts: 0,
    lockedBy: 'lease-id',
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
    prisma.$queryRaw.mockResolvedValue([event]);
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.PROCESSING,
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
        lockedBy: event.lockedBy,
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
    expect(statements).toHaveLength(4);
    expect(
      statements.every((sql) => sql.includes('FOR UPDATE SKIP LOCKED')),
    ).toBe(true);
    expect(statements[1]).toContain('"status" = \'PUBLISHED\'');
    for (const [query] of prisma.$executeRaw.mock.calls)
      expect(query.values).toContain(500);
    await service.drainOnce();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
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
        lockedBy: event.lockedBy,
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
    eventBus.on(event.eventName, () => {
      throw new Error('permanent failure');
    });

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: event.lockedBy,
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
      attempts: 5,
      error: 'permanent failure',
    });
  });

  it('releases a claimed event when Redis enqueue is unavailable', async () => {
    const queue = {
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
        status: OutboxEventStatus.PROCESSING,
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

  it('records database read failures through the retry path', async () => {
    prisma.outboxEvent.findUnique.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(processJob(queuedJob())).rejects.toThrow(
      'database unavailable',
    );
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: event.lockedBy,
      },
      data: expect.objectContaining({
        attempts: 1,
        lastError: 'database unavailable',
      }),
    });
  });

  it('preserves the database retry budget after a retained job is restarted', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      status: OutboxEventStatus.PROCESSING,
      attempts: 4,
    });
    eventBus.on(event.eventName, () => {
      throw new Error('permanent failure');
    });
    await expect(processJob(queuedJob())).rejects.toThrow('permanent failure');
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: OutboxEventStatus.PROCESSING,
        lockedBy: event.lockedBy,
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
    const queue = { getJob: jest.fn().mockResolvedValue(job), add: jest.fn() };
    (service as unknown as { queue: typeof queue }).queue = queue;
    await service.drainOnce();
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
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
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    await processJob(queuedJob());
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: event.id,
          status: OutboxEventStatus.PROCESSING,
          lockedBy: event.lockedBy,
        },
      }),
    );
  });
});
