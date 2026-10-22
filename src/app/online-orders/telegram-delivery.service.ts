import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { z } from 'zod';
import {
  OutboxDeferredError,
  OutboxPermanentError,
} from '../durable/outbox-delivery.error';

const ResponseSchema = z.object({
  ok: z.boolean(),
  error_code: z.number().int().optional(),
  parameters: z
    .object({
      retry_after: z
        .number()
        .int()
        .positive()
        .max(604_800)
        .catch(60)
        .optional(),
    })
    .catch({})
    .optional(),
});

// One atomic reservation across instances; a denied reservation consumes no slot.
const RESERVE_SCRIPT = `
local wait = math.max(redis.call('PTTL', KEYS[1]), redis.call('PTTL', KEYS[2]), redis.call('PTTL', KEYS[3]))
if wait > 0 then return wait end
redis.call('PSETEX', KEYS[2], 40, 1)
redis.call('PSETEX', KEYS[3], ARGV[1], 1)
return 0
`;

@Injectable()
export class TelegramDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramDeliveryService.name);
  private readonly redis?: Redis;
  private readonly prefix: string;
  private connecting?: Promise<void>;
  private readonly localSlots = new Map<string, number>();
  private lastSweepAt = 0;

  constructor(private readonly config: ConfigService) {
    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    this.prefix = `telegram:{${createHash('sha256')
      .update(token ?? '')
      .digest('hex')
      .slice(0, 24)}}`;
    const redisUrl = config.get<string>('REDIS_URL');
    if (token && redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        commandTimeout: 1_000,
        disconnectTimeout: 100,
        enableOfflineQueue: false,
        retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
      });
      this.redis.on('error', () =>
        this.logger.warn('Telegram rate limiter unavailable.'),
      );
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async send(
    chatId: string,
    text: string,
    button?: { text: string; url: string },
  ) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token)
      throw new OutboxPermanentError('Telegram bot is not configured.');
    await this.reserve(chatId);
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            link_preview_options: { is_disabled: true },
            ...(button
              ? { reply_markup: { inline_keyboard: [[button]] } }
              : {}),
          }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      throw new Error('Telegram transport failed.');
    }
    const result = ResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    const code =
      response.ok && result.success
        ? (result.data.error_code ?? response.status)
        : response.status;
    if (response.status === 429 || code === 429) {
      const delay =
        ((result.success ? result.data.parameters?.retry_after : undefined) ??
          60) * 1_000;
      await this.cooldown(delay);
      throw new OutboxDeferredError(delay + 100);
    }
    if (response.status === 403 || code === 403) return false;
    if ([400, 401, 404].includes(code)) {
      throw new OutboxPermanentError(
        `Telegram delivery rejected: code ${code}.`,
      );
    }
    if (!response.ok)
      throw new Error(`Telegram send failed: HTTP ${response.status}`);
    if (!result.success) throw new Error('Telegram send response invalid.');
    if (!result.data.ok) throw new Error('Telegram send rejected.');
    return true;
  }

  private async connect() {
    if (this.redis?.status === 'wait') {
      this.connecting = this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    if (this.connecting) await this.connecting;
  }

  private async reserve(chatId: string) {
    const chatKey = `${this.prefix}:chat:${createHash('sha256').update(chatId).digest('hex')}`;
    const cooldownKey = `${this.prefix}:cooldown`;
    const botKey = `${this.prefix}:bot`;
    const interval = chatId.startsWith('-') ? 3_100 : 1_100;
    let wait: number;
    if (this.redis) {
      try {
        await this.connect();
        wait = Number(
          await this.redis.eval(
            RESERVE_SCRIPT,
            3,
            cooldownKey,
            botKey,
            chatKey,
            interval,
          ),
        );
      } catch {
        throw new Error('Telegram rate limiter unavailable.');
      }
    } else {
      const now = Date.now();
      if (now - this.lastSweepAt > 60_000) {
        for (const [key, expiresAt] of this.localSlots) {
          if (expiresAt <= now) this.localSlots.delete(key);
        }
        this.lastSweepAt = now;
      }
      wait = Math.max(
        0,
        ...[cooldownKey, botKey, chatKey].map(
          (key) => (this.localSlots.get(key) ?? 0) - now,
        ),
      );
      if (wait === 0) {
        this.localSlots.set(botKey, now + 40);
        this.localSlots.set(chatKey, now + interval);
      }
    }
    if (wait > 0) throw new OutboxDeferredError(wait + 100);
  }

  private async cooldown(delay: number) {
    const key = `${this.prefix}:cooldown`;
    if (this.redis) {
      try {
        // Concurrent 429 responses must never shorten an existing cooldown.
        await this.redis.eval(
          `local ttl = redis.call('PTTL', KEYS[1]); if ttl < tonumber(ARGV[1]) then redis.call('PSETEX', KEYS[1], ARGV[1], 1) end; return 1`,
          1,
          key,
          delay,
        );
      } catch {
        throw new Error('Telegram rate limiter unavailable.');
      }
    } else {
      this.localSlots.set(
        key,
        Math.max(this.localSlots.get(key) ?? 0, Date.now() + delay),
      );
    }
  }
}
