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

`/metrics` bypasses the Redis-backed rate limiter, not its bearer-token check.
Keep it on the private monitoring network. PostgreSQL dependency and collector
failure alerts do not require a minimum number of HTTP requests. Failed collection
leaves the last successful business gauges in place; check dependency state and
collector failures before trusting them.

Redis health checks bound connection initialization and PING together, share an
in-flight check and close a stalled health connection before retrying. Memory
collection uses a bounded `INFO memory` on that dedicated connection. Allow
`PING`, `INFO` and initialization commands in its ACL; the runtime limiter also
requires `EVAL`/key writes and BullMQ needs its documented command set. Do not
assume PING success proves those writes are allowed.

`coffee_shop_redis_memory_used_bytes` and `coffee_shop_redis_maxmemory_bytes`
report Redis's memory usage and configured ceiling, not container RSS or host
free RAM. Rules warn above 80% and on unlimited maxmemory. Limiter command errors
increment `coffee_shop_rate_limit_unavailable_total` and alert even if PING works
(for example OOM, ACL or persistence write errors). Inspect container/host memory
as well; do not resolve queue pressure by enabling eviction.

Validate rules and their outage scenarios with a pinned Prometheus tool image:

```powershell
docker run --rm --entrypoint /bin/promtool --mount "type=bind,source=$((Resolve-Path deploy/observability).Path),target=/rules,readonly" prom/prometheus:v3.5.0 test rules /rules/prometheus-rules.test.yml
```

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
Redis spans retain command names only, never keys, Lua source, arguments or job
payloads. Winston log redaction is not a filter for OTLP span attributes.

## Kitchen Realtime

Each SSE connection sends `kitchen.renew` and closes after at most 60 seconds.
The frontend reconnects immediately through the existing authentication and
permission guards, preserving its event deduplication state. Revoked sessions or
permissions can therefore retain an existing stream for at most one minute;
there is no authorization query per message. Older frontends still reconnect
through their normal SSE error handling.

`coffee_shop_kitchen_sse_active_connections` counts active SSE subscriptions per
application instance, not unique devices or employees. It returns to zero when
clients disconnect or the application shuts down. Sum across instances for a
deployment total; do not use employee IDs or connection IDs as labels.
SSE lifetimes are excluded from the REST duration histogram; request counters
and in-flight gauges still include these connections.

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

Streams also send `kitchen.connection` and a `realtime` boolean in heartbeats.
The relay is ready only after subscription acknowledgement and while the
publisher is connected; losing either side switches the UI to periodic updates
without repeatedly reconnecting a healthy browser stream. Updated frontends
retain the last known relay state on legacy heartbeats. Local refreshes are
delivered before Redis publishing and the latest 500 event IDs are deduplicated
per API process against Pub/Sub echoes. This does not add durable message replay:
the existing HTTP reconciliation remains required.

## Request Throttling

Public/auth endpoints retain their existing IP limits. Protected staff routes
first use a coarse IP budget (10 times their route limit), then enforce the
original route limit by authenticated employee after `AuthGuard`. No identity
is taken from a client-supplied employee header or body. Both stages share the
Redis storage and remain fail-closed; payment webhooks keep their separate
per-instance policy. Do not reorder the employee guard before authentication.

The frontend reads bounded `Retry-After` seconds or HTTP dates, shows the wait
and disables resubmission in sign-in, checkout, payment and exception workflows.
Timers stop on expiry/unmount. The UI caps a wait at one hour; server limits
remain authoritative. Expiry only re-enables user actions; it never retries
mutations automatically or replaces their pending idempotency key.

## Outbox Delivery

Redis producer readiness and commands have a two-second application deadline;
the producer also uses a Redis command timeout. Blocking BullMQ worker
connections do not use that timeout. After an enqueue failure, the dispatcher
releases the rest of the unqueued batch with lease checks in one database update,
without spending the consumer retry budget.

Shutdown stops outbox before `app.close()` removes domain listeners. It stops
new claims, joins the in-flight dispatch, releases its unqueued claims, then
closes the worker before the producer queue. Repeated stop calls join the same
shutdown. The existing global
shutdown deadline still bounds shutdown; a forced stop may require lease
recovery and delivery remains at least once.

Apply `20261024200000_outbox_delivery_context` before deploying these workers.
Stop old API/worker processes first: mixed versions use different lease ownership
rules. The migration only adds an enum state and nullable context, and updates
the outbox state constraint; it does not rewrite business payloads.

Claims enter `ENQUEUED`. A worker re-reads PostgreSQL and conditionally acquires
a fresh `PROCESSING` execution lease, rather than trusting a Redis job's old
lease or retry count. Active execution renews its lease every 20 seconds.
Abandoned queued/running leases expire after 90 seconds, checked every 15 seconds
plus the configured dispatch polling interval, independently of retention cleanup.
This is a normal-operation recovery target, not a deadline during a database
outage or event-loop stall. Lease fencing prevents stale acknowledgements; it
does not make external email/Telegram delivery exactly once. Consumers must
retain their durable idempotency checks.

New events capture an allowlisted request ID, employee ID and W3C trace context
separately from their payload. Worker logs and transaction-created audit entries
restore this context; legacy events use `outbox:<event-id>` as their request ID.
No customer identifiers, auth tokens, request bodies or arbitrary tracing baggage
are captured. Trace export remains opt-in. POS checkout and exception actions
show a selectable/copyable support ID without discarding uncertain-payment state.

## Decimal Responses

HTTP and idempotent response storage use the same Decimal serializer. Existing
small exact-roundtrip values remain numbers; values beyond the safe money range
or values changed by number conversion are decimal strings. Clients must accept
both representations and calculate money using decimal/minor-unit helpers.
Previously rounded cached responses cannot be reconstructed from the cache.
Reconcile against the persisted invoice/ledger; never delete financial replay
keys just to force a new operation.

## Optional AI Queue

When manager AI is enabled, the same scrape collects bounded BullMQ queue heads
and counts. AI disabled means no queue connection for metrics. Rules include AI
queue inspection failure, stalled queue heads and repeated terminal job failures.
See the [AI runbook](../ai/README.md) for metric meanings, retry accounting and
activation checks. Do not interpret token/job counters as a billing ledger.
