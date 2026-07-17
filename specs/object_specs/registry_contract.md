# Card Protocol — Registry Contract Spec

**Version:** 0.6 (draft)  
**Date:** 2026-06-25  
**Status:** Draft  
**Contract target:** Arbitrum One (Stylus / WASM-compiled Rust)  
**Amends:** v0.5 — DNS admin card secp256r1 on-chain signing added. New storage table `DnsAdminCardKeys` (§3.11) maps DNS admin card addresses to secp256r1 public keys. `RegisterDomain` (§4.17) accepts and stores the admin's secp256r1 public key. `DeregisterDomain` (§4.18) clears it. `RegisterSubCard` (§4.3) gains two new parameters and an on-chain RIP-7212 verification step triggered when the master card is a DNS admin card; a compromised press can no longer register fraudulent sub-cards of domain admin cards without the admin's secp256r1 private key. Error code E-47 added. See also v0.4→v0.5: DNS authorization model hardened. `SetPolicyAddress` (§4.19) gains explicit domain-card binding check: `admin_card_address` must match `DomainRegistrations[domain].admin_card_address`; optional `sub_card_address` must be a registered direct sub-card of that admin card (`SubCardRegistrations` one-hop check). Governance-quorum write path split into dedicated `GovernanceSetPolicyAddress` (§4.23) for rollback and fraud remediation. `SetDnsGovernancePolicyAddress` (§4.24) added, making `DnsGovernancePolicyAddress` mutable via `DnsGovernanceBody` quorum rather than write-once. `PolicyAddressSet` event gains `sub_card_address` field. Two new events: `PolicyAddressGovernanceSet` and `DnsGovernancePolicyAddressUpdated`. Error codes E-45–E-46 added. See also v0.3→v0.4: DNS resolution support added. `DnsGovernanceBody` added to `GovernanceBodyId` enum (§3.6). New storage tables `DomainRegistrations` (§3.8), `PolicyAddresses` (§3.9), and global variable `DnsGovernancePolicyAddress` (§3.10). Six new write operations §4.17–4.22. Two new read operations in §5. Six new events in §7. Error codes E-37–E-44 in §8. See also `specs/dns_resolution.md` for the full DNS resolution protocol spec. See also v0.2→v0.3: three-contract architecture adopted (storage / logic / verifier). Logic contract is upgradeable via 7-day timelock `UpgradeLogic` (RootPolicyBody). Storage contract is immutable and enforces unconditional audit-trail invariants. §3.7, §4.14, §6.3 added/rewritten; events, error codes, and read operations updated. See also v0.1→v0.2: on-chain verification changed from ML-DSA-44 to secp256r1/RIP-7212 per ADR-012.

**Changelog (spec-consistency Phase 1):** §2's `CardEntry` field count corrected from "4-field" to "5-field" (Fix #1); §3.1 gains a clarifying note on currently-supported vs. reserved CID hash algorithms (Fix #6). See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, Tier 1 items 2–3):** documented two already-implemented, previously-undocumented behaviors — §4.25 `SetProtocolVersion` (write op, §5 read op, `ProtocolVersionUpdated` event) and §4.3's new precondition 2a / error `E-48 SUB_CARD_ADDRESS_RETIRED` (a deregistered sub-card address can never be re-registered). See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 2, Step C):** §4.4 `DeregisterSubCard`'s off-chain (press-verified) authorization now accepts a valid signature from any of three signers — the master card holder key, the requesting app's own card key, or the sub-card's own key — as independent, sufficient paths, applicable to both suspected-compromise (810) and benign (811) removal scenarios; the master-key path remains available as a recovery fallback (Decision (b), resolved). §8's `E-22` description updated to match. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

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
   - 3.8 [DomainRegistrations](#38-domainregistrations)
   - 3.9 [PolicyAddresses](#39-policyaddresses)
   - 3.10 [DnsGovernancePolicyAddress](#310-dnsgovernancepolicyaddress)
   - 3.11 [DnsAdminCardKeys](#311-dnsadmincardkeys)
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
   - 4.17 [RegisterDomain](#417-registerdomain)
   - 4.18 [DeregisterDomain](#418-deregisterdomain)
   - 4.19 [SetPolicyAddress](#419-setpolicyaddress)
   - 4.20 [RemovePolicyAddress](#420-removepolicyaddress)
   - 4.21 [ClearDomainEntries](#421-cleardomainentries)
   - 4.22 [FlagDomainFraudRisk](#422-flagdomainfraudrisk)
   - 4.23 [GovernanceSetPolicyAddress](#423-governancesetpolicyaddress)
   - 4.24 [SetDnsGovernancePolicyAddress](#424-setdnsgovernancepolicyaddress)
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

This spec extends and supersedes the `RegistryEntry` description in `protocol-objects.md §14`. The per-card entry structure defined there — `(address, log_head_cid)` — is expanded here with two additional on-chain fields: `policy_address` and `last_press_address` (§3.1). **`protocol-objects.md §14` has been updated (2026-06-14) to show the full 5-field `CardEntry` struct and reference this spec as authoritative.**

The governance tables (`PolicyAuthorizerKeys`, `PressAuthorizations`, `RegisterPolicy`, `AuthorizePress`, `RevokePress`, `RotateAuthorizerKey`) are adopted from `ARCHITECTURE.md` ADR-011, which is the authoritative source for their original specification. This document extends them with the full function signatures, authorization checks, and storage layout required for implementation.

**Note on sub-card directory updates (codes 510/511/512):** The holder's `active_subcards` field (per `protocol-objects.md §1.1`) is maintained entirely off-chain in the card's IPFS log. When codes 510 (addition), 511 (removal), or 512 (rotation) are posted as `LogEntry` records, the press validates them (confirming holder-only authorization) and posts them to IPFS; the contract's on-chain registry pointer is updated (via `UpdateCardHead`, §4.2) just like any other log entry. The contract itself plays no special role for 510/511/512 — it neither validates nor stores `active_subcards`. This is consistent with the contract's general role as a write-gate for authorization and a pointer-store for content on IPFS; the contract does not validate log entry content.

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

**Note on currently-supported vs. reserved hash algorithms:** the 64-byte size accommodates all three algorithms above for future flexibility, but the reference press implementation (`press.md §5.1`'s `pinToIPFS` CID-rederivation step) currently only produces and validates SHA2-256 CIDs. SHA3-256 and BLAKE3 are reserved for future use and are not currently implemented by any press in this spec set.

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

    revoked_at        uint64         — Unix timestamp of the most recent RevokePress call; 0 if
                                      never revoked or if subsequently re-authorized. A previously-
                                      revoked press may be re-authorized via AuthorizePress, which
                                      resets this field to 0. Full revocation/re-authorization
                                      history is preserved in the PressRevoked and PressAuthorized
                                      event log.
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

Three governance bodies, each with an M-of-N quorum key set. Each body's keyset is stored separately.

```
GovernanceKeysets: mapping (GovernanceBodyId → GovernanceKeyset)

GovernanceBodyId: enum { RootPolicyBody, PressRegistryBody, DnsGovernanceBody }

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
| `RegisterDomain` | `DnsGovernanceBody` |
| `DeregisterDomain` | `DnsGovernanceBody` |
| `ClearDomainEntries` | `DnsGovernanceBody` |
| `FlagDomainFraudRisk` | `DnsGovernanceBody` |
| `GovernanceSetPolicyAddress` | `DnsGovernanceBody` |
| `SetDnsGovernancePolicyAddress` | `DnsGovernanceBody` |

All three bodies govern with the same quorum verification logic (§6.2); they differ only in what operations they unlock. `DnsGovernanceBody` is bootstrapped as 1-of-1 (single deployer key) at deploy time, the same bootstrap pattern as `RootPolicyBody` and `PressRegistryBody`.

**`DnsGovernanceBody` scope.** The DNS Governance Body operates independently of `RootPolicyBody` and `PressRegistryBody`. Its keyset is self-amending via `RotateGovernanceKeys(DnsGovernanceBody, ...)`, authorized by the existing `DnsGovernanceBody` quorum. It has no supervisory relationship with the other two bodies. The DNS governance authority's operational mandate is specified in `governance/dns_governance_authority.md` (Phase 3 deliverable).

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
| `SubCardRegistrations[addr].deregistered_at` is write-once-non-zero: once set to a non-zero timestamp, no setter may overwrite or zero it. | `setSubCardEntry` setter |

These invariants preserve the audit trail and ensure that the core record of what has existed on-chain is permanent, independent of future protocol logic changes.

**Re-authorization after revocation.** A previously-revoked press may be re-authorized by the Press Registry Governance Body calling `AuthorizePress` again with the same `press_address`. On re-authorization, `revoked_at` is reset to `0` and `active` is set to `true`. The complete authorization history — including the original revocation timestamp — is preserved permanently in the `PressRevoked` and `PressAuthorized` on-chain event log and does not need to be retained in storage state.

---

---

### 3.11 DnsAdminCardKeys

Maps the on-chain address of a DNS admin card to its secp256r1 public key, enabling on-chain verification of the admin card holder's authorization for sub-card registrations.

```
DnsAdminCardKeys: mapping (bytes32 → bytes[64])

key:   card_address (bytes32)       — On-chain registry address of the DNS admin card
                                      (same key used in CardEntries and DomainRegistrations).
value: secp256r1_pubkey (bytes[64]) — secp256r1 public key (uncompressed x||y, 32+32 bytes)
                                      held by the domain admin card holder specifically for
                                      DNS admin operations. Verified via RIP-7212.
                                      Zero value (bytes[64](0)) means the card address is not
                                      a registered DNS admin card or has been deregistered.
```

**Written by:** `RegisterDomain` (§4.17) — stores the key when a domain admin card is registered. `DeregisterDomain` (§4.18) — clears the entry (sets to zero) when a domain is deregistered.

**Read by:** `RegisterSubCard` (§4.3) — if `DnsAdminCardKeys[master_card_address]` is non-zero, the sub-card registration requires an additional secp256r1 signature from the admin card holder, verified on-chain via RIP-7212. If zero, the standard ML-DSA-44 press-side check applies (unchanged behavior for non-DNS-admin master cards).

**Key management.** The secp256r1 keypair is separate from the admin card holder's ML-DSA-44 IPFS identity key. It is generated specifically for DNS admin on-chain operations. The private key must be held by the domain admin card holder — compromise of this key allows an attacker (if they also control a press) to authorize fraudulent sub-card registrations. Key rotation requires re-registration: the governance authority calls `DeregisterDomain` then `RegisterDomain` with the new secp256r1 key.

**Why a separate table rather than a field on `CardEntry`.** `CardEntry` is a general-purpose structure used by all cards in the protocol. Adding a secp256r1 key field to `CardEntry` would impose storage overhead on every card. Only DNS admin cards require on-chain secp256r1 signing; a dedicated table is more storage-efficient and keeps the general card model unchanged.

---

### 3.8 DomainRegistrations

One entry per registered `mcard://` domain. Keyed by the domain string (lowercase-normalized, no trailing dot, maximum 255 bytes per RFC 1035).

```
DomainRegistrations: mapping (string → DomainEntry)

DomainEntry {
    admin_card_address      bytes32   — On-chain registry address (CardEntry key) of the current
                                        active domain admin card. The card was issued under
                                        DnsGovernancePolicyAddress (§3.10). Set at RegisterDomain
                                        time. This is the card whose holder has authority to submit
                                        SetPolicyAddress calls for this domain (either directly or
                                        by delegating to sub-path-scoped sub-cards in SubCardRegistrations).

    registered_at           uint64    — Unix timestamp of the most recent RegisterDomain call for
                                        this domain. Updated on re-registration (new admin card
                                        replacing an old one). Prior registration timestamps are
                                        preserved in the DomainRegistered event log.

    fraud_risk              uint8     — Current fraud risk level.
                                        0 = normal (default; no restrictions)
                                        1 = monitored (public key registration required;
                                            brand-name scanning applied by authority)
                                        2 = suspended (SetPolicyAddress and RemovePolicyAddress
                                            rejected on-chain; E-39)
                                        Set by FlagDomainFraudRisk (§4.22). See dns_resolution.md §7.

    suspension_expires_at   uint64    — Unix timestamp after which a fraud_risk == 2 suspension
                                        lapses for resolution purposes. Zero if not currently
                                        suspended. The contract does NOT automatically reset
                                        fraud_risk to 0 when this timestamp is reached; the DNS
                                        governance authority must call FlagDomainFraudRisk to
                                        explicitly restore normal status after a suspension expires.

    exists                  bool      — True once RegisterDomain has been called for this domain.
                                        Used to distinguish unregistered domains (no entry) from
                                        domains with entries but no PolicyAddresses (registered but
                                        empty). Write-once-true: once set to true by RegisterDomain,
                                        no setter may reset it to false. DeregisterDomain sets
                                        fraud_risk to 0, clears admin_card_address, and clears
                                        suspension_expires_at, but leaves exists == true to preserve
                                        the audit trail that the domain was once registered.
}
```

**Storage note.** Mapping keys are Solidity `string` (dynamic type). In Stylus / Rust, this maps to `StorageString`. Keys MUST be lowercase-normalized before storage reads and writes. The storage contract does not validate domain format beyond rejecting empty strings and strings exceeding 255 bytes.

---

### 3.9 PolicyAddresses

One entry per registered domain/path pair. Keyed by a hash of the domain and path.

```
PolicyAddresses: mapping (bytes32 → bytes32)

key:   keccak256(<domain_bytes> || 0x00 || <path_bytes>)
         — <domain_bytes>: UTF-8 encoding of the lowercase domain string (no trailing dot).
           <path_bytes>:   UTF-8 encoding of the path string (no leading slash; case-sensitive).
           0x00:           Single zero-byte separator preventing hash collisions between
                           a domain with empty path and a domain/path pair where the path
                           begins with the domain prefix. This derivation is canonical;
                           all callers MUST use exactly this form.
           Example: domain "nytimes.com", path "staff/reporter"
                    → keccak256(bytes("nytimes.com") || 0x00 || bytes("staff/reporter"))

value: bytes32
         — On-chain registry address (CardEntry key) of the policy card active at this
           domain/path. Zero value (bytes32(0)) means no entry is registered. A zero
           response from LookupPolicyAddress MUST be treated as "not registered."
           The policy card's IPFS content is fetched via GetCardEntry(value).log_head_cid.
```

**No iteration required.** `PolicyAddresses` is a flat mapping; there is no on-chain way to enumerate all paths for a domain. `ClearDomainEntries` (§4.21) clears entries by re-deriving their keys from a list of paths supplied in the governance payload. The list of active paths is an off-chain responsibility of the DNS governance authority, which tracks them via `PolicyAddressSet` and `PolicyAddressRemoved` events.

---

### 3.10 DnsGovernancePolicyAddress

A single global storage variable holding the on-chain policy address under which all domain admin cards are issued.

```
DnsGovernancePolicyAddress: bytes32
```

- Initialized to `bytes32(0)` at storage contract deployment. Set to the DNS governance authority's policy address during bootstrap via `SetDnsGovernancePolicyAddress` (§4.24, requires `DnsGovernanceBody` quorum).
- **Mutable via `DnsGovernanceBody` quorum.** Unlike `LogicContract` (which has a timelock), `DnsGovernancePolicyAddress` is updated by a single governance operation. This is an intentional escape hatch for policy key compromise recovery: the governance body can rotate to a new policy, re-issue domain admin cards under it, and update each domain via `RegisterDomain`. See §4.24 for the full migration warning.
- **Used by:** `SetPolicyAddress` (§4.19) to verify that the submitting press is authorized under the DNS governance policy (`PressAuthorizations[DnsGovernancePolicyAddress][press_address]`). Also used at `RegisterDomain` time to verify that the admin card being registered was issued under this policy.
- **Zero-value guard.** `SetPolicyAddress` and `RemovePolicyAddress` (press path) MUST revert with E-40 if `DnsGovernancePolicyAddress == bytes32(0)`. `GovernanceSetPolicyAddress` (§4.23) and `RegisterDomain` (§4.17) also check this. `SetDnsGovernancePolicyAddress` itself is the only operation that may write a non-zero value when the current value is zero.

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
    admin_secp_payload     bytes,      — Canonical RFC 8785 JSON of AdminAuthorizeSubCardPayload (see below).
                                         Required (non-empty) when DnsAdminCardKeys[master_card_address]
                                         is non-zero (master is a DNS admin card). Empty bytes otherwise.
    admin_secp_signature   bytes[64]   — secp256r1 signature (r||s) over keccak256(admin_secp_payload),
                                         verified on-chain via RIP-7212 against
                                         DnsAdminCardKeys[master_card_address].
                                         Required (non-zero) when master is a DNS admin card.
                                         Must be bytes[64](0) when master is not a DNS admin card.
) → void
```

**`RegisterSubCardPayload` (press-signed):**

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

**`AdminAuthorizeSubCardPayload` (admin card secp256r1-signed; required only when master is a DNS admin card):**

```json
{
  "op":                  "admin_authorize_sub_card",
  "sub_card_address":    "<base64url — bytes32>",
  "master_card_address": "<base64url — bytes32>",
  "sub_card_doc_cid":    "<base64url — CID bytes of the SubCardDocument on IPFS>",
  "timestamp":           "<ISO 8601>"
}
```

The `sub_card_address` and `sub_card_doc_cid` fields in `AdminAuthorizeSubCardPayload` must match the corresponding calldata parameters exactly. The contract verifies this consistency before accepting the signature. Replay prevention is provided by `sub_card_address` uniqueness — the contract already rejects any `sub_card_address` with an existing active `SubCardRegistrations` entry, so each admin-signed authorization can be submitted at most once without a separate nonce.

**Preconditions checked by contract:**

1. `master_card_address` exists in `CardEntries`.
2. `sub_card_address` does not already exist in `SubCardRegistrations` with `active == true`. Error: `SUB_CARD_ALREADY_ACTIVE` (E-11).
2a. **If `sub_card_address` exists in `SubCardRegistrations` with `deregistered_at != 0` (previously registered, since deregistered), this call is rejected with `SUB_CARD_ADDRESS_RETIRED` (E-48)** — a deregistered sub-card address can never be re-registered, matching the `deregistered_at` write-once-non-zero storage invariant (§3.7). Added 2026-07-16, Phase 3 Tier 1 item 3.
3. `registration_log_head` matches `CardEntries[master_card_address].log_head_cid` at call time.
4. Press authorization checks (§6.1) pass for the master card's policy.
5. **Admin card secp256r1 check (conditional on master card type):**
   - If `DnsAdminCardKeys[master_card_address] != bytes[64](0)` (master is a DNS admin card):
     - `admin_secp_signature` must be non-zero. Error: E-47.
     - `admin_secp_payload` must encode `sub_card_address` and `sub_card_doc_cid` matching the calldata values. Error: E-47.
     - `admin_secp_signature` must verify via RIP-7212 against `DnsAdminCardKeys[master_card_address]` over `keccak256(admin_secp_payload)`. Error: E-47.
   - If `DnsAdminCardKeys[master_card_address] == bytes[64](0)` (master is not a DNS admin card):
     - `admin_secp_signature` must be `bytes[64](0)` and `admin_secp_payload` must be empty. Error: E-47 if either is non-zero/non-empty (prevents spurious signatures).

> **Master ML-DSA-44 signature is press-side only.** The press verifies `master_signature` (ML-DSA-44) off-chain against the holder public key from the card's `CardDocument` (fetched from IPFS) before submitting. The contract does not re-verify the ML-DSA-44 signature. The holder signature in calldata is retained as an auditable proof of holder intent. A press submitting without a valid ML-DSA-44 holder signature is a press policy violation (press-side error E-22).

> **Admin secp256r1 signature is on-chain verified.** For DNS admin master cards, the admin card holder's secp256r1 signature is verified by the contract via RIP-7212. A compromised press cannot register a fraudulent sub-card of a domain admin card without possession of the admin holder's secp256r1 private key, regardless of whether it skips the ML-DSA-44 press-side check.

> **App-chain verification is press-side only.** Before submitting `RegisterSubCard`, the press reads the `SubCardDocument` at `sub_card_doc_cid` from IPFS, verifies `app_signature`, and walks the `app_card` chain using `app_card_pubkey` to confirm it reaches the governance authority's app-certification policy root (applying the keccak256 binding check: `keccak256(app_card_pubkey)` must equal the `app_card` pointer address, and each subsequent hop uses the app card's own `ancestry_pubkeys`). The contract stores only the CID pointer to this document; it does not perform any app-chain verification. Runtime verifiers rely on the press having completed this check at registration time — they do not re-walk the app-certification chain independently (see `protocol-objects.md §16` Verifier chain walk).

**State changes:**

- Creates `SubCardRegistrations[sub_card_address] = { master_card_address, registration_log_head, sub_card_doc_cid, active: true, registered_at: block.timestamp, deregistered_at: 0 }`.

**Acceptance criteria (DNS admin card path):**

- [ ] `RegisterSubCard` with a DNS admin master and a valid `AdminAuthorizeSubCardPayload` signed by the correct secp256r1 key succeeds (all other preconditions passing).
- [ ] Returns E-47 if master is a DNS admin card and `admin_secp_signature` is `bytes[64](0)`.
- [ ] Returns E-47 if `admin_secp_payload` encodes `sub_card_address` or `sub_card_doc_cid` that differ from the calldata values.
- [ ] Returns E-47 if secp256r1 signature verification against `DnsAdminCardKeys[master_card_address]` fails.
- [ ] Returns E-47 if master is not a DNS admin card (`DnsAdminCardKeys` entry is zero) but `admin_secp_signature` is non-zero.
- [ ] `RegisterSubCard` with a non-DNS-admin master and `admin_secp_signature == bytes[64](0)` behaves identically to the pre-v0.6 behavior (no regression).

---

### 4.4 DeregisterSubCard

**Called by:** Press (authorized for the card's policy), on behalf of the sub-card holder or issuing organization. Gas is paid from the requesting app's pre-funded gas account (see §4.12); if the app account has insufficient balance, the issuing organization's press sponsors the cost.  
**Purpose:** Mark a sub-card as inactive (lost device, key rotation, app access revocation). Existing signatures from the sub-card that predate deregistration remain verifiable; new authentications using that sub-card key are rejected by verifiers.

```
DeregisterSubCard(
    sub_card_address   bytes32,
    sig_payload        bytes,
    signature          bytes[2420]  — ML-DSA-44; verified off-chain by press against one of
                                      three possible signers (see note below)
) → void
```

**Preconditions checked by contract:**

1. `sub_card_address` exists in `SubCardRegistrations` with `active == true`.
2. Press authorization checks (§6.1) pass for the master card's policy.

> **Signature authorization is press-side only, with three independent valid signer paths (Decision (b), `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`).** The press verifies `signature` over `sig_payload` against **any one** of the following ML-DSA-44 keys — any single valid signature from any one of the three is sufficient; the contract does not re-verify the signature or care which path was used:
>
> - **(a) the master card's holder key** — resolved from the master card's `CardDocument` on IPFS (the `holder_primary_card_pubkey`/`recipient_pubkey` of the master card itself, per §4 note below);
> - **(b) the requesting app's own card key** — resolved from the `SubCardDocument`'s `app_card_pubkey` at `sub_card_doc_cid`; or
> - **(c) the sub-card's own key** — resolved from the `SubCardDocument`'s `recipient_pubkey` at `sub_card_doc_cid`.
>
> This applies uniformly regardless of whether the deregistration is triggered by a suspected key compromise (code 810) or a benign/cooperative removal such as app uninstall or device retirement (code 811) — both scenarios are valid triggers for any of the three signers (`subcard_creation_policy.md`/`wallet_sdk.md §6.4`).
>
> **The master-key path remains available as a recovery fallback.** Paths (b) and (c) exist so the app or the sub-card itself can cooperatively self-deregister without requiring the holder's primary key to be online. The master-key path (a) stays available independently of app/device cooperation — e.g. if the app is uninstalled or unreachable and the holder needs to force-deregister a sub-card the app itself can no longer cooperate on. If the primary card key has been lost and not yet recovered, and neither the app nor the sub-card key is available either, the holder must complete key recovery before deregistering that sub-card.

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

**Phase 1 implementation note:** The current logic contract hardcodes `key_scheme = 0` (secp256r1) when writing the updated keyset, regardless of the `key_scheme` value in the governance payload or the new keys supplied. The spec §4.10 note states that governance bodies upgrade to ML-DSA-44 keys via `RotateGovernanceKeys` during Phase 2, but this requires a logic upgrade first — the Phase 2 logic contract must be modified to read `key_scheme` from the call parameters rather than hardcoding `0`. This discrepancy is intentional for Phase 1 and must be addressed in the Phase 2 logic upgrade spec.

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
- [ ] `RegisterAddressForward` returns E-06 if `secp256r1_sig` does not verify against the registered key.
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

### 4.17 RegisterDomain

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Create or update the `DomainRegistrations` entry for a domain after the DNS governance authority has verified TXT record ownership. Sets the active domain admin card address for the domain.

```
RegisterDomain(
    domain               string,    — Lowercase domain string (no trailing dot). Maximum 255 bytes.
    admin_card_address   bytes32,   — On-chain registry address of the domain admin card to register.
                                      The card must already exist in CardEntries and must have been
                                      issued under DnsGovernancePolicyAddress.
    admin_secp256r1_key  bytes[64], — secp256r1 public key (uncompressed x||y, 32+32 bytes) held by
                                      the domain admin card holder for on-chain sub-card authorization.
                                      Stored in DnsAdminCardKeys[admin_card_address]. The holder
                                      generates this keypair specifically for DNS admin operations;
                                      it is distinct from their ML-DSA-44 IPFS identity key.
    governance_payload   bytes,     — Canonical RFC 8785 JSON of RegisterDomainPayload (see below)
    governance_sigs      bytes[]    — secp256r1 signatures (r||s, 64 bytes each) from DnsGovernanceBody
                                      key holders; verified via RIP-7212
) → void
```

**`RegisterDomainPayload`:**

```json
{
  "op":                   "register_domain",
  "domain":               "<domain string>",
  "admin_card_address":   "<base64url — bytes32>",
  "admin_secp256r1_key":  "<base64url — 64 bytes, secp256r1 x||y>",
  "governance_version":   <uint32 — current GovernanceKeysets[DnsGovernanceBody].version>,
  "nonce":                "<base64url>",
  "timestamp":            "<ISO 8601>"
}
```

**Preconditions:**

1. `domain` is non-empty and does not exceed 255 bytes.
2. `admin_card_address` exists in `CardEntries` (the card is registered on-chain).
3. `CardEntries[admin_card_address].policy_address == DnsGovernancePolicyAddress` (the card was issued under the DNS governance policy).
4. If `DomainRegistrations[domain].exists == true`: the existing entry has no active admin card (`admin_card_address == bytes32(0)`) OR this call is an explicit re-registration authorized by governance quorum after the prior admin card was deactivated. **Error: E-38 if the domain already has an active admin card** (non-zero `admin_card_address`) — a new registration requires the prior admin to be cleared first via `DeregisterDomain`.
5. `DnsGovernanceBody` quorum signature check (§6.2).

**State changes:**

- Creates or updates `DomainRegistrations[domain]`:
  - Sets `admin_card_address = admin_card_address`.
  - Sets `registered_at = block.timestamp`.
  - Sets `fraud_risk = 0` (new registrations always start at normal risk).
  - Sets `suspension_expires_at = 0`.
  - Sets `exists = true` (write-once; already true on re-registration).
- Sets `DnsAdminCardKeys[admin_card_address] = admin_secp256r1_key`.
- Emits `DomainRegistered(domain, admin_card_address, block.timestamp)`.

**Acceptance criteria:**

- [ ] `RegisterDomain` with valid quorum signatures and an unregistered domain creates `DomainRegistrations[domain]` with correct fields, writes `DnsAdminCardKeys[admin_card_address]`, and emits `DomainRegistered`.
- [ ] `RegisterDomain` for a domain that already has a non-zero `admin_card_address` returns E-38 without modifying state.
- [ ] `RegisterDomain` for a domain whose prior entry has `admin_card_address == bytes32(0)` (cleared by `DeregisterDomain`) succeeds and re-registers the domain.
- [ ] `RegisterDomain` where `admin_card_address` does not exist in `CardEntries` returns E-02.
- [ ] `RegisterDomain` where `CardEntries[admin_card_address].policy_address != DnsGovernancePolicyAddress` returns E-40.
- [ ] `RegisterDomain` with insufficient governance signatures returns E-18.
- [ ] `RegisterDomain` always sets `fraud_risk = 0` and `suspension_expires_at = 0` regardless of prior state.
- [ ] After `RegisterDomain`, `GetDnsAdminCardKey(admin_card_address)` returns the registered secp256r1 key.
- [ ] After `RegisterDomain`, a `RegisterSubCard` call with `master_card_address == admin_card_address` and no `admin_secp_signature` returns E-47.

---

### 4.18 DeregisterDomain

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Clear the active admin card address from a domain entry, preventing new `SetPolicyAddress` submissions under the domain. Used during domain handoff (the prior admin is removed before the new admin is registered), or to permanently close a domain registration.

```
DeregisterDomain(
    domain               string,
    governance_payload   bytes,
    governance_sigs      bytes[]   — DnsGovernanceBody quorum
) → void
```

**`DeregisterDomainPayload`:**

```json
{
  "op":                 "deregister_domain",
  "domain":             "<domain string>",
  "governance_version": <uint32>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Preconditions:**

1. `DomainRegistrations[domain].exists == true` (domain is registered). Error: E-37 if not found.
2. `DnsGovernanceBody` quorum signature check (§6.2).

**State changes:**

- Records `old_admin = DomainRegistrations[domain].admin_card_address`.
- Sets `DomainRegistrations[domain].admin_card_address = bytes32(0)`.
- Sets `DnsAdminCardKeys[old_admin] = bytes[64](0)` — clears the admin card's secp256r1 key so the deregistered card can no longer authorize sub-card registrations.
- Does NOT clear `exists` (the domain's audit history is preserved).
- Does NOT clear `fraud_risk` or `suspension_expires_at` (fraud status survives deregistration; a re-registered domain does not inherit a clean slate if it was previously flagged — that requires an explicit `FlagDomainFraudRisk(domain, 0, 0)` call).
- Emits `DomainDeregistered(domain, block.timestamp)`.

**Note:** `DeregisterDomain` clears the admin card reference and its secp256r1 key, but does not remove `PolicyAddresses` entries. The DNS governance authority SHOULD call `ClearDomainEntries` (§4.21) in the same governance action or immediately after to remove the domain's policy entries. Leaving stale entries means `LookupPolicyAddress` will continue to return results for the deregistered domain until the entries are explicitly cleared.

**Acceptance criteria:**

- [ ] `DeregisterDomain` for a registered domain sets `admin_card_address = bytes32(0)`, clears `DnsAdminCardKeys[old_admin]` to zero, and emits `DomainDeregistered`.
- [ ] `DeregisterDomain` for an unregistered domain (exists == false) returns E-37.
- [ ] `DeregisterDomain` does not clear `fraud_risk` or `suspension_expires_at`.
- [ ] `DeregisterDomain` does not clear `exists`.
- [ ] After `DeregisterDomain`, `GetDnsAdminCardKey(old_admin_card_address)` returns `bytes[64](0)`.
- [ ] After `DeregisterDomain`, a `RegisterSubCard` call with the old admin card as master no longer requires `admin_secp_signature` (key is zero, check is skipped).
- [ ] After `DeregisterDomain`, a subsequent `RegisterDomain` for the same domain succeeds (the `admin_card_address == bytes32(0)` precondition is met).

---

### 4.19 SetPolicyAddress

**Called by:** Press authorized under `DnsGovernancePolicyAddress` policy, on behalf of a domain admin card holder or a sub-path-scoped sub-card holder.  
**Purpose:** Register or update the policy card address for a specific domain/path pair in `PolicyAddresses`. This is the core operation that makes `mcard://domain/path` URIs resolvable.

```
SetPolicyAddress(
    domain               string,    — Lowercase domain string.
    path                 string,    — Path string (no leading slash; case-sensitive). Maximum 512 bytes.
    policy_card_address  bytes32,   — On-chain registry address of the policy card to register at this
                                      domain/path. Must exist in CardEntries.
    admin_card_address   bytes32,   — On-chain registry address of the registered domain admin card.
                                      Must exactly match DomainRegistrations[domain].admin_card_address.
                                      Passed explicitly so the signed payload is self-describing.
    sub_card_address     bytes32,   — bytes32(0) if the domain admin card holder is submitting directly.
                                      Non-zero: the sub-path-scoped sub-card whose holder is submitting.
                                      Must be a direct sub-card of admin_card_address registered in
                                      SubCardRegistrations (one-hop only; sub-sub-cards not recognized).
    press_sig_payload    bytes,     — Canonical RFC 8785 JSON of SetPolicyAddressPayload (see below)
    press_signature      bytes[64]  — secp256r1 signature (r||s) over keccak256(press_sig_payload),
                                      verified via RIP-7212 against PressAuthorizations[
                                      DnsGovernancePolicyAddress][press_address].press_public_key
) → void
```

**`SetPolicyAddressPayload` (signed by press):**

```json
{
  "op":                   "set_policy_address",
  "domain":               "<domain string>",
  "path":                 "<path string>",
  "policy_card_address":  "<base64url — bytes32>",
  "admin_card_address":   "<base64url — bytes32>",
  "sub_card_address":     "<base64url — bytes32; zero bytes32 if admin submitting directly>",
  "press_address":        "<base64url — bytes32>",
  "sequence":             <uint64 — must equal PressAuthorizations[DnsGovernancePolicyAddress][press_address].next_sequence>,
  "timestamp":            "<ISO 8601>"
}
```

**Preconditions checked by contract:**

1. `DnsGovernancePolicyAddress != bytes32(0)` — DNS governance policy is initialized. Error: E-40.
2. `DomainRegistrations[domain].exists == true`. Error: E-37.
3. `DomainRegistrations[domain].fraud_risk != 2 OR block.timestamp >= DomainRegistrations[domain].suspension_expires_at` — domain not currently suspended. Error: E-39.
4. `admin_card_address == DomainRegistrations[domain].admin_card_address` — the supplied admin card is the registered domain admin. Error: E-46.
5. If `sub_card_address != bytes32(0)`:
   - `SubCardRegistrations[sub_card_address].active == true`. Error: E-45.
   - `SubCardRegistrations[sub_card_address].master_card_address == admin_card_address`. Error: E-45.
6. `PressAuthorizations[DnsGovernancePolicyAddress][press_address]` exists and `active == true`. Error: E-03 / E-04 / E-05.
7. `press_signature` verifies via RIP-7212 against `PressAuthorizations[DnsGovernancePolicyAddress][press_address].press_public_key` over `press_sig_payload`. Error: E-06.
8. `sequence` in `press_sig_payload` equals `PressAuthorizations[DnsGovernancePolicyAddress][press_address].next_sequence`. On success, `next_sequence` incremented by 1. Error: E-07.
9. `CardEntries[policy_card_address].exists == true`. Error: E-41.

**Why the contract does not re-check `admin_card_address.policy_address`.** `RegisterDomain` (§4.17) already verifies that `CardEntries[admin_card_address].policy_address == DnsGovernancePolicyAddress` before writing to `DomainRegistrations`. Any address stored in `DomainRegistrations[domain].admin_card_address` is therefore guaranteed to have been issued under the DNS governance policy by construction. Re-verifying here is redundant.

**Preconditions checked by press (off-chain only; not re-verified on-chain):**

- The holder's ML-DSA-44 signature over the `SetPolicyAddressIntent` is valid against the active card's public key from IPFS (admin card if `sub_card_address == 0`; sub-card if non-zero).
- If `sub_card_address != bytes32(0)`: the `dns_path_scope` regex in the sub-card's IPFS document matches `path`. Press-side error: E-44.
- If `DomainRegistrations[domain].fraud_risk == 1`: the domain admin's public key is registered with the DNS governance authority before submission.

**Security note — compromised press scope.** A compromised press cannot register fraudulent sub-cards of a domain admin card: `RegisterSubCard` now requires the admin's secp256r1 signature verified on-chain (§4.3 precondition 5), which a compromised press cannot forge. A compromised press is still able to submit fraudulent `SetPolicyAddress` calls for domains it legitimately administers (the secp256r1 key only gates sub-card registration, not direct policy writes). `GovernanceSetPolicyAddress` (§4.23) provides rollback for fraudulent entries; `RevokePress` stops further submissions.

**State changes:**

- Computes `key = keccak256(domain_bytes || 0x00 || path_bytes)`.
- Sets `PolicyAddresses[key] = policy_card_address`.
- Increments `PressAuthorizations[DnsGovernancePolicyAddress][press_address].next_sequence` by 1.
- Emits `PolicyAddressSet(domain, path, policy_card_address, admin_card_address, sub_card_address, press_address, block.timestamp)`.

**Acceptance criteria:**

- [ ] A valid call sets `PolicyAddresses[keccak256(domain||"\x00"||path)] = policy_card_address` and emits `PolicyAddressSet` with correct parameters including `admin_card_address` and `sub_card_address`.
- [ ] A subsequent `LookupPolicyAddress(domain, path)` returns the new `policy_card_address`.
- [ ] Returns E-40 if `DnsGovernancePolicyAddress == bytes32(0)`.
- [ ] Returns E-37 if `DomainRegistrations[domain].exists == false`.
- [ ] Returns E-39 if domain is actively suspended.
- [ ] Returns E-46 if `admin_card_address != DomainRegistrations[domain].admin_card_address`.
- [ ] Returns E-45 if `sub_card_address` is non-zero but not in `SubCardRegistrations` with `master_card_address == admin_card_address` and `active == true`.
- [ ] Returns E-45 if `sub_card_address` is a sub-card of a sub-card of the admin (depth > 1); the one-hop check fails.
- [ ] Returns E-04 / E-05 on press authorization failure.
- [ ] Returns E-06 on press signature verification failure.
- [ ] Returns E-07 on sequence mismatch.
- [ ] Returns E-41 if `CardEntries[policy_card_address].exists == false`.
- [ ] Press-side: rejects (E-44) submissions where `sub_card_address` is non-zero and the sub-card's `dns_path_scope` does not match `path`.

---

### 4.20 RemovePolicyAddress

**Called by:** Press authorized under `DnsGovernancePolicyAddress` policy, on behalf of a domain admin card holder; OR DNS Governance Body (quorum required) for governance-initiated removal.  
**Purpose:** Remove the policy card address for a specific domain/path pair from `PolicyAddresses`. After removal, `LookupPolicyAddress` returns zero for this path.

```
RemovePolicyAddress(
    domain               string,
    path                 string,
    card_address         bytes32,   — Zero bytes32 if called with governance quorum; otherwise the
                                      domain admin card address authorizing the removal.
    press_sig_payload    bytes,     — Empty bytes if called with governance quorum.
    press_signature      bytes[64], — Zero if called with governance quorum.
    governance_payload   bytes,     — Empty bytes if called by press on behalf of card holder.
    governance_sigs      bytes[]    — Empty array if called by press on behalf of card holder.
) → void
```

**Authorization paths (exactly one must be satisfied):**

**Path A — Press-authorized removal (card holder initiated):**
- Verifies press is authorized under `DnsGovernancePolicyAddress` (same checks as §4.19 preconditions 4–8).
- Verifies `card_address` is active and issued under `DnsGovernancePolicyAddress` (preconditions 7–8).
- `governance_sigs` must be an empty array.

**Path B — Governance-authorized removal (DNS governance body initiated, e.g., fraud response):**
- `DnsGovernanceBody` quorum signature check (§6.2) over `governance_payload`.
- `card_address` is ignored (set to `bytes32(0)` by convention); `press_sig_payload` and `press_signature` are ignored.
- `press_signature` must be `bytes[64](0)`.

**Shared preconditions (both paths):**

1. `PolicyAddresses[keccak256(domain||"\x00"||path)]` is non-zero (entry exists). Error: E-42.
2. `DomainRegistrations[domain].exists == true`. Error: E-37.

**State changes:**

- Sets `PolicyAddresses[keccak256(domain_bytes || 0x00 || path_bytes)] = bytes32(0)`.
- Emits `PolicyAddressRemoved(domain, path, block.timestamp)`.

**Note:** A zero value is the "not registered" sentinel (§3.9 zero-value semantics). Overwriting with zero is the correct removal mechanism; there is no `delete` operation.

**Acceptance criteria:**

- [ ] Path A (press): a valid press-authorized removal zeroes the `PolicyAddresses` entry and emits `PolicyAddressRemoved`.
- [ ] Path B (governance): a valid governance-quorum removal zeroes the entry and emits `PolicyAddressRemoved`.
- [ ] Returns E-42 if the `PolicyAddresses` entry is already zero (not registered).
- [ ] Returns E-37 if `DomainRegistrations[domain].exists == false`.
- [ ] Press path: returns E-04/E-05/E-06/E-07 on press authorization failures (same as §4.19).
- [ ] Governance path: returns E-18 if governance quorum is not met.
- [ ] After a successful removal, `LookupPolicyAddress(domain, path)` returns `bytes32(0)`.

---

### 4.21 ClearDomainEntries

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Remove all `PolicyAddresses` entries for a given domain. Used during domain handoff (clearing prior admin's entries before re-registration) and as part of the fraud suspension action.

```
ClearDomainEntries(
    domain               string,
    paths                string[],  — Ordered list of paths whose entries should be cleared.
                                      The contract computes keccak256(domain||"\x00"||path) for
                                      each path and zeroes the corresponding PolicyAddresses entry.
                                      Paths whose PolicyAddresses entry is already zero are skipped
                                      silently (no error).
    governance_payload   bytes,
    governance_sigs      bytes[]    — DnsGovernanceBody quorum
) → void
```

**`ClearDomainEntriesPayload`:**

```json
{
  "op":                 "clear_domain_entries",
  "domain":             "<domain string>",
  "paths":              ["<path1>", "<path2>", "..."],
  "governance_version": <uint32>,
  "nonce":              "<base64url>",
  "timestamp":          "<ISO 8601>"
}
```

**Why paths are caller-supplied.** `PolicyAddresses` is a flat mapping; the contract cannot enumerate keys. The DNS governance authority maintains the authoritative list of active paths for each domain (by indexing `PolicyAddressSet` and `PolicyAddressRemoved` events). The authority supplies this list in the governance payload, which is signed as part of the quorum signature — ensuring the path list is attested by a governance quorum and cannot be tampered with in transit.

**Preconditions:**

1. `DomainRegistrations[domain].exists == true`. Error: E-37.
2. `DnsGovernanceBody` quorum signature check (§6.2).
3. `len(paths) >= 1` and `len(paths) <= 500` (batch size limit, implementation-defined; prevents gas exhaustion). Error: E-33 (batch size invalid, reusing existing code).

**State changes:**

For each path in `paths`:
- Computes `key = keccak256(domain_bytes || 0x00 || path_bytes)`.
- If `PolicyAddresses[key] != bytes32(0)`: sets `PolicyAddresses[key] = bytes32(0)`.
- If `PolicyAddresses[key] == bytes32(0)`: no-op (skip silently).

After processing all paths:
- Emits `DomainEntriesCleared(domain, len(paths_cleared), block.timestamp)` where `len(paths_cleared)` is the count of paths that were non-zero before clearing.

**Acceptance criteria:**

- [ ] `ClearDomainEntries` with a valid path list zeroes all matching `PolicyAddresses` entries and emits `DomainEntriesCleared` with the correct cleared count.
- [ ] Paths that were already zero are skipped without error; they do not count toward `paths_cleared`.
- [ ] Returns E-37 if `DomainRegistrations[domain].exists == false`.
- [ ] Returns E-18 if quorum is not met.
- [ ] Returns E-33 if `paths` is empty or exceeds 500 entries.
- [ ] After `ClearDomainEntries`, `LookupPolicyAddress` returns zero for all cleared paths.

---

### 4.22 FlagDomainFraudRisk

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Set or update the fraud risk level for a registered domain. Used to escalate suspicious domains to "monitored" (level 1) or "suspended" (level 2) status, and to restore normal status (level 0) after a suspension expires.

```
FlagDomainFraudRisk(
    domain                  string,
    fraud_risk              uint8,    — New fraud risk level: 0, 1, or 2. Values > 2 are rejected.
    suspension_expires_at   uint64,   — Unix timestamp for suspension expiry.
                                        Required to be > block.timestamp if fraud_risk == 2.
                                        Must be 0 if fraud_risk == 0 or fraud_risk == 1.
    governance_payload      bytes,
    governance_sigs         bytes[]   — DnsGovernanceBody quorum
) → void
```

**`FlagDomainFraudRiskPayload`:**

```json
{
  "op":                    "flag_domain_fraud_risk",
  "domain":                "<domain string>",
  "fraud_risk":            <uint8>,
  "suspension_expires_at": <uint64>,
  "governance_version":    <uint32>,
  "nonce":                 "<base64url>",
  "timestamp":             "<ISO 8601>"
}
```

**Preconditions:**

1. `DomainRegistrations[domain].exists == true`. Error: E-37.
2. `fraud_risk <= 2` (values > 2 are invalid). Error: E-43 (invalid domain string reused for parameter validation — see §8 note).
3. If `fraud_risk == 2`: `suspension_expires_at > block.timestamp` (suspension expiry must be in the future). Error: E-43.
4. If `fraud_risk != 2`: `suspension_expires_at == 0`. Error: E-43.
5. `DnsGovernanceBody` quorum signature check (§6.2).

**State changes:**

- Sets `DomainRegistrations[domain].fraud_risk = fraud_risk`.
- Sets `DomainRegistrations[domain].suspension_expires_at = suspension_expires_at`.
- Emits `DomainFraudRiskUpdated(domain, fraud_risk, suspension_expires_at, block.timestamp)`.

**Acceptance criteria:**

- [ ] `FlagDomainFraudRisk(domain, 1, 0)` sets fraud_risk to 1, suspension_expires_at to 0, emits `DomainFraudRiskUpdated`.
- [ ] `FlagDomainFraudRisk(domain, 2, future_timestamp)` sets fraud_risk to 2 and suspension_expires_at, emits `DomainFraudRiskUpdated`.
- [ ] `FlagDomainFraudRisk(domain, 0, 0)` restores normal status (fraud_risk = 0, suspension_expires_at = 0), emits `DomainFraudRiskUpdated`.
- [ ] Returns E-37 if domain does not exist.
- [ ] Returns E-43 if fraud_risk > 2.
- [ ] Returns E-43 if fraud_risk == 2 and suspension_expires_at == 0 or <= block.timestamp.
- [ ] Returns E-43 if fraud_risk != 2 and suspension_expires_at != 0.
- [ ] Returns E-18 if quorum is not met.
- [ ] After `FlagDomainFraudRisk(domain, 2, t)`, a `SetPolicyAddress` call for that domain returns E-39 if block.timestamp < t.
- [ ] After `FlagDomainFraudRisk(domain, 0, 0)`, a subsequent `SetPolicyAddress` for that domain succeeds (assuming all other preconditions pass).

---

### 4.23 GovernanceSetPolicyAddress

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Directly write or clear a `PolicyAddresses` entry without going through a press or domain admin card. The primary use case is rollback after fraud: restoring a legitimate mapping that was overwritten by a fraudulent `SetPolicyAddress` call, or clearing an unauthorized entry when the domain admin is unavailable. Also used for emergency correction when a domain admin card has been compromised and no legitimate press submission is possible.

Unlike `SetPolicyAddress` (§4.19), this operation:
- Bypasses press and card holder authorization entirely.
- Works on suspended domains (fraud_risk == 2) — governance must be able to remediate even when a domain is locked.
- Can clear an entry by setting `policy_card_address = bytes32(0)` (equivalent to `RemovePolicyAddress` governance path).

```
GovernanceSetPolicyAddress(
    domain               string,
    path                 string,
    policy_card_address  bytes32,   — Target value to write. bytes32(0) clears the entry
                                      (same effect as RemovePolicyAddress governance path).
                                      If non-zero, must exist in CardEntries.
    governance_payload   bytes,
    governance_sigs      bytes[]    — DnsGovernanceBody quorum
) → void
```

**`GovernanceSetPolicyAddressPayload`:**

```json
{
  "op":                   "governance_set_policy_address",
  "domain":               "<domain string>",
  "path":                 "<path string>",
  "policy_card_address":  "<base64url — bytes32; zero bytes32 to clear the entry>",
  "governance_version":   <uint32 — current GovernanceKeysets[DnsGovernanceBody].version>,
  "nonce":                "<base64url>",
  "timestamp":            "<ISO 8601>"
}
```

**Preconditions:**

1. `DomainRegistrations[domain].exists == true`. Error: E-37.
2. If `policy_card_address != bytes32(0)`: `CardEntries[policy_card_address].exists == true`. Error: E-41.
3. `DnsGovernanceBody` quorum signature check (§6.2).

**Note:** No suspension check (precondition 3 of §4.19 is absent). Governance can write to any registered domain regardless of `fraud_risk` level.

**State changes:**

- Computes `key = keccak256(domain_bytes || 0x00 || path_bytes)`.
- Reads existing value: `old_policy_card_address = PolicyAddresses[key]`.
- Sets `PolicyAddresses[key] = policy_card_address`.
- Emits `PolicyAddressGovernanceSet(domain, path, policy_card_address, old_policy_card_address, block.timestamp)`.

**Acceptance criteria:**

- [ ] A valid governance-quorum call sets `PolicyAddresses[key]` to `policy_card_address` and emits `PolicyAddressGovernanceSet` with both new and old values.
- [ ] `policy_card_address = bytes32(0)` clears the entry; `LookupPolicyAddress` subsequently returns zero.
- [ ] Works on suspended domains (fraud_risk == 2) without reverting.
- [ ] Returns E-37 if domain does not exist.
- [ ] Returns E-41 if `policy_card_address` is non-zero but not in `CardEntries`.
- [ ] Returns E-18 if quorum is not met.
- [ ] `old_policy_card_address` in the event correctly reflects the value before the write (zero if entry was not previously set).

---

### 4.24 SetDnsGovernancePolicyAddress

**Called by:** DNS Governance Body (quorum required)  
**Purpose:** Update the global `DnsGovernancePolicyAddress` storage variable to point to a new DNS governance policy card. The primary use case is recovery from a policy authorizer key compromise: the governance body registers a new policy via `RegisterPolicy`, then calls this operation to redirect `SetPolicyAddress` authorization to the new policy.

> **⚠ Breaking change.** Changing `DnsGovernancePolicyAddress` orphans all existing domain admin cards — their `CardEntries[card_address].policy_address` will no longer match the new value, causing `RegisterDomain` checks to fail for them. All domains whose admin cards are orphaned will need their admin cards re-issued under the new policy and re-registered via `RegisterDomain`. Plan a full migration before executing this operation. Use `GovernanceSetPolicyAddress` (§4.23) for routine rollback; this operation is a last-resort escape hatch.

```
SetDnsGovernancePolicyAddress(
    new_policy_address   bytes32,   — On-chain registry address of the new DNS governance policy.
                                      Must exist in PolicyAuthorizerKeys (registered via RegisterPolicy).
    governance_payload   bytes,
    governance_sigs      bytes[]    — DnsGovernanceBody quorum
) → void
```

**`SetDnsGovernancePolicyAddressPayload`:**

```json
{
  "op":                    "set_dns_governance_policy_address",
  "new_policy_address":    "<base64url — bytes32>",
  "governance_version":    <uint32 — current GovernanceKeysets[DnsGovernanceBody].version>,
  "nonce":                 "<base64url>",
  "timestamp":             "<ISO 8601>"
}
```

**Preconditions:**

1. `new_policy_address != bytes32(0)`. Error: E-43.
2. `new_policy_address` exists in `PolicyAuthorizerKeys` (must be a recognized policy). Error: E-03.
3. `new_policy_address != DnsGovernancePolicyAddress` (no no-op updates). Error: E-43.
4. `DnsGovernanceBody` quorum signature check (§6.2).

**State changes:**

- Records `old_address = DnsGovernancePolicyAddress`.
- Sets `DnsGovernancePolicyAddress = new_policy_address`.
- Emits `DnsGovernancePolicyAddressUpdated(old_address, new_policy_address, block.timestamp)`.

**Acceptance criteria:**

- [ ] A valid governance-quorum call updates `DnsGovernancePolicyAddress` and emits `DnsGovernancePolicyAddressUpdated` with old and new addresses.
- [ ] Subsequent `RegisterDomain` calls check against the new `DnsGovernancePolicyAddress`.
- [ ] Subsequent `SetPolicyAddress` calls check press authorization against `PressAuthorizations[new_policy_address]`.
- [ ] Returns E-43 if `new_policy_address == bytes32(0)`.
- [ ] Returns E-03 if `new_policy_address` is not in `PolicyAuthorizerKeys`.
- [ ] Returns E-43 if `new_policy_address == DnsGovernancePolicyAddress` (no-op guard).
- [ ] Returns E-18 if quorum is not met.
- [ ] Domain admin cards issued under the old policy address become unregisterable under `RegisterDomain` after the update; their `CardEntries` entries are unaffected (the cards still exist, their `policy_address` field is immutable).

---

### 4.25 SetProtocolVersion

**Added 2026-07-16 (spec-consistency Phase 3, Tier 1 item 2) — documents an already-implemented operation this spec had omitted.**

**Called by:** Root Policy Governance Body (quorum required)
**Purpose:** Update the global protocol version string returned by `GetProtocolVersion()` (§5), which the press reads and attaches to every `CardDocument` it assembles (`protocol-objects.md §1`) and which message senders may attach to `SignedMessageEnvelope.payload.protocol_version`.

```
SetProtocolVersion(
    new_version          string,    — Must be non-empty. E.g. "0.2".
    governance_payload   bytes,
    governance_sigs      bytes[]    — RootPolicyBody quorum
) → void
```

**Preconditions:**

1. `new_version` is non-empty. Error: `INVALID_PAYLOAD`.
2. `RootPolicyBody` quorum signature check (§6.2).

**State changes:**

- Records `old_version` (the previously stored value, or `"0.1"` if the storage slot has never been set — contracts deployed before this operation was added are treated as v0.1).
- Sets the stored protocol version to `new_version`.
- Emits `ProtocolVersionUpdated(old_version, new_version, block.timestamp)`.

**Effective immediately.** Presses and message senders should call `GetProtocolVersion()` (§5) before assembling each artifact to pick up the new value. There is no transition window — verifiers continue to accept every version in their own `KNOWN_PROTOCOL_VERSIONS` list regardless of which version is currently live on-chain, until a future logic upgrade removes old entries from that list.

**Acceptance criteria:**

- [ ] A valid governance-quorum call updates the stored version and emits `ProtocolVersionUpdated` with the correct old/new values.
- [ ] `GetProtocolVersion()` reflects the new value immediately after the call confirms.
- [ ] Returns `INVALID_PAYLOAD` if `new_version` is empty.
- [ ] Returns the quorum-insufficiency error if `RootPolicyBody` quorum is not met.

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
| `LookupPolicyAddress(domain string, path string)` | `bytes32` | Returns `PolicyAddresses[keccak256(domain_bytes \|\| 0x00 \|\| path_bytes)]`. Returns `bytes32(0)` if no entry is registered at this domain/path. The domain is lowercased by the contract before key derivation. |
| `GetDomainRegistration(domain string)` | `DomainEntry` | Full domain entry including `admin_card_address`, `registered_at`, `fraud_risk`, `suspension_expires_at`, `exists`. Returns zero-value `DomainEntry` (exists = false) if the domain is not registered. |
| `GetDnsAdminCardKey(card_address bytes32)` | `bytes[64]` | Returns the secp256r1 public key registered for a DNS admin card via `RegisterDomain`. Returns `bytes[64](0)` if `card_address` is not a registered DNS admin card or if its domain has been deregistered. Used by presses to confirm whether a master card requires `admin_secp_signature` before submitting `RegisterSubCard`. |
| `GetProtocolVersion()` | `string` | The current protocol version (§4.25), e.g. `"0.1"`. Read by presses before assembling each `CardDocument` and by message senders populating `SignedMessageEnvelope.payload.protocol_version`. Returns `"0.1"` if `SetProtocolVersion` has never been called (added 2026-07-16, Phase 3 Tier 1 item 2). |

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

> **Known gap, confirmed 2026-07-16 (spec-consistency Phase 3, Tier 3 item (a)) — pending resolution, not yet fixed.** The write-gate implementation (`contracts/logic-contract/src/write_gate.rs`) verifies the press's signature over the signed payload and checks only `op` and `sequence` from that payload against contract state — it does not cross-check any other signed field (`card_address`, CIDs, `policy_address`, the `updates` array in batch operations, `domain`/`path` in DNS operations) against the actual calldata parameters being written. A valid signature+payload pair does not currently bind the signer to specific written content. The DNS-admin `AdminAuthorizeSubCardPayload` check (§4.3) has the same shape of gap: it confirms `sub_card_address`/`sub_card_doc_cid` are *present* in the payload but not that they *equal* the calldata values, despite this section's error `E-47` being intended to enforce that equality. The intended fix is a real field-by-field equality check — confirming the press is authorized to write the specific card/policy/domain named in the calldata, not just that *some* valid signature with the right sequence number exists — to be designed and implemented as a follow-up, not folded silently into this consistency pass. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (a).

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

PolicyDeregistered(
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
    body_id            uint8,    — 0 = RootPolicyBody, 1 = PressRegistryBody, 2 = DnsGovernanceBody
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

DomainRegistered(
    domain              string,   — Lowercase domain string
    admin_card_address  bytes32,  — On-chain registry address of the domain admin card
    timestamp           uint64
)

DomainDeregistered(
    domain      string,
    timestamp   uint64
)

PolicyAddressSet(
    domain               string,   — Lowercase domain string
    path                 string,   — Path string (no leading slash)
    policy_card_address  bytes32,  — The policy card address now registered at this domain/path
    admin_card_address   bytes32,  — The registered domain admin card
    sub_card_address     bytes32,  — The sub-card whose holder made the request; bytes32(0) if the
                                     admin card holder submitted directly
    press_address        bytes32,  — The press that submitted the transaction
    timestamp            uint64
)

PolicyAddressGovernanceSet(
    domain                  string,   — Lowercase domain string
    path                    string,   — Path string (no leading slash)
    policy_card_address     bytes32,  — The value written (bytes32(0) if entry was cleared)
    old_policy_card_address bytes32,  — The value before this write (bytes32(0) if entry was unset)
    timestamp               uint64
)

PolicyAddressRemoved(
    domain      string,
    path        string,
    timestamp   uint64
)

DomainEntriesCleared(
    domain          string,
    paths_cleared   uint32,   — Number of non-zero PolicyAddresses entries cleared in this call
    timestamp       uint64
)

DomainFraudRiskUpdated(
    domain                  string,
    fraud_risk              uint8,
    suspension_expires_at   uint64,
    timestamp               uint64
)

DnsGovernancePolicyAddressUpdated(
    old_address   bytes32,   — DnsGovernancePolicyAddress value before the update
    new_address   bytes32,   — New DnsGovernancePolicyAddress value
    timestamp     uint64
)

ProtocolVersionUpdated(
    old_version   string,   — Protocol version string before the update (§4.25)
    new_version   string,   — New protocol version string
    timestamp     uint64
)
```

**`AddressTransition` purpose (DNS resolution spec).** This event is the on-chain archive of address changes resulting from master key rotations. Off-chain indexers can build an `old_address → new_address` lookup table from these events, enabling resolution of old addresses even when the old card's IPFS content is no longer pinned and the IPFS-level `successor` field is unreachable. See `key_rotation.md §2.3`.

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
| E-22 | `INVALID_MASTER_SIGNATURE` | **Press-side rejection** — press detected an invalid ML-DSA-44 signature before submitting `RegisterSubCard` (master card holder signature only) or `DeregisterSubCard` (master card holder signature, requesting app card signature, or sub-card's own signature — see §4.4, Decision (b)). Not an on-chain revert; the press refuses to submit. |
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
| E-37 | `DOMAIN_NOT_FOUND` | Operation targets a domain not present in `DomainRegistrations` (`exists == false`). Applies to `DeregisterDomain`, `SetPolicyAddress`, `RemovePolicyAddress`, `ClearDomainEntries`, `FlagDomainFraudRisk`. |
| E-38 | `DOMAIN_ALREADY_REGISTERED` | `RegisterDomain` called for a domain that already has a non-zero `admin_card_address` in `DomainRegistrations`. The prior admin must be cleared via `DeregisterDomain` before re-registration. |
| E-39 | `DOMAIN_SUSPENDED` | `SetPolicyAddress` (or `RemovePolicyAddress` via press path) rejected because `DomainRegistrations[domain].fraud_risk == 2` and `block.timestamp < DomainRegistrations[domain].suspension_expires_at`. The domain is actively suspended. |
| E-40 | `CARD_NOT_DNS_GOVERNANCE_POLICY` | The `card_address` supplied to `SetPolicyAddress` or `RemovePolicyAddress` was not issued under `DnsGovernancePolicyAddress` (`CardEntries[card_address].policy_address != DnsGovernancePolicyAddress`), or `DnsGovernancePolicyAddress` is `bytes32(0)` (DNS governance not yet initialized). |
| E-41 | `POLICY_CARD_NOT_FOUND` | The `policy_card_address` supplied to `SetPolicyAddress` does not exist in `CardEntries` (`CardEntries[policy_card_address].exists == false`). |
| E-42 | `DOMAIN_PATH_ENTRY_NOT_FOUND` | `RemovePolicyAddress` called for a domain/path pair whose `PolicyAddresses` entry is already zero (not registered or already removed). |
| E-43 | `INVALID_DNS_PARAMETER` | A parameter to a DNS write operation failed validation: domain string is empty or exceeds 255 bytes (`RegisterDomain`, `DeregisterDomain`); `fraud_risk` value is > 2 or inconsistent with `suspension_expires_at` (`FlagDomainFraudRisk`). |
| E-44 | `DOMAIN_PATH_SCOPE_VIOLATION` | **Press-side rejection only.** The domain admin sub-card's `dns_path_scope` regex (from its IPFS card document) does not match the `path` argument in the `SetPolicyAddress` submission. The press refuses to submit the on-chain transaction. This is not an on-chain revert code. |
| E-45 | `SUB_CARD_NOT_DOMAIN_ADMIN_SUBCARD` | `sub_card_address` in `SetPolicyAddress` is non-zero but fails the on-chain binding check: either `SubCardRegistrations[sub_card_address]` does not exist, `active == false`, or `master_card_address != admin_card_address`. Sub-sub-cards (depth > 1 from the domain admin) also trigger this error since the one-hop check fails. |
| E-46 | `ADMIN_CARD_MISMATCH` | `admin_card_address` in `SetPolicyAddress` does not match `DomainRegistrations[domain].admin_card_address`. The caller supplied an admin card that is not the registered admin for this domain. |
| E-47 | `INVALID_ADMIN_CARD_SIGNATURE` | `RegisterSubCard` failed the admin card secp256r1 check (§4.3 precondition 5). Covers: missing signature when master is a DNS admin card; payload field mismatch (`sub_card_address` or `sub_card_doc_cid` inconsistent with calldata); RIP-7212 signature verification failure; and spurious non-zero signature when master is not a DNS admin card. |
| E-48 | `SUB_CARD_ADDRESS_RETIRED` | `RegisterSubCard` called for a `sub_card_address` that was previously registered and later deregistered (`SubCardRegistrations[sub_card_address].deregistered_at != 0`). Deregistered sub-card addresses can never be reused — `deregistered_at` is write-once-non-zero (§3.7), so a fresh registration attempt (which would write `deregistered_at = 0`) is rejected by the storage contract's invariant check before it can silently resurrect a retired entry. Added 2026-07-16, Phase 3 Tier 1 item 3 — this behavior was already implemented and intentional (audit-trail preserving); this error code was previously undocumented. |

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
| ~~**OQ-20**~~ | Governance | ~~**Policy deregistration.**~~ **Resolved 2026-07-16 (spec-consistency Phase 3).** `DeregisterPolicy` is a confirmed, intended governance kill-switch capability for compromised or abandoned policies, gated by `RootPolicyBody` quorum (`governance_ops.rs::deregister_policy`, already implemented and shipped). Removing a policy address causes all presses authorized under it to lose write authority and all cards under it to become permanently non-writable, with no re-registration path — governance must have a migration plan for affected cards before calling it. `DisablePolicyDeletePermanently` (§4.16) remains available as a separate, one-way governance action for charters that want to foreclose this capability entirely; absent that call, `DeregisterPolicy` stays available as designed. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (b). | ~~Medium~~ |
| **OQ-22** | Engineering | **Storage invariant scope.** The five unconditional invariants in §3.7 were chosen to preserve the audit trail (existence, forwards, timestamps). Are there additional invariants worth enforcing in the storage contract now, before the first logic upgrade path is exercised? Candidates: minimum quorum enforcement in `GovernanceKeysets` (currently checked by logic), monotonic `next_sequence` increments (currently checked by logic). Adding more invariants to the storage contract increases blast-radius protection but reduces flexibility of future logic upgrades. | **Low** |
| **OQ-14** | Governance | **Coercion resistance / governance key holder identity.** Should governance body key holders be pseudonymous (organizations or anonymous participants, harder to coerce) or identifiable (named individuals/organizations with public accountability, easier to hold accountable but more coercible)? Deferred pending governance charter design. Carried forward from `ARCHITECTURE.md` ADR-011. | **Medium** |
| **OQ-21** | Engineering | **Event indexing and the `approved_presses` sync problem.** ADR-011 notes that the `approved_presses` array in the policy card's IPFS content should be kept in sync with on-chain `PressAuthorizations` by tooling. The contract's `PressAuthorized` and `PressRevoked` events are the trigger. Should the protocol specify a canonical indexer interface (e.g., a subgraph schema) to make this sync reliable across implementations? | **Low** |
| ~~**OQ-6**~~ | Engineering | ~~**Efficient log head change detection.**~~ **Resolved 2026-07-11.** The Matrix Synapse policy module adopts the event-subscription path: a persistent watcher subscribes to `CardHeadUpdated`, filtered to the set of addresses (leaf + full ancestor chain) currently relevant to active room memberships, with a coarse backstop re-walk as a correctness floor against subscription loss. See `specs/process_specs/matrix_join_attestation_and_revocation.md §3` for the full design, including the watch-set construction, catch-up-on-reconnect handling, and the open question about which RPC provider (self-hosted vs. third-party) should serve the subscription given what the filter list itself reveals. This resolves the question for a server-side, always-on verifier; a mobile client with intermittent connectivity may still prefer polling on foreground — that narrower case remains open if it becomes relevant. | ~~Low~~ |

---

*This spec is derived from `ARCHITECTURE.md` (ADR-001, ADR-005, ADR-011), `protocol-objects.md` (§14, §15), and the raw notes corpus. Where this document and `protocol-objects.md §14` conflict, this document takes precedence for the on-chain `CardEntry` structure. The `protocol-objects.md §14` `RegistryEntry` description should be updated to reference this spec when it reaches accepted status.*
