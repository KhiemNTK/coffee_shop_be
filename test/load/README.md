# Read-Only Load Test

Use isolated staging with representative PostgreSQL/Redis sizing and k6 installed.
Never target shop traffic, real orders or live payment/stock data.

From the backend root:

```powershell
$env:API_BASE_URL = 'https://staging.example.com/api/v1'
$env:ACCESS_TOKEN = '<staging-employee-access-token>'
pnpm test:load
Remove-Item Env:ACCESS_TOKEN
```

The employee needs read permissions for menu, dining tables and order sessions.
[coffee-shop.k6.js](coffee-shop.k6.js) ramps to 250 RPS, holds, bursts to 500 RPS,
then recovers. Passing requires p95 below 300 ms, errors below 1%, checks above
99% and no dropped iterations. This profile does not measure mutation throughput.

Run k6 outside the application host. The generator has one source IP; normal
rate limits can return 429 well before the target. Document any staging-only limit
adjustment and test real abuse controls/NAT behavior separately, without weakening
production limits.

Save the commit, sizing, configuration and k6 summary with release evidence.
A configured target is not a measured capacity guarantee. Financial/inventory
load needs separate fixtures and unique idempotency keys; it is not part of this
read-only profile. See [release gates](../../deploy/README.md#release-gate).
