import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type {
  BusinessInsightJobData,
  BusinessInsightResult,
} from '../../common/types';
import { CreateBusinessInsightDto } from './dto/business-insight.dto';
import {
  BUSINESS_INSIGHT_MAX_RANGE_DAYS,
  BUSINESS_INSIGHT_PROMPT_VERSION,
  BUSINESS_INSIGHT_RETENTION_DAYS,
} from './business-insight.schema';
import { BusinessInsightSnapshotService } from './business-insight-snapshot.service';
import { GeminiInsightsService } from './gemini-insights.service';
import { buildBusinessInsightAnalysis } from './business-insight.analysis';
import { BUSINESS_INSIGHT_ERROR_CODES } from '../../common/consts/business-insights';
import {
  aiInsightEnabled,
  aiInsightJobDurationSeconds,
  aiInsightJobsTotal,
  aiInsightQueueHeadAgeSeconds,
  aiInsightQueueJobs,
  aiInsightQueueUp,
  metricsCollectionFailuresTotal,
} from '../../common/observability/metrics';

const QUEUE_NAME = 'business-insights';
const RETENTION_SECONDS = BUSINESS_INSIGHT_RETENTION_DAYS * 86_400;
const REDIS_TIMEOUT_MS = 2_000;
const ADMIT_SCRIPT = `
  local previous = redis.call('GET', KEYS[2])
  if previous then
    if previous ~= ARGV[1] then return -2 end
    return 0
  end
  local count = tonumber(redis.call('GET', KEYS[1]) or '0')
  if count >= tonumber(ARGV[2]) then return -1 end
  redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], 172800)
  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
  return 1
`;
const CALL_BUDGET_SCRIPT = `
  local count = tonumber(redis.call('GET', KEYS[1]) or '0')
  if count >= tonumber(ARGV[1]) then return 0 end
  redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], 172800)
  return 1
`;

@Injectable()
export class BusinessInsightsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BusinessInsightsService.name);
  private queue?: Queue<
    BusinessInsightJobData,
    BusinessInsightResult,
    'generate'
  >;
  private worker?: Worker<
    BusinessInsightJobData,
    BusinessInsightResult,
    'generate'
  >;
  private ready?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly snapshots: BusinessInsightSnapshotService,
    private readonly gemini: GeminiInsightsService,
  ) {}

  getConfiguration() {
    return {
      enabled: this.config.get<boolean>('AI_INSIGHTS_ENABLED', false) === true,
      retentionDays: BUSINESS_INSIGHT_RETENTION_DAYS,
      maxRangeDays: BUSINESS_INSIGHT_MAX_RANGE_DAYS,
    };
  }

  onApplicationBootstrap() {
    if (this.getConfiguration().enabled)
      void this.getQueue().catch(() =>
        this.logger.warn({ event: 'ai.insights.unavailable' }),
      );
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.gemini.stop();
    await Promise.all([
      this.closeRedisResource(this.worker, true),
      this.closeRedisResource(this.queue),
    ]);
  }

  async collectMetrics() {
    const enabled = this.getConfiguration().enabled;
    aiInsightEnabled.set(enabled ? 1 : 0);
    aiInsightQueueJobs.reset();
    aiInsightQueueHeadAgeSeconds.set(0);
    if (!enabled) {
      aiInsightQueueUp.set(0);
      return;
    }
    try {
      const queue = await this.getQueue();
      const [counts, heads] = await this.withRedisTimeout(
        Promise.all([
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          // Only read queue heads, never all retained snapshots on a metrics scrape.
          queue.getJobs(['waiting', 'active'], 0, 0, true),
        ]),
      );
      for (const state of ['waiting', 'active', 'delayed', 'failed']) {
        aiInsightQueueJobs.set(
          { state },
          (counts[state] ?? 0) +
            (state === 'waiting' ? (counts.paused ?? 0) : 0),
        );
      }
      const timestamps = heads.flatMap((job) => (job ? [job.timestamp] : []));
      aiInsightQueueHeadAgeSeconds.set(
        timestamps.length
          ? Math.max(0, (Date.now() - Math.min(...timestamps)) / 1_000)
          : 0,
      );
      aiInsightQueueUp.set(1);
    } catch {
      aiInsightQueueUp.set(0);
      metricsCollectionFailuresTotal.inc({ collector: 'ai_insights' });
    }
  }

  async create(employeeId: string, dto: CreateBusinessInsightDto) {
    if (Date.parse(dto.to) > Date.now())
      throw new BadRequestException('Insight period cannot end in the future.');
    const queue = await this.getQueue();
    const id = this.hash(`${employeeId}:${dto.clientRequestId}`);
    const from = new Date(dto.from).toISOString();
    const to = new Date(dto.to).toISOString();
    const requestHash = this.hash(
      JSON.stringify({ from, to, timeZone: dto.timeZone }),
    );
    try {
      const existing = await queue.getJob(id);
      if (existing) {
        if (
          Date.now() - Date.parse(existing.data.requestedAt) >=
          RETENTION_SECONDS * 1_000
        )
          throw new ConflictException('Insight expired. Use a new request ID.');
        if (existing.data.requestHash !== requestHash)
          throw new ConflictException(
            'The same request ID was used for a different period.',
          );
        return await this.present(existing);
      }
      const client = await queue.client;
      client.defineCommand('insightAdmit', {
        numberOfKeys: 2,
        lua: ADMIT_SCRIPT,
      });
      const admission: unknown = await client.runCommand('insightAdmit', [
        `ai:insights:admissions:${new Date().toISOString().slice(0, 10)}`,
        `ai:insights:request:${id}`,
        requestHash,
        this.config.get<number>('GEMINI_DAILY_REQUEST_LIMIT', 20),
        RETENTION_SECONDS,
      ]);
      const admitted = Number(admission);
      if (admitted === -2)
        throw new ConflictException(
          'The same request ID was used for a different period.',
        );
      if (admitted === -1)
        throw new HttpException(
          {
            message: 'Daily AI insight limit reached.',
            code: 'AI_DAILY_LIMIT',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      await queue.add(
        'generate',
        {
          employeeId,
          requestHash,
          from,
          to,
          timeZone: dto.timeZone,
          requestedAt: new Date().toISOString(),
          model: this.config.getOrThrow<string>('GEMINI_MODEL'),
          promptVersion: BUSINESS_INSIGHT_PROMPT_VERSION,
        },
        {
          jobId: id,
          attempts: 2,
          backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
          removeOnComplete: { age: RETENTION_SECONDS, count: 700 },
          removeOnFail: { age: RETENTION_SECONDS, count: 700 },
        },
      );
      const stored = await queue.getJob(id);
      if (!stored)
        throw new ServiceUnavailableException('AI_QUEUE_UNAVAILABLE');
      return await this.present(stored);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        message: 'AI_QUEUE_UNAVAILABLE',
        code: 'AI_QUEUE_UNAVAILABLE',
      });
    }
  }

  async get(employeeId: string, id: string) {
    const queue = await this.getQueue();
    try {
      const job = await queue.getJob(id);
      if (
        !job ||
        job.data.employeeId !== employeeId ||
        Date.now() - Date.parse(job.data.requestedAt) >=
          RETENTION_SECONDS * 1_000
      )
        throw new NotFoundException('Insight not found or expired.');
      return await this.present(job);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        message: 'AI_QUEUE_UNAVAILABLE',
        code: 'AI_QUEUE_UNAVAILABLE',
      });
    }
  }

  async process(
    job: Job<BusinessInsightJobData, BusinessInsightResult, 'generate'>,
  ): Promise<BusinessInsightResult> {
    if (job.data.promptVersion !== BUSINESS_INSIGHT_PROMPT_VERSION)
      throw new UnrecoverableError('AI_VERSION_CHANGED');
    const requestedAt = Date.parse(job.data.requestedAt);
    if (
      !Number.isFinite(requestedAt) ||
      Date.now() - requestedAt >= RETENTION_SECONDS * 1_000
    )
      throw new UnrecoverableError('AI_JOB_EXPIRED');
    if (!job.data.snapshot) {
      const snapshot = await this.snapshots.capture(job.data.from, job.data.to);
      await job.updateData({ ...job.data, snapshot });
    }
    const snapshot = job.data.snapshot!;
    if (
      snapshot.metrics.find((metric) => metric.key === 'paidInvoiceCount')
        ?.value === '0'
    ) {
      return {
        snapshot,
        analysis: buildBusinessInsightAnalysis(snapshot),
      };
    }
    const client = await this.queue!.client;
    client.defineCommand('insightCallBudget', {
      numberOfKeys: 1,
      lua: CALL_BUDGET_SCRIPT,
    });
    const budget: unknown = await client.runCommand('insightCallBudget', [
      `ai:insights:calls:${new Date().toISOString().slice(0, 10)}`,
      this.config.get<number>('GEMINI_DAILY_REQUEST_LIMIT', 20),
    ]);
    const granted = Number(budget);
    if (!granted) throw new UnrecoverableError('AI_DAILY_LIMIT');
    const suggestions = await this.gemini.generate(snapshot, job.data.model);
    return {
      snapshot,
      analysis: buildBusinessInsightAnalysis(snapshot, suggestions),
    };
  }

  private async getQueue() {
    if (!this.getConfiguration().enabled)
      throw new ServiceUnavailableException({
        message: 'AI_DISABLED',
        code: 'AI_DISABLED',
      });
    try {
      await this.withRedisTimeout(this.ensureReady());
    } catch {
      throw new ServiceUnavailableException({
        message: 'AI_QUEUE_UNAVAILABLE',
        code: 'AI_QUEUE_UNAVAILABLE',
      });
    }
    return this.queue!;
  }

  private ensureReady(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Stopping'));
    if (this.ready) return this.ready;
    if (!this.queue) {
      const url = new URL(this.config.getOrThrow<string>('REDIS_URL'));
      const connection = {
        host: url.hostname,
        port: Number(url.port || 6379),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: Number(url.pathname.slice(1) || 0),
        connectTimeout: 1_000,
        ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      };
      this.queue = new Queue(QUEUE_NAME, {
        connection: {
          ...connection,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          commandTimeout: REDIS_TIMEOUT_MS,
        },
      });
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 1,
        limiter: { max: 1, duration: 1_000 },
        autorun: false,
      });
      this.queue.on('error', () =>
        this.logger.warn({ event: 'ai.insights.queue_error' }),
      );
      this.worker.on('error', () =>
        this.logger.warn({ event: 'ai.insights.worker_error' }),
      );
      this.worker.on('completed', (job) => this.recordJobOutcome(job));
      this.worker.on('failed', (job, error) =>
        this.recordJobOutcome(job, error),
      );
    }
    this.ready = this.queue
      .setGlobalConcurrency(1)
      .then(() => {
        if (!this.stopping && !this.worker!.isRunning())
          void this.worker!.run().catch(() =>
            this.logger.warn({ event: 'ai.insights.worker_stopped' }),
          );
      })
      .catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }

  private async present(
    job: Job<BusinessInsightJobData, BusinessInsightResult, 'generate'>,
  ) {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      // State can change after getJob; terminal fields must come from a fresh read.
      const latest = await this.queue!.getJob(job.id!);
      if (!latest) throw new NotFoundException('Insight not found or expired.');
      job = latest;
    }
    const obsolete = job.data.promptVersion !== BUSINESS_INSIGHT_PROMPT_VERSION;
    const status = obsolete
      ? 'FAILED'
      : state === 'completed' && job.returnvalue
        ? 'COMPLETED'
        : state === 'failed'
          ? 'FAILED'
          : state === 'active'
            ? 'PROCESSING'
            : 'QUEUED';
    return {
      id: job.id!,
      status,
      requestedAt: job.data.requestedAt,
      model: job.data.model,
      promptVersion: job.data.promptVersion,
      period: {
        from: job.data.from,
        to: job.data.to,
        timeZone: job.data.timeZone,
      },
      snapshot: obsolete
        ? null
        : status === 'COMPLETED'
          ? job.returnvalue.snapshot
          : (job.data.snapshot ?? null),
      analysis: status === 'COMPLETED' ? job.returnvalue.analysis : null,
      errorCode: obsolete
        ? 'AI_VERSION_CHANGED'
        : status === 'FAILED'
          ? this.errorCode(job.failedReason)
          : null,
    };
  }

  private errorCode(reason: string) {
    return (
      BUSINESS_INSIGHT_ERROR_CODES.find((code) => code === reason) ??
      'AI_JOB_FAILED'
    );
  }

  private recordJobOutcome(
    job:
      | Job<BusinessInsightJobData, BusinessInsightResult, 'generate'>
      | undefined,
    error?: Error,
  ) {
    if (!job) return;
    // BullMQ sets finishedOn only after a terminal transition, including permanent errors.
    const outcome = error
      ? job.finishedOn === undefined
        ? 'retry'
        : 'failed'
      : 'completed';
    const errorCode = error ? this.errorCode(error.message) : 'NONE';
    aiInsightJobsTotal.inc({ outcome, error_code: errorCode });
    if (outcome !== 'retry' && job.finishedOn !== undefined)
      aiInsightJobDurationSeconds.observe(
        { outcome },
        Math.max(0, (job.finishedOn - job.timestamp) / 1_000),
      );
    if (error)
      this.logger.warn({
        event: 'ai.insights.failed',
        jobId: job.id,
        outcome,
        errorCode,
        attempts: job.attemptsMade,
      });
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async closeRedisResource(
    resource?: {
      close(force?: boolean): Promise<void>;
      disconnect(): Promise<void>;
    },
    force = false,
  ) {
    if (!resource) return;
    try {
      await this.withRedisTimeout(resource.close(force));
    } catch {
      this.logger.warn({ event: 'ai.insights.force_disconnect' });
      await this.withRedisTimeout(resource.disconnect()).catch(() =>
        this.logger.warn({ event: 'ai.insights.disconnect_failed' }),
      );
    }
  }

  private async withRedisTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis operation timed out')),
            REDIS_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
