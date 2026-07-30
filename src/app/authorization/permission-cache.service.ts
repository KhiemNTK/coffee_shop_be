import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AuthorizationContext } from '../../common/types';

interface CacheRecord {
  expiresAt: number;
  value: AuthorizationContext;
}

@Injectable()
export class PermissionCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(PermissionCacheService.name);
  private readonly ttlSeconds = 60;
  private readonly keyPrefix = 'authz:employee:';
  private readonly memoryCache = new Map<string, CacheRecord>();
  private readonly redis?: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) return;

    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.connect().catch((error) => {
      this.logger.warn(`Redis permission cache disabled: ${error.message}`);
    });
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async get(employeeId: string): Promise<AuthorizationContext | null> {
    const key = this.getKey(employeeId);

    if (this.redis?.status === 'ready') {
      const cached = await this.redis.get(key);
      return cached ? (JSON.parse(cached) as AuthorizationContext) : null;
    }

    const cached = this.memoryCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    return cached.value;
  }

  async set(employeeId: string, value: AuthorizationContext) {
    const key = this.getKey(employeeId);

    if (this.redis?.status === 'ready') {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
      return;
    }

    this.memoryCache.set(key, {
      expiresAt: Date.now() + this.ttlSeconds * 1000,
      value,
    });
  }

  async invalidateEmployee(employeeId: string) {
    const key = this.getKey(employeeId);
    this.memoryCache.delete(key);

    if (this.redis?.status === 'ready') {
      await this.redis.del(key);
    }
  }

  async invalidateAll() {
    this.memoryCache.clear();

    if (this.redis?.status !== 'ready') return;

    const stream = this.redis.scanStream({
      match: `${this.keyPrefix}*`,
      count: 100,
    }) as AsyncIterable<string[]>;

    for await (const keys of stream) {
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    }
  }

  private getKey(employeeId: string) {
    return `${this.keyPrefix}${employeeId}`;
  }
}
