import type { z } from 'zod';
import type {
  BusinessInsightAnalysisSchema,
  BusinessInsightSuggestionsSchema,
} from '../../app/reports/business-insight.schema';

export type BusinessInsightAnalysis = z.infer<
  typeof BusinessInsightAnalysisSchema
>;

export type BusinessInsightSuggestions = z.infer<
  typeof BusinessInsightSuggestionsSchema
>;

export interface BusinessInsightSnapshot {
  schemaVersion: 2;
  asOf: string;
  currentPeriod: { from: string; to: string };
  comparisonPeriod: { from: string; to: string };
  timeZone: 'Asia/Ho_Chi_Minh';
  comparisonBasis: 'PREVIOUS_DAY_SAME_WINDOW' | 'PREVIOUS_EQUAL_DURATION';
  basis: {
    sales: 'INVOICE_CREATED_AT';
    refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT';
    waste: 'WASTE_CREATED_AT';
  };
  metrics: Array<{
    key: string;
    label: string;
    value: string;
    previousValue: string;
    unit: 'VND' | 'COUNT';
  }>;
}

export interface BusinessInsightJobData {
  employeeId: string;
  requestHash: string;
  requestedAt: string;
  from: string;
  to: string;
  timeZone: string;
  model: string;
  promptVersion: string;
  snapshot?: BusinessInsightSnapshot;
}

export interface BusinessInsightResult {
  snapshot: BusinessInsightSnapshot;
  analysis: BusinessInsightAnalysis;
}
