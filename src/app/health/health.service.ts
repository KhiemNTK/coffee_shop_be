import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis?: Redis;
  private readonly redisRequired: boolean;
  private redisCheck?: Promise<'up' | 'down'>;
  private stopping = false;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    configService: ConfigService,
  ) {
    const redisUrl = configService.get<string>('REDIS_URL');
    this.redisRequired =
      configService.get<string>('NODE_ENV', 'development') === 'production';
    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 1000,
        disconnectTimeout: 100,
      });
      // Readiness and metrics report dependency failures without reconnect log spam.
      this.redis.on('error', () => undefined);
    }
  }

  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  async readiness() {
    const checks = await Promise.allSettled([
      this.withTimeout(this.prisma.$queryRaw`SELECT 1`, 1500),
      this.redisStatus().then((status) => {
        if (status === 'down') throw new Error('Redis is unavailable');
        return status;
      }),
    ]);
    const databaseReady = checks[0]?.status === 'fulfilled';
    const redisReady = checks[1]?.status === 'fulfilled';

    if (!databaseReady || !redisReady) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_NOT_READY',
        dependencies: {
          database: databaseReady ? 'up' : 'down',
          redis: redisReady ? 'up' : 'down',
        },
      });
    }

    return {
      status: 'ready',
      dependencies: {
        database: 'up',
        redis: this.redis ? 'up' : 'disabled',
      },
    };
  }

  onModuleDestroy() {
    this.stopping = true;
    this.redis?.disconnect();
  }

  async redisStatus(): Promise<'up' | 'down' | 'disabled'> {
    if (!this.redis) {
      return this.redisRequired ? 'down' : 'disabled';
    }
    if (this.stopping) return 'down';
    this.redisCheck ??= this.withTimeout(this.checkRedis(), 1500)
      .then(() => 'up' as const)
      .catch(() => {
        if (!this.stopping) this.redis?.disconnect(true);
        return 'down' as const;
      })
      .finally(() => {
        this.redisCheck = undefined;
      });
    return this.redisCheck;
  }

  private async checkRedis() {
    if (this.redis!.status === 'wait') await this.redis!.connect();
    await this.redis!.ping();
  }

  async redisMemory() {
    const info = await this.withTimeout(this.redis!.info('memory'), 1500);
    const fields = new Map(
      info.split('\r\n').map((line) => line.split(':', 2) as [string, string]),
    );
    const used = Number(fields.get('used_memory'));
    const limit = Number(fields.get('maxmemory'));
    if (
      ![used, limit].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      throw new Error('Invalid Redis memory metrics');
    return { used, limit };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Health check timed out')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
