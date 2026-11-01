# Single VPS Deployment

Run from the backend repository on a Linux VPS, with `coffee_shop_fe` as a sibling.
This is a single server with a maintenance window, not high availability.
Record compatible FE/BE Git SHAs and image digests for every release.

## Runtime Configuration

Use [the env example](../.env.example) as the reference for a private
`.env.production`. Use [compose.production.yml](compose.production.yml), not the
development Compose file. Permit only SSH and public HTTP/HTTPS at the firewall;
the production stack exposes neither PostgreSQL nor Redis.

| Setting                           | Required action                                                                |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `APP_DOMAIN`, `SHOP_*`            | Set the public hostname and actual store identity; configure DNS.              |
| `DB_*`, `DATABASE_URL`            | Use service hostname `postgres`, port 5432 and a bounded connection limit.     |
| `REDIS_PASSWORD`, `REDIS_URL`     | Use service hostname `redis`, authentication and persistent data.              |
| JWT/refresh/reorder secrets, SMTP | Supply distinct strong secrets and real mail settings privately.               |
| Turnstile and Google              | Match frontend origins/public IDs; keep provider secrets backend-only.         |
| `METRICS_TOKEN`                   | Set a strong scraper token, or explicitly disable metrics.                     |
| Optional providers                | Leave payment/Telegram/Supabase/Gemini disabled until configured and accepted. |

URL-encode credentials in connection URLs. Never commit filled env files or put
secrets in `VITE_*`; frontend values are public build-time configuration.
Compose enforces HTTPS cookies, CSRF, disabled public signup/Swagger and `/api/v1`.
Only the frontend reverse proxy publishes ports.

Redis uses AOF `everysec` and `noeviction`. The defaults
`REDIS_MAXMEMORY=128mb` and `REDIS_CONTAINER_MEMORY_LIMIT=384m` are starting values,
not a sizing guarantee. Leave RAM for AOF rewrite, buffers, PostgreSQL, API and OS.
AOF can lose the latest second after a crash. Review usage before recreating Redis
with a smaller limit; never enable eviction for BullMQ.

## Release Gate

1. Require green backend/frontend CI, including container and real-backend tests.
   Set frontend repository variable `BACKEND_REF` to the compatible 40-character
   backend commit SHA, not a mutable branch or a browser env variable.
2. Rehearse pending migrations, preflight and schema diff on a restored staging
   copy. An empty CI database does not prove existing shop data will upgrade.
3. Pause shop mutations, reconcile uncertain payments and stop all API workers
   and print agents. Old/new stock writers and outbox lease owners must not overlap.
4. Take an encrypted off-host backup and verify a restore into a new database.
   Agree how to reconcile callbacks arriving during maintenance.

## Release Commands

Run each step only after the previous succeeds. These commands write the selected
database; verify the host/env first. Never run a second stack over the same data.

```sh
set -eu
dc() { docker compose --env-file .env.production -f deploy/compose.production.yml "$@"; }

dc config --quiet
dc build backend frontend tooling
dc stop backend
dc up -d postgres redis

dc run --rm tooling
dc run --rm tooling node node_modules/ts-node/dist/bin.js prisma/seed.ts --permissions-only
dc run --rm tooling node node_modules/ts-node/dist/bin.js prisma/preflight/permissions.ts
dc run --rm tooling node node_modules/ts-node/dist/bin.js prisma/preflight/production-baseline.ts
dc run --rm tooling node node_modules/prisma/build/index.js migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code

dc up -d backend frontend
```

The tooling image's default command is `prisma migrate deploy`; the non-root
runtime image has no Prisma CLI. Permission-only seed adds missing default grants
without deleting extra ones. Stop on migration/preflight failure or schema drift
(exit code 2); do not edit migration history, reset data or bypass a failed check.

**First installation only:** privately set `OWNER_EMAIL`, `OWNER_USERNAME`,
`OWNER_FULL_NAME`, `OWNER_PASSWORD` (12+ characters). Run the tooling seed command
without `--permissions-only`, then rerun checks before opening intake.
That full seed also replaces system-role grants and seeds cash settings; do not
use it as a routine release step. Never run catalog/activity seeds on production.

## Acceptance

Through the real HTTPS domain, check liveness/readiness, login/refresh/CSRF, menu,
a reviewed cash sale, table completion, scheduled pickup and kitchen SSE.
Confirm the browser never calls internal hostnames. Reconcile delayed callbacks
and uncertain paper output before resuming intake/print agents.

Payment providers require merchant credentials, reachable verified callbacks and
approved end-to-end acceptance. Return URLs cannot mark invoices paid. Automatic
payOS refunds are not implemented; after a database restore, reconcile and advance
`payos_order_code_seq` beyond codes already issued before enabling new links.
For Supabase, configure a dedicated public menu-image bucket with no anonymous
writes; the backend validates/uploads images using its private service key.

Watch [metrics and alerts](observability/README.md) over a business cycle.
Fixture results do not prove merchant readiness, physical printing or 250/500 RPS.

## Optional Telegram

Staff sending requires backend `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STAFF_CHAT_ID`
for a private group. Customer subscriptions additionally require
`TELEGRAM_BOT_USERNAME` and a random 32+ character `TELEGRAM_WEBHOOK_SECRET`.

Register HTTPS `/api/v1/online-orders/telegram/webhook` using Telegram
`setWebhook`, that value as `secret_token` and `allowed_updates: ["message"]`.
Staff-only sending needs no webhook. Optional `TELEGRAM_WEB_APP_URL` is an HTTPS
frontend origin, without path/query/credentials. A group migration needs an
explicit chat-ID configuration update, not a destination copied from an error.

Before enabling, test opt-in, `/stop`, permissions, duplicate order replay and bot
delivery failure. Delivery is at least once and can duplicate after a timeout;
messages are neither payment evidence nor approval to prepare an order.

## Optional Cloudflare Proxy

Turnstile does not require the Cloudflare proxy. Direct VPS access keeps the
default loopback-only `CADDY_TRUSTED_PROXY_CIDRS`.

- For proxy use, configure trusted current Cloudflare IPv4/IPv6 ranges and TLS
  Full (strict). Restrict origin access while preserving certificate renewal and
  health checks. Never trust all IPs; keep Nest's `TRUST_PROXY=uniquelocal`.
- Preserve visitor IP headers and verify distinct client rate-limit identities.
- Bypass cache for `/api/v1/*`; never override `no-store`. Cache hashed assets only.
- Do not put browser challenges on API fetches, SSE or payment/Telegram webhooks.
  Their signatures, sessions, CSRF and application limits remain mandatory.
- If adding CSP, test Turnstile/Google, payment QR, image storage and theme bootstrap
  first. API Helmet configuration does not configure Caddy's HTML response.

A blocked or lost write must use its original recovery flow, never automatic
resubmission with a new key. See [source contracts](../src/app/online-orders/)
and the sibling frontend\'s `Caddyfile`.

## Recovery And Backup

| Incident                  | Action                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed release/migration  | Keep writes stopped. Prefer a reviewed forward fix; previous images are usable only if schema-compatible. Never `down -v`, reset, or alter migration metadata.                         |
| PostgreSQL outage/restore | Restore into a new destination; verify checksum, key counts, recent invoices and migration history. Reconcile payment attempts before reopening. Never restore over the source.        |
| Redis outage/OOM          | Restore readiness, inspect [outbox delivery](observability/README.md#outbox-delivery) and queues. Preserve replay keys; do not enable eviction or blindly recreate financial commands. |
| Payment mismatch          | Compare signed provider events/settlement using reconciliation. Never mark paid from a browser return or edit financial rows manually.                                                 |
| Uncertain print           | Inspect actual paper/device state before explicit recovery; a queue acknowledgement is not proof of printing.                                                                          |

Backups must be encrypted off-host and restore-tested; VPS volumes are not backups.
Agree acceptable data loss and restore time. Logical dumps are not PITR; do not
claim recovery guarantees without tested WAL/PITR and a timed restore drill.

## Secret Rotation

Revoke leaked credentials at the issuer and rotate integrations deliberately.
JWT rotation invalidates old signed tokens; it does not erase stored sessions.
Keep reorder secrets stable for valid old orders and reconcile in-flight payments
before provider-key changes. Update DB/Redis credentials in the backing services
and app, and metrics tokens in both API and scraper; verify old credentials fail.

Optional AI has separate [activation and evaluation checks](ai/README.md).
