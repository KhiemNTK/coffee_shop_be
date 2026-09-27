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
  };
  const service = new ManagementExceptionsService(
    prisma as unknown as ExtendedPrismaClient,
    new PaginationUtilService(),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.paymentReconciliationIncident.count.mockResolvedValue(2);
    prisma.cashExpenseRequest.count.mockResolvedValue(3);
    prisma.cashHandover.count.mockResolvedValue(4);
    prisma.takeawayFeedback.count.mockResolvedValue(5);
    prisma.paymentReconciliationIncident.findMany.mockResolvedValue([]);
    prisma.cashExpenseRequest.findMany.mockResolvedValue([]);
    prisma.cashHandover.findMany.mockResolvedValue([]);
    prisma.takeawayFeedback.findMany.mockResolvedValue([]);
  });

  it('counts only active cases without copying state into another table', async () => {
    expect(await service.summary()).toEqual({
      counts: {
        PAYMENT: 2,
        CASH_EXPENSE: 3,
        CASH_HANDOVER: 4,
        FEEDBACK: 5,
      },
      total: 14,
    });
    expect(prisma.paymentReconciliationIncident.count).toHaveBeenCalledWith({
      where: { status: 'OPEN' },
    });
    expect(prisma.cashExpenseRequest.count).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
    });
    expect(prisma.cashHandover.count).toHaveBeenCalledWith({
      where: {
        OR: [{ status: 'PENDING' }, { settlementStatus: 'PENDING' }],
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
});
