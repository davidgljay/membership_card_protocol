# Card Protocol — Press Spec

**Version:** 0.1 (draft)
**Date:** 2026-06-20
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Press Identity](#2-press-identity)
3. [Container Architecture](#3-container-architecture)
   - 3.1 [Dockerfile and Image](#31-dockerfile-and-image)
   - 3.2 [Configuration](#32-configuration)
   - 3.3 [Persistent State — SQLite](#33-persistent-state--sqlite)
   - 3.4 [IPFS Pinning — web3.storage](#34-ipfs-pinning--web3storage)
4. [HTTP Endpoints](#4-http-endpoints)
5. [Functions](#5-functions)
   - 5.1 [Card Issuance](#51-card-issuance)
   - 5.2 [Open Offer Processing](#52-open-offer-processing)
   - 5.3 [Card Updates and Revocations](#53-card-updates-and-revocations)
   - 5.4 [Sub-Card Registration](#54-sub-card-registration)
   - 5.5 [Chain Verification](#55-chain-verification)
   - 5.6 [Log Management](#56-log-management)
   - 5.7 [Audit Epoch Management](#57-audit-epoch-management)
   - 5.8 [On-Chain Operations](#58-on-chain-operations)
   - 5.9 [Rate Limiting](#59-rate-limiting)
   - 5.10 [Gas Management](#510-gas-management)
6. [Rate Limits](#6-rate-limits)
7. [Error Codes](#7-error-codes)
8. [Key Rotation](#8-key-rotation)
9. [Open Questions](#9-open-questions)

---

## 1. Overview

A **press** is the service that validates, co-signs, publishes, and registers cards on behalf of a policy. Every card that enters the protocol passes through a press: the press applies the final signature (`press_signature` in the `CardDocument`), posts the card to IPFS, and registers or updates the card's on-chain registry entry.

A press is authorized to act under one or more policies. Its authorization is recorded on-chain in the `PressAuthorizations` table of the registry contract (see `registry_contract.md §3.3`). The press's authority to write is enforced on-chain via secp256r1 signature verification on every write. Its IPFS-side identity — the key whose public key appears as `press_card` in issued `CardDocument`s — is an ML-DSA-44 keypair.

Presses are self-contained deployable units. This spec describes a **Docker container deployment** targeting any container-capable host (DigitalOcean App Platform, Droplets, Fly.io, Render, etc.). Each deployed container is a single running press. Multiple presses may be deployed — under the same or different policies — as independent containers; they do not share state.

---

## 2. Press Identity

A press has two distinct key pairs, serving distinct roles:

**ML-DSA-44 keypair (IPFS identity key)**

- The press generates this keypair at first boot if not already present.
- The public key is the press's IPFS identity. Its keccak256 hash is the press's on-chain registry address.
- Used to produce `press_signature` in every `CardDocument` and `LogEntry` the press signs.
- Used to produce `press_signature` in `SCIP` objects.
- Used to sign `AuditEpochEntry` objects.
- The private key is held in the container's runtime memory (loaded from the environment at startup). It never leaves the press process.

**secp256r1 keypair (on-chain authorization key)**

- Used to sign payloads submitted to the registry contract (`RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer`, `RegisterSubCard`, `DeregisterSubCard`, `BatchUpdateCardHeads`, `RegisterAddressForward`).
- The public key is registered on-chain in `PressAuthorizations[policy_address][press_address]`.
- Verified by the contract via the RIP-7212 precompile on every write.
- The private key is held in the container's runtime memory (loaded from the environment at startup).

**Press card (IPFS)**

The press's ML-DSA-44 public key and metadata are published as a `CardDocument` on IPFS before the press can begin operations. This card's CID is the `press_card` pointer that appears in all cards the press issues. The press card must appear in the policy's `approved_presses` list, and the press's secp256r1 key must be registered on-chain in `PressAuthorizations` for that policy before the press may issue any cards.

The press card is issued externally (by the governance body that authorizes the press) and its CID is provided to the press at configuration time via `PRESS_CARD_CID`.

---

## 3. Container Architecture

### 3.1 Dockerfile and Image

The press is a single Docker image. All dependencies are bundled; the only external runtime dependencies are the configured RPC endpoint, IPFS pinning credentials, and the key material in the environment.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
```

The `/app/data` volume contains the SQLite database file. This is the only stateful artifact. All other state is reconstructable from IPFS and Arbitrum One.

**Operator deployment:**

```bash
docker run -d \
  --name press \
  -p 3000:3000 \
  -v ./press-data:/app/data \
  --env-file press.env \
  ghcr.io/card-protocol/press:latest
```

All secrets are passed via environment variables (the `press.env` file). The container does not write secrets to disk.

---

### 3.2 Configuration

All configuration is via environment variables.

| Variable | Required | Description |
|---|---|---|
| `PRESS_CARD_CID` | Yes | CID of this press's `CardDocument` on IPFS |
| `PRESS_POLICY_CIDS` | Yes | Comma-separated list of policy card CIDs this press is authorized under |
| `PRESS_MLDSA44_PRIVATE_KEY` | Yes | Base64url-encoded ML-DSA-44 private key (IPFS identity / content signing) |
| `PRESS_SECP256R1_PRIVATE_KEY` | Yes | Hex-encoded secp256r1 private key (on-chain write authorization) |
| `ARBITRUM_RPC_URL` | Yes | Arbitrum One RPC endpoint (e.g. `https://arb1.arbitrum.io/rpc`) |
| `REGISTRY_CONTRACT_ADDRESS` | Yes | Address of the registry storage contract on Arbitrum One |
| `W3UP_KEY` | Yes | Base64url-encoded w3up agent private key |
| `W3UP_SPACE` | Yes | `did:key:...` DID of the w3up space to upload content into |
| `DATA_DIR` | No | Path to SQLite data directory. Default: `/app/data` |
| `PORT` | No | HTTP port. Default: `3000` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`. Default: `info` |
| `MAX_BATCH_SIZE` | No | Maximum cards per `BatchUpdateCardHeads` call. Default: `100` (contract maximum) |
| `STALENESS_WINDOW_SECONDS` | No | Maximum age of revocation data before press rejects issuance. Default: `300` (5 minutes) |

---

### 3.3 Persistent State — SQLite

The press uses an embedded SQLite database (WAL mode) for all runtime state. No external database is required.

**Initialization:** The database is created at `$DATA_DIR/press.db` on first boot. Schema migrations run automatically on startup.

**Backup:** Operators should back up the SQLite file regularly. On loss of the database, the press can reconstruct log head state by reading on-chain `CardEntry` records, but local rate limit counters and offer deduplication state will be lost.

```sql
-- Tracks the current log head per policy; single row per policy.
-- Row-level locking (BEGIN IMMEDIATE) prevents concurrent update races.
CREATE TABLE policy_log_heads (
  policy_card_cid  TEXT    NOT NULL PRIMARY KEY,
  log_head_cid     TEXT    NOT NULL,
  seq              INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL  -- Unix timestamp
);

-- Open offers in flight for the two-phase targeted issuance flow.
-- 'offer_cid' is the CID of the signed offer blob posted by the issuer.
CREATE TABLE offers_in_flight (
  offer_cid     TEXT    NOT NULL PRIMARY KEY,
  policy_cid    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,  -- Unix timestamp
  finalized     INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = finalized
  expires_at    INTEGER           -- Unix timestamp; null = no expiry
);

-- Per-requester and per-app-card write counts for rate limiting.
-- window_start is the Unix timestamp of the start of the current 7-day window.
CREATE TABLE rate_limit_counts (
  entity_address  TEXT    NOT NULL,  -- card registry address (keccak256 of pubkey)
  entity_type     TEXT    NOT NULL,  -- 'holder' or 'app_card'
  operation       TEXT    NOT NULL,  -- operation name (e.g. 'register_sub_card')
  policy_address  TEXT    NOT NULL,
  window_start    INTEGER NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_address, entity_type, operation, policy_address, window_start)
);

-- Per-policy weekly write totals for the press-funded write limit.
CREATE TABLE policy_write_counts (
  policy_address  TEXT    NOT NULL,
  window_start    INTEGER NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (policy_address, window_start)
);

-- Tracks open audit epochs per policy.
-- NOTE: The AEK is held in-process memory only during an open epoch; it is
-- NOT persisted to this table. If the press restarts with an open epoch, the
-- AEK must be recovered via the wrapped copies held by auditors (see OQ-A3).
CREATE TABLE audit_epochs (
  policy_card_cid  TEXT    NOT NULL,
  epoch_id         TEXT    NOT NULL,
  status           TEXT    NOT NULL,  -- 'open' or 'closed'
  epoch_start      INTEGER NOT NULL,  -- Unix timestamp
  epoch_end        INTEGER,           -- Unix timestamp; null if still open
  entry_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (policy_card_cid, epoch_id)
);
```

---

### 3.4 IPFS Pinning — web3.storage

The press uses **web3.storage (w3up)** for all IPFS content publishing and pinning. web3.storage stores content on Filecoin as well as IPFS, providing long-term persistence guarantees appropriate for card records that must remain verifiable indefinitely.

The press does not run an IPFS node. All IPFS interactions go through the w3up client library (`@web3-storage/w3up-client`).

**Initialization (at startup):**

1. The press loads the w3up agent key from `W3UP_KEY`.
2. The press connects to the w3up space identified by `W3UP_SPACE`.
3. The press confirms the space is accessible before accepting any traffic.

**Upload pattern:** All content is uploaded and pinned in a single w3up call. The w3up client returns the root CID of the uploaded content. The press validates that the returned CID is the expected hash of the uploaded bytes before recording it in any signed object or on-chain write.

**CID validation:** Before submitting any on-chain write that includes a CID, the press re-derives the expected CID from the content bytes and confirms it matches what w3up returned. A mismatch is treated as a hard error; the on-chain write is not submitted.

---

## 4. HTTP Endpoints

The press exposes an HTTP API for inbound requests from issuers, holders, and administrators.

| Method | Path | Description |
|---|---|---|
| `POST` | `/issue` | Submit a targeted issuance request (signed offer + requester card) |
| `POST` | `/issue/finalize` | Submit a countersigned offer (holder's `holder_signature`) to complete targeted issuance |
| `POST` | `/open-offer/claim` | Submit an `OpenOfferClaimSubmission` to claim a card under an open offer |
| `POST` | `/update` | Submit a signed `UpdateIntentPayload` to update or revoke a card |
| `POST` | `/sub-card/register` | Submit a signed `SubCardDocument` for press registration on-chain |
| `POST` | `/sub-card/deregister` | Submit a signed deregistration request for a sub-card |
| `GET`  | `/press` | Returns press metadata: `press_card_cid`, `policy_cids`, `log_heads`, `address` |
| `GET`  | `/health` | Liveness check. Returns `200 OK` with `{ "status": "ok" }` if the press is operational |

All `POST` endpoints accept `Content-Type: application/json`. All responses are JSON.

Endpoints return standard HTTP status codes. Press-side error codes (§7) are included in the response body as `{ "error": "<code>", "message": "<human-readable>" }`.

---

## 5. Functions

### 5.1 Card Issuance

These functions implement the targeted card issuance flow (`card_offering_and_acceptance.md`). They are invoked sequentially; the `/issue` and `/issue/finalize` endpoints call them in order.

---

#### `validateIssuanceRequest(request)`

**Called by:** `/issue` handler
**Purpose:** Perform all pre-issuance checks before the press commits to constructing an offer.

**Steps:**

1. Confirm the request includes: `policy_cid`, `requester_card_pointer`, `recipient_card_pointer` (or invitation delivery method), and any required field values.
2. Resolve the policy card from IPFS using `resolveCard(policy_cid)`.
3. Confirm the policy's `valid_until` has not passed (if set).
4. Confirm the press's own `press_card_cid` appears in `policy.approved_presses`.
5. Confirm an open audit epoch exists for this policy (via `getOpenEpoch`); if not, call `openAuditEpoch` before proceeding.
6. Call `evaluatePredicates(policy, requester_card, recipient_card)`.
7. Call `checkRateLimits('register_card', requester_card_address, policy_address)`.

**Returns:** Validated policy snapshot and resolved card chains, or an error code.

---

#### `evaluatePredicates(policy, requesterCard, recipientCard)`

**Called by:** `validateIssuanceRequest`, `processOpenOfferClaim`
**Purpose:** Evaluate the policy's `requester_predicate` and `recipient_predicate` against the resolved card chains.

**Steps:**

1. If `policy.requester_predicate` is present, evaluate it against the requester's resolved chain. Reject with `P-02` if not satisfied.
2. If `policy.recipient_predicate` is present, evaluate it against the recipient's resolved chain. Reject with `P-03` if not satisfied.
3. For every card in both chains, call `checkRevocationStatus(cardCid)`. If any ancestor card is revoked with `effective_date ≤ now`, reject with `P-04`.

**Returns:** `{ passed: true }` or an error with the first failing predicate and card.

---

#### `assembleCardDocument(policy, issuerOffer, recipientPubkey)`

**Called by:** `/issue/finalize` handler (targeted), `processOpenOfferClaim` (open offer)
**Purpose:** Build the complete `CardDocument` ready for press signing.

**Steps:**

1. Take the issuer-signed offer blob (which contains `policy_id`, `issuer_card`, `issued_at`, all policy field values, and `issuer_signature`).
2. Add `press_card: PRESS_CARD_CID`.
3. Add `recipient_pubkey` from the countersigned offer.
4. Add `holder_signature` from the countersigned offer.
5. Populate `ancestry_pubkeys`: resolve the issuer card chain and the press card chain from IPFS; collect ML-DSA-44 public keys in order from the immediate parent toward the root. Use the cached chain resolved during `evaluatePredicates`.
6. If this card is the result of a master key rotation, include `past_keys` (supplied by the holder in the rotation request).

**Returns:** Assembled `CardDocument` (all fields except `press_signature`).

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
**Purpose:** Encrypt the card, upload it to IPFS via web3.storage, and return the CID.

**Steps:**

1. Derive the content key: `HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`.
2. Encrypt the canonical RFC 8785 JSON of the signed card with AES-256-GCM (random 96-bit nonce).
3. Upload the encrypted bytes to web3.storage via `pinToIPFS(encryptedBytes)`.
4. Validate the returned CID by re-deriving it from the uploaded bytes.

**Returns:** CID of the encrypted card on IPFS.

---

#### `pinToIPFS(content)`

**Called by:** `publishCard`, `appendLogEntry`, `appendIssuanceRecord`, `openAuditEpoch`, `closeAuditEpoch`
**Purpose:** Upload bytes to web3.storage and return the root CID.

**Steps:**

1. Call `w3upClient.uploadBytes(content)` (or `uploadFile` / `uploadDirectory` as appropriate).
2. Receive the root CID from w3up.
3. Re-derive the expected CID from `content` using the same hash function (SHA2-256 / multihash).
4. Confirm the derived CID equals the returned CID. If they differ, abort and return error `P-10`.

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
7. Call `evaluatePredicates(policy, issuerCard, recipientCard)` (recipient is the submitter).
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

1. Verify `intentSignature` over canonical RFC 8785 JSON of `updateIntent` using the updater's ML-DSA-44 public key (resolved from `updateIntent.updater_card` via `resolveCard`). Reject with `P-09` on failure.
2. Confirm `updateIntent.timestamp` is within the press's staleness window. Reject stale intents.
3. Resolve the target card (`updateIntent.target_card`) via `resolveCard`.
4. Resolve the policy from the target card's `policy_id`.
5. Evaluate the relevant `update_policy` predicate for each field in `field_updates` (for 1xx–7xx codes). For revocation codes (8xx–9xx), evaluate `policy.revocation_permissions`.
6. Confirm the updater card chain satisfies the predicate. Reject with `P-11` if not.
7. Multiple revocation entries on the same card are permitted; if present, the entry with the earliest `effective_date` governs (per `card_updates.md`). Field update codes (1xx–7xx) may be applied to a card that already has a revocation entry — revocation does not block further field updates.
8. Call `checkRateLimits('update_card_head', updater_card_address, policy_address)` for 1xx codes.
9. Call `appendLogEntry(target_card, updateIntent)` to build, sign, publish, and register the new `LogEntry`.

**Returns:** `{ log_entry_cid, new_log_head_cid }` on success.

---

#### `appendLogEntry(targetCard, updateIntent)`

**Called by:** `processUpdateIntent`
**Purpose:** Build a new `LogEntry`, publish it to IPFS, and update the card's on-chain log head.

**Steps:**

1. Fetch the current log head CID for the target card (from SQLite `policy_log_heads`, or on-chain if local state is missing).
2. Assemble the `LogEntry`:
   - `version`: current log length + 1.
   - `code`: from `updateIntent.code`.
   - `entry_type`: `"field_update"` for 1xx–7xx; `"revocation"` for 8xx–9xx.
   - `prev_log_root`: current log head CID.
   - `field_updates` or `revocation`: from `updateIntent`.
   - `notify_holder`, `updater_message`: from `updateIntent`.
   - `intent_signature`: the updater's signature (passed in).
3. Serialize the `LogEntry` as canonical RFC 8785 JSON excluding `press_signature`.
4. Sign with the press's ML-DSA-44 key → `press_signature`.
5. Call `pinToIPFS(logEntryBytes)` → `log_entry_cid`.
6. Call `updateCardHeadOnChain(card_address, prev_log_cid, log_entry_cid)`.

**Returns:** `{ log_entry_cid, new_log_head_cid: log_entry_cid }`.

---

#### `updateCardHeadOnChain(cardAddress, prevLogCid, newLogCid)`

**Called by:** `appendLogEntry`, `appendIssuanceRecord` (for policy card log head)
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
5. On `E-08` (`STALE_PREV_CID`): the log head was updated by another process between the press reading it and submitting the transaction. Fetch the current on-chain head, update local SQLite state, and retry once. If still failing after one retry, return error `P-12`.

**Returns:** Transaction hash on success.

---

### 5.4 Sub-Card Registration

#### `processSubCardRegistration(subCardDoc, holderSignature)`

**Called by:** `/sub-card/register` handler
**Purpose:** Verify a completed `SubCardDocument` and register the sub-card on-chain.

**Steps:**

1. Verify `subCardDoc.app_signature` over canonical RFC 8785 JSON of the document excluding both signature fields.
2. Confirm `keccak256(subCardDoc.holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address. Reject with `P-13` on mismatch.
3. Confirm `keccak256(subCardDoc.app_card_pubkey)` equals the `app_card` pointer address. Reject with `P-13` on mismatch.
4. Verify `holderSignature` over canonical RFC 8785 JSON of the document including `app_signature`, excluding `holder_signature`, using `subCardDoc.holder_primary_card_pubkey`. Reject with `P-14` on failure.
5. Call `verifyAppCertificationChain(subCardDoc.app_card, subCardDoc.app_card_pubkey)`.
6. Confirm `attestation_level` is `"T2"` unless the governing policy explicitly accepts `"T1"`. If `"T2"`, verify `attestation_proof` against `hash(recipient_pubkey)`.
7. Call `checkRateLimits('register_sub_card', holder_card_address, policy_address)`.
8. Call `checkRateLimits('register_sub_card_app', app_card_address, policy_address)`.
9. Post the completed `SubCardDocument` to IPFS via `pinToIPFS` → `sub_card_doc_cid`.
10. Submit `RegisterSubCard` on-chain (see `registerSubCardOnChain`).
11. Notify the holder's wallet service of the successful registration via HTTPS.

**Returns:** `{ sub_card_doc_cid, tx_hash }` on success.

---

#### `verifyAppCertificationChain(appCardPointer, appCardPubkey)`

**Called by:** `processSubCardRegistration`
**Purpose:** Walk the app card's chain to confirm it reaches the governance authority's app-certification policy root. This is a press-side verification; it is not performed by the contract or by runtime verifiers.

**Steps:**

1. Confirm `keccak256(appCardPubkey)` equals `appCardPointer`. Reject with `P-13` on mismatch.
2. Derive the app card's content key: `HKDF-SHA3-256(appCardPubkey, info="card-content-v1")`.
3. Fetch and decrypt the app card from IPFS via `resolveCard(appCardPointer)`.
4. Walk the app card's `ancestry_pubkeys` chain toward the root, applying the binding check (`keccak256(entry_pubkey)` must equal the on-chain address for that link) at each hop.
5. Confirm the chain terminates at the governance authority's app-certification policy root (registered in `PolicyAuthorizerKeys` on-chain).
6. Reject with `P-15` if the chain does not reach the expected root.

**Returns:** `{ certified: true }` or an error.

---

#### `registerSubCardOnChain(subCardAddress, masterCardAddress, registrationLogHead, subCardDocCid)`

**Called by:** `processSubCardRegistration`
**Purpose:** Submit `RegisterSubCard` to the registry contract.

**Steps:**

1. Confirm the requesting app's gas balance is sufficient. Reject with `P-16` if insufficient (do not sponsor; the press does not self-fund sub-card registration).
2. Build the `RegisterSubCardPayload` and sign with secp256r1.
3. Call `RegisterSubCard(sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, master_sig_payload, master_signature)` on the registry.

**Returns:** Transaction hash on success.

---

#### `processSubCardDeregistration(subCardAddress, masterSignature, sigPayload)`

**Called by:** `/sub-card/deregister` handler
**Purpose:** Verify the holder's deregistration request and submit `DeregisterSubCard` on-chain.

**Steps:**

1. Resolve the `SubCardEntry` on-chain for `subCardAddress`; confirm it is active.
2. Fetch the `SubCardDocument` from IPFS using `sub_card_doc_cid` from the on-chain entry.
3. Resolve the master card from `subCardDoc.holder_primary_card` via `resolveCard`.
4. Verify `masterSignature` over canonical RFC 8785 JSON of `sigPayload` using the master card's primary key. Reject with `P-14` on failure.
5. Check the requesting app's gas balance.
   - If sufficient: deduct the gas cost from the app balance and submit `DeregisterSubCard`.
   - If zero: sponsor from the issuing organization's press balance and submit. Deregistration must never be blocked by a depleted app balance.
6. Call `DeregisterSubCard(sub_card_address, sig_payload, master_signature)` on the registry.

**Returns:** Transaction hash on success.

---

### 5.5 Chain Verification

#### `resolveCard(cardPointerOrCid)`

**Called by:** All functions that need to read card content
**Purpose:** Fetch a card's `CardDocument` from IPFS by its on-chain registry pointer or its content CID.

**Steps:**

1. If given a registry pointer (bytes32 address): call `GetCardEntry(address)` on the registry contract to get `log_head_cid`. Follow `forward_to` if non-zero.
2. Fetch the encrypted bytes at the CID from IPFS via the w3up gateway.
3. Identify the `recipient_pubkey` of the card (requires knowing it to derive the content key). For known presses and policy cards, the public key is cached or provided. For chains being walked, the `ancestry_pubkeys` field provides the hint; apply the binding check before use.
4. Derive content key: `HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`.
5. Decrypt with AES-256-GCM. Hard-reject on authentication failure.
6. Parse and return the `CardDocument`.

**Returns:** Decrypted `CardDocument`.

---

#### `verifyCardChain(cardPointer, trustedRoots)`

**Called by:** `evaluatePredicates`, `processOpenOfferClaim`, `verifyAppCertificationChain`
**Purpose:** Walk a card's chain from the given pointer back to a trusted root, verifying every link.

**Steps:**

1. Call `resolveCard(cardPointer)` → `card`.
2. Verify `card.issuer_signature` against `card.ancestry_pubkeys[0]` (the immediate parent's public key). Apply binding check: `keccak256(ancestry_pubkeys[0])` must equal the `issuer_card` pointer address. Reject on mismatch or signature failure.
3. Call `checkRevocationStatus(cardPointer)`.
4. If the current card's address is in `trustedRoots`, terminate — chain is valid.
5. Recurse on `card.issuer_card`.

**Returns:** `{ valid: true, chain: [CardDocument] }` or a specific error.

---

#### `checkRevocationStatus(cardPointerOrCid)`

**Called by:** `verifyCardChain`, `evaluatePredicates`
**Purpose:** Determine whether a card has a revocation entry in its log with `effective_date ≤ now`.

**Steps:**

1. Fetch the current `log_head_cid` for the card (on-chain via `GetCardEntry`).
2. Walk the CID-linked log from the head backward (following `prev_log_root`) until a `LogEntry` with `code` in 8xx–9xx is found, or the genesis `CardDocument` is reached.
3. Confirm the log walk does not exceed a configurable maximum depth.
4. If a revocation entry is found with `effective_date ≤ now`, return `{ revoked: true, effective_date, code }`.
5. Confirm the log head CID was fetched within `STALENESS_WINDOW_SECONDS`. If the on-chain read took longer than the staleness window (e.g., due to RPC latency or cache use), return error `P-17`. The press must refuse issuance if it cannot confirm it is reading a recent view of the revocation state; `STALENESS_WINDOW_SECONDS` bounds how stale an "all clear" from this function may be.

**Returns:** `{ revoked: false }` or `{ revoked: true, ... }` or error `P-17`.

---

### 5.6 Log Management

#### `getLogHead(policyCid)`

**Called by:** `appendIssuanceRecord`, `openAuditEpoch`, `closeAuditEpoch`
**Purpose:** Return the current log head CID for a policy card's press log.

**Steps:**

1. Check SQLite `policy_log_heads` for the policy CID.
2. If not present (first run or after recovery), read from on-chain via `GetCardEntry(policy_address)`.
3. Return `{ log_head_cid, seq }`.

---

#### `appendIssuanceRecord(policyCid, cardCid, recipientPubkey, offerType)`

**Called by:** `/issue/finalize` handler, `processOpenOfferClaim`
**Purpose:** Encrypt a `PressIssuanceRecord` with the current epoch AEK, upload to IPFS, and update the policy card's log head.

**Steps:**

1. Call `getOpenEpoch(policyCid)` → `{ epoch_id, aek }`.
2. Assemble the `PressIssuanceRecord` plaintext:
   ```json
   {
     "epoch_id": "<epoch_id>",
     "card_cid": "<cardCid>",
     "recipient_pubkey": "<base64url — ML-DSA-44 pubkey>",
     "scip_cid": "<scip_cid>",
     "issued_at": "<ISO 8601>",
     "offer_type": "<offerType>"
   }
   ```
3. Encrypt with AES-256-GCM using the epoch AEK and a fresh 96-bit random nonce.
4. Wrap in the outer storage envelope: `{ epoch_id (plaintext), nonce, ciphertext }`.
5. Call `pinToIPFS(envelope)` → `record_cid`.
6. Build a new log entry (append operation) linking to the current log head.
7. Using `BEGIN IMMEDIATE` in SQLite to prevent concurrent appends: get current log head, construct the new linked entry, call `pinToIPFS(new_log_entry)`, then call `updateCardHeadOnChain(policy_card_address, prev_cid, new_cid)`.
8. Update SQLite `policy_log_heads` and `audit_epochs.entry_count`.

**Returns:** `{ record_cid, new_log_head_cid, entry_index }`.

---

### 5.7 Audit Epoch Management

#### `getOpenEpoch(policyCid)`

**Called by:** `appendIssuanceRecord`, `validateIssuanceRequest`
**Purpose:** Return the current open audit epoch for a policy. Opens a new epoch if none exists.

**Steps:**

1. Query SQLite `audit_epochs` for `policy_card_cid = policyCid AND status = 'open'`.
2. If found, return `{ epoch_id, aek }`.
3. If not found, call `openAuditEpoch(policyCid)` and return the new epoch.

---

#### `openAuditEpoch(policyCid)`

**Called by:** `getOpenEpoch`
**Purpose:** Start a new audit epoch, distribute the epoch AEK to all auditors, and post the `AuditEpochEntry` to the policy log.

**Steps:**

1. Generate a fresh 256-bit random AEK.
2. Determine the `epoch_id` (convention: ISO year string for annual epochs; or a monotonically incrementing integer).
3. Resolve the policy card via `resolveCard(policyCid)` to get the `auditors` list.
4. For each auditor in `policy.auditors`:
   - Fetch the auditor's card from IPFS.
   - Derive the auditor's ML-KEM-768 public key (from auditor card's `recipient_pubkey` via HKDF or a dedicated KEM key field — see OQ-A1).
   - Call `ML-KEM.Encaps(auditor_pubkey)` → `{ kem_ciphertext, kem_shared_secret }`.
   - Derive wrap key: `HKDF-SHA3-256(kem_shared_secret, "audit-epoch-aek-v1")`.
   - Encrypt AEK with AES-256-GCM using the wrap key → `wrapped_aek`.
5. Assemble the `AuditEpochEntry`:
   ```json
   {
     "type": "audit_epoch_entry",
     "status": "open",
     "epoch_id": "<epoch_id>",
     "epoch_start": "<ISO 8601 now>",
     "epoch_end": null,
     "auditor_key_packages": [ ... ],
     "commitment_cid": null,
     "close_reason": null
   }
   ```
6. Sign with the press's ML-DSA-44 key → `press_signature`.
7. Call `pinToIPFS(epochEntry)` → `entry_cid`.
8. Call `updateCardHeadOnChain(policy_card_address, prev_cid, entry_cid)` to anchor the open epoch in the policy log.
9. Store `{ policy_card_cid, epoch_id, status: 'open', epoch_start }` in SQLite `audit_epochs`. Hold the AEK in process memory only; do not persist it. See OQ-A3 for the restart-recovery implications.

**Returns:** `{ epoch_id, aek }`.

---

#### `closeAuditEpoch(policyCid, closeReason)`

**Called by:** Operator-initiated (e.g., at calendar year boundary, key rotation, or auditor change)
**Purpose:** Close the current open epoch and post a closing `AuditEpochEntry` to the policy log.

**Steps:**

1. Fetch the current open epoch from SQLite.
2. Assemble a closing `AuditEpochEntry` with `status: "closed"`, `epoch_end: now`, `close_reason`, and `auditor_key_packages: []`.
3. Sign and pin to IPFS.
4. Call `updateCardHeadOnChain(policy_card_address, prev_cid, closing_entry_cid)`.
5. Update SQLite `audit_epochs` to `status: 'closed'`, record `epoch_end`.
6. Destroy the in-memory AEK (zero the memory region). There is no persisted copy to clear.

**Note:** After epoch close, the press must not generate issuance records for that epoch. `openAuditEpoch` must be called before the next issuance.

---

### 5.8 On-Chain Operations

#### `buildPressSignedPayload(op, fields)`

**Called by:** All on-chain write functions
**Purpose:** Construct and sign the canonical payload for an on-chain registry write.

**Steps:**

1. Assemble the payload object with `op`, all operation-specific fields, `press_address`, the current `sequence` (fetched from SQLite or from on-chain if stale), and `timestamp`.
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

**Note:** The press does not cache this value locally; it always reads from the contract to avoid sequence mismatches after restarts or concurrent writes. A `SEQUENCE_MISMATCH` (E-07) revert triggers an immediate re-read and one retry.

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
6. On success, increment `next_sequence` by 1 (not by the number of items).

**Returns:** Transaction hash.

---

### 5.9 Rate Limiting

#### `checkRateLimits(operation, entityAddress, policyAddress)`

**Called by:** `validateIssuanceRequest`, `processUpdateIntent`, `processSubCardRegistration`
**Purpose:** Enforce per-entity and per-policy write rate limits before processing any operation.

**Steps:**

1. Determine the 7-day window start: `floor(now / 7_days) * 7_days`.
2. Query SQLite for `rate_limit_counts` where `entity_address = entityAddress AND operation = operation AND policy_address = policyAddress AND window_start = windowStart`.
3. If `count >= limit` for this operation (see §6), reject with `P-18`.
4. Separately check `policy_write_counts` for the press-funded weekly total. Reject with `P-19` if at or above the per-policy limit.
5. If within limits, increment the count (deferred — actual increment happens after the operation succeeds, in `recordWrite`).

---

#### `recordWrite(operation, entityAddress, policyAddress)`

**Called by:** All write-completing handlers, after a successful on-chain transaction
**Purpose:** Increment rate limit counters after a successful write.

**Steps:**

1. Begin SQLite transaction.
2. Upsert `rate_limit_counts` (increment `count` by 1).
3. Upsert `policy_write_counts` (increment `count` by 1).
4. Commit.
5. If total is now ≥ 80% of any limit, call `sendSuspiciousActivityAlert`.

---

#### `sendSuspiciousActivityAlert(entityAddress, entityType, operation, currentCount, limit, policyAddress)`

**Called by:** `recordWrite`
**Purpose:** Notify the card-granting agency when write volume approaches a limit.

**Steps:**

1. Resolve the policy card from IPFS to get the granting agency's wallet service endpoint.
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

### 5.10 Gas Management

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

1. Query the press's internal ledger (SQLite, app gas accounts table — see OQ-A2) for the current balance of `appCardAddress`.
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
| `P-02` | `requester_predicate` not satisfied |
| `P-03` | `recipient_predicate` not satisfied |
| `P-04` | Ancestor card revoked with `effective_date ≤ now` |
| `P-05` | Invalid `issuer_signature` on open offer (binding check failed or ML-DSA-44 sig invalid) |
| `P-06` | Invalid `recipient_signature` on open offer claim |
| `P-07` | Open offer expired (press-side pre-flight before on-chain submission) |
| `P-08` | Open offer at capacity (press-side pre-flight) |
| `P-09` | Invalid `intent_signature` on `UpdateIntentPayload` |
| `P-10` | CID mismatch: derived CID does not match CID returned by web3.storage |
| `P-11` | `update_policy` predicate not satisfied for one or more field updates |
| `P-12` | `STALE_PREV_CID` revert on retry — concurrent log head conflict not resolvable |
| `P-13` | Pubkey binding check failed: `keccak256(pubkey) ≠ pointer address` |
| `P-14` | Invalid master card holder ML-DSA-44 signature (sub-card registration or deregistration) |
| `P-15` | App card chain does not reach the governance app-certification policy root |
| `P-16` | App gas account balance insufficient for `RegisterSubCard` |
| `P-17` | Revocation data is stale — cannot confirm freshness within staleness window |
| `P-18` | Per-entity rate limit reached for this operation |
| `P-19` | Per-policy press-funded write limit reached |
| `P-20` | Insufficient ETH balance to cover estimated gas cost |
| `P-21` | Policy `valid_until` has passed; press will not issue new cards under this policy |
| `P-22` | Offer timestamp is stale (replay prevention) |
| `P-24` | web3.storage upload failed; IPFS pin not confirmed |

---

## 8. Key Rotation

**secp256r1 key rotation:** If the press's on-chain authorization key is compromised or requires routine rotation, the Press Registry Governance Body calls `AuthorizePress` with the press's `press_address` and a new `press_pubkey`. The press must be restarted with the new `PRESS_SECP256R1_PRIVATE_KEY`. No SQLite changes are required; the `next_sequence` is reset on-chain.

**ML-DSA-44 key rotation:** Rotating the press's IPFS identity key requires issuing a new press card with the new public key, updating the policy's `approved_presses` list, registering the new press card on-chain via `AuthorizePress`, and redeploying the container with updated `PRESS_MLDSA44_PRIVATE_KEY` and `PRESS_CARD_CID`. Cards previously issued under the old press card remain valid; their `press_card` pointer is immutable.

**On-chain key scheme upgrade (secp256r1 → ML-DSA-44):** When the protocol advances to Phase 2 or Phase 3 (see `ARCHITECTURE.md` ADR-012), the press submits `RotateOnChainKeyScheme` with a dual-signature payload. This operation is self-initiated by the press; no governance action is required. The press must be restarted after the rotation transaction confirms so that subsequent writes use the ML-DSA-44 on-chain signing path.

---

## 9. Open Questions

| ID | Area | Question |
|---|---|---|
| **OQ-A1** | Audit | `openAuditEpoch` requires ML-KEM-768 public keys for each auditor. `CardDocument` stores only ML-DSA-44 keys (`recipient_pubkey`). Where is the auditor's KEM public key stored? Options: a dedicated field in the auditor's `CardDocument`, a separate KEM key document on IPFS, or derived from the ML-DSA-44 key (not recommended — different security properties). This is required before `openAuditEpoch` can be implemented. |
| **OQ-A2** | Gas | The app gas account ledger (pre-funded balances for `RegisterSubCard` and `DeregisterSubCard`) is not yet specified. What is the mechanism for apps to pre-fund their balance with the press — direct ETH transfer? A signed credit request? The press needs to track per-app balances and deduct on each sub-card operation. |
| **OQ-A3** | Recovery | The AEK is held in process memory only during an open epoch (not persisted). If the press restarts unexpectedly during an open epoch, the AEK is lost from memory. To resume encrypting issuance records, the press must either: (a) coordinate with auditors to decapsulate the epoch AEK from their wrapped copies and re-supply it out-of-band (operationally complex), or (b) close the interrupted epoch immediately on restart and open a new one (losing some entries from the interrupted epoch's audit log). The preferred recovery path must be specified before production deployment. |
| **OQ-A4** | Serialization | The canonical serialization format for all signed payloads is stated as RFC 8785 (see `ARCHITECTURE.md` ADR-010), but ADR-010 records this as unresolved. This spec proceeds on the assumption RFC 8785 is adopted. If CBOR is chosen instead, all `buildPressSignedPayload` and signing functions must be updated. |

---

*Related specs: `protocol-objects.md`, `registry_contract.md`, `process_specs/card_offering_and_acceptance.md`, `process_specs/open_offer_creation.md`, `process_specs/card_updates.md`, `process_specs/log_auditing.md`, `ARCHITECTURE.md` ADR-005, ADR-011, ADR-012.*
