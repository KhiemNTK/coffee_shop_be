import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { TelegramDeliveryService } from '../src/app/online-orders/telegram-delivery.service';
import { OutboxDeferredError } from '../src/app/durable/outbox-delivery.error';

describe('Telegram shared rate limit (real Redis)', () => {
  let first: TelegramDeliveryService;
  let second: TelegramDeliveryService;
  let fetchMock: jest.SpyInstance;

  beforeAll(() => {
    const url = new URL(process.env.REDIS_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        Number(url.pathname.slice(1)) > 0,
      'Use a dedicated loopback test Redis DB.',
    );
  });

  beforeEach(() => {
    const config = new ConfigService({
      REDIS_URL: process.env.REDIS_URL,
      TELEGRAM_BOT_TOKEN: `test-bot:${randomUUID()}`,
    });
    first = new TelegramDeliveryService(config);
    second = new TelegramDeliveryService(config);
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }))),
      );
  });

  afterEach(() => {
    first.onModuleDestroy();
    second.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('allows only one sender to reserve the same group slot across instances', async () => {
    const results = await Promise.allSettled([
      first.send('-1001234567890', 'First'),
      second.send('-1001234567890', 'Second'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(failure?.reason).toBeInstanceOf(OutboxDeferredError);
    expect(failure?.reason.retryAfterMs).toBeGreaterThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares Telegram retry_after cooldown across instances and different chats', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 9 },
        }),
        { status: 429 },
      ),
    );
    await expect(first.send('123456', 'First')).rejects.toMatchObject({
      retryAfterMs: 9_100,
    });
    await expect(second.send('654321', 'Second')).rejects.toBeInstanceOf(
      OutboxDeferredError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
