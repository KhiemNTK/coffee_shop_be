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
      });
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
    this.redis?.disconnect();
  }

  async redisStatus(): Promise<'up' | 'down' | 'disabled'> {
    if (!this.redis) {
      return this.redisRequired ? 'down' : 'disabled';
    }
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.withTimeout(this.redis.ping(), 1500);
      return 'up';
    } catch {
      return 'down';
    }
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
