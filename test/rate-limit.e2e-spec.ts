import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { RedisThrottlerStorage } from '../src/common/security/redis-throttler.storage';

describe('Distributed rate limit (e2e)', () => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const first = new RedisThrottlerStorage(redisUrl);
  const second = new RedisThrottlerStorage(redisUrl);

  afterAll(() => {
    first.disconnect();
    second.disconnect();
  });

  it('shares atomic counters between instances and expires a block', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? first : second).increment(key, 1_000, 3, 1_000),
      ),
    );
    expect(
      results.map((result) => result.totalHits).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.filter((result) => !result.isBlocked)).toHaveLength(3);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(first.increment(key, 1_000, 3, 1_000)).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it('fails closed when configured Redis is unreachable', async () => {
    const unavailable = new RedisThrottlerStorage('redis://127.0.0.1:1');
    try {
      await expect(
        unavailable.increment(randomUUID(), 1_000, 1, 1_000),
      ).rejects.toThrow();
    } finally {
      unavailable.disconnect();
    }
  });
});
