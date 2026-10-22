import { ConfigService } from '@nestjs/config';
import {
  OutboxDeferredError,
  OutboxPermanentError,
} from '../durable/outbox-delivery.error';
import { TelegramDeliveryService } from './telegram-delivery.service';

describe('TelegramDeliveryService', () => {
  let service: TelegramDeliveryService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new TelegramDeliveryService(
      new ConfigService({ TELEGRAM_BOT_TOKEN: '123456789:fake-test-token' }),
    );
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }))),
      );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    ['123456', 1_100],
    ['-100123456', 3_100],
  ])(
    'reserves a per-chat slot before sending (%s)',
    async (chatId, interval) => {
      await service.send(chatId, 'First');
      await expect(service.send(chatId, 'Second')).rejects.toBeInstanceOf(
        OutboxDeferredError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(interval);
      await service.send(chatId, 'Second');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('also throttles a burst across different chats', async () => {
    await service.send('123', 'First');
    await expect(service.send('456', 'Second')).rejects.toBeInstanceOf(
      OutboxDeferredError,
    );
    jest.advanceTimersByTime(40);
    await service.send('456', 'Second');
  });

  it.each([200, 429])(
    'honors retry_after and pauses other chats without logging provider details (HTTP %s)',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 27 },
            description: 'private-provider-details',
          }),
          { status },
        ),
      );
      await expect(service.send('123', 'First')).rejects.toMatchObject({
        retryAfterMs: 27_100,
        message: 'Delivery deferred by rate limit.',
      });
      jest.advanceTimersByTime(2_000);
      await expect(service.send('456', 'Second')).rejects.toMatchObject({
        retryAfterMs: 25_100,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(25_000);
      await service.send('456', 'Second');
    },
  );

  it.each([400, 401, 404])(
    'does not retry permanent delivery errors (%s)',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: 'private-provider-details',
          }),
          { status },
        ),
      );
      await expect(service.send('123', 'First')).rejects.toThrow(
        OutboxPermanentError,
      );
    },
  );

  it('uses a safe fallback cooldown for a malformed 429 response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('proxy failure', { status: 429 }),
    );
    await expect(service.send('123', 'First')).rejects.toMatchObject({
      retryAfterMs: 60_100,
    });
  });

  it.each([0, -1, 'invalid', 999999999])(
    'still defers an API 429 with malformed retry_after (%s)',
    async (retryAfter) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: retryAfter },
          }),
        ),
      );
      await expect(service.send('123', 'First')).rejects.toMatchObject({
        retryAfterMs: 60_100,
      });
    },
  );

  it('does not expose the request URL or token on network failure', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('https://api.telegram.org/botSECRET/sendMessage'),
    );
    await expect(service.send('123', 'First')).rejects.toThrow(
      /^Telegram transport failed\.$/,
    );
  });
});
