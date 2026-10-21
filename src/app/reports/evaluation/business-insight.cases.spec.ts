import { BUSINESS_INSIGHT_EVALUATION_CASES } from './business-insight.cases';
import { buildBusinessInsightAnalysis } from '../business-insight.analysis';
import { BusinessInsightAnalysisSchema } from '../business-insight.schema';

describe('business insight evaluation cases', () => {
  it.each(BUSINESS_INSIGHT_EVALUATION_CASES)(
    '$id preserves observations and cost safeguards',
    (scenario) => {
      const result = buildBusinessInsightAnalysis(scenario.snapshot);
      expect(BusinessInsightAnalysisSchema.safeParse(result).success).toBe(
        true,
      );
      expect(
        result.findings.every((finding) => finding.kind === 'OBSERVATION'),
      ).toBe(true);
      const receipts = result.findings.find((finding) =>
        finding.metricKeys.includes('netReceipts'),
      );
      const direction = {
        up: 'cao hon',
        down: 'thap hon',
        flat: 'khong thay doi',
      };
      expect(receipts?.detail).toContain(direction[scenario.receiptDirection]);
      expect(
        result.findings.some((finding) =>
          finding.metricKeys.includes('estimatedGrossProfit'),
        ),
      ).toBe(scenario.profitReliable);
      for (const finding of result.findings)
        expect(
          finding.metricKeys.every((key) =>
            scenario.snapshot.metrics.some((metric) => metric.key === key),
          ),
        ).toBe(true);
    },
  );
});
