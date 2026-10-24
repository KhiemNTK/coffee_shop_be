import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlineOrderStatus, Prisma, ServeStatus } from '@prisma/client';
import {
  OutboxDeferredError,
  OutboxPermanentError,
} from '../durable/outbox-delivery.error';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import type { OutboxService } from '../durable/outbox.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import {
  ONLINE_ORDER_TELEGRAM_EVENT,
  ONLINE_ORDER_TELEGRAM_READY_EVENT,
  ONLINE_ORDER_TELEGRAM_STAFF_EVENT,
} from './telegram-events';
import { TelegramNotificationsService } from './telegram-notifications.service';
import { TelegramDeliveryService } from './telegram-delivery.service';

describe('TelegramNotificationsService', () => {
  const requestId = 'd1ebfac7-36dc-442d-9cb0-68be76a5aa9c';
  const sessionId = '86965021-24b3-41d4-a74c-dd4a74c6633d';
  const secret = 's'.repeat(32);
  const token = 'a'.repeat(43);
  const prisma = {
    $transaction: jest.fn(),
    onlineOrderRequest: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const outbox = { enqueue: jest.fn() };
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          TELEGRAM_BOT_TOKEN: '123456789:fake-test-token',
          TELEGRAM_WEBHOOK_SECRET: secret,
          TELEGRAM_STAFF_CHAT_ID: '-1001234567890',
          TELEGRAM_WEB_APP_URL: 'https://coffee.example.test',
        })[key],
    ),
  };
  let eventBus: DomainEventBusService;
  let service: TelegramNotificationsService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.onlineOrderRequest.findUnique.mockReset();
    prisma.onlineOrderRequest.updateMany.mockReset();
    eventBus = new DomainEventBusService();
    service = new TelegramNotificationsService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
      eventBus,
      outbox as unknown as OutboxService,
      new TelegramDeliveryService(config as unknown as ConfigService),
    );
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    service.onModuleInit();
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
  });

  afterEach(() => {
    service.onModuleDestroy();
    fetchMock.mockRestore();
  });

  it('rejects unsigned webhook requests and links a private chat only once', async () => {
    await expect(service.receiveWebhook('wrong', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
    prisma.onlineOrderRequest.findUnique
      .mockResolvedValueOnce({ id: requestId })
      .mockResolvedValueOnce({
        status: OnlineOrderStatus.PENDING,
        orderSession: null,
      });
    prisma.onlineOrderRequest.updateMany.mockResolvedValue({ count: 1 });

    await service.receiveWebhook(secret, {
      message: {
        chat: { id: 123456, type: 'private' },
        from: { id: 123456 },
        text: `/start ${token}`,
      },
    });
    expect(prisma.onlineOrderRequest.findUnique).toHaveBeenCalledWith({
      where: {
        telegramLinkTokenHash: createHash('sha256').update(token).digest('hex'),
      },
      select: { id: true },
    });
    expect(prisma.onlineOrderRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          telegramChatId: null,
          telegramLinkExpiresAt: expect.any(Object),
        }),
        data: {
          telegramChatId: '123456',
          telegramLinkTokenHash: null,
          telegramLinkExpiresAt: null,
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe('123456');
    expect(body.text).not.toContain(token);
  });

  it('ignores group messages and honors /stop', async () => {
    await service.receiveWebhook(secret, {
      message: {
        chat: { id: -123456, type: 'group' },
        from: { id: 123456 },
        text: `/start ${token}`,
      },
    });
    expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
    await service.receiveWebhook(secret, {
      message: {
        chat: { id: 123456, type: 'private' },
        from: { id: 123456 },
        text: '/stop',
      },
    });
    expect(prisma.onlineOrderRequest.updateMany).toHaveBeenCalledWith({
      where: { telegramChatId: '123456' },
      data: { telegramChatId: null },
    });
  });

  it('queues one ready notification independently from the kitchen event', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce({
      status: OnlineOrderStatus.CANCELLED,
      telegramChatId: '123456',
    });
    await eventBus.publish(ONLINE_ORDER_TELEGRAM_EVENT, {
      requestId,
      status: OnlineOrderStatus.ACCEPTED,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce({
      id: requestId,
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      telegramReadyQueuedAt: null,
      orderSession: {
        orderItems: [
          { serveStatus: ServeStatus.READY },
          { serveStatus: ServeStatus.READY },
        ],
      },
    });
    prisma.onlineOrderRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: null,
      currentStatus: ServeStatus.READY,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        eventName: ONLINE_ORDER_TELEGRAM_READY_EVENT,
        payload: { requestId },
      }),
    );
    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce({
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
    });
    await eventBus.publish(ONLINE_ORDER_TELEGRAM_READY_EVENT, { requestId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce({
      id: requestId,
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      telegramReadyQueuedAt: new Date(),
      orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
    });
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: null,
      currentStatus: ServeStatus.READY,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits Telegram delivery failure to its own outbox event', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(
      eventBus.publish(ONLINE_ORDER_TELEGRAM_READY_EVENT, { requestId }),
    ).rejects.toBeInstanceOf(OutboxDeferredError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not announce a partially cancelled legacy order that cannot be collected', async () => {
    const request = {
      id: requestId,
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      telegramReadyQueuedAt: null,
      orderSession: {
        orderItems: [
          { serveStatus: ServeStatus.READY },
          { serveStatus: ServeStatus.PENDING },
        ],
      },
    };
    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce(request);
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: null,
      currentStatus: ServeStatus.READY,
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    prisma.onlineOrderRequest.findUnique.mockResolvedValueOnce({
      ...request,
      orderSession: {
        orderItems: [
          { serveStatus: ServeStatus.READY },
          { serveStatus: ServeStatus.CANCELLED },
        ],
      },
    });
    prisma.onlineOrderRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: null,
      currentStatus: ServeStatus.CANCELLED,
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [ServeStatus.CANCELLED],
    [ServeStatus.READY, ServeStatus.CANCELLED],
    [ServeStatus.SERVED, ServeStatus.CANCELLED],
    [ServeStatus.READY, ServeStatus.COOKING, ServeStatus.CANCELLED],
  ])(
    'does not announce cancellation as ready when the remaining items are %p',
    async (...statuses) => {
      prisma.onlineOrderRequest.findUnique.mockResolvedValue({
        id: requestId,
        status: OnlineOrderStatus.ACCEPTED,
        telegramChatId: '123456',
        telegramReadyQueuedAt: null,
        orderSession: {
          orderItems: statuses.map((serveStatus) => ({ serveStatus })),
        },
      });
      await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        orderSessionId: sessionId,
        tableId: null,
        currentStatus: ServeStatus.CANCELLED,
      });
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('keeps concurrent readiness events behind the same database compare-and-set', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      id: requestId,
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      telegramReadyQueuedAt: null,
      orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
    });
    prisma.onlineOrderRequest.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await Promise.all([
      eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        orderSessionId: sessionId,
        tableId: null,
        currentStatus: ServeStatus.READY,
      }),
      eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        orderSessionId: sessionId,
        tableId: null,
        currentStatus: ServeStatus.CANCELLED,
      }),
    ]);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ONLINE_ORDER_TELEGRAM_EVENT,
    ORDER_EVENTS.ITEM_STATUS_UPDATED,
    ONLINE_ORDER_TELEGRAM_READY_EVENT,
    ONLINE_ORDER_TELEGRAM_STAFF_EVENT,
  ])(
    'rejects malformed internal %s payloads permanently without exposing their contents',
    async (eventName) => {
      await expect(
        eventBus.publish(eventName, {
          requestId: 'invalid',
          accessToken: 'must-not-be-logged',
        }),
      ).rejects.toThrow(
        new OutboxPermanentError('Invalid Telegram event payload.'),
      );
      expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('does not queue a ready message after collection', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      id: requestId,
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      telegramReadyQueuedAt: null,
      orderSession: { orderItems: [{ serveStatus: ServeStatus.SERVED }] },
    });
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: null,
      currentStatus: ServeStatus.READY,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    JSON.stringify({
      ok: false,
      error_code: 500,
      description: 'private-chat-detail',
    }),
    JSON.stringify({ unexpected: true }),
    '<html>proxy failure</html>',
  ])('keeps failed or malformed delivery retryable: %s', async (body) => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
      orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(
      eventBus.publish(ONLINE_ORDER_TELEGRAM_READY_EVENT, { requestId }),
    ).rejects.toThrow(/^Telegram send (rejected|response invalid)\.$/);
    expect(prisma.onlineOrderRequest.updateMany).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 403])(
    'unsubscribes a blocked chat (HTTP %s) without endless retries',
    async (status) => {
      prisma.onlineOrderRequest.findUnique.mockResolvedValue({
        status: OnlineOrderStatus.ACCEPTED,
        telegramChatId: '123456',
        orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
      });
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error_code: 403 }), {
          status,
        }),
      );
      await expect(
        eventBus.publish(ONLINE_ORDER_TELEGRAM_READY_EVENT, { requestId }),
      ).resolves.toBeUndefined();
      expect(prisma.onlineOrderRequest.updateMany).toHaveBeenCalledWith({
        where: { telegramChatId: '123456' },
        data: { telegramChatId: null },
      });
    },
  );

  it('skips table orders before querying for an online subscription', async () => {
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: requestId,
      currentStatus: ServeStatus.READY,
    });
    expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
  });

  it('does not query customer subscriptions when configured for staff-only alerts', async () => {
    service.onModuleDestroy();
    const staffOnly = new TelegramNotificationsService(
      prisma as unknown as ExtendedPrismaClient,
      new ConfigService({
        TELEGRAM_BOT_TOKEN: '123456789:fake-test-token',
        TELEGRAM_STAFF_CHAT_ID: '-1001234567890',
      }),
      eventBus,
      outbox as unknown as OutboxService,
      {} as TelegramDeliveryService,
    );
    staffOnly.onModuleInit();
    try {
      await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
        orderSessionId: sessionId,
        tableId: null,
        currentStatus: ServeStatus.READY,
      });
      expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
    } finally {
      staffOnly.onModuleDestroy();
    }
  });

  it('distinguishes a staff-confirmed no-show from a normal cancellation', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      status: OnlineOrderStatus.CANCELLED,
      telegramChatId: '123456',
      noShowAt: new Date(),
    });
    await eventBus.publish(ONLINE_ORDER_TELEGRAM_EVENT, {
      requestId,
      status: OnlineOrderStatus.CANCELLED,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('không đến nhận');
  });

  it.each([null, '86965021-24b3-41d4-a74c-dd4a74c6633d'])(
    'links a customer through the normal access check without an order token (%s)',
    async (customerId) => {
      prisma.onlineOrderRequest.findUnique.mockResolvedValue({
        status: OnlineOrderStatus.ACCEPTED,
        customerId,
        telegramChatId: '123456',
        orderSession: { orderItems: [{ serveStatus: ServeStatus.READY }] },
      });
      await eventBus.publish(ONLINE_ORDER_TELEGRAM_READY_EVENT, { requestId });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.text).toContain('đã sẵn sàng');
      expect(body.text).toContain('thanh toán');
      expect(body.reply_markup.inline_keyboard).toEqual([
        [
          {
            text: customerId ? 'Xem đơn hàng' : 'Tra cứu đơn hàng',
            url: `https://coffee.example.test${customerId ? `/account/orders/${requestId}` : '/order?view=lookup'}`,
          },
        ],
      ]);
      expect(JSON.stringify(body)).not.toMatch(
        /accessToken|pickupAccessToken|reorderToken/,
      );
      expect(
        JSON.stringify(prisma.onlineOrderRequest.findUnique.mock.calls[0]),
      ).not.toContain('phoneNumber');
    },
  );

  it('sends a bounded staff summary without customer PII or instructions to prepare an unconfirmed order', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      status: OnlineOrderStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
      pickupAt: new Date('2026-10-22T03:15:00Z'),
      quotedSubtotal: new Prisma.Decimal('85000'),
      items: Array.from({ length: 6 }, () => ({
        quotedName: 'Trà đào\nNEW LINE',
        quantity: 2,
      })),
    });
    await eventBus.publish(ONLINE_ORDER_TELEGRAM_STAFF_EVENT, { requestId });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe('-1001234567890');
    expect(body.text).toContain('Chờ nhân viên xác nhận');
    expect(body.text).toContain('85000.00 VND');
    expect(body.text).toContain('10:15');
    expect(body.text).toContain('2 × Trà đào NEW LINE');
    expect(body.text).toContain('và các món khác');
    expect(body.reply_markup.inline_keyboard[0][0].url).toBe(
      'https://coffee.example.test/staff/online-orders?tab=pending',
    );
    const select = prisma.onlineOrderRequest.findUnique.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('phoneNumber');
    expect(select).not.toHaveProperty('pickupName');
    expect(select).not.toHaveProperty('requestHash');
  });

  it.each([
    {
      status: OnlineOrderStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
    },
    { status: OnlineOrderStatus.PENDING, expiresAt: new Date(0) },
  ])(
    'skips a delayed staff alert once it is no longer actionable (%s)',
    async (request) => {
      prisma.onlineOrderRequest.findUnique.mockResolvedValue(request);
      await eventBus.publish(ONLINE_ORDER_TELEGRAM_STAFF_EVENT, { requestId });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('dead-letters a forbidden staff group instead of clearing customer subscriptions', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      status: OnlineOrderStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
      pickupAt: null,
      quotedSubtotal: new Prisma.Decimal('35000'),
      items: [],
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      eventBus.publish(ONLINE_ORDER_TELEGRAM_STAFF_EVENT, { requestId }),
    ).rejects.toBeInstanceOf(OutboxPermanentError);
    expect(prisma.onlineOrderRequest.updateMany).not.toHaveBeenCalled();
  });
});
