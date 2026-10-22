# AI Activation And Evaluation

Scope: one shop, occasional manager analyses, not autonomous decisions. Checkout
and public recommendations never depend on Gemini. Apply the history migration
`20261022020000_add_business_insight_history` before deploying this version;
no additional dependency or permission seed is required. Leave `AI_INSIGHTS_ENABLED=false` until the
activation checks below are complete. Do not put Gemini credentials in frontend
configuration or commit a filled `.env`.

## Configuration And API

Enable only with backend `GEMINI_API_KEY`, a supported `GEMINI_MODEL`,
`GEMINI_DATA_POLICY_ACKNOWLEDGED=true` and `REDIS_URL`. Supported models are listed
in `src/common/consts/business-insights.ts`. Defaults: 15-second timeout,
20 admitted requests/provider calls per UTC day (separate counters), 3,000 output
tokens, seven-day result retention and at most 31 days per analysis. Provider
retries consume the call budget. Limits do not guarantee successful analyses.

- `GET /api/v1/reports/insights/config`: configuration, requires `/reports_read`.
- `POST /api/v1/reports/insights`: 202; requires `/reports_read` and
  `/reports_insights_generate`. Send UUID `clientRequestId`, ISO `from`/`to` and
  `timeZone=Asia/Ho_Chi_Minh`; do not end in the future.
- `GET /api/v1/reports/insights/:id`: creator-only result with `/reports_read`.

Request IDs are employee-scoped. Reusing one with a different period returns 409.
States remain QUEUED, PROCESSING, COMPLETED and FAILED; failures expose safe codes,
not provider text. The API contract and frontend authorization are unchanged.

## Queue Monitoring

The existing protected `/metrics` endpoint collects queue counts and FIFO heads,
using its five-second cache. No new polling timer runs. Disabled AI does not open
a queue connection. Collection has bounded Redis deadlines; failure clears stale
queue gauges and sets `coffee_shop_ai_insight_queue_up=0`.

- `coffee_shop_ai_insight_jobs_total{outcome,error_code}` distinguishes `retry`,
  `completed` and terminal `failed` transitions. Error codes are allowlisted.
- `coffee_shop_ai_insight_job_duration_seconds` includes queue wait and retries
  for terminal jobs. `coffee_shop_ai_insight_provider_duration_seconds` measures
  each adapter attempt, including response validation and failures.
- `coffee_shop_ai_insight_queue_jobs{state}` includes waiting (also paused),
  active, delayed and retained failed jobs. Retained failures are not a new-failure rate.
- `coffee_shop_ai_insight_queue_head_age_seconds` is the maximum age of FIFO
  waiting/paused heads and the active job, not a scan of every retained job.
  Delayed retries have separate depth and are excluded from this age.

Load `../observability/prometheus-rules.yml`: queue inspection outage, old queue
heads, persistently delayed retries and repeated terminal failures have warning alerts. Labels never contain
employee/job IDs, prompts, provider text or secrets. Job IDs remain in logs for
diagnosis. Logs do not include raw exception text.

Counters describe locally observed transitions, not an exactly-once billing
ledger. Worker/process termination can lose observations; use Redis queue gauges
and provider usage as well. Multiple replicas expose the same queue depth: use
`max`, not `sum`, to display global depth. Counters can be summed across replicas.

Incident: inspect safe error codes and queue/Redis health first. Configuration
rejection needs a credential/model check; quota exhaustion needs a budget check;
invalid output needs schema/provider investigation. Do not repeatedly resubmit
jobs with new IDs. Reuse the same employee/request ID for an uncertain POST. Set
`AI_INSIGHTS_ENABLED=false` and restart to stop accepting paid analyses. This is
not cancellation of queued jobs; inspect outstanding work before re-enabling.
Jobs older than the seven-day read retention fail with `AI_JOB_EXPIRED` before
snapshot capture or a paid call, rather than paying for an unreadable result.

## Deterministic Quality Cases

`src/app/reports/evaluation/business-insight.cases.ts` defines twelve synthetic
cases: growth, equality, no sales, decline, refund spike, negative profit, missing
current/prior costs, zero current/prior costs, small sample and decimal boundary.
Tests verify observations and suppress profit-efficiency observations when costs
are unreliable. The no-sales production path never needs a Gemini call.

These tests do not grade generated reasoning. For each real provider evaluation,
record commit, model, prompt version, case ID, reviewer and date. Score each item
0 (wrong), 1 (needs correction), or 2 (acceptable):

| Criterion            | Reviewer checks                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Evidence correctness | Cited metrics actually support the check being proposed; no contradiction of the snapshot.               |
| Uncertainty          | Causes are hypotheses, not proven facts; missing costs and small samples are acknowledged when relevant. |
| Actionability        | A manager can verify the suggestion without executing payments, price or stock changes.                  |

Any fabricated fact, unsupported cause presented as fact, private-data request,
or proposed financial/stock mutation is a hard failure, regardless of score.
Approve only cases with all criteria at 2 and no hard failure. Evaluate multiple
outputs when changing model/prompt; a single successful call proves compatibility,
not repeatable reasoning quality. Never use an AI judge as the only approver.

## Explicit Provider Smoke

```powershell
pnpm ai:smoke
# SKIPPED, no provider call.

# Backend-only GEMINI_API_KEY, GEMINI_MODEL and policy acknowledgement must be set.
pnpm ai:smoke --live --case normal-growth

# Optional human-review artifact containing only synthetic input and generated suggestions.
# Parent directory must exist; an existing file is never overwritten.
pnpm ai:smoke --live --case missing-current-costs --review-file .tmp/ai-review.json
```

The command sends exactly one synthetic snapshot, without retries, SQL, Redis or
application startup. It does not change the application enable flag. `--live`
explicitly allows a potentially billable request and bypasses the application's
Redis daily budget: do not loop it or include it in normal CI. Console output
contains only status, version, duration, token count (null if unreported) and
finding count. It never prints credentials or narrative. An optional review file
has no credentials, starts unapproved and is not automatically accepted by the
application. Protect it and do not treat synthetic evaluations as actual results.
If the artifact write fails after generation, `providerCompleted=true` warns that
a paid call may already have succeeded. Do not blindly retry. An interrupted
write can leave an incomplete file; choose a new path only after checking cost.

Before activation, verify real successful, blocked/truncated and timeout cases;
model/schema compatibility; queue recovery after Redis/process restart; disabled
behavior; and RBAC. Verify the project's billing/data policy with the operator,
not just `GEMINI_DATA_POLICY_ACKNOWLEDGED=true`. Review the official
[Gemini data terms](https://ai.google.dev/gemini-api/terms).

Results/snapshots and private seven-day history live in PostgreSQL; BullMQ delivery
and daily call budgets use Redis. See `docs/business-insights.md` for the list API,
outbox recovery and `AI_OUTCOME_UNKNOWN`. Keep persistence, `noeviction` and
provider-side budget controls. Redis data loss can lose pending work/reset counters;
the implementation does not promise a hard currency spending cap. PostgreSQL
history is derived data, not an accounting ledger. Expiry cleanup uses the existing
outbox housekeeping; do not disable its production poll loop.

## Recommendation Baseline

```powershell
pnpm recommendations:evaluate --input test/fixtures/recommendation-evaluation.json
```

This is an offline, read-only file tool: no database connection, writes, Gemini
call or exposure records. The committed fixture proves wiring only; its scores
are not evidence of business uplift. An approved real export contains only:
`schemaVersion=1`, `trainFrom`, `splitAt`, `testTo`, `availableMenuItemIds`, and
`baskets[{id,createdAt,menuItemIds}]`. Use pseudonymous, stable IDs and ISO timestamps.
Do not include names, contact details, notes or prices. Input is strict and bounded
to 5 MiB, 10,000 unique baskets and 10 unique items per basket.

Use non-cancelled, distinct item IDs from paid/partially-refunded invoices. Match
the serving invoice-creation-time cohort. For a valid historical experiment,
export from approved as-of snapshots: using today's refund/payment/availability
state can leak future information. This tool cannot reconstruct unavailable
historical states and cannot establish that an operator's export is authentic.

Training is `[trainFrom, splitAt)` (at most 90 days); testing is `[splitAt, testTo)`
(at most 31 days). Test baskets never update training. The tool uses the same
ranking function, support threshold, top-pair limit and result limit as serving.
One item per eligible test basket is hidden reproducibly using its ID; the other
items are anchors. Both co-purchase and popularity use the same frozen available
catalog and exclude anchors. This is basket completion, not prediction of click
order, real-time stock availability or personalized customer preferences.

Output reports hit rate and mean reciprocal rank at 3, offer coverage, average
suggestion count, cold targets and skipped baskets. Abstentions count as misses,
not filtered-out successes. No eligible cases fails instead of returning an
invented score. Review sample size, cold starts and coverage before interpreting
results. These metrics are descriptive; only a properly run online experiment
can support an uplift claim. No automatic production model switch is performed.
