import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

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

  constructor(url: string) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ) {
    const prefix = `throttle:v1:{${key}}`;
    const [totalHits, windowTtl, blockTtl] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${prefix}:hits`,
      `${prefix}:block`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(Math.max(0, windowTtl) / 1_000),
      isBlocked: blockTtl > 0,
      timeToBlockExpire: Math.ceil(Math.max(0, blockTtl) / 1_000),
    };
  }

  disconnect() {
    this.redis.disconnect();
  }
}
