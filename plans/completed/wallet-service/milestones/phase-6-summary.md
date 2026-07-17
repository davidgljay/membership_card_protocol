# Phase 6 Milestone Summary — Hardening and Validation

**Date:** 2026-06-30
**Status:** Complete (implementation). **Production deployment remains blocked on CP-3's independent security review** — see below.

This is the final phase of the wallet-service implementation plan. All four steps plus CP-3 are complete, and — having reached the milestone review that asks "are all five strategic goals actually met?" — one real gap was found and closed along the way (admin endpoints, Goal 5) rather than glossed over.

## What's implemented and verified

- **Step 6.1 (rate limiting):** Replaced the fixed-window limiter from earlier phases with a proper sliding-window-counter algorithm (`server/utils/rate-limit.ts`) — two fixed windows weighted by overlap, avoiding the up-to-2x-limit problem a naive fixed window has at boundaries. Applied to `POST /accounts` (5/IP/hour, IP hashed before use as a key — never stored raw), `POST /accounts/{card_hash}/recovery` (3/card/24h), `GET /accounts/{card_hash}/service-secret` (10/session), `POST /bindings/announce` (100/verified-peer/minute). Verified live: 6th `/accounts/challenge` call in an hour returns 429 with an accurate `Retry-After` header.

  **One rate limit from the original plan was deliberately not implemented:** "100 UUIDs per device_key per 24 hours" on UUID registration. You caught this mid-implementation — each delivered message consumes one UUID, so capping registration directly caps message throughput, and 100/day is far too low for active use. Removed entirely (not reduced or reworked); the per-call cap of 100 UUIDs stays as a payload-size guard, not a throughput limit. `implementation-plan.md` and the Phase 5 summary were both corrected to reflect this.

- **Step 6.2 (audit logging):** All eight required events (`service_secret` created/accessed, backup registration created, recovery initiated/cancelled/key-released, binding announcement accepted/rejected) now emit structured JSON via a single `auditLog()` helper, plus `rate_limit_exceeded` (warn) and `secrets_backend_failure` (error) for the two additional log levels the plan specifies. Schema documented in `docs/audit-log-schema.md`. An automated test (`test/audit-log-schema.test.ts`, 25 assertions) statically checks every device-IO route file (`server/routes/messages/**`, `server/routes/cards/**`) for the explicit prohibitions: no `getRequestIP` calls, no logged `subcardHash` variable references, no raw session tokens, no logged request bodies.

- **Step 6.2a (admin endpoints — not in the original plan, added this phase):** `strategic-plan.md §Goal 5` specified admin endpoints exposing the routing table, pending recovery windows, message counts, and UUID pool sizes — but no phase step ever existed to build them. Found while verifying Goal 5 for this milestone review, not flagged-and-deferred: implemented `GET /admin/recovery-windows`, `GET /admin/message-counts`, `GET /admin/uuid-pool-sizes`, all gated by a single `ADMIN_API_KEY` bearer token with timing-safe comparison (`server/utils/admin-auth.ts`). `GET /bindings` (already built in Phase 4) covers "current routing table." Verified live: 401 with no/wrong key, 200 with correct key, correct data shape, zero device-correlating fields.

- **Step 6.3 (federation smoke test):** Formalized as a permanent script (`scripts/federation-smoke-test.mjs`, `pnpm run smoke:federation`) rather than the ad hoc manual two-instance testing used in Phases 4-5 — closing the gap the Phase 4 summary explicitly flagged. The script spins up two full instances with separate databases (creating and dropping a throwaway `wallet_service_federation_smoke_b` database each run), verifies: registering a card on A replicates to B; a message addressed to that card submitted to B redirects (410) to A; submitting to A directly succeeds and delivers to a fake relay; a dual-signed `card_migration` announcement moves the card to B; A now redirects to B. All 9 checks pass on a clean run, and the script cleans up its own processes and database on exit (confirmed: no leftover `nitro dev` processes, no leftover database, after a full run).

- **Step 6.4 (load baseline):** Run against a `node-server`-preset production build (not `nitro dev`), with a real fake-relay process and a seeded 3,000-UUID pool. **Honest scope note: this ran at a scale appropriate to a single-machine development sandbox, not the plan's literal 100-connection/1000-req/s/60s target, and is explicitly not a substitute for load-testing the real production deployment topology** (Cloudflare Workers + Hyperdrive, or whatever is actually chosen). Results at the scale actually run:
  - 30-second sustained run, 20 connections: **135,000 requests, ~4,500 req/s average, p99 latency 7ms, zero errors/timeouts/non-2xx**.
  - Memory (RSS) sampled every 5 seconds across the 30s run: oscillated between 112-119MB with no upward trend — no leak at this scale/duration.
  - `SECRETS_BACKEND=webcrypto` (the default) was in use throughout — no external rate limit to throttle against, consistent with the plan's own note that KMS throttling is the only backend where this is a real concern.
  - These numbers are far inside the plan's p99<500ms target, but given the environment mismatch (single dev machine vs. the plan's implied production topology), the right reading is "no obvious bottleneck at this layer," not "production capacity confirmed."

- **CP-3 (pre-production security review):** Self-review completed and documented in `docs/security-review-cp3.md`, covering all three items the plan names: (a) 72-hour timer integrity — no code-level manipulation path found; the actual gate is an atomic Postgres `UPDATE ... WHERE expires_at > now()`/`< now()`, immune to Node-process clock skew (only a cosmetic `Retry-After` header value depends on the Node clock); direct DB access is an infra access-control concern, not an app-code one. (b) Cancellation signature verification — call-site logic (challenge-to-window binding, pubkey sourced from the trusted DB row, not request body) is correct and tested; the underlying `@noble/post-quantum` ML-DSA-44 implementation has no independent cryptographic audit, which is out of scope for a self-review to resolve. (c) `SecretsBackend` configuration — grepped every log call in the codebase for key-material references; found none; `.env` is gitignored; `KmsBackend`'s actual security depends on an AWS IAM policy that exists outside this repository. **This self-review does not satisfy CP-3** — the plan explicitly requires an independent reviewer, which the code's author cannot be by definition. Production deployment stays blocked until a genuine independent review (human or separate process) replaces this self-review.

**128 automated tests pass** across 18 files (confirmed by the final `vitest run` in this session) — including this phase's additions: `test/rate-limit.test.ts` (5), `test/audit-log-schema.test.ts` (25), and `test/admin-queries.test.ts` (4), plus a new network-failure regression test in `test/relay-client.test.ts`. Lint and typecheck are clean, all migrations apply cleanly from a fresh database, and both build presets succeed.

## Verifying the five strategic goals (strategic-plan.md, this milestone review's explicit requirement)

| Goal | Status | Evidence |
|---|---|---|
| 1. Secure keyring custody without seeing plaintext | Met | `service_secret` envelope-encrypted (Phase 1), never logged in plaintext anywhere in the codebase (grepped for this phase's CP-3 review), keyring blobs stored/replicated opaquely (Phase 4) |
| 2. Trustworthy recovery with meaningful cancellation protection | Met | 72h timer server-side and atomic (Phase 3, re-confirmed this phase), all four notification channels dispatch and retry (Phase 3), cancellation signature verification correct at the call-site level (this phase's CP-3 review) |
| 3. Privacy-preserving message delivery, no single-operator knowledge | Met | No push tokens/device identities held (architectural, Phases 4-5), `test/audit-log-schema.test.ts` statically enforces no IP/device correlation in device-IO routes, multi-device fan-out is now sender-side (architecture change, this session) rather than wallet-held re-encryption keys — a strictly stronger privacy posture than the original UMBRAL design |
| 4. Federated routing that degrades gracefully | Met | `scripts/federation-smoke-test.mjs` verifies binding sync, cross-instance delivery, 410 redirects, and migration end-to-end on every run; retained-message retransmission on UUID re-registration verified live in Phase 5 |
| 5. Operate honestly and transparently within the trust model | Met (as of this phase) | Admin endpoints built this phase (were a gap); audit log entries exist for every event the plan names (Step 6.2); a second instance can be run and validated via the federation smoke test |

## Deviations and corrections made this phase

- Removed the UUID-registration rate limit entirely (see Step 6.1 above) — a correction from you mid-implementation, not a self-caught issue.
- Added admin endpoints not specified in any phase step (Step 6.2a) — a self-caught gap between the strategic plan and the implementation plan.
- Load baseline run at sandbox scale, explicitly not claimed as production-representative (Step 6.4).
- CP-3 explicitly does not claim to satisfy itself — flagged as a self-review, not the required independent review.

## What's left before production

Everything in this phase's scope is done. What remains is **entirely outside what an implementation agent can self-certify**:

1. **CP-3's actual independent review** (`docs/security-review-cp3.md` is the starting checklist, not the review itself).
2. **A real KMS key policy review**, if `SECRETS_BACKEND=kms` is chosen for production (`webcrypto` needs no equivalent — it has no external policy surface).
3. **A genuine production-scale load test** against the actual deployment topology (Step 6.4's numbers here are sandbox-scale only).
4. **The known operational gaps** carried forward from earlier phases and listed in `docs/operations.md`'s final section (keyring-blob reconciliation, old-backup-registration revocation on rotation).

Once those clear, `implementation-plan.md`'s Phase 6 Milestone Review's "production deployment approved" criterion can actually be marked met — it is not met by this document alone.
