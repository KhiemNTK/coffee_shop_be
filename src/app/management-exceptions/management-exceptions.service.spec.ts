import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { ManagementExceptionsService } from './management-exceptions.service';

describe('ManagementExceptionsService', () => {
  const prisma = {
    paymentReconciliationIncident: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    cashExpenseRequest: { count: jest.fn(), findMany: jest.fn() },
    cashHandover: { count: jest.fn(), findMany: jest.fn() },
    takeawayFeedback: { count: jest.fn(), findMany: jest.fn() },
    kitchenTicket: { count: jest.fn(), findMany: jest.fn() },
    onlineOrderRequest: { count: jest.fn(), findMany: jest.fn() },
  };
  const service = new ManagementExceptionsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-11T10:00:00Z'));
    jest.clearAllMocks();
    prisma.paymentReconciliationIncident.count.mockResolvedValue(2);
    prisma.cashExpenseRequest.count.mockResolvedValue(3);
    prisma.cashHandover.count.mockResolvedValue(4);
    prisma.takeawayFeedback.count.mockResolvedValue(5);
    prisma.kitchenTicket.count.mockResolvedValue(6);
    prisma.onlineOrderRequest.count.mockResolvedValue(7);
    prisma.paymentReconciliationIncident.findMany.mockResolvedValue([]);
    prisma.cashExpenseRequest.findMany.mockResolvedValue([]);
    prisma.cashHandover.findMany.mockResolvedValue([]);
    prisma.takeawayFeedback.findMany.mockResolvedValue([]);
    prisma.kitchenTicket.findMany.mockResolvedValue([]);
    prisma.onlineOrderRequest.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.useRealTimers());

  it('counts only active cases without copying state into another table', async () => {
    expect(await service.summary()).toEqual({
      asOf: '2026-10-11T10:00:00.000Z',
      counts: {
        PAYMENT: 2,
        CASH_EXPENSE: 3,
        CASH_HANDOVER: 4,
        FEEDBACK: 5,
        KITCHEN_OVERDUE: 6,
        ONLINE_PICKUP_LATE: 7,
      },
      total: 27,
    });
    expect(prisma.paymentReconciliationIncident.count).toHaveBeenCalledWith({
      where: { status: 'OPEN' },
    });
    expect(prisma.cashExpenseRequest.count).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
    });
    expect(prisma.cashHandover.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'PENDING' },
          { status: 'APPROVED', settlementStatus: 'PENDING' },
        ],
      },
    });
    expect(prisma.takeawayFeedback.count).toHaveBeenCalledWith({
      where: { rating: { lte: 2 }, resolvedAt: null },
    });
  });

  it.each([
    ['PAYMENT', prisma.paymentReconciliationIncident, 'detectedAt', 2],
    ['CASH_EXPENSE', prisma.cashExpenseRequest, 'createdAt', 3],
    ['CASH_HANDOVER', prisma.cashHandover, 'createdAt', 4],
    ['FEEDBACK', prisma.takeawayFeedback, 'createdAt', 5],
    ['KITCHEN_OVERDUE', prisma.kitchenTicket, 'dueAt', 6],
    ['ONLINE_PICKUP_LATE', prisma.onlineOrderRequest, 'pickupAt', 7],
  ] as const)('paginates %s oldest first', async (kind, model, date, total) => {
    const result = await service.findAll({ kind, page: 2, itemPerPage: 2 });

    expect(model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 2,
        take: 2,
        orderBy: [{ [date]: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(result).toEqual({
      kind,
      list: [],
      totalItems: total,
      currentPage: 2,
      totalPages: Math.ceil(total / 2),
    });
  });

  it('returns minimal payment fields without provider payloads', async () => {
    await service.findAll({ kind: 'PAYMENT', page: 1, itemPerPage: 20 });

    expect(prisma.paymentReconciliationIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          type: true,
          title: true,
          detectedAt: true,
          paymentAttemptId: true,
          paymentRefundId: true,
        },
      }),
    );
  });

  it('excludes future scheduled, finished and deleted-station kitchen tickets', async () => {
    await service.summary();
    const where = {
      dueAt: { lt: new Date('2026-10-11T10:00:00Z') },
      OR: [
        { availableAt: null },
        { availableAt: { lte: new Date('2026-10-11T10:00:00Z') } },
      ],
      station: { deletedAt: null },
      items: {
        some: { orderItem: { serveStatus: { in: ['PENDING', 'COOKING'] } } },
      },
    };
    expect(prisma.kitchenTicket.count).toHaveBeenCalledWith({ where });
    await service.findAll({
      kind: 'KITCHEN_OVERDUE',
      page: 1,
      itemPerPage: 20,
    });
    expect(prisma.kitchenTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
  });

  it('uses the fulfillment grace window without treating late orders as no-shows', async () => {
    await service.summary();
    const where = {
      status: 'ACCEPTED',
      pickupAt: { lt: new Date('2026-10-11T09:45:00Z') },
      orderSession: {
        is: {
          orderItems: {
            some: {
              replacementRemake: { is: null },
              serveStatus: { in: ['PENDING', 'COOKING', 'READY'] },
            },
          },
        },
      },
    };
    expect(prisma.onlineOrderRequest.count).toHaveBeenCalledWith({ where });
    await service.findAll({
      kind: 'ONLINE_PICKUP_LATE',
      page: 1,
      itemPerPage: 20,
    });
    expect(prisma.onlineOrderRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        select: {
          id: true,
          pickupAt: true,
          createdAt: true,
          orderSessionId: true,
        },
      }),
    );
  });
});
