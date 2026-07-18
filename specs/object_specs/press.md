# Card Protocol — Press Spec

**Version:** 0.3 (draft)
**Date:** 2026-06-25
**Status:** Draft

**Amended 2026-07-16:** §5.3 `appendLogEntry` updated for the `LogEntry` full-repost design change (`protocol-objects.md §3`, `object_specs/ipfs_card.md §5`) — the press now fetches/decrypts the current head before assembling a new entry, and each entry carries `card_state` (full current field state) and `history` (flat CID provenance list) rather than only a diff.

**Amended 2026-07-16 (spec-consistency Phase 3, Tier 1 item 1):** §3.2, §3.4 (renamed from "IPFS Pinning — Piñata" to "IPFS Pinning — Filebase"), §3.5, §5.1, §5.0, §7, and §10 corrected to describe **Filebase** (S3-compatible upload + `HeadObject` CID capture + gateway fetch + byte-compare validation + Filebase Pinning API reconciliation), the actual and confirmed-deliberate production IPFS pinning vendor — the prior text describing Piñata was stale/incorrect; the deployed code (`press/src/ipfs/client.ts`, `press/server/tasks/reconcile-cids.ts`) has never used Piñata. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 1 item 1.

**Amended 2026-07-16 (spec-consistency Phase 1, Step C):** §5.1 `assembleCardDocument` now sets `protocol_version` on the `CardDocument` via `getProtocolVersion()` before signing (Fix #8, `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`). §5.4 `processSubCardRegistration`/`registerSubCardOnChain` now implement the DNS-admin-card secp256r1 authorization path from `registry_contract.md` v0.6 §4.3 — a `DnsAdminCardKeys` check, two new `POST /sub-card/register` request fields (`adminSecpPayload`/`adminSecpSignature`), the 8-argument `RegisterSubCard` call, and error `E-47` (Fix #2, same source).

**Amended 2026-07-16 (spec-consistency Phase 3, Tier 1 items 16–17):** §2 and §3.2 document two already-implemented, previously-undocumented items: the gas-paying wallet key (`PRESS_GAS_WALLET_PRIVATE_KEY`) is a deliberate, separate key from the on-chain-authorization secp256r1 key, isolating a gas-wallet compromise from write-authorization compromise; `PRESS_OHTTP_PRIVATE_KEY` (the X25519 HPKE key backing the already-documented OHTTP gateway endpoints) is added to the §3.2 config table. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Amended 2026-07-16 (spec-consistency Phase 2, Step C):** §4 gains `GET /ohttp/key-config` and `POST /ohttp/gateway` (Fix #7). §7's error table now aliases `P-05` to `E-14` (Fix #13). §5.4 `processSubCardDeregistration` now accepts a signature from any of three independent signers — sub-card key, requesting app card key, or master card holder key — for both suspected-compromise (810) and benign (811) deregistration, with the master-key path retained as a recovery fallback (Decision (b), resolved). See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changes from v0.2:**
- §3 rewritten: Docker/SQLite container model replaced by Nitro serverless architecture with external persistent storage.
- §3.4 rewritten: IPFS pinning provider changed from web3.storage (w3up) to Piñata (subsequently corrected to Filebase — see 2026-07-16 amendment above).
- §3.5 added: CID reconciliation — scheduled Nitro task that reads all card CIDs from the storage contract and ensures they are pinned.
- §4 updated: `PINATA_JWT` replaces `W3UP_KEY` / `W3UP_SPACE`; `EXTERNAL_KV_URL` added for persistent state. (`PINATA_JWT` subsequently corrected to `FILEBASE_KEY`/`FILEBASE_SECRET`/`FILEBASE_GATEWAY_URL` — see 2026-07-16 amendment above.)
- §5.0 added: Verifier integration — press instantiates a `CardVerifier` from `@membership-card-protocol/verifier` and delegates all chain walking and revocation checking to it.
- §5.5 removed: `resolveCard`, `verifyCardChain`, `checkRevocationStatus`, `verifyAppCertificationChain` — these duplicated verifier package functionality and are replaced by `CardVerifier.verifyCard()`.
- §5.1 `evaluatePredicates` updated: now calls `verifier.verifyCard()` rather than implementing chain walking internally.
- §5.4 `processSubCardRegistration` updated: app certification chain check now uses `verifier.verifyCard()`.
- `P-10` error description updated.
- §9 open questions updated.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Press Identity](#2-press-identity)
3. [Deployment Architecture](#3-deployment-architecture)
   - 3.1 [Nitro Serverless](#31-nitro-serverless)
   - 3.2 [Configuration](#32-configuration)
   - 3.3 [Persistent State — External KV Store](#33-persistent-state--external-kv-store)
   - 3.4 [IPFS Pinning — Filebase](#34-ipfs-pinning--filebase)
   - 3.5 [CID Reconciliation](#35-cid-reconciliation)
4. [HTTP Endpoints](#4-http-endpoints)
5. [Functions](#5-functions)
   - 5.0 [Verifier Integration](#50-verifier-integration)
   - 5.1 [Card Issuance](#51-card-issuance)
   - 5.2 [Open Offer Processing](#52-open-offer-processing)
   - 5.3 [Card Updates and Revocations](#53-card-updates-and-revocations)
   - 5.4 [Sub-Card Registration](#54-sub-card-registration)
   - 5.5 [Log Management](#55-log-management)
   - 5.6 [Audit Epoch Management](#56-audit-epoch-management)
   - 5.7 [On-Chain Operations](#57-on-chain-operations)
   - 5.8 [Rate Limiting](#58-rate-limiting)
   - 5.9 [Gas Management](#59-gas-management)
6. [Rate Limits](#6-rate-limits)
7. [Error Codes](#7-error-codes)
8. [Key Rotation](#8-key-rotation)
9. [Open Questions](#9-open-questions)

---

## 1. Overview

A **press** is the service that validates, co-signs, publishes, and registers cards on behalf of a policy. Every card that enters the protocol passes through a press: the press applies the final signature (`press_signature` in the `CardDocument`), posts the card to IPFS, and registers or updates the card's on-chain registry entry.

A press is authorized to act under one or more policies. Its authorization is recorded on-chain in the `PressAuthorizations` table of the registry contract (see `registry_contract.md §3.3`). The press's authority to write is enforced on-chain via secp256r1 signature verification on every write (RIP-7212 precompile). Its IPFS-side identity — the key whose public key appears as `press_card` in issued `CardDocument`s — is an ML-DSA-44 keypair.

Presses are deployed as **Nitro serverless applications**. Each deployment is a stateless Nitro server; all durable state is held in an external key-value store. Multiple press deployments may operate under the same or different policies; they do not share state beyond the on-chain registry.

Chain validation (chain walking, revocation checking) is delegated to the `@membership-card-protocol/verifier` npm package. The press does not reimplement these verification algorithms.

IPFS pinning is provided by **Filebase**. The press pins all content it publishes and runs a scheduled reconciliation task that reads all card CIDs from the on-chain storage contract and pins any that are not already pinned.

---

## 2. Press Identity

A press has two distinct key pairs, serving distinct roles:

**ML-DSA-44 keypair (IPFS identity key)**

- The press generates this keypair at first boot if not already present.
- The public key is the press's IPFS identity. Its keccak256 hash is the press's on-chain registry address.
- Used to produce `press_signature` in every `CardDocument` and `LogEntry` the press signs.
- Used to produce `press_signature` in `SCIP` objects.
- The private key is loaded from the environment at startup and held in memory for the lifetime of the function invocation. It never leaves the press process.

**secp256r1 keypair (on-chain authorization key)**

- Used to sign payloads submitted to the registry contract (`RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer`, `RegisterSubCard`, `DeregisterSubCard`, `BatchUpdateCardHeads`, `RegisterAddressForward`).
- The public key is registered on-chain in `PressAuthorizations[policy_address][press_address]`.
- Verified by the contract via the RIP-7212 precompile on every write.
- The private key is loaded from the environment at startup (`PRESS_SECP256R1_PRIVATE_KEY`). Used **exclusively** for signing press payloads — it never pays gas.

**Gas-paying wallet key (documented 2026-07-16, Phase 3 Tier 1 item 17 — already-implemented, previously-undocumented architecture).** A separate Ethereum wallet private key, `PRESS_GAS_WALLET_PRIVATE_KEY`, holds ETH and pays gas (`msg.sender`) for every on-chain transaction the press submits. This key is never used for press payload signing — that role belongs entirely to the secp256r1 key above. Splitting these two roles means a compromise of the gas-paying hot wallet (which, by its nature, must remain funded and reachable) does not by itself compromise the press's on-chain write-authorization identity; an attacker who steals only the gas wallet's key can drain its ETH but cannot forge a `press_signature` or a `RegisterCard`/`UpdateCardHead` payload signature.

**Press card (IPFS)**

The press's ML-DSA-44 public key and metadata are published as a `CardDocument` on IPFS before the press can begin operations. This card's CID is the `press_card` pointer that appears in all cards the press issues. The press card must appear in the policy's `approved_presses` list, and the press's secp256r1 key must be registered on-chain in `PressAuthorizations` for that policy before the press may issue any cards.

The press card is issued externally (by the governance body that authorizes the press) and its CID is provided to the press at configuration time via `PRESS_CARD_CID`.

---

## 3. Deployment Architecture

### 3.1 Nitro Serverless

The press is a **Nitro** application (https://nitro.unjs.io). Nitro produces a universal server build that deploys as serverless functions to any supported target (AWS Lambda, Cloudflare Workers, Vercel, self-hosted Node.js, etc.). HTTP routes are defined as Nitro API routes; the CID reconciliation job runs as a Nitro scheduled task.

Each function invocation is stateless. The press loads key material from the environment on each invocation and reads/writes all durable state (rate limit counters, offer records, log heads, app gas balances) to an external key-value store configured via `EXTERNAL_KV_URL`.

**Press operator deployment:**

```bash
# Build for target (e.g., AWS Lambda)
NITRO_PRESET=aws-lambda nitro build

# Or for self-hosted Node.js
NITRO_PRESET=node-server nitro build
node .output/server/index.mjs
```

All secrets are injected as environment variables. Key material is never written to disk or logged.

---

### 3.2 Configuration

All configuration is via environment variables.

| Variable | Required | Description |
|---|---|---|
| `PRESS_CARD_CID` | Yes | CID of this press's `CardDocument` on IPFS |
| `PRESS_POLICY_CIDS` | Yes | Comma-separated list of policy card CIDs this press is authorized under |
| `PRESS_MLDSA44_PRIVATE_KEY` | Yes | Base64url-encoded ML-DSA-44 private key (IPFS identity / content signing) |
| `PRESS_SECP256R1_PRIVATE_KEY` | Yes | Hex-encoded secp256r1 private key (on-chain write authorization; signs payloads only, never pays gas — see §2) |
| `PRESS_GAS_WALLET_PRIVATE_KEY` | Yes | Hex-encoded Ethereum wallet private key that holds ETH and pays gas (`msg.sender`) for on-chain transactions. Distinct from `PRESS_SECP256R1_PRIVATE_KEY` — see §2. Added 2026-07-16, Phase 3 Tier 1 item 17. |
| `PRESS_OHTTP_PRIVATE_KEY` | Yes | Base64url-encoded X25519 HPKE private key backing the OHTTP gateway endpoints (§4). Added 2026-07-16, Phase 3 Tier 1 item 16. |
| `ARBITRUM_RPC_URL` | Yes | Arbitrum One RPC endpoint (e.g. `https://arb1.arbitrum.io/rpc`) |
| `REGISTRY_CONTRACT_ADDRESS` | Yes | Address of the registry storage contract on Arbitrum One |
| `FILEBASE_KEY` | Yes | Filebase S3-compatible access key ID (IPFS pinning and content upload) |
| `FILEBASE_SECRET` | Yes | Filebase S3-compatible secret access key |
| `FILEBASE_GATEWAY_URL` | No | Filebase IPFS gateway URL for content fetches. Default: `https://ipfs.filebase.io` |
| `EXTERNAL_KV_URL` | Yes | Connection URL for the external key-value store (Redis, Upstash, DynamoDB, etc.) |
| `PORT` | No | HTTP port (self-hosted Node.js only). Default: `3000` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`. Default: `info` |
| `MAX_BATCH_SIZE` | No | Maximum cards per `BatchUpdateCardHeads` call. Default: `100` (contract maximum) |
| `STALENESS_WINDOW_SECONDS` | No | Maximum age of revocation data before press rejects issuance. Default: `300` (5 minutes) |

---

### 3.3 Persistent State — External KV Store

All durable state is stored in an external key-value store accessed via Nitro's `useStorage()` API. The underlying driver (Redis, Upstash, Cloudflare KV, DynamoDB, etc.) is operator-configured via `EXTERNAL_KV_URL` and the Nitro storage driver for that backend.

No local SQLite database is used. On restart or cold start, the press reads any required state from the KV store and falls back to on-chain reads where the KV store is absent (e.g., for log head CIDs).

**Key namespaces and schemas:**

```
press:log_head:<policy_card_cid>
  → { log_head_cid: string, seq: number, updated_at: number }
  Tracks the current log head CID per policy. On absence, read from on-chain.

press:offer:<offer_cid>
  → { policy_cid: string, created_at: number, finalized: boolean, expires_at: number | null }
  Open offers in flight for the two-phase targeted issuance flow.

press:rate:<entity_address>:<entity_type>:<operation>:<policy_address>:<window_start>
  → number (count)
  Per-entity rolling 7-day write counts for rate limiting.

press:policy_writes:<policy_address>:<window_start>
  → number (count)
  Per-policy weekly total write counts (press-funded operations).

press:app_gas:<app_card_address>
  → { balance_wei: string, last_funded_at: number | null, last_debited_at: number | null }
  Pre-funded gas account balances for app cards.
  Apps fund their balance by sending ETH to the press's Arbitrum address with their
  app_card_address (keccak256 of their ML-DSA-44 pubkey, hex-encoded) in calldata.
```

**Recovery:** On loss of KV state, the press can reconstruct log head state by reading on-chain `CardEntry` records. Rate limit counters and offer deduplication state cannot be recovered; operators should use a durable, replicated KV backend for production deployments.

---

### 3.4 IPFS Pinning — Filebase

The press uses **Filebase** for all IPFS content publishing and pinning. Filebase is an S3-compatible object storage service that pins every uploaded object to IPFS and exposes a public IPFS gateway for content retrieval.

**SDK:** `@aws-sdk/client-s3` (AWS SDK v3), used against the Filebase S3-compatible endpoint (`https://s3.filebase.com`, region `us-east-1`) rather than a Filebase-specific SDK. All protocol content is stored in a single bucket (`membership_card_protocol`), addressed by object key, not by CID — CIDs are recovered from Filebase-assigned object metadata (see below). Governance scripts share the same bucket under a `dns-governance/` key prefix; the press uses the `press/` prefix.

**Initialization (at startup):**

1. The press loads its Filebase S3 access credentials from `FILEBASE_KEY` and `FILEBASE_SECRET`.
2. The press configures its gateway base URL via `FILEBASE_GATEWAY_URL` (default `https://ipfs.filebase.io`).
3. The press confirms Filebase is reachable and its credentials are valid before accepting any traffic, via `checkFilebaseHealth()`: a `HeadObject` call against a known-nonexistent key in the bucket. A `NotFound`/`NoSuchKey` response confirms the press authenticated successfully (it reached Filebase and was correctly rejected only for the object not existing); any other error fails startup.

**Upload and CID-capture pattern:** New content (card documents, log entries, issuance records) is uploaded to the bucket via `PutObject`, keyed by a content-hash-derived key (hex of the first 16 bytes of `SHA-256(content)`, prefixed `press/`) so identical content maps to the same object — uploads are idempotent. The press then issues a `HeadObject` call on that same key; Filebase returns the IPFS CID it assigned to the object in the `cid` object-metadata field. Two round trips (`PutObject` + `HeadObject`) is the implementation's chosen mechanism — it avoids relying on AWS SDK v3 response-header middleware to capture the CID from the `PutObject` response directly. If Filebase does not return a CID via `HeadObject` metadata, the upload is treated as a failure (`P-24`).

**Fetch pattern:** Content fetches (for reading cards during chain validation, policy resolution, etc.) use the press's configured Filebase gateway (`FILEBASE_GATEWAY_URL`), via a plain HTTP `GET` to `<gateway>/ipfs/<cid>`. The press's IPFS provider, passed to the `CardVerifier` instance (see §5.0), wraps this gateway.

**CID validation:** After every upload, the press re-fetches the content from the Filebase gateway using the CID Filebase returned, and compares the fetched bytes byte-for-byte against the bytes it uploaded. This is a fetch-and-byte-compare round trip, not an independent re-derivation of the CID from the uploaded bytes — the press does not recompute the CID itself from the content's multihash. A mismatch (or a failed re-fetch) is a hard `P-10` error; the CID is never used in any signed object or on-chain write if validation fails. A failure during the initial upload itself (rather than the validation re-fetch) is a `P-24` error.

---

### 3.5 CID Reconciliation

Presses are responsible for pinning all card CIDs registered in the storage contract. This extends beyond CIDs the press itself published: when a press joins a policy, it must ensure any existing cards under that policy are pinned, and it must continue to pin cards it did not originally publish.

**Reconciliation job:** A Nitro scheduled task (`press/server/tasks/reconcile-cids.ts`) runs on a configurable schedule (default: every 6 hours). It:

1. Reads all `CardRegistered` and `CardHeadUpdated` events from the Arbitrum One registry contract, starting from the last processed block (stored in the KV store under `press:reconcile:last_block`), in batches of 2,000 blocks to stay within RPC limits.
2. For each event, extracts the `log_head_cid` (or `initial_log_cid` for `CardRegistered`) from the event data.
3. For each CID, calls the **Filebase Pinning API** (`POST https://api.filebase.io/v1/ipfs/pins`, an implementation of the standard IPFS Pinning Services API, authenticated with `Authorization: Bearer base64(FILEBASE_KEY:FILEBASE_SECRET)`) to ensure Filebase has pinned it. The call is treated as idempotent: both a success response and an HTTP 409 (already pinned) count as success.
4. Advances `press:reconcile:last_block` to the latest processed block, but only if every CID in the batch pinned successfully — a partial failure leaves the checkpoint unadvanced so the batch is retried on the next run rather than silently skipping unresolved CIDs.
5. Logs any CIDs that could not be resolved or pinned (content not reachable on the IPFS network, or a non-2xx/409 Filebase Pinning API response) for operator review.

**Initial bootstrap:** On first deployment, the press sets `press:reconcile:last_block` to the block at which the registry contract was deployed and runs the reconciliation job to catch up. This ensures the press pins the full history of CIDs for all policies it serves.

**Active pinning:** In addition to the scheduled reconciliation, the press pins every CID it produces during normal operations (card documents, log entries, issuance records) immediately upon upload (see `pinToIPFS` in §5.1). Active pinning and scheduled reconciliation together ensure that the press holds pins for all content it is responsible for.

---

## 4. HTTP Endpoints

The press exposes an HTTP API for inbound requests from issuers, holders, and administrators.

| Method | Path | Description |
|---|---|---|
| `POST` | `/issue` | Submit a targeted issuance request (signed offer + requester card) |
| `POST` | `/issue/finalize` | Submit a countersigned offer (holder's `holder_signature`) to complete targeted issuance |
| `POST` | `/open-offer/claim` | Submit an `OpenOfferClaimSubmission` to claim a card under an open offer |
| `POST` | `/update` | Submit a signed `UpdateIntentPayload` to update or revoke a card |
| `POST` | `/sub-card/register` | Submit a signed `SubCardDocument` for press registration on-chain. Body: `{ subCardDoc, holderSignature, adminSecpPayload?, adminSecpSignature? }` — the latter two fields carry the DNS admin card holder's `AdminAuthorizeSubCardPayload` and secp256r1 signature (`registry_contract.md §4.3`), required only when the master card is a DNS admin card (Fix #2). |
| `POST` | `/sub-card/deregister` | Submit a signed deregistration request for a sub-card |
| `GET`  | `/press` | Returns press metadata: `press_card_cid`, `policy_cids`, `log_heads`, `address` |
| `GET`  | `/health` | Liveness check. Returns `200 OK` with `{ "status": "ok" }` if the press is operational |
| `GET`  | `/app-gas/:address` | Returns the current pre-funded gas balance for an app card address: `{ "app_card_address": "0x...", "balance_wei": "..." }` |
| `GET`  | `/ohttp/key-config` | Returns the press's current OHTTP HPKE key configuration (per `oblivious_transport.md`), used by devices to encapsulate an oblivious request before dispatch (Fix #7). |
| `POST` | `/ohttp/gateway` | OHTTP gateway/dispatch endpoint: accepts an encapsulated oblivious request (`message/ohttp-req`-shaped body per `oblivious_transport.md §Request Path`), decapsulates it with the press's HPKE private key, forwards the inner request to the wallet-service/press target it addresses, and returns the encapsulated response. Implemented as `press/server/api/ohttp/{key-config,gateway}.*.ts`, consistent with the Nitro `server/api/` convention used by every other endpoint in this table (Fix #7). |

All `POST` endpoints accept `Content-Type: application/json`. All responses are JSON.

Endpoints return standard HTTP status codes. Press-side error codes (§7) are included in the response body as `{ "error": "<code>", "message": "<human-readable>" }`.

---

## 5. Functions

### 5.0 Verifier Integration

The press instantiates a single `CardVerifier` from `@membership-card-protocol/verifier` at startup and reuses it across all requests. The verifier handles all chain walking, revocation checking, and app-certification chain verification. The press does not reimplement these algorithms.

**Setup:**

```typescript
import { CardVerifier } from '@membership-card-protocol/verifier';
import type { RpcProvider, IpfsProvider } from '@membership-card-protocol/verifier';

// RpcProvider wraps the press's viem/ethers connection to the registry contract.
const pressRpcProvider: RpcProvider = {
  getCardEntry: (address) => registryContract.getCardEntry(address),
  isPolicyAuthorizer: (address) => registryContract.isPolicyAuthorizer(address),
  getPressAuthorization: (policyAddress, pressAddress) =>
    registryContract.getPressAuthorization(policyAddress, pressAddress),
  getSubCardEntry: (address) => registryContract.getSubCardEntry(address),
  getCardEventLog: (cardAddress) => registryContract.getCardEventLog(cardAddress),
  getEasAnnotations: () => [],  // press does not perform annotation lookups
};

// IpfsProvider wraps the press's Filebase gateway.
const pressIpfsProvider: IpfsProvider = {
  fetch: async (cid) => {
    const response = await fetch(`${FILEBASE_GATEWAY_URL}/ipfs/${cid}`);
    if (!response.ok) throw new Error(`IPFS fetch failed: ${cid} → ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
};

const verifier = new CardVerifier({
  rpc: pressRpcProvider,
  ipfs: pressIpfsProvider,
  revocationFreshnessWindowSeconds: STALENESS_WINDOW_SECONDS,
  rejectStaleRevocation: true,
  fetchAnnotations: false,
});
```

**Usage:** Wherever the press previously walked card chains or checked revocation status, it now calls `verifier.verifyCard(cardAddress)`. The result's `chain_reaches_trusted_root`, `is_currently_valid`, and `was_valid_at_signing_time` fields replace the press's prior internal checks.

---

### 5.1 Card Issuance

These functions implement the targeted card issuance flow (`card_offering_and_acceptance.md`). They are invoked sequentially; the `/issue` and `/issue/finalize` endpoints call them in order.

---

#### `validateIssuanceRequest(request)`

**Called by:** `/issue` handler
**Purpose:** Perform all pre-issuance checks before the press commits to constructing an offer.

**Steps:**

1. Confirm the request includes: `policy_cid`, `requester_card_pointer`, `recipient_card_pointer` (or invitation delivery method), and any required field values.
2. Resolve the policy card from IPFS using the press's Filebase gateway (the policy card is a public document; the press fetches it directly without decryption).
3. Confirm the policy's `valid_until` has not passed (if set).
4. Confirm the press's own `press_card_cid` appears in `policy.approved_presses`.
5. Call `evaluatePredicates(policy, requester_card_address, recipient_card_address)`.
6. Call `checkRateLimits('register_card', requester_card_address, policy_address)`.

**Returns:** Validated policy snapshot and card verification results, or an error code.

---

#### `evaluatePredicates(policy, requesterCardAddress, recipientCardAddress)`

**Called by:** `validateIssuanceRequest`, `processOpenOfferClaim`
**Purpose:** Validate the requester and recipient card chains and evaluate the policy's predicates using the verifier package.

**Steps:**

1. Call `verifier.verifyCard(requesterCardAddress)`.
   - If `chain_reaches_trusted_root !== true`, reject with `P-02`.
   - If `is_currently_valid === false`, reject with `P-04`.
2. Call `verifier.verifyCard(recipientCardAddress)`.
   - If `chain_reaches_trusted_root !== true`, reject with `P-03`.
   - If `is_currently_valid === false`, reject with `P-04`.
3. If either result's `revocation.data_freshness_seconds` exceeds `STALENESS_WINDOW_SECONDS`, reject with `P-17`.
4. If `policy.requester_predicate` is present, evaluate it against the requester's chain (extracted from the verifier's chain walk result). Reject with `P-02` if not satisfied.
5. If `policy.recipient_predicate` is present, evaluate it against the recipient's chain. Reject with `P-03` if not satisfied.

**Returns:** `{ passed: true, requesterResult, recipientResult }` or an error with the first failing check.

---

#### `assembleCardDocument(policy, issuerOffer, recipientPubkey)`

**Called by:** `/issue/finalize` handler (targeted), `processOpenOfferClaim` (open offer)
**Purpose:** Build the complete `CardDocument` ready for press signing.

**Steps:**

1. Take the issuer-signed offer blob (which contains `policy_id`, `issuer_card`, `issued_at`, all policy field values, and `issuer_signature`).
2. Add `press_card: PRESS_CARD_CID`.
3. Add `recipient_pubkey` from the countersigned offer.
4. Add `holder_signature` from the countersigned offer.
5. Populate `ancestry_pubkeys`: resolve the issuer card chain and the press card chain from IPFS (using the verifier's IpfsProvider for consistency); collect ML-DSA-44 public keys in order from the immediate parent toward the root. Use the cached chain resolved during `evaluatePredicates`.
6. If this card is the result of a master key rotation, include `past_keys` (supplied by the holder in the rotation request).
7. Call `getProtocolVersion()` on the logic contract and add `protocol_version` (the returned version string) to the document, per `protocol-objects.md §1`'s signing sequence step 5. This must happen before the document is passed to `signCardDocument`, since `protocol_version` is covered by `press_signature`.

**Returns:** Assembled `CardDocument`, including `protocol_version`, ready for signing (all fields except `press_signature`).

**Fix #8 (`plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`):** added step 7 — this function previously never set `protocol_version` before signing.

---

#### `signCardDocument(cardDocument)`

**Called by:** `/issue/finalize` handler
**Purpose:** Apply the press's ML-DSA-44 signature to the completed `CardDocument`.

**Steps:**

1. Serialize the card document as canonical RFC 8785 JSON, excluding the `press_signature` field.
2. Sign the canonical bytes with the press's ML-DSA-44 private key.
3. Add `press_signature: { public_key: PRESS_MLDSA44_PUBKEY, signature: <sig> }` to the document.

**Returns:** Fully signed `CardDocument`.

---

#### `publishCard(signedCardDocument)`

**Called by:** `/issue/finalize` handler, `processOpenOfferClaim`
**Purpose:** Encrypt the card, upload it to IPFS via Filebase, and return the CID.

**Steps:**

1. Derive the content key: `HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`.
2. Encrypt the canonical RFC 8785 JSON of the signed card with AES-256-GCM (random 96-bit nonce).
3. Upload the encrypted bytes to Filebase via `pinToIPFS(encryptedBytes)`.
4. Validate the returned CID: `pinToIPFS` re-fetches the content from the Filebase gateway by that CID and compares it byte-for-byte against `encryptedBytes` (not an independent re-derivation of the CID from the bytes — see §3.4).

**Returns:** CID of the encrypted card on IPFS.

---

#### `pinToIPFS(content)`

**Called by:** `publishCard`, `appendLogEntry`, `appendIssuanceRecord`
**Purpose:** Upload bytes to Filebase and return the root CID.

**Steps:**

1. Derive an idempotency key from `content`: hex of the first 16 bytes of `SHA-256(content)`, prefixed `press/`.
2. `PutObject` the content to the Filebase S3-compatible endpoint at that key. On failure, abort and return error `P-24`.
3. `HeadObject` the same key and read the Filebase-assigned IPFS CID from the `cid` object-metadata field.
4. Re-fetch the content from the Filebase gateway (`FILEBASE_GATEWAY_URL`) using that CID, and compare the fetched bytes byte-for-byte against `content`. If the fetch fails or the bytes differ, abort and return error `P-10`. (This is a fetch-and-byte-compare validation, not an independent re-derivation of the CID from `content`'s hash — see §3.4.)

**Returns:** CID string.

---

#### `registerCardOnChain(cardCid, policyAddress, cardAddress)`

**Called by:** `/issue/finalize` handler
**Purpose:** Submit `RegisterCard` to the Arbitrum One registry contract.

**Steps:**

1. Confirm the press's Arbitrum ETH balance is sufficient to cover gas (see `checkGasBalance`).
2. Build the `RegisterCardPayload`:
   ```json
   {
     "op": "register_card",
     "card_address": "<base64url bytes32>",
     "initial_log_cid": "<base64url CID bytes>",
     "policy_address": "<base64url bytes32>",
     "press_address": "<base64url bytes32>",
     "sequence": <current next_sequence>,
     "timestamp": "<ISO 8601>"
   }
   ```
3. Serialize the payload as canonical RFC 8785 JSON.
4. Sign `keccak256(payload_bytes)` with the press's secp256r1 private key → `press_signature` (r||s, 64 bytes).
5. Call `RegisterCard(card_address, initial_log_cid, policy_address, payload_bytes, press_signature)` on the registry contract.
6. Wait for transaction confirmation. On revert, surface the contract error code to the caller.

**Returns:** Transaction hash on success.

---

#### `issueScip(cardCid, policyLogEntryIndex, policyLogRootCid, issuedAt)`

**Called by:** `/issue/finalize` handler, `processOpenOfferClaim`
**Purpose:** Produce a `SCIP` (Signed Card Inclusion Proof) and deliver it to the recipient.

**Steps:**

1. Assemble the SCIP:
   ```json
   {
     "card_cid": "<cardCid>",
     "policy_log_entry_index": <policyLogEntryIndex>,
     "policy_log_root_at_inclusion": "<policyLogRootCid>",
     "issued_at": "<issuedAt>"
   }
   ```
2. Serialize as canonical RFC 8785 JSON excluding `press_signature`.
3. Sign with the press's ML-DSA-44 private key → `press_signature`.
4. Deliver the completed SCIP to the recipient's wallet service endpoint via HTTPS.
5. Deliver a courtesy copy to the administrator's wallet service endpoint via HTTPS (if configured in the policy).

**Returns:** SCIP object.

---

### 5.2 Open Offer Processing

#### `processOpenOfferClaim(submission)`

**Called by:** `/open-offer/claim` handler
**Purpose:** Process an `OpenOfferClaimSubmission` and issue the card if valid.

**Steps:**

1. Parse and validate the `OpenOfferClaimSubmission` structure.
2. Confirm `submission.claim_payload.offer.press_card` matches `PRESS_CARD_CID`.
3. Confirm the policy has `allow_open_offers: true`.
4. Verify `keccak256(offer.issuer_pubkey)` equals the `offer.issuer_card` pointer address. Reject with `P-05` on mismatch.
5. Verify `offer.issuer_signature` over canonical RFC 8785 JSON of all offer fields except `issuer_signature`, using `offer.issuer_pubkey`. Reject with `P-05` on failure.
6. Verify `submission.recipient_signature` over canonical RFC 8785 JSON of `claim_payload`. Reject with `P-06` on failure.
7. Call `evaluatePredicates(policy, issuer_card_address, recipient_card_address)` (recipient is the submitter).
8. Pre-flight on-chain check: read `OpenOfferUseCounts[offer_id]` and confirm `use_count < max_acceptances` and `block.timestamp < expires_at`. Reject with `P-07` or `P-08` before submitting any transaction.
9. Call `assembleCardDocument(policy, offer, submission.claim_payload.recipient_pubkey)`.
10. Call `signCardDocument`, `publishCard`.
11. Call `claimOpenOfferOnChain(offer_id, max_acceptances, expires_at, card_address, card_cid, policy_address)`.
12. Call `appendIssuanceRecord(policy_cid, card_cid, recipient_pubkey, 'open')`.
13. Call `issueScip(...)`.

**Returns:** `{ card_cid, scip }` on success.

---

#### `claimOpenOfferOnChain(offerId, maxAcceptances, expiresAt, cardAddress, cardCid, policyAddress)`

**Called by:** `processOpenOfferClaim`
**Purpose:** Submit `ClaimOpenOffer` to the registry contract.

**Steps:**

1. Confirm gas balance (see `checkGasBalance`).
2. Build and sign the `ClaimOpenOffer` press payload (same structure as `RegisterCardPayload` with `"op": "claim_open_offer"`, plus `offer_id`, `max_acceptances`, `expires_at`).
3. Call `ClaimOpenOffer(offer_id, max_acceptances, expires_at, card_address, card_cid, policy_address, payload_bytes, press_signature)` on the registry contract.
4. If the transaction reverts with `E-12` (offer expired) or `E-13` (offer at capacity), surface that error to the caller. Do not retry.

**Returns:** Transaction hash on success.

---

### 5.3 Card Updates and Revocations

#### `processUpdateIntent(updateIntent, intentSignature)`

**Called by:** `/update` handler
**Purpose:** Process a signed `UpdateIntentPayload` — field updates (1xx–7xx codes) or revocations (8xx–9xx codes).

**Steps:**

1. Verify `intentSignature` over canonical RFC 8785 JSON of `updateIntent` using the updater's ML-DSA-44 public key. To resolve the updater's public key: call `verifier.verifyCard(updateIntent.updater_card_address)` and extract the public key from the resolved card chain. Reject with `P-09` on signature failure.
2. Confirm `updateIntent.timestamp` is within the press's staleness window. Reject stale intents.
3. Resolve the target card's policy from the on-chain `CardEntry` (via the press's RPC connection).
4. **Codes 510/511/512 (`active_subcards` directory updates) are a hardcoded special case, evaluated before the generic `update_policy` step below and never subject to it:** reject with `P-23` unless `updater_card_address` equals `target_card_address` (only a card's own holder may touch its own `active_subcards`), and reject with `P-13` unless `keccak256(intentSignature.public_key)` equals `target_card_address` (the address-equality check above is meaningless without also confirming the signature was actually produced by that address's own key — implemented in `press/src/handlers/update.ts`). This is a hardcoded protocol invariant per `update_codes.md §5xx` and `process_specs/card_updates.md` — no policy's `update_policy` is consulted for these three codes, and `verifier.verifyCard` is not called for them.
4b. For all other codes: evaluate the relevant `update_policy` predicate for each field in `field_updates` (for 1xx–7xx codes). For revocation codes (8xx–9xx), evaluate `policy.revocation_permissions`. Use `verifier.verifyCard(updateIntent.updater_card_address)` for the chain data required by predicate evaluation.
5. Confirm the updater card chain satisfies the predicate. Reject with `P-11` if not.
6. Multiple revocation entries on the same card are permitted; if present, the entry with the earliest `effective_date` governs (per `card_updates.md`). Field update codes (1xx–7xx) may be applied to a card that already has a revocation entry — revocation does not block further field updates.
7. Call `checkRateLimits('update_card_head', updater_card_address, policy_address)` for 1xx codes.
8. Call `appendLogEntry(target_card, updateIntent)` to build, sign, publish, and register the new `LogEntry`.

**Returns:** `{ log_entry_cid, new_log_head_cid }` on success.

---

#### `appendLogEntry(targetCard, updateIntent)`

**Called by:** `processUpdateIntent`
**Purpose:** Build a new `LogEntry`, publish it to IPFS, and update the card's on-chain log head.

**Amended 2026-07-16** (`protocol-objects.md §3`): a `LogEntry` now reposts the card's complete current field state (`card_state`) and carries a flat `history` array of every predecessor CID, so a reader no longer needs to walk `prev_log_root` backward to reconstruct current state or full provenance. This requires the press to fetch and decrypt the current head object (genesis `CardDocument` or prior `LogEntry`) before assembling the new entry, not merely know its CID.

**Steps:**

1. Fetch the current log head CID for the target card (from the KV store under `press:log_head:<policy_cid>`, or on-chain if local state is missing).
2. Fetch and decrypt the current head object from IPFS (via the press's Filebase gateway; content key derived per `ipfs_card.md §3`), to obtain its `card_state` (or, if the head is still the genesis `CardDocument`, its policy-defined and protocol-reserved field values) and, if the head is itself a `LogEntry`, its `history` array.
3. Assemble the new `LogEntry`:
   - `version`: current log length + 1.
   - `code`: from `updateIntent.code`.
   - `entry_type`: `"field_update"` for 1xx–7xx; `"revocation"` for 8xx–9xx.
   - `prev_log_root`: current log head CID.
   - `history`: the current head's own `history` array (or `[]` if the head is the genesis document) with the current head's own CID appended.
   - `card_state`: the current head's field state with `updateIntent.field_updates` applied (field updates only; a revocation entry's `card_state` is unchanged from the current head's, since 8xx–9xx codes carry no `field_updates`).
   - `field_updates` or `revocation`: from `updateIntent`.
   - `notify_holder`, `updater_message`: from `updateIntent`.
   - `intent_signature`: the updater's signature (passed in).
4. Serialize the `LogEntry` as canonical RFC 8785 JSON excluding `press_signature`.
5. Sign with the press's ML-DSA-44 key → `press_signature`.
6. Call `pinToIPFS(logEntryBytes)` → `log_entry_cid`.
7. Call `updateCardHeadOnChain(card_address, prev_log_cid, log_entry_cid)`.

**Returns:** `{ log_entry_cid, new_log_head_cid: log_entry_cid }`.

**Note on cost.** Reposting `card_state` in full on every update means each `LogEntry`'s IPFS payload grows with the card's field count (not with log length — `card_state` is always the current snapshot, never a running total), and step 2 adds one IPFS fetch+decrypt to every update that the prior design didn't require. This trades a small, constant per-update cost for eliminating the backward-walk cost a reader previously paid on every read, which is the intended tradeoff (`plans/spec-consistency/` design discussion, 2026-07-16).

---

#### `updateCardHeadOnChain(cardAddress, prevLogCid, newLogCid)`

**Called by:** `appendLogEntry`
**Purpose:** Submit `UpdateCardHead` to the registry contract.

**Steps:**

1. Confirm gas balance.
2. Build the `UpdateCardHeadPayload`:
   ```json
   {
     "op": "update_card_head",
     "card_address": "<base64url bytes32>",
     "prev_log_cid": "<base64url — current head>",
     "new_log_cid": "<base64url — new head>",
     "press_address": "<base64url bytes32>",
     "sequence": <next_sequence>,
     "timestamp": "<ISO 8601>"
   }
   ```
3. Sign `keccak256(payload_bytes)` with secp256r1 → `press_signature`.
4. Call `UpdateCardHead(card_address, new_log_cid, payload_bytes, press_signature)` on the registry.
5. On `E-08` (`STALE_PREV_CID`): the log head was updated by another process between the press reading it and submitting the transaction. Fetch the current on-chain head, update the KV store, and retry once. If still failing after one retry, return error `P-12`.

**Returns:** Transaction hash on success.

---

### 5.4 Sub-Card Registration

#### `processSubCardRegistration(subCardDoc, holderSignature, adminSecpPayload?, adminSecpSignature?)`

**Called by:** `/sub-card/register` handler
**Purpose:** Verify a completed `SubCardDocument` and register the sub-card on-chain.

**Precondition (Fix #2):** if the master card is a DNS admin card (see step 5a below), the request body MUST include `adminSecpPayload` (the DNS admin card holder's `AdminAuthorizeSubCardPayload`, canonical RFC 8785 JSON) and `adminSecpSignature` (the holder's secp256r1 signature over `keccak256(adminSecpPayload)`), per `registry_contract.md §4.3`. The press has no channel to obtain this signature other than the inbound `/sub-card/register` request — the DNS admin holder provides it at the same time as their own countersignature over the sub-card document. When the master card is not a DNS admin card, these fields are omitted (or empty) and the press passes explicit zero-value/empty arguments on-chain.

**Steps:**

1. Verify `subCardDoc.app_signature` over canonical RFC 8785 JSON of the document excluding both signature fields.
2. Confirm `keccak256(subCardDoc.holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address. Reject with `P-13` on mismatch.
3. Confirm `keccak256(subCardDoc.app_card_pubkey)` equals the `app_card` pointer address. Reject with `P-13` on mismatch.
4. Verify `holderSignature` over canonical RFC 8785 JSON of the document including `app_signature`, excluding `holder_signature`, using `subCardDoc.holder_primary_card_pubkey`. Reject with `P-14` on failure.
5. Call `verifyAppCertificationChain(subCardDoc.app_card_address)`.
5a. **DNS admin card check (Fix #2).** Read `DnsAdminCardKeys[master_card_address]` via the press's registry contract RPC connection (`GetDnsAdminCardKey(master_card_address)`, `registry_contract.md §5`). If non-zero (the master card is a DNS admin card), confirm the request supplied `adminSecpPayload`/`adminSecpSignature`, that `adminSecpPayload` encodes `sub_card_address`/`sub_card_doc_cid` matching this registration, and pass both through unmodified to `registerSubCardOnChain` for on-chain RIP-7212 verification — the press does not verify the secp256r1 signature itself; the contract does. If the master card is not a DNS admin card, pass explicit zero-value/empty `admin_secp_payload`/`admin_secp_signature` to `registerSubCardOnChain`.
6. Confirm `attestation_level` is `"T2"` unless the governing policy explicitly accepts `"T1"`. If `"T2"`, verify `attestation_proof` against `hash(recipient_pubkey)`.
7. Call `checkRateLimits('register_sub_card', holder_card_address, policy_address)`.
8. Call `checkRateLimits('register_sub_card_app', app_card_address, policy_address)`.
9. Post the completed `SubCardDocument` to IPFS via `pinToIPFS` → `sub_card_doc_cid`.
10. Submit `RegisterSubCard` on-chain (see `registerSubCardOnChain`), passing the DNS-admin-path arguments resolved in step 5a.
11. Notify the holder's wallet service of the successful registration via HTTPS.

**Returns:** `{ sub_card_doc_cid, tx_hash }` on success.

**Note — `active_subcards` is a separate update.** `RegisterSubCard` above updates only the on-chain `SubCardEntry`. It does **not** touch the holder's `active_subcards` field on their master card (`protocol-objects.md §1.1`) — that requires a separate code-510 `UpdateIntentPayload` signed by the holder and submitted through the standard card-update flow (`process_specs/card_updates.md`), which may be handled by this press or any other press listed in the master card's `approved_presses`. A press processing that code-510 intent MUST verify it is signed by the master card's own holder key before posting, per `update_codes.md §5xx` — this authorization is hardcoded and not subject to the governing policy's `update_policy`. Implemented in `handleUpdate` (`press/src/handlers/update.ts`) — see §5.3 step 4 above and error codes `P-23`/`P-13`.

**Notification: Sibling subcard alert.** When the press accepts and appends a code-510 `LogEntry` (subcard addition) to the master card's log, the press reads the now-updated `active_subcards` array and sends a `subcard_sibling_added` message (per `messaging_protocol.md §9`) to each existing subcard listed in that array (not including the newly-added one). This notifies the holder's legitimate subcards on their other devices that a new sibling has been registered, enabling detection of unauthorized additions. The message includes the new subcard's public key and the CID of the code-510 entry. Similarly, when a code-511 entry (removal) is accepted, the press sends `subcard_sibling_removed` to all remaining subcards; when a code-512 entry (rotation) is accepted, it sends `subcard_sibling_rotated` to all remaining subcards.

Implemented in `press/src/functions/notifications.ts` (`diffActiveSubcards` identifies what changed and who the recipients are by diffing the pre-update `active_subcards` — read by decrypting the master card's *previous* IPFS content under ADR-006's public-key-derived content key, which the press can always do since it already confirmed `intent_signature.public_key` is the target card's own key — against the post-update array supplied in `field_updates`; `notifySubcardSiblings` then dispatches) and wired into `handleUpdate` after the log entry is successfully appended. **Delivery is currently best-effort plaintext JSON POSTed to a per-recipient-address endpoint stub**, mirroring the existing Phase 3 auditor-notification precedent in `appendIssuanceRecord` (`press/src/functions/log.ts`) — not full ADR-007 E2E encryption to each subcard's ML-KEM-768 public key, because no field anywhere in this protocol yet records a subcard's ML-KEM public key for the press to resolve (see `plans/milestones/subcard-registry-final-summary.md` "Next Steps"). A notification failure never blocks or fails the underlying `active_subcards` update.

---

#### `verifyAppCertificationChain(appCardAddress)`

**Called by:** `processSubCardRegistration`
**Purpose:** Confirm the app card's chain reaches the governance authority's app-certification policy root.

**Steps:**

1. Call `verifier.verifyCard(appCardAddress)`.
2. Confirm `result.chain_reaches_trusted_root === true` where the trusted root is the governance authority's app-certification policy root (registered in `PolicyAuthorizerKeys` on-chain and present in the press's `trustedRoots` configuration).
3. Confirm the app card is not revoked (`result.is_currently_valid === true`).
4. Reject with `P-15` if the chain does not reach the expected root or the app card is revoked.

**Returns:** `{ certified: true }` or an error.

**Note:** The press configures the verifier with the app-certification policy root as a trusted root for this check. The verifier's `isPolicyAuthorizer` RPC call is authoritative; no additional chain-walking logic is required.

**Note:** The press's app certification check is an early gate — it prevents uncertified sub-cards from reaching the on-chain registry, providing fail-fast feedback before gas is spent. It is not the sole line of defense: runtime verifiers independently re-walk the `app_card` chain using their configured `appCertificationRoot`. A sub-card registered by a compromised press with an uncertified `app_card` will fail Stage 2 verification regardless.

---

#### `registerSubCardOnChain(subCardAddress, masterCardAddress, registrationLogHead, subCardDocCid, adminSecpPayload, adminSecpSignature)`

**Called by:** `processSubCardRegistration`
**Purpose:** Submit `RegisterSubCard` to the registry contract.

**Steps:**

1. Confirm the requesting app's gas balance is sufficient. Reject with `P-16` if insufficient (do not sponsor; the press does not self-fund sub-card registration).
2. Build the `RegisterSubCardPayload` and sign with secp256r1.
3. Call `RegisterSubCard(sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, master_sig_payload, master_signature, admin_secp_payload, admin_secp_signature)` on the registry — the 8-argument form per `registry_contract.md §4.3` (Fix #2). `admin_secp_payload`/`admin_secp_signature` are the values resolved by `processSubCardRegistration` step 5a: the DNS admin holder's `AdminAuthorizeSubCardPayload` + secp256r1 signature when the master card is a DNS admin card, or explicit zero-value/empty (`bytes[64](0)` / empty bytes) otherwise. On revert with `E-47` (`INVALID_ADMIN_CARD_SIGNATURE`), surface that error to the caller — do not retry.

**Returns:** Transaction hash on success.

---

#### `processSubCardDeregistration(subCardAddress, signature, sigPayload)`

**Called by:** `/sub-card/deregister` handler
**Purpose:** Verify the deregistration request's authorization and submit `DeregisterSubCard` on-chain.

**Authorization (Decision (b), `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`): three independent valid signer paths.** The press accepts `signature` (ML-DSA-44, over canonical RFC 8785 JSON of `sig_payload`) from **any one** of: (a) the master card's holder key, (b) the requesting app's own card key (`SubCardDocument.app_card_pubkey`), or (c) the sub-card's own key (`SubCardDocument.recipient_pubkey`). Any single valid signature from any one path is sufficient — this applies whether the deregistration is a suspected-compromise (810) or benign/cooperative (811) removal (`subcard_creation_policy.md`/`wallet_sdk.md §6.4`). **The master-key path remains available as a recovery fallback** — e.g. if the app is uninstalled or unreachable and the holder needs to force-deregister a sub-card the app itself can no longer cooperate on.

**Steps:**

1. Resolve the `SubCardEntry` on-chain for `subCardAddress`; confirm it is active.
2. Fetch the `SubCardDocument` from IPFS using the `sub_card_doc_cid` from the on-chain entry (via the Filebase gateway). This fetch is already required to resolve `master_card_address` for the `DeregisterSubCard` call, so the app-card and sub-card keys it also contains are available at no extra cost.
3. Attempt verification against the two keys already in hand from step 2, in order (cheapest first, no further fetch required):
   a. Verify `signature` over canonical RFC 8785 JSON of `sigPayload` using `SubCardDocument.recipient_pubkey` (the sub-card's own key). If valid, accept and proceed to step 5.
   b. Else, verify `signature` using `SubCardDocument.app_card_pubkey` (the requesting app's own card key). If valid, accept and proceed to step 5.
4. If neither (a) nor (b) verifies, fall back to the master-key path: resolve the master card's public key from its `CardEntry`/`CardDocument` on-chain/IPFS, then verify `signature` using the master card's primary key. Reject with `P-14` if this also fails.
5. Check the requesting app's gas balance.
   - If sufficient: deduct the gas cost from the app balance and submit `DeregisterSubCard`.
   - If zero: sponsor from the issuing organization's press balance and submit. Deregistration must never be blocked by a depleted app balance.
6. Call `DeregisterSubCard(sub_card_address, sig_payload, signature)` on the registry — the ML-DSA-44 signature passed through is whichever of the three keys verified in steps 3–4; the contract does not distinguish which path was used (`registry_contract.md §4.4`).

**Note — `active_subcards` is a separate update.** As with registration, this call does not remove the sub-card's pubkey from `active_subcards`; that requires a separate holder-signed code-511 intent via `process_specs/card_updates.md`. When that code-511 `LogEntry` is accepted by any press, all remaining subcards are notified via `subcard_sibling_removed` messages.

**Returns:** Transaction hash on success.

---

### 5.5 Log Management

#### `getLogHead(policyCid)`

**Called by:** `appendIssuanceRecord`
**Purpose:** Return the current log head CID for a policy card's press log.

**Steps:**

1. Check the KV store under `press:log_head:<policy_cid>`.
2. If not present (first run or after recovery), read from on-chain via the registry contract.
3. Return `{ log_head_cid, seq }`.

---

#### `appendIssuanceRecord(policyCid, cardCid, recipientPubkey, offerType)`

**Called by:** `/issue/finalize` handler, `processOpenOfferClaim`
**Purpose:** Build a `PressIssuanceRecord`, deliver it to each auditor listed in the policy, and await confirmations.

**Steps:**

1. Resolve the policy card via the Filebase gateway to get `policy.auditors`.
2. If `policy.auditors` is empty or absent, skip — no auditors to notify.
3. Assemble the `PressIssuanceRecord` plaintext:
   ```json
   {
     "card_cid": "<cardCid>",
     "recipient_pubkey": "<base64url — ML-DSA-44 pubkey>",
     "scip_cid": "<scip_cid>",
     "issued_at": "<ISO 8601>",
     "offer_type": "<offerType>"
   }
   ```
4. For each card address in `policy.auditors`, send the `PressIssuanceRecord` as an E2E encrypted message via the normal message routing layer (HTTPS to the auditor's wallet service endpoint, encrypted to the auditor card's public key).
5. Await a confirmation message from each auditor acknowledging receipt and recording. Apply a configurable timeout (default: 30 seconds per auditor).
6. If an auditor does not confirm within the timeout, log a warning and continue — issuance is not blocked by an unresponsive auditor. Alert the policy administrator.
7. Record which auditors confirmed and which timed out in the KV store (local state only — not on IPFS).

**Returns:** `{ confirmed_auditors: string[], timed_out_auditors: string[] }`.

---

### 5.6 Audit Epoch Management

Removed. Audit epochs and ML-KEM-based AEK distribution are replaced by direct auditor messaging (see §5.5). Auditors maintain their own records of issuance notifications received from the press.

---

### 5.7 On-Chain Operations

#### `buildPressSignedPayload(op, fields)`

**Called by:** All on-chain write functions
**Purpose:** Construct and sign the canonical payload for an on-chain registry write.

**Steps:**

1. Assemble the payload object with `op`, all operation-specific fields, `press_address`, the current `sequence` (fetched from the registry contract — see `getNextSequence`), and `timestamp`.
2. Serialize as canonical RFC 8785 JSON.
3. Sign `keccak256(payload_bytes)` with the press's secp256r1 private key.

**Returns:** `{ payload_bytes, press_signature }`.

---

#### `getNextSequence(policyAddress)`

**Called by:** `buildPressSignedPayload`
**Purpose:** Return the current `next_sequence` value for this press under the given policy.

**Steps:**

1. Call `GetPressAuthorization(policy_address, press_address)` on the registry contract.
2. Return `PressAuthEntry.next_sequence`.

**Note:** The press always reads this value from the contract rather than caching it, to avoid sequence mismatches after restarts or concurrent writes. A `SEQUENCE_MISMATCH` (E-07) revert triggers an immediate re-read and one retry.

---

#### `batchUpdateCardHeads(policyAddress, updates)`

**Called by:** Operator-initiated bulk update operations
**Purpose:** Submit `BatchUpdateCardHeads` for up to 100 card updates in a single Arbitrum transaction.

**Steps:**

1. Confirm `updates.length >= 1` and `updates.length <= MAX_BATCH_SIZE`.
2. Confirm all cards in `updates` belong to `policyAddress`.
3. Build the `BatchUpdateCardHeadsPayload` with the full `updates` array.
4. Sign with secp256r1.
5. Call `BatchUpdateCardHeads(policy_address, updates, payload_bytes, press_signature)` on the registry.
6. On success, `next_sequence` is incremented by 1 (not by the number of items — the entire batch counts as one write for replay prevention).

**Returns:** Transaction hash.

---

### 5.8 Rate Limiting

#### `checkRateLimits(operation, entityAddress, policyAddress)`

**Called by:** `validateIssuanceRequest`, `processUpdateIntent`, `processSubCardRegistration`
**Purpose:** Enforce per-entity and per-policy write rate limits before processing any operation.

**Steps:**

1. Determine the 7-day window start: `floor(now / 7_days) * 7_days`.
2. Read the count from the KV store under `press:rate:<entityAddress>:<entityType>:<operation>:<policyAddress>:<windowStart>`. Default to 0 if absent.
3. If `count >= limit` for this operation (see §6), reject with `P-18`.
4. Separately read `press:policy_writes:<policyAddress>:<windowStart>` for the press-funded weekly total. Reject with `P-19` if at or above the per-policy limit.
5. If within limits, defer the counter increment to `recordWrite` (called after the operation succeeds).

---

#### `recordWrite(operation, entityAddress, policyAddress)`

**Called by:** All write-completing handlers, after a successful on-chain transaction
**Purpose:** Increment rate limit counters after a successful write.

**Steps:**

1. Increment `press:rate:<entityAddress>:<entityType>:<operation>:<policyAddress>:<windowStart>` in the KV store (atomic increment).
2. Increment `press:policy_writes:<policyAddress>:<windowStart>` in the KV store (atomic increment).
3. If total is now ≥ 80% of any limit, call `sendSuspiciousActivityAlert`.

---

#### `sendSuspiciousActivityAlert(entityAddress, entityType, operation, currentCount, limit, policyAddress)`

**Called by:** `recordWrite`
**Purpose:** Notify the card-granting agency when write volume approaches a limit.

**Steps:**

1. Resolve the policy card from the Filebase gateway to get the granting agency's wallet service endpoint.
2. POST an alert payload to the granting agency's HTTPS endpoint:
   ```json
   {
     "entity_card":   "<registry address of the holder or app card>",
     "entity_type":   "holder | app_card",
     "operation":     "<operation name>",
     "current_count": <count>,
     "limit":         <limit>,
     "window_start":  "<ISO 8601>",
     "timestamp":     "<ISO 8601>"
   }
   ```
3. If the HTTPS call fails, log the alert locally. Do not block the write operation.

---

### 5.9 Gas Management

#### `checkGasBalance()`

**Called by:** All on-chain write functions
**Purpose:** Confirm the press's Arbitrum ETH balance is sufficient to cover the estimated gas cost of the next write.

**Steps:**

1. Fetch the current ETH balance of the press's Arbitrum wallet.
2. Estimate gas for the pending operation using `eth_estimateGas`.
3. If `balance < estimated_gas_cost * 1.2` (20% buffer), log a low-balance warning.
4. If `balance < estimated_gas_cost`, reject with `P-20` and alert the operator.

---

#### `checkAppGasBalance(appCardAddress, operation)`

**Called by:** `registerSubCardOnChain`, `processSubCardDeregistration`
**Purpose:** Check the app's pre-funded gas account balance before a sub-card operation.

**Steps:**

1. Read `press:app_gas:<appCardAddress>` from the KV store.
2. Estimate gas for the operation.
3. For `RegisterSubCard`: if balance < estimated cost, return `{ sufficient: false }`. Caller rejects with `P-16`.
4. For `DeregisterSubCard`: if balance is zero, return `{ sufficient: false, sponsor: true }`. Caller sponsors from the press's Arbitrum balance.

---

## 6. Rate Limits

Default limits per rolling 7-day window. Policy operators may configure stricter limits in the policy card.

| Operation | Scope | Default weekly limit |
|---|---|---|
| `register_card` | Per policy (press-funded) | 1,000 |
| `update_card_head` (1xx codes) | Per holder | 20 |
| `register_sub_card` | Per holder | 10 |
| `register_sub_card` | Per app card | 500 |
| `deregister_sub_card` | Per holder | 10 |
| All press-funded writes | Per policy | 1,000 |

Suspicious-activity alerts are sent to the granting agency when any per-holder or per-app-card count reaches 80% of the configured limit.

---

## 7. Error Codes

Press-side error codes (not on-chain reverts). Returned in the HTTP response body.

| Code | Trigger |
|---|---|
| `P-01` | Press sub-card not in `approved_presses` for the requested policy |
| `P-02` | `requester_predicate` not satisfied, or requester chain does not reach a trusted root |
| `P-03` | `recipient_predicate` not satisfied, or recipient chain does not reach a trusted root |
| `P-04` | Card revoked with `effective_date ≤ now` (requester, recipient, or ancestor) |
| `P-05` (alias `E-14`) | Invalid `issuer_signature` on open offer (binding check failed or ML-DSA-44 sig invalid). This is the same condition `registry_contract.md §8`, `protocol-objects.md §7`, and the open-offer acceptance process specs refer to as `E-14` (`INVALID_ISSUER_SIGNATURE`) — a press-side rejection, never an on-chain revert. `P-05` is this spec's internal name for the identical check; callers should treat `E-14` and `P-05` as the same code (Fix #13). |
| `P-06` | Invalid `recipient_signature` on open offer claim |
| `P-07` | Open offer expired (press-side pre-flight before on-chain submission) |
| `P-08` | Open offer at capacity (press-side pre-flight) |
| `P-09` | Invalid `intent_signature` on `UpdateIntentPayload` |
| `P-10` | CID mismatch: content re-fetched from the gateway by the CID returned by Filebase does not byte-for-byte match the uploaded content |
| `P-11` | `update_policy` predicate not satisfied for one or more field updates |
| `P-12` | `STALE_PREV_CID` revert on retry — concurrent log head conflict not resolvable |
| `P-13` | Pubkey binding check failed: `keccak256(pubkey) ≠ pointer address` |
| `P-14` | Invalid ML-DSA-44 signature: for sub-card registration, the master card holder's `holderSignature`; for sub-card deregistration, a signature that fails verification against all three permitted signers (sub-card key, app card key, master card holder key — Decision (b), `§5.4 processSubCardDeregistration`) |
| `P-15` | App card chain does not reach the governance app-certification policy root |
| `P-16` | App gas account balance insufficient for `RegisterSubCard` |
| `P-17` | Revocation data is stale — cannot confirm freshness within staleness window |
| `P-18` | Per-entity rate limit reached for this operation |
| `P-19` | Per-policy press-funded write limit reached |
| `P-20` | Insufficient ETH balance to cover estimated gas cost |
| `P-21` | Policy `valid_until` has passed; press will not issue new cards under this policy |
| `P-22` | Offer timestamp is stale (replay prevention) |
| `P-23` | Code-510/511/512 `active_subcards` update where `updater_card_address` ≠ `target_card_address` (holder-only rule violated) |
| `P-24` | Filebase upload failed; IPFS pin not confirmed |

**On-chain revert codes this spec surfaces (Fix #2).** These are contract-side reverts (`registry_contract.md §8`), not press-generated codes, but `registerSubCardOnChain` (§5.4) explicitly forwards them to the caller rather than retrying:

| Code | Trigger |
|---|---|
| `E-47` | `INVALID_ADMIN_CARD_SIGNATURE` — `RegisterSubCard` failed the DNS admin card secp256r1 check (`registry_contract.md §4.3` precondition 5): missing/invalid `admin_secp_signature` when the master is a DNS admin card, `admin_secp_payload` field mismatch, or a spurious non-zero signature when the master is not a DNS admin card. |

---

## 8. Key Rotation

**secp256r1 key rotation:** If the press's on-chain authorization key is compromised or requires routine rotation, the Press Registry Governance Body calls `AuthorizePress` with the press's `press_address` and a new `press_pubkey`. The press is redeployed with the new `PRESS_SECP256R1_PRIVATE_KEY`. No KV store changes are required; the `next_sequence` is reset on-chain.

**ML-DSA-44 key rotation:** Rotating the press's IPFS identity key requires issuing a new press card with the new public key, updating the policy's `approved_presses` list, registering the new press card on-chain via `AuthorizePress`, and redeploying with updated `PRESS_MLDSA44_PRIVATE_KEY` and `PRESS_CARD_CID`. Cards previously issued under the old press card remain valid; their `press_card` pointer is immutable.

**On-chain key scheme upgrade (secp256r1 → ML-DSA-44):** When the protocol advances to Phase 2 or Phase 3 (see `ARCHITECTURE.md` ADR-012), the press submits `RotateOnChainKeyScheme` with a dual-signature payload. This operation is self-initiated by the press; no governance action is required. The press is redeployed after the rotation transaction confirms so that subsequent writes use the ML-DSA-44 on-chain signing path.

---

## 9. Open Questions

| ID | Area | Resolution |
|---|---|---|
| ~~**OQ-A1**~~ | Audit | **Closed.** Auditor key distribution via ML-KEM is replaced by direct E2E messaging. Auditors are listed in `policy.auditors` as card addresses; the press messages each auditor at issuance time using the normal routing layer. |
| ~~**OQ-A2**~~ | Gas | **Closed.** Apps pre-fund their gas balance by sending ETH directly to the press's Arbitrum One address with their `app_card_address` in the transaction calldata. See §3.3 `app_gas` KV namespace. |
| ~~**OQ-A3**~~ | Recovery | **Closed (no longer applicable).** AEK recovery is not needed — there is no AEK. The press does not hold any epoch key material. Auditors maintain their own records. |
| ~~**OQ-A4**~~ | Serialization | **Closed.** `ARCHITECTURE.md` ADR-010 is Accepted — RFC 8785 (JCS) adopted. |
| **OQ-B1** | KV backend | The external KV store driver is operator-selected (Redis, Upstash, Cloudflare KV, DynamoDB, etc.) via Nitro's `useStorage()` API. The press spec is storage-driver-agnostic; the operator's Nitro configuration specifies the driver. No specific backend is prescribed here. |
| **OQ-B2** | Reconciliation catch-up | The CID reconciliation job (§3.5) bootstraps by setting `press:reconcile:last_block` to the registry contract's deploy block. For large deployments with many historical cards, the initial catch-up may require multiple runs or a higher-frequency schedule until caught up. The appropriate schedule is operator-configurable. |
| **OQ-B3** | Verifier RpcProvider for log entries | The verifier's `RpcProvider.getCardEventLog(cardAddress)` must return the full ordered log (as `CardChainEvent[]`, where each event contains `{cid, timestamp}`) for a card address. The registry contract stores only the head CID (not the full log); the press's RPC provider reconstructs the ordered log by replaying on-chain CardRegistered and CardHeadUpdated events from the registry. This log-reconstruction logic now lives exclusively in the RPC provider implementation, not in the press itself. |

---

## 10. Dependencies

| Package | Purpose |
|---|---|
| `nitropack` (or `nitro`) | Serverless application framework; HTTP routing, scheduled tasks, storage API |
| `@membership-card-protocol/verifier` | Chain walking, revocation checking, app certification chain verification |
| `@aws-sdk/client-s3` | AWS SDK v3 S3 client, used against the Filebase S3-compatible endpoint for IPFS content upload and pinning |
| `viem` or `ethers` | Arbitrum One RPC client for registry contract calls and event indexing |
| `@noble/post-quantum` | ML-DSA-44 signing (FIPS 204) |
| `@noble/hashes` | keccak256, HKDF-SHA3-256 |

**Open item (Fix #8):** `assembleCardDocument` (§5.1) calls `getProtocolVersion()` on the logic contract, but `registry_contract.md §5` (Read Operations) currently has no `GetProtocolVersion()` entry. That spec should add one (or cite where the read op actually lives, if it is not the registry contract itself) — flagged here since this file only documents the press's call site, not the contract-side read operation.

---

*Related specs: `protocol-objects.md`, `registry_contract.md`, `process_specs/card_offering_and_acceptance.md`, `process_specs/open_offer_creation.md`, `process_specs/card_updates.md`, `process_specs/log_auditing.md`, `ARCHITECTURE.md` ADR-005, ADR-011, ADR-012.*
