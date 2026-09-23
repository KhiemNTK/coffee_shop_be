import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';

export const metricsRegistry = new Registry();

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
