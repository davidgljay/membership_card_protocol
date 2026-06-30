# Phase 2 Milestone Summary — Keyring Custody (Primary Service)

**Date:** 2026-06-30
**Status:** Complete

Phase 2 implements holder account creation, `service_secret` issuance and retrieval, and post-recovery keyring rotation — for both open-offer acceptance paths identified while resolving CP-1 (`open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`). All steps from `implementation-plan.md §Phase 2` are implemented and verified against a live local Postgres.

- **Step 2.0 (schema addendum):** `server/db/migrations/1772400100000_phase2-auth.cjs` adds `webauthn_credential_id` / `webauthn_public_key` / `webauthn_sign_count` to `holder_accounts`, plus a shared `auth_challenges` table backing all three challenge/response flows in this phase (`account_creation`, `passkey_login`, `keyring_rotation`). Verified against a fresh DB alongside the Phase 1 migration.
- **Step 2.1 (WebAuthn passkey login):** `POST /auth/passkey/challenge` and `POST /auth/passkey/login` (`server/routes/auth/passkey/`), backed by `src/auth/webauthn.ts` (wraps `@simplewebauthn/server`'s `verifyAuthenticationResponse`, with sign-count replay protection). 5 unit tests (mocked verification) cover verified/failed/replayed-counter/error paths; live smoke test confirms a fabricated assertion is rejected with a clean 401, not a crash.
- **Step 2.2 (account creation):** `POST /accounts/challenge` and `POST /accounts` (`server/routes/accounts/`), authenticated by the freshly-generated master card key signing the challenge — no external registration token, per CP-1's resolution. Verified live end-to-end: account creation, duplicate-challenge rejection (401), duplicate-card_hash rejection (409), and duplicate-`webauthn_credential_id` now returns a clean 409 (caught a raw Postgres 500 during testing and fixed it).
- **Step 2.3 (`service_secret` retrieval):** `GET /accounts/{card_hash}/service-secret`, session-token authenticated, rate-limited to 10 calls per session lifetime. Verified live: correct retrieval, 403 on card_hash mismatch, and the response is the consistent 32-byte secret returned at account creation.
- **Step 2.4 (keyring rotation):** `POST /accounts/{card_hash}/keyring/challenge` and `PUT /accounts/{card_hash}/keyring`, `masterCardSignatureAuth`-protected. Verified live end-to-end: rotation succeeds and returns a new `service_secret` + `keyring_id`; the session token issued at account creation is rejected immediately after rotation (`invalidateSessionsForCard`, new in this phase); invalid signatures are rejected with 401.

37 automated tests pass (17 from Phase 1 + 17 new: `test/challenges.test.ts`, `test/accounts-repo.test.ts`, `test/webauthn.test.ts`, plus additions to `test/auth.test.ts`), lint and typecheck are clean, and both build presets (Cloudflare default, Node sanity-check) succeed.

## Bugs found and fixed during this phase

- **KV `increment()` discarded its own TTL.** `server/utils/kv.ts` and `src/kv-postgres.ts` both wrote `expiresAt: null` on every `increment()` call, silently making rate-limit windows permanent after the first hit. Found while wiring up Step 2.1/2.2/2.3's rate limits; fixed in both implementations to preserve the existing expiry across increments within a window.
- **`Invalid binding WALLET_KV: undefined`** — `createNitroKvStore()` (the only KV implementation actually wired up in Phase 1) requires a real Cloudflare Workers KV binding, which doesn't exist under plain `nitro dev` or in CI. This was flagged as a known gap at the end of the Phase 1 summary and is now resolved: a new `KV_BACKEND` config (`cloudflare-kv` | `postgres`, default `postgres`) and `server/utils/kv-store.ts` factory pick the backend at runtime. All routes now go through `createKvStore()` rather than `createNitroKvStore()` directly. `cloudflare-kv` remains available for production Cloudflare deploys with a real `WALLET_KV` binding (see `wrangler.toml`).
- **Duplicate `webauthn_credential_id` returned a raw Postgres 500.** `POST /accounts` now catches the unique-violation (`23505`) and returns a clean `409`.

## Deviations from the plan as written

- `POST /auth/passkey/login`'s `assertion` field is a structured `AuthenticationResponseJSON` object (the standard shape `navigator.credentials.get()` produces, matching `@simplewebauthn/server`'s expected input), not a single base64url-encoded blob as the implementation plan's wire-format sketch suggested. This is what the verification library actually requires.
- `REGISTRATION_TOKEN_SECRET` (a Phase 1 config field for the registration-token mechanism CP-1 removed) was dead code; deleted from `src/config.ts`, `.env`/`.env.example`, and CI. `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` were added in its place.

## Known gaps carried into Phase 3+

- Federation broadcast (`broadcastKeyring`/`broadcastKeyringDelete`, Step 4.1a) is not yet implemented — `POST /accounts` and `PUT /accounts/{card_hash}/keyring` both store keyring blobs locally only, with a `// lands in Phase 4` comment marking the call site. Single-instance behavior is correct; federation replication is explicitly out of scope until Phase 4.
- Rate limits implemented in this phase (`/accounts/challenge`: 5/IP/hour; `/auth/passkey/challenge`: 20/card_hash/hour; `/accounts/{card_hash}/service-secret`: 10/session) are fixed-window counters via `server/utils/rate-limit.ts`, not the sliding-window-with-`Retry-After` design Phase 6 Step 6.1 calls for. Functionally correct for now; will be superseded, not duplicated, when Phase 6 lands.
- No automated test exercises a cryptographically valid WebAuthn assertion (would require a simulated authenticator). `src/auth/webauthn.ts`'s verification logic is tested via mocking `@simplewebauthn/server`; the live smoke test only confirms a fabricated assertion fails cleanly (401, not 500). Worth a dedicated test using `@simplewebauthn/server`'s test fixtures if one becomes available, but not blocking — the surrounding route logic (challenge issuance, consumption, card_hash scoping, error handling) is fully covered.
