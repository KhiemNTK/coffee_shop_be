import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
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
    occurredAt: new Date(),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    outboxEvent: { updateMany: jest.fn() },
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
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
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
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
      data: expect.objectContaining({
        status: OutboxEventStatus.PUBLISHED,
        publishedAt: expect.any(Date),
      }),
    });
  });

  it('returns a failed event to pending with exponential backoff', async () => {
    eventBus.on(event.eventName, () => {
      throw new Error('temporary failure');
    });

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
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
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
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
      add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    (service as unknown as { queue: typeof queue }).queue = queue;

    await service.drainOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: OutboxEventStatus.PROCESSING },
      data: expect.objectContaining({
        status: OutboxEventStatus.PENDING,
        lockedAt: null,
        lockedBy: null,
        lastError: 'redis unavailable',
      }),
    });
  });
});
