# Wallet Service Backend — Strategic Plan

**Date:** 2026-06-29
**Status:** Draft
**Companion document:** [implementation-plan.md](./implementation-plan.md)
**Spec references:**
- `specs/process_specs/wallet_backup_and_recovery.md`
- `specs/process_specs/notification_relay.md`
- `specs/process_specs/message_routing.md`
- `specs/object_specs/relay.md`
- `specs/object_specs/relay_data_model.md`

---

## What This Service Is

The wallet service backend is the always-online server component that card holders rely on for keyring custody, recovery infrastructure, and message delivery. It combines two roles defined in the backup/recovery spec:

- **Primary service** — holds each holder's `service_secret` (one half of the keyring decryption key), stores a replica of the holder's encrypted keyring blob (keyed by `keyring_id`, per `ARCHITECTURE.md` ADR-009-AMEND — not IPFS), and never sees wallet plaintext. The keyring blob is also broadcast to every other wallet service in the federation, and every wallet service instance stores replicas for holders across the federation, not just its own.
- **Backup service** — stores wrapped decryption key blobs (synced passkey and/or YubiKey variants), manages the 72-hour cancellation window, sends notifications across all configured channels, and releases key material after the window expires without cancellation.

On top of these keyring custody functions, the wallet service handles all inbound message routing: receiving encrypted message envelopes from peer wallet services, queuing them per card, registering UUID pools for each holder device, and delivering encrypted blobs to the relay for device notification. It never decrypts message content.

**What this service explicitly does NOT do:** card offer construction, press communication, chain verification at the routing layer, or relay service functions. The relay is a separate service. On-device card operations stay on-device to minimize server-side data exposure.

---

## Goals

### 1. Secure keyring custody without seeing plaintext key material

The wallet service holds `service_secret` values — one half of each holder's keyring decryption key — and encrypted keyring blob replicas for holders across the federation (not just its own). This is the most sensitive data the service touches, and its theft or exposure could enable wallet decryption. The service must never have access to the full decryption key, the plaintext keyring, or the wrapped recovery blobs in decryptable form.

### 2. Trustworthy recovery with meaningful cancellation protection

The 72-hour cancellation window is the primary human-scale safeguard against unauthorized recovery. The wallet service must execute this window reliably: sending notifications through all configured channels immediately on initiation, accepting valid signed cancellations at any point during the window, and releasing key material only after the full window has passed without cancellation. A failure here — failing to notify, accepting an invalid cancellation, or releasing early — is a security incident, not a UX bug.

### 3. Reliable, privacy-preserving message delivery with no single-operator knowledge

Card holders must receive messages without the wallet service being able to correlate their device identities to their card identities. The UUID-based relay architecture achieves this: the wallet service knows card hashes and device_keys (opaque hashes), but not push tokens or device identities. This property must be preserved throughout the implementation — any logging, monitoring, or debugging instrumentation that would re-link these must be treated as a privacy violation.

### 4. Federated routing that degrades gracefully

The wallet service is one node in a small federation of wallet services. Card holders can migrate between operators. The routing table must stay current through binding announcements and startup sync, and delivery failures (stale routes, operator downtime) must be handled without data loss: retained messages are re-delivered on UUID re-registration, and routing is retried after `410 Gone` redirects.

### 5. Operate honestly and transparently within the trust model

The wallet service operator has meaningful power: it holds `service_secret` values (enabling decryption if the passkey is also compromised), it controls the 72-hour timer, and it can observe which card hashes are receiving messages. The service must be built so that its trust assumptions are explicit, documented, and auditable — not hidden in implementation choices. Operators who wish to run their own instance should be able to do so.

---

## Rationale

### Why keyring custody matters and what the limits are

The spec's security model is: `decryption_key = KDF(device_passkey_output, service_secret)`. Neither component alone can reconstruct the decryption key. The wallet service holding `service_secret` is necessary for daily operations (the device needs it during key derivation) but must not become a single point of failure or a covert decryption oracle. `service_secret` is stored using envelope encryption (a random per-account DEK encrypts the secret; the DEK itself is encrypted by a master key) so that a database dump alone is not sufficient for a breach. See "Secret Storage: Two Different Trust Levels" below for which secrets get this treatment and which don't.

### Why the 72-hour window must be hardened

The 72-hour cancellation window is a social-layer control, not a cryptographic one. A stolen synced passkey (via Apple/Google account compromise) initiates a legitimate-looking recovery. The only defense is the notification and cancellation flow: if the holder sees the notification and their cancellation credential is intact, they can abort. This means the notification dispatch must happen immediately on initiation (not batched), must reach all configured channels in parallel, and must not be defeatable by the attacker (e.g., by spamming initiation requests to exhaust notification rate limits). The 72-hour timer itself must survive server restarts — it cannot live only in memory.

### Why message routing and UUID management are tightly coupled to the security model

The unlinkability property — wallet service can't correlate card hash to device — is not optional. For holders in adversarial contexts (activists, journalists, harm survivors), a wallet service log that reveals "card X received a message, and device Y was the delivery target" is a meaningful intelligence product. The UUID architecture breaks this: the wallet service only knows it delivered a blob to UUID Z, and UUID Z is opaque to it. Building message routing without understanding this property leads to logging choices that inadvertently reconstruct the link. This must be treated as a first-class constraint during implementation.

### Why a federation model rather than a single service

The card protocol is explicitly designed so that card holders can choose their wallet service operator or run their own. Centralization on one wallet service creates a single point of failure and a single surveillance target. The routing protocol (CardBindingAnnouncement, startup sync, `410 Gone` redirects) exists specifically to support federated operation. The implementation should validate that a second wallet service can be stood up and cards migrated to it without data loss.

---

## Key Objectives

### Goal 1: Secure keyring custody

- `service_secret` values are envelope-encrypted before database storage; the application cannot read them without the master key (see "Secret Storage" below for the default backend and pluggable alternatives).
- The wallet service can return `service_secret` to an authenticated device but cannot reconstruct the `decryption_key` itself (it never holds `device_passkey_output`).
- Wrapped recovery blobs are stored opaquely — the backup service role stores ciphertext and cannot unwrap it.
- A penetration test or audit of the database should confirm that no plaintext key material exists at rest.

### Goal 2: Trustworthy recovery

- Notification dispatch fires within 60 seconds of recovery initiation across all configured channels (email, SMS, webhook, secondary contact).
- The 72-hour timer persists across server restarts (stored in the database with start timestamp, not in memory).
- A valid signed cancellation received at any point during the 72-hour window aborts the recovery and triggers confirmation notifications.
- Key release is only possible after the timer expires with no valid cancellation on record; there is no administrative bypass.

### Goal 3: Privacy-preserving message delivery

- The wallet service never stores push tokens, device identifiers, or device credentials — those live in the relay.
- Wallet service logs do not contain any data that links a UUID to a card hash or a device_key to a person.
- The UUID pool (stored in the database as `card_hash → device_key → uuid[]`) contains no data the wallet service can correlate back to a device.
- Multi-device fan-out is confirmed working: two devices registered for one card both receive delivered messages independently.

### Goal 4: Federated routing

- A second wallet service can join the network, sync the routing table from peers, and receive messages addressed to a card it holds within 30 seconds of announcing a binding.
- A card migration (dual-signed `card_migration` announcement) causes all peers to update their routing table and the old wallet service to return `410 Gone` correctly.
- Retained messages are re-delivered after UUID re-registration without duplication (device deduplicates by message ID).

### Goal 5: Operational transparency

- Admin endpoints expose: current routing table, pending recovery windows with time remaining, held message counts per card, UUID pool sizes per device. No plaintext key material in admin output.
- An operator can run a second instance of the wallet service and validate the same routing and delivery behavior.
- Audit log entries exist for: `service_secret` creation and access, recovery initiation, cancellation receipt, key release, and binding announcement broadcast.

---

## Architectural Decision: Deployment Framework and Default Target

**Decided: the wallet service is built on [Nitro](https://nitro.unjs.io) (`nitropack`), the same server framework used by the press, deploying by default to Cloudflare Workers.** This replaces an earlier draft of this section, which weighed a persistent Docker container against an AWS Nitro Enclave (the hardware-attestation feature, unrelated to the Nitro framework — see the note below on the naming collision). That framing no longer applies once the following points are accounted for:

- The 72-hour recovery timer does not need a precise in-process timer. It is a persistent database record (`expires_at`), checked by a periodic sweep. Nitro's `scheduledTasks` config (already used by the press for `reconcile-cids`) runs this sweep — as an EventBridge-style cron trigger on serverless presets, or an in-process scheduler on `node-server`. No external job queue is needed.
- Staggered relay clearance is the relay's responsibility, not the wallet service's. The wallet service has no background dispatch job to run for it.
- The wallet service does not open or accept WebSocket connections to the relay. Relay communication is HTTPS in both directions (the wallet service receives inbound HTTPS posts from the relay and from peer wallet services). This removes the long-lived-connection requirement that made serverless or enclave deployment awkward in the original analysis.
- Inbound message routing doesn't require the wallet service to know sender identity — routing data lives in the encrypted envelope. This keeps every wallet service endpoint a stateless request/response handler.

Given these constraints, the wallet service is a stateless HTTP API plus a scheduled sweep — a clean fit for a portable serverless framework. Nitro supports this without committing to one cloud: the same codebase builds against `cloudflare-module`, `aws-lambda`, or `node-server` presets. **Cloudflare is the default preset** for both the wallet service and the press; operators who prefer AWS or a self-hosted Node process can build against the alternate presets from the same source.

**Naming note — two unrelated "Nitro"s:** "Nitro" here is the UnJS server framework (`nitropack`), a JS/TS framework that builds one codebase for multiple deployment targets. This is unrelated to "AWS Nitro Enclaves," a hardware-isolated compute feature available only on EC2 (no Lambda or Fargate integration exists). The original draft of this section was evaluating the latter. An enclave-based deployment remains technically possible as a future option for operators wanting hardware-attested isolation of `service_secret`, but it would require an always-on EC2 host regardless of how stateless the application logic is — it is an infrastructure choice independent of the framework decision above, not a deployment preset Nitro can target.

### Secret Storage: Two Different Trust Levels

The wallet service holds two categories of server-side secret, and they do not warrant the same protection:

- **`service_secret`** (one half of the keyring decryption key, per Goal 1): exposure, combined with a separately compromised passkey, directly enables wallet decryption. This is encrypted at rest via envelope encryption. **Default backend:** a master key held as a platform secret (a Cloudflare Worker secret, or the AWS-preset equivalent), used directly with the Workers/Node Web Crypto API (AES-256-GCM) to wrap and unwrap each account's DEK — no external key-management service call. This keeps the default deployment fully serverless with no AWS dependency. The encrypt/decrypt interface is pluggable: an operator deploying to AWS can swap in an AWS KMS-backed implementation behind the same interface if they want a logged, IAM-gated decrypt call as a separate credential domain from the application secret. This is a deliberate trade against the self-managed default — KMS adds an audit trail and credential separation at the cost of an AWS dependency baked into the deployment.
- **UMBRAL re-encryption keys — SUPERSEDED, see OQ-WS-4 below.** This bullet originally argued for storing per-sub-card UMBRAL re-encryption keys in plaintext. The wallet service no longer holds any re-encryption key material at all — Phase 4 of `implementation-plan.md` replaced wallet-side UMBRAL proxy re-encryption with sender-side per-sub-card encryption (`process_specs/message_routing.md` v0.4), eliminating both the key-custody question this bullet answered and the GPL-licensed dependency the only available UMBRAL implementation would have required. Kept here, struck through in spirit, for the historical record of why `reencryption_keys` briefly existed in the schema and was then dropped.

---

## Open Questions

The following questions should be resolved before or during the implementation plan. Answers will shape Phase 1 scaffolding and Phase 2 key custody choices.

**OQ-WS-1: `service_secret` delivery authentication — RESOLVED**

Resolved (implementation-plan.md CP-1, Phase 2 Step 2.1/2.2): there is no external registration token, because there is no third party in the loop — `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md` both describe the wallet service as the sole, continuous driver of offer display, wallet creation, and claim submission. Two auth paths follow from those two specs: a **new** wallet authenticates `POST /accounts` by having the freshly-generated master card key sign a server-issued challenge, proving control of the key being registered, with a session token returned directly in that response; an **existing** wallet authenticates via a new WebAuthn passkey login endpoint before `service_secret` is released for keyring decryption/update. Post-recovery re-registration continues to use a master-card-key-signed challenge, unchanged.

**OQ-WS-2: WebSocket endpoint for relay bridging — RESOLVED**

Resolved: the wallet service does not expose or open any WebSocket endpoint. All relay communication, in both directions, is HTTPS. This is what makes the Nitro/Cloudflare deployment decision above viable.

**OQ-WS-3: Keyring blob storage and federation replication — RESOLVED, no longer an IPFS question**

Per `ARCHITECTURE.md` ADR-009-AMEND, the keyring blob does not live on IPFS — it is stored directly by the wallet service (traditional storage, e.g. the same Postgres/object-storage backend used for everything else) and replicated to every other wallet service in the federation, keyed by `keyring_id = keccak256(encrypted_blob)`. No IPFS adapter is needed for this. What remains open for the implementation plan: the exact broadcast mechanism for propagating new/rotated keyring blobs to federation peers (likely piggybacking on the existing `CardBindingAnnouncement` broadcast, per the strategic plan's federation goal) and the delete-propagation protocol for superseded `keyring_id` versions.

**OQ-WS-4: UMBRAL re-encryption key protection — MOOT (architecture changed)**

Originally resolved as "stored in plaintext" (a stolen re-encryption key cannot decrypt anything without the corresponding sub-card private key). That resolution is now moot: Phase 4 replaced wallet-side UMBRAL re-encryption with sender-side per-sub-card encryption (`process_specs/message_routing.md` v0.4) — the wallet service holds no re-encryption keys at all, so there is nothing left to protect. This also sidesteps the GPL-3.0 license on the only available UMBRAL implementation (`@nucypher/umbral-pre`), which would otherwise have been a real adoption blocker.

**OQ-WS-5: Multi-wallet federation topology**

Is the initial deployment a single wallet service instance, or is a federated network of operators planned from the start? The routing protocol supports federation, but the peer list is a static operator configuration. If there will be more than one operator at launch, peer list management and the binding announcement broadcast must be implemented before cards are registered. If it's single-operator at first, federation can be validated in a later phase.

**OQ-WS-6: Recovery cancellation credential format**

The backup/recovery spec states that a cancellation is valid if it is "signed by any registered cancellation credential." What key material constitutes a cancellation credential? Options include: the holder's master card key, a dedicated revocation credential registered at backup time, or a separate one-time code. This must be specified before implementing the 72-hour window logic.

---

## Related Specs

- `specs/process_specs/wallet_backup_and_recovery.md` — full primary + backup service process
- `specs/process_specs/notification_relay.md` — relay delivery process; UUID pool lifecycle
- `specs/object_specs/relay.md` — relay API spec; endpoints the wallet service calls and exposes
- `specs/process_specs/message_routing.md` — CardBindingAnnouncement; routing table; delivery flow
- `specs/process_specs/card_migration.md` — dual-signature migration; `410 Gone` handling
- `specs/messaging_protocol.md` — SignedMessageEnvelope; E2E encryption model
