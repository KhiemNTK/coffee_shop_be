# AI Activation And Evaluation

Optional manager analysis runs in the existing backend/BullMQ worker. Gemini
never blocks POS checkout or public recommendations and never executes business
mutations. Keep `AI_INSIGHTS_ENABLED=false` until acceptance is complete.
Use the [single-VPS runbook](../README.md) for deployment, not a separate release path.

## Configuration And API

Configure backend-only `GEMINI_API_KEY`, `GEMINI_MODEL`, `REDIS_URL` and
`GEMINI_DATA_POLICY_ACKNOWLEDGED=true`, then enable `AI_INSIGHTS_ENABLED`.
Review provider billing/data policy with the operator; the flag is not consent
by itself. Use a model in [the supported list](../../src/common/consts/business-insights.ts).
See [.env.example](../../.env.example) for timeout, output and daily limits.

Defaults: 15-second provider timeout, 20 admitted requests and 20 provider calls
per UTC day (separate budgets), 3,000 output tokens and seven-day private history.
An analysis covers at most 31 days and cannot end in the future. Retries consume
provider-call budget; limits do not guarantee successful analyses.

| Route under `/api/v1/reports/insights` | Purpose                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /config`                          | Enabled state and configuration; requires `/reports_read`.                                                                |
| `POST /`                               | Returns 202; requires read and `/reports_insights_generate`. Send UUID `clientRequestId`, ISO `from`/`to` and `timeZone`. |
| `GET /` and `GET /:id`                 | Creator-only history/result with `/reports_read`.                                                                         |

Reuse the employee-scoped request ID after an uncertain POST. A different period
with that ID returns 409. States are QUEUED, PROCESSING, COMPLETED and FAILED.
Failures expose safe codes, not provider output. An unknown provider outcome
needs review (`AI_OUTCOME_UNKNOWN`), not another request with a fresh ID.
The [controller](../../src/app/reports/business-insights.controller.ts) and
[service](../../src/app/reports/business-insights.service.ts) define the contract.

History/snapshots live in PostgreSQL; delivery and budgets also require persistent
Redis with `noeviction`. Keep outbox dispatch/housekeeping running. Redis data loss
can reset counters or lose queue work: use provider-side spend limits too.
This is not a hard currency cap or an accounting ledger. Expired jobs fail before
snapshot capture/provider calls. Disabling AI and restarting stops admission,
not cancellation of queued jobs; inspect outstanding work before re-enabling.

## Evaluation Before Activation

Use [synthetic cases](../../src/app/reports/evaluation/business-insight.cases.ts)
for deterministic metrics and safety checks. They do not grade generated reasoning.
For each model/prompt change, record commit, model, prompt version, case and reviewer.

Approve only outputs whose evidence matches the snapshot, uncertainty is explicit
and suggested checks are useful without executing payments, prices or stock changes.
Fabricated facts, proven-cause claims without evidence, private-data requests or
financial mutation instructions are failures. Use human review across multiple
outputs; one successful call proves compatibility, not reasoning quality.

From the backend root:

```powershell
pnpm ai:smoke
```

Without `--live`, no provider call is made. A deliberately billable synthetic check:

```powershell
pnpm ai:smoke --live --case normal-growth
```

This sends one synthetic snapshot without retries, DB/Redis or app startup.
It bypasses application daily budgets: never loop it or add live mode to normal CI.
Optional `--review-file .tmp/ai-review.json` needs an existing parent directory,
does not overwrite files and starts unapproved. Protect generated narratives.
If `providerCompleted=true` accompanies an artifact failure, a paid call already
succeeded; do not retry blindly.

Before activation, verify successful, truncated/blocked and timeout responses,
RBAC, disabled mode and Redis/process restart recovery. Never claim merchant or
provider readiness from fixture results.

## Queue Monitoring

Use the existing protected `/metrics` and
[alert rules](../observability/prometheus-rules.yml):

| Metric                                             | Meaning                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `coffee_shop_ai_insight_queue_up`                  | Queue inspection succeeded; failure clears stale queue gauges.                    |
| `coffee_shop_ai_insight_jobs_total`                | Locally observed retry/completed/terminal-failed transitions, not billing.        |
| `coffee_shop_ai_insight_job_duration_seconds`      | Terminal duration including queue wait/retries.                                   |
| `coffee_shop_ai_insight_provider_duration_seconds` | Each provider attempt including validation.                                       |
| `coffee_shop_ai_insight_queue_jobs`                | Counts by state; retained failures are not a new-failure rate.                    |
| `coffee_shop_ai_insight_queue_head_age_seconds`    | FIFO waiting/paused head and active-job age; delayed retries have separate depth. |

Inspection is bounded and cached for five seconds; disabled AI opens no metrics
queue connection. Use `max`, not `sum`, for shared queue gauges across replicas.
Counters can be summed but can lose observations on crashes. Investigate safe
codes and Redis/queue health before resubmitting; do not log prompts, raw output,
credentials or customer data. See [observability](../observability/README.md).

## Recommendation Baseline

```powershell
pnpm recommendations:evaluate --input test/fixtures/recommendation-evaluation.json
```

This offline file tool makes no DB/provider calls or writes. The fixture tests
wiring, not sales uplift. The strict export schema is defined in
[the evaluator](../../src/cli/recommendation-evaluation.ts); use pseudonymous
basket/item IDs, no contacts/notes/prices. Limits: 5 MiB, 10,000 unique baskets,
10 distinct items per basket, at most 90 training days and 31 test days.

Use approved as-of paid/partially-refunded invoice snapshots. Today's availability
or refund state can leak future data; the tool cannot reconstruct missing history
or authenticate an export. Testing never updates training. The same ranking is
compared with popularity on a frozen available catalog.

Hit rate/MRR at 3, coverage, cold targets and abstentions describe basket completion,
not click prediction or personalization. No eligible cases fails rather than
inventing a score. Only a valid online experiment can support an uplift claim;
no automatic production model switch is performed.
