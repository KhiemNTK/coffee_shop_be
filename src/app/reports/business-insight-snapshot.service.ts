import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { BusinessInsightSnapshot } from '../../common/types';
import { queryProfitability } from './profitability.query';
import { queryInsightBreakdown } from './business-insight-breakdown.query';

@Injectable()
export class BusinessInsightSnapshotService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
  ) {}

  async capture(from: string, to: string): Promise<BusinessInsightSnapshot> {
    const period = { from: new Date(from), to: new Date(to) };
    const duration = period.to.getTime() - period.from.getTime();
    const previousDay = duration < 86_400_000;
    const offset = previousDay ? 86_400_000 : duration;
    const previous = {
      from: new Date(period.from.getTime() - offset),
      to: new Date(period.to.getTime() - offset),
    };
    const asOf = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const current = await queryProfitability(tx, period, asOf);
        const prior = await queryProfitability(tx, previous, asOf);
        const breakdown = await queryInsightBreakdown(tx, period, previous);
        const definitions = [
          ['paidInvoiceCount', 'Hoa don da thanh toan', 'COUNT'],
          ['grossSales', 'Doanh so truoc giam gia', 'VND'],
          ['discountAmount', 'Giam gia', 'VND'],
          ['refundCount', 'Giao dich hoan tien thanh cong', 'COUNT'],
          ['refundAmount', 'Tien da hoan', 'VND'],
          ['netReceipts', 'Thuc thu sau hoan tien', 'VND'],
          [
            'estimatedNetSalesExTax',
            'Doanh thu thuan uoc tinh chua VAT',
            'VND',
          ],
          ['ingredientCost', 'Chi phi nguyen lieu da che bien', 'VND'],
          ['wasteCost', 'Chi phi hao hut', 'VND'],
          ['estimatedGrossProfit', 'Loi nhuan gop uoc tinh', 'VND'],
          ['soldItemCount', 'So dong mon da ban', 'COUNT'],
          ['itemsWithCostSnapshot', 'Dong mon co snapshot chi phi', 'COUNT'],
          ['zeroCostSnapshotCount', 'Snapshot co chi phi bang khong', 'COUNT'],
        ] as const;
        return {
          schemaVersion: 2,
          asOf: asOf.toISOString(),
          currentPeriod: {
            from: period.from.toISOString(),
            to: period.to.toISOString(),
          },
          comparisonPeriod: {
            from: previous.from.toISOString(),
            to: previous.to.toISOString(),
          },
          timeZone: 'Asia/Ho_Chi_Minh',
          comparisonBasis: previousDay
            ? 'PREVIOUS_DAY_SAME_WINDOW'
            : 'PREVIOUS_EQUAL_DURATION',
          basis: {
            sales: 'INVOICE_CREATED_AT',
            refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
            waste: 'WASTE_CREATED_AT',
          },
          metrics: [
            ...definitions.map(([key, label, unit]) => ({
              key,
              label,
              unit,
              value: String(current[key]),
              previousValue: String(prior[key]),
            })),
            ...breakdown,
          ],
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 10_000,
      },
    );
  }
}
