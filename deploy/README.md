# Single VPS Deployment

Run from the backend repository on a Linux VPS. Keep `coffee_shop_be` and
`coffee_shop_fe` as sibling repositories and record both Git SHAs for each release.
This setup is one server, not high availability. It does not migrate or seed on startup.

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

## Recovery

Do not run `down -v`, `prisma migrate reset`, or drop the new metadata columns.
Restore the previous FE/BE images together only when their contracts are compatible
with the expanded schema. Fix failed migrations forward; investigate an unhealthy
backend before restarting it repeatedly. Keep a tested off-server backup and verify
restore before taking payments. Named volumes on the same VPS are not backups.
