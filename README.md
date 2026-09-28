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

## Employee Google Sign-In and Turnstile

- Set `GOOGLE_CLIENT_ID` to a Google web OAuth client ID to enable Google
  sign-in. The frontend obtains a Google ID token and sends
  `{idToken,turnstileToken}` to `POST /api/v1/auth/google`. This does not create
  or automatically match employees by email. An active employee first signs in
  with a password, then calls `POST /api/v1/auth/google/link` with
  `{idToken,password}`. The verified Google email must match the employee email.
  `POST /api/v1/auth/google/unlink` takes `{password}` and revokes all sessions;
  the employee can still sign in with a password. `GET /api/v1/auth/me` returns
  `googleLinked`, never the Google subject.
- Configure the frontend Turnstile widget for `login` on password and Google
  sign-in, `password_reset` on forgot-password, `online_order` on takeaway
  checkout, and `reservation_request` on public reservations. Send the widget token as
  `turnstileToken` in the JSON request body. The backend verifies it with
  Cloudflare Siteverify and checks the action and hostname against `FE_URL`.
  The public sitekey belongs in the frontend; keep `TURNSTILE_SECRET_KEY` only
  on the backend. Production requires a real secret and HTTPS `FE_URL`.
  Development/test may omit the secret to bypass verification locally.
- Authenticated link/unlink requests using cookies require the existing
  `X-CSRF-Token` header. Configure the frontend origin in `FE_URL`; do not put
  Google ID tokens or Turnstile tokens in URLs or logs. These Google endpoints
  authenticate staff, not customers placing remote takeaway orders.

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
  active categories and saleable item names/prices/option groups. Availability is manually
  controlled; this is not a promise that ingredients are reserved.
- Staff configure size/topping groups with `GET/PUT /api/v1/menu/items/:id/options`
  (`/menu_read` or `/menu_update`). `PUT` replaces all groups with
  `{groups:[{name,minSelected,maxSelected,options:[{name,priceDelta,ingredients:[{inventoryItemId,quantity}]}]}]}`.
  Changing groups gives choices new IDs, so pending online requests with old
  choices must be resubmitted; accepted orders retain their price, choice and
  recipe snapshots. Ingredients are additive to the base recipe, not substitutes.
- Remote takeaway uses `POST /api/v1/online-orders/requests` with
  `{clientRequestId, pickupName, phoneNumber, items:[{menuItemId,quantity,note?,optionIds?}], maxSubtotal?, turnstileToken?}`.
  `clientRequestId` is a fresh UUID per checkout attempt; retry with the same
  ID and payload returns the same request and `accessToken`, while a changed
  payload returns 409. The first submission requires a valid Turnstile token
  in production; an exact retry of a stored request does not need a fresh
  token. Set `maxSubtotal` to the current quote when confirming
  a reordered cart; a higher server quote returns 409 without creating an
  order. The server quotes base price plus selected choices;
  `POST /api/v1/orders/sessions/:id/items` accepts the same `optionIds` per
  line for POS. No stock or
  payment is reserved. Requests wait up to 30 minutes for staff review.
- Customers send `{requestId, accessToken}` in the body of
  `POST /api/v1/online-orders/requests/status` to track review, kitchen
  readiness, and payment, or `/requests/cancel` to withdraw a pending request.
  The token works for 72 hours from creation. Keep it out of URLs and logs;
  rotating `JWT_SECRET` invalidates existing tokens. Staff use
  `GET /api/v1/online-orders/requests` and `GET /requests/:id` with
  `/online-orders_read`, then `POST /requests/:id/accept` or `/reject` with
  `/online-orders_review`. Rejection requires `{reason}`. Acceptance creates
  one takeaway order session and kitchen ticket atomically; changed menu prices,
  choices or unavailable items require staff to reject and ask the customer to reorder.
  Acceptance does not reserve stock or collect payment. Staff use
  `GET /api/v1/online-orders/requests/fulfillment` to monitor accepted orders.
  Once every item is `READY`, staff with `/invoices_create` and
  `/orders_items_handoff` send `{accessToken,amountTendered,idempotencyKey}` to
  `POST /api/v1/online-orders/requests/:id/collect`. The customer must present
  their access token; the open cashier shift, cash invoice, cash ledger entry,
  item handoff and audit are committed together. Reuse the same idempotency key
  when retrying a failed response. Do not use the generic unpaid handoff route
  for online orders. Staff with `/online-orders_review` can send `{reason}` to
  `POST /api/v1/online-orders/requests/:id/cancel` before payment or collection;
  prepared ingredients are recorded as waste, not returned to stock.
- Scheduled pickup uses `GET /api/v1/online-orders/pickup-slots?date=YYYY-MM-DD`
  and an optional `pickupAt` ISO timestamp on request creation. Configure
  `ONLINE_PICKUP_SLOT_CAPACITY`, `ONLINE_PICKUP_OPEN_LOCAL` and
  `ONLINE_PICKUP_CLOSE_LOCAL` to enable it (15-minute slots in
  `Asia/Ho_Chi_Minh`; the current shop uses 07:00-22:00 and 4 accepted orders
  per slot). A pending request does **not** reserve capacity; acceptance
  rechecks it transactionally. `GET /requests/fulfillment?overdueOnly=true`
  shows uncollected orders more than 15 minutes past their pickup time;
  staff decide whether to cancel, and prepared stock is recorded as waste.
- Staff with `/online-orders_review` may call
  `POST /api/v1/online-orders/requests/:id/no-show` only for an unpaid,
  scheduled order whose active items are all READY and whose pickup grace period
  has passed. The 15-minute grace starts at the later of the booked pickup time
  and the last item-ready time, so kitchen delays are not blamed on the guest.
  This explicitly cancels the order and session, records prepared ingredients as
  waste, and writes an audit entry; there is no automatic no-show cancellation.
  Staff detail and fulfillment responses include `isNoShowEligible`.
- A new online request returns a `reorderToken` and `reorderExpiresAt` in
  addition to its 72-hour `accessToken`. Keep the reorder token in private
  client storage, not in URLs or logs. It is valid for 180 days from order
  creation and only grants a cart preview, not order status, customer details
  or checkout. `POST /api/v1/online-orders/requests/reorder-template` accepts
  either `{requestId,accessToken}` within 72 hours or
  `{requestId,reorderToken}` within 180 days. It returns `items` and a live
  `quote` with per-line availability and current prices. When `canSubmit` is
  false, the customer must update unavailable items or choices. On confirmation,
  submit a fresh `clientRequestId`, customer details and `maxSubtotal` equal to
  `quote.currentSubtotal`; the server requotes and never reuses old prices.
  `POST /requests/reorder-key` reissues the key while the 72-hour access token
  is valid; `POST /requests/reorder-key/revoke` revokes it using the reorder
  token. Older orders without a reorder key cannot be recovered after their
  access token expires; long-term account-based history would require customer
  authentication. In production, keep `ONLINE_REORDER_SECRET` stable and
  separate from JWT secrets so JWT rotation does not break reorder keys.
- Optional "buy together" suggestions: before checkout, generate a fresh
  `clientRequestId` and call `POST /api/v1/recommendations/online` with
  `{clientRequestId,menuItemIds:[...]}`. Use the same ID in
  `POST /api/v1/online-orders/requests`; generate a new ID if the basket's
  starting items change. `CONTROL` intentionally returns no suggestions;
  `TREATMENT` returns up to three currently saleable items with current base
  prices. The client must never auto-add them. Pairs come from paid, non-refunded
  invoices in the past 90 days, require at least three distinct invoices, and
  refresh in the background every six hours. Availability is still checked on
  each response; stock is not reserved. The public endpoint is rate-limited
  and stores only the checkout UUID, basket hash, cohort and suggested IDs,
  never customer contact details. Repeating the same ID and basket is safe;
  changing the basket with that ID returns 409. Staff with `/reports_read` use
  `GET /api/v1/recommendations/experiment?from=<ISO>&to=<ISO>` for the last
  90 days. `assignments` means API responses assigned to a cohort, not verified
  screen views; `attachedOrders` counts suggested items in paid orders. Compare
  paid conversion and revenue per assignment before enabling suggestions for
  everyone. No recommendation is shown until enough paid history exists.
  POS staff with `/orders_sessions_read` can call
  `GET /api/v1/recommendations/pos/:id` for an active order session. This uses
  the same current-menu filter but is not part of the online A/B experiment.
- Optional Telegram order updates: create a bot with BotFather, set
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and a random 32+ character
  `TELEGRAM_WEBHOOK_SECRET`, then register the HTTPS webhook at
  `/api/v1/online-orders/telegram/webhook` with Telegram's `secret_token` and
  `allowed_updates=["message"]`. The client calls
  `POST /api/v1/online-orders/requests/telegram-link` with
  `{requestId,accessToken}` and opens the returned deep link. The customer must
  press Start in a private bot chat to opt in; `/stop` unsubscribes that chat.
  Links expire after 30 minutes and can be used once. The bot sends only order
  status, never name, phone, total or access token. Notifications are advisory;
  the status endpoint remains authoritative. Telegram delivery may repeat after
  an outbox retry and requires a public HTTPS endpoint; no real message is sent
  until the bot settings are configured.
- `GET /api/v1/reports/online-orders?from=...&to=...&timeZone=...` requires
  `/reports_read` and returns a daily request-cohort funnel: submitted,
  reviewed/accepted, rejected, expired, cancelled, ready, paid and collected,
  plus review/preparation time and paid receipts after successful refunds.
  `from` is inclusive, `to` exclusive (default last 30 days, maximum 366 days);
  each day follows the requested IANA time zone. The cohort is the request's
  creation day, not the payment day: late payments/refunds can restate old
  cohorts. Stage counts overlap (a later-cancelled order was still accepted),
  and quoted demand is not booked revenue. Menu views and abandoned carts are
  not measured because the backend has no trustworthy event for them.
  `noShowCount` is an explicit staff-confirmed outcome. `noShowRatePercent`
  divides no-shows by no-shows plus collected scheduled orders, excluding
  upcoming and unresolved bookings from the denominator.
- `GET /api/v1/reports/kitchen-sla?from=...&to=...&stationId=...` requires
  `/reports_read` and reports completed, late and still-overdue kitchen tickets
  by station, with average and p95 ticket-to-ready seconds. The range is
  limited to 31 days; cancelled items are excluded from completion timing.
- `GET /api/v1/reports/kitchen-bottlenecks?from=...&to=...&timeZone=...&stationId=...`
  requires `/reports_read` and groups kitchen tickets by station and their
  creation hour in the requested IANA time zone. `bucketStartAt` is an absolute
  UTC timestamp, so repeated local hours during DST remain distinguishable.
  The default range is 7 days and the maximum is 7 days (`from` inclusive,
  `to` exclusive). `orderedUnitCount` includes units later cancelled;
  `lateRatePercent` divides late completions by completed tickets only.
  `openNowCount` and `overdueOpenCount` are current snapshots at `period.asOf`,
  not reconstructed historical backlog. Cancellation can restate past cohorts.
  The report diagnoses load and observed delay; it does not infer root cause.
- `GET /api/v1/kitchen/workload` requires `/kitchen-tickets_read` and returns
  one current snapshot per non-deleted station: open tickets and units,
  overdue tickets, tickets due within five minutes, oldest open time and next
  due time. Open means at least one item is `PENDING` or `COOKING`, matching the
  KDS ticket list. Counts change with time even without a kitchen event; clients
  should refresh periodically as well as on `kitchen.refresh` events. This is
  an operational queue snapshot, not a historical backlog or staffing forecast.
- `POST /api/v1/reservations/public/requests` accepts a request up to 30 days
  ahead. Include `turnstileToken` from the `reservation_request` widget in
  production. For safe retries, generate 32 random bytes with Web Crypto,
  base64url-encode them as `clientRequestToken` (43 characters), and keep the
  same token and payload across retries. The server stores only its hash and
  returns it as the booking `accessToken`; a changed payload with the same
  token returns 409. A stored exact retry does not need a new Turnstile token.
  Treat `clientRequestToken` as a secret: never put it in URLs or logs. Older
  clients may omit it and continue to receive a server-generated token, but
  their creation requests are not idempotent. This request does **not** reserve
  a table or confirm the booking. Staff review
  requests through `GET /api/v1/reservations/requests` and approve with
  `POST /api/v1/reservations/requests/:id/approve` plus a table ID, or reject with
  `POST /api/v1/reservations/requests/:id/reject`. Pending requests expire after their
  requested start time. Redis-backed rate limiting is shared between replicas
  when `REDIS_URL` is configured.
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
- Ratings 1-2 remain in `GET /api/v1/orders/takeaway/feedback/cases` until
  resolved. Staff with `/feedback_resolve` can send `{resolutionNote}` to
  `POST /api/v1/orders/takeaway/feedback/:id/resolve`. The action records an
  employee and audit entry; the note is internal and is not sent to customers.
- Managers with `/management-exceptions_read` can use
  `GET /api/v1/management/exceptions/summary` and
  `GET /api/v1/management/exceptions?kind=PAYMENT&page=1&itemPerPage=20`.
  Other kinds are `CASH_EXPENSE`, `CASH_HANDOVER`, and `FEEDBACK`. Each kind is
  paginated independently, oldest first; the inbox is read-only and reflects
  source records immediately. Resolve cases through their payment, cashier,
  handover, or feedback APIs so existing checks and audit logs remain in force.

Deploy the new migrations before calling the reservation-request API. Apply
permission seed changes to the intended database in a controlled release; code
deployment alone does not grant existing roles the new audit permission.
