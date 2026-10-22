import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  PaymentAttemptStatus,
  PaymentRefundStatus,
  PaymentStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { Queue, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import http from 'supertest';
import { AppModule } from '../src/app/app.module';
import { AuthSessionService } from '../src/app/auth/auth-session.service';
import { BusinessInsightSnapshotService } from '../src/app/reports/business-insight-snapshot.service';
import { BusinessInsightsService } from '../src/app/reports/business-insights.service';
import { BusinessInsightHistoryService } from '../src/app/reports/business-insight-history.service';
import { INSIGHT_REQUESTED } from '../src/app/reports/business-insight-history.service';
import { queryInsightBreakdown } from '../src/app/reports/business-insight-breakdown.query';
import { buildBusinessInsightAnalysis } from '../src/app/reports/business-insight.analysis';
import type { ExtendedPrismaTransactionClient } from '../src/common/types';
import { OutboxService } from '../src/app/durable/outbox.service';
import { DomainEventBusService } from '../src/app/durable/domain-event-bus.service';
import type { CreateBusinessInsightDto } from '../src/app/reports/dto/business-insight.dto';
import { GeminiInsightsService } from '../src/app/reports/gemini-insights.service';
import { PermissionKeys } from '../src/common/consts/permission-keys';
import type { ExtendedPrismaClient } from '../src/common/prisma/prisma.service';
import type {
  BusinessInsightSuggestions,
  BusinessInsightJobData,
  BusinessInsightResult,
  BusinessInsightSnapshot,
} from '../src/common/types/business-insight.types';
import { validateEnvironment } from '../src/config/environment';
import {
  aiInsightQueueJobs,
  aiInsightQueueUp,
  aiInsightQueueHeadAgeSeconds,
} from '../src/common/observability/metrics';
import { initApp } from '../src/init';

jest.setTimeout(35_000);

// Run serially with --maxWorkers=1; Redis DB 15 is reserved for this suite.
describe('Business insights (PostgreSQL/Redis integration)', () => {
  const redisDb = 15;
  const suffix = randomUUID();
  const ids: Record<string, string> = {};
  const duration = 60_000;
  const from = new Date(Date.UTC(2003, 0, 1) + randomInt(365 * 86_400_000));
  const to = new Date(from.getTime() + duration);
  const previousFrom = new Date(from.getTime() - 86_400_000);
  const previousTo = new Date(to.getTime() - 86_400_000);
  const apiKey = 'test-only-gemini-key-not-a-real-credential';
  const expectedFailureJobs = new Set<string>();
  const outageWarningEvents = [
    'ai.insights.queue_error',
    'ai.insights.worker_error',
    'ai.insights.unavailable',
    'ai.insights.force_disconnect',
    'ai.insights.disconnect_failed',
  ];
  let expectedOutageWarnings = false;
  const analysis: BusinessInsightSuggestions = {
    findings: [
      {
        title: 'Kiem tra hoan tien',
        kind: 'HYPOTHESIS',
        detail: 'Hoan tien anh huong den thuc thu.',
        metricKeys: ['refundAmount', 'netReceipts'],
        action: 'Doi chieu giao dich truoc khi quyet dinh.',
      },
    ],
    limitations: ['Mau giao dich nho; loi nhuan chi la uoc tinh.'],
  };

  let databaseUrl: URL;
  let redisUrl: URL;
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue<BusinessInsightJobData, BusinessInsightResult, 'generate'>;
  let snapshots: BusinessInsightSnapshotService;
  let history: BusinessInsightHistoryService;
  const eventBus = new DomainEventBusService();
  let gemini: GeminiInsightsService;
  let insights: BusinessInsightsService | undefined;
  let warn: jest.SpyInstance<void, Parameters<Logger['warn']>> | undefined;
  let generate:
    | jest.SpyInstance<
        Promise<BusinessInsightSuggestions>,
        [BusinessInsightSnapshot, string]
      >
    | undefined;

  function assertSafeTargets() {
    assert.equal(process.env.NODE_ENV, 'test', 'NODE_ENV must be test.');
    assert(
      ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) &&
        ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) &&
        /^[^/]+_test$/.test(decodeURIComponent(databaseUrl.pathname.slice(1))),
      'DATABASE_URL must target a loopback PostgreSQL database ending _test.',
    );
    assert(
      redisUrl.protocol === 'redis:' &&
        ['127.0.0.1', 'localhost'].includes(redisUrl.hostname) &&
        redisUrl.pathname === `/${redisDb}`,
      'Redis must target loopback and the dedicated test DB 15.',
    );
    if (redis) {
      assert.equal(redis.options.host, redisUrl.hostname);
      assert.equal(redis.options.port, Number(redisUrl.port || 6379));
      assert.equal(redis.options.db, redisDb);
    }
  }

  async function clearRedis() {
    assertSafeTargets();
    await redis.flushdb();
  }

  function request(expectFailure = false): CreateBusinessInsightDto {
    const dto: CreateBusinessInsightDto = {
      clientRequestId: randomUUID(),
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: 'Asia/Ho_Chi_Minh',
    };
    if (expectFailure) {
      expectedFailureJobs.add(
        createHash('sha256')
          .update(`${ids.employee}:${dto.clientRequestId}`)
          .digest('hex'),
      );
    }
    return dto;
  }

  function dailyKey(kind: 'admissions' | 'calls') {
    return `ai:insights:${kind}:${new Date().toISOString().slice(0, 10)}`;
  }

  async function terminal(id: string, employeeId = ids.employee) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await insights!.get(employeeId, id);
      if (result.status === 'COMPLETED' || result.status === 'FAILED')
        return result;
      await sleep(50);
    }
    throw new Error(`Insight ${id} did not finish within 25 seconds.`);
  }

  function createInvoice(
    createdAt: Date,
    paymentStatus: PaymentStatus,
    subTotal: number,
    discountAmount = 0,
    taxAmount = 0,
  ) {
    return prisma.invoice.create({
      data: {
        invoiceNumber: `INSIGHT-${randomUUID()}`,
        employeeId: ids.employee,
        orderSessionId: ids.session,
        createdAt,
        paymentStatus,
        subTotal,
        discountAmount,
        taxAmount,
        totalAmount: subTotal - discountAmount + taxAmount,
      },
    });
  }

  function createAttempt(invoice: { id: string; totalAmount: Prisma.Decimal }) {
    const id = randomUUID();
    return prisma.paymentAttempt.create({
      data: {
        invoiceId: invoice.id,
        createdById: ids.employee,
        shiftId: ids.shift,
        amount: invoice.totalAmount,
        status: PaymentAttemptStatus.SUCCEEDED,
        merchantReference: id,
        providerTransactionNo: id,
        idempotencyKey: id,
        requestHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        completedAt: new Date(),
      },
    });
  }

  function createRefund(
    paymentAttemptId: string,
    amount: number,
    status: PaymentRefundStatus = PaymentRefundStatus.SUCCEEDED,
    completedAt: Date | null = new Date(Date.now() - 1_000),
  ) {
    const id = randomUUID();
    return prisma.paymentRefund.create({
      data: {
        paymentAttemptId,
        requestedById: ids.employee,
        type: 'PARTIAL',
        amount,
        status,
        completedAt,
        requestedAt: new Date(from.getTime() + duration),
        reason: 'Business insight integration fixture',
        idempotencyKey: id,
        providerRequestId: id,
        requestHash: 'b'.repeat(64),
      },
    });
  }

  beforeAll(async () => {
    assert(process.env.DATABASE_URL, 'DATABASE_URL must be explicitly set.');
    databaseUrl = new URL(process.env.DATABASE_URL);
    redisUrl = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    // Keep the supplied test host/port, but never share the outbox Redis DB.
    redisUrl.pathname = `/${redisDb}`;
    assertSafeTargets();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- apply preserves the logger receiver.
    const originalWarn = Logger.prototype.warn;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (
      this: Logger,
      ...args: Parameters<Logger['warn']>
    ) {
      const message: unknown = args[0];
      if (
        typeof message === 'object' &&
        message !== null &&
        'event' in message &&
        typeof message.event === 'string'
      ) {
        if (
          message.event === 'ai.insights.failed' &&
          'jobId' in message &&
          typeof message.jobId === 'string' &&
          expectedFailureJobs.has(message.jobId)
        )
          return;
        if (
          expectedOutageWarnings &&
          Reflect.get(this, 'context') === BusinessInsightsService.name &&
          outageWarningEvents.includes(message.event)
        )
          return;
      }
      originalWarn.apply(this, args);
    });

    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl.href } },
    });
    await prisma.$connect();
    snapshots = new BusinessInsightSnapshotService(
      prisma as unknown as ExtendedPrismaClient,
    );
    history = new BusinessInsightHistoryService(
      prisma as unknown as ExtendedPrismaClient,
      new OutboxService(),
    );
    const connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username
        ? decodeURIComponent(redisUrl.username)
        : undefined,
      password: redisUrl.password
        ? decodeURIComponent(redisUrl.password)
        : undefined,
      db: redisDb,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    };
    redis = new Redis({
      ...connection,
      lazyConnect: true,
      commandTimeout: 2_000,
    });
    await redis.connect();
    await clearRedis();
    queue = new Queue('business-insights', { connection });
    await queue.waitUntilReady();

    expect(
      await prisma.invoice.count({
        where: { createdAt: { gte: previousFrom, lte: to } },
      }),
    ).toBe(0);
    ids.position = (
      await prisma.position.create({
        data: { name: `Insight position ${suffix}`, salary: 0 },
      })
    ).id;
    ids.employee = (
      await prisma.employee.create({
        data: {
          email: `insight-${suffix}@example.com`,
          username: `insight-${suffix}`,
          fullName: 'Insight integration employee',
          password: 'test-only-not-used-for-login',
          positionId: ids.position,
        },
      })
    ).id;
    ids.session = (
      await prisma.orderSession.create({ data: { employeeId: ids.employee } })
    ).id;
    ids.otherEmployee = (
      await prisma.employee.create({
        data: {
          email: `insight-other-${suffix}@example.com`,
          username: `insight-other-${suffix}`,
          fullName: 'Other insight employee',
          password: 'test-only',
          positionId: ids.position,
        },
      })
    ).id;
    ids.shift = (
      await prisma.cashierShift.create({
        data: { employeeId: ids.employee, startingCash: 0 },
      })
    ).id;

    await createInvoice(from, PaymentStatus.PAID, 60, 10, 5);
    const partial = await createInvoice(
      from,
      PaymentStatus.PARTIALLY_REFUNDED,
      100,
      0,
      10,
    );
    ids.partial = partial.id;
    const full = await createInvoice(from, PaymentStatus.REFUNDED, 40, 0, 4);
    await createInvoice(previousFrom, PaymentStatus.PAID, 50, 0, 5);
    const prior = await createInvoice(
      previousFrom,
      PaymentStatus.PARTIALLY_REFUNDED,
      80,
      0,
      8,
    );
    await createInvoice(from, PaymentStatus.UNPAID, 1_000);
    await createInvoice(from, PaymentStatus.VOIDED, 1_000);
    await createInvoice(to, PaymentStatus.PAID, 10_000);
    await createInvoice(
      new Date(previousFrom.getTime() - 1),
      PaymentStatus.PAID,
      10_000,
    );

    const partialAttempt = await createAttempt(partial);
    await createRefund(partialAttempt.id, 22);
    await createRefund(partialAttempt.id, 3, PaymentRefundStatus.PENDING, null);
    await createRefund(partialAttempt.id, 5, PaymentRefundStatus.FAILED);
    await createRefund(
      partialAttempt.id,
      7,
      PaymentRefundStatus.SUCCEEDED,
      new Date(Date.now() + 86_400_000),
    );
    await createRefund((await createAttempt(full)).id, 44);
    await createRefund((await createAttempt(prior)).id, 44);
  });

  beforeEach(async () => {
    expectedFailureJobs.clear();
    warn?.mockClear();
    await clearRedis();
    await prisma.businessInsight.deleteMany({
      where: { employeeId: { in: [ids.employee, ids.otherEmployee] } },
    });
    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateType: 'BusinessInsight',
        OR: [ids.employee, ids.otherEmployee].map((employeeId) => ({
          payload: { path: ['employeeId'], equals: employeeId },
        })),
      },
    });
    const config = new ConfigService({
      AI_INSIGHTS_ENABLED: true,
      REDIS_URL: redisUrl.href,
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_API_KEY: apiKey,
      GEMINI_DAILY_REQUEST_LIMIT: 2,
    });
    gemini = new GeminiInsightsService(config);
    generate = jest.spyOn(gemini, 'generate').mockResolvedValue(analysis);
    insights = new BusinessInsightsService(
      config,
      snapshots,
      gemini,
      history,
      eventBus,
    );
  });

  afterEach(async () => {
    try {
      await insights?.onModuleDestroy();
      insights = undefined;
    } finally {
      generate?.mockRestore();
    }
  });

  afterAll(async () => {
    try {
      await insights?.onModuleDestroy();
    } finally {
      try {
        await queue?.close();
      } finally {
        try {
          if (redis) {
            try {
              if (redis.status === 'ready') await clearRedis();
            } finally {
              redis.disconnect();
            }
          }
        } finally {
          try {
            if (prisma && ids.employee) {
              assertSafeTargets();
              await prisma.$transaction([
                prisma.businessInsight.deleteMany({
                  where: {
                    employeeId: { in: [ids.employee, ids.otherEmployee] },
                  },
                }),
                prisma.outboxEvent.deleteMany({
                  where: {
                    aggregateType: 'BusinessInsight',
                    OR: [ids.employee, ids.otherEmployee].map((employeeId) => ({
                      payload: { path: ['employeeId'], equals: employeeId },
                    })),
                  },
                }),
                prisma.paymentRefund.deleteMany({
                  where: { requestedById: ids.employee },
                }),
                prisma.paymentAttempt.deleteMany({
                  where: { createdById: ids.employee },
                }),
                prisma.invoice.deleteMany({
                  where: { employeeId: ids.employee },
                }),
                prisma.orderSession.deleteMany({
                  where: { employeeId: ids.employee },
                }),
                prisma.cashierShift.deleteMany({
                  where: { employeeId: ids.employee },
                }),
                prisma.employee.deleteMany({
                  where: { id: { in: [ids.employee, ids.otherEmployee] } },
                }),
              ]);
            }
            if (prisma && ids.position) {
              assertSafeTargets();
              await prisma.position.deleteMany({ where: { id: ids.position } });
            }
          } finally {
            try {
              await prisma?.$disconnect();
            } finally {
              warn?.mockRestore();
            }
          }
        }
      }
    }
  });

  it('is disabled by default and does not need a Gemini key or create a job', async () => {
    const defaults = new ConfigService(
      validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: databaseUrl.href }),
    );
    const disabled = new BusinessInsightsService(
      defaults,
      snapshots,
      gemini,
      history,
      eventBus,
    );
    try {
      expect(disabled.getConfiguration().enabled).toBe(false);
      await expect(
        disabled.create(ids.employee, request()),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'AI_DISABLED' },
      });
      await expect(
        disabled.get(ids.employee, 'a'.repeat(64)),
      ).rejects.toMatchObject({
        status: 404,
      });
      expect(await queue.getJobs()).toHaveLength(0);
      expect(await redis.get(dailyKey('admissions'))).toBeNull();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await disabled.onModuleDestroy();
    }
  });

  it('reads private paginated history after Redis is erased and AI is disabled without spending quota', async () => {
    const dto = request();
    const created = await insights!.create(ids.employee, dto);
    const result = await terminal(created.id);
    await insights!.onModuleDestroy();
    await clearRedis();
    const reader = new BusinessInsightsService(
      new ConfigService(),
      snapshots,
      gemini,
      history,
      eventBus,
    );
    expect(await reader.get(ids.employee, created.id)).toEqual(result);
    expect(await reader.create(ids.employee, dto)).toEqual(result);
    const list = await reader.list(ids.employee, { limit: 1 });
    expect(list.items.map((item) => item.id)).toEqual([created.id]);
    expect(list.items[0]).not.toHaveProperty('snapshot');
    expect(list.items[0]).not.toHaveProperty('analysis');
    expect(await reader.list(ids.otherEmployee, { limit: 1 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await reader.list(ids.otherEmployee, { limit: 1, cursor: created.id }),
    ).toEqual({ items: [], nextCursor: null });
    await expect(reader.get(ids.otherEmployee, created.id)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await redis.get(dailyKey('admissions'))).toBeNull();
    expect(await redis.get(dailyKey('calls'))).toBeNull();
    await prisma.businessInsight.update({
      where: { id: created.id },
      data: {
        requestedAt: new Date(Date.now() - 8 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    await expect(reader.get(ids.employee, created.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await reader.list(ids.employee, { limit: 1 })).items).toEqual([]);
  });

  it('imports a completed legacy snapshot atomically and preserves its original version', async () => {
    const dto = request();
    const snapshot = await snapshots.capture(dto.from, dto.to);
    const result = {
      snapshot,
      analysis: buildBusinessInsightAnalysis(snapshot, analysis),
    };
    const id = 'd'.repeat(64);
    await history.record(
      id,
      {
        employeeId: ids.employee,
        requestHash: 'a'.repeat(64),
        requestedAt: new Date().toISOString(),
        from: dto.from,
        to: dto.to,
        timeZone: dto.timeZone,
        model: 'gemini-3.5-flash-lite',
        promptVersion: 'business-finance-v2',
      },
      false,
      result,
    );
    expect(await insights!.get(ids.employee, id)).toMatchObject({
      status: 'COMPLETED',
      promptVersion: 'business-finance-v2',
      ...result,
    });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: id } })).toBe(
      0,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('commits request and outbox together and recovers a lost enqueue through duplicate deliveries', async () => {
    const dto = request();
    const id = createHash('sha256')
      .update(`${ids.employee}:${dto.clientRequestId}`)
      .digest('hex');
    const data: BusinessInsightJobData = {
      employeeId: ids.employee,
      requestHash: 'a'.repeat(64),
      from: dto.from,
      to: dto.to,
      timeZone: dto.timeZone,
      requestedAt: new Date().toISOString(),
      model: 'gemini-3.5-flash-lite',
      promptVersion: 'business-finance-v3',
    };
    const broken = new BusinessInsightHistoryService(
      prisma as unknown as ExtendedPrismaClient,
      {
        enqueue: () => Promise.reject(new Error('outbox rollback')),
      } as unknown as OutboxService,
    );
    await expect(broken.record(id, data)).rejects.toThrow('outbox rollback');
    expect(await prisma.businessInsight.count({ where: { id } })).toBe(0);
    await Promise.all([history.record(id, data), history.record(id, data)]);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: id, eventName: INSIGHT_REQUESTED },
      }),
    ).toBe(1);
    insights!.onModuleInit();
    await eventBus.publish(INSIGHT_REQUESTED, { id, employeeId: ids.employee });
    await eventBus.publish(INSIGHT_REQUESTED, { id, employeeId: ids.employee });
    expect((await terminal(id)).status).toBe('COMPLETED');
    expect(generate).toHaveBeenCalledTimes(1);
    await eventBus.publish(INSIGHT_REQUESTED, { id, employeeId: ids.employee });
    expect(generate).toHaveBeenCalledTimes(1);
    await history.record('b'.repeat(64), data, false);
    await history.record('c'.repeat(64), data, false);
    const first = await history.list(ids.employee, { limit: 1 });
    const second = await history.list(ids.employee, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    const third = await history.list(ids.employee, {
      limit: 1,
      cursor: second.nextCursor!,
    });
    expect([first.items[0].id, second.items[0].id, third.items[0].id]).toEqual(
      [id, 'b'.repeat(64), 'c'.repeat(64)].sort().reverse(),
    );
    expect(third.nextCursor).toBeNull();
  });

  it('does not repeat a provider call when storing its successful response fails', async () => {
    const complete = jest
      .spyOn(history, 'complete')
      .mockRejectedValueOnce(new Error('database write failed'));
    try {
      const created = await insights!.create(ids.employee, request(true));
      expect(await terminal(created.id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_OUTCOME_UNKNOWN',
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await redis.get(dailyKey('calls'))).toBe('1');
    } finally {
      complete.mockRestore();
    }
  });

  it('bounds item/category drill-down, compares the same entities and excludes cancelled/unpaid lines', async () => {
    const rollback = new Error('rollback breakdown fixtures');
    try {
      await prisma.$transaction(async (tx) => {
        const firstCategory = await tx.menuCategory.create({
          data: { name: `Insight category 1 ${suffix}` },
        });
        const secondCategory = await tx.menuCategory.create({
          data: { name: `Insight category 2 ${suffix}` },
        });
        const categories = [firstCategory, secondCategory];
        const prior = await tx.invoice.findFirstOrThrow({
          where: { employeeId: ids.employee, createdAt: previousFrom },
        });
        const unpaid = await tx.invoice.findFirstOrThrow({
          where: { employeeId: ids.employee, paymentStatus: 'UNPAID' },
        });
        const items: string[] = [];
        for (let index = 1; index <= 6; index++) {
          const item = await tx.menuItem.create({
            data: {
              name: `Insight item ${index}`,
              price: 999,
              categoryId: categories[index <= 3 ? 0 : 1].id,
            },
          });
          items.push(item.id);
          await tx.orderItem.createMany({
            data: [
              {
                menuItemId: item.id,
                orderSessionId: ids.session,
                invoiceId: ids.partial,
                quantity: 1,
                priceAtTime: index * 10,
                serveStatus: 'SERVED',
              },
              {
                menuItemId: item.id,
                orderSessionId: ids.session,
                invoiceId: prior.id,
                quantity: 2,
                priceAtTime: 5,
                serveStatus: 'SERVED',
              },
              {
                menuItemId: item.id,
                orderSessionId: ids.session,
                invoiceId: ids.partial,
                quantity: 100,
                priceAtTime: 999,
                serveStatus: 'CANCELLED',
              },
              {
                menuItemId: item.id,
                orderSessionId: ids.session,
                invoiceId: unpaid.id,
                quantity: 100,
                priceAtTime: 999,
                serveStatus: 'SERVED',
              },
            ],
          });
        }
        const metrics = await queryInsightBreakdown(
          tx as unknown as ExtendedPrismaTransactionClient,
          { from, to },
          { from: previousFrom, to: previousTo },
        );
        expect(metrics).toHaveLength(14);
        expect(
          metrics.some((metric) => metric.key === `item.${items[0]}.sales`),
        ).toBe(false);
        expect(metrics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: `item.${items[5]}.sales`,
              value: '60.00',
              previousValue: '10.00',
            }),
            expect.objectContaining({
              key: `item.${items[5]}.quantity`,
              value: '1',
              previousValue: '2',
            }),
            expect.objectContaining({
              key: `category.${categories[1].id}.sales`,
              value: '150.00',
              previousValue: '30.00',
            }),
          ]),
        );
        expect(new Set(metrics.map((metric) => metric.key)).size).toBe(
          metrics.length,
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });

  it('captures refund-aware SQL metrics with the same short window on the previous day', async () => {
    const snapshot = await snapshots.capture(
      from.toISOString(),
      to.toISOString(),
    );
    expect(snapshot.comparisonPeriod).toEqual({
      from: previousFrom.toISOString(),
      to: previousTo.toISOString(),
    });
    expect(
      Date.parse(snapshot.comparisonPeriod.to) -
        Date.parse(snapshot.comparisonPeriod.from),
    ).toBe(duration);
    expect(Date.parse(snapshot.asOf)).toBeLessThanOrEqual(Date.now());
    expect(
      Object.fromEntries(
        snapshot.metrics.map(({ key, value, previousValue }) => [
          key,
          [value, previousValue],
        ]),
      ),
    ).toEqual({
      paidInvoiceCount: ['3', '2'],
      grossSales: ['200.00', '130.00'],
      discountAmount: ['10.00', '0.00'],
      refundCount: ['2', '1'],
      refundAmount: ['66.00', '44.00'],
      netReceipts: ['143.00', '99.00'],
      estimatedNetSalesExTax: ['130.00', '90.00'],
      ingredientCost: ['0.00', '0.00'],
      wasteCost: ['0.00', '0.00'],
      estimatedGrossProfit: ['130.00', '90.00'],
      soldItemCount: ['0', '0'],
      itemsWithCostSnapshot: ['0', '0'],
      zeroCostSnapshotCount: ['0', '0'],
    });
  });

  it('creates one stored job and makes one provider call for simultaneous duplicate requests', async () => {
    const dto = request();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => insights!.create(ids.employee, dto)),
    );
    const id = responses[0].id;
    expect(responses.map((response) => response.id)).toEqual(Array(8).fill(id));
    const result = await terminal(id);
    expect(result).toMatchObject({
      status: 'COMPLETED',
      analysis: {
        findings: expect.arrayContaining(analysis.findings),
        limitations: expect.arrayContaining(analysis.limitations),
      },
      errorCode: null,
      period: { from: dto.from, to: dto.to, timeZone: dto.timeZone },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      result.snapshot,
      'gemini-3.5-flash-lite',
    );
    expect((await queue.getJobs()).map((job) => job.id)).toEqual([id]);
    expect(await redis.get(dailyKey('admissions'))).toBe('1');
    expect(await redis.get(dailyKey('calls'))).toBe('1');
    expect(await insights!.create(ids.employee, dto)).toEqual(result);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a request ID for a different period, including its Redis tombstone', async () => {
    const dto = request();
    const created = await insights!.create(ids.employee, dto);
    await terminal(created.id);
    const changed = {
      ...dto,
      to: new Date(to.getTime() + duration).toISOString(),
    };
    await expect(insights!.create(ids.employee, changed)).rejects.toMatchObject(
      { status: 409 },
    );
    const job = await queue.getJob(created.id);
    assert(job);
    await job.remove();
    await expect(insights!.create(ids.employee, changed)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await redis.get(dailyKey('admissions'))).toBe('1');
  });

  it('returns 404 across employees and scopes the same client request ID to its owner', async () => {
    const dto = request();
    const otherEmployee = ids.otherEmployee;
    const created = await insights!.create(ids.employee, dto);
    await expect(
      insights!.get(otherEmployee, created.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      insights!.get(ids.employee, 'f'.repeat(64)),
    ).rejects.toMatchObject({ status: 404 });
    const other = await insights!.create(otherEmployee, dto);
    expect(other.id).not.toBe(created.id);
    expect((await terminal(created.id)).status).toBe('COMPLETED');
    expect((await terminal(other.id, otherEmployee)).status).toBe('COMPLETED');
    await expect(insights!.get(ids.employee, other.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('reuses the persisted snapshot on a real delayed retry and bounds provider requests', async () => {
    generate!.mockImplementationOnce(async () => {
      await prisma.invoice.update({
        where: { id: ids.partial },
        data: { subTotal: 200, taxAmount: 20, totalAmount: 220 },
      });
      throw new Error('AI_PROVIDER_UNAVAILABLE');
    });
    try {
      const created = await insights!.create(ids.employee, request(true));
      const result = await terminal(created.id);
      expect(result).toMatchObject({
        status: 'COMPLETED',
        analysis: {
          findings: expect.arrayContaining(analysis.findings),
          limitations: expect.arrayContaining(analysis.limitations),
        },
        errorCode: null,
      });
      expect(generate).toHaveBeenCalledTimes(2);
      const firstSnapshot = generate!.mock.calls[0][0];
      expect(generate!.mock.calls[1][0]).toEqual(firstSnapshot);
      expect(result.snapshot).toEqual(firstSnapshot);
      const job = await queue.getJob(created.id);
      assert(job);
      expect(job.data.snapshot).toEqual(firstSnapshot);
      expect(job.opts.attempts).toBe(2);
      expect(job.attemptsMade).toBe(2);
      expect(await redis.get(dailyKey('calls'))).toBe('2');
      expect(warn).toHaveBeenCalledWith({
        event: 'ai.insights.failed',
        jobId: created.id,
        outcome: 'retry',
        errorCode: 'AI_PROVIDER_UNAVAILABLE',
        attempts: 1,
      });
      const fresh = await snapshots.capture(
        from.toISOString(),
        to.toISOString(),
      );
      expect(
        fresh.metrics.find((metric) => metric.key === 'grossSales')?.value,
      ).toBe('300.00');
      expect(
        firstSnapshot.metrics.find((metric) => metric.key === 'grossSales')
          ?.value,
      ).toBe('200.00');
    } finally {
      await prisma.invoice.update({
        where: { id: ids.partial },
        data: { subTotal: 100, taxAmount: 10, totalAmount: 110 },
      });
    }
  });

  it('atomically admits only two different requests and still allows an admitted duplicate', async () => {
    const dtos = Array.from({ length: 8 }, () => request());
    const outcomes = await Promise.allSettled(
      dtos.map((dto) => insights!.create(ids.employee, dto)),
    );
    const admitted: Array<{ id: string; dto: CreateBusinessInsightDto }> = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') {
        admitted.push({ id: outcome.value.id, dto: dtos[index] });
      } else {
        expect(outcome.reason).toMatchObject({
          status: 429,
          response: { code: 'AI_DAILY_LIMIT' },
        });
      }
    }
    expect(admitted).toHaveLength(2);
    for (const job of admitted)
      expect((await terminal(job.id)).status).toBe('COMPLETED');
    expect(await redis.get(dailyKey('admissions'))).toBe('2');
    expect(await redis.get(dailyKey('calls'))).toBe('2');
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await queue.getJobs()).map((job) => job.id).sort()).toEqual(
      admitted.map((job) => job.id).sort(),
    );
    expect(await insights!.create(ids.employee, admitted[0].dto)).toMatchObject(
      { id: admitted[0].id, status: 'COMPLETED' },
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('collects real paused queue depth and clears its head age after processing', async () => {
    await queue.pause();
    try {
      const created = await insights!.create(ids.employee, request());
      await insights!.collectMetrics();
      expect((await aiInsightQueueUp.get()).values[0].value).toBe(1);
      expect((await aiInsightQueueJobs.get()).values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            labels: expect.objectContaining({ state: 'waiting' }),
            value: 1,
          }),
        ]),
      );
      await queue.resume();
      expect((await terminal(created.id)).status).toBe('COMPLETED');
      await insights!.collectMetrics();
      expect((await aiInsightQueueHeadAgeSeconds.get()).values[0].value).toBe(
        0,
      );
      expect((await aiInsightQueueJobs.get()).values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            labels: expect.objectContaining({ state: 'waiting' }),
            value: 0,
          }),
        ]),
      );
    } finally {
      await queue.resume();
    }
  });

  it('enforces the shared provider-call budget across jobs and their retries', async () => {
    generate!.mockRejectedValue(new Error('AI_PROVIDER_UNAVAILABLE'));
    const jobs = await Promise.all([
      insights!.create(ids.employee, request(true)),
      insights!.create(ids.employee, request(true)),
    ]);
    for (const job of jobs) {
      expect(await terminal(job.id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_DAILY_LIMIT',
        analysis: null,
      });
    }
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await redis.get(dailyKey('admissions'))).toBe('2');
    expect(await redis.get(dailyKey('calls'))).toBe('2');
    for (const job of jobs) {
      expect(warn).toHaveBeenCalledWith({
        event: 'ai.insights.failed',
        jobId: job.id,
        outcome: 'failed',
        errorCode: 'AI_DAILY_LIMIT',
        attempts: 2,
      });
    }
  });

  it.each([
    {
      name: 'provider rejection',
      reason: 'AI_PROVIDER_REJECTED',
      recoverable: false,
      code: 'AI_PROVIDER_REJECTED',
      attempts: 1,
    },
    {
      name: 'invalid output',
      reason: 'AI_INVALID_OUTPUT',
      recoverable: false,
      code: 'AI_INVALID_OUTPUT',
      attempts: 1,
    },
    {
      name: 'provider unavailability',
      reason: 'AI_PROVIDER_UNAVAILABLE',
      recoverable: true,
      code: 'AI_PROVIDER_UNAVAILABLE',
      attempts: 2,
    },
    {
      name: 'unexpected provider details',
      reason: `Bearer ${apiKey}; SELECT private_invoice; raw provider body`,
      recoverable: true,
      code: 'AI_JOB_FAILED',
      attempts: 2,
    },
  ])(
    'reports $name with a safe code and bounded attempts',
    async ({ reason, recoverable, code, attempts }) => {
      generate!.mockRejectedValue(
        recoverable ? new Error(reason) : new UnrecoverableError(reason),
      );
      const created = await insights!.create(ids.employee, request(true));
      const result = await terminal(created.id);
      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: code,
        analysis: null,
      });
      expect(result.snapshot).not.toBeNull();
      expect(generate).toHaveBeenCalledTimes(attempts);
      const job = await queue.getJob(created.id);
      assert(job);
      expect(job.attemptsMade).toBe(attempts);
      expect(job.failedReason).toBe(reason);
      expect(await redis.get(dailyKey('calls'))).toBe(String(attempts));
      expect(
        warn!.mock.calls.filter(
          ([message]) =>
            message?.event === 'ai.insights.failed' &&
            message?.jobId === created.id,
        ),
      ).toHaveLength(attempts);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(apiKey);
      expect(serialized).not.toContain('private_invoice');
      expect(serialized).not.toContain('raw provider body');
      expect(result).not.toHaveProperty('failedReason');
      expect(result).not.toHaveProperty('stacktrace');
    },
  );

  it('bounds admission and shutdown when a real BullMQ connection stalls over TCP', async () => {
    const sockets = new Set<Socket>();
    let acceptedConnections = 0;
    let tearingDown = false;
    let stalled: BusinessInsightsService | undefined;
    let shutdown: Promise<void> | undefined;
    const server = createServer((socket) => {
      sockets.add(socket);
      acceptedConnections++;
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // Drain incoming commands without ever sending a Redis response.
      if (tearingDown) socket.destroy();
      else socket.resume();
    });

    async function bounded<T>(promise: Promise<T>) {
      const timeout = new AbortController();
      try {
        return await Promise.race([
          promise,
          sleep(5_000, undefined, { signal: timeout.signal }).then(() => {
            throw new Error(
              'TCP-stalled Redis operation exceeded five seconds.',
            );
          }),
        ]);
      } finally {
        timeout.abort();
      }
    }

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert(address && typeof address !== 'string');
      stalled = new BusinessInsightsService(
        new ConfigService({
          AI_INSIGHTS_ENABLED: true,
          REDIS_URL: `redis://127.0.0.1:${address.port}/${redisDb}`,
          GEMINI_MODEL: 'gemini-3.5-flash-lite',
          GEMINI_DAILY_REQUEST_LIMIT: 2,
        }),
        snapshots,
        gemini,
        history,
        eventBus,
      );
      expectedOutageWarnings = true;
      stalled.onApplicationBootstrap();
      const startedAt = performance.now();
      await expect(
        bounded(stalled.create(ids.employee, request())),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'AI_QUEUE_UNAVAILABLE' },
      });
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(acceptedConnections).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith({ event: 'ai.insights.unavailable' });

      const shutdownStartedAt = performance.now();
      shutdown = stalled.onModuleDestroy();
      await bounded(shutdown);
      expect(performance.now() - shutdownStartedAt).toBeLessThan(5_000);
      expect(generate).not.toHaveBeenCalled();
      expect(await queue.getJobs()).toHaveLength(0);
      expect(await redis.get(dailyKey('admissions'))).toBeNull();
      expect(await redis.get(dailyKey('calls'))).toBeNull();
    } finally {
      try {
        tearingDown = true;
        const serverClosed = server.listening
          ? new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            })
          : Promise.resolve();
        for (const socket of sockets) socket.destroy();
        await serverClosed;
        if (stalled) await bounded(shutdown ?? stalled.onModuleDestroy());
        expect(sockets.size).toBe(0);
      } finally {
        expectedOutageWarnings = false;
      }
    }
  });

  it('enforces HTTP authentication, DTO validation, generation permissions and job ownership', async () => {
    assertSafeTargets();
    const roleId = randomUUID();
    const otherEmployeeId = randomUUID();
    const employeeIds = [ids.employee, otherEmployeeId];
    const createdPermissionIds: string[] = [];
    const permissionIds: Record<string, string> = {};
    const previousLogger = new Logger().localInstance;
    const appRedisUrl = new URL(redisUrl.href);
    let app: NestExpressApplication | undefined;

    try {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(BusinessInsightsService)
        .useValue(insights)
        .overrideProvider(ConfigService)
        .useValue(
          new ConfigService({
            ...validateEnvironment(process.env),
            REDIS_URL: appRedisUrl.href,
            OUTBOX_POLL_INTERVAL_MS: 0,
            AI_INSIGHTS_ENABLED: false,
          }),
        )
        .compile();
      app = moduleFixture.createNestApplication<NestExpressApplication>();
      app.useLogger(false);
      initApp(app);
      await app.init();
      expect(app.get(BusinessInsightsService)).toBe(insights);

      await prisma.role.create({
        data: { id: roleId, name: `Insight HTTP role ${suffix}` },
      });
      for (const key of [
        PermissionKeys.REPORTS_READ,
        PermissionKeys.REPORTS_INSIGHTS_GENERATE,
      ]) {
        let permission = await prisma.permission.findFirst({
          where: { key, deletedAt: null },
        });
        if (!permission) {
          permission = await prisma.permission.create({
            data: { key, name: `Insight HTTP ${key} ${suffix}` },
          });
          createdPermissionIds.push(permission.id);
        }
        permissionIds[key] = permission.id;
        await prisma.rolePermission.create({
          data: { roleId, permissionId: permission.id },
        });
      }
      await prisma.employeeRole.create({
        data: { employeeId: ids.employee, roleId },
      });
      const employee = await prisma.employee.findUniqueOrThrow({
        where: { id: ids.employee },
      });
      const sessions = app.get(AuthSessionService);
      const tokens = await sessions.createSession(employee, {
        ipAddress: '127.0.0.1',
        userAgent: 'business-insights-http-test',
      });
      const bearer = `Bearer ${tokens.accessToken}`;
      const api = http
        .agent(app.getHttpServer())
        .set('X-Forwarded-For', `198.18.${randomInt(256)}.${randomInt(256)}`);
      const prefix = app
        .get(ConfigService)
        .get<string>('APP_PREFIX', '/api/v1');
      const url = `${prefix}/reports/insights`;

      await api.get(`${url}/config`).expect(401);
      await api.get(url).expect(401);
      const configuration = await api
        .get(`${url}/config`)
        .set('Authorization', bearer)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      expect(configuration.body).toEqual({
        errors: null,
        message: 'OK',
        data: insights!.getConfiguration(),
      });

      const dto = request();
      // Bearer auth exercises the normal CSRF exemption without disabling the guard.
      const created = await api
        .post(url)
        .set('Authorization', bearer)
        .send(dto)
        .expect(202)
        .expect('Cache-Control', 'no-store');
      expect(created.body).toMatchObject({
        errors: null,
        message: 'OK',
        data: { id: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      const id: unknown = created.body.data?.id;
      assert(typeof id === 'string');
      const result = await terminal(id);
      expect(result.status).toBe('COMPLETED');
      const historyPage = await api
        .get(`${url}?limit=1`)
        .set('Authorization', bearer)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      expect(
        historyPage.body.data.items.map((item: { id: string }) => item.id),
      ).toEqual([id]);
      await api.get(`${url}?limit=51`).set('Authorization', bearer).expect(400);
      await api
        .get(`${url}?employeeId=other`)
        .set('Authorization', bearer)
        .expect(400);
      const completed = await api
        .get(`${url}/${id}`)
        .set('Authorization', bearer)
        .expect(200)
        .expect('Cache-Control', 'no-store');
      expect(completed.body).toEqual({
        errors: null,
        message: 'OK',
        data: result,
      });

      await api
        .post(url)
        .set('Authorization', bearer)
        .send({ ...dto, clientRequestId: 'not-a-uuid' })
        .expect(400);
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId:
              permissionIds[PermissionKeys.REPORTS_INSIGHTS_GENERATE],
          },
        },
      });
      await api
        .post(url)
        .set('Authorization', bearer)
        .send(request())
        .expect(403);
      const stillReadable = await api
        .get(`${url}/${id}`)
        .set('Authorization', bearer)
        .expect(200);
      expect(stillReadable.body).toEqual(completed.body);

      const other = await prisma.employee.create({
        data: {
          id: otherEmployeeId,
          email: `insight-http-${suffix}@example.com`,
          username: `insight-http-${suffix}`,
          fullName: 'Insight HTTP reader',
          password: 'test-only-not-used-for-login',
          positionId: ids.position,
        },
      });
      await prisma.employeeRole.create({
        data: { employeeId: other.id, roleId },
      });
      const otherTokens = await sessions.createSession(other, {
        ipAddress: '127.0.0.1',
        userAgent: 'business-insights-http-test',
      });
      const otherBearer = `Bearer ${otherTokens.accessToken}`;
      await api
        .get(`${url}/config`)
        .set('Authorization', otherBearer)
        .expect(200);
      await api
        .get(`${url}/${id}`)
        .set('Authorization', otherBearer)
        .expect(404);
      const otherHistory = await api
        .get(url)
        .set('Authorization', otherBearer)
        .expect(200);
      expect(otherHistory.body.data).toEqual({ items: [], nextCursor: null });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await redis.get(dailyKey('admissions'))).toBe('1');
    } finally {
      try {
        await app?.close();
      } finally {
        Logger.overrideLogger(previousLogger);
        assertSafeTargets();
        await prisma.$transaction([
          prisma.authSession.deleteMany({
            where: { employeeId: { in: employeeIds } },
          }),
          prisma.employeeRole.deleteMany({ where: { roleId } }),
          prisma.rolePermission.deleteMany({ where: { roleId } }),
          prisma.role.deleteMany({ where: { id: roleId } }),
          prisma.permission.deleteMany({
            where: { id: { in: createdPermissionIds } },
          }),
          prisma.employee.deleteMany({ where: { id: otherEmployeeId } }),
        ]);
      }
    }
  });
});
