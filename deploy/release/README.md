# Release and recovery runbook

This repository targets one store. CI checks migrations and schema on an empty
PostgreSQL database, runs tests and builds a non-root runtime image. Backup
recovery must be rehearsed separately on a staging copy of production data;
CI does not prove point-in-time recovery (PITR).

## Release gate

1. Record the commit SHA and image digest. Require green `verify` and
   `container` CI jobs. Keep the previous image available for rollback.
2. On a staging copy of production data, run `pnpm exec prisma migrate status`,
   `pnpm exec prisma migrate deploy`, `pnpm prisma:preflight`, and
   `pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`.
   Stop on any failed preflight, orphan, duplicate, or schema difference. Do
   not use `prisma migrate reset` or `migrate dev` on shared databases.
3. Take an encrypted, off-host backup before touching production. Verify its
   checksum and restore it into a **new** database. Confirm key business row
   counts (orders, payments, inventory, migrations) and rehearse migrations on
   that restored database. A successful `pg_dump` alone is not a restore test.
4. Apply migrations once using a controlled migration runner with the same
   commit as the application image. The production image intentionally does not
   include the Prisma CLI. Deploy one canary instance; check `/api/v1/health/ready`,
   sign-in, table/order read, a test transaction, metrics, logs, and payment
   reconciliation before increasing traffic. Never test payments with real money.
5. Watch 5xx, p95 read/mutation latency, PostgreSQL connections, Redis status,
   outbox lag/dead letters, and payment mismatch for at least one business
   cycle. Record the release decision and evidence outside the repository.
6. Run `pnpm audit --prod --audit-level high` against the release lockfile.
   Investigate and resolve high/critical findings before go-live. Audit
   advisories change; keep the output with the release evidence.

## Local Docker restore drill (PowerShell)

The commands below use the local Compose database, not a production endpoint.
Choose an existing source name/user from your private `.env`; the destination
name is fixed and `createdb` will fail if it already exists. Never point
`pg_restore` at the source database. Run this against a staging copy before a
real release.

```powershell
$dbUser = '<DB_USER>'
$dbName = '<DB_NAME>'
$backup = Join-Path $env:TEMP "coffee-shop-$(Get-Date -Format yyyyMMddHHmmss).dump"
docker compose exec -T postgres_db pg_dump -U $dbUser -d $dbName -Fc -f /tmp/coffee-shop-release.dump
docker compose cp postgres_db:/tmp/coffee-shop-release.dump $backup
$containerHash = ((docker compose exec -T postgres_db sha256sum /tmp/coffee-shop-release.dump) -split '\s+')[0].ToUpperInvariant()
$localHash = (Get-FileHash -Algorithm SHA256 $backup).Hash
if ($containerHash -ne $localHash) { throw 'Backup checksum mismatch' }
docker compose exec -T postgres_db createdb -U $dbUser coffee_shop_restore_drill
docker compose cp $backup postgres_db:/tmp/coffee-shop-restore.dump
docker compose exec -T postgres_db pg_restore --exit-on-error --no-owner --no-acl -U $dbUser -d coffee_shop_restore_drill /tmp/coffee-shop-restore.dump
```

Then set `DATABASE_URL` to the **restore-drill database** for these checks:

```powershell
pnpm exec prisma migrate status
pnpm exec prisma migrate deploy
pnpm prisma:preflight
pnpm exec prisma migrate diff --from-url "$env:DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
```

Compare business counts and a recent invoice against the source snapshot.
Store the backup off-host with encryption and restricted access. The local
dump and container copies contain sensitive data; remove temporary copies
after the encrypted off-host copy and drill are verified. The local Docker
volume and temporary dumps are **not** backup retention. For a
production RPO/RTO, configure managed PostgreSQL PITR or tested WAL archiving,
then periodically restore to a timestamp and measure actual recovery time.
Do not claim PITR until a timestamp restore has succeeded.

## Incidents

| Incident                      | Immediate action                                                                                                                                                                                       | Recovery evidence                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Migration failure             | Stop rollout; keep old application if schema remains compatible. Never edit `_prisma_migrations` by hand or run `migrate reset`. Decide on a reviewed forward-fix migration using a restored copy.     | Migration status, drift diff, canary readiness, unaffected business counts.            |
| PostgreSQL unavailable        | Stop writes and payment capture paths; preserve logs and the last known backup. Restore into a new database if required, then reconcile payments before reopening writes.                              | Restore checksum, migration status, business counts, provider settlement comparison.   |
| Redis unavailable             | Readiness should fail; pause rollout and restore Redis. Outbox rows remain in PostgreSQL, but realtime/queue delivery is delayed. Check queue backlog and dead letters on recovery.                    | Readiness, outbox lag/dead letters, duplicate-consumer checks.                         |
| VNPay mismatch or delayed IPN | Do not mark invoices paid from the return URL or manually mutate invoice/payment tables. Keep attempts in review, compare signed provider events and settlement, then run the reconciliation workflow. | Provider transaction ID, local attempt/refund IDs, signed event, incident audit trail. |
| Secret leak                   | Revoke the exposed credential at its issuer, rotate the deployment secret, restart affected instances, and inspect access logs without copying token values into tickets.                              | Issuer revocation, deployment version, old-secret rejection, incident timeline.        |

## Secret rotation constraints

Keep secrets in a secret manager, not `.env` in an image, Git, or release
artifacts. Rotate one integration at a time and test readiness afterwards.
`JWT_SECRET` and `JWT_REFRESH_SECRET` currently support only one verification
key each: rotating either invalidates tokens signed by the old key. Announce
re-authentication and use a controlled restart; zero-downtime dual-key rotation
requires a separate implementation with key IDs. Changing the refresh signing
secret does not delete session rows, but old refresh tokens become unusable.
Coordinate `VNPAY_HASH_SECRET` with the provider and reconcile in-flight
attempts before/after the switch. Rotate `METRICS_TOKEN` in both the API and
scraper; rotate database/Redis credentials with the backing service first and
then deploy the application. Never print old or new values in CI output.

## Known go-live blockers

- Logical backups are not PITR or automated off-site retention. The operator
  must configure both and pass a timed restore drill.
- The current Nest throttler uses process-local storage. If multiple API
  replicas are deployed, rate limits are not shared across replicas; replace
  its storage with Redis before treating limits as cluster-wide.
- The read-only k6 profile in `test/load` has not demonstrated 250 RPS steady
  or 500 RPS burst until run on production-sized staging with saved results.
  Financial and inventory concurrency tests need disposable fixtures and
  distinct idempotency keys; do not point mutation load at live data.
- The production dependency audit on 2026-09-25 reported 33 high, 18 moderate
  and 5 low advisories, including paths through `multer` and Prisma/`effect`.
  The current lockfile is **not** security-cleared for go-live. Remediate and
  re-run the audit; do not suppress findings by adding an always-failing CI
  job or blindly overriding transitive versions.
