import type { BusinessInsightSnapshot } from '../../../common/types';

const defaults: Record<string, readonly [string, string]> = {
  paidInvoiceCount: ['20', '18'],
  grossSales: ['1000000.00', '900000.00'],
  discountAmount: ['100000.00', '100000.00'],
  refundCount: ['0', '0'],
  refundAmount: ['0.00', '0.00'],
  netReceipts: ['900000.00', '800000.00'],
  estimatedNetSalesExTax: ['900000.00', '800000.00'],
  ingredientCost: ['300000.00', '260000.00'],
  wasteCost: ['20000.00', '10000.00'],
  estimatedGrossProfit: ['580000.00', '530000.00'],
  soldItemCount: ['40', '35'],
  itemsWithCostSnapshot: ['40', '35'],
  zeroCostSnapshotCount: ['0', '0'],
};
const counts = new Set([
  'paidInvoiceCount',
  'refundCount',
  'soldItemCount',
  'itemsWithCostSnapshot',
  'zeroCostSnapshotCount',
]);

function snapshot(
  overrides: Record<string, readonly [string, string]> = {},
): BusinessInsightSnapshot {
  return {
    schemaVersion: 2,
    asOf: '2026-01-03T00:00:00.000Z',
    currentPeriod: {
      from: '2026-01-01T17:00:00.000Z',
      to: '2026-01-02T17:00:00.000Z',
    },
    comparisonPeriod: {
      from: '2025-12-31T17:00:00.000Z',
      to: '2026-01-01T17:00:00.000Z',
    },
    timeZone: 'Asia/Ho_Chi_Minh',
    comparisonBasis: 'PREVIOUS_EQUAL_DURATION',
    basis: {
      sales: 'INVOICE_CREATED_AT',
      refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
      waste: 'WASTE_CREATED_AT',
    },
    metrics: Object.entries({ ...defaults, ...overrides }).map(
      ([key, [value, previousValue]]) => ({
        key,
        label: key,
        unit: counts.has(key) ? 'COUNT' : 'VND',
        value,
        previousValue,
      }),
    ),
  };
}

export const BUSINESS_INSIGHT_EVALUATION_CASES = [
  {
    id: 'normal-growth',
    snapshot: snapshot(),
    receiptDirection: 'up',
    profitReliable: true,
    review: 'Propose checks, not a proven cause for increased receipts.',
  },
  {
    id: 'unchanged',
    snapshot: snapshot(
      Object.fromEntries(
        Object.entries(defaults).map(([key, [value]]) => [key, [value, value]]),
      ),
    ),
    receiptDirection: 'flat',
    profitReliable: true,
    review: 'Do not invent a growth trend when the periods are equal.',
  },
  {
    id: 'no-sales',
    snapshot: snapshot(
      Object.fromEntries(Object.keys(defaults).map((key) => [key, ['0', '0']])),
    ),
    receiptDirection: 'flat',
    profitReliable: true,
    review:
      'No sales: production must use deterministic analysis without calling Gemini.',
  },
  {
    id: 'receipts-down',
    snapshot: snapshot(
      Object.fromEntries(
        Object.entries(defaults).map(([key, [value, previous]]) => [
          key,
          [previous, value],
        ]),
      ),
    ),
    receiptDirection: 'down',
    profitReliable: true,
    review: 'Lower receipts do not identify a staff, price or demand cause.',
  },
  {
    id: 'refund-spike',
    snapshot: snapshot({
      refundCount: ['5', '1'],
      refundAmount: ['150000.00', '10000.00'],
      netReceipts: ['750000.00', '790000.00'],
      estimatedNetSalesExTax: ['750000.00', '790000.00'],
      estimatedGrossProfit: ['430000.00', '520000.00'],
    }),
    receiptDirection: 'down',
    profitReliable: true,
    review:
      'Refunds belong to the invoice cohort; do not infer a returned product or period cash flow.',
  },
  {
    id: 'negative-profit',
    snapshot: snapshot({
      ingredientCost: ['1100000.00', '260000.00'],
      estimatedGrossProfit: ['-220000.00', '530000.00'],
    }),
    receiptDirection: 'up',
    profitReliable: true,
    review:
      'Higher receipts can coexist with lower gross profit; this is not accounting net profit.',
  },
  {
    id: 'missing-current-costs',
    snapshot: snapshot({ itemsWithCostSnapshot: ['30', '35'] }),
    receiptDirection: 'up',
    profitReliable: false,
    review: 'Cost coverage is incomplete: do not claim profit efficiency.',
  },
  {
    id: 'missing-prior-costs',
    snapshot: snapshot({ itemsWithCostSnapshot: ['40', '20'] }),
    receiptDirection: 'up',
    profitReliable: false,
    review:
      'Prior-period costs are incomplete even when current costs are complete.',
  },
  {
    id: 'zero-current-cost',
    snapshot: snapshot({ zeroCostSnapshotCount: ['1', '0'] }),
    receiptDirection: 'up',
    profitReliable: false,
    review:
      'A zero cost snapshot needs verification before profit conclusions.',
  },
  {
    id: 'zero-prior-cost',
    snapshot: snapshot({ zeroCostSnapshotCount: ['0', '1'] }),
    receiptDirection: 'up',
    profitReliable: false,
    review:
      'An unreliable comparison period also blocks profit-efficiency claims.',
  },
  {
    id: 'small-sample',
    snapshot: snapshot({
      paidInvoiceCount: ['1', '1'],
      soldItemCount: ['1', '1'],
      itemsWithCostSnapshot: ['1', '1'],
      grossSales: ['35000.00', '30000.00'],
      discountAmount: ['0', '0'],
      netReceipts: ['35000.00', '30000.00'],
      estimatedNetSalesExTax: ['35000.00', '30000.00'],
      ingredientCost: ['20000.00', '18000.00'],
      wasteCost: ['0', '0'],
      estimatedGrossProfit: ['15000.00', '12000.00'],
    }),
    receiptDirection: 'up',
    profitReliable: true,
    review:
      'One invoice per period is not evidence of a stable business trend.',
  },
  {
    id: 'decimal-boundary',
    snapshot: snapshot({
      netReceipts: ['9007199254740992.01', '9007199254740992.00'],
    }),
    receiptDirection: 'up',
    profitReliable: true,
    review: 'The system, not generated prose, owns exact decimal comparisons.',
  },
] as const;
