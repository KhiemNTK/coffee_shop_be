import { ConfigService } from '@nestjs/config';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { ONLINE_ORDER_NO_SHOW_GRACE_MS } from '../../common/consts/online-order-settings';
import type { TurnstileService } from '../auth/turnstile.service';
import type { IdempotencyService } from '../durable/idempotency.service';
import type { OutboxService } from '../durable/outbox.service';
import type { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import type { InvoicesService } from '../invoices/invoices.service';
import type { OrdersService } from '../orders/orders.service';
import type { OnlineOrderIntakeService } from './online-order-intake.service';
import { OnlineOrdersService } from './online-orders.service';

describe('Online order overdue and no-show policy', () => {
  const prisma = {
    onlineOrderRequest: { count: jest.fn(), findMany: jest.fn() },
  };
  const service = new OnlineOrdersService(
    prisma as unknown as ExtendedPrismaClient,
    {} as OrdersService,
    {} as InvoicesService,
    {} as InventoryConsumptionService,
    {} as IdempotencyService,
    {} as OutboxService,
    new PaginationUtilService(),
    new ConfigService({ JWT_SECRET: 'isolated-fulfillment-policy-secret' }),
    {} as TurnstileService,
    {} as OnlineOrderIntakeService,
  );
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T04:00:00Z'));
    jest.clearAllMocks();
    prisma.onlineOrderRequest.count.mockResolvedValue(1);
  });
  afterEach(() => jest.useRealTimers());

  it.each([
    ['READY', ONLINE_ORDER_NO_SHOW_GRACE_MS, true],
    ['READY', ONLINE_ORDER_NO_SHOW_GRACE_MS - 1, false],
    ['COOKING', ONLINE_ORDER_NO_SHOW_GRACE_MS * 2, false],
    ['PENDING', ONLINE_ORDER_NO_SHOW_GRACE_MS * 2, false],
  ])(
    'classifies an ASAP %s line aged %s ms as no-show eligible: %s',
    async (serveStatus, age, expected) => {
      prisma.onlineOrderRequest.findMany.mockResolvedValue([
        {
          id: 'request-id',
          pickupAt: null,
          orderSession: {
            sessionStatus: 'ACTIVE',
            orderItems: [
              {
                serveStatus,
                readyAt: new Date(Date.now() - age),
                isPaid: false,
                invoiceId: null,
              },
            ],
          },
        },
      ]);
      const result = await service.findFulfillment({
        page: 1,
        itemPerPage: 20,
        overdueOnly: true,
      });
      expect(result.list[0]).toMatchObject({
        isOverdue: expected,
        isNoShowEligible: expected,
      });
      expect(prisma.onlineOrderRequest.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ pickupAt: null }),
          ]),
        }),
      });
    },
  );

  it('uses the last ready line, not the first, and keeps the scheduled pickup lower bound', async () => {
    const old = new Date(Date.now() - ONLINE_ORDER_NO_SHOW_GRACE_MS * 2);
    const recent = new Date(Date.now() - 1000);
    const line = (readyAt: Date) => ({
      serveStatus: 'READY',
      readyAt,
      isPaid: false,
      invoiceId: null,
    });
    prisma.onlineOrderRequest.findMany.mockResolvedValue([
      {
        id: 'asap',
        pickupAt: null,
        orderSession: { orderItems: [line(old), line(recent)] },
      },
      {
        id: 'future',
        pickupAt: new Date(Date.now() + 60_000),
        orderSession: { orderItems: [line(old)] },
      },
      {
        id: 'paid',
        pickupAt: null,
        orderSession: { orderItems: [{ ...line(old), isPaid: true }] },
      },
    ]);
    const result = await service.findFulfillment({ page: 1, itemPerPage: 20 });
    expect(result.list.every((row) => !row.isNoShowEligible)).toBe(true);
  });
});
