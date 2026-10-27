# Single VPS Deployment

Run from the backend repository on a Linux VPS. Keep `coffee_shop_be` and
`coffee_shop_fe` as sibling repositories and record both Git SHAs for each release.
This is one server with a maintenance window, not high availability or a canary
deployment. Nothing migrates or seeds on startup. This is the release/recovery
procedure; module documents describe their API contracts, not another release path.

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
- Leave VNPay/MoMo/payOS credentials blank for cash-only operation. Otherwise use
  credentials and production URLs supplied by the provider, never sandbox URLs.
- Disable Swagger. Either disable metrics or configure a strong metrics token.
- Never put secrets in `VITE_*`; those values are embedded in the public bundle.
- Optional services: [Telegram](#optional-telegram), [AI](ai/README.md),
  [menu images](../docs/supabase-images.md), and [monitoring](observability/README.md).

The Compose file overrides HTTPS cookie, CSRF, public signup, API prefix and
proxy settings. Only the frontend reverse proxy publishes ports. PostgreSQL and
Redis are private; Redis also requires authentication. Logs rotate at 3 x 10 MiB.

## Release Gate

1. Record both Git SHAs and image digests; keep compatible previous images.
   Require green backend `verify` and `container` jobs and the frontend CI gate.
   Pin frontend integration `BACKEND_REF` to the committed backend revision.
2. Rehearse migrations and read-only preflight on a restored staging copy. CI's
   empty database does not prove upgrades work on existing shop data. Run
   `pnpm audit --prod --audit-level high` on the release lockfile and resolve
   high/critical findings. Keep evidence privately, not secrets in CI output.
3. Pause new shop operations and reconcile uncertain payments. Take an encrypted
   off-host backup and verify restoration into a new database, including counts,
   recent invoices and migration history. Agree how to reconcile callbacks during
   maintenance. A dump alone is not a restore test; VPS volumes are not backups.
4. Review pending migrations. Do not mix old/new inventory reservation writers,
   outbox lease owners or printer recovery. See the [stock](../docs/customer-orders-stock.md),
   [outbox](observability/README.md#outbox-delivery) and
   [printing](../docs/pos-precheck-payment-feedback.md#migration) contracts.

## Release Commands

Run each step only after the previous succeeds. The backend also owns workers;
stop it before migration, even when updating an existing stack. Stop separately
launched workers/agents too. The frontend may remain up, but API calls/webhooks
can return 503 until recovery. Do not retry uncertain writes with new keys or
create a second stack over the same database.

```sh
set -eu
docker compose --env-file .env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file .env.production -f deploy/compose.production.yml build backend frontend tooling

docker compose --env-file .env.production -f deploy/compose.production.yml stop backend
docker compose --env-file .env.production -f deploy/compose.production.yml up -d postgres redis
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/ts-node/dist/bin.js prisma/seed.ts --permissions-only
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/ts-node/dist/bin.js prisma/preflight/permissions.ts

docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/ts-node/dist/bin.js prisma/preflight/production-baseline.ts

docker compose --env-file .env.production -f deploy/compose.production.yml run --rm tooling node node_modules/prisma/build/index.js migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code

docker compose --env-file .env.production -f deploy/compose.production.yml up -d backend frontend
```

The opt-in tooling image runs `prisma migrate deploy`; the non-root runtime image
does not contain the Prisma CLI. The shown permission seed is an explicit release
step, not the full catalog/activity seed. Bootstrap OWNER separately with the
controlled seed and private `OWNER_*` values, never public signup.

First installation: before acceptance/opening intake, configure `OWNER_EMAIL`,
`OWNER_USERNAME`, `OWNER_FULL_NAME` and `OWNER_PASSWORD` (12+ characters) privately.
Run the tooling seed command without `--permissions-only` only for that reviewed
bootstrap, then rerun the checks. This also replaces system-role grants and seeds
cash-control settings; do not use it as a routine update on an existing shop.

The read-only permission catalog check must pass before release. See the
[catalog and concurrent-edit contract](../docs/authorization-delegation.md) for legacy API
compatibility and backend-first frontend rollout.

Stop on any failed migration/preflight or schema diff (exit code 2). Do not bypass
checks, edit `_prisma_migrations`, run `migrate reset`, or run `migrate dev` against
a shared database. Review unknown permission keys instead of auto-deleting grants.

## Acceptance

Check `/api/v1/health/live` and `/api/v1/health/ready` through the real HTTPS hostname,
then verify login/refresh/CSRF, menu, a cash sale, explicit table completion and
scheduled pickup. Check kitchen SSE remains live through the proxy and that the
browser never calls an internal hostname. Google/Turnstile domains must match.

Use fixtures/sandbox first; a real acceptance payment needs merchant approval
and normal accounting/reconciliation. Review uncertain paper output before
resuming print agents, and reconcile delayed/missed callbacks before reopening
intake. Watch 5xx, p95 latency, DB connections, Redis, outbox lag/dead letters and
payment mismatches for a business cycle. See [metrics and alerts](observability/README.md).
The k6 profile is not proof of 250/500 RPS until measured on sized staging;
never run mutation load against live orders, stock or payments.

## Optional Telegram

Leave bot settings blank when unused; credentials are backend-only. Staff alerts
need `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STAFF_CHAT_ID` for a private group where the
bot can send. Keep bot privacy enabled. A migrated supergroup requires explicitly
updating the chat ID and restarting, not trusting a destination from an error.

Customer subscriptions also need `TELEGRAM_BOT_USERNAME` (without `@`) and a random
32+ character `TELEGRAM_WEBHOOK_SECRET`. Register the public HTTPS
`POST /api/v1/online-orders/telegram/webhook` with Telegram `setWebhook`, using
that secret as `secret_token` and `allowed_updates: ["message"]`. Staff-only sending
needs no webhook. Optional `TELEGRAM_WEB_APP_URL` must be an HTTPS frontend origin
without path/query/credentials. Never put bot tokens in logs or `VITE_*`.

Activation: create a test request and replay its key; expect one outbox alert.
Check staff links require sign-in, customer `/start` and `/stop` work, COD/current
state is correct, and guest links contain no credentials. Block the bot or remove
it from the group to verify unsubscribe/dead-letter handling; restore access and
replay only non-stale events. See [delivery and privacy](../docs/online-order-preparation.md#telegram-delivery).
Telegram is at-least-once: a timeout can duplicate a message. It is not payment
evidence or an instruction to prepare an unapproved order; API state is authoritative.

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

## Recovery And Backup

- Failed rollout: keep API writes stopped until schema compatibility is known.
  Restore previous FE/BE images only if compatible with the expanded schema.
  Preserve logs/migration evidence; prefer a reviewed forward fix. Never run
  `down -v`, drop metadata, or restart repeatedly without diagnosis.
- Restore drill: use a new destination database; refuse an existing destination.
  Verify the backup checksum, restore with fail-on-error/no-owner/no-ACL options,
  compare key business counts/recent invoices, then rehearse migration/preflight
  and schema diff there. Never restore over the source. Remove temporary plaintext
  dumps only after verifying the encrypted off-host copy and drill.
- PostgreSQL outage: stop writes, restore into a new database if needed, then
  reconcile payments. Redis outage: readiness fails; fix Redis and inspect
  outbox/queue recovery. Do not erase replay keys or enable eviction. Signed payment
  callbacks have their own limiter and may still persist events during Redis outage;
  check DB state before replaying. Health routes bypass the ordinary Redis limiter.
- Payment mismatch: compare signed provider events and settlement through the
  reconciliation workflow; never mark paid from a return URL or edit financial
  tables by hand. Confirm per-IP callback limits fit clients sharing a public IP;
  coordinate edge abuse protection before scaling replicas.
- Agree RPO (acceptable data loss) and RTO (restore time) with the shop. Logical
  backups are not PITR. Add tested WAL archiving/managed PITR when the recovery
  target needs it; do not claim a guarantee without a timed restore drill.

## Secret Rotation

Use a secret manager or restricted host configuration, not image/Git artifacts.
On a leak, revoke at the issuer, rotate one integration at a time and inspect
logs without copying secrets. JWT access/refresh each has one verification key:
rotation invalidates old signed tokens, not stored session rows. Announce
re-authentication and restart in a controlled window; dual-key rotation is not
implemented. Keep reorder secrets stable for valid old orders.

Coordinate payment keys with providers and reconcile in-flight attempts. Rotate
`METRICS_TOKEN` in API and scraper; change DB/Redis credentials in the backing
service before updating the app. Verify readiness and rejection of old credentials.
