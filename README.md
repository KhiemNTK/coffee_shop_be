# Coffee Homes Backend

NestJS API for one coffee shop, maintained separately from the sibling
`../coffee_shop_fe` React repository. PostgreSQL owns business state; Redis/BullMQ
handle background delivery and rate limiting. This is a modular monolith, not a
multi-branch or microservice platform.

## Local Setup

Requirements: Node.js 22, pnpm 9.15.9, Docker Compose, PostgreSQL 15 and Redis 7.

1. For a new checkout, copy [.env.example](.env.example) to `.env`; do not overwrite
   an existing configuration. Set the database, Redis, frontend origin and secrets.
2. Confirm `DATABASE_URL` targets your local development database before migration.
3. Run from this repository:

```powershell
pnpm install --frozen-lockfile
docker compose up -d
pnpm prisma:generate
pnpm exec prisma migrate deploy
pnpm start:dev
```

The example API address is `http://localhost:3000/api/v1`; an existing `PORT`
can override it. Check `/api/v1/health/live` and `/api/v1/health/ready`.
The frontend's development proxy currently defaults to port 8888: set its
`API_PROXY_TARGET=http://localhost:3000` when using the backend example unchanged.

Configuration is validated at startup. See [.env.example](.env.example) and
[environment validation](src/config/environment.ts), not a committed filled env.
No migration or seed runs automatically when the API starts.

## Accounts And Seed Data

Public employee signup is disabled by default and prohibited in production.
For an initial OWNER, privately configure `OWNER_EMAIL`, `OWNER_USERNAME`,
`OWNER_FULL_NAME` and `OWNER_PASSWORD` (at least 12 characters), then run
`pnpm prisma:seed` on the reviewed local database.

| Command                                                                 | Purpose and boundary                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm prisma:seed`                                                      | Initial system roles/settings and optional OWNER; replaces system-role grants. Not a routine production update.                         |
| `pnpm prisma:seed:permissions`                                          | Synchronizes permission definitions and adds missing default system-role grants; does not remove extra grants or bootstrap OWNER.       |
| `pnpm permissions:check`                                                | Read-only permission catalog check.                                                                                                     |
| `pnpm prisma:seed:catalog --database coffee_shop`                       | Opt-in local catalog; replace the database name with the exact target. Preserves existing catalog values; new stock/cost start at zero. |
| `pnpm prisma:seed:activity --database coffee_shop --through YYYY-MM-DD` | Local synthetic history preview; a completed Vietnam date is required. Only `--apply` writes the batch.                                 |

Catalog and activity seeds reject production and non-loopback databases.
Activity data is fictional, changes revenue/stock/cash totals and creates no usable
customer logins or real provider/notification calls. Never use that database as
production accounting evidence. Replaying the same completed batch writes nothing;
changed parameters are rejected. Do not delete its completion marker to reseed.
Review [catalog](prisma/seed-catalog.ts) and [activity](prisma/seed-activity.ts)
before use. Catalog `--replace-demo` explicitly archives/removes matching old demo
records; it is not a general data reset.

## Code Map

| Area                                        | Source                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Models, constraints and schema changes      | [prisma/](prisma/)                                                                                                               |
| Staff authentication and permissions        | [auth](src/app/auth/), [authorization](src/app/authorization/), [roles](src/app/roles/)                                          |
| Customers, wishlist and order history       | [customers](src/app/customers/)                                                                                                  |
| POS, tables, invoices and payment providers | [orders](src/app/orders/), [dining-tables](src/app/dining-tables/), [invoices](src/app/invoices/), [payments](src/app/payments/) |
| Online pickup and reservations              | [online-orders](src/app/online-orders/), [reservations](src/app/reservations/)                                                   |
| Kitchen, printing, menu and inventory       | [kitchen](src/app/kitchen/), [printing](src/app/printing/), [menu](src/app/menu/), [inventory](src/app/inventory/)               |
| Shifts, reconciliation and reporting        | [cashier-shifts](src/app/cashier-shifts/), [reports](src/app/reports/)                                                           |
| Events, audit and operational exceptions    | [durable](src/app/durable/), [audit-logs](src/app/audit-logs/), [management-exceptions](src/app/management-exceptions/)          |

Controllers, DTOs and service responses define the current API contract. Enable
`SWAGGER_ENABLED` locally to inspect `/api/v1/docs`; keep it disabled in production.
Do not copy an old rollout note as an API specification.

## Business And Security Rules

- The backend enforces permissions; frontend visibility is not authorization.
  Customer and employee sessions are separate. Cookies require CSRF protection.
- Role metadata edits require `expectedUpdatedAt` from a fresh role read and return
  `409 ROLE_CHANGED` on conflict. Employee edits also require their observed version.
  System roles are protected; reassign employees before deleting an in-use custom role.
- Public reservation requests do not hold a table. Staff approval reserves it.
  `GET /reservations/available-tables` requires reservation-read and table-read;
  its paged time-window lookup is advisory. Database constraints prevent overlap.
  Phone input normalizes formatting and requires 8-15 digits with optional leading
  `+`; existing stored values are not backfilled.
- Online pickup uses payment on collection. Acceptance reserves recipe ingredients;
  cooking consumes them. Prepared cancellations record waste, not restored stock.
  Use the dedicated online collection/cancellation flow, not generic POS checkout.
- Reuse the original idempotency key and payload after an uncertain write.
  Recovery reads do not create orders. Do not replace a pending command merely
  because its response timed out.
- Send large money values as decimal strings. API Decimal values may be numbers
  or exact strings; never convert wide values through JavaScript `Number`.
  Invoice documents preserve their issued item/table snapshots.
- Only verified provider callbacks/reconciliation confirm online payments.
  Return URLs and screenshots are not payment evidence. Active cash shifts are
  required for cash collection; refunds and adjustments remain audited.
- Outbox delivery is at least once, not exactly once. Keep consumer idempotency,
  Redis persistence and `noeviction`; preserve pending/failed work during recovery.

## Verification

```powershell
pnpm verify
pnpm audit --prod --audit-level high
```

`pnpm verify` validates Prisma, lints without rewriting, type-checks, builds and
runs unit tests with one worker. CI also checks migration/schema consistency,
integration behavior and the non-root production container.

Database integration tests mutate data. Use `NODE_ENV=test`, a dedicated loopback
PostgreSQL database ending in `_test`, dedicated test Redis and applied migrations.
Never load the shop's queues or database into the test environment.

```powershell
pnpm test:e2e --maxWorkers=1 --workerThreads --workerIdleMemoryLimit=512MB
```

A green fixture or empty-database test is not proof of merchant acceptance,
migration safety on existing data, restore readiness or a production load target.

## Operations

| Guide                                           | Use                                                     |
| ----------------------------------------------- | ------------------------------------------------------- |
| [Single VPS deployment](deploy/README.md)       | Configuration, release, migrations, backup and recovery |
| [Observability](deploy/observability/README.md) | Metrics, logs, alerts, tracing and outbox diagnosis     |
| [AI activation](deploy/ai/README.md)            | Optional Gemini insights and offline recommendations    |
| [Load testing](test/load/README.md)             | Read-only staging profile and measured limits           |
| [HTTP localization](src/common/i18n/README.md)  | Stable API codes with localized display text            |

Deploy migrations and the matching backend before frontend contract changes;
pin frontend CI `BACKEND_REF` to the pushed, compatible backend SHA.
Optional Google, Turnstile, payment, Telegram, Supabase and Gemini configuration
belongs in the backend env unless explicitly marked as a public frontend value.
Credentials, tokens, customer details and raw payment payloads must not enter logs.
