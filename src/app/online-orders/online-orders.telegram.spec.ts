import { createHmac } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlineOrderStatus, ServeStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { IdempotencyService } from '../durable/idempotency.service';
import type { OutboxService } from '../durable/outbox.service';
import type { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import type { InvoicesService } from '../invoices/invoices.service';
import type { OrdersService } from '../orders/orders.service';
import type { TurnstileService } from '../auth/turnstile.service';
import { OnlineOrdersService } from './online-orders.service';
import type { OnlineOrderIntakeService } from './online-order-intake.service';

describe('OnlineOrdersService order access', () => {
  const requestId = 'd1ebfac7-36dc-442d-9cb0-68be76a5aa9c';
  const prisma = {
    onlineOrderRequest: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'TELEGRAM_BOT_USERNAME' ? 'coffee_test_bot' : undefined,
    ),
    getOrThrow: jest.fn(() => 'test-secret-at-least-thirty-two-characters'),
  };
  const accessKey = createHmac(
    'sha256',
    'test-secret-at-least-thirty-two-characters',
  )
    .update('online-order-access:v1')
    .digest();
  const accessToken = createHmac('sha256', accessKey)
    .update(requestId)
    .digest('hex');
  const service = new OnlineOrdersService(
    prisma as unknown as ExtendedPrismaClient,
    {} as OrdersService,
    {} as InvoicesService,
    {} as InventoryConsumptionService,
    {} as IdempotencyService,
    {} as OutboxService,
    {} as PaginationUtilService,
    config as unknown as ConfigService,
    {} as TurnstileService,
    {} as OnlineOrderIntakeService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('requires a valid order access token and stores only a short-lived link hash', async () => {
    await expect(
      service.createTelegramLink({ requestId, accessToken: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.onlineOrderRequest.findUnique).not.toHaveBeenCalled();
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      status: OnlineOrderStatus.PENDING,
      telegramChatId: null,
    });
    prisma.onlineOrderRequest.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.createTelegramLink({ requestId, accessToken });
    expect(result.url).toMatch(
      /^https:\/\/t\.me\/coffee_test_bot\?start=[A-Za-z0-9_-]{43}$/,
    );
    const rawToken = result.url.split('start=')[1];
    expect(prisma.onlineOrderRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: requestId, telegramChatId: null }),
        data: {
          telegramLinkTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          telegramLinkExpiresAt: expect.any(Date),
        },
      }),
    );
    expect(
      prisma.onlineOrderRequest.updateMany.mock.calls[0][0].data
        .telegramLinkTokenHash,
    ).not.toBe(rawToken);
  });

  it('does not rebind an already subscribed order', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      status: OnlineOrderStatus.ACCEPTED,
      telegramChatId: '123456',
    });
    await expect(
      service.createTelegramLink({
        requestId,
        accessToken,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.onlineOrderRequest.updateMany).not.toHaveBeenCalled();
  });

  it('exposes notification availability and subscription, never chat credentials', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      id: requestId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      status: OnlineOrderStatus.PENDING,
      telegramChatId: '123456',
      items: [],
      orderSession: null,
    });
    const result = await service.trackPublicRequest({ requestId, accessToken });
    expect(result.telegram).toEqual({ enabled: true, subscribed: true });
    expect(result).not.toHaveProperty('telegramChatId');
    expect(result).not.toHaveProperty('pickupAccessToken');
    expect(JSON.stringify(result)).not.toContain('123456');
    expect(prisma.onlineOrderRequest.findUnique).toHaveBeenCalledTimes(1);
  });

  it('recovers the existing pickup credential only for the authenticated order owner', async () => {
    const row = {
      id: requestId,
      createdAt: new Date(),
      pickupAt: null,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      status: OnlineOrderStatus.ACCEPTED,
      items: [],
      orderSession: {
        invoices: [],
        orderItems: [{ serveStatus: ServeStatus.READY, isPaid: false }],
      },
    };
    prisma.onlineOrderRequest.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.customerId === 'owner-id' ? row : null),
    );
    await expect(
      service.getCustomerOrder('owner-id', requestId),
    ).resolves.toEqual(
      expect.objectContaining({ pickupAccessToken: accessToken, invoices: [] }),
    );
    expect(prisma.onlineOrderRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: requestId, customerId: 'owner-id' },
      }),
    );
    await expect(
      service.getCustomerOrder('another-customer', requestId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['expired', 'collected', 'cancelled', 'pending', 'no-show'])(
    'does not recover pickup credentials for a %s order',
    async (state) => {
      prisma.onlineOrderRequest.findUnique.mockResolvedValue({
        id: requestId,
        createdAt: new Date(
          Date.now() - (state === 'expired' ? 73 * 60 * 60_000 : 0),
        ),
        pickupAt: null,
        expiresAt: new Date(),
        status:
          state === 'cancelled'
            ? OnlineOrderStatus.CANCELLED
            : state === 'pending'
              ? OnlineOrderStatus.PENDING
              : OnlineOrderStatus.ACCEPTED,
        noShowAt: state === 'no-show' ? new Date() : null,
        items: [],
        orderSession: {
          invoices: [],
          orderItems: [
            {
              serveStatus:
                state === 'collected' ? ServeStatus.SERVED : ServeStatus.READY,
              isPaid: state === 'collected',
            },
          ],
        },
      });
      const result = await service.getCustomerOrder('owner-id', requestId);
      expect(result).toHaveProperty('pickupAccessToken', null);
    },
  );

  it('does not issue a link for an expired pending request', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: new Date(Date.now() - 30 * 60_000),
      status: OnlineOrderStatus.PENDING,
      telegramChatId: null,
    });
    await expect(
      service.createTelegramLink({ requestId, accessToken }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.onlineOrderRequest.updateMany).not.toHaveBeenCalled();
  });
});
