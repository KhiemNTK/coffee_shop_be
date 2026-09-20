import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxDispatcherService } from '../src/app/durable/outbox-dispatcher.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithRequestContext } from '../src/common/request-context';

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

    await dispatcher.drainOnce();
    await expect(withTimeout(received, 10_000)).resolves.toEqual({
      aggregateId,
    });
    unsubscribe();
    await expect(waitForPublished(created.id)).resolves.toBe(
      OutboxEventStatus.PUBLISHED,
    );
  });

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
