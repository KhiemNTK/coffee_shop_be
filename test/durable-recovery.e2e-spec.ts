import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { OutboxDeferredError } from '../src/app/durable/outbox-delivery.error';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import {
  getRequestContext,
  runWithRequestContext,
} from '../src/common/request-context';
import type { ClaimedOutboxEvent } from '../src/common/types';

describe('Durable recovery (dedicated PostgreSQL and Redis)', () => {
  let base: PrismaService;
  let prisma: ExtendedPrismaClient;
  let bus: DomainEventBusService;
  let dispatcher: OutboxDispatcherService;
  let employeeId: string;
  const createdIds: string[] = [];
  const unsubscribe: (() => void)[] = [];
  const outbox = new OutboxService();
  const config = new ConfigService({
    REDIS_URL: process.env.REDIS_URL,
    OUTBOX_POLL_INTERVAL_MS: 0,
  });

  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL ?? '');
    const redis = new URL(process.env.REDIS_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['localhost', '127.0.0.1'].includes(database.hostname) &&
        database.pathname.endsWith('_test'),
      'Only an isolated loopback test database is allowed.',
    );
    assert(
      ['localhost', '127.0.0.1'].includes(redis.hostname) &&
        (Number(redis.port || '6379') !== 6379 || redis.pathname === '/14'),
      'Use a dedicated loopback test Redis on a non-default port or isolated /14 database.',
    );
    base = new PrismaService();
    await base.$connect();
    prisma = base.getExtendedClient();
    const position = await prisma.position.create({
      data: { name: `Recovery ${randomUUID()}`, salary: 0 },
    });
    const employee = await prisma.employee.create({
      data: {
        positionId: position.id,
        username: `recovery-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
        fullName: 'Recovery fixture',
        password: 'not-used-for-login',
      },
    });
    employeeId = employee.id;
    bus = new DomainEventBusService();
    dispatcher = new OutboxDispatcherService(prisma, config, bus);
    await dispatcher.onApplicationBootstrap();
  });

  afterEach(async () => {
    for (const remove of unsubscribe.splice(0)) remove();
    await prisma.outboxEvent.deleteMany({
      where: { id: { in: createdIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await dispatcher?.onModuleDestroy();
    await base?.$disconnect();
  });

  async function enqueue(eventName = `test.${randomUUID()}`) {
    const result = await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        topic: 'order',
        eventName,
        aggregateType: 'RecoveryFixture',
        aggregateId: randomUUID(),
        payload: { amount: '120000.00' },
      }),
    );
    createdIds.push(result.id);
    return prisma.outboxEvent.update({
      where: { id: result.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
  }

  async function waitForStatus(id: string, status: OutboxEventStatus) {
    let lastState: OutboxEventStatus | undefined;
    for (let attempt = 0; attempt < 70; attempt++) {
      const event = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id },
      });
      if (event.status === status) return event;
      lastState = event.status;
      await sleep(50);
    }
    throw new Error(
      `Event ${id} did not reach ${status}; last state was ${lastState}`,
    );
  }

  const workerJob = (id: string) =>
    ({
      data: { id, lockedBy: 'obsolete-redis-owner' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    }) as Job<ClaimedOutboxEvent, void, 'publish'>;
  const processEvent = (service: OutboxDispatcherService, id: string) =>
    (
      service as unknown as {
        processJob(
          job: Job<ClaimedOutboxEvent, void, 'publish'>,
        ): Promise<void>;
      }
    ).processJob(workerJob(id));

  it('recovers a crash between database claim and enqueue before a 15-minute token expires, preserving actor and request ID', async () => {
    const requestId = `request-${randomUUID()}`;
    const event = await runWithRequestContext({ requestId, employeeId }, () =>
      enqueue(),
    );
    expect(event.context).toEqual({ requestId, employeeId });
    unsubscribe.push(
      bus.on(event.eventName, async () => {
        const context = getRequestContext();
        expect(context).toMatchObject({
          requestId,
          employeeId,
          outboxEventId: event.id,
        });
        await prisma.actionLog.create({
          data: {
            employeeId,
            actionType: 'RECOVERY_TEST',
            details: { eventId: event.id },
          },
        });
      }),
    );
    const claimed = await (
      dispatcher as unknown as { claimBatch(): Promise<ClaimedOutboxEvent[]> }
    ).claimBatch();
    expect(claimed.map((row) => row.id)).toContain(event.id);
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({ status: 'ENQUEUED' });
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { lockedAt: new Date(Date.now() - 91_000) },
    });
    const restarted = new OutboxDispatcherService(prisma, config, bus);
    await restarted.onApplicationBootstrap();
    try {
      await restarted.drainOnce();
      const published = await waitForStatus(
        event.id,
        OutboxEventStatus.PUBLISHED,
      );
      expect(published.attempts).toBe(0);
      expect(Date.now() - published.occurredAt.getTime()).toBeLessThan(
        15 * 60_000,
      );
      expect(
        await prisma.actionLog.findFirst({ where: { requestId } }),
      ).toMatchObject({ employeeId, requestId });
    } finally {
      await restarted.onModuleDestroy();
    }
  });

  it('lets only one racing worker claim an event and does not trust the queued lease', async () => {
    const event = await enqueue();
    const listener = jest.fn();
    unsubscribe.push(bus.on(event.eventName, listener));
    const other = new OutboxDispatcherService(prisma, config, bus);
    await Promise.all([
      processEvent(dispatcher, event.id),
      processEvent(other, event.id),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({ status: 'PUBLISHED', lockedBy: null });
  });

  it('never steals a fresh running lease and fences acknowledgement after ownership changes', async () => {
    const event = await enqueue();
    const owner = randomUUID();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: owner },
    });
    const listener = jest.fn();
    unsubscribe.push(bus.on(event.eventName, listener));
    await dispatcher.drainOnce();
    await processEvent(dispatcher, event.id);
    expect(listener).not.toHaveBeenCalled();
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({ status: 'PROCESSING', lockedBy: owner });
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'PENDING', lockedBy: null, lockedAt: null },
    });
    unsubscribe.push(
      bus.on(event.eventName, async () => {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { lockedBy: owner },
        });
      }),
    );
    await processEvent(dispatcher, event.id);
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({
      status: 'PROCESSING',
      lockedBy: owner,
      publishedAt: null,
    });
  });

  it('retries transient delivery through real BullMQ without losing the database retry budget', async () => {
    const event = await enqueue();
    const listener = jest
      .fn()
      .mockRejectedValueOnce(new Error('Temporary consumer failure'))
      .mockResolvedValue(undefined);
    unsubscribe.push(bus.on(event.eventName, listener));
    await dispatcher.drainOnce();
    const published = await waitForStatus(
      event.id,
      OutboxEventStatus.PUBLISHED,
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(published.attempts).toBe(1);
  });

  it('defers without spending attempts and reuses a completed Redis job ID', async () => {
    const event = await enqueue();
    const listener = jest
      .fn()
      .mockRejectedValueOnce(new OutboxDeferredError(30_000))
      .mockResolvedValue(undefined);
    unsubscribe.push(bus.on(event.eventName, listener));
    await dispatcher.drainOnce();
    let pending = await waitForStatus(event.id, OutboxEventStatus.PENDING);
    expect(pending.attempts).toBe(0);
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await sleep(100);
    pending = await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { availableAt: new Date() },
    });
    await dispatcher.drainOnce();
    expect(
      (await waitForStatus(pending.id, OutboxEventStatus.PUBLISHED)).attempts,
    ).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('delivers old rows with null context using an event-specific support ID', async () => {
    const event = await enqueue();
    expect(event.context).toBeNull();
    const listener = jest.fn(() =>
      expect(getRequestContext()?.requestId).toBe(`outbox:${event.id}`),
    );
    unsubscribe.push(bus.on(event.eventName, listener));
    await dispatcher.drainOnce();
    await waitForStatus(event.id, OutboxEventStatus.PUBLISHED);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rolls outbox state and correlation metadata back together with the business transaction', async () => {
    const id = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, {
          topic: 'order',
          eventName: 'test.rollback',
          aggregateType: 'RecoveryFixture',
          aggregateId: id,
          payload: {},
        });
        throw new Error('Rollback fixture');
      }),
    ).rejects.toThrow('Rollback fixture');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: id } })).toBe(
      0,
    );
  });
});
