import type { BusinessInsightSnapshot } from '../../common/types';
import { BusinessInsightAnalysisSchema } from './business-insight.schema';
import { buildBusinessInsightAnalysis } from './business-insight.analysis';

const snapshot: BusinessInsightSnapshot = {
  schemaVersion: 2,
  asOf: '2026-10-10T02:00:00Z',
  currentPeriod: { from: '2026-10-09T17:00:00Z', to: '2026-10-10T02:00:00Z' },
  comparisonPeriod: {
    from: '2026-10-08T17:00:00Z',
    to: '2026-10-09T02:00:00Z',
  },
  timeZone: 'Asia/Ho_Chi_Minh',
  comparisonBasis: 'PREVIOUS_DAY_SAME_WINDOW',
  basis: {
    sales: 'INVOICE_CREATED_AT',
    refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
    waste: 'WASTE_CREATED_AT',
  },
  metrics: [
    {
      key: 'netReceipts',
      label: 'Thuc thu',
      unit: 'VND',
      value: '9007199254740992.01',
      previousValue: '9007199254740992.00',
    },
    {
      key: 'paidInvoiceCount',
      label: 'Hoa don',
      unit: 'COUNT',
      value: '10',
      previousValue: '10',
    },
    {
      key: 'estimatedGrossProfit',
      label: 'Loi nhuan gop',
      unit: 'VND',
      value: '-0.01',
      previousValue: '0.00',
    },
    {
      key: 'soldItemCount',
      label: 'Dong mon',
      unit: 'COUNT',
      value: '10',
      previousValue: '10',
    },
    {
      key: 'itemsWithCostSnapshot',
      label: 'Chi phi',
      unit: 'COUNT',
      value: '10',
      previousValue: '10',
    },
    {
      key: 'zeroCostSnapshotCount',
      label: 'Chi phi khong',
      unit: 'COUNT',
      value: '0',
      previousValue: '0',
    },
  ],
};

describe('deterministic business observations', () => {
  it('computes increase, equality and negative profit without floating-point rounding', () => {
    const result = buildBusinessInsightAnalysis(snapshot);
    expect(result.findings.map((finding) => finding.detail)).toEqual([
      'Thuc thu cao hon ky so sanh.',
      'Hoa don khong thay doi so voi ky so sanh.',
      'Loi nhuan gop thap hon ky so sanh.',
    ]);
    expect(
      result.findings.every((finding) => finding.kind === 'OBSERVATION'),
    ).toBe(true);
    expect(BusinessInsightAnalysisSchema.safeParse(result).success).toBe(true);
  });

  it.each(['itemsWithCostSnapshot', 'zeroCostSnapshotCount'])(
    'does not claim profit efficiency when current or previous %s is unreliable',
    (key) => {
      const result = buildBusinessInsightAnalysis({
        ...snapshot,
        metrics: snapshot.metrics.map((metric) =>
          metric.key === key
            ? {
                ...metric,
                previousValue: key === 'itemsWithCostSnapshot' ? '9' : '1',
              }
            : metric,
        ),
      });
      expect(
        result.findings.some((finding) =>
          finding.metricKeys.includes('estimatedGrossProfit'),
        ),
      ).toBe(false);
      expect(result.limitations.join(' ')).toContain(
        'Snapshot chi phi thieu hoac bang khong',
      );
    },
  );

  it('keeps unverified model text out of the authoritative summary and observations', () => {
    const result = buildBusinessInsightAnalysis(snapshot, {
      findings: [
        {
          title: 'Gia thuyet',
          kind: 'HYPOTHESIS',
          detail: 'Co the nhu cau dang giam.',
          metricKeys: ['paidInvoiceCount'],
          action: 'Kiem tra nhu cau.',
        },
      ],
      limitations: ['Chua xac nhan nguyen nhan.'],
    });
    expect(result.summary).not.toContain('nhu cau');
    expect(result.findings[0].detail).toBe('Thuc thu cao hon ky so sanh.');
    expect(result.findings.at(-1)?.kind).toBe('HYPOTHESIS');
    expect(BusinessInsightAnalysisSchema.safeParse(result).success).toBe(true);
  });
});
