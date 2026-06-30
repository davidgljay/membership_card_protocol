# Wallet Service Backend — Implementation Plan

**Date:** 2026-06-29
**Status:** Draft
**Strategic plan:** [strategic-plan.md](./strategic-plan.md)

---

## Resolved Design Decisions

The following open questions from the strategic plan are resolved here:

| Question | Decision |
|---|---|
| OQ-WS-1: `service_secret` delivery auth | **Resolved (CP-1).** No externally-issued registration token — there is no third party in the loop to issue one. Per `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`, the wallet service is the sole, continuous driver of offer display, wallet creation, and claim submission; auth is bootstrapped in-flow instead: **new wallet** — `POST /accounts` is authenticated by the freshly-generated master card key signing a server-issued challenge (same challenge/response shape as recovery), proving control of the key being registered; the response includes a session token directly, so no separate login step is needed for the rest of that session. **Existing wallet** — the recipient already holds an account and must authenticate via a new WebAuthn passkey login (Step 2.1) before `GET /service-secret` (Step 2.3) will release the value needed to decrypt and update their keyring. At recovery re-registration (Phase 3), device signs a challenge with the recovered master card key; wallet issues a session token in response — unchanged. |
| OQ-WS-2: WebSocket for relay bridging | **Resolved by relay spec change.** Wallet service no longer exposes a WebSocket endpoint. Relay's `GET /ws/{uuid}` is device-facing only. Outbound messages go device → wallet HTTPS directly. Wallet service is fully stateless with respect to persistent connections — this is what enables the Nitro/serverless deployment model below. |
| OQ-WS-3: Keyring blob storage | **No IPFS.** Per `ARCHITECTURE.md` ADR-009-AMEND, the keyring blob is stored in traditional, deletable storage (`keyring_blobs` table) and replicated to every wallet service in the federation, keyed by `keyring_id = keccak256(encrypted_blob)`. Rotation triggers a synchronized delete of the superseded version across all federation members. See Step 4.1a. |
| OQ-WS-4: UMBRAL re-encryption key storage | **Moot — architecture changed in Phase 4.** Originally resolved as "stored in plaintext, no encryption." Phase 4 replaced wallet-side UMBRAL re-encryption with sender-side per-sub-card encryption (`message_routing.md` v0.4): the sender resolves the recipient's current sub-card list from the storage contract and encrypts independently to each one, so the wallet service never holds re-encryption key material at all. This also avoided taking on the only available UMBRAL implementation's GPL-3.0 license. |
| OQ-WS-5: Federation scope | Single wallet service at launch. Peer list, binding announcements, and startup sync are implemented but tested against a single-instance stub. Federation is validated in Phase 4. |
| OQ-WS-6: Cancellation credential | Master card key. Holder signs a cancellation challenge with their master card key. The wallet service verifies the ML-DSA-44 signature against the master card's public key (already held from account registration). |

**Standing privacy invariant — applies to every phase:**

The wallet service must not be able to determine which cards are held on which devices. Concretely:
- No log, metric, trace, database record, or admin endpoint may link a `device_key`, IP address, or session to a `card_hash` or `subcard_hash`.
- No IO with devices (inbound messages, UUID registration, sub-card registration, service_secret retrieval) is logged at the request/response level. Only outcome events (account created, sub-card registered) are logged, stripped of all network identifiers.
- If this invariant conflicts with an operational or debugging need in any phase, the invariant wins. Debugging must use aggregate metrics only.

---

**Deployment model decision:** The wallet service is built on the [Nitro](https://nitro.unjs.io) server framework (`nitropack`), matching the press. The relay spec change (removing the wallet WebSocket requirement) makes the wallet service a stateless HTTP API plus one scheduled sweep task (for 72-hour timer expiry), which Nitro targets across multiple deployment presets from one codebase. **The default build preset is `cloudflare-module`** (Cloudflare Workers); `aws-lambda` and `node-server` presets are also supported for operators who prefer those platforms. See `strategic-plan.md §Architectural Decision: Deployment Framework and Default Target` for the full rationale, including the naming distinction between the Nitro framework and unrelated AWS Nitro Enclaves.

---

## Phases

---

### Phase 1: Foundation

**Goal:** Project scaffolded on Nitro, database schema defined, secrets backend tested, auth middleware in place, CI green.

---

**Step 1.1 — Project scaffolding**
- What: Initialize a Nitro (`nitropack`) project, mirroring the press's structure (`srcDir: 'server'`). Set up `tsconfig.json`, ESLint, Prettier, Vitest. Create directory structure: `server/routes/`, `server/services/`, `server/db/`, `server/adapters/`, `server/tasks/` (scheduled tasks). `nitro.config.ts` sets `preset: 'cloudflare-module'` as the default, with `build:lambda` (`NITRO_PRESET=aws-lambda`) and `build:node` (`NITRO_PRESET=node-server`) as alternate scripts, matching the press's `package.json` convention. Add `docker-compose.yml` with PostgreSQL only (for local dev/testing — no Redis; no background job queue is needed per the deployment model decision above).
- Who: Claude
- Context needed: `specs/ARCHITECTURE.md` (language decision context), `specs/object_specs/relay.md` (endpoints the wallet service must expose to the relay), `press/nitro.config.ts` and `press/package.json` (conventions to mirror)
- Done when: `npm test` passes (no tests yet, just setup); `docker compose up` starts PostgreSQL; `nitro build` (default Cloudflare preset) and `npm run build:node` both produce valid output; lint passes on empty codebase.

**Step 1.2 — PostgreSQL schema**
- What: Write and apply the initial database migration using `node-postgres` + `db-migrate` (or `drizzle-orm`). Tables:

  ```sql
  -- Holder accounts
  holder_accounts (
    id              UUID PRIMARY KEY,
    card_hash       TEXT UNIQUE NOT NULL,   -- keccak256(card_pubkey)
    master_pubkey   TEXT NOT NULL,           -- ML-DSA-44 pubkey, base64url
    keyring_id      TEXT NOT NULL,           -- keccak256(encrypted_blob); lookup key into keyring_blobs
    service_secret_enc  TEXT NOT NULL,       -- AES-256-GCM ciphertext of service_secret, DEK stored separately
    service_secret_dek_enc TEXT NOT NULL,    -- envelope-encrypted DEK for this account's service_secret (see SecretsService, Step 1.3)
    created_at      TIMESTAMPTZ DEFAULT now()
  );

  -- Keyring blobs (replicated across the wallet service federation; see
  -- ARCHITECTURE.md ADR-009-AMEND. Not IPFS — traditional, deletable storage.
  -- A row here may belong to a holder served by THIS wallet service, or to a
  -- holder of any peer in the federation (full replication, OQ-WS-3).
  keyring_blobs (
    keyring_id      TEXT PRIMARY KEY,        -- keccak256(encrypted_blob)
    card_hash       TEXT NOT NULL,
    encrypted_blob  TEXT NOT NULL,           -- AES-GCM ciphertext, base64url; opaque to this service
    received_at     TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX ON keyring_blobs(card_hash);

  -- Backup registrations (wrapped decryption key blobs)
  backup_registrations (
    id              UUID PRIMARY KEY,
    holder_id       UUID REFERENCES holder_accounts(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('synced_passkey', 'yubikey')),
    wrapped_blob    TEXT NOT NULL,           -- opaque ciphertext; wallet cannot decrypt
    notification_channels  JSONB NOT NULL,  -- { email, sms, webhook, secondary_contact }
    cancellation_pubkey    TEXT NOT NULL,   -- ML-DSA-44 pubkey for cancellation signing (master card key)
    created_at      TIMESTAMPTZ DEFAULT now()
  );

  -- Active recovery windows
  recovery_windows (
    id              UUID PRIMARY KEY,
    backup_reg_id   UUID REFERENCES backup_registrations(id),
    initiated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,   -- initiated_at + 72 hours
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cancelled', 'released')),
    cancelled_at    TIMESTAMPTZ,
    released_at     TIMESTAMPTZ
  );

  -- Per-card message queue
  message_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_hash       TEXT NOT NULL,
    payload         TEXT NOT NULL,           -- E2E encrypted routing envelope payload, base64url
    received_at     TIMESTAMPTZ DEFAULT now(),
    cleared         BOOLEAN DEFAULT FALSE,
    cleared_at      TIMESTAMPTZ
  );
  CREATE INDEX ON message_queue(card_hash, cleared);

  -- UUID pools (subcard delivery routing)
  uuid_pools (
    uuid            UUID PRIMARY KEY,
    card_hash       TEXT NOT NULL,
    subcard_hash    TEXT NOT NULL,           -- keccak256(subcard_pubkey), opaque
    consumed        BOOLEAN DEFAULT FALSE,
    registered_at   TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL    -- registered_at + 30 days
  );
  CREATE INDEX ON uuid_pools(card_hash, subcard_hash, consumed);

  -- reencryption_keys (UMBRAL; one per card per sub-card) — DROPPED IN PHASE 4.
  -- This table shipped with Phase 1 under the original UMBRAL re-encryption
  -- design. Phase 4 replaced wallet-side re-encryption with sender-side
  -- per-sub-card encryption (message_routing.md v0.4), so the wallet service
  -- no longer holds any re-encryption key material — this table was dropped
  -- via a Phase 4 migration. Left here, struck through in spirit, for the
  -- historical record; see Phase 4 Step 4.3.

  -- Routing table (off-chain; card_hash → wallet service endpoint)
  routing_table (
    card_hash       TEXT PRIMARY KEY,
    wallet_service_id TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('card_registration', 'card_migration')),
    announced_at    TIMESTAMPTZ NOT NULL,
    nonce           TEXT NOT NULL UNIQUE     -- replay prevention
  );

  -- Nonce cache (routing announcement replay prevention)
  routing_nonces (
    nonce           TEXT PRIMARY KEY,
    seen_at         TIMESTAMPTZ DEFAULT now()
  );
  ```

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md`, `specs/process_specs/notification_relay.md`, `specs/process_specs/message_routing.md`
- Done when: Migration runs clean against a fresh PostgreSQL instance; all indexes exist; `SELECT` on each table returns empty result set.

**Step 1.3 — Secrets backend and envelope encryption**
- What: Implement a `SecretsBackend` interface with two methods:
  - `wrapDek(dek: Buffer): Promise<string>` — encrypts a 256-bit DEK with the backend's master key, returns ciphertext.
  - `unwrapDek(dek_enc: string): Promise<Buffer>` — decrypts a wrapped DEK.

  And a `SecretsService` built on top of it, used only for `service_secret` (re-encryption keys are stored in plaintext per OQ-WS-4 and need no service):
  - `encryptSecret(plaintext: Buffer): { ciphertext: string, dek_enc: string }` — generates a random 256-bit DEK, encrypts plaintext with AES-256-GCM using the DEK, wraps the DEK via the configured `SecretsBackend`, returns both ciphertexts.
  - `decryptSecret(ciphertext: string, dek_enc: string): Buffer` — unwraps the DEK via the backend (result cached in process memory with a 10-minute TTL), decrypts ciphertext with the DEK.

  Two `SecretsBackend` implementations:
  - **`WebCryptoBackend` (default).** Master key is a platform secret (Cloudflare Worker secret on the `cloudflare-module` preset, environment variable on `node-server`/`aws-lambda`). Wrap/unwrap use the runtime's native Web Crypto API (AES-256-GCM) — no external service call, no AWS dependency. This is the default for all presets, including `aws-lambda`.
  - **`KmsBackend` (opt-in).** Calls AWS KMS `Encrypt`/`Decrypt` to wrap/unwrap the DEK. Available for operators who want a logged, IAM-gated decrypt call kept in a separate credential domain from the application secret — this is a deliberate trade of an AWS dependency for an audit trail and key-custody separation. Selected via config (e.g. `SECRETS_BACKEND=kms`), independent of which Nitro preset is deployed.
- Who: Claude
- Context needed: `strategic-plan.md §Secret Storage: Two Different Trust Levels`, `strategic-plan.md §Architectural Decision`
- Done when: Unit tests cover encrypt/decrypt round-trip against `WebCryptoBackend`; DEK caching verified (second decrypt call hits memory, not the backend); `decryptSecret` throws on tampered ciphertext; `KmsBackend` has equivalent unit tests run against a mocked KMS client.

**Step 1.4 — Auth middleware**
- What: Implement two auth mechanisms:
  - `sessionTokenAuth` — validates short-lived HMAC-SHA256 bearer tokens (issued by `POST /auth/session`); tokens contain `{ card_hash, issued_at, expires_at }`; 15-minute TTL. Revocation list stored via Nitro's `storage` abstraction (already used by the press for KV-backed storage) rather than Redis — defaults to a `cloudflare-kv-binding` driver on the Cloudflare preset, falls back to a Postgres-backed table on `node-server`/`aws-lambda`. No standalone Redis dependency.
  - `masterCardSignatureAuth` — for recovery re-registration only; holder sends a signed challenge using their ML-DSA-44 master card key; wallet verifies signature against the `master_pubkey` in `holder_accounts`.
  - Peer wallet service auth: verify ML-DSA-44 signature on `CardBindingAnnouncement` (no middleware needed; handled inline in routing endpoints).
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Actors`, `strategic-plan.md §OQ-WS-1`
- Done when: Integration tests confirm: valid token passes; expired token fails; tampered token fails; invalid master card signature fails; valid master card signature succeeds.

**Step 1.5 — Health check and CI**
- What: `GET /health` returns `{ status: "ok", postgres: "ok", secrets: "ok" }` (or `degraded` with individual component status; `secrets` checks whichever `SecretsBackend` is configured). Add GitHub Actions workflow: lint → test → `nitro build` (default Cloudflare preset) → `npm run build:node` (sanity-check the alternate preset still builds). Add environment variable template (`.env.example`) covering both `SECRETS_BACKEND=webcrypto` (default) and `SECRETS_BACKEND=kms` configs.
- Who: Claude
- Context needed: none
- Done when: `GET /health` returns 200 against local Postgres; CI workflow passes on a clean push for both build presets.

**⬥ Phase 1 Milestone Review**
- Context needed: Phase 1 step outputs; `plans/wallet-service/strategic-plan.md §Goals 1 and 5`
- Done when: Schema reviewed against all three process specs (backup/recovery, notification relay, message routing) for completeness; `SecretsService` tested end-to-end against both `WebCryptoBackend` and a mocked `KmsBackend`; auth middleware passes all failure cases; CI is green for both the Cloudflare and Node build presets; one-paragraph phase summary written to `plans/wallet-service/milestones/phase-1-summary.md`.

---

### Phase 2: Keyring Custody (Primary Service)

**Goal:** Holder accounts can be created, `service_secret` issued, keyring CID stored and updated. Session token authentication works end-to-end for both acceptance paths — master-card-key signature at new-wallet creation, WebAuthn passkey login for existing wallets.

---

**Step 2.1 — WebAuthn passkey registration and login (CP-1 resolved — see below)**
- What: Per `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`, the wallet service is the sole, continuous driver of offer display, wallet creation, and claim submission — there is no third party that mints a registration token (see CP-1 resolution note below). Two distinct auth needs follow from the two specs:

  - **New wallet:** no prior credential exists. `POST /accounts` (Step 2.2) is authenticated directly by the freshly-generated master card key signing a server-issued challenge — folded into Step 2.2, not a separate endpoint.
  - **Existing wallet:** the recipient already has an account and must prove it via a WebAuthn login before the wallet service will release `service_secret` (Step 2.3) so they can decrypt and update their existing keyring (`open_offer_acceptance_existing_wallet.md` Step 6). This is a genuinely new endpoint, not previously in this plan.

  `POST /auth/passkey/challenge` — issues a WebAuthn assertion challenge. Unauthenticated, identified by `card_hash`, rate-limited by `card_hash`.

  ```
  POST /auth/passkey/challenge
  Body: { card_hash: "<hex>" }
  Response: { challenge: "<32 random bytes, base64url>", credential_id: "<base64url>", expires_at: "<ISO8601>" }
  ```

  `POST /auth/passkey/login` — verifies a WebAuthn assertion against the credential public key stored for this account (see schema addendum below), issues a 15-minute session token (same shape as `issueSessionToken`, Step 1.4).

  ```
  POST /auth/passkey/login
  Body: {
    card_hash: "<hex>",
    challenge: "<same value>",
    assertion: "<WebAuthn AuthenticatorAssertionResponse, base64url-encoded per WebAuthn JSON serialization>"
  }
  Response: { session_token: "<bearer>", expires_at: "<ISO8601>" }
  ```

  **Schema addendum (extends Step 1.2's `holder_accounts` table — add via a Phase 2 migration, not a Phase 1 retrofit):**

  ```sql
  ALTER TABLE holder_accounts
    ADD COLUMN webauthn_credential_id TEXT NOT NULL,
    ADD COLUMN webauthn_public_key    TEXT NOT NULL,  -- COSE public key, base64url
    ADD COLUMN webauthn_sign_count    BIGINT NOT NULL DEFAULT 0;  -- replay protection per WebAuthn spec
  CREATE UNIQUE INDEX ON holder_accounts(webauthn_credential_id);
  ```

  The credential is registered once, as part of `POST /accounts` (Step 2.2) for new wallets — there is no separate `POST /auth/passkey/register`, since passkey creation and account creation happen in the same call per `open_offer_acceptance_new_wallet.md` Step 6.

- Who: Claude
- Context needed: `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md §Phase 2 Step 6`
- Done when: Integration test: valid WebAuthn assertion → session token; signature count must increase monotonically (replay of a prior assertion → 401); expired challenge → 401; assertion for wrong `card_hash`'s credential → 401.

**⚑ Clarification Checkpoint CP-1 — RESOLVED**

There is no externally-issued registration token. The wallet service hosts and drives the entire offer-display → wallet-creation → claim-submission flow itself (confirmed against `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`), so there's no third party to issue one. New-wallet account creation authenticates via the freshly-generated master card key (Step 2.2); existing-wallet re-authentication uses WebAuthn passkey login (Step 2.1, above).

**Step 2.2 — Holder account creation and `service_secret` generation**
- What: `POST /accounts/challenge` — issues a random challenge. Unauthenticated (there is no account yet to authenticate against), rate-limited by IP.

  ```
  POST /accounts/challenge
  Response: { challenge: "<32 random bytes, base64url>", expires_at: "<ISO8601>" }
  ```

  `POST /accounts` — creates a holder account, authenticated by the master card key signing the challenge (proves control of the key being registered; mirrors the challenge/response shape already used for recovery and keyring rotation). Generates a 256-bit `service_secret`, encrypts it via `SecretsService.encryptSecret` (Step 1.3), stores it in `holder_accounts` along with the WebAuthn credential registered in the same call (Step 2.1 schema addendum). Accepts the holder's encrypted keyring blob, computes `keyring_id = keccak256(encrypted_blob)`, stores it in `keyring_blobs`, and broadcasts it to every peer wallet service in the federation (see Step 4.1a). Per `ARCHITECTURE.md` ADR-009-AMEND, this is traditional storage, not IPFS — the wallet service never resolves a CID, it just stores and forwards the ciphertext it's given.

  ```
  POST /accounts
  Body: {
    challenge: "<same value as /accounts/challenge>",
    signature: "<ML-DSA-44 sig over challenge using the new master private key, base64url>",
    card_hash: "<hex>",
    master_pubkey: "<ML-DSA-44 pubkey, base64url>",
    webauthn_credential_id: "<base64url>",
    webauthn_public_key: "<COSE public key, base64url>",
    encrypted_keyring_blob: "<AES-GCM ciphertext, base64url>"
  }
  Response: {
    service_secret: "<256-bit value, base64url>",
    account_id: "<UUID>",
    keyring_id: "<keccak256 hex>",
    session_token: "<bearer>",
    expires_at: "<ISO8601>"
  }
  ```

  The response includes a `session_token` directly — bootstrapped from the same in-flow signature check, so the rest of the wallet-creation flow (e.g. Step 3.1's optional YubiKey backup, offered in the same session per `open_offer_acceptance_new_wallet.md` Step 9) doesn't require a second login. `service_secret` is returned in this response only. It is not stored in plaintext; the encrypted version in the database can only be decrypted via the configured `SecretsBackend`. Log: account creation (card_hash, timestamp) — no key material in logs.

- Who: Claude
- Context needed: `specs/process_specs/open_offer_acceptance_new_wallet.md §Phase 2 Steps 6–10`, `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Steps 3–4`, `strategic-plan.md §Goal 1`
- Done when: `service_secret` returned in response is exactly 32 bytes; encrypted value in DB is different from plaintext; `decryptSecret` round-trip recovers the original value; valid challenge signature → account created + session token issued; invalid/missing signature → 401; expired challenge → 401; test confirms no plaintext secrets appear in application logs.

**Step 2.3 — `service_secret` retrieval**
- What: `GET /accounts/{card_hash}/service-secret` — authenticated with session token. Decrypts and returns `service_secret` for daily-use decryption key derivation. If `SecretsBackend=kms`, the decrypt call is logged by AWS automatically; the `WebCryptoBackend` default has no external audit log, so the application's own access log (Step 5.1) is the audit trail in that configuration.

  ```
  GET /accounts/{card_hash}/service-secret
  Authorization: Bearer {session_token}
  Response: { service_secret: "<base64url>" }
  ```

  Rate limit: 10 calls per session token lifetime. Log: access event (card_hash, timestamp) — no key material.

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Step 4`
- Done when: Returns correct `service_secret` for the authenticated card_hash; returns 403 for mismatched card_hash in token; rate limit enforced.

**Step 2.4 — Keyring update (post-recovery re-registration)**
- What: `PUT /accounts/{card_hash}/keyring` — replaces the holder's keyring blob after recovery re-registration. Authenticated with `masterCardSignatureAuth` (holder signs a challenge with recovered master card key). Stores the new blob under a new `keyring_id`, broadcasts it to the federation alongside a delete instruction for the previous `keyring_id` (Step 4.1a), and generates/returns a new `service_secret` (old one is invalidated).

  ```
  POST /accounts/{card_hash}/keyring/challenge
  Response: { challenge: "<32 random bytes, base64url>", expires_at: "<ISO8601>" }

  PUT /accounts/{card_hash}/keyring
  Body: {
    challenge: "<same value>",
    signature: "<ML-DSA-44 sig over challenge, base64url>",
    new_encrypted_keyring_blob: "<AES-GCM ciphertext, base64url>"
  }
  Response: { service_secret: "<new value, base64url>", keyring_id: "<keccak256 hex>" }
  ```

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 3 Steps 10–11`, `strategic-plan.md §OQ-WS-1`
- Done when: Valid master card signature → new `service_secret` issued, keyring blob replaced under a new `keyring_id`, delete-previous-version broadcast sent; old session tokens for this card invalidated; invalid signature → 401.

**⬥ Phase 2 Milestone Review**
- Context needed: Step 2.1–2.4 outputs; `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md`, `specs/process_specs/wallet_backup_and_recovery.md §Process 1 and §Process 3`; `plans/wallet-service/strategic-plan.md §Goal 1 Objectives`
- Done when: End-to-end test covers both acceptance paths: (new wallet) challenge → signed account creation → session token issued in the same response → service_secret retrieval; (existing wallet) WebAuthn passkey login → session token → service_secret retrieval → keyring update; for the `kms` backend, calls are confirmed auditable in AWS CloudTrail; no plaintext key material in logs; phase summary written to `plans/wallet-service/milestones/phase-2-summary.md`.

---

### Phase 3: Recovery Infrastructure (Backup Service)

**Goal:** Holders can register backup credentials; the 72-hour cancellation window runs reliably; key release works; notifications fire across all four channels.

---

**Step 3.1 — Backup registration**
- What: `POST /accounts/{card_hash}/backups` — stores a wrapped decryption key blob (synced passkey or YubiKey type), notification channels, and cancellation credential. The wallet never decrypts the wrapped blob.

  ```
  POST /accounts/{card_hash}/backups
  Authorization: Bearer {session_token}
  Body: {
    type: "synced_passkey" | "yubikey",
    wrapped_blob: "<AES-GCM ciphertext, base64url>",  -- opaque; wallet cannot decrypt
    keyring_id: "<keccak256 hex>",                    -- keyring_id to release alongside wrapped_blob
    notification_channels: {
      email?: "<address>",
      sms?: "<E.164 phone>",
      webhook?: "<https:// URL>",
      secondary_contact?: { name: string, email?: string, sms?: string }
    },
    cancellation_pubkey: "<ML-DSA-44 pubkey of master card key, base64url>"
  }
  Response: { backup_id: "<UUID>" }
  ```

  At least one notification channel is required.

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Steps 11–14`
- Done when: Backup registration stored in DB; `wrapped_blob` is opaque (no decrypt attempt); GET backup returns all fields except `wrapped_blob` (never returned after registration).

**Step 3.2 — Recovery initiation**
- What: `POST /accounts/{card_hash}/recovery` — initiates recovery for a specific backup registration. Creates a `recovery_window` record with `expires_at = now + 72 hours`. Immediately enqueues notification jobs for all four configured channels. No session token required (this is called by someone who may not have their device).

  ```
  POST /accounts/{card_hash}/recovery
  Body: { backup_id: "<UUID>" }
  Response: { recovery_id: "<UUID>", expires_at: "<ISO8601>", notified_channels: ["email", "sms", ...] }
  ```

  Rate limit: one active recovery window per backup registration at a time. A second `POST` while a window is active returns 409 with the existing `recovery_id`.

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 2a and 2b Steps 1–3`
- Done when: Recovery window created with correct `expires_at`; notification jobs enqueued within 5 seconds; rate limit enforced.

**Step 3.3 — Notification dispatch**
- What: Implement `NotificationWorker` — polls the job queue every 30 seconds. Dispatches to:
  - **Email:** via configurable transactional email provider (SendGrid default; interface allows swap). Template includes: timestamp, recovery method, cancellation instructions, cancellation code.
  - **SMS:** via Twilio (or configurable provider). Short-form notification with cancellation code.
  - **Webhook:** HTTP POST to the holder's configured URL with JSON payload containing recovery details.
  - **Secondary contact:** email/SMS to the registered secondary contact with a different template (third-party alert, not cancellation instructions).

  Job queue: use PostgreSQL `LISTEN/NOTIFY` with a `notification_jobs` table (not Redis — these must survive restarts since they're part of the 72-hour window integrity).

  ```sql
  notification_jobs (
    id              UUID PRIMARY KEY,
    recovery_id     UUID REFERENCES recovery_windows(id),
    channel         TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT DEFAULT 'pending',
    attempts        INT DEFAULT 0,
    next_attempt_at TIMESTAMPTZ DEFAULT now(),
    sent_at         TIMESTAMPTZ
  );
  ```

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 2a Steps 2–3`
- Done when: Integration test (with stubbed email/SMS providers) confirms all four channels receive notifications within 60 seconds of recovery initiation; failed dispatch retried with exponential backoff; sent_at recorded.

**Step 3.4 — Cancellation handling**
- What: `POST /recovery/{recovery_id}/cancel` — accepts a cancellation signed by the master card key. Verifies the ML-DSA-44 signature against the `cancellation_pubkey` registered with the backup. If valid: marks `recovery_window.status = 'cancelled'`, enqueues cancellation confirmation notifications to all channels.

  ```
  POST /recovery/{recovery_id}/cancel
  Body: {
    challenge: "<recovery_id as bytes, base64url>",   -- challenge = recovery_id
    signature: "<ML-DSA-44 sig over challenge, base64url>"
  }
  Response: { cancelled: true }
  ```

  Idempotent: second cancellation of an already-cancelled window returns 200.

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 2a Steps 4–5`, `strategic-plan.md §OQ-WS-6`
- Done when: Valid signature → status `cancelled`, confirmation notifications enqueued; invalid signature → 401; already-cancelled → 200 idempotent; test that cancellation after 72-hour expiry returns 410.

**Step 3.5 — Key release**
- What: `GET /recovery/{recovery_id}/release` — called by the device after the 72-hour window has elapsed. Checks `recovery_window.status == 'pending'` and `now() > expires_at`. If conditions met: marks status `released`, returns `wrapped_blob` and `keyring_id`.

  ```
  GET /recovery/{recovery_id}/release
  Response: {
    wrapped_blob: "<AES-GCM ciphertext, base64url>",
    keyring_id: "<keccak256 hex>"
  }
  ```

  The `wrapped_blob` and `keyring_id` are the only materials released. The holder's client then fetches the keyring blob itself by `keyring_id` from this or any other reachable wallet service in the federation (`GET /keyrings/{keyring_id}`, Step 4.1a) — the original primary service that issued it is not required to still be reachable. No `service_secret` is released (the holder gets a new `service_secret` in Phase 2, Step 2.4, after re-registering). Idempotent: a second call to a `released` window returns the same data.

- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 2a Steps 6`, `§Process 2b Steps 5`
- Done when: `GET /release` before 72 hours returns 425 Too Early with `retry_after` header; after 72 hours returns blob and CID; cancelled window returns 410.

**⚑ Clarification Checkpoint CP-2: Before any real recovery data is stored in production**

Review the complete backup registration and cancellation flow with a security-focused colleague before any production data is stored. Specifically: confirm that the 72-hour timer is based on server-side `expires_at` only (not client-provided), that `wrapped_blob` is never logged, and that the cancellation challenge cannot be replayed across different recovery windows.

**⬥ Phase 3 Milestone Review**
- Context needed: Step 3.1–3.5 outputs; `specs/process_specs/wallet_backup_and_recovery.md §Key Security Properties` table; `strategic-plan.md §Goal 2 Objectives`
- Done when: Full recovery flow tested end-to-end: registration → initiation → notification → cancellation (valid + invalid) → key release (before and after window); security properties table from spec verified against implementation; phase summary written to `plans/wallet-service/milestones/phase-3-summary.md`.

---

### Phase 4: Message Routing and Queue

**Goal:** Wallet service accepts inbound routed messages, queues them per sub-card, and persists until cleared by relay.

**Revised mid-phase:** Steps 4.3 and 4.4 originally specified UMBRAL proxy re-encryption at the wallet service. That was replaced with sender-side per-sub-card encryption (`process_specs/message_routing.md` v0.4) — the sender resolves the recipient's current sub-card list from the storage contract and sends one independently-encrypted routing envelope per sub-card, so the wallet service never re-encrypts anything and never holds re-encryption key material. This removed both a key-custody question and a dependency problem: the only available UMBRAL implementation (`@nucypher/umbral-pre`) is GPL-3.0-only, which would have been a real licensing blocker. See Steps 4.2-4.4 below for the resulting (simpler) design.

---

**Step 4.1 — Routing table and binding announcements**
- What: Implement `CardBindingAnnouncement` handling:
  - `POST /bindings/announce` — receives signed announcement from a peer wallet service. Verifies signature (`wallet_service` role: verify `keccak256(public_key) == wallet_service_id`). Applies conflict resolution rules. Updates `routing_table`.
  - `GET /bindings` — returns current routing table as a list of signed announcement objects (for startup sync by peers).
  - `broadcastAnnouncement(announcement)` — called internally when a card registers or migrates; fans out to all configured peers.
  - Nonce cache: prune `routing_nonces` records older than 24 hours (weekly background job).
- Who: Claude
- Context needed: `specs/process_specs/message_routing.md §Wallet Service Registry`, `§Binding Conflict Resolution`, `§Startup Sync`
- Done when: Peer can call `POST /bindings/announce`, receive update in routing table; conflicting announcements resolve correctly per spec rules; `GET /bindings` returns full table; broadcast reaches all configured peers.

**Step 4.1a — Keyring blob replication and deletion**
- What: Implement federation-wide keyring replication per `ARCHITECTURE.md` ADR-009-AMEND and `wallet_backup_and_recovery.md §Keyring Storage and Replication`. Rides the same peer-broadcast mechanism as `CardBindingAnnouncement` (Step 4.1):
  - `POST /federation/keyrings` — receives a signed `{ keyring_id, card_hash, encrypted_blob }` from a peer wallet service (signature: peer's `wallet_service` role key, same verification as binding announcements). Stores the blob in `keyring_blobs` keyed by `keyring_id`. Idempotent — re-receiving the same `keyring_id` is a no-op.
  - `POST /federation/keyrings/delete` — receives a signed `{ keyring_id }` delete instruction from a peer. Deletes the corresponding `keyring_blobs` row. Idempotent — deleting an already-absent `keyring_id` returns success.
  - `GET /keyrings/{keyring_id}` — holder-facing endpoint (called during recovery, Step 3.5) returning `{ encrypted_blob }` for a `keyring_id` this instance holds a replica of, regardless of whether the requesting holder's primary service is this instance. 404 if not held locally.
  - `broadcastKeyring(keyring_id, card_hash, encrypted_blob)` and `broadcastKeyringDelete(keyring_id)` — called internally by Steps 2.2 and 2.4 whenever a keyring is created or rotated; fan out to all configured peers, same fanout list as `broadcastAnnouncement`.
- Who: Claude
- Context needed: `specs/ARCHITECTURE.md §ADR-009-AMEND`, `specs/process_specs/wallet_backup_and_recovery.md §Keyring Storage and Replication`, Step 4.1 (peer auth pattern to reuse)
- Done when: Creating an account on instance A replicates the keyring blob to instance B within the same latency bound as a binding announcement; instance B's `GET /keyrings/{keyring_id}` serves the blob without instance A being reachable; rotating the keyring on instance A causes instance B to delete its replica of the previous `keyring_id`; a holder can complete recovery (Step 3.5 → `GET /keyrings/{keyring_id}`) against a wallet service that was never their primary.

**Step 4.2 — Inbound message receipt**
- What: `POST /messages` — accepts routed message envelopes from peer wallet services. Each envelope is already addressed to one specific sub-card and already encrypted to that sub-card's key by the sender (`message_routing.md` v0.4 §Sender-Side Fan-out) — the wallet service performs no cryptographic transform. Validates that `to` (card hash) is held by this wallet service. Stores payload in `message_queue`, scoped to `subcard_hash`. Returns 202 Accepted. Returns 410 Gone with correct redirect if card has migrated.

  ```
  POST /messages
  Body: {
    to:           "<card hash, hex>",
    subcard_hash: "<keccak256(subcard_pubkey), hex — which registered device this copy is for>",
    payload:      "<ML-KEM encrypted SignedMessageEnvelope, base64url, encrypted to this subcard's key>"
  }
  Response: 202 Accepted
  ```

  The payload is opaque — wallet service does not decrypt it and holds no key material that could. No sender information is stored or logged beyond what is in the routing header (`to`, `subcard_hash`).

- Who: Claude
- Context needed: `specs/process_specs/message_routing.md §Routing Envelope`, `§Delivery Flow`
- Done when: Message stored in `message_queue` with correct `card_hash` and `subcard_hash`; unknown card → 404; migrated card → 410 with redirect; payload stored as-is (no decryption attempt).

**Step 4.3 — Sub-card registration — RESOLVED, folded into Phase 5**

Originally specified as `POST /accounts/{card_hash}/subcards` registering a sub-card's UMBRAL re-encryption key. With re-encryption removed, there is nothing left for the wallet service to store about a sub-card beyond its UUID delivery pool — which Phase 5 Step 5.1 (`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`) already covers. No separate sub-card registration endpoint exists; a device becomes able to receive messages the moment it registers its first UUID batch.

The unlinkability constraint this step originally called out still applies and is now enforced at Step 5.1 instead: the wallet service MUST NOT be able to determine which cards are held on which devices. `subcard_hash` is opaque — stored for UUID pool and message-queue routing, but never logged, correlated, or exposed in combination with any device-identifying signal (IP address, session token lineage, timing correlation).

**Step 4.4 — Per-device delivery fan-out**
- What: After inbound message receipt (Step 4.2), deliver the message to its target sub-card: pop the next UUID from that subcard's pool in `uuid_pools`, call the relay `POST /deliver/{uuid}` with the payload unchanged from the routing envelope (no re-encryption — it was already encrypted to this exact sub-card by the sender). Retain message in `message_queue` until `DELETE /messages/{uuid}` is received. On 404 or 410 from relay: advance to the next UUID in that subcard's pool. On 5xx/network error: advance to the next UUID rather than retrying the same one (a fresh UUID is cheap and plentiful; Phase 5's re-registration/retransmission path is the better fit for a sustained relay outage than burning through one sub-card's pool on retries).

  Since each arriving envelope already names its one target sub-card (Step 4.2), there is no per-card fan-out loop at the wallet — "fan-out" happens at the sender, which already sent N independent envelopes for N sub-cards. Each delivery here is independent and synchronous within the `POST /messages` request handler; no background worker or `LISTEN/NOTIFY` polling is needed for this step (unlike Step 3.3's notification retries, a failed delivery here doesn't need scheduled retry — Phase 5's UUID re-registration path already re-delivers any uncleared message when a device comes back).

- Who: Claude
- Context needed: `specs/process_specs/message_routing.md §Relay Delivery and Multi-Device Fan-out`, `specs/process_specs/notification_relay.md §Process 2`, `specs/object_specs/relay.md §7.2`
- Done when: End-to-end test: inbound message → ciphertext delivered to relay within 500ms; two independently-addressed sub-card envelopes for the same card both deliver independently; relay 404/410 → next UUID used; message retained in queue until DELETE arrives.

**Step 4.5 — Message clearance endpoint**
- What: `DELETE /messages/{uuid}` — called by the relay (staggered, 0–6 hours after device pickup). Finds the message queue entry associated with this UUID and marks it cleared.

  ```
  DELETE /messages/{uuid}
  Response: 200 (cleared) | 404 (already cleared or unknown UUID)
  ```

- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Process 6`, `specs/object_specs/relay.md §7.2`
- Done when: DELETE clears the correct message; double-DELETE returns 404; unknown UUID returns 404.

**⬥ Phase 4 Milestone Review**
- Context needed: Step 4.1–4.5 outputs; `specs/process_specs/message_routing.md §What Wallet Services Observe`; `strategic-plan.md §Goal 3 Objectives` (privacy/unlinkability)
- Done when: Privacy audit: confirm no logs link UUID, message content, or subcard_hash to a device identity; routing table conflict resolution tested with out-of-order announcements; phase summary written to `plans/wallet-service/milestones/phase-4-summary.md`.

---

### Phase 5: UUID Management

**Goal:** Devices can register and replenish UUID pools; wallet service delivers and retransmits correctly.

---

**Step 5.1 — UUID pool registration**
- What: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` — device registers a batch of UUIDs for this subcard. Stores in `uuid_pools`. No authentication required beyond valid card_hash (unlinkable by design — device does not authenticate its identity here). UUIDs expire after 30 days.

  ```
  POST /cards/{card_hash}/subcards/{subcard_hash}/uuids
  Body: {
    uuids: ["<uuid>", ...]
  }
  Response: 204 No Content
  ```

  On receiving new UUIDs: check `message_queue` for uncleared messages for this card. If any exist, immediately re-encrypt and enqueue them for delivery to the new UUIDs for this subcard (retransmission after relay restart).

- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Process 1 Steps 6–7`, `§UUID Pools and Device Credential`, `specs/process_specs/message_routing.md §UUID Re-registration and Retransmission`
- Done when: UUIDs stored with correct expiry; retransmission triggered on new registration when uncleared messages exist; device cannot look up another subcard's UUIDs.

**Step 5.2 — UUID pool deregistration**
- What: `DELETE /cards/{card_hash}/subcards/{subcard_hash}` — device removes its UUID pool for a subcard (e.g., on app uninstall or card removal). Marks all UUIDs for this subcard as consumed.

  ```
  DELETE /cards/{card_hash}/subcards/{subcard_hash}
  Response: 204 No Content
  ```

- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Multi-Device Support`
- Done when: UUID pool deleted; subsequent message delivery to this subcard finds no UUIDs available; 404 if subcard not registered.

**Step 5.3 — UUID expiry cleanup**
- What: Background job runs nightly: delete `uuid_pools` records where `expires_at < now()` and `consumed = true`. Log count of pruned records per card (no subcard-level logging — aggregate only).
- Who: Claude
- Context needed: none
- Done when: Job runs without error; expired UUIDs removed; non-expired UUIDs untouched.

**⬥ Phase 5 Milestone Review**
- Context needed: Step 5.1–5.3 outputs; `specs/process_specs/notification_relay.md §Registration Privacy`
- Done when: UUID registration and retransmission tested end-to-end including relay restart scenario; privacy property confirmed (wallet logs do not link device_key to card_hash in a correlatable way); phase summary written to `plans/wallet-service/milestones/phase-5-summary.md`.

---

### Phase 6: Hardening and Validation

**Goal:** Rate limiting, audit logging, federation validation (single-peer test), load baseline, and pre-production security review.

---

**Step 6.1 — Rate limiting**
- What: Apply rate limits to sensitive endpoints:
  - `POST /accounts` — 5 per IP per hour
  - `POST /accounts/{card_hash}/recovery` — 3 per card per 24 hours
  - `POST /cards/{card_hash}/devices/{device_key}/uuids` — 100 UUIDs per device_key per 24 hours
  - `GET /accounts/{card_hash}/service-secret` — 10 per session token lifetime
  - `POST /bindings/announce` — 100 per peer per minute
  Implement using sliding window counters via Nitro's `storage` abstraction (same KV-backed driver as session revocation, Step 1.4 — no standalone Redis dependency). Return `429 Too Many Requests` with `Retry-After` header.
- Who: Claude
- Context needed: none
- Done when: Each limit triggers correctly in load test; `Retry-After` header is accurate.

**Step 6.2 — Audit logging**
- What: Structured JSON logs (no plaintext key material) for:
  - `service_secret` created (card_hash, timestamp)
  - `service_secret` accessed (card_hash, timestamp, session_token_id)
  - Backup registration created (card_hash, type, backup_id)
  - Recovery initiated (card_hash, recovery_id, timestamp)
  - Recovery cancelled (recovery_id, timestamp)
  - Recovery key released (recovery_id, timestamp)
  - Binding announcement accepted/rejected (card_hash, peer_wallet_id, outcome)
  Log level: `INFO` for all above; `WARN` for rejected announcements and rate limit hits; `ERROR` for `SecretsBackend` failures.

  **Explicit prohibitions — the following MUST NOT appear in any log, metric, trace, or database record:**
  - IP addresses or any network identifier associated with a device IO request (inbound messages, UUID registration, sub-card registration)
  - Session tokens in log fields (only session_token_id — a non-reversible hash — is permitted)
  - Any data that links a `device_key` to a `card_hash` in a single log line or queryable field
  - Any data that links a `subcard_hash` to a `device_key`, IP, or session
  - Request/response bodies for any device-facing endpoint (headers may be logged only if stripped of Authorization values)
  - Timing data fine-grained enough to correlate device check-in patterns to card activity

  **The wallet service must not be able to determine which cards are held on which devices.** This is a hard architectural invariant, not a best-effort privacy measure. Any instrumentation, debugging tool, admin endpoint, or monitoring query that would reconstruct this mapping is prohibited. If an operator needs to debug delivery failures, they must do so through aggregate metrics (e.g., delivery success rate per card, not per device).

- Who: Claude
- Context needed: `strategic-plan.md §Goal 3`, `strategic-plan.md §Goal 5`
- Done when: Audit events appear in structured log output; grep on log output confirms zero plaintext key material; automated log-schema test asserts that no device IO endpoint emits IP, request body, or device-correlating fields; log schema documented.

**Step 6.3 — Federation smoke test**
- What: Stand up two wallet service instances (two `node-server` preset processes — or two local `wrangler dev` instances for the Cloudflare preset — sharing a PostgreSQL instance). Register a card on instance A. Send a message from instance B. Confirm message appears in instance A's queue and is delivered to the relay. Test card migration announcement between instances.
- Who: Claude + user validation
- Context needed: `specs/process_specs/message_routing.md`, Phase 4 step outputs
- Done when: Cross-instance message delivery works; `410 Gone` redirect works after migration announcement.

**Step 6.4 — Load baseline**
- What: Run a load test (k6 or autocannon) against the message delivery path: 100 concurrent clients each sending 10 messages/second for 60 seconds. Measure: p50/p95/p99 latency for `POST /messages` → relay delivery; memory and CPU under load; any `SecretsBackend` throttling events (relevant mainly if `SECRETS_BACKEND=kms`, which is subject to AWS KMS rate limits — the default `WebCryptoBackend` has no external rate limit).
- Who: Claude
- Context needed: Phase 4 and 5 outputs
- Done when: p99 `POST /messages` → relay delivery < 500ms at 1000 req/s; no `SecretsBackend` throttling; no memory leak over 60-second run.

**⚑ Clarification Checkpoint CP-3: Pre-production security review**

Before any production deployment or real user data: conduct an independent review of (a) the 72-hour timer integrity (can it be manipulated via clock skew or direct DB access?), (b) the cancellation signature verification (is the ML-DSA-44 verification implementation correct?), (c) the deployed `SecretsBackend` configuration — for `WebCryptoBackend`, confirm the master key is a platform secret not committed or logged anywhere; for `KmsBackend`, confirm the KMS key policy restricts access to the wallet service identity only. **Block production launch on this review.**

**⬥ Phase 6 Milestone Review (Pre-Production Gate)**
- Context needed: All phase milestone summaries; `strategic-plan.md §Goals 1–5 Objectives`; security review findings
- Done when: All five goal objectives verified; security review complete with no open Critical or High findings; load baseline meets target; federation smoke test passes; operator runbook written (`docs/operations.md`); production deployment approved.

---

## Clarification Checkpoints Summary

| ID | Where | Trigger |
|---|---|---|
| CP-1 | Phase 2, Step 2.1 | **Resolved.** No external registration token exists; new-wallet auth is the master card key signing a challenge (Step 2.2), existing-wallet auth is WebAuthn passkey login (Step 2.1). Not a blocker for Phase 2 going forward. |
| CP-2 | Phase 3, Step 3.5 | Not a development blocker — security review of the 72-hour window, cancellation, and key release will happen separately, before any real recovery data is stored in production. |
| CP-3 | Phase 6, Step 6.4 | Confirmed as the pre-launch gate. Before any production deployment or real user data: independent security review. |

---

## Context Map

For a fresh agent starting any step, the minimum context to load is:

| Phase | Minimum context |
|---|---|
| Phase 1 | `specs/ARCHITECTURE.md`, `specs/process_specs/wallet_backup_and_recovery.md`, `specs/process_specs/notification_relay.md`, `specs/process_specs/message_routing.md` |
| Phase 2 | `plans/wallet-service/milestones/phase-1-summary.md`, `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md`, `specs/process_specs/wallet_backup_and_recovery.md §Process 1 and 3`, `plans/wallet-service/strategic-plan.md §Goal 1` |
| Phase 3 | `plans/wallet-service/milestones/phase-2-summary.md`, `specs/process_specs/wallet_backup_and_recovery.md §Process 2a, 2b, Security Properties`, `plans/wallet-service/strategic-plan.md §Goal 2` |
| Phase 4 | `plans/wallet-service/milestones/phase-3-summary.md`, `specs/process_specs/message_routing.md`, `specs/object_specs/relay.md`, `plans/wallet-service/strategic-plan.md §Goals 3 and 4` |
| Phase 5 | `plans/wallet-service/milestones/phase-4-summary.md`, `specs/process_specs/notification_relay.md §Process 1`, `specs/process_specs/message_routing.md §UUID Re-registration` |
| Phase 6 | All previous milestone summaries, `plans/wallet-service/strategic-plan.md §All Goals and Objectives` |
