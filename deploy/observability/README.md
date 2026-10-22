# Production Observability

## Prometheus

Scrape `GET /metrics` with the production `METRICS_TOKEN` as a bearer token.
Keep the token in the deployment secret store, not in Prometheus configuration
committed to Git.

```yaml
scrape_configs:
  - job_name: coffee-shop-api
    authorization:
      type: Bearer
      credentials_file: /run/secrets/coffee-shop-metrics-token
    static_configs:
      - targets: [coffee-shop-api:3000]
```

Load `prometheus-rules.yml` through Prometheus `rule_files`. Route critical
alerts to the on-call channel and warning alerts to the operations queue.

`coffee_shop_postgres_connections` measures PostgreSQL server connections. It
does not claim to expose Prisma's private pool occupancy. Correlate connection
pressure with request latency, transaction retries and PostgreSQL monitoring.

## OpenTelemetry

Tracing is opt-in. Set these variables only when an OTLP collector is ready:

```text
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

HTTP, Express, NestJS and ioredis are instrumented. Application metrics remain
Prometheus-native and logs remain JSON stdout to avoid duplicate telemetry.

## Kitchen Realtime

`coffee_shop_kitchen_sse_active_connections` counts active SSE subscriptions per
application instance, not unique devices or employees. It returns to zero when
clients disconnect or the application shuts down. Sum across instances for a
deployment total; do not use employee IDs or connection IDs as labels.

KDS keeps a 60-second HTTP reconciliation while connected. After an SSE error or
45 seconds without a heartbeat/event, it uses the existing ticket polling
(6 seconds) and workload polling (15 seconds), with reconnect attempts every
5 seconds. The status badge reports periodic updates until the stream reopens.
The displayed update time comes from the last successful ticket HTTP response.

Only new-ticket events with a validated station and a release time already due
may chime. Other events still refresh data. The latest 200 new-ticket event IDs
are deduplicated per mounted KDS session. Reloads and other tabs have independent
notification state; this is not an exactly-once delivery guarantee. Scheduled
release stays visual through reconciliation; add a durable release event only
if the shop needs a timed audible alert. No new Redis channel, queue, permission
or database migration is required.

## Optional AI Queue

When manager AI is enabled, the same scrape collects bounded BullMQ queue heads
and counts. AI disabled means no queue connection for metrics. Rules include AI
queue inspection failure, stalled queue heads and repeated terminal job failures.
See the [AI runbook](../ai/README.md) for metric meanings, retry accounting and
activation checks. Do not interpret token/job counters as a billing ledger.
