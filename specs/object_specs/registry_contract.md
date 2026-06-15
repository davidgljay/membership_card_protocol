# Card Protocol — Registry Contract Spec

**Version:** 0.2 (draft)  
**Date:** 2026-06-14  
**Status:** Draft  
**Contract target:** Arbitrum One (Stylus / WASM-compiled Rust)  
**Amends:** v0.1 — on-chain verification changed from ML-DSA-44 to secp256r1/RIP-7212 per ADR-012. Key sizes updated throughout. ML-DSA-44 key hashes retained in `PressAuthorizations` for upgrade path.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Relationship to Existing Specs](#2-relationship-to-existing-specs)
3. [Storage Layout](#3-storage-layout)
   - 3.1 [Per-Card Registry Entries](#31-per-card-registry-entries)
   - 3.2 [PolicyAuthorizerKeys](#32-policyauthorizerkeys)
   - 3.3 [PressAuthorizations](#33-pressauthorizations)
   - 3.4 [SubCardRegistrations](#34-subcardregistrations)
   - 3.5 [OpenOfferUseCounts](#35-openofferusecounts)
   - 3.6 [GovernanceKeysets](#36-governancekeysets)
4. [Write Operations](#4-write-operations)
   - 4.1 [RegisterCard](#41-registermark)
   - 4.2 [UpdateMarkHead](#42-updatemarkhead)
   - 4.3 [RegisterSubCard](#43-registersubcard)
   - 4.4 [DeregisterSubCard](#44-deregistersubcard)
   - 4.5 [ClaimOpenOffer](#45-claimopenoffer)
   - 4.6 [RegisterPolicy](#46-registerpolicy)
   - 4.7 [AuthorizePress](#47-authorizepress)
   - 4.8 [RevokePress](#48-revokepress)
   - 4.9 [RotateAuthorizerKey](#49-rotateauthorizerkey)
   - 4.10 [RotateGovernanceKeys](#410-rotategovernancekeys)
5. [Read Operations](#5-read-operations)
6. [Authorization Model](#6-authorization-model)
   - 6.1 [Card Write Gate](#61-card-write-gate)
   - 6.2 [Governance Quorum Verification](#62-governance-quorum-verification)
7. [Events](#7-events)
8. [Error Codes](#8-error-codes)
9. [Open Questions](#9-open-questions)

---

## 1. Overview

The Card Protocol registry contract is the single Arbitrum One contract that tracks the current state of every registered card. It is the canonical, tamper-resistant source of truth for:

- **Card state:** the current log head CID for each card (the pointer verifiers follow to read a card's full history on IPFS).
- **Card provenance:** the policy under which each card was issued and the press that last wrote to it.
- **Press authorization:** which presses are permitted to write to cards under which policies.
- **Sub-card bindings:** the master card for each registered sub-card, enabling device delegation.
- **Open offer tracking:** acceptance counts for rate-limited open offers.

The contract is the protocol's **write gatekeeper** — it enforces press authorization on every card write before accepting state changes. It does not store card content; all content lives on IPFS. The contract stores only pointers and authorization tables.

The contract verifies press and governance signatures on-chain using the **RIP-7212 secp256r1 precompile** (P-256, ~3,450 gas per verification). This is the mechanism by which the contract confirms that a write is signed by a key registered to an authorized press. Without on-chain signature verification, the contract would be a passive log; with it, it is an enforced authorization boundary.

The contract is implemented in **Stylus** (WASM-compiled Rust) to retain the upgrade path to ML-DSA-44 on-chain verification when quantum computing makes secp256r1 vulnerable. The Stylus runtime supports WASM-compiled ML-DSA-44 verification; it is not used for Phase 1 writes but is available via a `UpgradeVerifier` governance operation (§6.3). See ADR-012 for the full upgrade path.

---

## 2. Relationship to Existing Specs

This spec extends and supersedes the `RegistryEntry` description in `protocol-objects.md §14`. The per-card entry structure defined there — `(address, log_head_cid)` — is expanded here with two additional on-chain fields: `policy_address` and `last_press_address` (§3.1). **`protocol-objects.md §14` has been updated (2026-06-14) to show the full 4-field `CardEntry` struct and reference this spec as authoritative.**

The governance tables (`PolicyAuthorizerKeys`, `PressAuthorizations`, `RegisterPolicy`, `AuthorizePress`, `RevokePress`, `RotateAuthorizerKey`) are adopted from `ARCHITECTURE.md` ADR-011, which is the authoritative source for their original specification. This document extends them with the full function signatures, authorization checks, and storage layout required for implementation.

---

## 3. Storage Layout

### 3.1 Per-Card Registry Entries

One entry per registered card. Keyed by `card_address`.

```
CardEntries: mapping (bytes32 → CardEntry)

CardEntry {
    log_head_cid      bytes         — Current IPFS log head CID.
                                      Public mode:  plaintext CID bytes.
                                      Private mode: ML-KEM-encrypted CID bytes.
                                      Updated on every successful RegisterCard or UpdateMarkHead call.

    policy_address    bytes32       — On-chain registry address of the policy card under which
                                      this card was issued. Set at RegisterCard time; immutable
                                      thereafter. Used by the write gate to look up
                                      PressAuthorizations[policy_address, press_address].

    last_press_address bytes32      — On-chain registry address of the press sub-card whose key
                                      signed the most recent write (RegisterCard or UpdateMarkHead).
                                      Updated on every successful write. Provides an on-chain
                                      attribution trail independent of IPFS content.

    exists            bool          — True once the entry has been created by RegisterCard;
                                      used to distinguish unregistered addresses from cards
                                      whose log_head_cid is empty.
}
```

**Address derivation (client-side, not enforced by contract):**

| Privacy mode | Address derivation |
|---|---|
| Public | `keccak256(recipient_pubkey)` |
| Private | `keccak256(sign(recipient_private_key, "card-address-v1"))` |

The contract does not distinguish between public and private addresses; both are `bytes32` keys. The privacy properties are enforced by the client's choice of derivation and by whether `log_head_cid` is stored as plaintext or encrypted bytes.

**Encoding of `log_head_cid`:** The CID is stored as raw bytes (multihash format). Maximum length is 64 bytes, which accommodates SHA2-256 (34 bytes), SHA3-256 (34 bytes), and BLAKE3 (34 bytes) CIDs. The contract does not validate CID format; format is the press's responsibility.

---

### 3.2 PolicyAuthorizerKeys

Maps each registered root policy address to the secp256r1 public key whose signatures are authoritative for press management under that policy.

```
PolicyAuthorizerKeys: mapping (bytes32 → bytes[64])

key:   policyAddress (bytes32)    — On-chain registry address of the policy card.
value: authorizerPublicKey (bytes[64]) — secp256r1 public key (uncompressed x||y, 32+32 bytes)
                                         of the policy's authorizer.
                                         Presence of an entry is what makes policyAddress
                                         a recognized root policy in the contract's view.
```

Signatures against this key are verified via RIP-7212. An entry in `PolicyAuthorizerKeys` is created by `RegisterPolicy` (§4.6). It is updated (key rotated) by `RotateAuthorizerKey` (§4.9). There is no delete — once registered, a policy address remains in the table permanently, with key rotation as the replacement mechanism.

---

### 3.3 PressAuthorizations

Maps `(policyAddress, pressAddress)` pairs to the press's active signing key and authorization status.

```
PressAuthorizations: mapping (bytes32 → mapping (bytes32 → PressAuthEntry))

PressAuthEntry {
    press_public_key  bytes[64]      — secp256r1 public key (uncompressed x||y) for this press's
                                      on-chain write authorization. The contract verifies press
                                      signatures against this key via RIP-7212 on every card write.
                                      This is separate from the press's ML-DSA-44 content-signing
                                      key (which lives on the press CardDocument in IPFS).

    mldsa44_key_hash  bytes32        — keccak256 of the press's ML-DSA-44 public key (1312 bytes).
                                      Registered at AuthorizePress time for the Phase 2 on-chain
                                      key upgrade path (ADR-012). Not verified during Phase 1 writes.
                                      When the press submits RotateOnChainKeyScheme, the supplied
                                      ML-DSA-44 public key must hash to this value (or an updated
                                      hash can be provided alongside the rotation).

    key_scheme        uint8          — 0 = secp256r1 (Phase 1 default).
                                      1 = mldsa44 (after RotateOnChainKeyScheme completes).
                                      Determines which key and verification path are used for writes.

    active            bool           — True = press may write to cards under this policy.
                                      False = press has been revoked; existing cards unaffected,
                                      new writes rejected.

    next_sequence     uint64         — Monotonically incrementing counter used for replay prevention
                                      on press-signed payloads. Each accepted write increments this
                                      by 1. The press must include the current next_sequence value
                                      in its signed payload; the contract rejects any payload whose
                                      sequence does not match. Initialized to 0 at AuthorizePress.
                                      Resets to 0 on key rotation.

    authorized_at     uint64         — Unix timestamp of the most recent AuthorizePress call
                                      for this (policy, press) pair. Retained for audit purposes.

    revoked_at        uint64         — Unix timestamp of RevokePress, if called; 0 if never revoked.
                                      Entry is retained with active=false rather than deleted,
                                      preserving the on-chain audit trail.
}
```

**Write gate check:** On any card write (RegisterCard, UpdateMarkHead), the contract:

1. Resolves `policyAddress` from the target `CardEntry.policy_address`.
2. Looks up `PressAuthorizations[policyAddress][pressAddress]`.
3. Rejects if no entry exists, if `active == false`, or if the signature does not verify against `press_public_key`.

---

### 3.4 SubCardRegistrations

Maps a sub-card's registry address to its master card's registry address and the log head CID of the master card at sub-card registration time.

```
SubCardRegistrations: mapping (bytes32 → SubCardEntry)

SubCardEntry {
    master_mark_address     bytes32   — Registry address of the master card.

    registration_log_head   bytes     — Log head CID of the master card at the time this
                                        sub-card was registered. Used for scope-attenuation
                                        verification: the sub-card cannot have been granted
                                        authority the master did not hold at registration time.

    active                  bool      — True until DeregisterSubCard is called. Verifiers
                                        reject signatures from sub-cards with active=false.

    registered_at           uint64    — Unix timestamp of registration.
    deregistered_at         uint64    — Unix timestamp of deregistration; 0 if still active.
}
```

---

### 3.5 OpenOfferUseCounts

Tracks acceptance counts for open card offers. Keyed by the offer's canonical ID.

```
OpenOfferUseCounts: mapping (bytes32 → uint64)

key:   offer_id (bytes32)   — keccak256(canonical CBOR of the complete OpenMarkOffer document
                               including issuer_signature). Lazily initialized on first accepted claim.
value: use_count (uint64)   — Number of accepted claims under this offer. Atomically incremented
                               by ClaimOpenOffer (§4.5).
```

The contract enforces `use_count < max_acceptances` (skipped if `max_acceptances == type(uint64).max`) and `block.timestamp < expires_at` (skipped if `expires_at == 0`) atomically within the same transaction via `ClaimOpenOffer`, preventing race conditions. The press maps a document-level `null` `max_acceptances` to `type(uint64).max` in calldata; `null` `expires_at` maps to `0`.

---

### 3.6 GovernanceKeysets

Two governance bodies, each with an M-of-N quorum key set. Each body's keyset is stored separately.

```
GovernanceKeysets: mapping (GovernanceBodyId → GovernanceKeyset)

GovernanceBodyId: enum { RootPolicyBody, PressRegistryBody }

GovernanceKeyset {
    keys          bytes[64][]     — Ordered array of active secp256r1 public keys (64 bytes each,
                                    uncompressed x||y). Verified via RIP-7212 precompile.
                                    Phase 2: upgraded to ML-DSA-44 keys (bytes[1312][]) via
                                    RotateGovernanceKeys when the on-chain key upgrade occurs.
    quorum        uint8           — Minimum number of signatures required from keys[] to approve
                                    a governance action. Must be > len(keys)/2 (majority).
    version       uint32          — Incremented on every RotateGovernanceKeys call; included in
                                    the signed payload to prevent governance rotation replays.
    key_scheme    uint8           — 0 = secp256r1 (Phase 1). 1 = mldsa44 (after upgrade).
                                    Determines which precompile/verifier is used for quorum checks.
}
```

**Which body governs which operations:**

| Operation | Governing body |
|---|---|
| `RegisterPolicy` | `RootPolicyBody` |
| `AuthorizePress` | `PressRegistryBody` |
| `RevokePress` | `PressRegistryBody` |
| `RotateAuthorizerKey` | `RootPolicyBody` |
| `RotateGovernanceKeys` | The body whose keyset is being rotated (self-amending) |

Both bodies govern with the same quorum verification logic; they differ only in what operations they unlock.

**Bootstrap (OQ-15, resolved 2026-06-14):** The contract is deployed with a 1-of-1 governance keyset (single deployer key, `quorum = 1`). As additional governance members are invited in, the deployer calls `RotateGovernanceKeys` to expand `keys[]` and raise `quorum`. Once the board has multiple members, all further additions and removals require a quorum vote via `RotateGovernanceKeys`. The quorum threshold itself is board-updatable through the same self-amending operation. No deploy-time timelock or external multisig is required; the single-key bootstrap is the accepted initial trust anchor.

---

## 4. Write Operations

All write operations emit a corresponding event (§7) on success.

---

### 4.1 RegisterCard

**Called by:** Press (authorized for the target policy)  
**Purpose:** Create the initial registry entry for a newly-issued card.

```
RegisterCard(
    card_address       bytes32,   — Derived by client; see §3.1 address derivation
    initial_log_cid    bytes,     — CID of the genesis CardDocument on IPFS
    policy_address     bytes32,   — Registry address of the governing policy card
    press_sig_payload  bytes,     — Canonical CBOR of the RegisterCardPayload (see below)
    press_signature    bytes[64]  — secp256r1 signature (r||s) over keccak256(press_sig_payload),
                                    verified via RIP-7212 against PressAuthorizations.press_public_key
) → void
```

**`RegisterCardPayload` (signed by press):**

```json
{
  "op":              "register_card",
  "card_address":    "<base64url — bytes32>",
  "initial_log_cid": "<base64url — CID bytes>",
  "policy_address":  "<base64url — bytes32>",
  "press_address":   "<base64url — bytes32>",
  "sequence":        <uint64 — must equal PressAuthorizations[policy][press].next_sequence>,
  "timestamp":       "<ISO 8601 — press rejects stale payloads>"
}
```

**Preconditions checked by contract:**

1. `card_address` does not already exist in `CardEntries` (no re-registration).
2. `policy_address` exists in `PolicyAuthorizerKeys` (recognized policy).
3. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
4. `press_signature` verifies against `PressAuthorizations[policy_address][press_address].press_public_key` over `press_sig_payload`.
5. `sequence` in `press_sig_payload` equals `PressAuthorizations[policy_address][press_address].next_sequence` (replay prevention). On success, `next_sequence` is incremented by 1.

**State changes:**

- Creates `CardEntries[card_address] = { log_head_cid: initial_log_cid, policy_address: policy_address, last_press_address: press_address, exists: true }`.

---

### 4.2 UpdateMarkHead

**Called by:** Press (authorized for the card's policy)  
**Purpose:** Advance the card's log head to a new CID after any post-genesis update (field change, annotation, revocation).

```
UpdateMarkHead(
    card_address      bytes32,   — Existing card to update
    new_log_cid       bytes,     — CID of the new log head (latest LogEntry on IPFS)
    press_sig_payload bytes,     — Canonical CBOR of the UpdateMarkHeadPayload (see below)
    press_signature   bytes[64]  — secp256r1 signature (r||s) over keccak256(press_sig_payload)
) → void
```

**`UpdateMarkHeadPayload` (signed by press):**

```json
{
  "op":              "update_mark_head",
  "card_address":    "<base64url — bytes32>",
  "prev_log_cid":    "<base64url — current log_head_cid; prevents lost-update race>",
  "new_log_cid":     "<base64url — CID bytes>",
  "press_address":   "<base64url — bytes32>",
  "sequence":        <uint64 — must equal PressAuthorizations[policy][press].next_sequence>,
  "timestamp":       "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `card_address` exists in `CardEntries`.
2. `CardEntries[card_address].policy_address` exists in `PolicyAuthorizerKeys`.
3. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
4. `press_signature` verifies against `press_public_key`.
5. `prev_log_cid` matches `CardEntries[card_address].log_head_cid` (optimistic concurrency check — prevents a press from writing on top of a stale view).
6. `sequence` equals `PressAuthorizations[policy_address][press_address].next_sequence`. On success, `next_sequence` is incremented by 1.

**State changes:**

- Updates `CardEntries[card_address].log_head_cid = new_log_cid`.
- Updates `CardEntries[card_address].last_press_address = press_address`.

**Note on revocations:** The contract does not distinguish between update codes (field changes vs. revocations). Both use `UpdateMarkHead`. The update code semantics (1xx–9xx) live in the LogEntry stored on IPFS; the contract is code-agnostic. Revocation status is determined by verifiers reading the log from IPFS, not by on-chain state beyond the head pointer.

---

### 4.3 RegisterSubCard

**Called by:** Press (authorized for the card's policy), on behalf of the sub-card holder. Gas is paid from the requesting app's pre-funded gas account with the press (see §4.11). The press verifies the holder's authorization off-chain before submitting; the holder's signature in `master_sig_payload` is included for auditability.  
**Purpose:** Register a new sub-card (device key delegation) under a master card.

```
RegisterSubCard(
    sub_card_address       bytes32,    — Registry address of the new sub-card
    master_mark_address    bytes32,    — Registry address of the master card
    registration_log_head  bytes,      — Current log_head_cid of master card (snapshot for scope check)
    master_sig_payload     bytes,      — Canonical CBOR of the RegisterSubCardPayload
    master_signature       bytes[2420] — ML-DSA-44 signature over master_sig_payload,
                                         using the master card's holder key.
                                         Note: master card holder keys are ML-DSA-44 (IPFS identity
                                         keys); this is not a secp256r1 signature. The press verifies
                                         this off-chain against the holder's CardDocument pubkey.
) → void
```

**`RegisterSubCardPayload`:**

```json
{
  "op":                       "register_sub_card",
  "sub_card_address":         "<base64url — bytes32>",
  "master_mark_address":      "<base64url — bytes32>",
  "registration_log_head":    "<base64url — CID bytes>",
  "sequence":                 <uint64 — must equal PressAuthorizations[policy][press].next_sequence>,
  "timestamp":                "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `master_mark_address` exists in `CardEntries`.
2. `sub_card_address` does not already exist in `SubCardRegistrations` with `active == true`.
3. `registration_log_head` matches `CardEntries[master_mark_address].log_head_cid` at call time. (Ensures the snapshot is current; prevents a holder from registering a sub-card claiming authority the master no longer holds.)
4. `master_signature` verifies against the master card holder's public key.

> **Resolution (INC-10/OQ-4/OQ-16):** All writes go through a press. The press verifies `master_signature` off-chain against the holder public key from the card's `CardDocument` (fetched from IPFS). The contract verifies only press authorization (§6.1 write gate). The holder signature in calldata remains as an auditable proof of holder intent; the press bears responsibility for off-chain verification and is sanctioned/revoked if it submits unauthorized registrations.

**State changes:**

- Creates `SubCardRegistrations[sub_card_address] = { master_mark_address, registration_log_head, active: true, registered_at: block.timestamp, deregistered_at: 0 }`.

---

### 4.4 DeregisterSubCard

**Called by:** Press (authorized for the card's policy), on behalf of the sub-card holder or issuing organization. Gas is paid by the issuing organization's press in all cases (see §4.11).  
**Purpose:** Mark a sub-card as inactive (lost device, key rotation, app access revocation). Existing signatures from the sub-card that predate deregistration remain verifiable; new authentications using that sub-card key are rejected by verifiers.

```
DeregisterSubCard(
    sub_card_address   bytes32,
    sig_payload        bytes,
    signature          bytes[2420]  — ML-DSA-44 (master card holder key; verified off-chain by press)
) → void
```

**Preconditions:**

1. `sub_card_address` exists in `SubCardRegistrations` with `active == true`.
2. `signature` is a valid ML-DSA-44 signature from the **master card's primary card key** over `sig_payload`. The press resolves the holder's public key from the master card's `CardDocument` on IPFS and verifies it off-chain before submission; the contract verifies press authorization via §6.1 write gate.
3. Press authorization checks (§6.1) pass for the master card's policy.

The primary card key is the exclusive authorization for sub-card deregistration. Sub-card keys cannot authorize their own deregistration. If the primary card key has been lost and not yet recovered, the holder must complete key recovery before deregistering sub-cards. After recovery from a key compromise, all sub-cards should be deregistered and re-issued.

**State changes:**

- Sets `SubCardRegistrations[sub_card_address].active = false`.
- Sets `SubCardRegistrations[sub_card_address].deregistered_at = block.timestamp`.

---

### 4.5 ClaimOpenOffer

**Called by:** Press (authorized for the offer's policy), during open-offer issuance  
**Purpose:** Atomically check and increment the acceptance count for an open offer, then register the new card. Combines the open-offer validation with `RegisterCard` in a single atomic transaction to prevent over-issuance race conditions.

```
ClaimOpenOffer(
    offer_id           bytes32,     — keccak256(canonical CBOR of OpenMarkOffer including issuer_sig)
    max_acceptances    uint64,      — type(uint64).max means unconstrained (press encodes document null as this);
                                     0 means zero acceptances permitted (offer always reverts)
    expires_at         uint64,      — Unix timestamp; 0 means unconstrained (press encodes document null as 0)
    card_address       bytes32,     — New card to register
    initial_log_cid    bytes,       — CID of genesis CardDocument
    policy_address     bytes32,
    issuer_sig_payload bytes,       — Canonical CBOR of the OpenMarkOffer (for issuer sig verification)
    issuer_signature   bytes[2420], — ML-DSA-44 sig from offer issuer over issuer_sig_payload
                                      (issuer key is ML-DSA-44 — IPFS identity key, not secp256r1)
    press_sig_payload  bytes,
    press_signature    bytes[64]    — secp256r1 signature (r||s) from press over keccak256(press_sig_payload)
) → void
```

**Preconditions (all atomic):**

1. `expires_at == 0 OR block.timestamp < expires_at`.
2. `max_acceptances == type(uint64).max OR OpenOfferUseCounts[offer_id] < max_acceptances`.
3. `issuer_signature` verifies against the issuer card's public key over `issuer_sig_payload`.
4. Press authorization checks (same as §4.1 steps 2–4).

**State changes (all atomic):**

- `OpenOfferUseCounts[offer_id]` incremented by 1.
- New `CardEntry` created (same as `RegisterCard`).

---

### 4.6 RegisterPolicy

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Register a new root policy address, establishing it as a recognized trust anchor in the contract.

```
RegisterPolicy(
    policy_address       bytes32,    — On-chain registry address of the new policy card
    authorizer_pubkey    bytes[64],  — secp256r1 public key (x||y) for press management under this policy
    governance_payload   bytes,      — Canonical CBOR of RegisterPolicyPayload
    governance_sigs      bytes[]     — Array of secp256r1 signatures (r||s, 64 bytes each) from
                                       governance key holders; verified via RIP-7212
) → void
```

**`RegisterPolicyPayload`:**

```json
{
  "op":                 "register_policy",
  "policy_address":     "<base64url — bytes32>",
  "authorizer_pubkey":  "<base64url — 64 bytes, secp256r1 x||y>",
  "governance_version": <uint32 — current GovernanceKeysets[RootPolicyBody].version>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. `policy_address` does not already exist in `PolicyAuthorizerKeys`.
2. `governance_sigs` contains at least `GovernanceKeysets[RootPolicyBody].quorum` valid signatures, each from a distinct key in `GovernanceKeysets[RootPolicyBody].keys`, over `governance_payload`.
3. `governance_version` in the payload matches the current `GovernanceKeysets[RootPolicyBody].version` (prevents replay of old governance actions).

**State changes:**

- Creates `PolicyAuthorizerKeys[policy_address] = authorizer_pubkey`.

---

### 4.7 AuthorizePress

**Called by:** Press Registry Governance Body (quorum required)  
**Purpose:** Add or update a press authorization for a given policy. Sets the press as active and records its signing key.

```
AuthorizePress(
    policy_address     bytes32,
    press_address      bytes32,
    press_pubkey       bytes[64],   — secp256r1 public key (x||y, 64 bytes) for on-chain write authorization
    mldsa44_key_hash   bytes32,     — keccak256 of ML-DSA-44 public key (1312 bytes); stored for upgrade path
    governance_payload bytes,
    governance_sigs    bytes[]      — secp256r1 signatures (r||s, 64 bytes each) from governance key holders
) → void
```

**`AuthorizePressPayload`:**

```json
{
  "op":                 "authorize_press",
  "policy_address":     "<base64url>",
  "press_address":      "<base64url>",
  "press_pubkey":       "<base64url — 64 bytes, secp256r1 x||y>",
  "mldsa44_key_hash":   "<base64url — 32 bytes, keccak256 of ML-DSA-44 pubkey>",
  "governance_version": <uint32>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. `policy_address` exists in `PolicyAuthorizerKeys`.
2. Quorum signature check (same logic as §4.6, using `PressRegistryBody` keyset).

**State changes:**

- Creates or updates `PressAuthorizations[policy_address][press_address] = { press_public_key: press_pubkey, mldsa44_key_hash: mldsa44_key_hash, key_scheme: 0, active: true, authorized_at: block.timestamp, revoked_at: 0 }`.

**Key rotation (secp256r1):** If the press needs to rotate its secp256r1 signing key, the Press Registry Governance Body calls `AuthorizePress` again with the same `press_address` and the new `press_pubkey`. The `press_public_key` is overwritten; `active` is reset to `true`. Prior cards signed with the old key remain verifiable by verifiers who cached it; the contract will only accept new writes from the new key.

**On-chain scheme upgrade (secp256r1 → ML-DSA-44):** See §4.11 `RotateOnChainKeyScheme`.

---

### 4.8 RevokePress

**Called by:** Press Registry Governance Body (quorum required)  
**Purpose:** Prevent a press from making further writes under a policy. Does not affect cards already issued by that press.

```
RevokePress(
    policy_address     bytes32,
    press_address      bytes32,
    governance_payload bytes,
    governance_sigs    bytes[]
) → void
```

**Preconditions:**

1. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
2. Quorum signature check (`PressRegistryBody` keyset).

**State changes:**

- Sets `PressAuthorizations[policy_address][press_address].active = false`.
- Sets `PressAuthorizations[policy_address][press_address].revoked_at = block.timestamp`.

The entry is retained with `active = false` (not deleted) to preserve the on-chain audit trail.

---

### 4.9 RotateAuthorizerKey

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Replace the authorizer key for a registered policy (e.g., following key compromise or routine rotation).

```
RotateAuthorizerKey(
    policy_address      bytes32,
    new_authorizer_key  bytes[64],  — secp256r1 public key (x||y); bytes[1312] after Phase 3 upgrade
    governance_payload  bytes,
    governance_sigs     bytes[]     — secp256r1 signatures (r||s, 64 bytes each)
) → void
```

**`RotateAuthorizerKeyPayload`:**

```json
{
  "op":                 "rotate_authorizer_key",
  "policy_address":     "<base64url>",
  "new_authorizer_key": "<base64url — 64 bytes, secp256r1 x||y>",
  "governance_version": <uint32>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. `policy_address` exists in `PolicyAuthorizerKeys`.
2. Quorum signature check (`RootPolicyBody` keyset).

**State changes:**

- Updates `PolicyAuthorizerKeys[policy_address] = new_authorizer_key`.

---

### 4.10 RotateGovernanceKeys

**Called by:** The governance body whose keyset is being rotated (self-amending, supermajority required)  
**Purpose:** Replace the active key set and/or quorum threshold for a governance body. Requires the existing quorum to authorize the change.

```
RotateGovernanceKeys(
    body_id            GovernanceBodyId,
    new_keys           bytes[64][],   — secp256r1 public keys (x||y, 64 bytes each);
                                        bytes[1312][] after on-chain key scheme upgrade
    new_quorum         uint8,
    governance_payload bytes,
    governance_sigs    bytes[]        — secp256r1 signatures (r||s, 64 bytes each) from existing
                                        keyset, not the new one
) → void
```

**Preconditions:**

1. `governance_sigs` contains at least `GovernanceKeysets[body_id].quorum` valid signatures from distinct keys in the *current* `GovernanceKeysets[body_id].keys` (not the proposed new keys).
2. `new_quorum > len(new_keys) / 2` (majority requirement; prevents trivially-satisfied quorums).
3. `len(new_keys) >= 3` (minimum key set size; prevents single-party governance capture).
4. `governance_version` in payload matches current version.

**State changes:**

- Replaces `GovernanceKeysets[body_id].keys` with `new_keys`.
- Sets `GovernanceKeysets[body_id].quorum = new_quorum`.
- Increments `GovernanceKeysets[body_id].version`.

---

### 4.11 RotateOnChainKeyScheme

**Called by:** Press (self-initiated, no governance quorum required)  
**Purpose:** Upgrade a press's on-chain write authorization from secp256r1 (Phase 1) to ML-DSA-44 (Phase 2/3). Requires dual-signature proof of possession of both the current secp256r1 key and the new ML-DSA-44 key to prevent key hijacking during the transition window. The contract must be in Phase 2 (dual-accept) or Phase 3 (ML-DSA-44 primary) to accept this operation.

```
RotateOnChainKeyScheme(
    policy_address     bytes32,
    press_address      bytes32,
    new_mldsa44_pubkey bytes[1312],  — Full ML-DSA-44 public key (1312 bytes)
    rotation_payload   bytes,        — Canonical CBOR of RotateOnChainKeySchemePayload
    secp256r1_sig      bytes[64],    — secp256r1 signature (r||s) over keccak256(rotation_payload),
                                       from current registered secp256r1 press key
    mldsa44_sig        bytes[2420]   — ML-DSA-44 signature over keccak256(rotation_payload),
                                       from the new ML-DSA-44 key (proves possession)
) → void
```

**`RotateOnChainKeySchemePayload`:**

```json
{
  "op":                "rotate_on_chain_key_scheme",
  "press_address":     "<base64url — bytes32>",
  "policy_address":    "<base64url — bytes32>",
  "new_mldsa44_pubkey": "<base64url — 1312 bytes>",
  "nonce":             "<base64url>",
  "deadline_block":    <uint64 — block number after which this payload is rejected>
}
```

**Preconditions:**

1. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
2. `PressAuthorizations[policy_address][press_address].key_scheme == 0` (secp256r1; cannot re-rotate to ML-DSA-44 once already migrated).
3. Contract `key_scheme_phase >= 1` (Phase 2 or 3 must be active; rejected in Phase 1).
4. `block.number <= deadline_block` (payload not expired).
5. `secp256r1_sig` verifies via RIP-7212 against `PressAuthorizations[policy_address][press_address].press_public_key`.
6. `keccak256(new_mldsa44_pubkey) == PressAuthorizations[policy_address][press_address].mldsa44_key_hash` (confirms the new key matches the hash registered at authorization time).
7. `mldsa44_sig` verifies against `new_mldsa44_pubkey` over `keccak256(rotation_payload)` (proves possession of the new ML-DSA-44 private key).

**State changes:**

- Sets `PressAuthorizations[policy_address][press_address].press_public_key` to the 64-byte secp256r1 slot being superseded (nulled or retained for grace-period rotation-only use, implementation-defined).
- Stores `new_mldsa44_pubkey` as the new write authorization key (storage slot TBD based on Phase 2 contract upgrade).
- Sets `PressAuthorizations[policy_address][press_address].key_scheme = 1`.
- Emits `OnChainKeySchemeRotated(policy_address, press_address, new_mldsa44_pubkey)`.

**Note on governance key upgrade:** Governance bodies rotate via a new call to `RotateGovernanceKeys` during Phase 2, passing ML-DSA-44 keys in `new_keys[]` and updating `key_scheme` to `1` in `GovernanceKeysets`. The existing quorum of secp256r1 governance keys must sign the rotation payload.

---

## 4.11 Gas Payment and Rate Limiting

All on-chain writes require ETH (Arbitrum One) for gas. **Only presses hold funded Arbitrum wallets and submit transactions.** End users never pay gas directly.

**Gas payment by operation type:**

| Operation | Who pays gas |
|---|---|
| `RegisterCard`, `UpdateMarkHead`, `ClaimOpenOffer` | Issuing organization's press |
| `DeregisterSubCard` | Issuing organization's press |
| `RegisterSubCard` | Requesting app's pre-funded gas account |
| Governance operations | Governance body's press |

**Issuing organization's press** covers all card creation, card updates (whether issuer- or holder-initiated), sub-card deregistration, and open-offer claims. Holders do not hold or spend ETH directly; they submit signed requests to the press, which submits on their behalf. This applies equally to holder-initiated updates (self-revocation, key rotation) and issuer-initiated updates.

**Requesting app's pre-funded gas account** covers only `RegisterSubCard`. The app organization pre-funds a balance with the press before requesting sub-card registrations. The press deducts the gas cost from the app's balance on each registration and rejects requests when the balance is insufficient.

**Rate limiting.** To prevent abuse, presses enforce the following default limits per rolling 7-day window:

| Operation | Limit scope | Default weekly limit |
|---|---|---|
| `RegisterSubCard` | Per holder | 10 |
| `DeregisterSubCard` | Per holder | 10 |
| `UpdateMarkHead` (1xx codes) | Per holder | 20 |
| All press-funded writes | Per policy | 1,000 |
| `RegisterSubCard` | Per app card | 500 |

The per-app-card limit guards against a single app exhausting press capacity or depleting its own gas balance in a burst. Policy operators may configure stricter limits; limits above the defaults require explicit policy configuration and carry additional auditability obligations.

**Suspicious activity notifications.** Presses track write volume per holder and per app card. When activity in a rolling 7-day window exceeds 80% of any per-holder or per-app-card limit, the press sends an alert to the card granting agency via HTTPS to their wallet service endpoint. The alert includes: the relevant card pointer (holder or app), the operation type, the current count and limit, and a timestamp. The granting agency may respond by lowering the limit, revoking the card, or taking no action.

**Acceptance criteria:**
- [ ] A press rejects a `RegisterSubCard` request if the requesting app's gas balance is insufficient to cover the transaction before submitting.
- [ ] A press rejects a `RegisterSubCard` if the holder or app card has reached its per-entity weekly limit.
- [ ] A press rejects a press-funded write that would push the per-policy weekly total over the limit.
- [ ] A suspicious-activity notification is sent when a holder's or app card's 7-day write count exceeds 80% of any configured limit.

---

## 5. Read Operations

These are view functions — no state change, no fee beyond RPC costs.

| Function | Returns | Description |
|---|---|---|
| `GetCardEntry(card_address bytes32)` | `CardEntry` | Full entry including `log_head_cid`, `policy_address`, `last_press_address`, `exists` |
| `GetPressAuthorization(policy_address, press_address bytes32)` | `PressAuthEntry` | Key, active flag, timestamps |
| `GetPolicyAuthorizer(policy_address bytes32)` | `bytes[64]` | Authorizer secp256r1 public key (x||y) for the policy |
| `GetSubCardEntry(sub_card_address bytes32)` | `SubCardEntry` | Master address, log head snapshot, active flag |
| `GetOpenOfferCount(offer_id bytes32)` | `uint64` | Current acceptance count |
| `GetGovernanceKeyset(body_id GovernanceBodyId)` | `GovernanceKeyset` | Active keys, quorum, version |
| `IsPressActive(policy_address, press_address bytes32)` | `bool` | Quick check for verifiers |
| `CardExists(card_address bytes32)` | `bool` | Check without fetching full entry |

---

## 6. Authorization Model

### 6.1 Card Write Gate

The following check is applied on every call to `RegisterCard`, `UpdateMarkHead`, and `ClaimOpenOffer`. Failure at any step reverts the transaction with the corresponding error code (§8).

```
1. Resolve policy_address:
   - RegisterCard:    use the supplied policy_address argument.
   - UpdateMarkHead:  read CardEntries[card_address].policy_address.
   - ClaimOpenOffer:  use the supplied policy_address argument.

2. Confirm policy_address ∈ PolicyAuthorizerKeys.
   → Error: UNRECOGNIZED_POLICY

3. Confirm PressAuthorizations[policy_address][press_address] exists.
   → Error: PRESS_NOT_AUTHORIZED

4. Confirm PressAuthorizations[policy_address][press_address].active == true.
   → Error: PRESS_REVOKED

5. Verify press_signature (secp256r1, r||s) over keccak256(press_sig_payload) against
   PressAuthorizations[policy_address][press_address].press_public_key via RIP-7212.
   → Error: INVALID_PRESS_SIGNATURE

6. Confirm sequence in press_sig_payload equals
   PressAuthorizations[policy_address][press_address].next_sequence.
   Increment next_sequence by 1 on success.
   → Error: SEQUENCE_MISMATCH

7. (UpdateMarkHead only) Confirm prev_log_cid matches current
   CardEntries[card_address].log_head_cid.
   → Error: STALE_PREV_CID
```

### 6.2 Governance Quorum Verification

Applied on every governance operation (§4.6–4.10). The signed `governance_payload` includes the operation name, all action parameters, a `governance_version` equal to the current keyset version, and a replay-prevention nonce.

```
1. Confirm governance_version in payload matches GovernanceKeysets[body_id].version.
   → Error: GOVERNANCE_VERSION_MISMATCH

2. Confirm nonce in payload has not been seen before.
   → Error: NONCE_REUSED

3. For each sig in governance_sigs:
   - Identify the corresponding key in GovernanceKeysets[body_id].keys.
   - Verify secp256r1 signature (r||s) over keccak256(governance_payload) via RIP-7212.
     (After Phase 3 upgrade: verify ML-DSA-44 signature per key_scheme.)
   - Confirm no two sigs use the same key.
   → Error: INVALID_GOVERNANCE_SIGNATURE / DUPLICATE_SIGNER

4. Confirm count(valid, distinct signatures) >= GovernanceKeysets[body_id].quorum.
   → Error: INSUFFICIENT_QUORUM
```

---

## 6.3 Upgradeability — Modular Verifier (OQ-18, resolved 2026-06-14)

The registry contract is split into two deployed contracts:

**Registry storage contract (immutable).** Holds all state: `CardEntries`, `PolicyAuthorizerKeys`, `PressAuthorizations`, `SubCardRegistrations`, `OpenOfferUseCounts`, `GovernanceKeysets`. This contract is never upgraded. Its address is the stable protocol identifier.

**Verifier module (upgradeable).** Contains the signature verification logic. In Phase 1, this delegates secp256r1 verification to the RIP-7212 precompile at `0x100` and requires no Stylus computation. In Phase 3, the verifier module is upgraded (via `UpgradeVerifier`) to a Stylus WASM contract that performs ML-DSA-44 verification. The storage contract holds the verifier module address and delegates all signature checks to it via a cross-contract call. The verifier module has no state; it is a pure computation contract.

The verifier module address is stored in the registry as:

```
VerifierModule: address   — Address of the current verifier module.
                            Phase 1: thin wrapper delegating to RIP-7212 precompile.
                            Phase 3: Stylus WASM contract for ML-DSA-44 verification.
                            Set at deploy; updated only via UpgradeVerifier governance operation.
```

**UpgradeVerifier** is a governance operation (governed by `RootPolicyBody` quorum) with a mandatory 48-hour timelock. The proposed new verifier address is recorded on-chain at proposal time; the upgrade takes effect only after the timelock expires and a second confirmation transaction is submitted. This gives protocol observers a window to detect and respond to a compromised governance key before a malicious verifier takes effect.

The upgrade path intentionally cannot touch storage layout, authorization tables, or card entries. A governance key compromise can replace the signature verifier (potentially accepting invalid signatures going forward) but cannot rewrite existing registry state.

---

## 7. Events

Every successful state-changing operation emits an event. Events are the primary mechanism by which off-chain tooling (press software, monitoring agents, governance dashboards) tracks on-chain state without polling.

```
CardRegistered(
    card_address       bytes32,
    policy_address     bytes32,
    press_address      bytes32,
    initial_log_cid    bytes,
    timestamp          uint64
)

CardHeadUpdated(
    card_address       bytes32,
    prev_log_cid       bytes,
    new_log_cid        bytes,
    press_address      bytes32,
    timestamp          uint64
)

SubCardRegistered(
    sub_card_address   bytes32,
    master_address     bytes32,
    timestamp          uint64
)

SubCardDeregistered(
    sub_card_address   bytes32,
    master_address     bytes32,
    timestamp          uint64
)

OpenOfferClaimed(
    offer_id           bytes32,
    card_address       bytes32,
    use_count          uint64,   — count after this claim
    timestamp          uint64
)

PolicyRegistered(
    policy_address     bytes32,
    timestamp          uint64
)

PressAuthorized(
    policy_address     bytes32,
    press_address      bytes32,
    timestamp          uint64
)

PressRevoked(
    policy_address     bytes32,
    press_address      bytes32,
    timestamp          uint64
)

AuthorizerKeyRotated(
    policy_address     bytes32,
    timestamp          uint64
)

GovernanceKeysRotated(
    body_id            uint8,    — 0 = RootPolicyBody, 1 = PressRegistryBody
    new_quorum         uint8,
    key_count          uint8,
    version            uint32,
    timestamp          uint64
)
```

**Note:** Events do not include the new governance keys or press public keys in plaintext — these are available from the call data on the same transaction. Emitting 1,312-byte public keys in events would significantly increase log storage costs.

---

## 8. Error Codes

| Code | Name | Trigger |
|---|---|---|
| E-01 | `MARK_ALREADY_EXISTS` | `RegisterCard` called for an address already in `CardEntries` |
| E-02 | `MARK_NOT_FOUND` | Operation targets an address not in `CardEntries` |
| E-03 | `UNRECOGNIZED_POLICY` | `policy_address` not in `PolicyAuthorizerKeys` |
| E-04 | `PRESS_NOT_AUTHORIZED` | No entry in `PressAuthorizations` for (policy, press) |
| E-05 | `PRESS_REVOKED` | Entry exists but `active == false` |
| E-06 | `INVALID_PRESS_SIGNATURE` | secp256r1 verification failure (via RIP-7212) for press signature; after Phase 3 upgrade: ML-DSA-44 failure |
| E-07 | `SEQUENCE_MISMATCH` | Press payload `sequence` does not equal `PressAuthEntry.next_sequence` |
| E-07G | `NONCE_REUSED` | Governance payload nonce seen in a prior governance transaction |
| E-08 | `STALE_PREV_CID` | `prev_log_cid` in `UpdateMarkHeadPayload` does not match stored head |
| E-09 | `POLICY_ALREADY_REGISTERED` | `RegisterPolicy` for an already-registered address |
| E-10 | `SUB_MARK_NOT_FOUND` | `DeregisterSubCard` for an address not in `SubCardRegistrations` |
| E-11 | `SUB_MARK_ALREADY_ACTIVE` | `RegisterSubCard` for an address already registered and active |
| E-12 | `OFFER_EXPIRED` | `ClaimOpenOffer` after `expires_at` |
| E-13 | `OFFER_AT_CAPACITY` | `ClaimOpenOffer` when `use_count >= max_acceptances` |
| E-14 | `INVALID_ISSUER_SIGNATURE` | Issuer ML-DSA-44 verification failure in `ClaimOpenOffer` (issuer keys are always ML-DSA-44 — IPFS identity keys) |
| E-15 | `GOVERNANCE_VERSION_MISMATCH` | Governance payload version does not match stored version |
| E-16 | `INVALID_GOVERNANCE_SIGNATURE` | One or more governance secp256r1 signatures fail RIP-7212 verification (or ML-DSA-44 after Phase 3 upgrade) |
| E-17 | `DUPLICATE_SIGNER` | Two governance signatures use the same key |
| E-18 | `INSUFFICIENT_QUORUM` | Valid distinct governance signatures < quorum threshold |
| E-19 | `QUORUM_TOO_LOW` | `RotateGovernanceKeys` proposes `new_quorum <= len(new_keys)/2` |
| E-20 | `KEYSET_TOO_SMALL` | `RotateGovernanceKeys` proposes fewer than 3 keys |
| E-21 | `LOG_CID_TOO_LONG` | CID bytes exceed 64-byte maximum |
| E-22 | `INVALID_MASTER_SIGNATURE` | Master card holder signature fails in `RegisterSubCard` |
| E-23 | `KEY_SCHEME_ALREADY_UPGRADED` | `RotateOnChainKeyScheme` called for a press already on ML-DSA-44 (`key_scheme == 1`) |
| E-24 | `SCHEME_UPGRADE_NOT_AVAILABLE` | `RotateOnChainKeyScheme` called while contract is still in Phase 1 (`key_scheme_phase == 0`) |
| E-25 | `ROTATION_PAYLOAD_EXPIRED` | `RotateOnChainKeyScheme` `deadline_block` has passed |
| E-26 | `MLDSA44_KEY_HASH_MISMATCH` | `new_mldsa44_pubkey` in `RotateOnChainKeyScheme` does not hash to the stored `mldsa44_key_hash` |

---

## 9. Open Questions

The following questions must be resolved before the contract is deployed or before the implementation phase begins. Questions are numbered sequentially from the existing open question list in `ARCHITECTURE.md`.

| ID | Area | Question | Priority |
|---|---|---|---|
| ~~**OQ-2**~~ | Engineering | ~~**ML-DSA-44 Stylus gas cost.**~~ **Resolved 2026-06-14.** On-chain write authorization switched to secp256r1 / RIP-7212 precompile. ML-DSA-44 is no longer used for on-chain verification in Phase 1. Estimated write cost ~$0.05–0.10 (calldata dominated by secp256r1 at 64-byte sig + 64-byte pubkey vs. ML-DSA-44's 2,420 + 1,312 bytes). ML-DSA-44 Stylus verifier is deferred to Phase 3 of the on-chain key upgrade path (ADR-012). | ~~Critical / Blocking~~ |
| **OQ-15** | Governance | **Bootstrap: who sets the initial governance keysets?** The contract deployer controls the initial `GovernanceKeysets` state. No governance quorum can authorize itself before it exists. The bootstrap process — how the initial key holders are chosen, published, and audited before the contract goes live — is a governance charter question with significant trust implications. Should the initial deployment be timelocked or require a multisig from recognized stakeholders? | **Critical / Blocking** |
| **OQ-16** | Engineering | **SubCard holder key verification.** `RegisterSubCard` requires verifying a signature from the master card holder (not the press). The contract needs access to the holder's public key to do this on-chain. Options: (a) store `holder_pubkey` in `CardEntries` at `RegisterCard` time (~1,312 bytes/card); (b) require presses to mediate all sub-card registrations (adds press dependency to a user-sovereign key operation); (c) verify off-chain and use a press-countersigned payload (weakens the user-sovereign model). This is a significant design decision. | **High** |
| **OQ-4** | Engineering | **Recipient-initiated writes.** Can a card holder directly call `UpdateMarkHead` (e.g., for self-revocation) without going through a press? Direct writes require a paymaster (holder may not hold ETH) and require the contract to verify the holder's key rather than a press key. Press-mediated writes are simpler but add a liveness dependency on the press for holder-initiated changes. | **High** |
| **OQ-17** | Engineering | **Nonce storage and pruning.** The contract must track used nonces to prevent replay attacks on press signatures and governance payloads. If nonces are stored indefinitely, the contract's storage grows unboundedly. Options: (a) timestamp-scoped nonces (discard nonces older than N days, reject payloads with timestamps outside the window); (b) sequence numbers per press address (simpler but requires per-press state). The nonce scheme must be compatible with the timestamp field already included in signed payloads. | **High** |
| ~~**OQ-18**~~ | Engineering | ~~**Contract upgradeability.**~~ **Resolved 2026-06-14.** Modular verifier architecture adopted (option c): immutable storage contract + upgradeable verifier module (§6.3). The verifier module starts as a thin RIP-7212 wrapper (Phase 1) and is upgraded to a ML-DSA-44 Stylus WASM verifier via `UpgradeVerifier` governance operation with 48-hour timelock when the key scheme upgrade occurs. | ~~High~~ |
| **OQ-3** | Engineering | **Minimum IPFS replication before on-chain write.** When a press calls `RegisterCard` or `UpdateMarkHead`, it includes an IPFS CID. If the content is not yet replicated (the CID is not resolvable), verifiers will be unable to fetch the log entry. Should the protocol require presses to confirm a minimum replication count before submitting the on-chain transaction? How is this enforced? | **Medium** |
| **OQ-19** | Engineering | **Batch write operation.** High-volume presses may want to register or update multiple cards in a single Arbitrum One transaction to reduce per-card gas overhead. A `BatchUpdateMarkHeads(updates[])` function could amortize the base transaction cost. This adds implementation complexity but may be necessary for press economics at scale. | **Medium** |
| **OQ-20** | Governance | **Policy deregistration.** Once a policy is registered via `RegisterPolicy`, can it be deregistered? The current design has no delete operation for `PolicyAuthorizerKeys`. Removing a policy address would cause all presses authorized under it to lose write authority and all cards under it to become non-writable. This may be a desired kill-switch capability for compromised or abandoned policies, but it must be governed carefully. | **Medium** |
| **OQ-14** | Governance | **Coercion resistance / governance key holder identity.** Should governance body key holders be pseudonymous (organizations or anonymous participants, harder to coerce) or identifiable (named individuals/organizations with public accountability, easier to hold accountable but more coercible)? Deferred pending governance charter design. Carried forward from `ARCHITECTURE.md` ADR-011. | **Medium** |
| **OQ-21** | Engineering | **Event indexing and the `approved_presses` sync problem.** ADR-011 notes that the `approved_presses` array in the policy card's IPFS content should be kept in sync with on-chain `PressAuthorizations` by tooling. The contract's `PressAuthorized` and `PressRevoked` events are the trigger. Should the protocol specify a canonical indexer interface (e.g., a subgraph schema) to make this sync reliable across implementations? | **Low** |
| **OQ-6** | Engineering | **Efficient log head change detection.** How does a client or verifier efficiently learn that a card's log head has changed since their last check — polling the registry via RPC on each verification, or subscribing to `CardHeadUpdated` events? The event-subscription path requires an indexer; the polling path is simpler but wastes RPC calls. Relevant for mobile clients with limited connectivity. | **Low** |

---

*This spec is derived from `ARCHITECTURE.md` (ADR-001, ADR-005, ADR-011), `protocol-objects.md` (§14, §15), and the raw notes corpus. Where this document and `protocol-objects.md §14` conflict, this document takes precedence for the on-chain `CardEntry` structure. The `protocol-objects.md §14` `RegistryEntry` description should be updated to reference this spec when it reaches accepted status.*
