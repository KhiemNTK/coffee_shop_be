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
