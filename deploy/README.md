# Single VPS Deployment

Run from the backend repository on a Linux VPS. Keep `coffee_shop_be` and
`coffee_shop_fe` as sibling repositories and record both Git SHAs for each release.
This setup is one server, not high availability. It does not migrate or seed on startup.

Redis memory is configurable through `REDIS_MAXMEMORY` (dataset limit, default
`128mb`) and `REDIS_CONTAINER_MEMORY_LIMIT` (container limit, default `384m`).
These are starting values, not a VPS sizing guarantee. Keep room outside
`maxmemory` for AOF rewrite, client buffers and the allocator, plus RAM for
PostgreSQL, the API and the OS. Measure actual queue size before increasing load.
The stack explicitly keeps AOF `everysec` and `noeviction`; never enable LRU/LFU
eviction on Redis used by BullMQ. AOF can still lose the latest second on a crash.
Changing these env values takes effect when the Redis container is recreated,
not by editing the app's running environment. Do not apply a limit below current
usage without first reviewing memory and durable queue recovery.

## Runtime Configuration

Use the existing `.env.example` as the field reference for `.env.production`.
The production file is ignored by Git and excluded from Docker build contexts.
Set `APP_DOMAIN` to the real hostname, point DNS to the VPS, and permit only SSH,
80 and 443 in the host firewall. Do not use the development Compose file here.

- Set distinct random JWT, refresh and reorder secrets, real SMTP credentials,
  the production Turnstile secret and `VITE_TURNSTILE_SITE_KEY` (public sitekey).
- Set `DB_USER`, `DB_NAME`, `DB_PASSWORD`, and a strong `REDIS_PASSWORD`.
- Set `DATABASE_URL=postgresql://USER:PASSWORD@postgres:5432/DB?schema=public&connection_limit=10`.
- Set `REDIS_URL=redis://:PASSWORD@redis:6379`. URL-encode credentials where necessary.
- Use the actual Coffee Homes `SHOP_NAME`, `SHOP_ADDRESS`, `SHOP_PHONE`.
- Leave all VNPay/MoMo credentials blank for cash-only operation. Otherwise use
  credentials and production URLs supplied by the provider, never sandbox URLs.
- Disable Swagger. Either disable metrics or configure a strong metrics token.
- Never put secrets in `VITE_*`; those values are embedded in the public bundle.
- Optional Telegram customer updates and private staff alerts: see [setup and delivery limits](telegram/README.md). Leave bot settings blank when unused.

The Compose file overrides HTTPS cookie, CSRF, public signup, API prefix and
proxy settings. Only the frontend reverse proxy publishes ports. PostgreSQL and
Redis are private; Redis also requires authentication. Logs rotate at 3 x 10 MiB.

## Release

First rehearse migrations against staging data and take a restorable database
snapshot outside the VPS. Do not create a second production stack over the same DB.

```sh
docker compose --env-file .env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file .env.production -f deploy/compose.production.yml build backend frontend tooling
docker compose --env-file .env.production -f deploy/compose.production.yml up -d postgres redis
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/ts-node/dist/bin.js prisma/seed.ts --permissions-only
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/ts-node/dist/bin.js prisma/preflight/permissions.ts

docker compose --env-file .env.production -f deploy/compose.production.yml up -d backend frontend
```

The tooling service is opt-in and runs `prisma migrate deploy`; seeding permissions
is a separate explicit command. Bootstrap OWNER using the controlled seed workflow
with `OWNER_*` configured privately, never public signup.

The read-only permission catalog check must pass before release. See the
[catalog and concurrent-edit contract](authorization/README.md) for legacy API
compatibility and backend-first frontend rollout.

Check `/api/v1/health/live` and `/api/v1/health/ready` through the real HTTPS hostname,
then verify login/refresh/CSRF, menu, a cash sale, explicit table completion and
scheduled pickup. Check kitchen SSE remains live through the proxy and that the
browser never calls an internal hostname. Google/Turnstile domains must match.

## Optional Cloudflare Proxy

Turnstile does not require Cloudflare DNS/proxy. Keep the default loopback-only
`CADDY_TRUSTED_PROXY_CIDRS` when clients connect directly to this VPS.

When enabling the Cloudflare proxy:

- Set `CADDY_TRUSTED_PROXY_CIDRS` to the current space-separated IPv4 and IPv6
  ranges from https://www.cloudflare.com/ips/; review changes during releases.
  Do not trust all IPs or all private networks. Caddy accepts `CF-Connecting-IP`
  only from a trusted peer and sends one normalized client IP to Nest.
  Keep Nest's Compose `TRUST_PROXY=uniquelocal`; never change it to `true`.
- Use TLS **Full (strict)** and restrict origin ingress to Cloudflare ranges
  (including IPv6), or use authenticated origin access. Coordinate certificate
  renewal and health checks before applying firewall restrictions.
- Disable Pseudo IPv4 header overwriting and removal of visitor IP headers;
  confirm distinct clients produce distinct rate-limit identities at the origin.
- Bypass cache for `/api/v1/*` and do not override `no-store`. Only hashed
  `/assets/*` should use the existing immutable cache policy.
- Do not apply browser/JavaScript challenges to fetch APIs, kitchen SSE, or
  VNPay/MoMo/payOS/Telegram webhooks. Keep their signature, session, CSRF and
  application rate-limit checks. Test these rules through the public hostname.
- Allow `challenges.cloudflare.com` scripts and frames if a frontend CSP is
  added. API Helmet headers do not configure CSP for Caddy's HTML responses.
  Test Google Sign-In, payment QR, storage images and the theme bootstrap before
  enforcing a new CSP; do not deploy an untested blanket policy.

Frontend network challenges show a recovery message, not a permission failure.
There is no automatic replay of a blocked write. If an order response was lost,
the `/online-orders/requests/recover` (or authenticated `/customers/orders/recover`)
endpoint only reads a saved request with the identical key, payload and customer.
A missing order is never created by recovery; a new submission still needs a
fresh Turnstile token. Deploy backend recovery routes before this frontend.

Monitor `coffee_shop_turnstile_verifications_total{action,outcome}` and
`coffee_shop_turnstile_verification_duration_seconds`. Labels contain no visitor
IP, request ID or token. Check `turnstile.unavailable` logs for safe provider
error codes when secret configuration or Siteverify fails.

## Recovery

Do not run `down -v`, `prisma migrate reset`, or drop the new metadata columns.
Restore the previous FE/BE images together only when their contracts are compatible
with the expanded schema. Fix failed migrations forward; investigate an unhealthy
backend before restarting it repeatedly. Keep a tested off-server backup and verify
restore before taking payments. Named volumes on the same VPS are not backups.
