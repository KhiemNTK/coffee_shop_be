import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { EnvironmentSchema } from '../config/environment';
import { GeminiInsightsService } from '../app/reports/gemini-insights.service';
import { BUSINESS_INSIGHT_EVALUATION_CASES } from '../app/reports/evaluation/business-insight.cases';
import { BUSINESS_INSIGHT_PROMPT_VERSION } from '../app/reports/business-insight.schema';
import { BUSINESS_INSIGHT_ERROR_CODES } from '../common/consts/business-insights';
import { aiInsightTokensTotal } from '../common/observability/metrics';

const smokeConfiguration = EnvironmentSchema.pick({
  GEMINI_API_KEY: true,
  GEMINI_MODEL: true,
  GEMINI_DATA_POLICY_ACKNOWLEDGED: true,
  GEMINI_TIMEOUT_MS: true,
  GEMINI_MAX_OUTPUT_TOKENS: true,
}).strip();

export async function runAiSmoke(
  args: string[],
  environment: Record<string, unknown>,
) {
  const { values } = parseArgs({
    args,
    options: {
      live: { type: 'boolean', default: false },
      case: { type: 'string', default: 'normal-growth' },
      'review-file': { type: 'string' },
    },
  });
  if (!values.live)
    return {
      status: 'SKIPPED',
      reason:
        'Use --live to allow one potentially billable Gemini call with synthetic data.',
    };
  const configuration = smokeConfiguration.parse(environment);
  if (
    !configuration.GEMINI_API_KEY ||
    !configuration.GEMINI_MODEL ||
    !configuration.GEMINI_DATA_POLICY_ACKNOWLEDGED
  )
    throw new Error('AI_SMOKE_CONFIG_INVALID');
  const scenario = BUSINESS_INSIGHT_EVALUATION_CASES.find(
    (scenario) => scenario.id === values.case,
  );
  if (!scenario || scenario.id === 'no-sales')
    throw new Error('AI_SMOKE_CASE_INVALID');
  const gemini = new GeminiInsightsService(new ConfigService(configuration));
  const before = (await aiInsightTokensTotal.get()).values[0]?.value ?? 0;
  // Reserve an operator-requested file before spending a provider call; never overwrite it.
  const reviewFile = values['review-file']
    ? await open(values['review-file'], 'wx', 0o600)
    : undefined;
  const started = performance.now();
  let providerCompleted = false;
  try {
    const result = await gemini.generate(
      scenario.snapshot,
      configuration.GEMINI_MODEL,
    );
    providerCompleted = true;
    if (reviewFile) {
      await reviewFile.writeFile(
        JSON.stringify(
          {
            syntheticDataOnly: true,
            caseId: scenario.id,
            model: configuration.GEMINI_MODEL,
            promptVersion: BUSINESS_INSIGHT_PROMPT_VERSION,
            snapshot: scenario.snapshot,
            suggestions: result,
            reviewFocus: scenario.review,
            humanReview: {
              reviewer: null,
              evidenceCorrectness: null,
              uncertainty: null,
              actionability: null,
              approved: false,
            },
          },
          null,
          2,
        ),
      );
      await reviewFile.close();
    }
    const tokens = (await aiInsightTokensTotal.get()).values[0]?.value ?? 0;
    return {
      status: 'PASSED',
      caseId: scenario.id,
      model: configuration.GEMINI_MODEL,
      promptVersion: BUSINESS_INSIGHT_PROMPT_VERSION,
      elapsedMs: Math.round(performance.now() - started),
      reportedTokens: tokens > before ? tokens - before : null,
      findingCount: result.findings.length,
      qualityReview: 'REQUIRED_NOT_AUTOMATICALLY_SCORED',
    };
  } catch (error) {
    return {
      status: 'FAILED',
      elapsedMs: Math.round(performance.now() - started),
      providerCompleted,
      errorCode: providerCompleted
        ? 'AI_SMOKE_REVIEW_WRITE_FAILED'
        : (BUSINESS_INSIGHT_ERROR_CODES.find(
            (code) => error instanceof Error && error.message === code,
          ) ?? 'AI_SMOKE_FAILED'),
    };
  } finally {
    gemini.stop();
    await reviewFile?.close().catch(() => {});
  }
}

if (require.main === module) {
  config({ quiet: true });
  void runAiSmoke(process.argv.slice(2), process.env)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'FAILED') process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        'AI_SMOKE_CONFIG_OR_INPUT_INVALID: check backend Gemini configuration, policy acknowledgement and --case.',
      );
      process.exitCode = 1;
    });
}
