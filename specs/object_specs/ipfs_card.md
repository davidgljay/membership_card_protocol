# Card Protocol — IPFS Card Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-16
**Status:** Draft — drafted as Phase 0 of the spec-consistency initiative (`plans/spec-consistency/`)

> **Provenance note.** Unlike this repo's other `object_specs/` entries, no dedicated object spec previously existed for "the card as stored on IPFS" — `specs/protocol-objects.md` defines `CardDocument` (§1) and `LogEntry` (§3) as generic object templates shared across every object type in the protocol, and `press.md`/`registry_contract.md` each describe fragments of card lifecycle (encryption, pinning, on-chain anchoring) from their own service's point of view. This document consolidates those fragments into one authoritative reference for the card as a first-class IPFS object: its structure, its content-addressing and pinning scheme, its relationship to the on-chain registry, and its versioning model. It does not introduce new protocol behavior — every claim here is sourced from `protocol-objects.md §1/§3/§14`, `press.md §3.4/§5.1`, and `registry_contract.md §3.1/§4.1-4.2`, which remain authoritative for implementation-level detail (function signatures, error codes, endpoint contracts). Where this document and one of those specs conflict, treat the conflict as a spec-consistency finding, not as this document silently overriding the other.

> **Changelog (spec-consistency Phase 1):** §6's on-chain/IPFS-side mapping table gains a `forward_to` row (Fix #1); §4's CID hash-algorithm claim is narrowed to distinguish currently-supported (SHA2-256) from reserved-for-future (SHA3-256/BLAKE3) (Fix #6). See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

> **Changelog (spec-consistency Phase 3, Tier 1 item 1):** §4 corrected to describe **Filebase** (the actual, confirmed-deliberate production IPFS pinning vendor) rather than Piñata, which this document had inherited from `press.md`'s then-stale text; the deployed code (`press/src/ipfs/client.ts`) has never used Piñata. §4's CID-validation claim is also corrected: the press does a fetch-and-byte-compare round trip, not an independent re-derivation of the CID from the uploaded bytes. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 1 item 1.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Card Structure (Genesis Document)](#2-card-structure-genesis-document)
3. [Content Encryption](#3-content-encryption)
4. [IPFS Content-Addressing and Pinning](#4-ipfs-content-addressing-and-pinning)
5. [The Card Log (Post-Genesis History)](#5-the-card-log-post-genesis-history)
6. [Relationship to the On-Chain Anchor](#6-relationship-to-the-on-chain-anchor)
7. [Card Versioning](#7-card-versioning)
8. [Dependencies](#8-dependencies)

---

## 1. Overview

A **card** is the protocol's core credential object. Every card — a holder's membership card, a policy card, a press sub-card — begins as a `CardDocument` JSON object posted to IPFS, and accumulates history as a singly-linked chain of `LogEntry` objects also posted to IPFS. The Arbitrum One registry contract (`registry_contract.md`) never stores card content; it stores only a pointer (the current log head CID) and a small amount of write-authorization metadata. IPFS is the sole store of record for card content; Arbitrum One is the sole store of record for "which CID is current" and "who is allowed to advance it."

This document covers the card as an IPFS object: its JSON structure, how it's encrypted at rest, how it's content-addressed and pinned, how its on-chain pointer relates to its IPFS content, and how a card's identity persists across key rotation.

**Format: JSON, not CBOR.** Cards are canonical RFC 8785 JSON (JCS — deterministic Unicode-code-point-ordered JSON, no whitespace) both at rest on IPFS and as the byte sequence signatures are computed over. There is no CBOR encoding anywhere in the current protocol; `serialization-conformance.json` is the shared conformance corpus that the verifier package and any SDK canonicalizer are tested against.

---

## 2. Card Structure (Genesis Document)

The genesis document of every card is a `CardDocument`, fully specified in `protocol-objects.md §1`. This section summarizes the shape; `protocol-objects.md §1` is authoritative for field-by-field detail.

**Required fields** (present on every card, no exceptions): `policy_id`, `issuer_card`, `press_card`, `protocol_version`, `recipient_pubkey`, `issued_at`, `ancestry_pubkeys`, `issuer_signature`, `holder_signature`, `press_signature`.

**Conditionally-present fields:**
- `past_keys` — present only on cards produced by a master-key rotation (§7 below). Never `null`; omitted entirely when inapplicable.
- `supersedes` / `supersession_note` — present only on un-revocation cards.
- `active_subcards` — a protocol-reserved field (`protocol-objects.md §1.1`), **not present at genesis** on any card. Added only by a post-genesis code-510 `LogEntry` on the card's own log. Its presence is unrelated to card *type* — any card that has ever added a sub-card carries it, genesis documents never do.
- Policy-defined fields — whatever `field_definitions` the governing `PolicyCardDocument` (`protocol-objects.md §2`) requires or permits for cards issued under it.

**Address derivation.** A card's on-chain registry address is always `keccak256(recipient_pubkey)` — a single public, client-side derivation with no private/secret-derived addresses (`ARCHITECTURE.md` ADR-006; `protocol-objects.md §14`). This address is what the registry contract keys `CardEntries` by (`registry_contract.md §3.1`), and it is the value every `ancestry_pubkeys` / `issuer_card` / `app_card` pointer resolves to before a verifier trusts the corresponding pubkey hint.

**Signing sequence.** Three parties sign a card in a fixed order — offerer (`issuer_signature`), holder (`holder_signature`, a countersignature adding `recipient_pubkey`), press (`press_signature`, applied last after policy-compliance validation and after adding `protocol_version`). The full sequence, including which fields each signature covers and excludes, is specified in `protocol-objects.md §1` ("Signing sequence" subsection) and is not repeated here to avoid the two documents drifting on the exact exclusion lists.

**Offer-phase vs. registered card.** The document assembled and signed in steps 1–2 of that sequence (offerer-signed, no `recipient_pubkey`/`holder_signature`/`press_signature`/`protocol_version` yet) is a distinct, transient artifact from the registered `CardDocument` the press eventually posts to IPFS in step 5. Only the registered document is "the card" for the purposes of this spec — the offer-phase document is never posted to IPFS or content-encrypted under this scheme (see §3).

---

## 3. Content Encryption

Registered cards are encrypted at rest on IPFS under **ADR-006 content encryption**:

```
content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")
ciphertext  = AES-256-GCM(content_key, canonical_RFC8785_JSON(signed_card_document), random 96-bit nonce)
```

- The content key is derived from the card's own `recipient_pubkey` — a public value — not from any private key. Confidentiality against outside observers comes from the encryption; a holder of the corresponding private key can always re-derive `content_key` themselves to decrypt their own card, and so can anyone else who already knows `recipient_pubkey` (e.g. a verifier that resolved it via a trusted `ancestry_pubkeys` hint). This is a content-obfuscation scheme, not an access-control scheme keyed to key possession.
- Content encryption applies **only** to the registered document (post step-5 of the signing sequence, §2 above). The offer-phase document has no `recipient_pubkey` yet, so `content_key` is undefined for it and it is never content-encrypted under this scheme — see `protocol-objects.md §1` ("Content encryption and the offer phase").
- Key rotation: when a holder's `recipient_pubkey` changes (a new card supersedes an old one via `past_keys`, §7), each card version has its own `recipient_pubkey` and therefore its own `content_key`. A holder or verifier who needs to decrypt content produced under a prior key derives `content_key` from the relevant `past_keys` entry's `pubkey`, not the current `recipient_pubkey`.

---

## 4. IPFS Content-Addressing and Pinning

**Content addressing.** A card's CID is derived from the encrypted bytes it is composed of, using standard IPFS multihash addressing. `registry_contract.md §3.1` notes the on-chain `log_head_cid` field's 64-byte maximum accommodates SHA2-256, SHA3-256, or BLAKE3 CIDs (34 bytes each) for future flexibility. In practice, only SHA2-256 CIDs are currently produced, since that is what Filebase (the reference press implementation's pinning provider, `press.md §3.4`) assigns by default; SHA3-256 and BLAKE3 are reserved for future use, not currently implemented. This is an assumption based on Filebase's current default behavior, not an invariant the press code itself enforces — `pinToIPFS` (`press.md §5.1`) validates a CID by fetch-and-byte-compare (see below), and never inspects a CID's multihash prefix to confirm which hash algorithm produced it. The contract itself does not validate CID format regardless of algorithm — that is the responsibility of whichever press posted the content (`registry_contract.md §3.1`: "The contract does not validate CID format; format is the press's responsibility").

**Upload and pinning.** Presses are the only parties that post card content to IPFS (`press.md §3.4`). A press:
1. Encrypts the signed card document (§3 above).
2. Uploads the encrypted bytes to Filebase (an S3-compatible object storage service that pins every uploaded object to IPFS) via `pinToIPFS` (`press.md §5.1`): a `PutObject` call followed by a `HeadObject` call that recovers the IPFS CID Filebase assigned to the object, in the `cid` object-metadata field.
3. **Validates the CID before any signed or on-chain use**: re-fetches the content from the Filebase gateway using the CID Filebase returned, and compares the fetched bytes byte-for-byte against the bytes it uploaded. This is a fetch-and-byte-compare round trip, not an independent re-derivation of the CID from the uploaded bytes — the press never recomputes the CID itself from the content's multihash. A mismatch (or a failed re-fetch) is a hard error (`P-10`) and the corresponding on-chain write is never submitted (`press.md §3.4, §5.1`).

**Fetch.** Content fetches — by a press validating a chain, by a verifier walking `ancestry_pubkeys`, by a holder reading their own card — go through whichever IPFS gateway the fetching party's `IpfsProvider` implementation wraps (a press's own Filebase gateway for press-side fetches; a verifier-package-supplied `IpfsProvider` for SDK/client-side fetches). This spec does not mandate a specific gateway or pinning provider for non-press consumers of card content; it only specifies the press's own obligations as the content's publisher.

**Reconciliation.** Presses are responsible for pinning every card CID registered under a policy they serve, including cards they did not themselves originally publish. `press.md §3.5` specifies the scheduled reconciliation job (`press/server/tasks/reconcile-cids.ts`) that reads `CardRegistered`/`CardHeadUpdated` events from the registry contract and calls the Filebase Pinning API (idempotent: success or HTTP 409 both count) for each CID found. This spec treats reconciliation as a press operational responsibility, not a property of the card object itself; see `press.md §3.5` for the full mechanism.

---

## 5. The Card Log (Post-Genesis History)

Every state change to a card after genesis — field updates, revocations, protocol-reserved-field updates (`active_subcards`, `successor`) — is a `LogEntry` (`protocol-objects.md §3`), not a rewrite of the genesis `CardDocument`. **Amended 2026-07-16:** each `LogEntry` reposts the card's complete current field state (`card_state`) and carries a flat `history` array listing every predecessor object's CID, oldest-first — a reader fetches only the current head object to get both full current state and full provenance, with no backward IPFS walk required. `prev_log_root` is retained as the hash-chain integrity link (signed, so it can't be forged after the fact); `history` is a convenience index over the same chain, always ending in that entry's own `prev_log_root` value. This replaces the prior design, under which a verifier reconstructing full history had to walk the IPFS chain backward from the current head via `prev_log_root` pointers one hop at a time (that walk is what the verifier package's `RpcProvider.getLogEntries()` implemented; see `press.md` Open Question OQ-B3 — that implementation now needs to change to read `history` directly instead of walking, a Phase 3 code-alignment item).

`LogEntry` structure — including `history`, `card_state`, the `code`/`entry_type` mapping (1xx–7xx field updates, 8xx–9xx revocations), and the two-signature sequence (`intent_signature` by the updater, `press_signature` by the press) — is fully specified in `protocol-objects.md §3` and `§4` (`UpdateIntentPayload`) and is not repeated here.

**Card content vs. log content.** "The card" as read by a holder, verifier, or auditor at any point in time means: the current head object's `card_state` (for any post-genesis card) or the genesis `CardDocument` itself (for a card with no updates yet). Because every `LogEntry` now carries a complete `card_state`, a reader never needs to fold `field_updates` across multiple log entries to learn current values — a single fetch of the current head suffices. `field_updates`/`revocation` remain present on each entry as the explicit record of what that specific entry changed, for audit purposes and for `update_policy` predicate evaluation, but are no longer the only way to learn current state.

**Provenance verification.** `history` is a claim self-reported by the press that signed the `LogEntry` — it is not new on-chain storage; the registry contract's `CardEntries` mapping (§6 below) is unchanged by this amendment and still stores only the current `log_head_cid`. A verifier or auditor requiring cryptographic assurance that `history` is genuine (rather than trusting the press) reconstructs the ground-truth CID sequence by replaying that card's `CardRegistered` and `CardHeadUpdated` events from the registry contract (both already emit the relevant CID today — `registry_contract.md §7`) and confirms it matches `history` plus the entry's own CID, in order. This is a strict-verification step recommended for auditors and any verifier that must not merely trust the press; it is not a new mandatory check for routine single-card reads, which continue to rely on the existing check that the on-chain `log_head_cid` matches the CID of the object actually fetched. See `protocol-objects.md §3` "Provenance verification" for the authoritative statement of this mechanism.

---

## 6. Relationship to the On-Chain Anchor

Every card has exactly one on-chain counterpart: a `CardEntry` in the registry contract's `CardEntries` mapping, keyed by the card's address (`keccak256(recipient_pubkey)`). `registry_contract.md §3.1` is the authoritative schema for `CardEntry`; `protocol-objects.md §14` gives the same structure as a summary and explicitly defers to `registry_contract.md` for implementation detail. This spec adds no new fields to `CardEntry` — it only clarifies the IPFS-side half of the relationship:

| On-chain (`CardEntry`) | IPFS-side meaning |
|---|---|
| `log_head_cid` | CID of the *most recent* IPFS object in this card's history — either the genesis `CardDocument` (a brand-new card) or the most recent `LogEntry` (a card with at least one post-genesis change). The contract stores this as opaque plaintext CID bytes; it does not distinguish "points at a CardDocument" from "points at a LogEntry" — that distinction is recoverable only by fetching and inspecting the pointed-to IPFS object. |
| `policy_address` | The on-chain address of the `PolicyCardDocument` (itself a card, with its own `CardEntry`) governing this card. Set once at `RegisterCard` time from the genesis document's `policy_id` (after the press resolves that CID to an on-chain policy address); immutable thereafter. |
| `last_press_address` | The on-chain address of the press sub-card (itself a card) whose key signed the most recent write. Independent of and not derived from any IPFS content — it is an attribution trail the contract itself maintains. |
| `exists` | True once `RegisterCard` has created the entry. Distinguishes "never registered" from "registered with an empty-seeming log_head_cid" — the contract has no independent way to fetch or validate IPFS content, so `exists` is purely a bookkeeping flag over on-chain state. |
| `forward_to` | If non-zero, the on-chain address of the card that supersedes this one following a key rotation (`registry_contract.md §3.1`; set once via `RegisterAddressForward`, immutable thereafter). Independent of and not derived from any IPFS content — see §7 below for how this relates to the card's own IPFS-side `successor` field. |

**Two independent stores, one write gate.** IPFS content is mutable in the sense that a card accrues new `LogEntry` objects over time, but each individual IPFS object (the genesis document, each log entry) is itself immutable once posted — content addressing guarantees this. What *is* mutable is the on-chain pointer: `UpdateCardHead` (`registry_contract.md §4.2`) advances `log_head_cid` from one immutable IPFS object's CID to the next. The registry contract is therefore the sole source of truth for "which of a card's many IPFS objects is currently authoritative"; IPFS itself has no such concept — every CID it has ever pinned remains fetchable and valid content, but only the one referenced by the on-chain `log_head_cid` (or reachable by walking `prev_log_root` back from it) is part of the card's authoritative history.

**Optimistic concurrency.** `UpdateCardHead` requires the caller (a press) to supply `prev_log_cid` matching the *current* on-chain `log_head_cid` (`registry_contract.md §4.2`) — this prevents a press from posting a new `LogEntry` on IPFS whose `prev_log_root` no longer matches the chain's actual current head, i.e. it prevents a lost-update race between the press reading the current head and submitting its update.

---

## 7. Card Versioning

Two distinct kinds of "versioning" apply to a card, and they must not be conflated:

**Log versioning (`LogEntry.version`).** Each `LogEntry` carries a `version` integer, monotonically increasing from `1` for the first post-genesis entry (`protocol-objects.md §3`). This numbers a single card's own history — it has nothing to do with holder key rotation and does not reset or change when the holder's key rotates (a rotation is expressed via `successor`/`past_keys`, not via the log versioning scheme).

**Protocol versioning (`CardDocument.protocol_version`).** Each card's genesis document carries a `protocol_version` string set by the press at issuance time, read from the logic contract's `getProtocolVersion()` (`protocol-objects.md §1`). This records which protocol version was in force when the card was issued; verifiers reject cards whose `protocol_version` is not in their own known-versions list. This is a protocol-level compatibility marker, not a per-card revision counter.

**Holder key rotation (`past_keys` / `successor`).** A holder's cryptographic identity can change without changing which "card" they hold, via the master-key-rotation mechanism:
- A card produced by rotating a holder's key carries `past_keys` — an oldest-first array of every prior public key the same holder controlled, each with `valid_from`/`rotated_at` (`protocol-objects.md §1`). The **holder** is the authority on their own key history; although `past_keys` appears in the `issuer_signature` payload (present in the offer the offerer signs), the authoritative attestation that this history is genuinely the holder's own is the `holder_signature` countersignature.
- The prior card (the one being superseded) carries a `successor` field (a protocol-reserved updatable field, `protocol-objects.md §1.1`) pointing to the new card. `successor` may be set at most once and, once effective, is immutable — see `key_rotation.md` for the full state machine (codes 100–103, including the 72-hour pending window for issuer-initiated rotation and its code-103 cancellation).
- On-chain, an analogous mechanism exists at the `CardEntry` level via `forward_to` (`registry_contract.md §3.1`) — set once via `RegisterAddressForward` and immutable thereafter — allowing a client resolving an old address to follow it to the new one. `forward_to` (on-chain, address-to-address) and `successor` (in the card's own IPFS content, card-pointer-to-card-pointer) are two independent, parallel mechanisms recording the same underlying fact (this address/card has been superseded); a spec-consistency review of `key_rotation.md` should confirm they are kept in sync by whatever process sets them, since this document does not itself specify the ordering or atomicity guarantee between the two.
- Each key version is content-encrypted under its own `content_key` (derived from that version's own `recipient_pubkey` — see §3); a holder or verifier decrypting historical content produced under a prior key uses that key's `past_keys` entry, not the current `recipient_pubkey`.

Every one of these three axes (log version, protocol version, key-rotation succession) can vary independently for the same conceptual "card" — they are not layers of a single version number.

---

## 8. Dependencies

| Spec | Relationship |
|---|---|
| `specs/protocol-objects.md` | Authoritative for `CardDocument` (§1), `LogEntry` (§3), `UpdateIntentPayload` (§4), and `CardEntry` (§14) field-level schema. This document summarizes and cross-references rather than duplicating those definitions. |
| `specs/object_specs/registry_contract.md` | Authoritative for the on-chain `CardEntry` schema, write operations (`RegisterCard`, `UpdateCardHead`), and the write-authorization gate. |
| `specs/object_specs/press.md` | Authoritative for the press's IPFS pinning mechanics (Filebase), CID validation, and reconciliation job. |
| `specs/ARCHITECTURE.md` | ADR-006 (content encryption / address derivation), ADR-007 (E2E transport encryption for offer-phase delivery), ADR-012 (on-chain key scheme upgrade path). |
| `specs/serialization-conformance.json` | Shared canonicalization conformance corpus referenced by §1. |
| `specs/process_specs/key_rotation.md` | Authoritative for the holder-key-rotation state machine referenced in §7. |

---

*Related specs: `specs/card_protocol_spec.md` (top-level overview and serialization appendix), `specs/protocol-objects.md`, `specs/object_specs/registry_contract.md`, `specs/object_specs/press.md`.*
