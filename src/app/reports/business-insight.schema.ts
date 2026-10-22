import { z } from 'zod';

export const BUSINESS_INSIGHT_PROMPT_VERSION = 'business-finance-v3';
export const BUSINESS_INSIGHT_RETENTION_DAYS = 7;
export const BUSINESS_INSIGHT_MAX_RANGE_DAYS = 31;

export const BusinessInsightSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  asOf: z.iso.datetime({ offset: true }),
  currentPeriod: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  comparisonPeriod: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  timeZone: z.literal('Asia/Ho_Chi_Minh'),
  comparisonBasis: z.enum([
    'PREVIOUS_DAY_SAME_WINDOW',
    'PREVIOUS_EQUAL_DURATION',
  ]),
  basis: z.object({
    sales: z.literal('INVOICE_CREATED_AT'),
    refunds: z.literal('COHORT_REFUNDS_AS_OF_SNAPSHOT'),
    waste: z.literal('WASTE_CREATED_AT'),
  }),
  metrics: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().min(1),
        value: z.string().regex(/^-?\d+(?:\.\d+)?$/),
        previousValue: z.string().regex(/^-?\d+(?:\.\d+)?$/),
        unit: z.enum(['VND', 'COUNT']),
      }),
    )
    .max(64),
});

export const BusinessInsightAnalysisSchema = z.strictObject({
  summary: z.string().trim().min(1).max(600),
  findings: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(120),
        kind: z.enum(['OBSERVATION', 'HYPOTHESIS']),
        detail: z.string().trim().min(1).max(500),
        metricKeys: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(5)
          .refine((keys) => new Set(keys).size === keys.length),
        action: z.string().trim().min(1).max(240),
      }),
    )
    .min(1)
    .max(5),
  limitations: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
});

// Provider text is never allowed to masquerade as a verified observation.
export const BusinessInsightSuggestionsSchema = z.strictObject({
  findings: z
    .array(
      BusinessInsightAnalysisSchema.shape.findings.element.extend({
        kind: z.literal('HYPOTHESIS'),
      }),
    )
    .min(1)
    .max(2),
  limitations: z.array(z.string().trim().min(1).max(240)).min(1).max(2),
});
