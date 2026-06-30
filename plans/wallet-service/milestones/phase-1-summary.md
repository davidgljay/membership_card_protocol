# Phase 1 Milestone Summary — Foundation

**Date:** 2026-06-29
**Status:** Complete

Phase 1 scaffolded the wallet service as a Nitro (`nitropack`) project at `wallet-service/`, mirroring the press's structure (`srcDir: 'server'`, `src/` for framework-agnostic logic). All five steps and the milestone review criteria from `implementation-plan.md §Phase 1` are satisfied:

- **Step 1.1 (scaffolding):** `package.json`, `nitro.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `vitest.config.ts`, and `docker-compose.yml` (Postgres only, port 5433, no Redis) are in place. `npm run build` (Cloudflare preset, default) and `npm run build:node` both produce valid `.output/` bundles; `npm run lint` and `npm run typecheck` pass clean on the seeded codebase.
- **Step 1.2 (schema):** `server/db/migrations/1772400000000_initial-schema.cjs` creates all nine tables from the plan (`holder_accounts`, `keyring_blobs`, `backup_registrations`, `recovery_windows`, `message_queue`, `uuid_pools`, `reencryption_keys`, `routing_table`, `routing_nonces`) plus a `kv_store` table backing the Postgres KV fallback (see Step 1.4 below). Verified against a fresh local Postgres via `docker compose up` + `node-pg-migrate up`: all tables and indexes exist, `SELECT` returns empty result sets.
- **Step 1.3 (secrets backend):** `src/secrets/` implements the `SecretsBackend` interface with `WebCryptoBackend` (default, AES-256-GCM via the runtime Web Crypto API) and `KmsBackend` (opt-in, AWS KMS Encrypt/Decrypt), plus `SecretsService` for envelope-encrypted `service_secret` storage with a 10-minute in-memory DEK cache. 7 unit tests cover round-trip encryption, tamper detection, DEK caching (verified via spy — second decrypt does not call the backend), and KMS round-trip against a mocked client.
- **Step 1.4 (auth):** `src/auth/` implements `sessionTokenAuth` (HMAC-SHA256 bearer tokens, 15-minute TTL, revocation via KV), `masterCardSignatureAuth` (ML-DSA-44 challenge/response, reusing the `@noble/post-quantum` library already used by the press), and peer wallet service signature verification (for Phase 4's `CardBindingAnnouncement`). A KV abstraction (`src/kv.ts`) backs session revocation: `server/utils/kv.ts` wraps Nitro's `useStorage` (`cloudflare-kv-binding` driver by default), with `src/kv-postgres.ts` as the documented fallback for `node-server`/`aws-lambda` presets. 10 unit tests cover valid/expired/tampered/revoked tokens, valid/invalid/wrong-challenge signatures, and peer signature ID-binding.
- **Step 1.5 (health + CI):** `GET /health` (`server/routes/health.get.ts`) checks Postgres reachability and exercises a full `SecretsService` encrypt/decrypt round-trip; returns `200` with `{status, postgres, secrets}` when healthy, `503` otherwise. Verified live against local Postgres. `.github/workflows/wallet-service-ci.yml` runs lint → typecheck → migration → test → both build presets on every push/PR touching `wallet-service/`. `.env.example` documents both `SECRETS_BACKEND` configurations.

## Deviations from the plan as written

- `health.get.ts` was moved from `server/api/` to `server/routes/`: Nitro auto-prefixes `server/api/*` with `/api`, but the plan's "Done when" criteria require the endpoint at exactly `GET /health`.
- The Cloudflare build requires two additions not called out in the plan: `cloudflare.nodeCompat: true` (for `pg` and `node:crypto`) and a `pg-native` alias to `unenv/mock/empty` (the bundler's static analysis chokes on `pg`'s optional native-binding `require()` otherwise). Both are documented inline in `nitro.config.ts`. A `wrangler.toml` with `compatibility_flags = ["nodejs_compat"]` and a `WALLET_KV` namespace binding was added to support this.
- `docker-compose.yml` uses `postgres:16` rather than `postgres:16-alpine` — the alpine variant failed to start in the development environment used for this implementation (`exec format error`); the non-alpine image is unaffected and otherwise equivalent for local dev.
- Scheduled tasks (`scheduledTasks` in `nitro.config.ts`) are left empty in Phase 1 — the 72-hour recovery sweep and pruning jobs referenced in the strategic plan don't have handlers until Phase 3+; referencing non-existent task names would break the build.

## Known gap carried into Phase 2+

`createNitroKvStore()` is wired to the `cloudflare-kv-binding` driver only; the documented Postgres fallback (`src/kv-postgres.ts`) exists as a standalone implementation but isn't yet selected automatically based on the deployed preset. This wasn't exercised because no protected routes exist yet in Phase 1 — `requireSessionToken` (`server/utils/auth.ts`) is plumbed but unused until Phase 2's `POST /auth/session`. Wire up preset-based KV selection when Step 2.1 lands.

## Not yet resolved

CP-1 (registration token issuance — who calls `POST /auth/session` and when) remains open per the plan; it blocks Step 2.1 and must be resolved before Phase 2 begins.
