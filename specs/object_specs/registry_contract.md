# Card Protocol — Registry Contract Spec

**Version:** 0.3 (draft)  
**Date:** 2026-06-19  
**Status:** Draft  
**Contract target:** Arbitrum One (Stylus / WASM-compiled Rust)  
**Amends:** v0.2 — three-contract architecture adopted (storage / logic / verifier). Logic contract is upgradeable via 7-day timelock `UpgradeLogic` (RootPolicyBody). Storage contract is immutable and enforces unconditional audit-trail invariants. §3.7, §4.14, §6.3 added/rewritten; events, error codes, and read operations updated. See also v0.1→v0.2: on-chain verification changed from ML-DSA-44 to secp256r1/RIP-7212 per ADR-012.

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
   - 3.7 [Logic Contract Address and Storage Access Control](#37-logic-contract-address-and-storage-access-control)
4. [Write Operations](#4-write-operations)
   - 4.1 [RegisterCard](#41-registercard)
   - 4.2 [UpdateCardHead](#42-updatecardhead)
   - 4.3 [RegisterSubCard](#43-registersubcard)
   - 4.4 [DeregisterSubCard](#44-deregistersubcard)
   - 4.5 [ClaimOpenOffer](#45-claimopenoffer)
   - 4.6 [RegisterPolicy](#46-registerpolicy)
   - 4.7 [AuthorizePress](#47-authorizepress)
   - 4.8 [RevokePress](#48-revokepress)
   - 4.9 [RotateAuthorizerKey](#49-rotateauthorizerkey)
   - 4.10 [RotateGovernanceKeys](#410-rotategovernancekeys)
   - 4.11 [RotateOnChainKeyScheme](#411-rotateonchainKeyscheme)
   - 4.12 [Gas Payment and Rate Limiting](#412-gas-payment-and-rate-limiting)
   - 4.13 [RegisterAddressForward](#413-registeraddressforward)
   - 4.14 [UpgradeLogic](#414-upgradelogic)
   - 4.15 [BatchUpdateCardHeads](#415-batchupdatecardheads)
   - 4.16 [DisablePolicyDeletePermanently](#416-disablepolicydeletepermanently)
5. [Read Operations](#5-read-operations)
6. [Authorization Model](#6-authorization-model)
   - 6.1 [Card Write Gate](#61-card-write-gate)
   - 6.2 [Governance Quorum Verification](#62-governance-quorum-verification)
   - 6.3 [Upgradeability — Three-Contract Model](#63-upgradeability--three-contract-model)
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

The registry is deployed as **three separate contracts** (see §6.3 for full detail):

- **Storage contract (immutable address)** — holds all state mappings. Exposes permissioned setters callable only by the current logic contract address. Enforces a set of unconditional storage invariants (write-once existence flags, immutable forwards, append-only timestamps) that no logic upgrade can override. Its address is the stable protocol identifier.
- **Logic contract (upgradeable)** — implements all write operations (§4), authorization checks (§6.1–6.2), and event emission. Calls into the storage contract for reads and writes, and calls the verifier module for signature checks. Replaced via `UpgradeLogic` (7-day timelock, RootPolicyBody quorum, §4.14).
- **Verifier module (upgradeable)** — implements signature verification logic. In Phase 1, delegates to the RIP-7212 secp256r1 precompile. Replaced via `UpgradeVerifier` (48-hour timelock, RootPolicyBody quorum, §6.3). Implemented in **Stylus** (WASM-compiled Rust) to retain the upgrade path to ML-DSA-44 on-chain verification when warranted (ADR-012).

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
    log_head_cid      bytes         — Current IPFS log head CID, stored as plaintext CID bytes.
                                      Updated on every successful RegisterCard or UpdateCardHead call.

    policy_address    bytes32       — On-chain registry address of the policy card under which
                                      this card was issued. Set at RegisterCard time; immutable
                                      thereafter. Used by the write gate to look up
                                      PressAuthorizations[policy_address, press_address].

    last_press_address bytes32      — On-chain registry address of the press sub-card whose key
                                      signed the most recent write (RegisterCard or UpdateCardHead).
                                      Updated on every successful write. Provides an on-chain
                                      attribution trail independent of IPFS content.

    forward_to        bytes32       — If non-zero, the registry address of the card that supersedes
                                      this one following a key rotation. Set by RegisterAddressForward
                                      (§4.13); immutable once set. A client that resolves this address
                                      and finds forward_to non-zero SHOULD follow it to the new address.
                                      Zero value (default) means no forward is registered.

    exists            bool          — True once the entry has been created by RegisterCard;
                                      used to distinguish unregistered addresses from cards
                                      whose log_head_cid is empty.
}
```

**Address derivation (client-side, not enforced by contract):** a card's address is always `keccak256(recipient_pubkey)` — a single public derivation, no private/secret-derived addresses (see `ARCHITECTURE.md` ADR-006).

All card addresses are `bytes32` keys derived as `keccak256(recipient_pubkey)`; `log_head_cid` is always stored as plaintext CID bytes.

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

**Write gate check:** On any card write (RegisterCard, UpdateCardHead), the contract:

1. Resolves `policyAddress` from the target `CardEntry.policy_address`.
2. Looks up `PressAuthorizations[policyAddress][pressAddress]`.
3. Rejects if no entry exists, if `active == false`, or if the signature does not verify against `press_public_key`.

---

### 3.4 SubCardRegistrations

Maps a sub-card's registry address to its master card's registry address and the log head CID of the master card at sub-card registration time.

```
SubCardRegistrations: mapping (bytes32 → SubCardEntry)

SubCardEntry {
    master_card_address     bytes32   — Registry address of the master card (the holder's
                                        primary card). The on-chain entry identifies the master
                                        but does not store the app card address; the app card
                                        address and app signature live in the IPFS SubCardDocument
                                        (see §16 of protocol-objects.md) pointed to by
                                        sub_card_doc_cid below.

    registration_log_head   bytes     — Log head CID of the master card at the time this
                                        sub-card was registered. Used for scope-attenuation
                                        verification: the sub-card cannot have been granted
                                        authority the master did not hold at registration time.

    sub_card_doc_cid        bytes     — CID of the SubCardDocument stored on IPFS. This is the
                                        authoritative off-chain record containing the app card
                                        address (app_card), the app card pubkey (app_card_pubkey),
                                        the app's signature (app_signature), the holder's
                                        countersignature (holder_signature), and all other
                                        sub-card metadata. Maximum 64 bytes (same CID size limit
                                        as log_head_cid). Format is not validated by the contract.

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

key:   offer_id (bytes32)   — keccak256(canonical RFC 8785 JSON of the complete OpenCardOffer document
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

### 3.7 Logic Contract Address and Storage Access Control

The storage contract holds the address of the currently authorized logic contract and enforces that all setter functions are called exclusively by that address.

```
LogicContract: address   — Address of the current logic contract.
                           Set at deploy to the initial logic contract address.
                           Updated only via UpgradeLogic (§4.14, 7-day timelock,
                           RootPolicyBody quorum).
                           All storage setter functions revert if
                           msg.sender != LogicContract.

PendingLogicUpgrade: PendingUpgrade   — Proposal state for a pending UpgradeLogic.
                                         Zero-value if no upgrade is pending.

PendingUpgrade {
    proposed_address   address    — New logic contract address proposed.
    proposed_at        uint64     — Block timestamp when proposal was submitted.
    governance_version uint32     — GovernanceKeysets[RootPolicyBody].version at
                                    proposal time; used to detect keyset rotation
                                    between proposal and confirmation.
    nonce              bytes32    — Replay-prevention nonce from proposal payload.
}

PolicyDeleteDisabled: bool   — Write-once-true flag. Once set to true by
                               DisablePolicyDeletePermanently, the
                               delete_policy_authorizer_key storage setter
                               reverts unconditionally, regardless of caller.
                               Initialized to false at deploy. Can never be
                               unset once true.
```

**Storage setter interface.** The storage contract exposes one setter per logical write operation (e.g., `setCardEntry`, `setPressAuthEntry`, `setSubCardEntry`). Each setter:

1. Reverts with `CALLER_NOT_LOGIC_CONTRACT` (E-29) if `msg.sender != LogicContract`.
2. Applies the relevant unconditional invariant checks (see below) before writing.
3. Writes the new value.

The setters are not user-facing functions. They are called exclusively by the logic contract as part of implementing the write operations in §4. They are not directly accessible to presses, governance bodies, or any other external caller.

**Unconditional storage invariants.** The following invariants are enforced by the storage contract setters and cannot be overridden by any logic contract, regardless of the logic upgrade history:

| Invariant | Enforcement point |
|---|---|
| `CardEntries[addr].exists` is write-once: once `true`, no setter may set it back to `false`. | `setCardEntry` setter |
| `CardEntries[addr].forward_to` is immutable once non-zero: if the stored value is non-zero, the setter reverts. | `setForwardTo` setter |
| `PolicyAuthorizerKeys` has no unconditional delete: the delete setter (`delete_policy_authorizer_key`) exists but is permanently brickable via `PolicyDeleteDisabled`. | `delete_policy_authorizer_key` setter (checks `PolicyDeleteDisabled` before executing) |
| `PolicyDeleteDisabled` is write-once-true: once set to `true`, no setter may set it back to `false`. | `disable_policy_delete_permanently` setter |
| `PressAuthorizations[p][a].revoked_at` is write-once-non-zero: once set to a non-zero timestamp, no setter may overwrite or zero it. | `setPressAuthEntry` setter |
| `SubCardRegistrations[addr].deregistered_at` is write-once-non-zero: once set to a non-zero timestamp, no setter may overwrite or zero it. | `setSubCardEntry` setter |

These invariants preserve the audit trail and ensure that the core record of what has existed on-chain is permanent, independent of future protocol logic changes.

---

## 4. Write Operations

All write operations are implemented in the **logic contract** (§6.3). From a caller's perspective the function signatures are identical regardless of which logic contract version is active; the storage contract address — the stable protocol identifier — never changes. The logic contract calls the storage contract's setter interface for all state changes and the verifier module for all signature checks.

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
    press_sig_payload  bytes,     — Canonical RFC 8785 JSON of the RegisterCardPayload (see below)
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

### 4.2 UpdateCardHead

**Called by:** Press (authorized for the card's policy)  
**Purpose:** Advance the card's log head to a new CID after any post-genesis update (field change, annotation, revocation).

```
UpdateCardHead(
    card_address      bytes32,   — Existing card to update
    new_log_cid       bytes,     — CID of the new log head (latest LogEntry on IPFS)
    press_sig_payload bytes,     — Canonical RFC 8785 JSON of the UpdateCardHeadPayload (see below)
    press_signature   bytes[64]  — secp256r1 signature (r||s) over keccak256(press_sig_payload)
) → void
```

**`UpdateCardHeadPayload` (signed by press):**

```json
{
  "op":              "update_card_head",
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

**Note on revocations:** The contract does not distinguish between update codes (field changes vs. revocations). Both use `UpdateCardHead`. The update code semantics (1xx–9xx) live in the LogEntry stored on IPFS; the contract is code-agnostic. Revocation status is determined by verifiers reading the log from IPFS, not by on-chain state beyond the head pointer.

---

### 4.3 RegisterSubCard

**Called by:** Press (authorized for the card's policy), on behalf of the sub-card holder. Gas is paid from the requesting app's pre-funded gas account with the press (see §4.12). The press verifies the holder's authorization off-chain before submitting; the holder's signature in `master_sig_payload` is included for auditability.  
**Purpose:** Register a new sub-card (device key delegation) under a master card.

```
RegisterSubCard(
    sub_card_address       bytes32,    — Registry address of the new sub-card
    master_card_address    bytes32,    — Registry address of the master card (holder's primary card).
                                         The app card address is NOT stored on-chain; it lives in the
                                         IPFS SubCardDocument pointed to by sub_card_doc_cid.
    registration_log_head  bytes,      — Current log_head_cid of master card (snapshot for scope check)
    sub_card_doc_cid       bytes,      — CID of the SubCardDocument on IPFS, which contains the
                                         app card address (app_card), app card pubkey, app signature,
                                         and holder countersignature. Maximum 64 bytes.
    master_sig_payload     bytes,      — Canonical RFC 8785 JSON of the RegisterSubCardPayload
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
  "master_card_address":      "<base64url — bytes32>",
  "registration_log_head":    "<base64url — CID bytes>",
  "sub_card_doc_cid":         "<base64url — CID bytes of the SubCardDocument on IPFS>",
  "sequence":                 <uint64 — must equal PressAuthorizations[policy][press].next_sequence>,
  "timestamp":                "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `master_card_address` exists in `CardEntries`.
2. `sub_card_address` does not already exist in `SubCardRegistrations` with `active == true`.
3. `registration_log_head` matches `CardEntries[master_card_address].log_head_cid` at call time. (Ensures the snapshot is current; prevents a holder from registering a sub-card claiming authority the master no longer holds.)
4. Press authorization checks (§6.1) pass for the master card's policy.

> **Master signature is press-side only.** The press verifies `master_signature` (ML-DSA-44) off-chain against the holder public key from the card's `CardDocument` (fetched from IPFS) before submitting. The contract does not re-verify the master signature. The holder signature in calldata is retained as an auditable proof of holder intent. A press submitting a sub-card registration without a valid holder signature is detectable by observers and constitutes a press policy violation (press-side error E-22).

> **App-chain verification is press-side only.** Before submitting `RegisterSubCard`, the press reads the `SubCardDocument` at `sub_card_doc_cid` from IPFS, verifies `app_signature`, and walks the `app_card` chain using `app_card_pubkey` to confirm it reaches the governance authority's app-certification policy root (applying the keccak256 binding check: `keccak256(app_card_pubkey)` must equal the `app_card` pointer address, and each subsequent hop uses the app card's own `ancestry_pubkeys`). The contract stores only the CID pointer to this document; it does not perform any app-chain verification. Runtime verifiers rely on the press having completed this check at registration time — they do not re-walk the app-certification chain independently (see `protocol-objects.md §16` Verifier chain walk).

**State changes:**

- Creates `SubCardRegistrations[sub_card_address] = { master_card_address, registration_log_head, sub_card_doc_cid, active: true, registered_at: block.timestamp, deregistered_at: 0 }`.

---

### 4.4 DeregisterSubCard

**Called by:** Press (authorized for the card's policy), on behalf of the sub-card holder or issuing organization. Gas is paid from the requesting app's pre-funded gas account (see §4.12); if the app account has insufficient balance, the issuing organization's press sponsors the cost.  
**Purpose:** Mark a sub-card as inactive (lost device, key rotation, app access revocation). Existing signatures from the sub-card that predate deregistration remain verifiable; new authentications using that sub-card key are rejected by verifiers.

```
DeregisterSubCard(
    sub_card_address   bytes32,
    sig_payload        bytes,
    signature          bytes[2420]  — ML-DSA-44 (master card holder key; verified off-chain by press)
) → void
```

**Preconditions checked by contract:**

1. `sub_card_address` exists in `SubCardRegistrations` with `active == true`.
2. Press authorization checks (§6.1) pass for the master card's policy.

> **Master signature is press-side only.** The press verifies that `signature` is a valid ML-DSA-44 signature from the master card's primary card key over `sig_payload`, resolving the holder's public key from the master card's `CardDocument` on IPFS before submission. The contract does not re-verify the signature. Sub-card keys cannot authorize their own deregistration. If the primary card key has been lost and not yet recovered, the holder must complete key recovery before deregistering sub-cards.

After recovery from a key compromise, all sub-cards should be deregistered and re-issued.

**State changes:**

- Sets `SubCardRegistrations[sub_card_address].active = false`.
- Sets `SubCardRegistrations[sub_card_address].deregistered_at = block.timestamp`.

---

### 4.5 ClaimOpenOffer

**Called by:** Press (authorized for the offer's policy), during open-offer issuance  
**Purpose:** Atomically check and increment the acceptance count for an open offer, then register the new card. Combines the open-offer validation with `RegisterCard` in a single atomic transaction to prevent over-issuance race conditions.

```
ClaimOpenOffer(
    offer_id           bytes32,     — keccak256(canonical RFC 8785 JSON of OpenCardOffer including issuer_sig)
    max_acceptances    uint64,      — type(uint64).max means unconstrained (press encodes document null as this);
                                     0 means zero acceptances permitted (offer always reverts)
    expires_at         uint64,      — Unix timestamp; 0 means unconstrained (press encodes document null as 0)
    card_address       bytes32,     — New card to register
    initial_log_cid    bytes,       — CID of genesis CardDocument
    policy_address     bytes32,
    press_sig_payload  bytes,
    press_signature    bytes[64]    — secp256r1 signature (r||s) from press over keccak256(press_sig_payload)
) → void
```

**Preconditions (all atomic):**

1. `expires_at == 0 OR block.timestamp < expires_at`.
2. `max_acceptances == type(uint64).max OR OpenOfferUseCounts[offer_id] < max_acceptances`.
3. Press authorization checks (same as §4.1 steps 2–4).

> **Issuer signature verification is press-side only.** The press verifies the ML-DSA-44 issuer signature on the `OpenCardOffer` document before submitting `ClaimOpenOffer`. The contract does not receive or re-verify the issuer signature. A press submitting a claim for an offer with an invalid issuer signature is detectable by observers and constitutes a press policy violation (press-side error E-14).

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
    governance_payload   bytes,      — Canonical RFC 8785 JSON of RegisterPolicyPayload
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
    rotation_payload   bytes,        — Canonical RFC 8785 JSON of RotateOnChainKeySchemePayload
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

## 4.12 Gas Payment and Rate Limiting

All on-chain writes require ETH (Arbitrum One) for gas. **Only presses hold funded Arbitrum wallets and submit transactions.** End users never pay gas directly.

**Gas payment by operation type:**

| Operation | Who pays gas |
|---|---|
| `RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer` | Issuing organization's press |
| `RegisterSubCard` | Requesting app's pre-funded gas account |
| `DeregisterSubCard` | Requesting app's pre-funded gas account; issuing organization's press sponsors if balance insufficient |
| Governance operations | Governance body's press |

**Issuing organization's press** covers all card creation, card updates (whether issuer- or holder-initiated), and open-offer claims. Holders do not hold or spend ETH directly; they submit signed requests to the press, which submits on their behalf. This applies equally to holder-initiated updates (self-revocation, key rotation) and issuer-initiated updates.

**Requesting app's pre-funded gas account** covers `RegisterSubCard` and `DeregisterSubCard`. The app organization pre-funds a balance with the press before requesting sub-card operations. The press deducts the gas cost from the app's balance on each operation. For `DeregisterSubCard`: if the app account is empty, the issuing organization's press sponsors the cost — deregistration must never be blocked by a depleted app balance, since stranding an active sub-card key is a security risk.

**Rate limiting.** To prevent abuse, presses enforce the following default limits per rolling 7-day window:

| Operation | Limit scope | Default weekly limit |
|---|---|---|
| `RegisterSubCard` | Per holder | 10 |
| `DeregisterSubCard` | Per holder | 10 |
| `UpdateCardHead` (1xx codes) | Per holder | 20 |
| All press-funded writes | Per policy | 1,000 |
| `RegisterSubCard` | Per app card | 500 |

The per-app-card limit guards against a single app exhausting press capacity or depleting its own gas balance in a burst. Policy operators may configure stricter limits; limits above the defaults require explicit policy configuration and carry additional auditability obligations.

**Suspicious activity notifications.** Presses track write volume per holder and per app card. When activity in a rolling 7-day window exceeds 80% of any per-holder or per-app-card limit, the press sends an alert to the card granting agency via HTTPS to their wallet service endpoint. The alert includes: the relevant card pointer (holder or app), the operation type, the current count and limit, and a timestamp. The granting agency may respond by lowering the limit, revoking the card, or taking no action.

**Acceptance criteria:**
- [ ] A press rejects a `RegisterSubCard` request if the requesting app's gas balance is insufficient to cover the transaction before submitting.
- [ ] A press submits a `DeregisterSubCard` even if the requesting app's gas balance is zero, sponsoring the cost from the issuing organization's press balance.
- [ ] A press rejects a `RegisterSubCard` if the holder or app card has reached its per-entity weekly limit.
- [ ] A press rejects a press-funded write that would push the per-policy weekly total over the limit.
- [ ] A suspicious-activity notification is sent when a holder's or app card's 7-day write count exceeds 80% of any configured limit.

---

---

## 4.13 RegisterAddressForward

Records an address-level forward on the old card's `CardEntry` when a holder rotates their master key and the card's on-chain address changes. This is a companion to the card-level `successor` link (written to the IPFS log as a 1xx entry) and provides a registry-level redirect that survives IPFS content loss.

```
RegisterAddressForward(
    old_address         bytes32,      — Registry address of the card being superseded
                                        (keccak256 of the old public key).
    new_address         bytes32,      — Registry address of the successor card
                                        (keccak256 of the new public key).
    holder_sig_payload  bytes,        — Canonical RFC 8785 JSON of the RegisterAddressForwardPayload
                                        (see below), signed by the holder using their old ML-DSA-44 key.
    holder_signature    bytes[2420]   — ML-DSA-44 signature over holder_sig_payload,
                                        using the old card holder's primary key.
                                        The press verifies this off-chain against the holder's
                                        CardDocument pubkey before submitting. The contract does not
                                        re-verify the ML-DSA-44 signature on-chain.
    secp256r1_sig       bytes[64]     — secp256r1 signature over keccak256(holder_sig_payload),
                                        signed by the press's registered on-chain key.
)
```

**`RegisterAddressForwardPayload` (holder-signed, also co-signed by press via `secp256r1_sig`):**

```json
{
  "op":          "register_address_forward",
  "old_address": "<base64url bytes32>",
  "new_address": "<base64url bytes32>",
  "nonce":       "<base64url>",
  "deadline_block": <uint64>
}
```

Note: `secp256r1_sig` signs over `keccak256(holder_sig_payload)`. There is only one payload document (the holder-signed one); the press co-signs the same payload. This ensures the press attests to the exact forward the holder authorized.

**Authorization checks:**

1. `old_address` must exist in `CardEntries` (`exists == true`).
2. `new_address` must exist in `CardEntries` (`exists == true`). The successor card must be registered before the forward is set.
3. `old_address.forward_to` must be zero — a forward may only be registered once. Attempting to overwrite returns error E-27.
4. The old card's log must contain no 8xx or 9xx revocation entries. Because the contract is revocation-agnostic and cannot read IPFS content, this check is performed by the press before submitting. If the press finds that a revocation has already been written to the old card's log, it must reject the `RegisterAddressForward` request and return error E-28 to the caller. The contract does not enforce this constraint on-chain; E-28 is a press-side rejection. (The `last_press_address` field does not encode revocation status; full revocation detection requires reading the IPFS log.)
5. The press verifies `holder_signature` (ML-DSA-44) off-chain against the holder's old card pubkey (resolved from the old card's `CardDocument` on IPFS) before submitting. The contract does not re-verify the ML-DSA-44 signature. A press submitting without a valid holder signature is detectable by observers and constitutes a press policy violation (press-side error E-22).
6. `secp256r1_sig` must verify against the key registered in `PressAuthorizations` for the old card's policy (`old_card.policy_address`). The press need not be the last writer to the old card — any currently-authorized press under the old card's policy may submit on the holder's behalf.

**On success:**

- Sets `CardEntries[old_address].forward_to = new_address`.
- Emits `AddressTransition(old_address, new_address, timestamp)`.

**Called by:** Any currently-authorized press under the old card's policy, on behalf of the card holder, as part of the master key rotation flow (see `key_rotation.md §2.4` step 4a). Gas is paid by the issuing organization's press.

**Acceptance criteria:**

- [ ] `RegisterAddressForward` succeeds when `old_address` and `new_address` both exist and `old_address.forward_to` is zero.
- [ ] `RegisterAddressForward` returns E-27 if `old_address.forward_to` is already set.
- [ ] `RegisterAddressForward` returns E-28 if the press determines the old card has been revoked.
- [ ] `RegisterAddressForward` returns E-03 if `secp256r1_sig` does not verify against the registered key.
- [ ] After a successful call, `GetCardEntry(old_address).forward_to == new_address`.
- [ ] The `AddressTransition` event is emitted with correct `old_address`, `new_address`, and `timestamp`.
- [ ] `RegisterAddressForward` may be submitted by any currently-authorized press under the old card's policy, not only the press that last wrote to the card.
- [ ] The `holder_signature` parameter is required in calldata for auditability; a press that submits without obtaining a valid holder ML-DSA-44 signature is in violation of press policy (E-22).

---

### 4.14 UpgradeLogic

Upgrading the logic contract is a two-step operation with a mandatory 7-day timelock between proposal and confirmation. Both steps require a valid quorum signature from the **Root Policy Governance Body**. The logic contract address stored in the storage contract (`LogicContract`) is only updated on successful confirmation after the timelock has elapsed.

The 7-day window gives press operators, card holders, monitoring agents, and protocol observers time to detect a malicious or erroneous proposal and take action (emergency governance rotation, public alerting) before the new logic takes effect.

---

#### Step 1 — ProposeLogicUpgrade

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Record a proposed new logic contract address on-chain and start the 7-day timelock.

```
ProposeLogicUpgrade(
    new_logic_address   address,    — Address of the proposed new logic contract.
                                      Must be a deployed contract; the storage contract
                                      does not verify bytecode — that is the governance
                                      body's responsibility before signing.
    governance_payload  bytes,      — Canonical RFC 8785 JSON of ProposeLogicUpgradePayload
    governance_sigs     bytes[]     — secp256r1 signatures (r||s, 64 bytes each) from
                                      RootPolicyBody key holders
) → void
```

**`ProposeLogicUpgradePayload`:**

```json
{
  "op":                 "propose_logic_upgrade",
  "new_logic_address":  "<base64url — 20 bytes, EVM address>",
  "governance_version": <uint32 — current GovernanceKeysets[RootPolicyBody].version>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. No upgrade is already pending (`PendingLogicUpgrade.proposed_address == address(0)`). A new proposal cannot be submitted until the pending one is either confirmed or cancelled.
2. `new_logic_address != address(0)` and `new_logic_address != LogicContract` (no no-op upgrades).
3. Quorum signature check (§6.2, `RootPolicyBody` keyset).

**State changes:**

- Sets `PendingLogicUpgrade = { proposed_address: new_logic_address, proposed_at: block.timestamp, governance_version: GovernanceKeysets[RootPolicyBody].version, nonce: <nonce from payload> }`.
- Emits `LogicUpgradeProposed(new_logic_address, block.timestamp, timelock_expires_at)` where `timelock_expires_at = block.timestamp + 7 days`.

---

#### Step 2 — ConfirmLogicUpgrade

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Execute the upgrade by updating `LogicContract` to the proposed address, after the 7-day timelock has elapsed.

```
ConfirmLogicUpgrade(
    proposed_logic_address  address,    — Must match PendingLogicUpgrade.proposed_address exactly.
                                          Provided explicitly to prevent ambiguity if a new proposal
                                          was somehow queued between steps.
    governance_payload      bytes,      — Canonical RFC 8785 JSON of ConfirmLogicUpgradePayload
    governance_sigs         bytes[]     — secp256r1 signatures (r||s, 64 bytes each) from
                                          RootPolicyBody key holders; a fresh quorum signature
                                          is required (not the same signatures as the proposal)
) → void
```

**`ConfirmLogicUpgradePayload`:**

```json
{
  "op":                    "confirm_logic_upgrade",
  "proposed_logic_address": "<base64url — 20 bytes, EVM address>",
  "governance_version":    <uint32 — current GovernanceKeysets[RootPolicyBody].version>,
  "nonce":                 "<base64url>",
  "timestamp":             "<ISO 8601>"
}
```

**Preconditions:**

1. `PendingLogicUpgrade.proposed_address != address(0)` (a proposal exists).
2. `proposed_logic_address == PendingLogicUpgrade.proposed_address` (addresses match).
3. `block.timestamp >= PendingLogicUpgrade.proposed_at + 7 days` (timelock has elapsed).
4. `GovernanceKeysets[RootPolicyBody].version == PendingLogicUpgrade.governance_version`. If the governance keyset was rotated between proposal and confirmation, the proposal is stale and must be re-submitted under the new keyset. This prevents a scenario where a proposal is made under a compromised keyset that has since been rotated out.
5. Fresh quorum signature check (§6.2, `RootPolicyBody` keyset) over `ConfirmLogicUpgradePayload`. The confirmation nonce must differ from the proposal nonce.

**State changes:**

- Updates `LogicContract = proposed_logic_address`.
- Clears `PendingLogicUpgrade` to zero value.
- Emits `LogicUpgradeConfirmed(proposed_logic_address, block.timestamp)`.

---

#### CancelLogicUpgrade

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Withdraw a pending proposal without executing it. Used when a proposal is found to be erroneous or when a governance keyset rotation makes the proposal stale and re-submission is preferred over waiting for the timelock to elapse.

```
CancelLogicUpgrade(
    governance_payload  bytes,
    governance_sigs     bytes[]
) → void
```

**Preconditions:**

1. `PendingLogicUpgrade.proposed_address != address(0)` (a proposal exists).
2. Quorum signature check (`RootPolicyBody` keyset).

**State changes:**

- Clears `PendingLogicUpgrade` to zero value.
- Emits `LogicUpgradeCancelled(PendingLogicUpgrade.proposed_address, block.timestamp)`.

---

**Acceptance criteria:**

- [ ] `ProposeLogicUpgrade` succeeds with valid quorum signatures and no pending proposal; creates `PendingLogicUpgrade` and emits `LogicUpgradeProposed`.
- [ ] `ProposeLogicUpgrade` reverts with E-30 if a proposal is already pending.
- [ ] `ConfirmLogicUpgrade` reverts with E-31 if called before 7 days have elapsed since `proposed_at`.
- [ ] `ConfirmLogicUpgrade` reverts with E-15 if `governance_version` in the payload does not match the current keyset version.
- [ ] `ConfirmLogicUpgrade` reverts with E-32 if `proposed_logic_address` does not match `PendingLogicUpgrade.proposed_address`.
- [ ] On successful `ConfirmLogicUpgrade`, `LogicContract` is updated and `PendingLogicUpgrade` is cleared.
- [ ] After a logic upgrade, the storage contract's setter access control rejects calls from the old logic contract address.
- [ ] `CancelLogicUpgrade` clears `PendingLogicUpgrade` and emits `LogicUpgradeCancelled`.
- [ ] All storage invariants (§3.7) are enforced after a logic upgrade — the new logic contract cannot bypass them.

---

### 4.15 BatchUpdateCardHeads

**Called by:** Press (authorized for the target policy)  
**Purpose:** Advance the log heads of multiple cards in a single Arbitrum One transaction, amortizing the base transaction gas cost across all updates. Intended for high-volume presses performing bulk updates (e.g., credential refresh cycles, mass revocations) under a single policy. All updates are atomic — the transaction reverts entirely if any individual precondition fails.

```
BatchUpdateCardHeads(
    policy_address     bytes32,      — Policy shared by all cards in this batch.
                                       All cards must belong to this policy; the contract
                                       verifies CardEntries[card_address].policy_address
                                       == policy_address for each item.
    updates            UpdateItem[], — Ordered array of card updates; 1–100 items
                                       (MAX_BATCH_SIZE = 100, implementation-defined).
    press_sig_payload  bytes,        — Canonical RFC 8785 JSON of BatchUpdateCardHeadsPayload
    press_signature    bytes[64]     — secp256r1 signature (r||s) over keccak256(press_sig_payload),
                                       verified via RIP-7212 against PressAuthorizations.press_public_key
) → void

UpdateItem {
    card_address   bytes32   — Existing card to update
    prev_log_cid   bytes     — Current log_head_cid; must match stored value (lost-update guard)
    new_log_cid    bytes     — CID of the new log head
}
```

**`BatchUpdateCardHeadsPayload` (signed by press):**

```json
{
  "op":           "batch_update_card_heads",
  "policy_address": "<base64url — bytes32>",
  "press_address": "<base64url — bytes32>",
  "updates": [
    {
      "card_address": "<base64url — bytes32>",
      "prev_log_cid": "<base64url — CID bytes>",
      "new_log_cid":  "<base64url — CID bytes>"
    }
  ],
  "sequence":     <uint64 — must equal PressAuthorizations[policy][press].next_sequence>,
  "timestamp":    "<ISO 8601>"
}
```

The `updates` array in the signed payload must match the calldata `updates` array exactly (same order, same values). The contract verifies the signature over the payload before processing any individual item.

**Preconditions checked by contract (all verified before any state change):**

1. `len(updates) >= 1` and `len(updates) <= MAX_BATCH_SIZE` (100).
2. No duplicate `card_address` values within `updates`.
3. `policy_address` exists in `PolicyAuthorizerKeys` (recognized policy).
4. `PressAuthorizations[policy_address][press_address]` exists and `active == true`.
5. `press_signature` verifies against `PressAuthorizations[policy_address][press_address].press_public_key` over `press_sig_payload` via RIP-7212.
6. `sequence` in `press_sig_payload` equals `PressAuthorizations[policy_address][press_address].next_sequence`. On success, `next_sequence` is incremented by **1** (not by the number of items — the entire batch counts as one write for replay prevention).
7. For each `UpdateItem`:
   a. `card_address` exists in `CardEntries`.
   b. `CardEntries[card_address].policy_address == policy_address` (cross-policy writes in a single batch are not permitted).
   c. `prev_log_cid` matches `CardEntries[card_address].log_head_cid` (optimistic concurrency check).
   d. `len(new_log_cid) <= 64` (CID size limit).

All items are validated before any storage write begins. A failure on item N reverts the entire transaction; no partial state changes occur.

**State changes (all atomic):**

For each `UpdateItem`, in order:
- Updates `CardEntries[card_address].log_head_cid = new_log_cid`.
- Updates `CardEntries[card_address].last_press_address = press_address`.

Increments `PressAuthorizations[policy_address][press_address].next_sequence` by 1.

**Events:**

Emits one `CardHeadUpdated` event per item (same event as `UpdateCardHead`), in the same order as the `updates` array. Off-chain indexers need no special handling for batched updates.

**Gas note.** The primary saving is the ~21,000 gas base transaction cost, amortized across all items. Each item still incurs the per-card storage write and RIP-7212 verification costs. At 100 items the base-cost saving is ~210 gas per item. For presses with frequent bulk operations this compounds materially over time.

**Acceptance criteria:**

- [ ] `BatchUpdateCardHeads` succeeds and updates all cards when all preconditions pass; emits one `CardHeadUpdated` per item.
- [ ] `BatchUpdateCardHeads` reverts with E-33 if `updates` is empty or exceeds MAX_BATCH_SIZE.
- [ ] `BatchUpdateCardHeads` reverts with E-34 if any two items share the same `card_address`.
- [ ] `BatchUpdateCardHeads` reverts with E-34 if any item's `card_address` belongs to a policy other than `policy_address`.
- [ ] `BatchUpdateCardHeads` reverts (E-08) if any item's `prev_log_cid` does not match the stored head; no items are updated.
- [ ] `BatchUpdateCardHeads` reverts (E-02) if any item's `card_address` does not exist; no items are updated.
- [ ] `BatchUpdateCardHeads` reverts (E-07) on sequence mismatch; no items are updated.
- [ ] `next_sequence` is incremented by exactly 1 regardless of the number of items in `updates`.
- [ ] A subsequent single `UpdateCardHead` or `BatchUpdateCardHeads` using `sequence + 1` succeeds after a successful batch.

---

### 4.16 DisablePolicyDeletePermanently

**Called by:** Root Policy Governance Body (quorum required)  
**Purpose:** Permanently and irrevocably disable the `DeregisterPolicy` operation at the storage contract level. Once this operation confirms, no future logic contract (regardless of upgrade history) can ever delete a policy authorizer key. This operation exists to give governance the ability to resolve OQ-20 in the "no deregistration" direction without requiring a storage contract redeployment.

```
DisablePolicyDeletePermanently(
    governance_payload  bytes,
    governance_sigs     bytes[]   — RootPolicyBody quorum
) → void
```

**Preconditions:**

1. `PolicyDeleteDisabled == false` (already permanently disabled → revert with E-36).
2. Quorum signature check (§6.2, RootPolicyBody keyset).

**State changes:**

- Sets `PolicyDeleteDisabled = true` in the storage contract (write-once-true; unconditional invariant enforced by storage contract).
- Emits `PolicyDeletePermanentlyDisabled(uint64 timestamp)`.

**Note:** This operation has no inverse. Governance should treat it as a one-way protocol commitment.

---

## 5. Read Operations

These are view functions — no state change, no fee beyond RPC costs.

| Function | Returns | Description |
|---|---|---|
| `GetCardEntry(card_address bytes32)` | `CardEntry` | Full entry including `log_head_cid`, `policy_address`, `last_press_address`, `forward_to`, `exists` |
| `GetPressAuthorization(policy_address, press_address bytes32)` | `PressAuthEntry` | Key, active flag, timestamps |
| `GetPolicyAuthorizer(policy_address bytes32)` | `bytes[64]` | Authorizer secp256r1 public key (x||y) for the policy |
| `GetSubCardEntry(sub_card_address bytes32)` | `SubCardEntry` | Master card address, log head snapshot, `sub_card_doc_cid` (CID of the IPFS SubCardDocument), active flag. The app card address and app signature are in the SubCardDocument at that CID, not stored on-chain. |
| `GetOpenOfferCount(offer_id bytes32)` | `uint64` | Current acceptance count |
| `GetGovernanceKeyset(body_id GovernanceBodyId)` | `GovernanceKeyset` | Active keys, quorum, version |
| `IsPressActive(policy_address, press_address bytes32)` | `bool` | Quick check for verifiers |
| `CardExists(card_address bytes32)` | `bool` | Check without fetching full entry |
| `GetLogicContract()` | `address` | Address of the current logic contract |
| `GetPendingLogicUpgrade()` | `PendingUpgrade` | Pending upgrade proposal, or zero-value if none |
| `GetVerifierModule()` | `address` | Address of the current verifier module (stored in logic contract, not storage contract) |

---

## 6. Authorization Model

### 6.1 Card Write Gate

The following check is applied on every call to `RegisterCard`, `UpdateCardHead`, and `ClaimOpenOffer`. Failure at any step reverts the transaction with the corresponding error code (§8).

```
1. Resolve policy_address:
   - RegisterCard:    use the supplied policy_address argument.
   - UpdateCardHead:  read CardEntries[card_address].policy_address.
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

7. (UpdateCardHead only) Confirm prev_log_cid matches current
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

## 6.3 Upgradeability — Three-Contract Model (OQ-18, resolved 2026-06-14; extended 2026-06-19)

The registry is deployed as three contracts with distinct upgradeability properties:

---

### Storage contract (immutable address, no business logic)

Holds all protocol state: `CardEntries`, `PolicyAuthorizerKeys`, `PressAuthorizations`, `SubCardRegistrations`, `OpenOfferUseCounts`, `GovernanceKeysets`, `LogicContract`, `PendingLogicUpgrade`. This contract is **never redeployed**. Its address is the stable protocol identifier — the address presses write to, verifiers read from, and monitoring infrastructure watches.

The storage contract exposes only:
- Getter functions (publicly readable).
- Setter functions callable exclusively by `LogicContract` (see §3.7).
- The unconditional storage invariants enforced in setters (see §3.7).

The storage contract has no business logic, no authorization checks beyond `msg.sender == LogicContract`, and emits no events. It cannot be upgraded.

---

### Logic contract (upgradeable, 7-day timelock)

Implements all write operations (§4.1–4.13), authorization checks (§6.1–6.2), and event emission. Reads from and writes to the storage contract via the setter interface. Delegates all signature verification to the verifier module via cross-contract call.

The logic contract also implements `ProposeLogicUpgrade`, `ConfirmLogicUpgrade`, and `CancelLogicUpgrade` (§4.14). These are the only operations that modify `LogicContract` in the storage contract.

**UpgradeLogic** (§4.14) governance:
- Governed by `RootPolicyBody` quorum.
- Mandatory 7-day timelock between `ProposeLogicUpgrade` and `ConfirmLogicUpgrade`.
- Second quorum signature required at confirmation (fresh signatures, not a replay of the proposal).
- Governance keyset version must match between proposal and confirmation; a keyset rotation invalidates pending proposals.
- A `CancelLogicUpgrade` operation allows the governance body to withdraw a proposal before the timelock elapses.

**Blast-radius limit of a logic upgrade.** A malicious logic contract (whether from a compromised governance key or a bug in the proposed implementation) can misuse write authority to the storage contract's setters. However, the unconditional storage invariants (§3.7) are enforced by the storage contract itself and cannot be overridden: existing card entries cannot be deleted, forwards cannot be overwritten, revocation timestamps cannot be zeroed. The core audit trail is permanent regardless of logic upgrade history.

The 7-day timelock exists specifically to bound the blast radius: any malicious proposal is visible on-chain for 7 days before it can take effect, giving the broader community, monitoring infrastructure, and remaining governance key holders time to detect, alert, and respond.

**Gas cost of logic separation.** Each write operation incurs one additional cross-contract call from the logic contract into the storage contract per setter invocation (~2,100 gas base per call). For typical operations (`RegisterCard`: ~2–3 setter calls, `UpdateCardHead`: ~1–2), this adds ~4,000–6,000 gas per write — approximately $0.001–0.003 at current Arbitrum One gas prices. This is not a blocking cost.

---

### Verifier module (upgradeable, 48-hour timelock)

Contains signature verification logic only. In Phase 1, delegates secp256r1 verification to the RIP-7212 precompile at `0x100`. In Phase 3, upgraded to a Stylus WASM contract performing ML-DSA-44 verification (ADR-012). The verifier module has no state; it is a pure computation contract. Its address is stored in the logic contract (not the storage contract), and it is called by the logic contract on every signature check.

```
VerifierModule: address   — Stored in the logic contract.
                            Phase 1: thin wrapper delegating to RIP-7212 precompile.
                            Phase 3: Stylus WASM contract for ML-DSA-44 verification.
                            Updated only via UpgradeVerifier governance operation.
```

**UpgradeVerifier** is a governance operation (governed by `RootPolicyBody` quorum) with a mandatory **48-hour timelock**. The proposed new verifier address is recorded in the logic contract at proposal time; the upgrade takes effect only after the timelock expires and a second confirmation transaction is submitted. Because the verifier module is stored in the logic contract rather than the storage contract, a verifier upgrade takes effect immediately on confirmation — there is no separate logic upgrade required to change the verifier address.

**Blast-radius limit of a verifier upgrade.** A malicious verifier module can accept invalid signatures for new writes, but cannot modify existing storage state (it has no storage access). This is the narrower blast radius of the two upgradeable components.

---

### Upgrade governance summary

| Operation | Timelock | Governing body | What changes |
|---|---|---|---|
| `UpgradeLogic` | 7 days | `RootPolicyBody` | All write operation logic, authorization checks |
| `UpgradeVerifier` | 48 hours | `RootPolicyBody` | Signature verification only |
| `RotateGovernanceKeys` | None (quorum required) | The body being rotated | Governance key set |

The storage contract itself is never upgraded. Its address is permanent.

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
    sub_card_doc_cid   bytes,    — CID of the SubCardDocument on IPFS; off-chain indexers use
                                   this to read the app card address, app signature, and other
                                   sub-card metadata without a separate on-chain lookup
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

AddressTransition(
    old_address        bytes32,  — Registry address of the superseded card
                                   (keccak256 of the old public key)
    new_address        bytes32,  — Registry address of the successor card
                                   (keccak256 of the new public key)
    timestamp          uint64
)

LogicUpgradeProposed(
    proposed_address   address,  — Address of the proposed new logic contract
    proposed_at        uint64,   — Block timestamp of the proposal
    timelock_expires   uint64    — Block timestamp after which confirmation is permitted
                                   (proposed_at + 7 days)
)

LogicUpgradeConfirmed(
    new_logic_address  address,  — Address of the new logic contract now active
    confirmed_at       uint64
)

LogicUpgradeCancelled(
    cancelled_address  address,  — Address of the proposal that was cancelled
    cancelled_at       uint64
)

PolicyDeletePermanentlyDisabled(
    timestamp   uint64
)
```

**`AddressTransition` purpose.** This event is the on-chain archive of address changes resulting from master key rotations. Off-chain indexers can build an `old_address → new_address` lookup table from these events, enabling resolution of old addresses even when the old card's IPFS content is no longer pinned and the IPFS-level `successor` field is unreachable. See `key_rotation.md §2.3`.

**Note:** Events do not include the new governance keys or press public keys in plaintext — these are available from the call data on the same transaction. Emitting 1,312-byte public keys in events would significantly increase log storage costs.

**Note on event emission location:** All events are emitted by the **logic contract**, not the storage contract. The storage contract emits no events. Monitoring infrastructure that subscribes to protocol events must target the logic contract address, and must update its subscription when a logic upgrade takes effect (i.e., listen for `LogicUpgradeConfirmed` to know when to re-point subscriptions). The storage contract address — used for direct state reads — is permanent and never changes.

---

## 8. Error Codes

| Code | Name | Trigger |
|---|---|---|
| E-01 | `CARD_ALREADY_EXISTS` | `RegisterCard` called for an address already in `CardEntries` |
| E-02 | `CARD_NOT_FOUND` | Operation targets an address not in `CardEntries` |
| E-03 | `UNRECOGNIZED_POLICY` | `policy_address` not in `PolicyAuthorizerKeys` |
| E-04 | `PRESS_NOT_AUTHORIZED` | No entry in `PressAuthorizations` for (policy, press) |
| E-05 | `PRESS_REVOKED` | Entry exists but `active == false` |
| E-06 | `INVALID_PRESS_SIGNATURE` | secp256r1 verification failure (via RIP-7212) for press signature; after Phase 3 upgrade: ML-DSA-44 failure |
| E-07 | `SEQUENCE_MISMATCH` | Press payload `sequence` does not equal `PressAuthEntry.next_sequence` |
| E-07G | `NONCE_REUSED` | Governance payload nonce seen in a prior governance transaction |
| E-08 | `STALE_PREV_CID` | `prev_log_cid` in `UpdateCardHeadPayload` does not match stored head |
| E-09 | `POLICY_ALREADY_REGISTERED` | `RegisterPolicy` for an already-registered address |
| E-10 | `SUB_CARD_NOT_FOUND` | `DeregisterSubCard` for an address not in `SubCardRegistrations` |
| E-11 | `SUB_CARD_ALREADY_ACTIVE` | `RegisterSubCard` for an address already registered and active |
| E-12 | `OFFER_EXPIRED` | `ClaimOpenOffer` after `expires_at` |
| E-13 | `OFFER_AT_CAPACITY` | `ClaimOpenOffer` when `use_count >= max_acceptances` |
| E-14 | `INVALID_ISSUER_SIGNATURE` | **Press-side rejection** — press detected an invalid ML-DSA-44 issuer signature on the `OpenCardOffer` document before submitting `ClaimOpenOffer`. Not an on-chain revert; the press refuses to submit. |
| E-15 | `GOVERNANCE_VERSION_MISMATCH` | Governance payload version does not match stored version |
| E-16 | `INVALID_GOVERNANCE_SIGNATURE` | One or more governance secp256r1 signatures fail RIP-7212 verification (or ML-DSA-44 after Phase 3 upgrade) |
| E-17 | `DUPLICATE_SIGNER` | Two governance signatures use the same key |
| E-18 | `INSUFFICIENT_QUORUM` | Valid distinct governance signatures < quorum threshold |
| E-19 | `QUORUM_TOO_LOW` | `RotateGovernanceKeys` proposes `new_quorum <= len(new_keys)/2` |
| E-20 | `KEYSET_TOO_SMALL` | `RotateGovernanceKeys` proposes fewer than 3 keys |
| E-21 | `LOG_CID_TOO_LONG` | CID bytes exceed 64-byte maximum |
| E-22 | `INVALID_MASTER_SIGNATURE` | **Press-side rejection** — press detected an invalid ML-DSA-44 master card holder signature before submitting `RegisterSubCard` or `DeregisterSubCard`. Not an on-chain revert; the press refuses to submit. |
| E-23 | `KEY_SCHEME_ALREADY_UPGRADED` | `RotateOnChainKeyScheme` called for a press already on ML-DSA-44 (`key_scheme == 1`) |
| E-24 | `SCHEME_UPGRADE_NOT_AVAILABLE` | `RotateOnChainKeyScheme` called while contract is still in Phase 1 (`key_scheme_phase == 0`) |
| E-25 | `ROTATION_PAYLOAD_EXPIRED` | `RotateOnChainKeyScheme` `deadline_block` has passed |
| E-26 | `MLDSA44_KEY_HASH_MISMATCH` | `new_mldsa44_pubkey` in `RotateOnChainKeyScheme` does not hash to the stored `mldsa44_key_hash` |
| E-27 | `FORWARD_ALREADY_SET` | `RegisterAddressForward` called for an `old_address` that already has a non-zero `forward_to` |
| E-28 | `FORWARD_ON_REVOKED_CARD` | **Press-side rejection** — press detected that the old card already has an 8xx or 9xx revocation entry before the forward was registered. Not an on-chain revert; the press refuses to submit. |
| E-29 | `CALLER_NOT_LOGIC_CONTRACT` | A call to a storage contract setter was made by an address other than `LogicContract`. Reverted by the storage contract. |
| E-30 | `UPGRADE_ALREADY_PENDING` | `ProposeLogicUpgrade` called while a prior proposal is still pending (not yet confirmed or cancelled). |
| E-31 | `UPGRADE_TIMELOCK_NOT_ELAPSED` | `ConfirmLogicUpgrade` called before 7 days have elapsed since `PendingLogicUpgrade.proposed_at`. |
| E-32 | `UPGRADE_ADDRESS_MISMATCH` | `proposed_logic_address` in `ConfirmLogicUpgrade` does not match `PendingLogicUpgrade.proposed_address`. |
| E-33 | `BATCH_SIZE_INVALID` | `BatchUpdateCardHeads` called with an empty `updates` array or with more than MAX_BATCH_SIZE (100) items. |
| E-34 | `BATCH_ITEM_INVALID` | `BatchUpdateCardHeads` item failed validation: duplicate `card_address` within the batch, or `card_address` belongs to a policy other than `policy_address`. |
| E-35 | `POLICY_DELETE_DISABLED` | `delete_policy_authorizer_key` called after `PolicyDeleteDisabled == true`. |
| E-36 | `POLICY_DELETE_ALREADY_DISABLED` | `DisablePolicyDeletePermanently` called when `PolicyDeleteDisabled` is already `true`. |

---

## 9. Open Questions

The following questions must be resolved before the contract is deployed or before the implementation phase begins. Questions are numbered sequentially from the existing open question list in `ARCHITECTURE.md`.

| ID | Area | Question | Priority |
|---|---|---|---|
| ~~**OQ-2**~~ | Engineering | ~~**ML-DSA-44 Stylus gas cost.**~~ **Resolved 2026-06-14.** On-chain write authorization switched to secp256r1 / RIP-7212 precompile. ML-DSA-44 is no longer used for on-chain verification in Phase 1. Estimated write cost ~$0.05–0.10 (calldata dominated by secp256r1 at 64-byte sig + 64-byte pubkey vs. ML-DSA-44's 2,420 + 1,312 bytes). ML-DSA-44 Stylus verifier is deferred to Phase 3 of the on-chain key upgrade path (ADR-012). | ~~Critical / Blocking~~ |
| ~~**OQ-15**~~ | Governance | ~~**Bootstrap: who sets the initial governance keysets?**~~ **Resolved 2026-06-14.** Deploy with 1-of-1 governance keyset (single deployer key). `RotateGovernanceKeys` expands the keyset as governance members are added; quorum required to add/remove members once multiple members exist. Implemented in §3.6. | ~~Critical / Blocking~~ |
| ~~**OQ-16**~~ | Engineering | ~~**SubCard holder key verification.**~~ **Resolved 2026-06-15 (INC-22).** Press mediates all sub-card registration and verifies the ML-DSA-44 master signature off-chain before submitting. Holder signature retained in calldata for auditability. Contract checks only press authorization (§6.1 write gate). Press-side E-22 if invalid. | ~~High~~ |
| ~~**OQ-4**~~ | Engineering | ~~**Recipient-initiated writes.**~~ **Resolved 2026-06-14.** All writes go through a press. Holder-initiated `UpdateCardHead` (self-revocation, key rotation) is submitted through a press; gas is paid by the issuing organization's press. Holders do not hold or spend ETH directly. | ~~High~~ |
| ~~**OQ-17**~~ | Engineering | ~~**Nonce storage and pruning.**~~ **Resolved 2026-06-14.** Per-press sequence numbers: `PressAuthEntry` has `next_sequence: uint64`; press-signed payloads include `"sequence": <uint64>`; contract checks `sequence == next_sequence` and increments on success. No nonce table or pruning required. Governance payloads retain timestamp-scoped random nonces. Implemented in §3.3. | ~~High~~ |
| ~~**OQ-18**~~ | Engineering | ~~**Contract upgradeability.**~~ **Resolved 2026-06-14.** Modular verifier architecture adopted (option c): immutable storage contract + upgradeable verifier module (§6.3). The verifier module starts as a thin RIP-7212 wrapper (Phase 1) and is upgraded to a ML-DSA-44 Stylus WASM verifier via `UpgradeVerifier` governance operation with 48-hour timelock when the key scheme upgrade occurs. | ~~High~~ |
| **OQ-3** | Engineering | **Minimum IPFS replication before on-chain write.** When a press calls `RegisterCard` or `UpdateCardHead`, it includes an IPFS CID. If the content is not yet replicated (the CID is not resolvable), verifiers will be unable to fetch the log entry. Should the protocol require presses to confirm a minimum replication count before submitting the on-chain transaction? How is this enforced? | **Medium** |
| ~~**OQ-19**~~ | Engineering | ~~**Batch write operation.**~~ **Resolved 2026-06-19.** `BatchUpdateCardHeads` added as §4.15. Restricted to a single policy per batch (preserves per-(policy, press) sequence semantics). Atomic execution (all-or-nothing). Single sequence increment for the entire batch. MAX_BATCH_SIZE = 100. Emits individual `CardHeadUpdated` events per item for indexer compatibility. `RegisterCard` batching deferred — open-offer and policy-address permutations make batch registration substantially more complex; revisit if press economics require it. | ~~Medium~~ |
| **OQ-20** | Governance | **Policy deregistration.** Once a policy is registered via `RegisterPolicy`, can it be deregistered? The current design has no delete operation for `PolicyAuthorizerKeys`. Removing a policy address would cause all presses authorized under it to lose write authority and all cards under it to become non-writable. This may be a desired kill-switch capability for compromised or abandoned policies, but it must be governed carefully. **Note (2026-06-19):** The three-contract model (§6.3) makes `DeregisterPolicy` straightforwardly addable via a future logic upgrade, without a storage migration. The storage invariant that `PolicyAuthorizerKeys` has no delete setter would need to be revisited if a deregistration path is adopted. **Note (resolution path):** `DisablePolicyDeletePermanently` (§4.16) allows governance to resolve OQ-20 in the "no deregistration" direction without a storage contract redeployment. The capability is present at deploy time; governance may permanently disable it once the governance charter decision is made. | **Medium** |
| **OQ-22** | Engineering | **Storage invariant scope.** The five unconditional invariants in §3.7 were chosen to preserve the audit trail (existence, forwards, timestamps). Are there additional invariants worth enforcing in the storage contract now, before the first logic upgrade path is exercised? Candidates: minimum quorum enforcement in `GovernanceKeysets` (currently checked by logic), monotonic `next_sequence` increments (currently checked by logic). Adding more invariants to the storage contract increases blast-radius protection but reduces flexibility of future logic upgrades. | **Low** |
| **OQ-14** | Governance | **Coercion resistance / governance key holder identity.** Should governance body key holders be pseudonymous (organizations or anonymous participants, harder to coerce) or identifiable (named individuals/organizations with public accountability, easier to hold accountable but more coercible)? Deferred pending governance charter design. Carried forward from `ARCHITECTURE.md` ADR-011. | **Medium** |
| **OQ-21** | Engineering | **Event indexing and the `approved_presses` sync problem.** ADR-011 notes that the `approved_presses` array in the policy card's IPFS content should be kept in sync with on-chain `PressAuthorizations` by tooling. The contract's `PressAuthorized` and `PressRevoked` events are the trigger. Should the protocol specify a canonical indexer interface (e.g., a subgraph schema) to make this sync reliable across implementations? | **Low** |
| **OQ-6** | Engineering | **Efficient log head change detection.** How does a client or verifier efficiently learn that a card's log head has changed since their last check — polling the registry via RPC on each verification, or subscribing to `CardHeadUpdated` events? The event-subscription path requires an indexer; the polling path is simpler but wastes RPC calls. Relevant for mobile clients with limited connectivity. | **Low** |

---

*This spec is derived from `ARCHITECTURE.md` (ADR-001, ADR-005, ADR-011), `protocol-objects.md` (§14, §15), and the raw notes corpus. Where this document and `protocol-objects.md §14` conflict, this document takes precedence for the on-chain `CardEntry` structure. The `protocol-objects.md §14` `RegistryEntry` description should be updated to reference this spec when it reaches accepted status.*
