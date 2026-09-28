import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlineOrderStatus, ServeStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { DomainEventBusService } from '../durable/domain-event-bus.service';
import type { OutboxService } from '../durable/outbox.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import {
  ONLINE_ORDER_TELEGRAM_EVENT,
  ONLINE_ORDER_TELEGRAM_READY_EVENT,
} from './telegram-events';
import { TelegramNotificationsService } from './telegram-notifications.service';

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
        })[key],
    ),
  };
  let eventBus: DomainEventBusService;
  let service: TelegramNotificationsService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    eventBus = new DomainEventBusService();
    service = new TelegramNotificationsService(
      prisma as unknown as ExtendedPrismaClient,
      config as unknown as ConfigService,
      eventBus,
      outbox as unknown as OutboxService,
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
          { serveStatus: ServeStatus.CANCELLED },
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
    ).rejects.toThrow('Telegram send failed: HTTP 429');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

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

  it('skips table orders before querying for an online subscription', async () => {
    await eventBus.publish(ORDER_EVENTS.ITEM_STATUS_UPDATED, {
      orderSessionId: sessionId,
      tableId: requestId,
      currentStatus: ServeStatus.READY,
    });
    expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
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
    expect(body.text).toContain('khong den nhan');
  });
});
