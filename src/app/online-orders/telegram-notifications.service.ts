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
import { OutboxPermanentError } from '../durable/outbox-delivery.error';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import {
  ONLINE_ORDER_TELEGRAM_EVENT,
  ONLINE_ORDER_TELEGRAM_READY_EVENT,
  ONLINE_ORDER_TELEGRAM_STAFF_EVENT,
} from './telegram-events';
import {
  ONLINE_ORDER_ACCESS_WINDOW_MS,
  PICKUP_ACCESS_GRACE_MS,
} from './online-order-access';

const UpdateSchema = z.object({
  message: z.object({
    chat: z.object({ id: z.number().int().safe(), type: z.literal('private') }),
    from: z.object({ id: z.number().int().safe() }),
    text: z.string().max(256),
  }),
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
    private readonly delivery: TelegramDeliveryService,
  ) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN');
    this.webhookSecret = config.get<string>('TELEGRAM_WEBHOOK_SECRET');
  }

  onModuleInit() {
    if (!this.botToken) return;
    if (this.webhookSecret) {
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
    if (this.config.get<string>('TELEGRAM_STAFF_CHAT_ID')) {
      this.unsubscribe.push(
        this.eventBus.on(ONLINE_ORDER_TELEGRAM_STAFF_EVENT, (payload) =>
          this.notifyStaff(payload),
        ),
      );
    }
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
      await this.acknowledge(chatId, 'Đã tắt thông báo đơn hàng.');
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
          telegramChatId: null,
          AND: [
            {
              OR: [
                {
                  createdAt: {
                    gt: new Date(Date.now() - ONLINE_ORDER_ACCESS_WINDOW_MS),
                  },
                },
                {
                  pickupAt: {
                    gt: new Date(Date.now() - PICKUP_ACCESS_GRACE_MS),
                  },
                },
              ],
            },
            {
              OR: [
                { status: OnlineOrderStatus.ACCEPTED },
                {
                  status: OnlineOrderStatus.PENDING,
                  expiresAt: { gt: new Date() },
                },
              ],
            },
          ],
        },
        data: {
          telegramChatId: chatId,
          telegramLinkTokenHash: null,
          telegramLinkExpiresAt: null,
        },
      }));
    let confirmation = 'Liên kết không hợp lệ hoặc đã hết hạn.';
    let button: { text: string; url: string } | undefined;
    if (linked?.count === 1) {
      const current = await this.prisma.onlineOrderRequest.findUnique({
        where: { id: request!.id },
        select: {
          customerId: true,
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
        active.some((item) => item.serveStatus === ServeStatus.READY) &&
        active.every(
          (item) =>
            item.serveStatus === ServeStatus.READY ||
            item.serveStatus === ServeStatus.SERVED,
        );
      const reference = request!.id.slice(0, 8).toUpperCase();
      if (current?.status === OnlineOrderStatus.ACCEPTED) {
        confirmation = ready
          ? `Đã bật thông báo. Đơn #${reference} đã sẵn sàng. Mời bạn đến quầy nhận món và thanh toán.`
          : `Đã bật thông báo. Quán đã xác nhận đơn #${reference}. Vui lòng theo dõi trạng thái trước khi đến nhận.`;
      } else if (current?.status === OnlineOrderStatus.PENDING) {
        confirmation = `Đã bật thông báo. Đơn #${reference} đang chờ quán xác nhận, chưa bắt đầu chế biến.`;
      } else {
        confirmation = `Trạng thái đơn #${reference} đã thay đổi. Vui lòng kiểm tra lại trên trang theo dõi đơn.`;
      }
      if (current)
        button = this.customerButton(request!.id, current.customerId);
    }
    await this.acknowledge(chatId, confirmation, button);
    return { ok: true };
  }

  private async acknowledge(
    chatId: string,
    text: string,
    button?: { text: string; url: string },
  ) {
    try {
      await this.delivery.send(chatId, text, button);
    } catch {
      this.logger.warn('Telegram acknowledgement failed.');
    }
  }

  private async notifyStatus(payload: unknown) {
    const event = StatusEventSchema.safeParse(payload);
    if (!event.success) return;
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: this.notificationWhere(event.data.requestId),
      select: {
        customerId: true,
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
      ACCEPTED:
        'Quán đã xác nhận đơn mang đi. Bạn thanh toán tại quầy khi nhận món.',
      REJECTED:
        'Quán chưa thể nhận đơn này. Vui lòng xem chi tiết trên trang theo dõi đơn.',
      CANCELLED: request.noShowAt
        ? 'Đã quá thời gian nhận món. Quán đã hủy đơn và ghi nhận không đến nhận.'
        : 'Đơn mang đi đã được hủy. Vui lòng xem chi tiết trên trang theo dõi đơn.',
    }[event.data.status];
    const sent = await this.delivery.send(
      request.telegramChatId,
      `Đơn #${event.data.requestId.slice(0, 8).toUpperCase()}: ${text}`,
      this.customerButton(event.data.requestId, request.customerId),
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
      where: this.notificationWhere(event.data.requestId),
      select: {
        customerId: true,
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
    const sent = await this.delivery.send(
      request.telegramChatId,
      `Đơn #${event.data.requestId.slice(0, 8).toUpperCase()} đã sẵn sàng. Mời bạn đến quầy nhận món và thanh toán.`,
      this.customerButton(event.data.requestId, request.customerId),
    );
    if (!sent) await this.unsubscribeChat(request.telegramChatId);
  }

  private async unsubscribeChat(chatId: string) {
    await this.prisma.onlineOrderRequest.updateMany({
      where: { telegramChatId: chatId },
      data: { telegramChatId: null },
    });
  }

  private customerButton(requestId: string, customerId: string | null) {
    return this.webButton(
      customerId ? 'Xem đơn hàng' : 'Tra cứu đơn hàng',
      customerId ? `/account/orders/${requestId}` : '/order?view=lookup',
    );
  }

  private notificationWhere(requestId: string) {
    return {
      id: requestId,
      OR: [
        {
          createdAt: {
            gt: new Date(Date.now() - ONLINE_ORDER_ACCESS_WINDOW_MS),
          },
        },
        { pickupAt: { gt: new Date(Date.now() - PICKUP_ACCESS_GRACE_MS) } },
      ],
    };
  }

  private webButton(text: string, path: string) {
    const origin = this.config.get<string>('TELEGRAM_WEB_APP_URL');
    return origin ? { text, url: new URL(path, origin).href } : undefined;
  }

  private async notifyStaff(payload: unknown) {
    const chatId = this.config.get<string>('TELEGRAM_STAFF_CHAT_ID');
    const event = ReadyEventSchema.safeParse(payload);
    if (!chatId || !event.success) return;
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: event.data.requestId },
      select: {
        status: true,
        expiresAt: true,
        pickupAt: true,
        quotedSubtotal: true,
        items: {
          orderBy: { lineNumber: 'asc' },
          take: 6,
          select: { quotedName: true, quantity: true },
        },
      },
    });
    if (
      request?.status !== OnlineOrderStatus.PENDING ||
      request.expiresAt <= new Date()
    )
      return;
    const pickup = request.pickupAt
      ? new Intl.DateTimeFormat('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(request.pickupAt)
      : 'Sớm nhất có thể sau khi quán xác nhận';
    const items = request.items
      .slice(0, 5)
      .map(
        (item) =>
          `${item.quantity} × ${item.quotedName.replace(/[\r\n\t]/g, ' ').slice(0, 80)}`,
      );
    const sent = await this.delivery.send(
      chatId,
      [
        `ĐƠN MANG ĐI MỚI #${event.data.requestId.slice(0, 8).toUpperCase()}`,
        ...items,
        ...(request.items.length > 5 ? ['… và các món khác.'] : []),
        `Hẹn nhận: ${pickup}`,
        `Giá trị dự kiến: ${request.quotedSubtotal.toFixed(2)} VND`,
        'Chờ nhân viên xác nhận. Thanh toán tại quầy khi nhận món.',
      ].join('\n'),
      this.webButton('Mở hàng đợi đơn', '/staff/online-orders?tab=pending'),
    );
    if (!sent)
      throw new OutboxPermanentError(
        'Telegram staff chat is unavailable; check bot membership and permissions.',
      );
  }
}
