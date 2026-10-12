# HTTP Localization

The SPA sends `Accept-Language: vi` or `en`. Express negotiates regional tags and
quality weights. Unsupported or missing languages fall back to English to keep
legacy clients compatible. Responses declare `Content-Language` and vary on
`Accept-Language`.

Only error display text is localized at the HTTP boundary. Error codes, request
IDs, field paths, HTTP statuses, success envelope markers (`OK`/`ERROR`), business
data, audit records, provider signatures, webhook contracts and export snapshots
stay unchanged. No language preference is put into JWTs or database records.

`error-messages.ts` handles registered business codes, shared messages and Zod
constraints. An unregistered custom validation/business reason stays in its
original language rather than being replaced with a misleading generic message.
Add its translation when migrating that domain. Never use process-global
`z.config()` or mutable global request language: concurrent requests can differ.

No migration or seed is needed for this feature. The earlier menu metadata
migration is a separate deployment prerequisite and is not applied by i18n.

Relevant unit tests run with one worker:

```sh
pnpm exec jest --maxWorkers=1 --workerIdleMemoryLimit=512MB --runTestsByPath src/common/i18n/http-locale.spec.ts src/catch-everything/catch-everything.filter.spec.ts src/init.spec.ts
```
