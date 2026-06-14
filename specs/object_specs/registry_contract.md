# Mark Protocol — Registry Contract Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  
**Contract target:** Arbitrum One (Stylus / WASM-compiled Rust)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Relationship to Existing Specs](#2-relationship-to-existing-specs)
3. [Storage Layout](#3-storage-layout)
   - 3.1 [Per-Mark Registry Entries](#31-per-mark-registry-entries)
   - 3.2 [PolicyAuthorizerKeys](#32-policyauthorizerkeys)
   - 3.3 [PressAuthorizations](#33-pressauthorizations)
   - 3.4 [SubMarkRegistrations](#34-submarkregistrations)
   - 3.5 [OpenOfferUseCounts](#35-openofferusecounts)
   - 3.6 [GovernanceKeysets](#36-governancekeysets)
4. [Write Operations](#4-write-operations)
   - 4.1 [RegisterMark](#41-registermark)
   - 4.2 [UpdateMarkHead](#42-updatemarkhead)
   - 4.3 [RegisterSubMark](#43-registersubmark)
   - 4.4 [DeregisterSubMark](#44-deregistersubmark)
   - 4.5 [ClaimOpenOffer](#45-claimopenoffer)
   - 4.6 [RegisterPolicy](#46-registerpolicy)
   - 4.7 [AuthorizePress](#47-authorizepress)
   - 4.8 [RevokePress](#48-revokepress)
   - 4.9 [RotateAuthorizerKey](#49-rotateauthorizerkey)
   - 4.10 [RotateGovernanceKeys](#410-rotategovernancekeys)
5. [Read Operations](#5-read-operations)
6. [Authorization Model](#6-authorization-model)
   - 6.1 [Mark Write Gate](#61-mark-write-gate)
   - 6.2 [Governance Quorum Verification](#62-governance-quorum-verification)
7. [Events](#7-events)
8. [Error Codes](#8-error-codes)
9. [Open Questions](#9-open-questions)

---

## 1. Overview

The Mark Protocol registry contract is the single Arbitrum One contract that tracks the current state of every registered mark. It is the canonical, tamper-resistant source of truth for:

- **Mark state:** the current log head CID for each mark (the pointer verifiers follow to read a mark's full history on IPFS).
- **Mark provenance:** the policy under which each mark was issued and the press that last wrote to it.
- **Press authorization:** which presses are permitted to write to marks under which policies.
- **Sub-mark bindings:** the master mark for each registered sub-mark, enabling device delegation.
- **Open offer tracking:** acceptance counts for rate-limited open offers.

The contract is the protocol's **write gatekeeper** — it enforces press authorization on every mark write before accepting state changes. It does not store mark content; all content lives on IPFS. The contract stores only pointers and authorization tables.

The contract is implemented in **Stylus** (WASM-compiled Rust) to enable full on-chain ML-DSA-44 (FIPS 204) signature verification. This is the mechanism by which the contract confirms that a write is signed by a key registered to an authorized press. Without on-chain signature verification, the contract would be a passive log; with it, it is an enforced authorization boundary.

---

## 2. Relationship to Existing Specs

This spec extends and supersedes the `RegistryEntry` description in `protocol-objects.md §14`. The per-mark entry structure defined there — `(address, log_head_cid)` — is expanded here with two additional on-chain fields: `policy_address` and `last_press_address` (§3.1). The `protocol-objects.md` §14 description should be updated to reference this spec when it is promoted to accepted status.

The governance tables (`PolicyAuthorizerKeys`, `PressAuthorizations`, `RegisterPolicy`, `AuthorizePress`, `RevokePress`, `RotateAuthorizerKey`) are adopted from `ARCHITECTURE.md` ADR-011, which is the authoritative source for their original specification. This document extends them with the full function signatures, authorization checks, and storage layout required for implementation.

---

## 3. Storage Layout

### 3.1 Per-Mark Registry Entries

One entry per registered mark. Keyed by `mark_address`.

```
MarkEntries: mapping (bytes32 → MarkEntry)

MarkEntry {
    log_head_cid      bytes         — Current IPFS log head CID.
                                      Public mode:  plaintext CID bytes.
                                      Private mode: ML-KEM-encrypted CID bytes.
                                      Updated on every successful RegisterMark or UpdateMarkHead call.

    policy_address    bytes32       — On-chain registry address of the policy mark under which
                                      this mark was issued. Set at RegisterMark time; immutable
                                      thereafter. Used by the write gate to look up
                                      PressAuthorizations[policy_address, press_address].

    last_press_address bytes32      — On-chain registry address of the press sub-mark whose key
                                      signed the most recent write (RegisterMark or UpdateMarkHead).
                                      Updated on every successful write. Provides an on-chain
                                      attribution trail independent of IPFS content.

    exists            bool          — True once the entry has been created by RegisterMark;
                                      used to distinguish unregistered addresses from marks
                                      whose log_head_cid is empty.
}
```

**Address derivation (client-side, not enforced by contract):**

| Privacy mode | Address derivation |
|---|---|
| Public | `keccak256(recipient_pubkey)` |
| Private | `keccak256(sign(recipient_private_key, "mark-log-v1"))` |

The contract does not distinguish between public and private addresses; both are `bytes32` keys. The privacy properties are enforced by the client's choice of derivation and by whether `log_head_cid` is stored as plaintext or encrypted bytes.

**Encoding of `log_head_cid`:** The CID is stored as raw bytes (multihash format). Maximum length is 64 bytes, which accommodates SHA2-256 (34 bytes), SHA3-256 (34 bytes), and BLAKE3 (34 bytes) CIDs. The contract does not validate CID format; format is the press's responsibility.

---

### 3.2 PolicyAuthorizerKeys

Maps each registered root policy address to the ML-DSA-44 public key whose signatures are authoritative for press management under that policy.

```
PolicyAuthorizerKeys: mapping (bytes32 → bytes[1312])

key:   policyAddress (bytes32)       — On-chain registry address of the policy mark.
value: authorizerPublicKey (bytes[1312]) — ML-DSA-44 public key of the policy's authorizer.
                                           Presence of an entry is what makes policyAddress
                                           a recognized root policy in the contract's view.
```

An entry in `PolicyAuthorizerKeys` is created by `RegisterPolicy` (§4.6). It is updated (key rotated) by `RotateAuthorizerKey` (§4.9). There is no delete — once registered, a policy address remains in the table permanently, with key rotation as the replacement mechanism.

---

### 3.3 PressAuthorizations

Maps `(policyAddress, pressAddress)` pairs to the press's active signing key and authorization status.

```
PressAuthorizations: mapping (bytes32 → mapping (bytes32 → PressAuthEntry))

PressAuthEntry {
    press_public_key  bytes[1312]    — ML-DSA-44 public key for this press's signing operations.
                                      The contract verifies press signatures against this key
                                      on every mark write.

    active            bool           — True = press may write to marks under this policy.
                                      False = press has been revoked; existing marks unaffected,
                                      new writes rejected.

    authorized_at     uint64         — Unix timestamp of the most recent AuthorizePress call
                                      for this (policy, press) pair. Retained for audit purposes.

    revoked_at        uint64         — Unix timestamp of RevokePress, if called; 0 if never revoked.
                                      Entry is retained with active=false rather than deleted,
                                      preserving the on-chain audit trail.
}
```

**Write gate check:** On any mark write (RegisterMark, UpdateMarkHead), the contract:

1. Resolves `policyAddress` from the target `MarkEntry.policy_address`.
2. Looks up `PressAuthorizations[policyAddress][pressAddress]`.
3. Rejects if no entry exists, if `active == false`, or if the signature does not verify against `press_public_key`.

---

### 3.4 SubMarkRegistrations

Maps a sub-mark's registry address to its master mark's registry address and the log head CID of the master mark at sub-mark registration time.

```
SubMarkRegistrations: mapping (bytes32 → SubMarkEntry)

SubMarkEntry {
    master_mark_address     bytes32   — Registry address of the master mark.

    registration_log_head   bytes     — Log head CID of the master mark at the time this
                                        sub-mark was registered. Used for scope-attenuation
                                        verification: the sub-mark cannot have been granted
                                        authority the master did not hold at registration time.

    active                  bool      — True until DeregisterSubMark is called. Verifiers
                                        reject signatures from sub-marks with active=false.

    registered_at           uint64    — Unix timestamp of registration.
    deregistered_at         uint64    — Unix timestamp of deregistration; 0 if still active.
}
```

---

### 3.5 OpenOfferUseCounts

Tracks acceptance counts for open mark offers. Keyed by the offer's canonical ID.

```
OpenOfferUseCounts: mapping (bytes32 → uint64)

key:   offer_id (bytes32)   — keccak256(canonical CBOR of the complete OpenMarkOffer document
                               including issuer_signature). Lazily initialized on first accepted claim.
value: use_count (uint64)   — Number of accepted claims under this offer. Atomically incremented
                               by ClaimOpenOffer (§4.5).
```

The contract enforces `use_count < max_acceptances` and `block.timestamp < expires_at` atomically within the same transaction that registers the new mark, preventing race conditions.

---

### 3.6 GovernanceKeysets

Two governance bodies, each with an M-of-N quorum key set. Each body's keyset is stored separately.

```
GovernanceKeysets: mapping (GovernanceBodyId → GovernanceKeyset)

GovernanceBodyId: enum { RootPolicyBody, PressRegistryBody }

GovernanceKeyset {
    keys          bytes[1312][]   — Ordered array of active ML-DSA-44 public keys (1312 bytes each).
    quorum        uint8           — Minimum number of signatures required from keys[] to approve
                                    a governance action. Must be > len(keys)/2 (majority).
    version       uint32          — Incremented on every RotateGovernanceKeys call; included in
                                    the signed payload to prevent governance rotation replays.
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

**Bootstrap concern (open question OQ-15):** The initial governance keysets must be set at contract deployment. The deployer controls this initial state; no governance quorum can authorize itself before it exists. The bootstrap process is a governance design question deferred to the governance charter.

---

## 4. Write Operations

All write operations emit a corresponding event (§7) on success.

---

### 4.1 RegisterMark

**Called by:** Press (authorized for the target policy)  
**Purpose:** Create the initial registry entry for a newly-issued mark.

```
RegisterMark(
    mark_address       bytes32,     — Derived by client; see §3.1 address derivation
    initial_log_cid    bytes,       — CID of the genesis ChittDocument on IPFS
    policy_address     bytes32,     — Registry address of the governing policy mark
    press_sig_payload  bytes,       — Canonical CBOR of the RegisterMarkPayload (see below)
    press_signature    bytes[2420]  — ML-DSA-44 signature over press_sig_payload
) → void
```

**`RegisterMarkPayload` (signed by press):**

```json
{
  "op":              "register_mark",
  "mark_address":    "<base64url — bytes32>",
  "initial_log_cid": "<base64url — CID bytes>",
  "policy_address":  "<base64url — bytes32>",
  "press_address":   "<base64url — bytes32>",
  "nonce":           "<base64url — 32 random bytes, for replay prevention>",
  "timestamp":       "<ISO 8601 — press rejects stale payloads>"
}
```

**Preconditions checked by contract:**

1. `mark_address` does not already exist in `MarkEntries` (no re-registration).
2. `policy_address` exists in `PolicyAuthorizerKeys` (recognized policy).
3. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
4. `press_signature` verifies against `PressAuthorizations[policy_address][press_address].press_public_key` over `press_sig_payload`.
5. The `nonce` in `press_sig_payload` has not been used before (replay prevention).

**State changes:**

- Creates `MarkEntries[mark_address] = { log_head_cid: initial_log_cid, policy_address: policy_address, last_press_address: press_address, exists: true }`.

---

### 4.2 UpdateMarkHead

**Called by:** Press (authorized for the mark's policy)  
**Purpose:** Advance the mark's log head to a new CID after any post-genesis update (field change, annotation, revocation).

```
UpdateMarkHead(
    mark_address      bytes32,     — Existing mark to update
    new_log_cid       bytes,       — CID of the new log head (latest LogEntry on IPFS)
    press_sig_payload bytes,       — Canonical CBOR of the UpdateMarkHeadPayload (see below)
    press_signature   bytes[2420]  — ML-DSA-44 signature over press_sig_payload
) → void
```

**`UpdateMarkHeadPayload` (signed by press):**

```json
{
  "op":              "update_mark_head",
  "mark_address":    "<base64url — bytes32>",
  "prev_log_cid":    "<base64url — current log_head_cid; prevents lost-update race>",
  "new_log_cid":     "<base64url — CID bytes>",
  "press_address":   "<base64url — bytes32>",
  "nonce":           "<base64url — 32 random bytes>",
  "timestamp":       "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `mark_address` exists in `MarkEntries`.
2. `MarkEntries[mark_address].policy_address` exists in `PolicyAuthorizerKeys`.
3. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
4. `press_signature` verifies against `press_public_key`.
5. `prev_log_cid` matches `MarkEntries[mark_address].log_head_cid` (optimistic concurrency check — prevents a press from writing on top of a stale view).
6. `nonce` has not been used before.

**State changes:**

- Updates `MarkEntries[mark_address].log_head_cid = new_log_cid`.
- Updates `MarkEntries[mark_address].last_press_address = press_address`.

**Note on revocations:** The contract does not distinguish between update codes (field changes vs. revocations). Both use `UpdateMarkHead`. The update code semantics (1xx–9xx) live in the LogEntry stored on IPFS; the contract is code-agnostic. Revocation status is determined by verifiers reading the log from IPFS, not by on-chain state beyond the head pointer.

---

### 4.3 RegisterSubMark

**Called by:** Master mark holder (via paymaster or press)  
**Purpose:** Register a new sub-mark (device key delegation) under a master mark.

```
RegisterSubMark(
    sub_mark_address       bytes32,    — Registry address of the new sub-mark
    master_mark_address    bytes32,    — Registry address of the master mark
    registration_log_head  bytes,      — Current log_head_cid of master mark (snapshot for scope check)
    master_sig_payload     bytes,      — Canonical CBOR of the RegisterSubMarkPayload
    master_signature       bytes[2420] — ML-DSA-44 signature over master_sig_payload,
                                         using the master mark's holder key
) → void
```

**`RegisterSubMarkPayload`:**

```json
{
  "op":                       "register_sub_mark",
  "sub_mark_address":         "<base64url — bytes32>",
  "master_mark_address":      "<base64url — bytes32>",
  "registration_log_head":    "<base64url — CID bytes>",
  "nonce":                    "<base64url>",
  "timestamp":                "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `master_mark_address` exists in `MarkEntries`.
2. `sub_mark_address` does not already exist in `SubMarkRegistrations` with `active == true`.
3. `registration_log_head` matches `MarkEntries[master_mark_address].log_head_cid` at call time. (Ensures the snapshot is current; prevents a holder from registering a sub-mark claiming authority the master no longer holds.)
4. `master_signature` verifies against the master mark holder's public key.

> **Open question OQ-4 dependency:** Verification of the master mark holder's public key requires the contract to either (a) store the holder public key on-chain for each mark, or (b) delegate sub-mark registration to presses who perform off-chain verification. Option (a) costs ~1,312 bytes of storage per mark. Option (b) ties sub-mark registration to press availability, which is undesirable for user-sovereign key operations. This is an open design question (§9, OQ-16).

**State changes:**

- Creates `SubMarkRegistrations[sub_mark_address] = { master_mark_address, registration_log_head, active: true, registered_at: block.timestamp, deregistered_at: 0 }`.

---

### 4.4 DeregisterSubMark

**Called by:** Master mark holder or press (per policy)  
**Purpose:** Mark a sub-mark as inactive (lost device, key rotation). Existing signatures from the sub-mark that predate deregistration remain verifiable; new authentications using that sub-mark key are rejected by verifiers.

```
DeregisterSubMark(
    sub_mark_address   bytes32,
    sig_payload        bytes,
    signature          bytes[2420]
) → void
```

**Preconditions:** Sub-mark exists and is active. Signature is from the master mark holder OR from an authorized press for the master mark's policy (to support press-initiated revocation on holder request).

**State changes:**

- Sets `SubMarkRegistrations[sub_mark_address].active = false`.
- Sets `SubMarkRegistrations[sub_mark_address].deregistered_at = block.timestamp`.

---

### 4.5 ClaimOpenOffer

**Called by:** Press (authorized for the offer's policy), during open-offer issuance  
**Purpose:** Atomically check and increment the acceptance count for an open offer, then register the new mark. Combines the open-offer validation with `RegisterMark` in a single atomic transaction to prevent over-issuance race conditions.

```
ClaimOpenOffer(
    offer_id           bytes32,     — keccak256(canonical CBOR of OpenMarkOffer including issuer_sig)
    max_acceptances    uint64,      — 0 means unconstrained; carried from the signed offer
    expires_at         uint64,      — Unix timestamp; 0 means unconstrained
    mark_address       bytes32,     — New mark to register
    initial_log_cid    bytes,       — CID of genesis ChittDocument
    policy_address     bytes32,
    issuer_sig_payload bytes,       — Canonical CBOR of the OpenMarkOffer (for issuer sig verification)
    issuer_signature   bytes[2420], — ML-DSA-44 sig from offer issuer over issuer_sig_payload
    press_sig_payload  bytes,
    press_signature    bytes[2420]
) → void
```

**Preconditions (all atomic):**

1. `expires_at == 0 OR block.timestamp < expires_at`.
2. `max_acceptances == 0 OR OpenOfferUseCounts[offer_id] < max_acceptances`.
3. `issuer_signature` verifies against the issuer mark's public key over `issuer_sig_payload`.
4. Press authorization checks (same as §4.1 steps 2–4).

**State changes (all atomic):**

- `OpenOfferUseCounts[offer_id]` incremented by 1.
- New `MarkEntry` created (same as `RegisterMark`).

---

### 4.6 RegisterPolicy

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Register a new root policy address, establishing it as a recognized trust anchor in the contract.

```
RegisterPolicy(
    policy_address       bytes32,      — On-chain registry address of the new policy mark
    authorizer_pubkey    bytes[1312],  — ML-DSA-44 public key for press management under this policy
    governance_payload   bytes,        — Canonical CBOR of RegisterPolicyPayload
    governance_sigs      bytes[]       — Array of ML-DSA-44 signatures from governance key holders
) → void
```

**`RegisterPolicyPayload`:**

```json
{
  "op":                 "register_policy",
  "policy_address":     "<base64url — bytes32>",
  "authorizer_pubkey":  "<base64url — 1312 bytes>",
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
    press_pubkey       bytes[1312],
    governance_payload bytes,
    governance_sigs    bytes[]
) → void
```

**`AuthorizePressPayload`:**

```json
{
  "op":                 "authorize_press",
  "policy_address":     "<base64url>",
  "press_address":      "<base64url>",
  "press_pubkey":       "<base64url — 1312 bytes>",
  "governance_version": <uint32>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. `policy_address` exists in `PolicyAuthorizerKeys`.
2. Quorum signature check (same logic as §4.6, using `PressRegistryBody` keyset).

**State changes:**

- Creates or updates `PressAuthorizations[policy_address][press_address] = { press_public_key: press_pubkey, active: true, authorized_at: block.timestamp, revoked_at: 0 }`.

**Key rotation:** If the press needs to rotate its signing key, the Press Registry Governance Body calls `AuthorizePress` again with the same `press_address` and the new `press_pubkey`. The `press_public_key` is overwritten; `active` is reset to `true`. Prior marks signed with the old key remain verifiable by verifiers who cached it; the contract will only accept new writes from the new key.

---

### 4.8 RevokePress

**Called by:** Press Registry Governance Body (quorum required)  
**Purpose:** Prevent a press from making further writes under a policy. Does not affect marks already issued by that press.

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
    new_authorizer_key  bytes[1312],
    governance_payload  bytes,
    governance_sigs     bytes[]
) → void
```

**`RotateAuthorizerKeyPayload`:**

```json
{
  "op":                 "rotate_authorizer_key",
  "policy_address":     "<base64url>",
  "new_authorizer_key": "<base64url — 1312 bytes>",
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
    new_keys           bytes[1312][],
    new_quorum         uint8,
    governance_payload bytes,
    governance_sigs    bytes[]        — Signatures from existing keyset, not the new one
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

## 5. Read Operations

These are view functions — no state change, no fee beyond RPC costs.

| Function | Returns | Description |
|---|---|---|
| `GetMarkEntry(mark_address bytes32)` | `MarkEntry` | Full entry including `log_head_cid`, `policy_address`, `last_press_address`, `exists` |
| `GetPressAuthorization(policy_address, press_address bytes32)` | `PressAuthEntry` | Key, active flag, timestamps |
| `GetPolicyAuthorizer(policy_address bytes32)` | `bytes[1312]` | Authorizer public key for the policy |
| `GetSubMarkEntry(sub_mark_address bytes32)` | `SubMarkEntry` | Master address, log head snapshot, active flag |
| `GetOpenOfferCount(offer_id bytes32)` | `uint64` | Current acceptance count |
| `GetGovernanceKeyset(body_id GovernanceBodyId)` | `GovernanceKeyset` | Active keys, quorum, version |
| `IsPressActive(policy_address, press_address bytes32)` | `bool` | Quick check for verifiers |
| `MarkExists(mark_address bytes32)` | `bool` | Check without fetching full entry |

---

## 6. Authorization Model

### 6.1 Mark Write Gate

The following check is applied on every call to `RegisterMark`, `UpdateMarkHead`, and `ClaimOpenOffer`. Failure at any step reverts the transaction with the corresponding error code (§8).

```
1. Resolve policy_address:
   - RegisterMark:    use the supplied policy_address argument.
   - UpdateMarkHead:  read MarkEntries[mark_address].policy_address.
   - ClaimOpenOffer:  use the supplied policy_address argument.

2. Confirm policy_address ∈ PolicyAuthorizerKeys.
   → Error: UNRECOGNIZED_POLICY

3. Confirm PressAuthorizations[policy_address][press_address] exists.
   → Error: PRESS_NOT_AUTHORIZED

4. Confirm PressAuthorizations[policy_address][press_address].active == true.
   → Error: PRESS_REVOKED

5. Verify press_signature (ML-DSA-44) over press_sig_payload against
   PressAuthorizations[policy_address][press_address].press_public_key.
   → Error: INVALID_PRESS_SIGNATURE

6. Confirm nonce in press_sig_payload has not been seen before.
   Store nonce in used-nonces set.
   → Error: NONCE_REUSED

7. (UpdateMarkHead only) Confirm prev_log_cid matches current
   MarkEntries[mark_address].log_head_cid.
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
   - Verify ML-DSA-44 signature over governance_payload.
   - Confirm no two sigs use the same key.
   → Error: INVALID_GOVERNANCE_SIGNATURE / DUPLICATE_SIGNER

4. Confirm count(valid, distinct signatures) >= GovernanceKeysets[body_id].quorum.
   → Error: INSUFFICIENT_QUORUM
```

---

## 7. Events

Every successful state-changing operation emits an event. Events are the primary mechanism by which off-chain tooling (press software, monitoring agents, governance dashboards) tracks on-chain state without polling.

```
MarkRegistered(
    mark_address       bytes32,
    policy_address     bytes32,
    press_address      bytes32,
    initial_log_cid    bytes,
    timestamp          uint64
)

MarkHeadUpdated(
    mark_address       bytes32,
    prev_log_cid       bytes,
    new_log_cid        bytes,
    press_address      bytes32,
    timestamp          uint64
)

SubMarkRegistered(
    sub_mark_address   bytes32,
    master_address     bytes32,
    timestamp          uint64
)

SubMarkDeregistered(
    sub_mark_address   bytes32,
    master_address     bytes32,
    timestamp          uint64
)

OpenOfferClaimed(
    offer_id           bytes32,
    mark_address       bytes32,
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
| E-01 | `MARK_ALREADY_EXISTS` | `RegisterMark` called for an address already in `MarkEntries` |
| E-02 | `MARK_NOT_FOUND` | Operation targets an address not in `MarkEntries` |
| E-03 | `UNRECOGNIZED_POLICY` | `policy_address` not in `PolicyAuthorizerKeys` |
| E-04 | `PRESS_NOT_AUTHORIZED` | No entry in `PressAuthorizations` for (policy, press) |
| E-05 | `PRESS_REVOKED` | Entry exists but `active == false` |
| E-06 | `INVALID_PRESS_SIGNATURE` | ML-DSA-44 verification failure for press signature |
| E-07 | `NONCE_REUSED` | Nonce seen in a prior transaction |
| E-08 | `STALE_PREV_CID` | `prev_log_cid` in `UpdateMarkHeadPayload` does not match stored head |
| E-09 | `POLICY_ALREADY_REGISTERED` | `RegisterPolicy` for an already-registered address |
| E-10 | `SUB_MARK_NOT_FOUND` | `DeregisterSubMark` for an address not in `SubMarkRegistrations` |
| E-11 | `SUB_MARK_ALREADY_ACTIVE` | `RegisterSubMark` for an address already registered and active |
| E-12 | `OFFER_EXPIRED` | `ClaimOpenOffer` after `expires_at` |
| E-13 | `OFFER_AT_CAPACITY` | `ClaimOpenOffer` when `use_count >= max_acceptances` |
| E-14 | `INVALID_ISSUER_SIGNATURE` | Issuer ML-DSA-44 verification failure in `ClaimOpenOffer` |
| E-15 | `GOVERNANCE_VERSION_MISMATCH` | Governance payload version does not match stored version |
| E-16 | `INVALID_GOVERNANCE_SIGNATURE` | One or more governance signatures fail verification |
| E-17 | `DUPLICATE_SIGNER` | Two governance signatures use the same key |
| E-18 | `INSUFFICIENT_QUORUM` | Valid distinct governance signatures < quorum threshold |
| E-19 | `QUORUM_TOO_LOW` | `RotateGovernanceKeys` proposes `new_quorum <= len(new_keys)/2` |
| E-20 | `KEYSET_TOO_SMALL` | `RotateGovernanceKeys` proposes fewer than 3 keys |
| E-21 | `LOG_CID_TOO_LONG` | CID bytes exceed 64-byte maximum |
| E-22 | `INVALID_MASTER_SIGNATURE` | Master mark holder signature fails in `RegisterSubMark` |

---

## 9. Open Questions

The following questions must be resolved before the contract is deployed or before the implementation phase begins. Questions are numbered sequentially from the existing open question list in `ARCHITECTURE.md`.

| ID | Area | Question | Priority |
|---|---|---|---|
| **OQ-2** | Engineering | **ML-DSA-44 Stylus gas cost.** On-chain verification of ML-DSA-44 in Stylus WASM must be benchmarked against current Arbitrum One blob-era pricing. The contract verifies one press signature per `RegisterMark` / `UpdateMarkHead` call; governance operations verify up to `quorum` signatures (typically 3–5) per call. The total calldata cost of a quorum governance operation — including `quorum × 2,420 bytes` of signatures and `quorum × 1,312 bytes` of public keys if provided inline — must be acceptable before deployment. | **Critical / Blocking** |
| **OQ-15** | Governance | **Bootstrap: who sets the initial governance keysets?** The contract deployer controls the initial `GovernanceKeysets` state. No governance quorum can authorize itself before it exists. The bootstrap process — how the initial key holders are chosen, published, and audited before the contract goes live — is a governance charter question with significant trust implications. Should the initial deployment be timelocked or require a multisig from recognized stakeholders? | **Critical / Blocking** |
| **OQ-16** | Engineering | **SubMark holder key verification.** `RegisterSubMark` requires verifying a signature from the master mark holder (not the press). The contract needs access to the holder's public key to do this on-chain. Options: (a) store `holder_pubkey` in `MarkEntries` at `RegisterMark` time (~1,312 bytes/mark); (b) require presses to mediate all sub-mark registrations (adds press dependency to a user-sovereign key operation); (c) verify off-chain and use a press-countersigned payload (weakens the user-sovereign model). This is a significant design decision. | **High** |
| **OQ-4** | Engineering | **Recipient-initiated writes.** Can a mark holder directly call `UpdateMarkHead` (e.g., for self-revocation) without going through a press? Direct writes require a paymaster (holder may not hold ETH) and require the contract to verify the holder's key rather than a press key. Press-mediated writes are simpler but add a liveness dependency on the press for holder-initiated changes. | **High** |
| **OQ-17** | Engineering | **Nonce storage and pruning.** The contract must track used nonces to prevent replay attacks on press signatures and governance payloads. If nonces are stored indefinitely, the contract's storage grows unboundedly. Options: (a) timestamp-scoped nonces (discard nonces older than N days, reject payloads with timestamps outside the window); (b) sequence numbers per press address (simpler but requires per-press state). The nonce scheme must be compatible with the timestamp field already included in signed payloads. | **High** |
| **OQ-18** | Engineering | **Contract upgradeability.** The Stylus contract should have a defined upgrade path. Options: (a) immutable (deploy and done; any bug requires a new contract and data migration); (b) proxy pattern (admin key or governance quorum can upgrade); (c) modular (separate contracts for mark storage and signature verification, only the verifier is upgradeable). Option (b) requires a trusted upgrade key; option (c) requires inter-contract call overhead. The ML-DSA-44 Stylus implementation is new enough that bugs are plausible, arguing for some upgrade path. | **High** |
| **OQ-3** | Engineering | **Minimum IPFS replication before on-chain write.** When a press calls `RegisterMark` or `UpdateMarkHead`, it includes an IPFS CID. If the content is not yet replicated (the CID is not resolvable), verifiers will be unable to fetch the log entry. Should the protocol require presses to confirm a minimum replication count before submitting the on-chain transaction? How is this enforced? | **Medium** |
| **OQ-19** | Engineering | **Batch write operation.** High-volume presses may want to register or update multiple marks in a single Arbitrum One transaction to reduce per-mark gas overhead. A `BatchUpdateMarkHeads(updates[])` function could amortize the base transaction cost. This adds implementation complexity but may be necessary for press economics at scale. | **Medium** |
| **OQ-20** | Governance | **Policy deregistration.** Once a policy is registered via `RegisterPolicy`, can it be deregistered? The current design has no delete operation for `PolicyAuthorizerKeys`. Removing a policy address would cause all presses authorized under it to lose write authority and all marks under it to become non-writable. This may be a desired kill-switch capability for compromised or abandoned policies, but it must be governed carefully. | **Medium** |
| **OQ-14** | Governance | **Coercion resistance / governance key holder identity.** Should governance body key holders be pseudonymous (organizations or anonymous participants, harder to coerce) or identifiable (named individuals/organizations with public accountability, easier to hold accountable but more coercible)? Deferred pending governance charter design. Carried forward from `ARCHITECTURE.md` ADR-011. | **Medium** |
| **OQ-21** | Engineering | **Event indexing and the `approved_presses` sync problem.** ADR-011 notes that the `approved_presses` array in the policy chitt's IPFS content should be kept in sync with on-chain `PressAuthorizations` by tooling. The contract's `PressAuthorized` and `PressRevoked` events are the trigger. Should the protocol specify a canonical indexer interface (e.g., a subgraph schema) to make this sync reliable across implementations? | **Low** |
| **OQ-6** | Engineering | **Efficient log head change detection.** How does a client or verifier efficiently learn that a mark's log head has changed since their last check — polling the registry via RPC on each verification, or subscribing to `MarkHeadUpdated` events? The event-subscription path requires an indexer; the polling path is simpler but wastes RPC calls. Relevant for mobile clients with limited connectivity. | **Low** |

---

*This spec is derived from `ARCHITECTURE.md` (ADR-001, ADR-005, ADR-011), `protocol-objects.md` (§14, §15), and the raw notes corpus. Where this document and `protocol-objects.md §14` conflict, this document takes precedence for the on-chain `MarkEntry` structure. The `protocol-objects.md §14` `RegistryEntry` description should be updated to reference this spec when it reaches accepted status.*
