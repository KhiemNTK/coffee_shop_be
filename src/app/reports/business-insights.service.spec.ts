import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PermissionKeys } from '../../common/consts/permission-keys';
import type {
  BusinessInsightJobData,
  BusinessInsightResult,
  BusinessInsightSnapshot,
} from '../../common/types';
import { REQUIRED_PERMISSIONS_KEY } from '../authorization/authorization.decorator';
import { BusinessInsightsController } from './business-insights.controller';
import { BusinessInsightsService } from './business-insights.service';
import { BusinessInsightSnapshotService } from './business-insight-snapshot.service';
import { GeminiInsightsService } from './gemini-insights.service';
import { CreateBusinessInsightSchema } from './dto/business-insight.dto';

describe('BusinessInsightsService', () => {
  const employeeId = randomUUID();
  const dto = {
    clientRequestId: randomUUID(),
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-02T00:00:00.000Z',
    timeZone: 'Asia/Ho_Chi_Minh' as const,
  };
  const config = new ConfigService({
    AI_INSIGHTS_ENABLED: true,
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_DAILY_REQUEST_LIMIT: 2,
  });
  const snapshots = { capture: jest.fn() };
  const gemini = { generate: jest.fn(), stop: jest.fn() };
  const client = { defineCommand: jest.fn(), runCommand: jest.fn() };
  const queue = {
    client: Promise.resolve(client),
    getJob: jest.fn(),
    add: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  let service: BusinessInsightsService;
  const jobFor = (data: BusinessInsightJobData, id: string) =>
    ({
      id,
      data,
      getState: jest.fn().mockResolvedValue('waiting'),
      failedReason: '',
      returnvalue: null,
    }) as unknown as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BusinessInsightsService(
      config,
      snapshots as unknown as BusinessInsightSnapshotService,
      gemini as unknown as GeminiInsightsService,
    );
    Reflect.set(service, 'queue', queue);
    Reflect.set(service, 'ready', Promise.resolve());
    client.runCommand.mockResolvedValue(1);
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockImplementation(
      (
        _name: string,
        data: BusinessInsightJobData,
        options: { jobId: string },
      ) => {
        const job = jobFor(data, options.jobId);
        queue.getJob.mockResolvedValue(job);
        return Promise.resolve(job);
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('requires read and generation permission, not a role-name bypass', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        Reflect.get(BusinessInsightsController.prototype, 'create'),
      ),
    ).toEqual([
      PermissionKeys.REPORTS_READ,
      PermissionKeys.REPORTS_INSIGHTS_GENERATE,
    ]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        Reflect.get(BusinessInsightsController.prototype, 'get'),
      ),
    ).toEqual([PermissionKeys.REPORTS_READ]);
  });

  it('rejects invalid ranges and unknown client properties at the trust boundary', () => {
    expect(CreateBusinessInsightSchema.safeParse(dto).success).toBe(true);
    expect(
      CreateBusinessInsightSchema.safeParse({ ...dto, to: dto.from }).success,
    ).toBe(false);
    expect(
      CreateBusinessInsightSchema.safeParse({
        ...dto,
        to: '2026-03-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      CreateBusinessInsightSchema.safeParse({ ...dto, sql: 'SELECT *' })
        .success,
    ).toBe(false);
  });

  it('is disabled by default and does not enqueue work', async () => {
    const disabled = new BusinessInsightsService(
      new ConfigService(),
      snapshots as unknown as BusinessInsightSnapshotService,
      gemini as unknown as GeminiInsightsService,
    );
    expect(disabled.getConfiguration().enabled).toBe(false);
    await expect(disabled.create(employeeId, dto)).rejects.toThrow(
      'AI_DISABLED',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([false, 'false', 'true'])(
    'fails closed for an unvalidated enable flag %j',
    (enabled) => {
      const disabled = new BusinessInsightsService(
        new ConfigService({ AI_INSIGHTS_ENABLED: enabled }),
        snapshots as unknown as BusinessInsightSnapshotService,
        gemini as unknown as GeminiInsightsService,
      );
      expect(disabled.getConfiguration().enabled).toBe(false);
    },
  );

  it('queues a bounded versioned job and reuses a stable request ID', async () => {
    const response = await service.create(employeeId, dto);
    const created = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    expect(response).toMatchObject({
      status: 'QUEUED',
      snapshot: null,
      analysis: null,
    });
    expect(created.id).toBe(
      createHash('sha256')
        .update(`${employeeId}:${dto.clientRequestId}`)
        .digest('hex'),
    );
    queue.getJob.mockResolvedValue(created);
    await expect(service.create(employeeId, dto)).resolves.toEqual(response);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2]).toMatchObject({
      attempts: 2,
      removeOnComplete: { age: 604800 },
    });
    await expect(
      service.create(employeeId, { ...dto, from: '2025-12-31T00:00:00.000Z' }),
    ).rejects.toThrow('different period');
  });

  it('rejects exhausted quota and queue outage with no provider calls', async () => {
    client.runCommand.mockResolvedValueOnce(-1);
    await expect(service.create(employeeId, dto)).rejects.toMatchObject({
      status: 429,
    });
    client.runCommand.mockRejectedValueOnce(
      new Error('redis-credential-in-error'),
    );
    await expect(service.create(employeeId, dto)).rejects.toThrow(
      'AI_QUEUE_UNAVAILABLE',
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(gemini.generate).not.toHaveBeenCalled();
  });

  it('does not reveal another employee job', async () => {
    await service.create(employeeId, dto);
    const created = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    queue.getJob.mockResolvedValue(created);
    await expect(service.get(randomUUID(), created.id!)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('hides obsolete results instead of presenting them under the new contract', async () => {
    await service.create(employeeId, dto);
    const created = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    created.data.promptVersion = 'business-finance-v1';
    jest.spyOn(created, 'getState').mockResolvedValue('completed');
    queue.getJob.mockResolvedValue(created);
    await expect(service.get(employeeId, created.id!)).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_VERSION_CHANGED',
      snapshot: null,
      analysis: null,
    });
    await expect(service.process(created)).rejects.toThrow(
      'AI_VERSION_CHANGED',
    );
    expect(snapshots.capture).not.toHaveBeenCalled();
    expect(gemini.generate).not.toHaveBeenCalled();
  });

  it('reuses a frozen no-sales snapshot without consuming provider budget', async () => {
    await service.create(employeeId, dto);
    const created = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    const snapshot: BusinessInsightSnapshot = {
      schemaVersion: 2,
      asOf: dto.to,
      currentPeriod: { from: dto.from, to: dto.to },
      comparisonPeriod: { from: '2025-12-31T00:00:00.000Z', to: dto.from },
      timeZone: dto.timeZone,
      comparisonBasis: 'PREVIOUS_EQUAL_DURATION',
      basis: {
        sales: 'INVOICE_CREATED_AT',
        refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
        waste: 'WASTE_CREATED_AT',
      },
      metrics: [
        {
          key: 'paidInvoiceCount',
          label: 'Hoa don',
          unit: 'COUNT',
          value: '0',
          previousValue: '1',
        },
      ],
    };
    created.data.snapshot = snapshot;
    client.runCommand.mockClear();
    await expect(service.process(created)).resolves.toMatchObject({
      snapshot,
      analysis: {
        findings: [
          { kind: 'OBSERVATION', detail: 'Hoa don thap hon ky so sanh.' },
        ],
      },
    });
    expect(snapshots.capture).not.toHaveBeenCalled();
    expect(client.runCommand).not.toHaveBeenCalled();
    expect(gemini.generate).not.toHaveBeenCalled();
  });

  it('bounds initial Redis readiness without enqueueing or exposing connection errors', async () => {
    jest.useFakeTimers();
    Reflect.set(service, 'ready', new Promise<void>(() => {}));
    const result = expect(
      service.create(employeeId, dto),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'AI_QUEUE_UNAVAILABLE' },
    });
    await jest.advanceTimersByTimeAsync(2_000);
    await result;
    expect(queue.add).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts Gemini and force-disconnects a stalled Redis close within a deadline', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const worker = {
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    Reflect.set(service, 'worker', worker);
    queue.close.mockReturnValueOnce(new Promise<void>(() => {}));
    const closing = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(gemini.stop).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(queue.disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'ai.insights.force_disconnect',
    });
    expect(jest.getTimerCount()).toBe(0);
    await expect(service.create(employeeId, dto)).rejects.toThrow(
      'AI_QUEUE_UNAVAILABLE',
    );
  });

  it('reloads terminal fields when a worker finishes between the job and state reads', async () => {
    await service.create(employeeId, dto);
    const stale = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    jest.spyOn(stale, 'getState').mockResolvedValue('failed');
    const latest = jobFor(stale.data, stale.id!);
    latest.failedReason = 'AI_PROVIDER_UNAVAILABLE';
    queue.getJob.mockResolvedValueOnce(stale).mockResolvedValueOnce(latest);
    await expect(service.get(employeeId, stale.id!)).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });
  });

  it('sanitizes unexpected failed-job details', async () => {
    await service.create(employeeId, dto);
    const created = (await queue.add.mock.results[0].value) as Job<
      BusinessInsightJobData,
      BusinessInsightResult,
      'generate'
    >;
    jest.spyOn(created, 'getState').mockResolvedValue('failed');
    created.failedReason = 'private database credentials';
    queue.getJob.mockResolvedValue(created);
    await expect(service.get(employeeId, created.id!)).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_JOB_FAILED',
      analysis: null,
    });
  });
});
