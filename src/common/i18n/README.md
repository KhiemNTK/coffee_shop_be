# HTTP Localization

Requests negotiate `Accept-Language: vi` or `en`, including regional tags and
quality weights. Missing/unsupported languages fall back to English for legacy
clients. Responses set `Content-Language` and vary on `Accept-Language`.

## Rules

- Localize display text at the HTTP boundary only. Keep error codes, request IDs,
  field paths, statuses, success markers, enums, business data and signatures stable.
- Register messages in [error-messages.ts](error-messages.ts). Unregistered custom
  reasons keep their original text, not a misleading generic translation.
- Never mutate global Zod language or process-global request locale; concurrent
  requests can use different languages.
- Language preferences do not enter JWTs, database records, audit or export
  snapshots. This feature needs no migration or seed.

## Verification

Run from the backend root:

```sh
pnpm exec jest --maxWorkers=1 --workerThreads --workerIdleMemoryLimit=512MB --runTestsByPath src/common/i18n/http-locale.spec.ts src/catch-everything/catch-everything.filter.spec.ts src/init.spec.ts
```

The relevant implementation is [http-locale.ts](http-locale.ts); see the
[root README](../../../README.md) for environment and test-database rules.
