import type { ThrottlerStorage } from '@nestjs/throttler';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { rateLimitUnavailableTotal } from '../observability/metrics';

const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local windowTtl = redis.call('PTTL', KEYS[1])
local blockTtl = redis.call('PTTL', KEYS[2])
if hits > tonumber(ARGV[2]) and blockTtl < 0 then
  redis.call('PSETEX', KEYS[2], ARGV[3], 1)
  blockTtl = tonumber(ARGV[3])
end
return { hits, windowTtl, blockTtl }
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;
  private connecting?: Promise<void>;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      // ioredis also schedules cleanup for an already-closed socket.
      disconnectTimeout: 100,
      commandTimeout: 1_000,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });
    this.redis.on('error', () => {
      Logger.warn('Rate limiter Redis connection failed.', 'RedisThrottler');
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ) {
    const prefix = `throttle:v1:{${key}}`;
    const [totalHits, windowTtl, blockTtl] = (await this.incrementRedis(
      prefix,
      ttl,
      limit,
      blockDuration,
    ).catch(() => {
      rateLimitUnavailableTotal.inc();
      throw new ServiceUnavailableException({
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Rate limiting is temporarily unavailable. Please retry.',
      });
    })) as [number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(Math.max(0, windowTtl) / 1_000),
      isBlocked: blockTtl > 0,
      timeToBlockExpire: Math.ceil(Math.max(0, blockTtl) / 1_000),
    };
  }

  private async incrementRedis(
    prefix: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ) {
    if (this.redis.status === 'wait') {
      this.connecting = this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    if (this.connecting) await this.connecting;
    return this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${prefix}:hits`,
      `${prefix}:block`,
      ttl,
      limit,
      blockDuration,
    );
  }

  disconnect() {
    this.redis.disconnect();
  }
}
