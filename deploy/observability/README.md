# Production Observability

Use the [deployment runbook](../README.md) for release, backup and recovery.
Metrics/logs diagnose the system; they are not payment or accounting evidence.

## Prometheus

Enable metrics and scrape `GET /metrics` on the private monitoring network.
Production requires `METRICS_TOKEN`; the endpoint bypasses the Redis limiter,
not bearer authentication. Never commit the token.

```yaml
scrape_configs:
  - job_name: coffee-shop-api
    authorization:
      type: Bearer
      credentials_file: /run/secrets/coffee-shop-metrics-token
    static_configs:
      - targets: [backend:3000]
```

Use the actual reachable service address; `backend` is the production Compose
service name. A scraper outside that Docker network needs an approved private route.
Load [prometheus-rules.yml](prometheus-rules.yml) through `rule_files` and route
critical/warning alerts to a monitored channel.

Validate existing outage scenarios from the backend root:

```powershell
docker run --rm --entrypoint /bin/promtool --mount "type=bind,source=$((Resolve-Path deploy/observability).Path),target=/rules,readonly" prom/prometheus:v3.5.0 test rules /rules/prometheus-rules.test.yml
```

| Signal                                                                     | Interpretation                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| HTTP latency/errors/in-flight                                              | REST durations exclude SSE lifetimes; request/in-flight counts still include SSE.                           |
| Dependency/collector failures                                              | Some business gauges retain the last successful value; verify collection health before trusting them.       |
| `coffee_shop_postgres_connections`                                         | PostgreSQL server connections, not Prisma's private pool occupancy.                                         |
| `coffee_shop_redis_memory_used_bytes`, `coffee_shop_redis_maxmemory_bytes` | Redis memory/ceiling, not container RSS or host free RAM; warnings start above 80% or an unlimited ceiling. |
| `coffee_shop_rate_limit_unavailable_total`                                 | Redis command failures, including OOM/ACL/persistence failures even if PING succeeds.                       |
| `coffee_shop_kitchen_sse_active_connections`                               | Active subscriptions per instance, not unique devices; sum across instances.                                |
| Outbox lag, retries/dead letters and payment mismatches                    | Investigate persisted state before replay or manual action.                                                 |

Redis checks/INFO collection have bounded deadlines. Its health connection needs
PING/INFO/initialization permissions; the limiter also needs EVAL/key writes and
BullMQ needs its command set. PING alone does not prove the app can write.
Inspect host/container memory too; never enable eviction to relieve queue pressure.

## Log And Exception Diagnosis

Production logs are JSON stdout with request correlation, without whole request
bodies/responses. Redaction is a safety net, not permission to log provider
payloads, Prisma arguments, URLs with credentials or customer details.

The management inbox is read-only. Resolve source cases through their payment,
cashier, feedback or printing workflow so permissions and audit remain in force.
Uncertain paper output needs operator review, not a blind reprint.

Dead-letter details expose safe `lastErrorCode`, `lastFailedAt` and `requestId`,
not raw payloads/errors. Search logs by request/event ID, fix the cause, then
explicitly retry with a reason. Requeued means waiting, not published.

## OpenTelemetry

Tracing is optional; set these only when a collector is ready:

```text
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

HTTP, Express, NestJS and ioredis are instrumented. Logs stay JSON stdout and
application metrics stay Prometheus-native. Redis spans retain command names,
not keys, arguments, Lua or job payloads. Log redaction does not scrub OTLP spans.

## Kitchen Realtime

Streams renew after at most 60 seconds through normal auth/permission guards;
revocation can therefore leave an existing stream open for up to one minute.
The active-connection gauge returns to zero on disconnect/shutdown.

KDS reconciles by HTTP every 60 seconds while connected. SSE error or 45 seconds
without a heartbeat/event enables ticket polling every 6 seconds and workload
polling every 15 seconds, with reconnect attempts every 5 seconds. The displayed
update time is the last successful ticket HTTP read, not a connection timestamp.

Only valid new-ticket events for the selected station whose release is due may
chime. The latest 200 IDs are deduplicated per mounted KDS; other tabs/reloads
have separate sound state. Scheduled release remains visible through polling.

Relay health requires publisher connectivity and subscriber acknowledgement.
Connection messages/heartbeats switch the UI to periodic updates when the relay
fails. Local refreshes are delivered before publish; each API process deduplicates
its latest 500 IDs against Redis echoes. Pub/Sub is not durable replay: HTTP
reconciliation remains required. See [implementation](../../src/app/kitchen/).

## Request Throttling

Public/auth limits use IP identity. Protected staff routes apply a coarse IP
budget first, then the authenticated employee's route budget after auth.
Both Redis stages fail closed; payment callbacks retain a separate per-instance
limit and still require signatures/replay protection. Health and protected metrics
remain accessible during ordinary limiter outages.

The UI reads bounded `Retry-After` seconds/HTTP dates and waits for explicit action.
Expiry does not retry a write or replace its idempotency key. Review reverse-proxy
limits before scaling replicas or serving many clients behind one public IP.

## Outbox Delivery

PostgreSQL is the durable source. Dispatcher claims enter ENQUEUED; workers
re-read and conditionally acquire PROCESSING execution leases. Active work renews
every 20 seconds. Abandoned 90-second leases are checked every 15 seconds plus
dispatch polling; DB outages/event-loop stalls can extend recovery.

Producer readiness/commands have two-second deadlines. Enqueue failure releases
unsubmitted claims with lease checks, without spending consumer retries.
Blocking worker connections do not use the producer command timeout.

Shutdown stops new claims, joins dispatch, releases unqueued claims, then closes
worker/producer connections before removing listeners/dependencies. A forced stop
may still need lease recovery. Stop old workers before migrating lease/context
changes; do not mix versions.

Allowlisted request/actor/trace context follows events into worker logs and audit;
legacy events use `outbox:<event-id>`. No tokens, request bodies or arbitrary
baggage are captured. Fencing protects stale acknowledgements, not exactly-once
external email/Telegram delivery. Consumers retain durable idempotency.
See [durable implementation](../../src/app/durable/).

## Decimal Responses And AI

HTTP and stored idempotent responses share Decimal serialization: safe exact
values remain numbers; wider/lossy values remain strings. Reconcile old rounded
snapshots against invoices/ledgers; never erase financial replay keys to retry.

Enabled AI uses bounded queue collection in the same scrape; disabled AI does not
open a metrics queue connection. Shared queue gauges use `max` across replicas,
not `sum`. See [AI activation](../ai/README.md) for budget and evaluation limits.
