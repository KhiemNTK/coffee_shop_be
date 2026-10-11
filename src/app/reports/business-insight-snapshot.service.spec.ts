import type { ExtendedPrismaClient } from '../../common/types';
import { BusinessInsightSnapshotService } from './business-insight-snapshot.service';
import { queryProfitability } from './profitability.query';

jest.mock('./profitability.query', () => ({ queryProfitability: jest.fn() }));

describe('BusinessInsightSnapshotService', () => {
  const tx = {};
  const prisma = {
    $transaction: jest.fn((capture: (tx: object) => unknown) => capture(tx)),
  };
  const query = jest.mocked(queryProfitability);
  const service = new BusinessInsightSnapshotService(
    prisma as unknown as ExtendedPrismaClient,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({
      asOf: '2026-10-10T02:00:00Z',
      paidInvoiceCount: 1,
      grossSales: '100.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      refundCount: 0,
      refundAmount: '0.00',
      netReceipts: '100.00',
      estimatedNetSalesExTax: '100.00',
      ingredientCost: '10.00',
      wasteCost: '0.00',
      estimatedGrossProfit: '90.00',
      soldItemCount: 1,
      itemsWithCostSnapshot: 1,
      zeroCostSnapshotCount: 0,
    });
  });

  it('compares a partial Vietnam business day with the same hours yesterday', async () => {
    const snapshot = await service.capture(
      '2026-10-10T00:00:00+07:00',
      '2026-10-10T09:00:00+07:00',
    );
    expect(snapshot.currentPeriod).toEqual({
      from: '2026-10-09T17:00:00.000Z',
      to: '2026-10-10T02:00:00.000Z',
    });
    expect(snapshot.comparisonPeriod).toEqual({
      from: '2026-10-08T17:00:00.000Z',
      to: '2026-10-09T02:00:00.000Z',
    });
    expect(snapshot.comparisonBasis).toBe('PREVIOUS_DAY_SAME_WINDOW');
    expect(query.mock.calls[0][2]).toBe(query.mock.calls[1][2]);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
  });

  it.each([1, 7, 31])(
    'compares a complete %i-day window with an adjacent equal-duration period',
    async (days) => {
      const end = new Date('2026-10-10T00:00:00+07:00');
      const start = new Date(end.getTime() - days * 86_400_000);
      const snapshot = await service.capture(
        start.toISOString(),
        end.toISOString(),
      );
      expect(snapshot.comparisonPeriod.to).toBe(start.toISOString());
      expect(
        Date.parse(snapshot.comparisonPeriod.to) -
          Date.parse(snapshot.comparisonPeriod.from),
      ).toBe(days * 86_400_000);
      expect(snapshot).toMatchObject({
        schemaVersion: 2,
        comparisonBasis: 'PREVIOUS_EQUAL_DURATION',
        timeZone: 'Asia/Ho_Chi_Minh',
        basis: {
          sales: 'INVOICE_CREATED_AT',
          refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
          waste: 'WASTE_CREATED_AT',
        },
      });
    },
  );
});
