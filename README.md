# Coffee Shop Backend

NestJS, Prisma, PostgreSQL and Redis backend for a single coffee shop. API
routes use `/api/v1` by default. PostgreSQL stores business state; Redis is
used for background delivery and cache. Do not run migrations or seed against
a shared database without reviewing the target URL and backup first.

## Local setup

1. Use Node.js 22 and pnpm 9.15.9. Copy `.env.example` to `.env`, then set
   private values locally.
2. Start PostgreSQL and Redis with `docker compose up -d`.
3. Run `pnpm install`, `pnpm prisma:generate`, and
   `pnpm exec prisma migrate deploy` against the intended local database.
4. Start the API with `pnpm start:dev`. Check
   `GET http://localhost:3000/api/v1/health/live` and `/health/ready`.

`pnpm prisma:seed` is an explicit development bootstrap step, not part of
application startup or deployment. Review its target database before running.

## Verification

`pnpm verify` validates Prisma, lints, type-checks, builds and runs unit tests.
`pnpm test:e2e -- --runInBand` requires a separate disposable PostgreSQL
database, Redis, applied migrations and `NODE_ENV=test`; it mutates test data.
`pnpm audit --prod --audit-level high` checks production dependencies and is
currently a go-live blocker; see the release runbook.

## Operations

- [Release and recovery runbook](deploy/release/README.md): migration rehearsal,
  backup/restore, incident response, secret rotation and remaining go-live
  blockers.
- [Observability](deploy/observability/README.md): metrics, alerts and tracing.
- [Load testing](test/load/README.md): read-only staging profile and limits.

CI checks schema drift. Backup/restore and point-in-time recovery require a
separate staging rehearsal before go-live.

## Customer-facing and operator APIs

- `GET /api/v1/menu/public/categories` and `/menu/public/items` expose only
  active categories and saleable item names/prices. Availability is manually
  controlled; this is not a promise that ingredients are reserved.
- `POST /api/v1/reservations/public/requests` accepts a request up to 30 days
  ahead. It does **not** reserve a table or confirm the booking. Staff review
  requests through `GET /api/v1/reservations/requests` and approve with
  `POST /api/v1/reservations/requests/:id/approve` plus a table ID, or reject with
  `POST /api/v1/reservations/requests/:id/reject`. Pending requests expire after their
  requested start time. Public writes have a process-local rate limit; put a
  shared edge rate limit or abuse control in front of multiple API replicas.
- Creation returns a one-time `accessToken`. The client uses it in the body of
  `POST /api/v1/reservations/public/requests/status` to check the outcome, or
  `POST /api/v1/reservations/public/requests/cancel` to withdraw while still
  pending and before the start time. Do not put the token in URLs or logs; only
  its hash is stored. Already-approved bookings must be cancelled by staff.
  Requests created before this feature have no token and remain staff-managed.
- `GET /api/v1/menu/items/stock-status` is a paginated, permission-protected
  advisory based on recipe and current stock. It does not reserve stock or
  toggle `isAvailable`; inventory is consumed when an item enters `COOKING`.
- `GET /api/v1/audit-logs` is read-only, paginated, redacted, and requires
  `/audit-logs_read`. OWNER and MANAGER receive that permission from the seed.
- For takeaway sessions, `PATCH /api/v1/orders/items/:id/status` supports
  `COOKING -> READY -> SERVED`. Staff can read ready items through
  `GET /api/v1/orders/takeaway/handoff`, including paid orders whose session is
  already complete. Waiters and cashiers use `POST /api/v1/orders/items/:id/handoff`
  to acknowledge collection without receiving kitchen status permissions.
  `readyAt` is persisted when the item becomes ready. Dine-in
  keeps the existing `COOKING -> SERVED` path until prepaid table lifecycle is
  addressed; the direct path remains valid for older takeaway clients too.
- For paid takeaway invoices, staff with `/invoices_read` can call
  `POST /api/v1/orders/takeaway/invoices/:id/pickup-code`. The customer sends
  `{invoiceId, code}` in the body of `POST /api/v1/orders/takeaway/pickup/status`;
  staff with `/orders_items_handoff` sends `{invoiceId, code, itemId}` to
  `POST /api/v1/orders/takeaway/pickup/collect`. Never put the code in a URL or
  log. The code expires 72 hours after issuance; a repeated issue returns the
  same active code. Staff with `/invoices_update` can rotate it using
  `POST /api/v1/orders/takeaway/invoices/:id/pickup-code/rotate` or revoke it
  using `POST /api/v1/orders/takeaway/invoices/:id/pickup-code/revoke`.
  Both mutations require `{code}` in the body and return 409 for a stale code;
  a retry cannot invalidate a newly rotated code.
  Refunded or voided invoices cannot use a code. Codes issued before the
  pickup-code lifecycle migration remain valid until 72 hours after invoice
  creation unless rotated or revoked. Rotating `JWT_SECRET` invalidates all
  codes; a staff member can issue a new one. Only code version and issuance
  time are stored, never the code itself.
- After every item is collected, the customer may send
  `{invoiceId, code, rating, comment?}` to
  `POST /api/v1/orders/takeaway/pickup/feedback`. The rating is 1-5 and the
  optional comment is limited to 500 characters. One invoice has one immutable
  feedback record; retrying the same payload returns it, while changing the
  rating or comment returns 409. Staff with `/reports_read` can use
  `GET /api/v1/orders/takeaway/feedback/summary` and
  `GET /api/v1/orders/takeaway/feedback` to review 30 days by default, with
  optional ISO-8601 `from`/`to` filters with timezone offsets. No customer
  profile or phone field is collected; free-text comments may still contain
  information typed by the customer and are staff-only.

Deploy the new migrations before calling the reservation-request API. Apply
permission seed changes to the intended database in a controlled release; code
deployment alone does not grant existing roles the new audit permission.
