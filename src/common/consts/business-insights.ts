// Only text models with the same explicit low-thinking policy are supported.
export const BUSINESS_INSIGHT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
] as const;

export const BUSINESS_INSIGHT_ERROR_CODES = [
  'AI_PROVIDER_UNAVAILABLE',
  'AI_PROVIDER_REJECTED',
  'AI_INVALID_OUTPUT',
  'AI_DAILY_LIMIT',
  'AI_VERSION_CHANGED',
  'AI_JOB_EXPIRED',
  'AI_OUTCOME_UNKNOWN',
] as const;
