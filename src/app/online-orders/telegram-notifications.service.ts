import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlineOrderStatus, ServeStatus } from '@prisma/client';
import { z } from 'zod';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import { OutboxService } from '../durable/outbox.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import {
  ONLINE_ORDER_ACCESS_WINDOW_MS,
  ONLINE_ORDER_TELEGRAM_EVENT,
  ONLINE_ORDER_TELEGRAM_READY_EVENT,
} from './telegram-events';

const UpdateSchema = z.object({
  message: z.object({
    chat: z.object({ id: z.number().int().safe(), type: z.literal('private') }),
    from: z.object({ id: z.number().int().safe() }),
    text: z.string().max(256),
  }),
});
const SendResponseSchema = z.object({
  ok: z.boolean(),
  error_code: z.number().int().optional(),
});
const StatusEventSchema = z.object({
  requestId: z.uuid(),
  status: z.enum([
    OnlineOrderStatus.ACCEPTED,
    OnlineOrderStatus.REJECTED,
    OnlineOrderStatus.CANCELLED,
  ]),
});
const ItemEventSchema = z.object({
  orderSessionId: z.uuid(),
  tableId: z.uuid().nullable(),
  currentStatus: z.enum([
    ServeStatus.PENDING,
    ServeStatus.COOKING,
    ServeStatus.READY,
    ServeStatus.SERVED,
    ServeStatus.CANCELLED,
  ]),
});
const ReadyEventSchema = z.object({ requestId: z.uuid() });

@Injectable()
export class TelegramNotificationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramNotificationsService.name);
  private readonly botToken?: string;
  private readonly webhookSecret?: string;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly config: ConfigService,
    private readonly eventBus: DomainEventBusService,
    private readonly outbox: OutboxService,
  ) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN');
    this.webhookSecret = config.get<string>('TELEGRAM_WEBHOOK_SECRET');
  }

  onModuleInit() {
    if (!this.botToken) return;
    this.unsubscribe.push(
      this.eventBus.on(ONLINE_ORDER_TELEGRAM_EVENT, (payload) =>
        this.notifyStatus(payload),
      ),
      this.eventBus.on(ORDER_EVENTS.ITEM_STATUS_UPDATED, (payload) =>
        this.queueReady(payload),
      ),
      this.eventBus.on(ONLINE_ORDER_TELEGRAM_READY_EVENT, (payload) =>
        this.notifyReady(payload),
      ),
    );
  }

  onModuleDestroy() {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  async receiveWebhook(secret: string | undefined, body: unknown) {
    if (!this.webhookSecret) throw new NotFoundException();
    const expected = Buffer.from(this.webhookSecret);
    const received = Buffer.from(secret ?? '');
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) return { ok: true };
    const { chat, from, text } = parsed.data.message;
    if (chat.id !== from.id) return { ok: true };
    const chatId = String(chat.id);
    if (text === '/stop') {
      await this.prisma.onlineOrderRequest.updateMany({
        where: { telegramChatId: chatId },
        data: { telegramChatId: null },
      });
      await this.acknowledge(chatId, 'Da tat thong bao don hang.');
      return { ok: true };
    }
    const match = /^\/start ([A-Za-z0-9_-]{43})$/.exec(text);
    if (!match) return { ok: true };
    const hash = createHash('sha256').update(match[1]).digest('hex');
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { telegramLinkTokenHash: hash },
      select: { id: true },
    });
    const linked =
      request &&
      (await this.prisma.onlineOrderRequest.updateMany({
        where: {
          id: request.id,
          telegramLinkTokenHash: hash,
          telegramLinkExpiresAt: { gt: new Date() },
          createdAt: {
            gt: new Date(Date.now() - ONLINE_ORDER_ACCESS_WINDOW_MS),
          },
          telegramChatId: null,
          OR: [
            { status: OnlineOrderStatus.ACCEPTED },
            {
              status: OnlineOrderStatus.PENDING,
              expiresAt: { gt: new Date() },
            },
          ],
        },
        data: {
          telegramChatId: chatId,
          telegramLinkTokenHash: null,
          telegramLinkExpiresAt: null,
        },
      }));
    let confirmation = 'Lien ket khong hop le hoac da het han.';
    if (linked?.count === 1) {
      const current = await this.prisma.onlineOrderRequest.findUnique({
        where: { id: request!.id },
        select: {
          status: true,
          orderSession: {
            select: { orderItems: { select: { serveStatus: true } } },
          },
        },
      });
      const active = (current?.orderSession?.orderItems ?? []).filter(
        (item) => item.serveStatus !== ServeStatus.CANCELLED,
      );
      const ready =
        active.length > 0 &&
        active.every(
          (item) =>
            item.serveStatus === ServeStatus.READY ||
            item.serveStatus === ServeStatus.SERVED,
        );
      const reference = request!.id.slice(0, 8).toUpperCase();
      confirmation = ready
        ? `Da bat thong bao. Don ${reference} da san sang de nhan va thanh toan.`
        : current?.status === OnlineOrderStatus.ACCEPTED
          ? `Da bat thong bao. Quan da xac nhan don ${reference}.`
          : `Da bat thong bao. Don ${reference} dang cho quan xac nhan.`;
    }
    await this.acknowledge(chatId, confirmation);
    return { ok: true };
  }

  private async acknowledge(chatId: string, text: string) {
    try {
      await this.send(chatId, text);
    } catch {
      this.logger.warn('Telegram acknowledgement failed.');
    }
  }

  private async notifyStatus(payload: unknown) {
    const event = StatusEventSchema.safeParse(payload);
    if (!event.success) return;
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: event.data.requestId },
      select: {
        status: true,
        telegramChatId: true,
        telegramReadyQueuedAt: true,
        noShowAt: true,
      },
    });
    if (!request?.telegramChatId || request.status !== event.data.status)
      return;
    if (
      event.data.status === OnlineOrderStatus.ACCEPTED &&
      request.telegramReadyQueuedAt
    )
      return;
    const text = {
      ACCEPTED: 'Don mang di da duoc quan xac nhan.',
      REJECTED:
        'Don mang di khong duoc quan xac nhan. Vui long xem trang theo doi don.',
      CANCELLED: request.noShowAt
        ? 'Da qua thoi gian nhan mon. Quan da huy don va ghi nhan khong den nhan.'
        : 'Don mang di da bi huy. Vui long xem trang theo doi don.',
    }[event.data.status];
    const sent = await this.send(
      request.telegramChatId,
      `Don ${event.data.requestId.slice(0, 8).toUpperCase()}: ${text}`,
    );
    if (!sent) await this.unsubscribeChat(request.telegramChatId);
  }

  private async queueReady(payload: unknown) {
    const event = ItemEventSchema.safeParse(payload);
    if (
      !event.success ||
      event.data.currentStatus !== ServeStatus.READY ||
      event.data.tableId !== null
    )
      return;
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { orderSessionId: event.data.orderSessionId },
      select: {
        id: true,
        status: true,
        telegramChatId: true,
        telegramReadyQueuedAt: true,
        orderSession: {
          select: { orderItems: { select: { serveStatus: true } } },
        },
      },
    });
    const items = request?.orderSession?.orderItems ?? [];
    const active = items.filter(
      (item) => item.serveStatus !== ServeStatus.CANCELLED,
    );
    if (
      request?.status !== OnlineOrderStatus.ACCEPTED ||
      !request.telegramChatId ||
      request.telegramReadyQueuedAt ||
      active.length === 0 ||
      !active.some((item) => item.serveStatus === ServeStatus.READY) ||
      active.some(
        (item) =>
          item.serveStatus !== ServeStatus.READY &&
          item.serveStatus !== ServeStatus.SERVED,
      )
    )
      return;

    await this.prisma.$transaction(async (tx) => {
      const queued = await tx.onlineOrderRequest.updateMany({
        where: {
          id: request.id,
          status: OnlineOrderStatus.ACCEPTED,
          telegramChatId: request.telegramChatId,
          telegramReadyQueuedAt: null,
        },
        data: { telegramReadyQueuedAt: new Date() },
      });
      if (queued.count !== 1) return;
      await this.outbox.enqueue(tx, {
        topic: 'order',
        eventName: ONLINE_ORDER_TELEGRAM_READY_EVENT,
        aggregateType: 'OnlineOrderRequest',
        aggregateId: request.id,
        payload: { requestId: request.id },
      });
    });
  }

  private async notifyReady(payload: unknown) {
    const event = ReadyEventSchema.safeParse(payload);
    if (!event.success) return;
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: event.data.requestId },
      select: {
        status: true,
        telegramChatId: true,
        orderSession: {
          select: { orderItems: { select: { serveStatus: true } } },
        },
      },
    });
    if (
      request?.status !== OnlineOrderStatus.ACCEPTED ||
      !request.telegramChatId
    )
      return;
    const active = (request.orderSession?.orderItems ?? []).filter(
      (item) => item.serveStatus !== ServeStatus.CANCELLED,
    );
    if (
      active.length === 0 ||
      !active.some((item) => item.serveStatus === ServeStatus.READY) ||
      active.some(
        (item) =>
          item.serveStatus !== ServeStatus.READY &&
          item.serveStatus !== ServeStatus.SERVED,
      )
    )
      return;
    const sent = await this.send(
      request.telegramChatId,
      `Don ${event.data.requestId.slice(0, 8).toUpperCase()} da san sang. Vui long den quan nhan mon va thanh toan.`,
    );
    if (!sent) await this.unsubscribeChat(request.telegramChatId);
  }

  private async unsubscribeChat(chatId: string) {
    await this.prisma.onlineOrderRequest.updateMany({
      where: { telegramChatId: chatId },
      data: { telegramChatId: null },
    });
  }

  private async send(chatId: string, text: string) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      throw new Error('Telegram transport failed.');
    }
    if (response.status === 403) return false;
    if (!response.ok)
      throw new Error(`Telegram send failed: HTTP ${response.status}`);
    const result = SendResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!result.success) throw new Error('Telegram send response invalid.');
    if (!result.data.ok) {
      if (result.data.error_code === 403) return false;
      throw new Error('Telegram send rejected.');
    }
    return true;
  }
}
