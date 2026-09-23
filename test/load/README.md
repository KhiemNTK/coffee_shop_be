# Load Test

Run only against an isolated staging environment with production-like
PostgreSQL and Redis sizing. The token must belong to a seeded employee with
read permissions for menu, dining tables and order sessions.

```powershell
$env:API_BASE_URL='https://staging.example.com/api/v1'
$env:ACCESS_TOKEN='<access-token>'
pnpm test:load
```

The profile ramps to 250 RPS, holds it, bursts to 500 RPS and then recovers.
It fails when read p95 reaches 300 ms, errors reach 1 percent, checks fall below
99 percent or the load generator drops an iteration. Run the generator outside
the application host and save the k6 summary with the release evidence.

This script is read-only by design. Financial and inventory mutation load tests
need isolated fixtures and unique idempotency keys; do not point them at shared
staging or production data.
