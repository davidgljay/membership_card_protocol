# Wallet Service — Service Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-04
**Status:** Draft — describes the wallet service as implemented (`wallet-service/`, all six build phases complete). Production deployment remains blocked on an independent security review (`wallet-service/docs/security-review-cp3.md`); this spec describes current code behavior regardless of that gate.
**Source of truth:** Every claim in this document traces to `wallet-service/server/` or `wallet-service/src/` as of the review underlying `plans/wallet-service/spec-phase1-*.md`, cross-checked against the process specs it implements (`plans/wallet-service/spec-discrepancies.md`). Where the build plans (`plans/wallet-service/strategic-plan.md`, `implementation-plan.md`) described an earlier design the code has since moved past, this spec describes the current behavior only.

**Changelog (spec-consistency Phase 1):** Fixes #11–#13, #15, #29 — added §7.10 Matrix endpoints, `matrix_credentials` data model row, OQ-WALLET-6/7, and corrected the retired `client-sdk` reference to `app-sdk`. See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, Tier 3 item (g)):** §7.10's `POST /matrix/rooms` description now documents the load-bearing `m.room.join_rules: "public"` state event — omitted before this correction, though already present and tested in code. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 2):** Fix #52 — added §6.5.1 documenting cardholder-signature verification (including sub-card-chain resolution) for `card_migration`-type `CardBindingAnnouncement`s, and updated §7.5's `POST /bindings/announce` description to cite it. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, 2026-07-16):** Corrected Fix #52 — David confirmed migration is a master-card-key-only operation; the code (`wallet-service/src/federation/binding.ts`) never implemented the sub-card-chain path described in old §6.5.1, and that allowance should not have been added to the spec. Folded §6.5.1 back into §6.5 (now "Peer wallet-service and cardholder signatures") describing only the direct master-key check for the `cardholder` signer, and updated §7.5's cross-reference accordingly. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (j).

**Changelog (spec-consistency Phase 3, Tier 1 items 9–10):** §7.10 gains documentation for two already-implemented, previously-undocumented Matrix endpoints (`POST /matrix/token`, `PUT /matrix/transactions/{txnId}`); §5's migration count corrected from "8" to "10" (two Matrix migrations were added in Phase 1 but the count was never updated). See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Relationship to Existing Specs](#2-relationship-to-existing-specs)
3. [Actors](#3-actors)
4. [Privacy Properties](#4-privacy-properties)
5. [Data Model](#5-data-model)
6. [Authentication](#6-authentication)
7. [Endpoints](#7-endpoints)
   - 7.1 [Health](#71-health)
   - 7.2 [Account Creation and Login](#72-account-creation-and-login)
   - 7.3 [Keyring and Service Secret](#73-keyring-and-service-secret)
   - 7.4 [Backup Registration and Recovery](#74-backup-registration-and-recovery)
   - 7.5 [Federation and Routing](#75-federation-and-routing)
   - 7.6 [Message Routing](#76-message-routing)
   - 7.7 [Sub-card and UUID Lifecycle](#77-sub-card-and-uuid-lifecycle)
   - 7.8 [Admin](#78-admin)
   - 7.9 [Oblivious Transport (OHTTP)](#79-oblivious-transport-ohttp)
   - 7.10 [Matrix](#710-matrix)
8. [Error Codes](#8-error-codes)
9. [Open Questions](#9-open-questions)

---

## 1. Overview

The wallet service is the always-online server component a card holder's client relies on for keyring custody, recovery infrastructure, and message routing. It plays two roles defined in `process_specs/wallet_backup_and_recovery.md`:

- **Primary service** — holds each holder's `service_secret` (one half of the keyring decryption key: `decryption_key = KDF(device_passkey_output, service_secret)`), stores a replica of the holder's encrypted keyring blob keyed by `keyring_id = keccak256(encrypted_blob)`, and never sees wallet plaintext or the full decryption key. The keyring blob is stored using traditional, deletable storage — not IPFS (`ARCHITECTURE.md` ADR-009-AMEND) — and is broadcast to every other wallet service in the federation; every instance holds replicas for holders across the whole federation, not just its own.
- **Backup service** — stores wrapped decryption-key blobs (synced-passkey and/or YubiKey variants), manages the 72-hour recovery cancellation window, dispatches notifications across all configured channels, and releases key material after the window expires without a valid cancellation.

On top of keyring custody, the wallet service is the terminus for inbound message routing: it receives per-sub-card routing envelopes from peer wallet services, queues them, hands them to the relay for device delivery, and manages the UUID pools that make that delivery possible. It never decrypts message content, and — since `message_routing.md` v0.4 — never holds any key material capable of transforming ciphertext at all (the prior UMBRAL proxy re-encryption design was replaced by sender-side per-sub-card encryption before this service was built).

The wallet service also runs an OHTTP gateway (`specs/process_specs/oblivious_transport.md`) that lets a device reach any of the endpoints below without exposing its IP address to this service, by routing an HPKE-encapsulated request through the relay.

**What this service does not do:** card offer construction, press communication (the app-sdk talks to a press directly), chain verification at the routing layer, or relay service functions (message buffering, push delivery — that's `specs/object_specs/relay.md`, a separate service). On-device card operations (signing, key generation) stay on-device.

**Deployment model:** built on the [Nitro](https://nitro.unjs.io) server framework, one codebase targeting `cloudflare-module` (default), `node-server`, and `aws-lambda` presets. It is a stateless HTTP API plus one scheduled sweep task family (notification retries, nonce/UUID pruning) — see `wallet-service/docs/operations.md` for the operator-facing deployment reference this spec does not duplicate.

**Open scope question — open-offer hosting/claim-link serving is not implemented here.** `open_offer_creation.md` and `open_offer_acceptance_new_wallet.md` both describe the wallet service as hosting the signed open-offer document and serving a claim link (e.g. `https://<wallet-service>/claim/<offer-id>`); no such route exists in `wallet-service/server/routes/` as of this review (confirmed by search — no `offer`/`claim` route files). It is not yet determined whether this is a planned-but-unbuilt wallet-service feature or was intended to live on a different component (e.g. the press). Inbound targeted-offer delivery and the SCIP/audit-record delivery `card_offering_and_acceptance.md` steps 23–24 describe ("HTTPS to their wallet service endpoint") are not a separate gap — they are ordinary encrypted messages and are already covered by the generic `POST /messages` routing path (§7.6). See **OQ-WALLET-6**.

---

## 2. Relationship to Existing Specs

| Spec | Relationship |
|---|---|
| `specs/process_specs/wallet_backup_and_recovery.md` | Process-level spec for keyring custody, backup registration, and the two recovery flows (synced passkey, YubiKey) this service implements as the primary + backup service roles. |
| `specs/process_specs/message_routing.md` | Defines the routing envelope, the Wallet Service Registry (peer list, binding announcements, conflict resolution, startup sync), and delivery/retransmission behavior this service implements on the receiving side. |
| `specs/process_specs/notification_relay.md` | UUID pool lifecycle, sub-card registration/deregistration signed-envelope requirements, and the wallet-relay delivery/clearance contract this service implements on the wallet side. |
| `specs/process_specs/open_offer_acceptance_new_wallet.md` | New-holder wallet creation flow; this service's `POST /accounts` is the account-creation step in that flow. |
| `specs/process_specs/open_offer_acceptance_existing_wallet.md` | Existing-holder keyring update flow; this service's WebAuthn passkey login and `PUT /accounts/{card_hash}/keyring` implement its Step 6. |
| `specs/process_specs/card_migration.md` | Dual-signature migration protocol; this service implements the routing-table side (`POST /bindings/announce`, `410 Gone` handling) but not client-side migration initiation. **§6's "old wallet service" behavior on receiving a migration announcement (forwarding queued messages to the new wallet service, removing the card from its local store) is not confirmed as implemented — see OQ-WALLET-7.** |
| `specs/process_specs/subcard_creation_policy.md` | Defines on-chain sub-card revocation (`SubCardEntry.active`), which this service's sub-card UUID registration/deregistration endpoints deliberately do not consult (§6, §7.7). |
| `specs/subcards.md` | §Step 5 defines the on-chain-registry → IPFS → `recipient_pubkey` resolution chain this service's sub-card signed-envelope verification depends on. |
| `specs/process_specs/oblivious_transport.md` | Defines the OHTTP envelope, key-configuration discovery, and relay-forwarding protocol this service's `/ohttp/*` endpoints implement on the destination side. |
| `specs/object_specs/relay.md` | The relay this service calls (`POST /deliver/{uuid}`) and receives clearance calls from (`DELETE /messages/{uuid}`). Not a bridge or WebSocket peer — all communication is HTTPS in both directions. |
| `specs/messaging_protocol.md` | Defines `SignedMessageEnvelope`, encrypted end-to-end inside the routing envelope's opaque payload. |
| `specs/ARCHITECTURE.md` | ADR-009-AMEND (keyring storage, no IPFS); ADR-007 (transport, OHTTP precedent); the Wallet Service Registry and message-server design this service is the concrete implementation of. |
| `specs/object_specs/matrix_room.md` | Defines the room predicate document and the `POST /matrix/rooms` room-creation request/response shape this service implements (§7.10). |
| `specs/object_specs/matrix_synapse_module.md` | The Synapse policy module this service's Matrix subsystem provisions credentials and configuration for (§5 `matrix_credentials`); the module itself is not part of this service's own request-handling code. |
| `specs/object_specs/matrix_encryption.md` | Defines shadow-account derivation (`deriveMatrixUserId`) and sender-binding verification; this service provisions the shadow Matrix account (via the Application Service bridge) at room-creation/first-use time as described there. |
| `specs/process_specs/room_discovery.md` | Defines the room index (`GET /matrix/room-index`) and server-hosted discovery (`POST /matrix/discover-rooms`) this service implements (§7.10), plus the client-side discovery path that consumes the same index. |
| `specs/process_specs/matrix_join_attestation_and_revocation.md` | Defines the join-attestation and revocation flow the Synapse policy module implements; this service's only role in that flow is the one-time shadow-account provisioning and room creation, not join/post authorization, which never queries this service. |

---

## 3. Actors

| Actor | Role |
|---|---|
| **Holder device** | Card holder's client. Creates accounts, retrieves `service_secret`, registers backups, initiates/cancels recovery, registers UUID pools per sub-card. |
| **Peer wallet service** | Another operator's wallet-service instance. Exchanges binding announcements, keyring blob replicas, and routed messages over HTTPS. |
| **Relay** | Receives `POST /deliver/{uuid}` calls from this service; sends `DELETE /messages/{uuid}` clearance calls back. Never opens a persistent connection to this service. |
| **Operator (admin)** | Holds `ADMIN_API_KEY`. Reads aggregate operational state via `/admin/*` — never plaintext key material or device-correlating data. |
| **Notification providers** | Email (SendGrid-compatible), SMS (Twilio-compatible), webhook, secondary contact — dispatched to during recovery initiation/cancellation. |

---

## 4. Privacy Properties

The wallet service must not be able to determine which cards are held on which devices. This is an architectural invariant (not best-effort), enforced by a combination of design and (for two routes) an automated test:

| Party | Knows | Does not know |
|---|---|---|
| Wallet service | `card_hash`, `subcard_hash`, UUID(s) currently in each sub-card's pool, `keyring_id`, `service_secret` (envelope-encrypted at rest) | Device identity, push token, device credential, IP address of any device-facing request, which `subcard_hash`es belong to the same physical device |

Concretely:

- No log, metric, trace, database record, or admin endpoint may link a `device_key`, IP address, or session to a `card_hash` or `subcard_hash`. (There is no `device_key` concept at this layer at all — it was removed from the routing model in `message_routing.md` v0.3.)
- Device-facing I/O (inbound messages, UUID registration/deregistration) is not logged at the request/response level — only outcome events, stripped of network identifiers.
- `subcard_hash` is visible in the routing header (`message_routing.md v0.4 §What Wallet Services Observe` — a deliberate trade from removing UMBRAL re-encryption) but remains opaque and is never correlated to a device, IP, or session.
- `test/audit-log-schema.test.ts` statically enforces the no-IP/no-raw-body/no-subcard-hash-interpolation rules against files under `server/routes/messages/` and `server/routes/cards/`. **Known gap:** as of this review, the actual `console.info` calls for message receipt and sub-card UUID registration/deregistration live in `src/routes/messages-create.ts`, `src/routes/subcard-uuid-registration.ts`, and `src/routes/subcard-deregistration.ts` — outside the test's scanned directories. Manual review of all three confirms they log only `card_hash` and aggregate counts, never `subcard_hash`, IP, or session data — so the invariant currently holds, but the automated enforcement no longer covers where the logging code actually lives. Recommend extending the test's scan roots to include `src/routes/`.
- Federation and admin surfaces (`/federation/keyrings*`, `/admin/*`) are excluded from the device-correlation invariant by construction — they carry peer-wallet-service or operator identity, not device identity, and admin responses are keyed by `card_hash`/`subcard_hash` only, never joined against anything device-identifying.

---

## 5. Data Model

PostgreSQL, schema managed via `node-pg-migrate` (`server/db/migrations/`, 10 migrations applied in sequence — the original 8 plus two Matrix-related migrations added in this initiative's Phase 1). Current state:

### `holder_accounts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `card_hash` | text, unique, not null | `keccak256(card_pubkey)` |
| `master_pubkey` | text, not null | ML-DSA-44 pubkey, base64url |
| `keyring_id` | text, not null | Lookup key into `keyring_blobs` (no hard FK) |
| `service_secret_enc` | text, not null | AES-256-GCM ciphertext |
| `service_secret_dek_enc` | text, not null | Envelope-encrypted DEK (§6.4) |
| `webauthn_credential_id` | text, nullable | Unique when non-null |
| `webauthn_public_key` | text, nullable | COSE public key, base64url |
| `webauthn_sign_count` | bigint, not null, default 0 | Replay protection |
| `created_at` | timestamptz | |

### `keyring_blobs`

`keyring_id` (PK, text = `keccak256(encrypted_blob)`), `card_hash` (indexed), `encrypted_blob` (opaque ciphertext), `received_at`. A row may belong to a holder served by this instance or any peer in the federation — full replication, no distinction made on read. Insert is `ON CONFLICT (keyring_id) DO NOTHING` (idempotent); delete of an absent `keyring_id` is a no-op (idempotent).

### `backup_registrations`

`id` (PK), `holder_id` (FK → `holder_accounts`, `ON DELETE CASCADE`), `type` (`synced_passkey` | `yubikey`), `wrapped_blob` (opaque ciphertext — never decrypted by this service), `notification_channels` (jsonb: `email`, `sms`, `webhook`, `secondary_contact`), `cancellation_pubkey` (ML-DSA-44 pubkey — the holder's master card key), `keyring_id` (text — the `keyring_id` this registration can unwrap to, independent of the account's *current* `keyring_id`, since recovery may be initiated against an older registration), `created_at`.

### `recovery_windows`

`id` (PK), `backup_reg_id` (FK → `backup_registrations`), `initiated_at`, `expires_at` (= `initiated_at` + 72 hours), `status` (`pending` | `cancelled` | `released`), `cancelled_at`, `released_at`.

### `message_queue`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `card_hash` | text, not null | |
| `subcard_hash` | text, nullable | Which registered sub-card this copy is for; nullable only for rows predating the sender-side-encryption change, always set on new rows |
| `payload` | text, not null | Opaque ciphertext — already encrypted to the target sub-card's key by the sender |
| `received_at` | timestamptz | |
| `cleared` | boolean, default false | |
| `cleared_at` | timestamptz, nullable | |
| `delivery_uuid` | uuid, nullable | Most recent relay UUID this row was handed to; `DELETE /messages/{uuid}` looks up by this column |

Indexes: `(card_hash, cleared)`, `(card_hash, subcard_hash, cleared)`, `delivery_uuid`.

### `uuid_pools`

`uuid` (PK), `card_hash`, `subcard_hash` (opaque, `keccak256(subcard_pubkey)`), `consumed` (bool), `registered_at`, `expires_at` (= `registered_at` + 30 days). Index: `(card_hash, subcard_hash, consumed)`.

### `routing_table`

`card_hash` (PK), `wallet_service_id`, `endpoint`, `type` (`card_registration` | `card_migration`), `announced_at`, `nonce` (unique), `signatures` (jsonb — the original announcement envelope's signature array, so `GET /bindings` can re-serve independently verifiable envelopes, not just resolved fields).

### `routing_nonces`

`nonce` (PK), `seen_at` — federation-wide replay cache for binding announcements, pruned on a rolling 24-hour window.

### `kv_store`

`key` (PK), `value` (jsonb), `expires_at` — Postgres-backed fallback for Nitro's `storage()` abstraction on `node-server`/`aws-lambda` presets (session revocation, rate-limit counters). The `cloudflare-module` preset uses a Cloudflare KV binding instead.

### `auth_challenges`

`id` (PK), `purpose` (`account_creation` | `passkey_login` | `keyring_rotation`), `card_hash` (nullable — null for `account_creation`, issued before the account exists), `challenge`, `expires_at`, `consumed`, `created_at`. Index: `(card_hash, purpose)`. Shared single-use challenge store for all three challenge/response auth flows (§6.1).

### `notification_jobs`

`id` (PK), `recovery_id` (FK → `recovery_windows`, `ON DELETE CASCADE`), `channel` (`email` | `sms` | `webhook` | `secondary_contact_email` | `secondary_contact_sms`), `payload` (jsonb), `status` (`pending` | `sent` | `failed`), `attempts`, `next_attempt_at`, `sent_at`, `created_at`. Indexes: `(status, next_attempt_at)`, `recovery_id`.

### `subcard_action_nonces`

`subcard_hash`, `nonce`, `action` (`register` | `deregister`), `seen_at`. PK: `(subcard_hash, action, nonce)`. Replay protection for the two sub-card signed-envelope endpoints (§7.7), scoped per sub-card and per action so registration and deregistration nonces never collide.

### `matrix_credentials`

Audit-trail table for the Matrix-subsystem credentials generated by the Matrix bring-up scripts (Synapse's signing key and `registration_shared_secret`, the watcher's Synapse login credential, and the membership registry's encryption key). Not consumed at runtime by this service — the consumers (the `synapse` container / Python policy-module process) read the raw material directly from a mounted file; this table exists purely as an audit/recovery/rotation record, mirroring the envelope-encryption pattern already used for `holder_accounts.service_secret_enc`.

| Column | Type | Notes |
|---|---|---|
| `credential_name` | text PK | e.g. `synapse_signing_key`, `synapse_registration_shared_secret` |
| `ciphertext` | text, not null | AES-256-GCM ciphertext of the raw credential (`SecretsService`) |
| `dek_enc` | text, not null | Envelope-encrypted DEK (`SecretsService`) |
| `key_file_path` | text, not null | Where the raw material was actually written, for whichever process reads it directly |
| `description` | text, not null | |
| `created_at` | timestamptz, not null | |
| `rotated_at` | timestamptz, nullable | Set on every re-generation after the first |

### Historical: `reencryption_keys` (removed)

Created in the initial schema to hold per-sub-card UMBRAL proxy re-encryption keys in plaintext. Dropped when `message_routing.md` v0.4 replaced wallet-side re-encryption with sender-side per-sub-card encryption — the wallet service no longer holds any re-encryption key material, and this table no longer exists.

---

## 6. Authentication

### 6.1 Master card key signature

Holder signs a server-issued challenge (or, for cancellation, the `recovery_id`'s own bytes) with their ML-DSA-44 master card key. Verified against `master_pubkey` (account creation, keyring rotation) or `cancellation_pubkey` (recovery cancellation — currently always the master card key; no other cancellation credential type is implemented).

Used by: `POST /accounts`, `PUT /accounts/{card_hash}/keyring`, `POST /recovery/{recovery_id}/cancel`.

### 6.2 Session token

HMAC-SHA256 over `{ card_hash, issued_at, expires_at }`, 15-minute TTL, format `base64url(payload).base64url(hmac)`. Issued directly in the response to `POST /accounts` (new wallet) or `POST /auth/passkey/login` (existing wallet) — no separate login step needed after either.

Revocation: single-token revoke (keyed by `sessionTokenId` = `sha256(token)`, never the raw token) and a per-`card_hash` bulk cutoff (`sessionMinIssuedAt`) used by keyring rotation to invalidate every session issued before the rotation without enumerating them.

Used by: `GET /accounts/{card_hash}/service-secret`, `POST /accounts/{card_hash}/backups`, `GET /accounts/{card_hash}/backups/{backup_id}`.

### 6.3 WebAuthn passkey login

Verifies a WebAuthn authentication assertion against the credential registered at account creation. Enforces a monotonically increasing sign count (one exception: a stored counter of exactly 0 is treated as "never incremented," not a replay). Used only for the existing-wallet path — new-wallet creation registers the passkey credential in the same call as account creation (§7.2), never verifies one.

Used by: `POST /auth/passkey/login`.

### 6.4 Sub-card signed envelope (registration and deregistration)

Proves control of a sub-card's private key without authenticating device identity. The wallet service resolves the sub-card's public key via the on-chain registry (`getSubCardEntry`) → IPFS fetch (`sub_card_doc_cid` → `SubCardDocument.recipient_pubkey`) — `specs/subcards.md §Step 5` — confirms `keccak256(pubkey) == subcard_hash`, then verifies an ML-DSA-44 signature over `canonicalize(payload)`. Deliberately does **not** check `SubCardEntry.active`: on-chain revocation (`subcard_creation_policy.md`'s 8xx/9xx flow) and this service's local UUID-pool bookkeeping are independent by design, so a merely-deregistered (e.g., reinstalled-app) sub-card can always resume receiving messages by re-registering, without being conflated with a genuinely revoked one.

Additional replay protection layered on top (checked in the route logic, not the signature-verification functions themselves): a ±5-minute timestamp window, a nonce scoped to `(subcard_hash, action)`, and a path/payload param match (the envelope's `card_hash`/`subcard_hash` must match the URL).

Used by: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`, `DELETE /cards/{card_hash}/subcards/{subcard_hash}`.

### 6.5 Peer wallet-service and cardholder signatures

A peer's `wallet_service_id` is `keccak256(peer_public_key)`. Verification confirms both that the claimed public key hashes to the claimed id and that the message is validly ML-DSA-44-signed by that key. Two independent verification functions implement this pattern for two different message types: `verifyAnnouncementEnvelope` (`src/federation/binding.ts`) for binding announcements, and `verifySignedKeyringMessage` (`src/federation/keyring-sync.ts`) for keyring blob replication/delete messages.

A `card_migration`-type `CardBindingAnnouncement` (`process_specs/card_migration.md §3/§5`) carries two signatures, not one: alongside the peer wallet-service signature above, `verifyAnnouncementEnvelope` also verifies a `cardholder`-role signer over the same canonical RFC 8785 JSON payload. This second signature is mandatory for `card_migration` announcements — an envelope with a valid `wallet_service` signature but a missing or invalid `cardholder` signature is rejected. Verification requires the `cardholder` entry's `public_key` to resolve directly to the payload's `card_hash` (`keccak256(public_key) == card_hash`); there is no sub-card-chain path for this signer — migration is a master-card-key-only operation. `card_registration`-type announcements carry only the `wallet_service` signature.

Used by: `POST /bindings/announce`, `POST /federation/keyrings`, `POST /federation/keyrings/delete`.

### 6.6 Admin bearer token

A single operator-configured `ADMIN_API_KEY`, compared using a timing-safe comparison. Gates all `/admin/*` endpoints only — not used by any holder- or peer-facing endpoint.

---

## 7. Endpoints

Unless noted, request/response bodies are JSON.

### 7.1 Health

**`GET /health`** — No auth. Checks Postgres reachability and exercises a full encrypt/decrypt round-trip against the configured `SecretsBackend`. Returns `{ status: "ok" | "degraded", postgres: "ok" | "error", secrets: "ok" | "error" }`; `503` if either check fails.

### 7.2 Account Creation and Login

**`POST /accounts/challenge`** — No auth. Rate limit: 5 per hashed IP per hour. Issues a random challenge for account creation. Response: `{ challenge, expires_at }`.

**`POST /accounts`** — Authenticated by the freshly generated master card key signing the challenge from the call above (proves control of the key being registered — there is no separate registration token; the wallet service is the sole driver of the new-wallet acceptance flow, per `open_offer_acceptance_new_wallet.md`). Shares the same rate limit bucket as the challenge call.

Request: `{ challenge, signature, card_hash, master_pubkey, webauthn_credential_id, webauthn_public_key, encrypted_keyring_blob }`. Registers the WebAuthn credential in the same call (no separate registration endpoint). Generates a 256-bit `service_secret`, envelope-encrypts it, computes `keyring_id = keccak256(encrypted_keyring_blob)`, stores the blob, and broadcasts it to the federation.

Response: `{ service_secret, account_id, keyring_id, session_token, expires_at }`. `409` if an account or credential already exists for this `card_hash`.

**`POST /auth/passkey/challenge`** — No auth. Rate limit: 20 per `card_hash` per hour. Response: `{ challenge, credential_id, expires_at }`. `404` if no account/credential exists for the `card_hash`.

**`POST /auth/passkey/login`** — Verifies a WebAuthn assertion against the registered credential (§6.3). Request: `{ card_hash, challenge, assertion }`. Response: `{ session_token, expires_at }`.

### 7.3 Keyring and Service Secret

**`GET /accounts/{card_hash}/service-secret`** — Session token, must match the path's `card_hash` (`403` otherwise). Rate limit: 10 calls per session token lifetime. Decrypts and returns `service_secret`. Response: `{ service_secret }`.

**`POST /accounts/{card_hash}/keyring/challenge`** — No auth (the account must exist). Response: `{ challenge, expires_at }`.

**`PUT /accounts/{card_hash}/keyring`** — Master card key signs the challenge above. Replaces the keyring blob under a new `keyring_id`, broadcasts it to the federation alongside a delete instruction for the superseded `keyring_id`.

Request: `{ challenge, signature, new_encrypted_keyring_blob, rotate_service_secret? }` (`rotate_service_secret` defaults `true`).

- `rotate_service_secret: true` (default): mints a new `service_secret`, invalidates every session token previously issued for this `card_hash`. This is the behavior used for genuine recovery re-registration.
- `rotate_service_secret: false`: replaces the keyring blob and `keyring_id` but leaves the existing `service_secret` untouched and echoes it back unchanged, without invalidating sessions. This exists because a client that has already encrypted `new_encrypted_keyring_blob` under the account's *current* `service_secret` needs a way to install that exact blob without a second, uninvited rotation displacing the secret it was encrypted under from underneath it. Both the initial finalize call right after `POST /accounts` and the second call in a recovery re-registration sequence (after a first, provisional `PUT` that does rotate) use `rotate_service_secret: false`.

Response: `{ service_secret, keyring_id }`.

### 7.4 Backup Registration and Recovery

**`POST /accounts/{card_hash}/backups`** — Session token, matching `card_hash`. Request: `{ type: "synced_passkey" | "yubikey", wrapped_blob, keyring_id, notification_channels, cancellation_pubkey }`. At least one notification channel required. The wallet service never attempts to decrypt `wrapped_blob`. Response: `{ backup_id }`.

**`GET /accounts/{card_hash}/backups/{backup_id}`** — Session token, matching `card_hash`. Returns every field except `wrapped_blob` (only ever released to the holder at registration time, and to the recovering device at key release).

**`POST /accounts/{card_hash}/recovery`** — No auth (the point of recovery is that the holder may not have their device). Rate limit: 3 per `card_hash` per 24 hours. Request: `{ backup_id }`. Creates a 72-hour `recovery_window` and immediately fans out notifications to every configured channel. A second call while a window is already active returns `409` with the existing `recovery_id`/`expires_at` rather than creating a new one.

**`POST /recovery/{recovery_id}/cancel`** — Request: `{ challenge, signature }`, where `challenge` is the `recovery_id`'s own bytes and `signature` is an ML-DSA-44 signature over them, verified against the backup registration's `cancellation_pubkey`. Idempotent (a second cancellation of an already-cancelled window returns `200`). `410` if the window is no longer cancellable (already released, or past the window).

**`GET /recovery/{recovery_id}/release`** — No auth (the recovery window itself, once past its 72-hour mark with no cancellation, is the authorization). `425 Too Early` with a `Retry-After` header before the window closes; `410` if the window was cancelled. Once released, returns `{ wrapped_blob, keyring_id }` and is idempotent on repeat calls. The holder's client then fetches the keyring blob itself by `keyring_id` from any reachable wallet service in the federation (§7.5) — the original primary service need not still be reachable. No `service_secret` is released here; a new one is issued during re-registration (`PUT /accounts/{card_hash}/keyring`, §7.3).

### 7.5 Federation and Routing

**`POST /bindings/announce`** — Peer wallet-service signature (§6.5); for `card_migration`-type announcements, also the cardholder signature (§6.5). Receives a `CardBindingAnnouncement` envelope, verifies signatures, checks the nonce hasn't been replayed, applies `message_routing.md §Binding Conflict Resolution`, and updates the local routing table if accepted. Rate limit: 100 per verified peer per minute, applied only after signature verification succeeds (so an unverified claimed identity can't be used to rate-limit a victim peer). Response: `{ applied: boolean }`.

**`GET /bindings`** — No auth (federation peers need this for startup sync by design). Returns the full routing table as a list of signed `CardBindingAnnouncement` envelopes.

**`POST /federation/keyrings`** — Peer wallet-service signature. Receives `{ payload: { keyring_id, card_hash, encrypted_blob }, ... }`, stores the replica. Idempotent (`ON CONFLICT DO NOTHING`).

**`POST /federation/keyrings/delete`** — Peer wallet-service signature. Receives `{ payload: { keyring_id }, ... }`, deletes the local replica. Idempotent (deleting an absent row succeeds).

**`GET /keyrings/{keyring_id}`** — No auth. Holder-facing replica lookup, called during recovery. Serves any `keyring_id` this instance holds a replica of, regardless of whether the requesting holder's primary service is this instance — that is the entire point of federation-wide replication. `404` if not held locally.

### 7.6 Message Routing

**`POST /messages`** — No auth (peer-to-peer wallet-service traffic; the routing envelope's authenticity is not independently checked at this layer — see §9 for the resulting open question). Request: `{ to, subcard_hash, payload }`, where `payload` is already encrypted to the target sub-card's key by the sender (`message_routing.md v0.4 §Sender-Side Fan-out`) and is opaque to this service. If `to` is unknown, `404`. If `to` has migrated to a peer, returns `410` with `{ error: "card_migrated", wallet_service_id, endpoint }` instead of accepting. Otherwise enqueues the message and attempts delivery to the relay synchronously within the request (§7.7), returning `202`.

**`DELETE /messages/{uuid}`** — No auth (called by the relay after confirmed device pickup, 0–6 hours staggered). Looks up the message queue row by `delivery_uuid` and marks it cleared. `200` on success, `404` if the UUID is unknown or the message was already cleared. The wallet service never clears a message based solely on a successful relay delivery response — only this explicit call does.

### 7.7 Sub-card and UUID Lifecycle

**`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`** — Sub-card signed envelope (§6.4). Request: `{ payload: { card_hash, subcard_hash, uuids: [1-100 UUID v4s], timestamp, nonce }, signature }`. On success, stores the UUIDs in the sub-card's pool and immediately redelivers any uncleared messages queued for that sub-card to the newly registered UUIDs (no re-encryption needed — the payload was never transformed at the wallet in the first place). Returns `204`.

Delivery (used both here on retransmission and from `POST /messages` on fresh arrival): claims the next UUID from the sub-card's pool and calls the relay's `POST /deliver/{uuid}` with the payload unchanged. On a `404`/`410` (unknown or already-consumed UUID) or a `5xx`/network error, advances to the next UUID in the pool rather than retrying the same one — bounded at 5 attempts per message per delivery pass. A relay outage beyond that is handled by the message staying queued and being retransmitted whenever the sub-card next registers UUIDs, not by retry loops against a single UUID.

**`DELETE /cards/{card_hash}/subcards/{subcard_hash}`** — Sub-card signed envelope, same verification pipeline as registration minus the `uuids` field. Marks every UUID currently registered for the sub-card consumed. `404` if this sub-card was never registered at all. This is purely local bookkeeping for this wallet-service instance — it never reads or sets the on-chain `SubCardEntry.active` flag, and a sub-card deregistered this way can immediately re-register UUIDs and resume normal delivery.

### 7.8 Admin

All three endpoints require the admin bearer token (§6.6); `401` without it or with a wrong key.

**`GET /admin/message-counts`** — `{ message_counts: [{ card_hash, count }] }` — uncleared message count per card. No `subcard_hash`, no payload.

**`GET /admin/recovery-windows`** — `{ recovery_windows: [{ recovery_id, initiated_at, expires_at, seconds_remaining }] }` — every pending window. No `card_hash` (not joined in).

**`GET /admin/uuid-pool-sizes`** — Available (unconsumed, unexpired) UUID count per `(card_hash, subcard_hash)`.

`GET /bindings` (§7.5) also serves as the routing-table view referenced by the strategic plan's operational-transparency goal — it is intentionally unauthenticated (peers need it) rather than gated behind the admin token.

### 7.9 Oblivious Transport (OHTTP)

**`GET /ohttp/key-config`** — No auth. Returns this wallet service's current HPKE public key and suite identifiers, per `oblivious_transport.md`. A device's SDK configuration names a single preferred wallet-service base URL, so there is exactly one such configuration to fetch and cache (on a TTL), unlike a press's key configuration, which is fetched per press base URL.

**`POST /ohttp/gateway`** — No auth (the HPKE envelope is the trust boundary). Request: `{ enc, ciphertext }` — an HPKE-encapsulated inner request. Decapsulates the envelope, dispatches in-process to the same logic module the corresponding plaintext route would call (`accounts-challenge`, `accounts-create`, `keyrings-get`, `messages-create`, and the sub-card registration/deregistration handlers all support this dual entry point), and encapsulates the response back through the same HPKE context. The relay forwards to this endpoint as a stateless oblivious forwarder (`POST /ohttp/{target_id}` on the relay side); it never decrypts the request and sees only the relay's IP as the connecting peer, not the device's.

### 7.10 Matrix

Endpoints supporting the Matrix room subsystem (`specs/object_specs/matrix_room.md`, `specs/process_specs/room_discovery.md`). This service provisions shadow Matrix accounts, authors room predicate documents, and hosts a public room index; it never evaluates a predicate or authorizes a Matrix join or post — that is the Synapse policy module's job (`specs/object_specs/matrix_synapse_module.md`), and it never queries this service to do it (`specs/object_specs/matrix_encryption.md §3`).

**`POST /matrix/rooms`** — Existing session-token auth (§6.2), authenticated card holder. Request: `{ card_hash, policy_id, name?, topic? }`, where `card_hash` is the creating card's registry address (must belong to the authenticated session), `policy_id` is the CID of an existing room predicate document (`matrix_room.md §The Room Predicate Document`; parsed only, not validated for well-formedness — the Synapse module is the authority on evaluation), and `name`/`topic` are optional, passed through to Matrix's own `m.room.name`/`m.room.topic` state events. Creates the room (setting initial `m.room.join_rules` — explicitly overridden to `"public"`, **load-bearing for card-gating to function at all**, not a cosmetic default; see below — plus `m.room.encryption` and `m.room.power_levels` state per `matrix_room.md §Room Creation`), provisions/auto-joins the creating card's shadow Matrix account via the Application Service bridge, and appends an entry to the room index (§7.10 `GET /matrix/room-index`). **On the `m.room.join_rules` override (added 2026-07-16):** room creation uses Synapse's `private_chat` preset, which otherwise defaults `join_rules` to `"invite"`-only; without this explicit override, Synapse's core event-authorization rejects any non-invited user's join with a `403` before `matrix_synapse_module.md`'s policy-module callbacks ever run — silently defeating the entire card-gating mechanism this endpoint exists to support, regardless of attestation validity. This is code-and-test-confirmed already-shipped behavior; only this documentation was missing it. Response: `{ room_id, matrix_alias? }` — `matrix_alias` present only if the deployment assigns human-readable aliases.

**`GET /matrix/room-index`** — No auth (deliberately anonymous and identical for every requester; publicly cacheable). Response: `{ rooms: [{ room_id, policy_id, created_at }, ...], updated_at }`. Written by `POST /matrix/rooms` at room-creation time; no separate write path.

**`POST /matrix/discover-rooms`** — Existing session-token auth (§6.2). Request: `{ envelope }`, a `SignedMessageEnvelope` built and signed locally by the client attesting to its own `card_hash` (not a bare `card_hash` field — see `room_discovery.md`'s 2026-07-12 correction). The server verifies the envelope's signature and confirms the recovered signer matches the authenticated session's own `card_hash` before trusting its chain data, then runs the same chain-walk + predicate-evaluation algorithm the client-side discovery path runs, against the same room index. Response: `{ room_ids: [...] }`. This is a secondary, server-hosted path — client SDKs should attempt local discovery first and fall back here only when local RPC/IPFS access isn't available; per `room_discovery.md`, no persistent per-query log is kept beyond abuse rate-limiting.

**`POST /matrix/token`** — Existing session-token auth (§6.2). Added 2026-07-16 (Phase 3 Tier 1 item 9) — already-implemented, previously undocumented. Request: none beyond the session token. Mints (or returns a still-cached, still-valid) Matrix access token scoped to the caller's own shadow Matrix account — always `deriveMatrixUserId(session.card_hash, ...)`, derived entirely from the caller's own verified session, never a request-body parameter, so a caller can never mint a token for any shadow account but their own. First provisions the shadow account if it doesn't already exist (`src/matrix/provisioning.ts`), then mints/caches the token (`src/matrix/token-minting.ts`). Never returns the Application Service token itself, only a token scoped to that one shadow account. Client SDKs use this to talk to Synapse directly (`sync`/`send`) once they hold a token. Response: `{ matrix_access_token, matrix_user_id }`.

**`PUT /matrix/transactions/{txnId}`** — Added 2026-07-16 (Phase 3 Tier 1 item 9) — already-implemented, previously undocumented. This is the wallet service's Matrix Application Service transaction-push endpoint: the `url` the AS registration file points Synapse at, so Synapse `PUT`s every event relevant to this AS's namespaces here. Bearer-`hs_token`-authenticated per the Matrix AS spec (Synapse authenticates itself with a bearer token equal to this AS's own `hs_token`, as either an `Authorization: Bearer <token>` header or an `access_token` query param); rejects with `401` on mismatch. Full event-driven bridge logic (parsing/acting on the pushed transaction body) is explicitly out of scope for the current implementation — clients talk to Synapse directly for `sync`/`send` once they hold a token from `POST /matrix/token` above. This handler only acknowledges receipt (`{}`, `200`) so Synapse doesn't retry the same transaction.

---

## 8. Error Codes

The wallet service does not use a single uniform `{ error: CODE }` shape the way the relay does (`relay.md §10`) — most endpoints throw an H3 error with a `statusMessage` string. Status codes in use, by condition:

| Status | Meaning | Representative endpoints |
|---|---|---|
| 200 | Success | Most `GET`/`POST` endpoints |
| 202 | Accepted, queued for delivery | `POST /messages` |
| 204 | Success, no body | `POST /cards/.../uuids`, `DELETE /cards/.../subcards/{subcard_hash}` |
| 400 | Missing/malformed required field, or invalid format (e.g., `subcard_hash` not 0x-prefixed 32-byte hex) | Most endpoints with a request body |
| 401 | Invalid or expired challenge/signature/assertion/credential; missing or wrong admin key | Any signed-envelope or session-authenticated endpoint |
| 403 | Session token or envelope payload doesn't authorize the requested `card_hash`/`subcard_hash` | `GET /accounts/{card_hash}/service-secret`, sub-card lifecycle endpoints |
| 404 | Unknown `card_hash`, `backup_id`, `recovery_id`, `keyring_id`, or UUID; sub-card never registered | Most lookup endpoints |
| 409 | Account/credential already exists; recovery window already active | `POST /accounts`, `POST /accounts/{card_hash}/recovery` |
| 410 | Card migrated (with redirect hint); recovery window cancelled or no longer cancellable; UUID already consumed | `POST /messages`, `POST /recovery/{recovery_id}/cancel`, delivery-path UUID handling |
| 425 | Recovery window's 72 hours has not yet elapsed (`Retry-After` header present) | `GET /recovery/{recovery_id}/release` |
| 429 | Rate limit exceeded (`Retry-After` header present) | `POST /accounts/challenge`, `POST /accounts`, `POST /accounts/{card_hash}/recovery`, `GET /accounts/{card_hash}/service-secret`, `POST /bindings/announce` |
| 503 | Dependency (Postgres or `SecretsBackend`) unhealthy | `GET /health` |

---

## 9. Open Questions

**OQ-WALLET-1: `POST /messages` has no sender authentication.** The endpoint accepts routing envelopes from "peer wallet services" by convention, but nothing in the route logic verifies the caller is actually a known peer (contrast with `POST /bindings/announce` and `POST /federation/keyrings*`, which both require a peer wallet-service signature). Worth confirming whether this is an intentional trust boundary (any HTTPS caller can enqueue a message addressed to a card this instance holds, relying on E2E encryption to make an unauthenticated message harmless beyond queue-filling) or a gap to close alongside the other federation endpoints' auth model.

**OQ-WALLET-2: Old backup registrations are not revoked on keyring rotation.** `wallet_backup_and_recovery.md` Process 3 Step 13 calls for revoking old backup registrations after post-recovery re-registration; this is not implemented (confirmed against `wallet-service/docs/operations.md`'s known-gaps section). Mitigated in practice — the old `keyring_id` is deleted from every federation member on rotation, so even an unrevoked old backup registration's release would hand back a `keyring_id` no instance can serve — but the registration itself remains queryable and its notification channels remain live. Not a currently-exploitable gap, but a real divergence from the spec worth closing.

**OQ-WALLET-3: No automated keyring-blob reconciliation.** A federation member that misses a delete broadcast (e.g., was down at the time) retains a stale `keyring_id` replica indefinitely; no reconciliation sweep exists to catch this.

**OQ-WALLET-4: Audit-log test coverage gap.** See §4 — `test/audit-log-schema.test.ts`'s scan roots (`server/routes/messages`, `server/routes/cards`) no longer include the files where device-IO logging actually happens post-refactor (`src/routes/*.ts`). Content is currently compliant on manual review; the automated guarantee is narrower than it was designed to be.

**OQ-WALLET-5: `SECRETS_BACKEND=kms` deployments depend on an out-of-repo AWS KMS key policy.** The application-level access pattern is reviewed (`docs/security-review-cp3.md`); the actual IAM restriction to only this service's identity is an operator responsibility this spec cannot verify.

**OQ-WALLET-6: Open-offer hosting and claim-link serving have no implementing endpoint.** `open_offer_creation.md` and `open_offer_acceptance_new_wallet.md` both describe the wallet service as storing the signed open-offer document and serving a claim link (e.g. `https://<wallet-service>/claim/<offer-id>`); no `offer`/`claim` route exists under `wallet-service/server/routes/` as of this review. Not yet determined whether this is a planned-but-unbuilt wallet-service feature or was intended to live on a different component (e.g. the press). (Inbound targeted-offer delivery and the SCIP/audit-record delivery `card_offering_and_acceptance.md` steps 23–24 describe are not part of this gap — both are ordinary encrypted messages already covered by the generic `POST /messages` routing path, §7.6.)

**OQ-WALLET-7: `card_migration.md` §6's "old wallet service" behavior is not confirmed as implemented.** That section requires the old wallet service, on receiving a valid migration announcement, to (a) forward any queued, undelivered messages for the migrated card to the new wallet service by re-posting each routing envelope, and (b) remove the card from its local store. `POST /bindings/announce`'s implementation (§7.5) updates the routing table on acceptance but contains no message-forwarding step, and this service has no per-card "local store" concept distinct from `message_queue`/`uuid_pools` rows keyed by `card_hash` to remove. Worth confirming whether this is a genuine gap against `card_migration.md` §6 or whether the old-wallet-service side of migration was deliberately deferred.
