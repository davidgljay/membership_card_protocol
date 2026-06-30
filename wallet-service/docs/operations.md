# Wallet Service — Operator Runbook

**Status:** Production deployment approval is pending CP-3's independent security review (see `docs/security-review-cp3.md`). This runbook documents how to deploy, configure, and operate an instance once that review clears.

---

## Deployment

The wallet service is a Nitro (`nitropack`) application with three supported presets, one codebase:

| Preset | Build command | Target |
|---|---|---|
| `cloudflare-module` (default) | `pnpm run build` / `pnpm run build:cloudflare` | Cloudflare Workers |
| `node-server` | `pnpm run build:node` | Any Node 22+ host |
| `aws-lambda` | `pnpm run build:lambda` | AWS Lambda |

**Cloudflare specifics:** `wrangler.toml` sets `compatibility_flags = ["nodejs_compat"]` (required for `pg` and `node:crypto`) and declares the `WALLET_KV` binding used when `KV_BACKEND=cloudflare-kv`. `pg` needs a TCP-capable path to Postgres from a Worker — use Cloudflare Hyperdrive or an equivalent; a bare Worker cannot open a raw TCP socket to a database without it.

**Database:** PostgreSQL, schema managed via `node-pg-migrate` (`server/db/migrations/`). Run `pnpm run migrate` (reads `.env`) or `node-pg-migrate up --migrations-dir server/db/migrations --database-url-var DATABASE_URL` with `DATABASE_URL` set directly, before starting the application for the first time and after every deploy that adds a migration.

---

## Configuration reference

See `.env.example` for the full list with inline documentation. Summary by concern:

- **Secrets backend** (`SECRETS_BACKEND=webcrypto` default, or `kms`): see `plans/wallet-service/strategic-plan.md §Secret Storage` for the tradeoff. `webcrypto` needs `WEBCRYPTO_MASTER_KEY` set as a genuine platform secret (Cloudflare Worker secret via `wrangler secret put`, not a plain environment variable in a committed config) — **never** put it in `wrangler.toml` or any file that reaches source control.
- **KV backend** (`KV_BACKEND=postgres` default, or `cloudflare-kv`): `postgres` works everywhere including local dev and CI; `cloudflare-kv` requires the `WALLET_KV` binding to actually exist in the target Cloudflare account.
- **WebAuthn** (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`): must match the real public hostname the wallet's client-facing flows run on. Getting this wrong breaks existing-wallet passkey login (Step 2.1) silently (assertions will fail verification).
- **Federation** (`WALLET_SERVICE_ID`, `WALLET_SERVICE_ENDPOINT`, `WALLET_SERVICE_PRIVATE_KEY`, `PEER_LIST`): `WALLET_SERVICE_PRIVATE_KEY` is this instance's federation signing identity — treat it with the same care as the secrets-backend master key (platform secret, never committed). `PEER_LIST` is a static, manually-maintained JSON array; adding or removing a wallet service from the federation requires updating every other operator's `PEER_LIST` out-of-band (message_routing.md §Wallet Service Registry).
- **Relay** (`RELAY_BASE_URL`): the relay this instance delivers `POST /deliver/{uuid}` calls to. One relay per wallet service deployment in this implementation; the relay itself is a separate service (`specs/object_specs/relay.md`), not covered by this runbook.
- **Notifications** (`SENDGRID_*`, `TWILIO_*`): optional. If unset, email/SMS notifications fall back to a console-logging provider — **this silently breaks the 72-hour recovery window's actual notification guarantee**. Production deployments handling real recovery flows must configure real providers; the fallback exists only to let the service start without external accounts in development.
- **Admin** (`ADMIN_API_KEY`): gates `/admin/*` (§Admin Endpoints below). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, store as a platform secret, rotate by updating the env var (no code change needed — `requireAdminAuth` reads it fresh from config each request, and config is process-lifetime-cached, so a rotation requires a redeploy/restart to take effect).

---

## Scheduled tasks

Three tasks run via Nitro's `scheduledTasks` (`nitro.config.ts`) — note `experimental: { tasks: true }` is required for these to register at all; without it, Nitro silently never invokes them (a real bug found and fixed during this implementation — see `plans/wallet-service/milestones/phase-3-summary.md`).

| Task | Schedule | Purpose |
|---|---|---|
| `sweep-notification-retries` | every 5 min | Retries failed recovery notification dispatches with exponential backoff |
| `prune-routing-nonces` | weekly, Sunday 03:00 | Deletes replay-prevention nonces older than the 24h window they protect |
| `prune-expired-uuids` | nightly, 04:00 | Deletes expired + already-consumed `uuid_pools` rows |

On `node-server`/`aws-lambda`, confirm the deployment's cron/scheduler equivalent actually invokes these — Nitro's `scheduledTasks` map needs a runtime that calls it (Cloudflare Cron Triggers do this automatically for the `cloudflare-module` preset; other presets need an external scheduler hitting the task-invoke mechanism).

---

## Admin endpoints

Three read-only endpoints, gated by `Authorization: Bearer ${ADMIN_API_KEY}` (strategic-plan.md §Goal 5 — operational transparency):

| Endpoint | Returns |
|---|---|
| `GET /bindings` | Full routing table (unauthenticated by design — federation peers need this for startup sync) |
| `GET /admin/recovery-windows` | Every pending recovery window: `recovery_id`, `initiated_at`, `expires_at`, `seconds_remaining` |
| `GET /admin/message-counts` | Uncleared message count per `card_hash` |
| `GET /admin/uuid-pool-sizes` | Available UUID count per `(card_hash, subcard_hash)` |

None of these expose plaintext key material, `subcard_hash`-to-device correlation, or message payload content — see `docs/audit-log-schema.md` for the underlying invariant these are built against.

---

## Audit logs

Structured JSON, one event per line — full schema and the explicit prohibitions enforced against it: `docs/audit-log-schema.md`. Key operational signals to alert on:

- `secrets_backend_failure` (level `error`) — the `SecretsBackend` (KMS or WebCrypto) failed to encrypt/decrypt. Should never happen in steady state; investigate immediately (KMS throttling/permissions, or a corrupted ciphertext).
- `binding_announcement_rejected` (level `warn`) — a peer's announcement failed signature verification or was a nonce replay. Occasional rejections from a misconfigured peer are normal; a sustained flood from one `peer_wallet_id` may indicate that peer is compromised or misbehaving.
- `rate_limit_exceeded` (level `warn`) — any rate-limited endpoint hit its cap. Frequent hits from the same key may indicate abuse; see `server/utils/enforce-rate-limit.ts` for the five rate-limited endpoints (`POST /accounts`, `POST /accounts/{card_hash}/recovery`, `GET /accounts/{card_hash}/service-secret`, `POST /bindings/announce` — UUID registration is deliberately *not* rate-limited, see implementation-plan.md §Step 6.1).

---

## Federation operations

- **Adding a peer:** generate the new operator's `wallet_service_id`/endpoint, add to every existing operator's `PEER_LIST`, redeploy. The new instance performs startup sync via `GET /bindings` against its configured peers to build its initial routing table (not yet automated — currently a manual step the new operator runs once at first boot; see `specs/process_specs/message_routing.md §Startup Sync`).
- **Verifying federation health:** run `pnpm run smoke:federation` against a non-production environment to validate cross-instance message delivery and migration handling end-to-end (`scripts/federation-smoke-test.mjs`).
- **Card migration:** off-chain, via a dual-signed `card_migration` `CardBindingAnnouncement` (`POST /bindings/announce`). The full migration protocol is `specs/process_specs/card_migration.md`; this wallet service implements the routing-table side (accept the announcement, apply conflict resolution, return `410 Gone` with the new operator's identity for stale lookups) but not card-holder-facing migration initiation, which is a client-side flow outside this service's scope.

---

## Known operational gaps (carried from phase milestone summaries)

- No automated keyring-blob garbage collection beyond the explicit delete-on-rotation broadcast (Step 4.1a) — a federation member that misses a delete broadcast (e.g., was down) retains a stale `keyring_id` indefinitely. No reconciliation sweep exists yet.
- Old backup registrations are not revoked during keyring rotation (Phase 3 summary) — the spec calls for this (`wallet_backup_and_recovery.md` Process 3 Step 13) but it isn't implemented.
- `SECRETS_BACKEND=kms`'s actual security depends on an AWS KMS key policy that exists outside this repository — see `docs/security-review-cp3.md §(c)`.
