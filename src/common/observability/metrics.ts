import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';

export const metricsRegistry = new Registry();

export const turnstileVerificationsTotal = new Counter({
  name: 'coffee_shop_turnstile_verifications_total',
  help: 'Human verification results by bounded action and outcome.',
  labelNames: ['action', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const turnstileVerificationDurationSeconds = new Histogram({
  name: 'coffee_shop_turnstile_verification_duration_seconds',
  help: 'Human verification duration, including provider failures.',
  labelNames: ['action'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 3.5, 5],
  registers: [metricsRegistry],
});

export const aiInsightRequestsTotal = new Counter({
  name: 'coffee_shop_ai_insight_requests_total',
  help: 'Gemini insight requests by bounded outcome.',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const aiInsightTokensTotal = new Counter({
  name: 'coffee_shop_ai_insight_tokens_total',
  help: 'Provider-reported tokens consumed by business insights.',
  registers: [metricsRegistry],
});

export const aiInsightJobsTotal = new Counter({
  name: 'coffee_shop_ai_insight_jobs_total',
  help: 'Observed BullMQ insight transitions, separating retries from terminal outcomes.',
  labelNames: ['outcome', 'error_code'] as const,
  registers: [metricsRegistry],
});

export const aiInsightJobDurationSeconds = new Histogram({
  name: 'coffee_shop_ai_insight_job_duration_seconds',
  help: 'Terminal insight job elapsed time, including queue wait and retries.',
  labelNames: ['outcome'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

export const aiInsightProviderDurationSeconds = new Histogram({
  name: 'coffee_shop_ai_insight_provider_duration_seconds',
  help: 'Gemini adapter attempt duration, including response validation.',
  buckets: [0.5, 1, 2, 5, 10, 15, 30],
  registers: [metricsRegistry],
});

export const aiInsightEnabled = new Gauge({
  name: 'coffee_shop_ai_insight_enabled',
  help: 'Whether manager AI insights are configured as enabled.',
  registers: [metricsRegistry],
});

export const aiInsightQueueUp = new Gauge({
  name: 'coffee_shop_ai_insight_queue_up',
  help: 'Whether the last enabled insight queue collection succeeded.',
  registers: [metricsRegistry],
});

export const aiInsightQueueJobs = new Gauge({
  name: 'coffee_shop_ai_insight_queue_jobs',
  help: 'Current insight jobs by state; waiting includes a paused queue.',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

export const aiInsightQueueHeadAgeSeconds = new Gauge({
  name: 'coffee_shop_ai_insight_queue_head_age_seconds',
  help: 'Maximum age of FIFO waiting/paused heads and active insight job; excludes delayed retries.',
  registers: [metricsRegistry],
});

metricsRegistry.setDefaultLabels({
  service: process.env.APP_NAME ?? 'coffee_shop_be',
});

collectDefaultMetrics({
  prefix: 'coffee_shop_',
  register: metricsRegistry,
});

export const httpRequestsTotal = new Counter({
  name: 'coffee_shop_http_requests_total',
  help: 'Total HTTP requests handled by the API.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'coffee_shop_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const httpRequestsInFlight = new Gauge({
  name: 'coffee_shop_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed.',
  registers: [metricsRegistry],
});

export const kitchenSseActiveConnections = new Gauge({
  name: 'coffee_shop_kitchen_sse_active_connections',
  help: 'Active kitchen SSE subscriptions on this application instance.',
  registers: [metricsRegistry],
});

export const transactionRetriesTotal = new Counter({
  name: 'coffee_shop_transaction_retries_total',
  help: 'Serializable transaction retries caused by database conflicts.',
  labelNames: ['context', 'error_code'] as const,
  registers: [metricsRegistry],
});

export const dependencyUp = new Gauge({
  name: 'coffee_shop_dependency_up',
  help: 'Whether a required dependency is reachable (1) or unavailable (0).',
  labelNames: ['dependency'] as const,
  registers: [metricsRegistry],
});

export const redisMemoryUsedBytes = new Gauge({
  name: 'coffee_shop_redis_memory_used_bytes',
  help: 'Redis dataset and allocator memory reported by INFO memory.',
  registers: [metricsRegistry],
});
export const redisMaxMemoryBytes = new Gauge({
  name: 'coffee_shop_redis_maxmemory_bytes',
  help: 'Configured Redis maxmemory; zero means unlimited.',
  registers: [metricsRegistry],
});
export const rateLimitUnavailableTotal = new Counter({
  name: 'coffee_shop_rate_limit_unavailable_total',
  help: 'Rate limiter command failures, including OOM and ACL errors.',
  registers: [metricsRegistry],
});

export const postgresConnections = new Gauge({
  name: 'coffee_shop_postgres_connections',
  help: 'Current PostgreSQL server connections across all databases.',
  registers: [metricsRegistry],
});

export const postgresMaxConnections = new Gauge({
  name: 'coffee_shop_postgres_max_connections',
  help: 'Configured PostgreSQL server max_connections value.',
  registers: [metricsRegistry],
});

export const outboxEvents = new Gauge({
  name: 'coffee_shop_outbox_events',
  help: 'Durable outbox event count by status.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const outboxLagSeconds = new Gauge({
  name: 'coffee_shop_outbox_lag_seconds',
  help: 'Age in seconds of the oldest pending or processing outbox event.',
  registers: [metricsRegistry],
});

export const outboxDispatchTotal = new Counter({
  name: 'coffee_shop_outbox_dispatch_total',
  help: 'Outbox dispatch outcomes.',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const paymentReviewItems = new Gauge({
  name: 'coffee_shop_payment_review_items',
  help: 'Payment records currently requiring manual review.',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

export const paymentReconciliationIncidents = new Gauge({
  name: 'coffee_shop_payment_reconciliation_incidents',
  help: 'Open payment reconciliation incidents by type.',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

export const metricsCollectionFailuresTotal = new Counter({
  name: 'coffee_shop_metrics_collection_failures_total',
  help: 'Operational metrics collection failures by collector.',
  labelNames: ['collector'] as const,
  registers: [metricsRegistry],
});
