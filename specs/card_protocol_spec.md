# Card Protocol — Feature Specification

**Version:** 0.4 (draft)
**Date:** 2026-07-04
**Status:** In Review
**Changes from v0.3:** Corrected §3's keyring structure description and YubiKey recovery flow to describe wallet-service keyring storage and federation replication, replacing an earlier IPFS-based description (approved via CP-SPEC-2, `plans/wallet-service/spec-discrepancies.md` D-8; second passage found during the Phase 5 consistency pass).

**Amended 2026-11-12 (notaries):** §9 Replication and close: single-operator quorums are a disclosed bootstrap allowance, retired by governance. Source: `plans/notary-spec-wording-e31.md`, approved by David 2026-11-12.
**Amended 2026-11-11 (notaries, ADR-013):**
- New §9 Notaries.
- §1's protocol-defined policy fields gain `approved_notaries` and `notary`.
- The Predicate System gains parameter references, which are valid only inside a `notary` section.
- Protocol-Required Fields notes the optional `expires_at`.
- The P2 TEE items in §1 and §2 point to §9.

**Amended 2026-11-08 (card login):** §8 rewritten — login router replaces CHAPI; server-card-signed requests bound to a login service card and domain; `form_post` and `mcard_message` response modes; `preferred_services`. Steps in `process_specs/card_login.md`.

**Amended 2026-10-23:** issuance records go to the issuer and the policy card's holder as well as to auditors, so both build up a list of the cards issued through them and can message those cards (§2 Issuance Records, `protocol-objects.md §11`).

**Changelog (spec-consistency Phase 2, Fix #11):** rewrote the Audit Log Entries section and related passages to describe the direct E2E-encrypted `PressIssuanceRecord`-to-`policy.auditors` model (`press.md §5.5`, `protocol-objects.md §11`), replacing the retired audit-epoch/AEK/ML-KEM key-wrapping narrative — this file was missed by Phase 1's review and had fallen out of sync. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

---

## Overview

The Card Protocol is a decentralized, privacy-preserving credential system. A **card** is a cryptographically signed credential whose current state is tracked via a mutable pointer in the Card registry contract on Arbitrum One, whose full history lives in an append-only log on IPFS, and whose issuance is governed by a **policy card** — itself a card whose content specifies who may issue, what the credential contains, and how it can be updated or revoked.

This document specifies the behavior of nine core features:

1. [Creating Card Policies](#1-creating-card-policies)
2. [Pressing Cards and Updating Logs](#2-pressing-cards-and-updating-logs)
3. [Setting Up a Keychain and Backup Options](#3-setting-up-a-keychain-and-backup-options)
4. [Receiving a Card as a User](#4-receiving-a-card-as-a-user)
5. [Updating Cards](#5-updating-cards)
6. [Signing a Message with a Card](#6-signing-a-message-with-a-card)
7. [Validating That a Message Has Been Signed by a Card](#7-validating-that-a-message-has-been-signed-by-a-card)
8. [Authenticating with a Card](#8-authenticating-with-a-card)
9. [Notaries](#9-notaries)

---

## Background Concepts

### The Card Address Model

A card's stable address is an entry in the Card registry contract deployed on Arbitrum One. The on-chain entry is a mutable pointer to the current head CID of an append-only log stored on IPFS. The log is immutable and content-addressed; only the pointer moves as new entries are appended.

**Address derivation.** A card's registry address is always `keccak256(recipient_pubkey)` — a one-way derivation from the card's public key. The on-chain entry stores the current IPFS log head CID in plaintext, but the IPFS content at that CID is **encrypted**. (See `ARCHITECTURE.md` ADR-006.)

**Content encryption (registered card only).** Once the press posts the completed, registered card to IPFS — the document that has `recipient_pubkey`, `holder_signature`, and `press_signature` all present — it is encrypted with AES-256-GCM using a content key derived from the card's public key:

```
content_key  = HKDF-SHA3-256(ikm=recipient_pubkey, info="card-content-v1")
ipfs_payload = { "nonce": <96-bit random, base64url>,
                 "ciphertext": AES-256-GCM.Encrypt(content_key, card_document_bytes, nonce) }
```

A fresh nonce is generated for each log entry. The public key is the single credential needed to derive the address (via `keccak256`) and decrypt the content (via HKDF). There is no separate address secret and no per-card decryption key distinct from the public key itself. A party cannot read a card's content by knowing its address alone — they must hold the public key. Sharing a card means sharing its public key.

**Offer-phase exemption.** An offer-phase `CardDocument` (the proposed card before the recipient countersigns, without `recipient_pubkey`, `holder_signature`, or `press_signature`) has no `recipient_pubkey`, so the content key above is undefined for it. Offer-phase documents are **not** content-encrypted under this scheme. They are conveyed to the prospective recipient either in the clear within the delivery payload (e.g. the `mcard://invite` URL for open offers) or protected only by the E2E message encryption used to deliver the `card_offer` message (ML-KEM per ADR-007) — not by the at-rest content-encryption scheme. Content encryption applies only at the moment the press posts the completed, registered card.

Confidentiality of *messages* between cards is a separate concern handled by end-to-end message encryption in the transport layer (ML-KEM; see ADR-007), not by the card address model.

### Protocol-Required Fields

Every issued card contains a fixed set of immutable protocol-required fields set at issuance and never subsequently changed:

| Field | Type | Description |
|---|---|---|
| `policy_id` | `cid` | CID of the policy card at time of issuance |
| `issuer_card` | `card-pointer` | Mutable pointer in registry of the offerer (issuer) who constructed and first-signed the offer |
| `press_card` | `card-pointer` | Mutable pointer in registry of the press sub-card that validated and registered this card |
| `recipient_pubkey` | `base64url` | The recipient's ML-DSA-44 public key (1,312 bytes) |
| `issued_at` | `timestamp` | Timestamp of issuance |
| `ancestry_pubkeys` | `array of base64url` | Ordered array of ML-DSA-44 public keys (1,312 bytes each) for every ancestor card a verifier must resolve to walk this card's chain to a trusted root — covering the issuer chain and the press/policy chain as applicable. Ordered from immediate parent up toward the root. Set at issuance and covered by all three signatures. **Root base case:** a card whose own address is registered in the on-chain `PolicyAuthorizerKeys` table (a trusted root) carries `ancestry_pubkeys: []` — the empty array. `[]` is a legal, signed value distinct from omission; the field is REQUIRED and always present. A card whose immediate parent is a registered trusted root likewise carries `[]`. **Untrusted hint:** the verifier MUST confirm `keccak256(entry_pubkey)` equals the on-chain address being resolved for each entry; a wrong or forged pubkey yields an address mismatch or undecryptable ciphertext and MUST be rejected. Per-link on-chain addresses remain authoritative. |
| `past_keys` | `array of objects` *(optional)* | **Present only on cards produced by a master key rotation.** Omitted entirely on cards that have never been the product of a rotation (field omission, not `null` or `[]`, consistent with RFC 8785 absent-field convention). When present, lists all prior public keys held by the same holder, **oldest-first**, each as `{ "pubkey": "<base64url ML-DSA-44 public key>", "valid_from": "<ISO 8601>", "rotated_at": "<ISO 8601>" }`. **Provenance:** `past_keys` is the holder's own key history. During a master-key rotation, the holder/wallet supplies their prior-key history to the offerer as part of the rotation request; the offerer includes it verbatim in the assembled offer. The **holder is the authority on their own key history**: the authoritative attestation is the `holder_signature` — the holder countersigns, confirming the listed keys are theirs; `issuer_signature` and `press_signature` also cover the bytes. Immutable after issuance. **Covered by all three signatures** — not in any exclusion list. See `protocol-objects.md §1` for the formal field definition and `key_rotation.md §2.3` for rotation semantics. |
| `expires_at` | `timestamp` *(optional)* | Added 2026-11-11. When present, the card lapses at this chain time. Signatures made before it stay valid, as with an 8xx. Set at genesis, covered by all three signatures, never changed. Used by notary-derived cards (§9). Distinct from a policy's `valid_until`. See `protocol-objects.md §1`. |
| `protocol_version` | `string` | The protocol version in force at the time of card issuance (e.g. `"0.1"`). Added by the press: the press calls `getProtocolVersion()` on the logic contract and includes the returned string in the assembled card document. Covered by `press_signature`. Verifiers reject cards whose `protocol_version` is missing or not in their known-versions list. |
| `issuer_signature` | `base64url` | The offerer's ML-DSA-44 signature over the constructed offer (first signature); `ancestry_pubkeys` and `past_keys` (if present) are covered; `protocol_version` and `recipient_pubkey` are excluded (not yet present) |
| `holder_signature` | `base64url` | The recipient's ML-DSA-44 countersignature over the offer including their `recipient_pubkey` (second signature); `ancestry_pubkeys` and `past_keys` (if present) are covered; `protocol_version` is excluded (not yet present) |
| `press_signature` | `base64url` | The press's ML-DSA-44 signature over the completed card including `protocol_version`, applied last after the press validates policy compliance (third signature); `ancestry_pubkeys`, `past_keys` (if present), and `protocol_version` are all covered |

Targeted cards are signed in a fixed three-party sequence: the **offerer** (issuer) constructs the offer and signs it with their own card key (`issuer_signature`); the **recipient** adds their public key and countersigns (`holder_signature`); the offerer validates the countersigned result; the card is then sent to the **press**, which calls `getProtocolVersion()` on the logic contract, adds `protocol_version` to the document, validates policy compliance, signs with its press sub-card key (`press_signature`), and registers it on-chain. The press key is never held by the offerer's wallet service — these are distinct parties and keys.

**Exception — directly-issued policy cards.** A policy card is issued directly by an authorizer with no press in the loop (§1). Such a card carries `issuer_signature` (the authorizer) and `holder_signature` (the administrator) but **no** `press_signature` and no `press_card`; `press_signature`/`press_card` are required only for cards issued through a press.

**Policy compliance is always anchored to `policy_id`.** When verifying that a card conforms to its governing policy — checking `field_definitions`, `recipient_predicate`, `requester_predicate`, or `approved_presses` membership — verifiers MUST use the content at the `policy_id` CID (the immutable content snapshot embedded at issuance), not the policy's current mutable pointer head. Subsequent changes to the live policy card cannot retroactively invalidate cards issued under a prior policy snapshot.

This rule has one explicit carve-out: **update authorization** (§5 update and revocation flow) evaluates `update_policy` predicates and `revocation_permissions` against the **current live policy**, since these govern present-time operations. Whether a given party may submit an update intent today is a question about the policy's current state, not the policy as it existed when the card was issued.

These fields cannot be modified by any update, regardless of the card's update policy.

### A Card's Schema Is a Floor, Not a Closed Allow-List

A card's complete field set is the union of three sources: the protocol-required fields above (always present), the governing policy's `field_definitions` (if any are declared for that policy), and — critically — **any additional issuer- or holder-supplied fields not declared in either**. Nothing in the protocol prevents an offerer or holder from including a field the policy never defined. The schema a policy declares is a floor of what the press validates, not a closed enumeration of what a card may contain.

**Trust rule for undeclared fields.** An undeclared field is covered by the same three signatures as every other field in the document (`issuer_signature`, `holder_signature`, `press_signature`, per the signing sequence in `protocol-objects.md §1`) — it is signed and tamper-evident, exactly like a declared field. What it does **not** get is a synthesized `update_policy`: because no `field_definitions` entry exists for it, no party is granted authorization to change it later. In practice, this means an undeclared field should be treated as **effectively immutable after issuance** — not because the protocol forbids updating it, but because nothing in the policy grants anyone the authority to do so. A future update could, in principle, introduce a policy-defined path for that field with some other party's cooperation (e.g., a policy amendment that retroactively declares `field_definitions` for it and a co-signed update establishing new authorization) — but this is a deliberate, visible act, not a hidden default. This is a known sharp edge of the model, not hidden behavior: an issuer who includes an undeclared field should expect it to be permanent.

**What the press does and does not validate.** The press validates that required fields are present and that declared-field values satisfy the policy's `field_definitions` constraints (regex, min/max, `field_requirements`, etc. — §The Field Type System below). The press does **not** reject a card merely because it carries fields beyond the declared schema, and does not attempt to validate undeclared fields against anything (there is nothing to validate them against). "Policy compliance" and "schema satisfied" mean *required fields present and declared-field values valid* — not *no fields beyond the ones the policy names*. See §2 step 9 below, which uses this precise language.

### The Field Type System

All card fields — whether in policy cards or in issued cards — use a common type system. Each field definition specifies a type, optional validation, and an update policy.

| Type | Validation options |
|---|---|
| `text` | `regex` (optional — pattern the value must match) |
| `base64url` | — (value is a base64url-encoded binary field per RFC 4648 §5, no padding; serialized as a JSON string in canonical serialization) |
| `integer` | `min`, `max` |
| `number` | `min`, `max` |
| `boolean` | — |
| `date` | `min`, `max` |
| `timestamp` | `min`, `max` |
| `cid` | `required_template` (optional), `field_requirements` (optional) |
| `card-pointer` | `required_template` (optional), `field_requirements` (optional) |
| `card-pointer-array` | `min_count`, `max_count`, `required_template` (optional), `field_requirements` (optional) |
| `append-only-array` | `item_type` (any of the above), plus that item type's validation options |
| `policy-creation-constraint` | Structured object — see §1, *The `policy_creation` Field* |
| `service-array` | Array of service entries `{ origin, name, icon?, description? }` — see §1, *The `preferred_services` Field* (added 2026-11-08) |

**Notes on types:**

`text` with a `regex` replaces both the legacy `enum` type (use `^(option1|option2|option3)$`) and explicit length limits (use `^[\s\S]{0,500}$`). The regex applies to the full string value.

`card-pointer` and `card-pointer-array` accept `field_requirements` — a list of `{ field, regex }` pairs that the referenced card's fields must satisfy. For example, "must be an employee card whose `role` field is `admin`":

```json
{
  "name": "approver",
  "type": "card-pointer",
  "required_template": "<employee-policy-id CID>",
  "field_requirements": [
    { "field": "role", "regex": "^admin$" }
  ]
}
```

`cid` with `field_requirements` applies when the CID points to structured JSON content; the requirements are evaluated against the parsed content at that CID.

`append-only-array` items can only be added, never removed or edited. For `append-only-array` items of type `card-pointer`, `required_template` and `field_requirements` apply to each item.

**Field definition object:**

```json
{
  "name": "<field name>",
  "type": "<type>",
  "required": true | false,
  "description": "<human-readable description>",
  "<validation options for this type>": ...,
  "update_policy": <predicate expression>
}
```

### The Predicate System

Predicates are used in three places: `requester_predicate`, `recipient_predicate`, and `update_policy` for each field. All three use the same nested boolean predicate format.

**Combinators** (each takes an array of sub-expressions):

```json
{ "any_of": [ <expr>, <expr>, ... ] }   // OR
{ "all_of": [ <expr>, <expr>, ... ] }   // AND
{ "none_of": [ <expr>, <expr>, ... ] }  // NOT any
```

Combinators may be nested to arbitrary depth.

**Leaf predicates:**

```json
{ "issued_under_template": "<policy_id CID>" }
// The subject's card was issued under this policy

{ "chain_includes": "<mutable pointer>" }
// This specific card appears somewhere in the subject's chain

{ "card_field_matches": { "template": "<policy_id CID>", "field": "<name>", "regex": "<pattern>" } }
// A card in the subject's chain issued under the named template has a field matching the regex

{ "is_holder": true }
// The subject is the holder of the card being updated

{ "is_issuer": true }
// The subject is the issuer (press) of the card being updated

{ "chain_depth_at_most": <integer> }
// The subject's chain has at most N links

{ "code_equals": <integer> }
// The update code of the current log entry equals this value.
// Valid only inside revocation_permissions predicates (8xx–9xx context).
// Allows a policy to grant a specific party permission for one specific code
// without granting permission for the entire range.
// Example: { "all_of": [{ "is_holder": true }, { "code_equals": 910 }] }
// grants holders permission to post code 910 but no other 9xx code.
```

Predicates are finite and non-recursive. Evaluation is deterministic from publicly-available chain data; any verifier can re-evaluate independently.

**Predicate evaluation context.** Most leaf predicates (`issued_under_template`, `chain_includes`, `card_field_matches`, `is_holder`, `is_issuer`, `chain_depth_at_most`) evaluate properties of the **subject's card chain** — the chain of the party whose authorization is being checked. `code_equals` is the sole exception: it evaluates a property of the **current operation** (the update code being submitted), not the subject's chain. It is only meaningful inside `revocation_permissions` predicates where a specific code is being authorized.

**Parameter references (added 2026-11-11, notaries).** Inside a policy's `notary` section only (`protocol-objects.md §2.1`), a leaf predicate's value may be `{ "param": "<name>" }` instead of a literal. Before evaluation, it is replaced by the value of that parameter in the notary job's signed `parameters` (`protocol-objects.md §21`). Example: `{ "issued_under_template": { "param": "source_policy" } }`. A reference to a parameter the job doesn't supply makes the predicate fail. Parameter references are invalid anywhere else and must be rejected there. Evaluation stays deterministic, because the job's parameters are signed and fixed.

### The Update & Revocation Code System

Every log entry carries a required `code` field — a three-digit integer signaling the semantic nature of the update to verifiers and downstream systems. Codes are grouped into ranges by their trust implication. Within each range, lower subcodes indicate more favorable outcomes and higher subcodes indicate less favorable ones.

**Code ranges:**

| Range | Semantics | Entry type | Card status after |
|---|---|---|---|
| 1xx | Positive update — the holder has earned additional standing, often by linking to a new card (e.g. a promotion). | `field_update` | Active |
| 2xx | Positive context — an annotation indicating the holder is deserving of additional trust; no field changes implied. | `field_update` | Active |
| 3xx | Neutral update — a field change with no trust implication (e.g. a `valid_until` refresh). | `field_update` | Active |
| 4xx | Neutral context — pertinent information added for verifiers that carries no positive or negative trust signal. | `field_update` | Active |
| 5xx | Programmatic update — an automated field change triggered by protocol or policy logic, not a human decision. | `field_update` | Active |
| 6xx | Negative context — an annotation suggesting reduced trustworthiness that does not yet warrant revocation. | `field_update` | Active |
| 7xx | Negative update — a field change that reduces the holder's privileges (e.g. removing admin rights). Within the 7xx range, lower subcodes indicate the reduction is honorable (retiring with distinction); higher subcodes indicate it is less so. | `field_update` | Active |
| 8xx | Quiet revocation — the card is revoked; the holder is not considered an active risk to other communities. The holder's standing in other contexts is unaffected by this revocation alone. | `revocation` | Revoked |
| 9xx | Loud revocation — the card is revoked and the holder may pose risks to other communities. Verifiers operating multi-card communities may wish to notify issuers of other cards they have seen this holder use. | `revocation` | Revoked |

Entries with codes 1xx–7xx use `field_updates` to record changes and do not carry an `effective_date`; the update takes effect at the time it is posted. Entries with codes 8xx–9xx are revocations and carry an `effective_date` that may be earlier than the posting date — the issuer is asserting when the relevant condition began.

**Defined codes.** The canonical code registry is `specs/update_codes.md`. Selected codes for reference:

| Code | Meaning |
|---|---|
| 100 | Linked successor — planned key rotation or advancement (holder-initiated) |
| 101 | Linked successor — emergency rotation (holder-initiated; prior key potentially compromised) |
| 102 | Linked successor — issuer-initiated card recovery (72-hour pending window) |
| 103 | Issuer-initiated recovery rotation cancelled by holder |
| 200 | Positive annotation — general commendation or trust endorsement |
| 300 | Neutral field update — general |
| 301 | Valid-until refresh |
| 400 | Neutral annotation — informational note for verifiers |
| 500 | Programmatic field update |
| 600 | Negative annotation — concern noted; revocation not yet warranted |
| 700 | Privilege reduction, honorable — retiring from a role after exemplary service |
| 750 | Privilege reduction, procedural — termed out of a responsibility; no negative implication |
| 760 | Privilege reduction, unfavorable — rights removed following misconduct, short of revocation |
| 800 | Quiet revocation — role ended; departed in good standing |
| 801 | Quiet revocation — voluntary surrender by holder |
| 810 | Quiet revocation — this card's signing key compromised |
| 811 | Quiet revocation — sub-card lost or stolen (this card only) |
| 900 | Loud revocation — credential obtained under false pretenses |
| 901 | Loud revocation — policy violation identified post-issuance |
| 910 | Loud revocation — full wallet compromise suspected |
| 911 | Loud revocation — bad actor or harmful conduct |

See `specs/update_codes.md` for the full registry, authority rules per code, and extended notes. Additional codes within each range may be defined as use cases arise.

**Verification rule for revocations:** When evaluating any card or signature, walk the full chain. For each link, check whether any 8xx or 9xx entry exists with an `effective_date` at or before the timestamp of the thing being evaluated. If so, apply the appropriate semantics: for 8xx, things before the effective date remain trusted; for 9xx, things on or after the effective date are invalid or suspect. If multiple revocation entries exist, the one with the earliest effective date governs. 1xx–7xx entries do not affect the card's revocation status.

**Historical signature semantics by code range:**

| Range | Historical signatures |
|---|---|
| 1xx–7xx | Fully trusted; the card was not revoked at any point. |
| 8xx | Trusted before effective date. The revocation signals a change of state, not a claim that prior actions were invalid. |
| 9xx | Trusted before effective date; suspect or invalid on or after it. Verifiers should apply judgment based on the subcode and context. |

**Propagation of loud revocations.** A 9xx revocation is a signal, not an automatic action, against other cards the holder may hold. Presses and community operators who observe a 9xx entry may choose to notify issuers of other cards they have interacted with from the same holder — but this is a social protocol, not a cryptographic one. No automatic cascading revocation occurs.

**Un-revocation.** The append-only log cannot remove a revocation entry. To restore standing after an erroneous 8xx or 9xx revocation, the authorizer issues a new **successor card** with a `supersedes` field pointing to the old card's mutable pointer, and a `supersession_note` field explaining the context. The successor card has a clean history; the old revocation remains visible in the old card's log for auditability.

### The Press Model

**Key custody is user-sovereign.** The press never holds a card holder's signing key — nor does it hold the offerer's key. A targeted card is signed by three distinct parties in order: the **offerer** signs the constructed offer with their own card key (`issuer_signature`); the **holder** generates their own keypair and countersigns (`holder_signature`); and the **press**, after validating policy compliance, signs the completed countersigned card with its press sub-card key (`press_signature`) and registers it. The press's signature is a statement about policy adherence, not an identity claim on behalf of the offerer or holder.

A **card press** is a service (self-hosted or commercial) that:
1. Holds a **press sub-card** — a sub-card of a specific policy card, authorizing it to issue cards under that policy.
2. Verifies that issuance requests satisfy the policy's predicates and that the offerer's `issuer_signature` and the holder's `holder_signature` are valid.
3. Signs the completed, countersigned card with its press sub-card key (`press_signature`), last in the sequence.
4. Posts completed cards to IPFS and updates the Arbitrum One registry.
5. Logs each issuance in the policy card's audit log, encrypted to each auditor card's public key.

Presses hold two keys serving distinct roles. The **on-chain key** is a secp256r1 (P-256) keypair registered in the `PressAuthorizations` table on Arbitrum One; it authorizes registry writes and is verified on-chain using the RIP-7212 precompile (~3,450 gas). The **IPFS key** is an ML-DSA-44 (FIPS 204) keypair whose public key appears in the press's card document on IPFS; it signs card content, log entries, and SCIPs, and is verified off-chain by presses and verifiers. The keccak256 hash of the press's ML-DSA-44 public key is stored on-chain in `PressAuthorizations` to enable a future Phase 3 upgrade to full on-chain post-quantum verification without re-registering. Presses hold funded Arbitrum One wallets to pay for on-chain writes. Most end users never interact with IPFS or the chain directly.

---

## 1. Creating Card Policies

### Problem Statement

A card authorizer needs to define the rules governing what cards may be issued under their authority — including field schema, who may request and receive them, how they can be updated, who can audit issuances, and which presses may operate the policy. Without a signed, verifiable policy, presses cannot be constrained and the trust model breaks down.

### Goals

- Express a policy as a card, so that all standard card machinery — updating, revocation, audit logs, sub-card authorization — applies to policies without special-case infrastructure.
- Produce a content-addressed policy card whose registry address and log are the stable, living record of that policy.
- Enable verifiers to independently confirm that any issued card was produced under a valid, currently-active policy.
- Allow granular delegation: different parties can update different aspects of the policy (e.g., the administrator manages auditors; the authorizer must co-sign schema changes).

### Non-Goals

- **Not:** A visual policy builder. Policy creation in v1 is a structured JSON authoring workflow.
- **Not:** Policy search or discovery. There is no global registry of policies; distribution is the authorizer's responsibility.
- **Not:** Policy inheritance or composition. A policy stands alone; referencing another policy's predicates is done by including the same predicate expression, not by reference.

### User Stories

**As a policy drafter (e.g., a school administrator),** I want to assemble a policy JSON defining the schema, predicates, and update rules for a class of card, so that any press operating under this policy knows exactly what it may issue and under what conditions.

**As a policy authorizer (e.g., a superintendent),** I want to review the proposed policy, approve it by issuing a policy card to the administrator, and publish it to IPFS, so that any verifier can confirm my authorization without contacting me again.

**As a verifier,** I want to fetch a card's policy card by CID from IPFS, confirm the authorizer's signature chains to a root I trust, and evaluate whether an issuance was properly authorized, so that I can assess the card's validity without trusting any intermediary.

**As an administrator,** I want to add or remove auditors from a running policy by updating the `auditors` field in the policy card, so that audit access can be adjusted without revoking and reissuing the policy.

### Requirements

#### Must-Have (P0)

**The policy card is a card.** Policy cards are issued directly by authorizers — not through a press. The authorizer signs with their own card key; the administrator (or the authorizer themselves) countersigns as the holder. The policy card is published to IPFS; its Arbitrum One registry entry is created at issuance and its append-only log tracks all subsequent updates.

**Protocol-defined fields of a policy card:**

| Field | Type | Required | Default update policy |
|---|---|---|---|
| `field_definitions` | `field-definition-array` | Yes | `{ "is_issuer": true }` |
| `recipient_predicate` | `card-predicate` | No | `{ "is_issuer": true }` |
| `requester_predicate` | `card-predicate` | No | `{ "is_issuer": true }` |
| `auditors` | `card-pointer-array` | No | `{ "is_holder": true }` |
| `approved_presses` | `card-pointer-array` | No | `{ "is_holder": true }` |
| `valid_until` | `timestamp` | No | `{ "is_issuer": true }` |
| `allow_open_offers` | `boolean` | No | `{ "is_issuer": true }` |
| `revocation_permissions` | structured object | No | `{ "is_issuer": true }` |
| `notes` | `append-only-array` of `text` | No | `{ "is_holder": true }` |
| `policy_creation` | `policy-creation-constraint` | No | `{ "is_issuer": true }` |
| `preferred_services` | `service-array` | No | `{ "is_holder": true }` |
| `approved_notaries` | `card-pointer-array` | No | `{ "is_holder": true }` |
| `notary` | notary section (`protocol-objects.md §2.1`) | No | `{ "is_issuer": true }` |

These are the standardized fields all verifiers know to look for. Their update policies above are defaults; the authorizer may override them at issuance. For example, requiring both holder and issuer to co-sign auditor changes: `{ "all_of": [{ "is_holder": true }, { "is_issuer": true }] }`.

**`field_definitions`** is an array of field definition objects describing the fields of cards issued under this policy. Each object:

```json
{
  "name": "<field name>",
  "type": "<type from the field type system>",
  "required": true | false,
  "description": "<human-readable description of this field>",
  "<type-specific validation options>": ...,
  "update_policy": <predicate expression>
}
```

Example — a student card policy with three fields:

```json
"field_definitions": [
  {
    "name": "role",
    "type": "text",
    "regex": "^(student|audit-student)$",
    "required": true,
    "description": "The holder's enrollment role.",
    "update_policy": { "is_issuer": true }
  },
  {
    "name": "enrollment_date",
    "type": "date",
    "required": true,
    "description": "Date of enrollment.",
    "update_policy": { "is_issuer": true }
  },
  {
    "name": "notes",
    "type": "append-only-array",
    "item_type": "text",
    "required": false,
    "description": "Ongoing annotations from authorized parties.",
    "update_policy": {
      "any_of": [
        { "is_issuer": true },
        { "issued_under_template": "<administrator-policy-id>" }
      ]
    }
  }
]
```

**`recipient_predicate`** and **`requester_predicate`** use the predicate system described in Background Concepts. If absent, the policy imposes no constraint on that party (the holder is fully trusted to issue to whomever they choose, and anyone may request). Example — requester must be a school administrator:

```json
"requester_predicate": {
  "all_of": [
    { "issued_under_template": "<school-staff-policy-id>" },
    { "card_field_matches": {
        "template": "<school-staff-policy-id>",
        "field": "role",
        "regex": "^administrator$"
    }}
  ]
}
```

**`auditors`** is a `card-pointer-array`. Each card address listed receives direct notice of every issuance under the policy: immediately after a press assembles and signs a completed `CardDocument`, it sends a `PressIssuanceRecord` to each active auditor as an E2E-encrypted message (ML-KEM per ADR-007) via the normal message routing layer, encrypted to that auditor's own card public key. There is no shared symmetric key, no epoch structure, and no key-wrapping step — each auditor receives their own independently-encrypted copy of each record, and auditors maintain their own local records of the notifications they receive. See **Audit Notification Model** below and `process_specs/log_auditing.md` for the full flow.

If an auditor card is revoked or removed from `auditors`, the press simply stops sending them future `PressIssuanceRecord`s (resolved from the current policy snapshot at each issuance); there is no retroactive change to notifications already delivered.

**`approved_presses`** is a `card-pointer-array` listing the mutable pointers of press sub-cards authorized to issue under this policy. A press whose sub-card pointer does not appear here must not be accepted by the smart contract.

**`allow_open_offers`** is a boolean flag that, when `true`, permits issuers to create open card offers under this policy — pre-signed batch authorizations that any bearer may claim up to a stated limit or expiry window, without individual issuer review at claim time. When absent or `false`, only targeted issuance (press-initiated, addressed to a specific recipient) is permitted. See §2 for the open offer issuance flow.

**`revocation_permissions`** defines who may publish revocation entries (8xx and 9xx codes) to cards issued under this policy. Non-revocation updates (1xx–7xx) are governed by the relevant field's `update_policy`, not by `revocation_permissions`.

```json
"revocation_permissions": {
  "8xx": { "any_of": [{ "is_holder": true }, { "is_issuer": true }] },
  "9xx": { "is_issuer": true }
}
```

If absent, the default is: 8xx by holder or issuer; 9xx by issuer only.

**The `policy_creation` field.** A policy card may include a `policy_creation` field that constrains the policies which holders of cards issued under this policy are permitted to create. This is an opt-in governance mechanism: without it, holders are unconstrained in what policies they create. With it, any new policy created by such a holder must satisfy the stated restrictions.

`policy_creation` contains a list of `field_restrictions`, each describing a constraint on a field that must appear in (or is prohibited from) the `field_definitions` of any policy the holder creates:

```json
"policy_creation": {
  "field_restrictions": [
    {
      "name": "<field name>",
      "required": true | false,
      "prohibited": true | false,
      "type": "<required type — optional>",
      "regex": "<pattern — for text fields, values must match>"
    }
  ]
}
```

- **`required: true`** — a field with this name must appear in the created policy's `field_definitions`.
- **`prohibited: true`** — a field with this name must not appear in the created policy's `field_definitions`. Mutually exclusive with `required`.
- **`type`** — if present, the field must have this type.
- **`regex`** — if present and the field is of type `text`, the field's `regex` in the new policy must be at least as restrictive as this pattern (see note below on enforcement).

Example — an NYT employee policy whose holders may only create policies that include a `department` field restricted to known departments:

```json
"policy_creation": {
  "field_restrictions": [
    {
      "name": "department",
      "required": true,
      "type": "text",
      "regex": "^(editorial|ops|tech|legal|finance)$"
    }
  ]
}
```

**The `preferred_services` field** *(added 2026-11-08 for card login — `process_specs/card_login.md §Service Discovery`)*. A policy may list the online services its card holders can log in to. Wallets show these services on the card and offer one-tap login to them.

```json
"preferred_services": [
  { "origin": "https://forum.example.org", "name": "Member Forum", "icon": "<CID — optional>", "description": "<text — optional>" }
]
```

- `origin`: `https:` scheme and host, default port, no path; unique within the list. `name` is what wallets display (the service's own name is not used). `icon` is an IPFS CID so that showing it never contacts the service.
- **Inheritance with replace.** If a policy omits the field, its cards use the nearest ancestor policy's list, walking the **issuance chain** (the policy card's issuer card → that card's policy → …, `protocol-objects.md §8.1`) — not the holder-lineage walk below. If a policy sets the field — including to `[]`, meaning "no services" — that list replaces whatever it would inherit. No merging.
- Wallets read the **live** policy head for this field, not the `policy_id` snapshot: services are discovery data, not compliance data, so the snapshot rule in §Background Concepts does not apply.
- Updated with code 302 (`update_codes.md`). A listed service appears in a wallet only if its signed `/.well-known/membership-login` (`protocol-objects.md §18`) confirms it accepts the card.

**The policy creation chain walk.** When evaluating whether a holder is permitted to create a given policy, walkers traverse an alternating chain of cards and policies:

1. Start with the **holder's card** (the administrator who is creating the new policy).
2. Resolve that card's **policy card**. Collect any `policy_creation` restrictions.
3. Resolve that policy card's **holder** (the administrator who holds the policy card). Find that holder's own card.
4. Resolve that card's **policy card**. Collect any `policy_creation` restrictions.
5. Continue alternating (holder's card → its policy → that policy's holder → their card → ...) until reaching a card with no further policy, or a trusted root.

Constraints collected at each step accumulate: the proposed policy must satisfy **all** restrictions from all policies encountered in the walk. Restrictions can only narrow permissible field definitions, never expand them — a policy higher in the chain cannot grant permission that a lower policy has already forbidden.

This walk is independent of the standard chain walk used for card issuance. It traverses the **holder lineage** of policies, not the issuance authorization chain. The distinction matters: a constraint at the "NYT internship program" policy level applies to policies created by coordinators — it does not affect cards that coordinators receive from unrelated organizations.

**Important scoping rule:** `policy_creation` constraints do **not** propagate to sub-cards or to cards that holders receive from other chains. They constrain only what the holder can actively create. If an NYT intern holds credentials from other organizations, those organizations' constraints are irrelevant to policies the intern creates; only the restrictions from the intern's NYT-lineage policy chain apply.

**Enforcement note on regex subsumption.** Exactly verifying that one regex is "at least as restrictive" as another is computationally hard in the general case. The press performs a conservative best-effort check (e.g., literal string matching for simple enumerations). Definitive enforcement happens at card issuance time: when cards are issued under the policy, field values are checked against the policy's regex directly — if the policy's regex would allow a value that the ancestor's `policy_creation` constraint forbids, the issuance fails. Press reputation is at stake if it accepts non-compliant policies; independent verifiers can re-check compliance post-hoc.

**Press authorization.** The policy card holder authorizes presses by issuing a **press sub-card** — a sub-card of the policy card — to each press operator. The press operator countersigns, explicitly accepting authorization and responsibility. The press sub-card's mutable pointer is added to `approved_presses`. Revoking a press sub-card removes the press's ability to issue under this policy; previously-issued cards are unaffected (they pre-date the revocation's effective date).

**Policy creation flow:**
1. The drafter assembles the policy JSON.
2. The drafter submits the proposed policy to the authorizer out of band.
3. The authorizer reviews and, if approved, issues the policy card to the administrator (the holder). The policy JSON is the card's IPFS content.
4. The policy card is published to IPFS. Its Arbitrum One registry entry is created.
5. The administrator registers one or more presses by issuing press sub-cards and adding their pointers to `approved_presses`.
6. The policy is live. The press begins accepting issuance requests.

**Acceptance criteria:**
- [ ] A policy card without a `field_definitions` field is rejected by the press at policy load time.
- [ ] A policy card whose `valid_until` has passed is rejected by the press at policy load time.
- [ ] A verifier who fetches the policy card by CID can confirm the authorizer's signature and walk the chain to a trusted root without contacting the authorizer.
- [ ] Updating a policy field with a signature that does not satisfy the field's `update_policy` is rejected by verifiers as invalid.
- [ ] A press whose secp256r1 key is not registered as an active entry in `PressAuthorizations` for the relevant policy is rejected by the Arbitrum One registry contract.

#### Nice-to-Have (P1)

- A CLI tool that validates a policy JSON against the protocol schema before submission.
- A human-readable policy summary auto-generated alongside the JSON for authorizer review.
- A standard policy template library for common use cases (employee credentials, community membership, event attendance).

#### Future Considerations (P2)

- Visual policy builder UI.
- Policy composition: a policy that references another policy's predicates by pointer rather than embedding them.
- Trusted Execution Environment (TEE) hardening for high-stakes policies: an optional path where the press is additionally attested via hardware enclave, providing stronger enforcement of rate limits and revocation freshness timing. *(2026-11-11: attested computation is now specified for notaries, §9 and ADR-013; a TEE-hardened press would reuse its governance runtime list.)*

### Open Questions

- **[Engineering — RESOLVED]** Canonical serialization format: RFC 8785 (JSON Canonicalization Scheme — JCS). Deterministic JSON with lexicographic key sorting, no whitespace, standard JSON escaping. All field values (including binary fields and timestamps) are serialized as plain JSON strings. See Appendix A and ARCHITECTURE.md ADR-010.
- **[Engineering]** How are field definition changes (adding a new field to an existing policy) handled for cards already issued under the old schema? Are those cards now non-conforming, or do they remain valid?

---

## 2. Pressing Cards and Updating Logs

### Problem Statement

Once a policy card is live and a press is authorized, the press must accept issuance requests, verify they satisfy the policy's predicates, produce signed card offers, log each issuance in an auditor-encrypted record, and update the Arbitrum One registry. The smart contract enforces that only authorized presses can write to the registry; the press enforces policy compliance; verifiers can confirm both independently after the fact.

### Goals

- Allow an authorized press to issue cards without requiring hardware attestation or a trusted execution environment.
- Make all policy compliance checks independently verifiable by any observer post-issuance.
- Ensure the issuance log is readable by auditors and opaque to everyone else, including the press operator.
- Prevent spam writes to the registry by requiring a valid press sub-card key for all registry operations.

### Non-Goals

- **Not:** Cryptographic enforcement of rate limits. Rate limits stated in a policy are a social and legal commitment enforced by the press; they are auditable by the policy authorizer (who holds the audit key) but not verifiable by outside parties without the audit key.
- **Not:** Guaranteeing delivery of card offers. Delivery is best-effort via invitation link or HTTPS to the recipient's wallet service.

### User Stories

**As a press operator,** I want to accept an issuance request, verify the requester's and recipient's chains against the policy predicates, sign the offer with my press sub-card key, and log the issuance encrypted to each auditor, so that the issuance is policy-compliant and auditable.

**As an administrator,** I want the press to post the completed card to IPFS and register it on Arbitrum One, so that the card's mutable pointer is stable and independently resolvable by anyone.

**As an auditor,** I want to decrypt my copy of each log entry using my card's private key, so that I can review the full issuance history for this policy without the press operator or any other party being able to read it.

**As any verifier,** I want to confirm post-hoc that an issued card's content conforms to the policy schema, that the press sub-card that signed it is listed in `approved_presses`, and that the recipient's chain satisfied the recipient predicate, so that I can assess validity without trusting the press.

**As an issuer,** I want to create an open card offer and distribute it as a link, so that up to N recipients can claim a card under my policy without requiring me to be online for each individual acceptance.

### Requirements

#### Must-Have (P0)

**Policy registration check.** Before a press begins operating under a new policy, it performs a one-time pre-flight check to confirm the policy itself was authorized to exist. The press:

1. Resolves the **policy card's holder** (the administrator who holds it).
2. Walks the policy creation chain: holder's card → its policy → that policy's holder → their card → ..., collecting all `policy_creation` field restrictions encountered along the way.
3. Confirms that the new policy's `field_definitions` satisfy all accumulated restrictions: required fields are present, prohibited fields are absent, and text field regexes are at least as restrictive as the inherited constraint (best-effort check).
4. If any restriction is violated, the press refuses to register under the policy and reports the violation to the administrator.

This check does not prevent issuance from proceeding if the press is already registered — it is a gate applied when the press first loads a policy. Re-running it when the policy card or any ancestor is updated is recommended.

**Smart contract enforcement.** The Arbitrum One registry contract enforces a single rule: writes to the registry must be authorized by a key registered in the `PressAuthorizations` table for the relevant policy. Specifically:

- Creating a new card registry entry requires a secp256r1 signature from a press key registered in `PressAuthorizations` for the policy. The contract verifies this signature on-chain using the RIP-7212 precompile.
- The contract checks that the press entry in `PressAuthorizations` is active (not revoked) for the given policy address.
- Updating an existing card registry entry (posting a new log head) requires a secp256r1 signature from the registered press key (for press-initiated updates) or from a key explicitly granted write authority via a prior on-chain grant.
- The contract does **not** evaluate predicate expressions, walk chains, fetch IPFS content, or verify ML-DSA-44 signatures. Semantic compliance and ML-DSA-44 content verification are performed off-chain by presses and verifiers.

**Issuance flow.**

1. A request arrives at the press — from the administrator (targeted mode), directly from the requester (open mode), or from the recipient (requested mode), as specified by the policy.
2. The press resolves the requester's card chain and evaluates `requester_predicate`. If absent, this step passes automatically.
3. The press resolves the recipient's card chain and evaluates `recipient_predicate`. If absent, this step passes automatically.
4. For each card in both chains, the press checks for revocation entries. For each revocation found, the press confirms the effective date is after the current time (i.e., the card was valid when evaluated). If any ancestor is revoked with an effective date at or before now, the press refuses to issue.
5. The **offerer's wallet service** assembles the proposed card JSON: protocol-required fields populated (`issuer_card`, `press_card`, `policy_id`, `issued_at`, and `ancestry_pubkeys` — the ordered array of ancestor ML-DSA-44 public keys from immediate parent up toward the root; `recipient_pubkey` left empty; `protocol_version` left absent — it is added by the press in step 9 after reading the current version from the contract), plus `past_keys` if this card is the product of a master key rotation (omitted otherwise), and all `field_definitions` fields populated per the policy. (In targeted mode the offerer constructs the offer; the request at step 1 carries the offerer's parameters.)
6. The **offerer** signs the canonical serialization of the offer with the **offerer's own card key**, producing `issuer_signature` — the **signed offer**. `ancestry_pubkeys` and `past_keys` (if present) are included in the signed payload. `protocol_version` and `recipient_pubkey` are excluded (not yet present). The press key is not used here.
7. The offer is delivered to the recipient: as an invitation link (base64 payload in a URL, e.g., `mcard://invite?o=<base64>`) for first-time recipients, or via HTTPS POST to the recipient's wallet service endpoint for existing holders.
8. The recipient reviews the offer (see §4), generates a keypair, adds their public key, and countersigns → `holder_signature`. `protocol_version` is excluded from the `holder_signature` payload (not yet present). The countersigned card is returned to the offerer, who validates `holder_signature` and forwards it to the press.
9. The **press** calls `getProtocolVersion()` on the logic contract to obtain the current protocol version string, adds `protocol_version` to the card document, validates the countersigned card (both `issuer_signature` and `holder_signature` verify; required fields present and declared-field values valid per the policy's `field_definitions` — see §Background Concepts, *A Card's Schema Is a Floor, Not a Closed Allow-List*: the press does not reject a card for carrying fields beyond the declared schema), signs the complete document — including `protocol_version` — with its press sub-card key → `press_signature`, and posts it to IPFS. Either the press or the recipient's client may perform the IPFS posting after `press_signature` is applied.
10. The press creates a registry entry on Arbitrum One for the new card, with the initial log head CID; the write is authorized on-chain by the press's secp256r1 key in `PressAuthorizations`.
11. The press produces a **Signed Card Inclusion Proof (SCIP)**: a small signed object binding the new card's CID to its log entry index and the log root at time of inclusion. The SCIP is signed with the press's sub-card key.
12. The press assembles a `PressIssuanceRecord` (`card_cid`, `recipient_pubkey`, `issuer_card`, `policy_id`, `scip_cid`, `issued_at`, `offer_type`) and delivers it as an E2E-encrypted message via the normal message routing layer to each issuance-record recipient: every active auditor in `policy.auditors`, the issuing card (`issuer_card`), and the policy card (`policy_id`'s card address, which reaches the policy card's holder), with duplicates removed. The press awaits a per-auditor confirmation (default timeout 30 seconds); an unresponsive auditor does not block issuance, and the administrator is alerted. See **Issuance Records** below.
13. The press sends the SCIP and a confirmation to the recipient via HTTPS to the recipient's wallet service endpoint.

**Open card offer document structure.** An open card offer is a signed JSON document created by an issuer (not a press) and hosted on a wallet service. It serves as a pre-signed batch authorization: any recipient who countersigns and submits to the named press is authorized to receive a card, subject to the stated constraints. The policy card must have `allow_open_offers: true` for the press to accept submissions under an open offer.

```json
{
  "offer_type": "open",
  "policy_id": "<CID of the policy card>",
  "press_card": "<mutable pointer of the approved press to submit to>",
  "issuer_card": "<mutable pointer of the issuer's card>",
  "max_acceptances": <integer | null>,
  "expires_at": "<ISO 8601 timestamp | null>",
  "display_message": "<optional human-readable context for the recipient>",
  "redirect_url": "<URL to redirect recipient to after successful issuance>",
  "proposed_fields": { "<issuer-populated field values for cards issued under this offer>" },
  "issuer_signature": "<ML-DSA-44 signature over the canonical serialization of all above fields>"
}
```

`max_acceptances` and `expires_at` may each be null (unconstrained), but an offer with both null is valid only if the policy constrains issuance in some other way. An open card offer with no constraints whatsoever requires explicit acknowledgment from the issuer at creation time. The `offer_id` used for on-chain counter tracking is `hash(canonical RFC 8785 JSON of the complete open card offer document including `issuer_signature`)`. This binds the offer ID to the issuer's key, making it unforgeable and unique per issuance.

**Open offer issuance flow.**

1. The issuer assembles the open card offer JSON, populates `proposed_fields` with all issuer-defined field values, signs the canonical serialization with their card key, and submits the signed offer to a wallet service.
2. The wallet service stores the offer and generates a claim link (`mcard://claim?o=<base64>` or a wallet-service-hosted URL) for distribution.
3. The issuer distributes the claim link via any channel (private message, QR code, email, etc.). The security of the resulting cards is bounded by the channel's trustworthiness.
4. A recipient follows the claim link. The wallet service presents an offer review screen: issuer identity and chain summary, proposed field values, acceptance constraints (slots remaining if `max_acceptances` is set, expiry if `expires_at` is set), and the redirect destination URL.
5. The recipient's client verifies the issuer's card chain to a trusted root and confirms the named press sub-card appears in the policy's `approved_presses`. If either check fails, the offer is rejected before display.
6. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this card, stores the private key in the keyring, and assembles an **open offer claim payload**: `{ "offer": <verbatim OpenCardOffer document>, "recipient_pubkey": <new public key> }`. The client signs the canonical RFC 8785 JSON of this claim payload with the new private key, producing a `recipient_signature`.
7. The wallet service submits an **OpenOfferClaimSubmission** to the approved press via HTTPS POST: `{ "claim_payload": { "offer": ..., "recipient_pubkey": ... }, "recipient_signature": ... }`. See `protocol-objects.md` §7 for the full schema.
8. The press validates: (a) the issuer's signature over the offer document is valid; (b) the press's own sub-card is listed in `approved_presses`; (c) the policy card has `allow_open_offers: true`; (d) the press independently checks `expires_at` and reads `OpenOfferUseCounts[offer_id]` on-chain to confirm capacity — this is the press's own pre-flight, separate from the contract's atomic enforcement (see below). If validation fails at any step, the press rejects with a specific error code before submitting any transaction.
9. The press signs the per-recipient card with its press sub-card key (producing `press_signature`), calls `ClaimOpenOffer` on-chain (which atomically re-validates constraints and registers the card), then posts the completed card to IPFS. (The offerer's authorization for an open offer is the `issuer_signature` on the `OpenCardOffer` document; the recipient's countersignature is `holder_signature`.)
10. The press confirms completion to the wallet service. The wallet service updates the recipient's keyring to include the new card address and presents a confirmation screen, then redirects the recipient to `redirect_url` (displaying the destination URL to the recipient first).
11. A `PressIssuanceRecord` (with `offer_type: "open"` and the `offer_id`) is delivered as an E2E-encrypted message to each issuance-record recipient, as in the targeted issuance flow: every active auditor in `policy.auditors`, the issuing card (`issuer_card`), and the policy card (`policy_id`'s card address, which reaches the policy card's holder), with duplicates removed.

**Open offer smart contract enforcement.** For cards submitted under an open card offer, the press calls `ClaimOpenOffer` (see `registry_contract.md §4.5`) — a separate on-chain entrypoint that combines acceptance-count enforcement and card registration in a single atomic transaction. `ClaimOpenOffer` is distinct from `RegisterCard`; a press must not call `RegisterCard` for open-offer claims. No pre-registration of the offer on-chain is required; the acceptance counter (`OpenOfferUseCounts[offer_id]`) is lazily initialized on the first accepted claim.

**Press pre-flight verification.** Before submitting `ClaimOpenOffer`, the press verifies the issuer's ML-DSA-44 signature over the `OpenCardOffer` document (confirming `max_acceptances`, `expires_at`, and all offer terms were set by the issuer and have not been tampered with). A press that submits a claim for an offer with an invalid issuer signature violates press policy and is subject to observable detection and deregistration (E-14). The contract does not re-verify the issuer signature on-chain.

The press calls `ClaimOpenOffer` with: `offer_id` (keccak256 of the canonical RFC 8785 JSON of the complete offer document including `issuer_signature`), `max_acceptances` (`null` in the document is encoded as `type(uint64).max` in calldata; any other value is passed as-is), `expires_at` (`null` encoded as `0`), and the standard card registration fields.

The contract executes the following checks atomically with card registration:

1. Confirms `block.timestamp < expires_at` (skipped if `expires_at` is `0`, meaning unconstrained).
2. Looks up `OpenOfferUseCounts[offer_id]` and confirms the current count is less than `max_acceptances` (skipped if `max_acceptances` is `type(uint64).max`, meaning unconstrained).
3. Atomically increments `OpenOfferUseCounts[offer_id]` and registers the card (with press authorization checks per §6.1).

If any check fails, the transaction reverts and the card is not registered. The press surfaces a specific rejection reason to the wallet service (E-12: offer expired, E-13: offer at capacity). A recipient who loses the race to the last acceptance slot receives a clear error rather than a spinner timeout.

**Key separation.** The policy authorizer's card key and any auditor's card key must be separate from each other. A compromised auditor key must not grant policy control.

**Issuance Records.**

Every card issuance under a policy is reported point-to-point with a `PressIssuanceRecord`. Immediately after the press assembles, signs, and publishes a completed `CardDocument` and produces its SCIP, it sends the record to each issuance-record recipient: every active auditor in `policy.auditors`, the issuing card (`issuer_card`), and the policy card (`policy_id`'s card address, which reaches the policy card's holder), with duplicates removed. There are no epochs, no shared symmetric key, and no key-wrapping step.

*Why the issuer and policy holder receive records.* A card's messaging address and the key that decrypts its content both derive from `recipient_pubkey`. The record gives the issuer and the policy card's holder that key, so each builds up a list of the cards issued through them and can message those cards individually or collectively (e.g. with an `announcement`). The issuer receives records only for cards it issued; the policy card's holder and the auditors receive records for every card issued under the policy, including cards issued by delegated issuers. A card's list of issued cards is visible to the same parties who receive these records and to no one else; it is never posted to IPFS or on-chain. Directly-issued policy cards (§1) have no press: the authorizer already holds the countersigned policy card, including its `recipient_pubkey`, and records it locally.

*Display.* Wallets list issued cards from these records and resolve each card's current state from its log. Revoked cards (8xx or 9xx) stay in the list and are shown greyed out.

*Delivery.* For each issuance-record recipient:

1. The press assembles the `PressIssuanceRecord` plaintext: `card_cid`, `recipient_pubkey` (the ML-DSA-44 public key of the issued `CardDocument`, already known to the press at this point), `scip_cid`, `issued_at`, and `offer_type` (`"targeted"` or `"open"`). See `protocol-objects.md §11`.
2. The press sends the record as an E2E-encrypted message (ML-KEM per ADR-007) via the normal message routing layer to the auditor's wallet service endpoint, encrypted directly to that auditor card's public key. Each auditor receives their own independently-encrypted copy — there is no AEK, no ML-KEM key-wrapping package, and no shared ciphertext.
3. The press awaits a confirmation message from the auditor acknowledging receipt and local recording, with a configurable timeout (default 30 seconds). If the auditor does not confirm in time, the press logs a warning, alerts the policy administrator, and continues — an unresponsive auditor never blocks issuance.

*Auditor-side recording and inspection.* The auditor decrypts the message with their own card's private key and locally records the `PressIssuanceRecord` — there is no shared, press-hosted, or IPFS-hosted audit log the auditor depends on. At any later time, the auditor may inspect the referenced issued card: derive `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")` from the record's `recipient_pubkey`, fetch the card at `card_cid`, decrypt it, confirm `keccak256(recipient_pubkey)` matches the card's on-chain registry address, and inspect its field values against the policy's `field_definitions`, `recipient_predicate`, and `requester_predicate`. See `process_specs/log_auditing.md` for the full flow.

*Auditor added or removed.* Adding or removing an auditor from the `auditors` array takes effect on the next issuance: the press resolves the current policy snapshot at each issuance and sends `PressIssuanceRecord`s only to auditors active in that snapshot. There is no epoch to close and no retroactive change to records already delivered — a newly added auditor simply receives records for issuances from that point forward; a removed auditor simply stops receiving new records, with no effect on records already delivered to them.

*Auditor card revocation.* If an auditor card is revoked, the press stops sending it future `PressIssuanceRecord`s (resolved from the current policy snapshot). This has no effect on notifications already delivered.

**Acceptance criteria:**

- [ ] A press whose sub-card pointer does not appear in `approved_presses` cannot write to the Arbitrum One registry.
- [ ] A press whose sub-card is revoked with an effective date at or before now cannot write to the Arbitrum One registry.
- [ ] A completed card contains all three signatures — the offerer's `issuer_signature`, the recipient's `holder_signature`, and the press's `press_signature` — and any verifier can confirm all three independently without contacting the press.
- [ ] For every issuance, the issuing card and the policy card each receive a `PressIssuanceRecord` containing the issued card's `recipient_pubkey`, so that both can address and message the issued card. When the issuer card and the policy card are the same, or either is also an auditor, it receives one record.
- [ ] Every active auditor in `policy.auditors` receives their own independently E2E-encrypted `PressIssuanceRecord`, decryptable only with their card's private key, for every card issued under the policy while they are active.
- [ ] Each `PressIssuanceRecord` is delivered directly to the auditor via the normal message routing layer; neither the press operator nor any party without an auditor's private key can read the message content in transit.
- [ ] An auditor can decrypt every `PressIssuanceRecord` addressed to them: for each record, the auditor derives `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")` from the record's `recipient_pubkey` field, fetches the card at `card_cid`, and decrypts it successfully; the decrypted card's fields and the issuer/recipient chain can then be inspected for predicate compliance.
- [ ] A press does not block or fail card issuance when an auditor fails to confirm receipt of a `PressIssuanceRecord` within the configured timeout; the administrator is alerted instead.
- [ ] A post-hoc verifier can confirm: (a) the card's content conforms to the `field_definitions` in the policy snapshot at `policy_id` CID, (b) the press sub-card that signed it appears in the `approved_presses` array from that same snapshot, and (c) the recipient's chain satisfies `recipient_predicate` from that snapshot if one is specified.
- [ ] A third-party verifier can walk the full issuer and press/policy chain of any card by reading `ancestry_pubkeys` from the decrypted card, deriving each ancestor's address as `keccak256(entry_pubkey)` and content key as `HKDF-SHA3-256(entry_pubkey, info="card-content-v1")`, and confirming the derived address matches the on-chain address being resolved before decrypting; a pubkey that yields an address mismatch or an undecryptable ciphertext is rejected.
- [ ] The SCIP is delivered to recipient and administrator via HTTPS within a reasonable latency window of the card being posted.
- [ ] A press refuses to accept an open card offer submission when the policy card does not have `allow_open_offers: true`.
- [ ] A press refuses to accept an open card offer submission when the issuer's signature over the offer document does not verify.
- [ ] An on-chain transaction submitting a card under an open offer whose `max_acceptances` has been reached is reverted by the registry contract.
- [ ] An on-chain transaction submitting a card under an open offer whose `expires_at` has passed is reverted by the registry contract.
- [ ] Two concurrent submissions racing for the last open offer slot result in exactly one accepted card and one clean rejection, with no double-issuance.
- [ ] The open offer counter is lazily initialized on first use; no pre-registration transaction is required.

#### Nice-to-Have (P1)

- Batched registry writes: multiple log updates anchored in a single Arbitrum One transaction to reduce gas costs during high-volume periods.
- Press health endpoint exposing operational metrics (issuance count, log head freshness, uptime) without exposing card content.
- Reference docker-compose stack for self-hosted press deployment.
- Paymaster integration: the press sponsors gas for recipient-initiated registry writes (e.g., self-revocations) so recipients never need to hold ETH.

#### Future Considerations (P2)

- Trusted Execution Environment (TEE) hardening for high-stakes policies: optional hardware attestation proving the press is running unmodified open-source code. *(2026-11-11: see §9 Notaries and ADR-013.)*
- Multi-tenant press: one press service managing sub-cards for multiple policies simultaneously.
- Cross-press portability: a recipient can migrate their card from one press to another without reissuance.
- Open offer waitlist: when an open offer is full, the wallet service optionally collects waitlist registrations and notifies the issuer, who may create a follow-on offer.

### Open Questions

- **[Engineering]** What is the minimum IPFS replication count for the policy card's log before the Arbitrum One registry pointer update is considered safe?
- **[Engineering]** For recipient-initiated registry writes (e.g., self-revocation), should the press always mediate, or should the protocol support direct writes from the holder using a paymaster?
- **[Engineering]** Is a transparency log of approved press implementations operated by the protocol foundation or a decentralized committee? (Relevant if TEE attestation is added in P2.)

---

## 3. Setting Up a Keychain and Backup Options

### Problem Statement

A card holder's private keys are the root of their identity in the protocol. Loss of these keys means loss of access to all cards and any services authenticated with them. At the same time, keys that are too easy to recover are vulnerable to theft. The system must support a practical recovery path that is independent of any single service while resisting unauthorized recovery.

### Goals

- Provide a default key management model that is secure, recoverable, and does not require users to manage raw seed phrases.
- Ensure master card keys are never used for routine operations — sub-card keys handle day-to-day signing.
- Make recovery fully independent of the primary service.
- Resist unauthorized recovery attempts with a time-windowed cancellation mechanism.

### Non-Goals

- **Not:** Supporting seed-phrase-based key management as a first-class option.
- **Not:** Social recovery via guardian quorum in v1.
- **Not:** Automatic key rotation. Rotation is a deliberate operation triggered by the holder.

### User Stories

**As a new card holder,** I want my client to create a keyring, generate a master keypair for my first card, and store the private key encrypted with my passkey, so that I do not need to manage raw key material.

**As a holder with multiple devices,** I want device-specific sub-card keys stored in secure device storage, so that my master key stays cold while I sign routine operations from any device.

**As a holder,** I want a YubiKey-based backup so that if my primary service is unavailable I can recover my full keyring independently.

**As a holder who suspects their YubiKey has been stolen,** I want a 72-hour cancellation window with multi-channel notifications, so that I can abort an unauthorized recovery before it completes.

### Requirements

#### Must-Have (P0)

**Keyring structure.** The keyring is an append-only encrypted blob stored by the wallet service and replicated across the wallet service federation (see `ARCHITECTURE.md` ADR-009-AMEND). It holds the master private key for each card the holder controls, the private keys for any sub-cards registered to those master cards, and metadata associating each key with its corresponding card mutable pointer. The keyring is encrypted with a key derived from `passkey + service_secret`. The primary service holds `service_secret` but never sees plaintext keys or the decryption key. Because the keyring is append-only, new keys are added without destroying prior entries.

**Sub-card keys.** Sub-card private keys are held in secure device storage (Secure Enclave on Apple devices, TPM on others). All routine signing operations use sub-card keys. The master card key is accessed only for: creating new sub-cards, performing key rotations, and other high-stakes operations. Sub-cards are registered to their master card: the master key signs each sub-card registration, making the link verifiable.

**YubiKey backup registration.** The holder registers with one or more backup services, presenting their YubiKey. The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The backup service never sees the decryption key in plaintext. The backup service returns a card (proof of registration) and records the holder's notification channels and cancellation credentials.

**Recovery flow.**
1. Holder presents their YubiKey to a backup service.
2. Backup service simultaneously sends notifications to all configured channels (email, SMS, HTTPS webhook, secondary contacts).
3. Backup service waits 72 hours for a cancellation signed by any registered cancellation credential.
4. If cancellation is received: the service aborts and notifies the holder to rotate their backup registration and treat the old YubiKey as potentially compromised.
5. If no cancellation after 72 hours: the service releases the `keyring_id` of the encrypted keyring blob plus the wrapped decryption key blob. The holder's device presents the wrapped blob to the YubiKey (PIN required); the YubiKey unwraps it locally; the resulting key fetches the keyring blob by `keyring_id` from any reachable wallet service in the federation and decrypts it.
6. The holder re-registers with a new primary service, creates a new passkey, re-encrypts the keyring, and optionally rotates their YubiKey backup registration.

**Acceptance criteria:**
- [ ] A new holder's master key is never stored in plaintext anywhere other than secure device storage during setup.
- [ ] A passkey + service_secret combination can decrypt the keyring; neither alone is sufficient.
- [ ] YubiKey recovery completes in under 5 minutes after the 72-hour window closes, assuming network availability.
- [ ] A stolen YubiKey cannot complete recovery if a valid cancellation is submitted before the window closes.
- [ ] The backup service cannot read the keyring contents or the decryption key.
- [ ] After recovery, the holder can register sub-cards for new devices and deregister potentially-compromised ones.

#### Nice-to-Have (P1)

- Multiple YubiKey backup registrations (primary + spare).
- Configurable notification window duration for high-value use cases (e.g., 7 days).
- On-chain sub-card deregistration wizard exposed in the client after recovery.

#### Future Considerations (P2)

- Guardian-quorum social recovery (M-of-N trusted parties initiate time-windowed key rotation).

### Open Questions

- **[Design]** What is the recovery UX when the holder has both a lost primary service and a lost YubiKey? Out of scope for v1?
- **[Engineering]** How are sub-card deregistrations for compromised devices handled when the holder has only recovery access and no active device sub-card?

---

## 4. Receiving a Card as a User

### Problem Statement

A card recipient — whether a first-time participant or an existing holder — must be able to review an issuance offer, verify it was produced by an authorized press operating under a valid policy, generate their own keypair, countersign, and establish ownership of the resulting card — all without trusting the press.

### Goals

- Guide first-time recipients through keychain setup and offer acceptance in a single flow.
- Enable existing holders to receive additional cards without repeating onboarding.
- Ensure the mutual-signing pattern: the press commits to content before the recipient; the recipient accepts by countersigning.
- Make the completed card independently verifiable by any party without trust in the press.

### Non-Goals

- **Not:** Automatic offer acceptance. Every offer requires explicit recipient review.
- **Not:** Accepting offers from a press whose sub-card is not in `approved_presses` or whose chain cannot be verified.

### User Stories

**As a first-time recipient,** I want to open an invitation link, set up my keychain, review the offer, and countersign, so that I own the resulting card immediately and can use it without understanding IPFS or Arbitrum.

**As an existing holder receiving an offer via my wallet service,** I want to review who is offering the card and what it contains, generate a fresh keypair, countersign, and have my client post the result, so that I hold a new credential under my existing identity.

**As a first-time recipient following a claim link,** I want to set up my keychain, review the open card offer's constraints and issuer identity, and countersign, so that I receive the card without the issuer needing to be online or approve my specific request.

**As a recipient reviewing an offer,** I want to see who issued it, what chain they trace to, what the card contains, and what countersigning commits me to, so that I can make an informed decision.

### Requirements

#### Must-Have (P0)

**First-time recipient flow (invitation link).**
1. The offerer's wallet service assembles the proposed card JSON with all issuer-populated fields, `issuer_card`, `press_card`, and `recipient_pubkey` left empty.
2. The offerer signs the offer with the **offerer's own card key** → `issuer_signature` (the **signed offer**). The offerer's wallet service does not hold the press key.
3. The offer is encoded as `mcard://invite?o=<base64>` and delivered out of band.
4. The recipient opens the link. If no keychain exists, the client presents the keychain setup flow (§3) before proceeding.
5. The client verifies `issuer_signature` and walks the offerer's (`issuer_card`) chain to a trusted root. If verification fails, the offer is rejected before being shown to the user.
6. The client presents a review screen: offerer identity (chain summary), card content and field values, the policy and schema governing it, and what countersigning commits the recipient to.
7. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this card, stores the private key in the keyring, adds the public key to the card JSON, and signs the canonical serialization with the new private key → `holder_signature`.
8. The countersigned card is returned to the offerer, who validates `holder_signature` and forwards it to the press. The press validates predicates, revocation, and schema, then signs the completed card with its press sub-card key → `press_signature`. The completed card — `issuer_signature`, `recipient_pubkey`, `holder_signature`, `press_signature`, `ancestry_pubkeys`, and `past_keys` (if present) — is posted to IPFS by the press or the recipient's client.
9. The press creates the card's registry entry on Arbitrum One and logs the issuance.
10. The press delivers the SCIP and confirmation to the recipient via HTTPS to the wallet service endpoint.

**Existing recipient flow (HTTPS delivery).** Steps 1–2 as above. The signed offer is sent via HTTPS to the recipient's wallet service endpoint, identified from the recipient's registered wallet address. Steps 4–10 as above, omitting keychain setup.

**Open card offer receipt flow.**

1. The recipient follows a claim link to the wallet service hosting the open card offer.
2. The wallet service presents an offer review screen: issuer identity and chain summary, proposed field values, acceptance constraints (slots remaining if `max_acceptances` is set, expiry if `expires_at` is set), and the redirect destination URL.
3. If no keychain exists, the client presents the keychain setup flow (§3) before proceeding. For first-time recipients, keypair generation and keyring initialization occur in-browser before countersigning.
4. The client verifies the issuer's card chain to a trusted root and confirms the named press sub-card appears in the policy's `approved_presses`. If either check fails, the offer is rejected before display.
5. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this card, stores the private key in the keyring, and countersigns the canonical serialization of the open card offer document (with the recipient's public key included in the signed payload).
6. The wallet service submits the countersigned offer to the approved press via HTTPS. The press validates and issues the card per the open offer issuance flow in §2.
7. The press confirms completion to the wallet service. The wallet service updates the recipient's keyring to include the new card address and presents a confirmation screen.
8. The wallet service redirects the recipient to the `redirect_url` specified in the offer, displaying the destination to the recipient before navigating and warning against known phishing domains.

**Offer review requirements.**
- The client must verify the press sub-card chain before displaying the offer.
- The review screen must show: the press's identity and chain, the full field values from the offer, the policy card's mutable pointer and `valid_until` if set.
- If the policy card or any ancestor is revoked with an effective date at or before the current time, the offer is rejected with a reason shown to the user.

**Acceptance criteria:**
- [ ] A first-time recipient can complete the full flow (keychain setup through SCIP receipt) without prior knowledge of IPFS or Arbitrum.
- [ ] A completed card is verifiable by any third party with access to IPFS and the Arbitrum One registry, without contacting the issuer or recipient.
- [ ] An offer from a press whose sub-card cannot be verified to a trusted root is rejected before being shown to the user.
- [ ] The recipient's private key is stored in the keyring before countersigning, so it is recoverable via the YubiKey backup flow.
- [ ] A first-time recipient can complete the open card offer receipt flow (keychain setup through confirmation) without prior knowledge of IPFS or Arbitrum.
- [ ] The wallet service displays the `redirect_url` to the recipient before navigating away.
- [ ] An open card offer whose issuer chain cannot be verified to a trusted root is rejected before display.
- [ ] A recipient who attempts to claim a full or expired open offer receives a clear rejection with a reason, not a timeout.

#### Nice-to-Have (P1)

- QR code encoding of claim links for desktop-to-mobile handoff.
- Offer expiry: press sets an expiry on the offer; client rejects expired offers.
- "Why am I eligible for this?" — human-readable explanation pulled from the policy's `description` field.
- Named progress states during open offer claim ("Generating your keys", "Sending to press", "Finalizing") rather than a blank spinner.

#### Future Considerations (P2)

- Recipient-initiated issuance: the recipient requests a targeted card from a press without a prior invitation or open offer.
- Open offer provenance metadata: a structured field on issued cards recording the distribution channel type (private link, public QR code, etc.) to help relying parties calibrate trust appropriately.

### Open Questions

- **[Design]** What is the UX when a recipient declines an offer? Should a decline notification be sent to the press?
- **[Engineering]** How long should unsigned offers be retained by the press before expiring?

---

## 5. Updating Cards

### Problem Statement

After issuance, authorized parties need to record changes to a card — from positive endorsements to field edits to revocations. The full range of update types is codified in the 1xx–9xx code system. Authority is field-granular: different parties may update different fields, and revocation rights are separately controlled by `revocation_permissions`. The append-only log preserves full history; nothing is silently removed. Holders are notified of updates by default so they remain aware of their credential's state.

### Goals

- Support the full update code taxonomy (1xx–9xx) with a single unified log entry structure.
- Enforce field-level update authorization using the same predicate system as everywhere else.
- Route all updates through an authorized press, which acts as neutral submission infrastructure: it validates, countersigns, and posts, but does not exercise independent authority over what gets updated.
- Ensure every update is independently re-verifiable by any observer: the updater's identity and signature are part of the log entry.
- Notify the holder of updates by default; allow suppression for automated or adversarial scenarios.
- Preserve full update history in the append-only log; make every update independently verifiable.

### Non-Goals

- **Not:** Allowing unilateral holder updates to fields not authorized by the update policy.
- **Not:** Silent updates. Every update is a visible, signed log entry.
- **Not:** Retroactive removal or redaction of prior log entries. The log is strictly append-only; entries are never removed or redacted. Revocation withdraws standing by appending a revocation entry — it does not delete anything.
- **Not:** Special direct-write paths for any code range. All updates, including self-revocations, go through an approved press. Resilience against press downtime is achieved by listing multiple approved presses in `approved_presses`.

### User Stories

**As an administrator with update authority,** I want to submit a 2xx update intent to add a positive annotation to a student's card, so that verifiers see an official endorsement on the credential.

**As an administrator,** I want to submit an 800 revocation intent to a press for a card whose holder departed the organization, so that future authentications are rejected while historical signatures remain valid.

**As a holder,** I want to submit an 810 self-revocation intent to any approved press for my policy, so that my compromised signing key is invalidated without requiring the issuer's involvement.

**As a verifier,** I want to fetch the current log head, walk back to the original issuance, and confirm each entry's authorization against the policy's field definitions and `revocation_permissions` — including confirming the updater's card satisfies the relevant predicate — so that I can determine the card's current state without trusting the press.

**As a holder,** I want to receive a notification via my wallet service whenever my card is updated by a third party, optionally including a message from the updater, so that I am not surprised by changes to my credential.

### Requirements

#### Must-Have (P0)

**Update entry structure.** Each log entry is a signed JSON object assembled by the press from the updater's signed intent:

```json
{
  "version": <monotonically increasing integer>,
  "code": <integer 100–999>,
  "entry_type": "field_update",
  "prev_log_root": "<CID of prior log root>",
  "field_updates": [
    { "field": "<field name>", "value": <new value> }
  ],
  "revocation": {
    "effective_date": "<ISO 8601 timestamp>",
    "note": "<optional human-readable explanation>"
  },
  "notify_holder": true | false,
  "updater_message": "<optional — included in the holder notification if notify_holder is true>",
  "intent_signature": {
    "public_key": "<ML-DSA-44 public key>",
    "signature": "<ML-DSA-44 sig over canonical serialization of the update intent payload>"
  },
  "press_signature": {
    "public_key": "<ML-DSA-44 public key>",
    "signature": "<ML-DSA-44 sig over canonical serialization of the complete entry>"
  }
}
```

`entry_type` is `"field_update"` for codes 1xx–7xx and `"revocation"` for codes 8xx–9xx. `field_updates` is present for codes 1xx–7xx. `revocation` is present for codes 8xx–9xx. The two are mutually exclusive. `notify_holder` defaults to `true`; the updater may set it to `false` in the intent. The policy may suppress notification for specific code prefixes (see below).

**The update intent payload** is what the updater signs before submitting to the press:

```json
{
  "target_card": "<mutable pointer of the card being updated>",
  "updater_card": "<mutable pointer of the updater's card>",
  "code": <integer 100–999>,
  "field_updates": [...] | null,
  "revocation": { "effective_date": "...", "note": "..." } | null,
  "notify_holder": true | false,
  "updater_message": "<optional>",
  "timestamp": "<ISO 8601>"
}
```

The intent does not include `version` or `prev_log_root` — those are added by the press when it assembles the complete entry.

**Update flow.**

1. The updater assembles the update intent, signs it with their card key, and sends the signed intent via HTTPS to any press listed in `approved_presses` for the card's policy. The client discovers available presses from `approved_presses` on the policy card.
2. The press fetches the card's current log head from IPFS and confirms the on-chain registry pointer matches.
3. The press validates the intent:
   - Intent signature is cryptographically valid.
   - Updater's card is not revoked (effective date check against current time).
   - For codes 1xx–7xx: the updater's card satisfies the `update_policy` predicate for each field in `field_updates`. If multiple fields are updated in one entry, all `update_policy` predicates must be satisfied by the same updater.
   - For codes 8xx–9xx: the updater's card satisfies the `revocation_permissions` predicate for the code range. If `revocation_permissions` is absent from the policy, the default is: 8xx by holder or issuer; 9xx by issuer only.
   - No fields in `field_updates` are protocol-required immutable fields (the complete immutable set is: `policy_id`, `issuer_card`, `press_card`, `recipient_pubkey`, `issued_at`, `ancestry_pubkeys`, `past_keys`, `issuer_signature`, `holder_signature`, `press_signature`).
   - The code range is consistent with the entry content (8xx–9xx entries must include `revocation`; 1xx–7xx entries must include `field_updates`).
   - If any check fails, the press rejects the intent with a specific error code and does not post.
4. The press assembles the complete entry: intent payload verbatim + `version` (current head version + 1) + `prev_log_root` (current head CID). The press signs the canonical RFC 8785 JSON of this complete assembled entry — **excluding the `press_signature` field itself** — with its press sub-card key, then appends the resulting `press_signature` field to the entry. The signature therefore covers everything that precedes it in the completed document.
5. The press posts the new log entry to IPFS and updates the on-chain registry pointer for the card with its press sub-card key.
6. If `notify_holder` is `true` and the policy does not suppress notification for this code prefix: the press sends an HTTPS notification to the holder's wallet service endpoint containing the update code, the `updater_message` if present, and the CID of the new log entry. If the holder's wallet service endpoint is unreachable, the notification is dropped and the holder will discover the update on next poll.
7. The press confirms success to the updater via HTTPS.

**Presses as neutral infrastructure.** Approved presses are community infrastructure: they hold a funded Arbitrum One wallet, maintain a reputation for policy compliance, and receive update submissions. Any press listed in `approved_presses` may process any update for a card governed by that policy. The press does not exercise independent judgment about whether an update is desirable — it validates predicates mechanically and posts if valid. This means issuers should list multiple presses in `approved_presses` to ensure availability; the likelihood that all listed presses are simultaneously unreachable is the practical bound on update resilience.

**Holder notification suppression.** A policy may declare code prefixes for which holder notification is always suppressed, regardless of the `notify_holder` field in the intent:

```json
"suppress_notification_for_codes": [5]
```

This suppresses notification for all 5xx entries (programmatic updates). The updater may also suppress notification per-intent by setting `notify_holder: false`. If either the policy suppression or the per-intent flag suppresses notification, no notification is sent. For adversarial scenarios — such as a 9xx revocation where tipping off the holder would be harmful — the issuer should configure the policy accordingly or set `notify_holder: false` in the intent.

**Field update authorization.** For each field in `field_updates`, the updater's card chain must satisfy that field's `update_policy` in the policy's `field_definitions`. If a field has no `update_policy` specified, the policy's default applies; if no default is specified, only the issuer may update.

**Revocation semantics.**
- The `effective_date` in a revocation entry may be earlier than the posting date. The updater is asserting when the relevant condition began.
- If multiple revocation entries exist on a card, the one with the earliest effective date governs.
- The append-only log cannot remove a revocation entry. Un-revocation requires a successor card (see Background Concepts).

**On-chain anchoring.** After each update, the Arbitrum One registry entry for the card is updated to point to the new log head CID, providing a trusted timestamp and rollback resistance. Only the press sub-card key is required for this write; the contract verifies the press is in `approved_presses` for the policy.

**Acceptance criteria:**
- [ ] An update intent whose updater does not satisfy the relevant field's `update_policy` is rejected by the press.
- [ ] A revocation intent whose updater does not satisfy `revocation_permissions` for the given code range is rejected by the press.
- [ ] An 810 intent signed by the holder (satisfying `is_holder`) is accepted by the press without issuer involvement.
- [ ] A verifier re-checking an update entry can independently confirm the updater's card satisfies the relevant `update_policy` or `revocation_permissions` predicate by evaluating the predicate against the updater's card chain.
- [ ] The monotonic version number and `prev_log_root` chain prevent replay and out-of-order posting of stale entries.
- [ ] A verifier can reconstruct the full current state of a card by reading the append-only log from the first entry to the current head.
- [ ] The press sends an HTTPS notification to the holder's wallet service endpoint after posting any update where `notify_holder` is true and the code prefix is not suppressed by the policy.
- [ ] A concurrent update submission that arrives after a conflicting entry has already been posted is rejected by the press due to a stale `prev_log_root`; the submitter receives a clear error and can resubmit against the new head.

#### Nice-to-Have (P1)

- Multi-party update approval: a field's `update_policy` can require M-of-N co-signers; the press collects partial intent signatures before assembling and posting the complete entry.
- Revocation notification to services the holder has authenticated with (via HTTPS to callback URLs registered during prior auth sessions).
- Per-press submission receipts: the press returns a signed acknowledgment of the intent before posting, so the updater has proof of submission independent of the on-chain write.

#### Future Considerations (P2)

- Cascading revocation: revoking a policy card triggers batch revocation intents on all cards issued under it (per `revocation_cascade` setting in the policy).
- Update dispute: the holder can publish a counter-statement (a 4xx annotation) to a contested annotation or revocation, visible to verifiers alongside the original entry.

### Open Questions

- **[Engineering]** How does the client efficiently detect new log entries since its last check — polling the Arbitrum One registry pointer, or subscribing via HTTPS webhook?
- **[Engineering]** When a policy's `field_definitions` are updated (a new field added), how are previously-issued cards that lack that field treated by verifiers?

---

## 6. Signing a Message with a Card

### Problem Statement

Card holders need to sign arbitrary messages using their card identity. Signatures must commit to specific recipients and content, support parallel co-signers, prevent replay, and keep the master card key cold.

### Goals

- Produce signed message envelopes verifiable by anyone without network access.
- Commit the signature to the specific audience to prevent misquotation.
- Support parallel co-signing for multi-author statements.
- Keep the master card key cold during all routine signing.

### Non-Goals

- **Not:** Encrypting message content as part of the signing flow. Encryption is a separate layer.
- **Not:** Ordered sequential co-signing. All signatures in v1 are parallel and independent.

### User Stories

**As a card holder,** I want to compose a message, sign it with my device sub-card key, and send it to specified recipients, so they can verify it came from me and was addressed to them.

**As a co-author,** I want to independently sign the same message payload, with my signature added to the `signatures` array, so that verifiers can confirm both commitments.

**As a sender editing a prior message,** I want to publish a new signed envelope with an `edit_of` pointer to the prior hash, so the edit is verifiable and the original remains intact.

### Requirements

#### Must-Have (P0)

**Message envelope structure** (canonical format; see `protocol-objects.md §5` and `messaging_protocol.md §1`):

```json
{
  "payload": {
    "type":        "<message type — see messaging_protocol.md §2>",
    "content":     { "<type-specific fields>" },
    "senders":     ["<mutable pointer of sender's master card>"],
    "recipients":  ["<mutable pointer>", "<mutable pointer>"],
    "timestamp":   "<ISO 8601>",
    "in_reply_to": "<hash of prior payload — optional>",
    "edit_of":     "<hash of prior payload — optional, mutually exclusive with retracts and forwards>",
    "retracts":    "<hash of prior payload — optional, mutually exclusive with edit_of and forwards>",
    "forwards":    "<hash of the original payload being forwarded — optional, mutually exclusive with edit_of and retracts; see Forwarding below>"
  },
  "signatures": [
    {
      "public_key": "<ML-DSA-44 public key>",
      "signature": "<sig over canonical serialization of payload>"
    }
  ]
}
```

**Signing process.**
1. The sender assembles the payload: content, recipient mutable pointers, timestamp, and optional reply/edit/retraction fields.
2. The client canonically serializes the payload (canonical RFC 8785 JSON — see Appendix A).
3. The client signs the canonical serialization using the current device's sub-card private key. The master key is not accessed.
4. The signature and the ML-DSA-44 public key are added to the `signatures` array. The signing sub-card's registry address is not included — verifiers derive it as `keccak256(public_key)`.
5. For parallel co-signing, each additional signer independently repeats steps 3–4 and appends their entry.
6. The message ID is the hash of the canonical payload serialization. There is no separate ID field.

**Recipient binding.** The `recipients` array is part of the signed payload; modifying it invalidates all signatures. A message whose recipient list does not include the receiving card MUST NOT be treated as a valid direct message — delivering an original envelope to a party not in its `recipients` is an unauthenticated relay and is rejected. Such a message is only valid when delivered inside a `ForwardPackage` whose `forward_envelope.payload.recipients` includes the receiving card (see Forwarding below).

**Edit and retraction.**
- An **edit** is a new signed envelope with `edit_of` pointing to the prior payload hash. The original is not mutated. Authorization: signers must chain to the same master card(s) as the original.
- A **retraction** is a new signed envelope with `retracts` pointing to the prior payload hash. No new content is proposed; the sender formally withdraws the original statement. Same authorization rules as edits.
- Successive edits form a linked list (`A → A' → A''`). Each is independently verifiable.
- `edit_of`, `retracts`, and `forwards` are mutually exclusive.

**Forwarding.** A message forwarded to a party not in the original `recipients` MUST be transmitted as a **ForwardPackage** (see `protocol-objects.md §5.1`): a pair `{ original_envelope, forward_envelope }`. The `forward_envelope` is a new signed envelope by the forwarder whose `payload.forwards` equals the message ID of `original_envelope.payload` and whose `payload.recipients` lists the new recipients. The original envelope is unmodified and its signatures remain independently verifiable; the forwarder's signature commits only to the act of forwarding and the new recipient set, not to the original content. Verifiers establish *forwarded from* (from `original_envelope.signatures[].public_key`), *forwarded by* (from `forward_envelope.signatures[].public_key`), and *forwarded to* (`forward_envelope.payload.recipients`).

**Acceptance criteria:**
- [ ] Any party with the signed envelope can verify the signature using the inline public key without a network call.
- [ ] Modifying any field in the payload invalidates all signatures.
- [ ] Two independent signers over the same canonical payload produce independently-verifiable signatures in the same envelope.
- [ ] An edit signed by a party who does not chain to the original signer's master card is flagged as unauthorized by verifiers.
- [ ] A payload with more than one of `edit_of`, `retracts`, `forwards` set is rejected at the client before signing.
- [ ] An original envelope delivered to a party not in its `recipients` without a `ForwardPackage` is rejected as an unauthenticated relay.
- [ ] A `ForwardPackage` whose `forward_envelope.payload.forwards` does not match the original payload's message ID is rejected.
- [ ] The message ID (payload hash) is deterministic across clients given the same inputs.

#### Nice-to-Have (P1)

- Signer state snapshot: each signature entry includes the sub-card's master pointer, version CID, and log root at signing time, enabling retroactive chain-state verification.

#### Future Considerations (P2)

- Threshold signing: M of N designated parties must sign before the message is considered valid.

### Open Questions

- **[Design]** Is there a maximum size for the `recipients` array? Should broadcast messages use a different primitive?
- **[Engineering]** For edits to private (encrypted) messages: how are edits delivered to recipients who did not receive the original?

---

## 7. Validating That a Message Has Been Signed by a Card

### Problem Statement

A recipient or service needs to determine: whether each signature is cryptographically valid; whether the signing card was valid at the time of signing; whether it is currently valid; and what revocation and annotation context surrounds it. The verification process must be independently executable and must respect the distinction between historical validity and current validity.

### Goals

- Return a structured result per signature covering all four validity dimensions.
- Parallelize chain walks using the cached chain array in each card's signed metadata.
- Apply revocation effective dates precisely, distinguishing 7xx / 8xx / 9xx semantics.
- Provide a verifiable npm package API for server-side and client-side use.

### Non-Goals

- **Not:** Making trust decisions on behalf of the application. The verification machinery returns facts; the application layer acts on them. (One exception: when verification finds a card that does **not** conform to its policy snapshot, the verifier reports the responsible press to the Press Registry Body — see step 5. This is an accountability obligation, not an application-level trust decision.)
- **Not:** Verifying encrypted messages without the decryption key.

### User Stories

**As a message recipient,** I want my client to automatically verify every received message and surface a trust indicator, so that I can assess the content without manually checking chain validity.

**As a server operator,** I want to call a verification library and receive a structured result, so that I do not implement chain verification myself. (The concrete npm API is deferred to a future npm-package spec.)

**As a verifier checking historical validity,** I want to confirm whether a message signed six months ago by a now-revoked card was valid at the time, so that I can treat historical statements appropriately depending on the revocation code.

### Requirements

#### Must-Have (P0)

**Verification stages** (executed per signature entry in the envelope):

1. **Signature validity.** Verify the signature against the canonical serialization of the payload using the inline public key. No network call required.

2. **Sub-card to master link.** Derive the signing sub-card's registry address as `keccak256(public_key)` from the `SignatureEntry`. Decrypt the leaf sub-card document (content key = `HKDF-SHA3-256(public_key, info="card-content-v1")`). Read `holder_primary_card_pubkey` and `app_card_pubkey` from the decrypted `SubCardDocument` (see `protocol-objects.md §16`); these are untrusted hints — confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address and `keccak256(app_card_pubkey)` equals the `app_card` pointer address before use (a mismatch or an AES-GCM decryption failure on either parent card is a hard rejection). Derive `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")` to decrypt the master card and confirm the sub-card's address (`keccak256(public_key)`) appears among the `keccak256`-derived addresses of the master card's `active_subcards` entries (`protocol-objects.md §1.1`) — hard reject if absent, independent of the on-chain `SubCardEntry.active` flag; verify the master card holder's ML-DSA-44 signature on the sub-card registration using `holder_primary_card_pubkey`. See `process_specs/card_validation.md` Stage 2 for the full procedure.

2a. **Capability check (sub-cards only).** If the signing sub-card has an associated `SubCardDocument` (see `protocol-objects.md §16`), retrieve it and confirm the message's `type` field appears in the sub-card's `capabilities` array. If the message type is absent from the whitelist, reject the signature regardless of cryptographic validity. If no `SubCardDocument` exists (legacy or wallet primary-key signature), skip this step.

2d. **App card chain walk.** Derive the `app_card` content key from `app_card_pubkey` bytes using `HKDF-SHA3-256(app_card_pubkey_bytes, "card-content-v1")`; fetch and decrypt the app card document from IPFS; walk `ancestry_pubkeys` hop by hop until the chain reaches `VerifierConfig.appCertificationRoot`. Hard-reject with `APP_CARD_CHAIN_NOT_TRUSTED` (`scope_clean: false`, abort) if the chain does not reach the configured root within `maxChainDepth` hops.

3. **Chain walk (historical).** The master card was already decrypted in step 2. Read `ancestry_pubkeys` from the decrypted master card (set at master card issuance, ordered from immediate parent up toward root). Using both `ancestry_pubkeys` (for pubkey/content-key derivation) and the cached chain array of version CIDs (for parallel IPFS fetches), walk every ancestor from the master card up to the trusted root. **Walk termination:** the walk terminates successfully when the next on-chain address to resolve is present in the `PolicyAuthorizerKeys` table — i.e., it is a registered trusted root. Equivalently, when a card's `ancestry_pubkeys` is `[]` (the root base case) and the card's own on-chain address is registered in `PolicyAuthorizerKeys`, the walk ends at that card and `chain_reaches_trusted_root` is set to `true`. If `ancestry_pubkeys` is `[]` but the card is **not** registered in `PolicyAuthorizerKeys`, the chain does not reach a trusted root; record `chain_reaches_trusted_root: false`. For each non-empty ancestor entry:
   a. Take the next entry from `ancestry_pubkeys` (the ancestor's ML-DSA-44 public key, a hint).
   b. Derive the expected on-chain address as `keccak256(entry_pubkey)` and confirm it equals the on-chain address being resolved (the mutable pointer from the prior link). **If the address does not match, reject: the array entry is forged or incorrect.**
   c. Derive the ancestor's content key as `HKDF-SHA3-256(entry_pubkey, info="card-content-v1")` and decrypt the ancestor card document. **If decryption fails (authentication tag mismatch), reject.**
   d. Verify the issuer's ML-DSA-44 signature on the ancestor document using `entry_pubkey`.
   e. Confirm scope attenuation and confirm the chain array entry matches the per-link issuer reference (array is a hint; per-link on-chain addresses are authoritative).
   Per-link on-chain addresses always govern; `ancestry_pubkeys` is an untrusted performance hint whose entries are individually validated against those addresses.

4. **Revocation check (current).** Resolve all mutable pointers in the chain on Arbitrum One in parallel. For each link, read the append-only log for entries with codes 8xx or 9xx. Apply semantics by code range:
   - **1xx–7xx entries:** Not revocations; do not affect the card's validity status.
   - **8xx:** Quiet revocation. Things before the effective date remain trusted; new actions are rejected.
   - **9xx:** Loud revocation. Things on or after the effective date are suspect or invalid; things before the effective date are trusted. Verifiers should note the 9xx signal may warrant notifying issuers of other cards from the same holder.
   - If multiple 8xx or 9xx entries exist, the one with the earliest effective date governs.
   - If revocation data is stale beyond an acceptable freshness window, flag as stale (default: treat as rejection).

5. **Policy compliance and match.** Resolve the card's governing policy using the `policy_id` CID embedded in the CardDocument — not the policy's current mutable pointer head. For **every** verified card, confirm its field values conform to `field_definitions` and that the signing press was authorized for the policy. If the card does not conform, record it non-compliant and submit a non-compliance report to the **Press Registry Body** (the body that authorizes/revokes presses, ADR-011): a press must verify content before posting, so non-compliant content on-chain means the responsible press failed its duty and is accountable (up to `RevokePress`). Additionally, for authentication flows, evaluate `requester_predicate` and `recipient_predicate` from the `policy_id` snapshot against the presented chain; if any predicate fails, reject. (A press added to or removed from the live policy after issuance does not affect the validity of cards issued before that change.) See `process_specs/card_validation.md` Stage 5 for the full procedure.

5a. **Policy creation compliance check (for policy-level verification).** When verifying a policy card itself (rather than an ordinary issued card), walk the policy creation chain — alternating between the policy card's holder card and that card's own policy — and collect all `policy_creation` field restrictions. At each step, use the `policy_id` CID from the card under evaluation to fetch the policy snapshot in effect at issuance. Confirm the policy's `field_definitions` satisfy every collected restriction drawn from those snapshots. If any restriction is violated, the policy is flagged as non-compliant; cards issued under it inherit this flag. Verifiers may apply their own tolerance policy for non-compliant policies (e.g., reject entirely, warn, or accept with reduced trust).

6. **Annotation lookup (optional).** Query EAS on Arbitrum One for third-party annotations on cards in the chain. Filter by whether the annotation signer's chain validates to a trusted root. Assemble annotation context.

7. **Recipient-set check.** Confirm the verifying party's card mutable pointer appears in the `recipients` array. If absent, flag as forwarded.

8. **Replay and freshness check.** Confirm the timestamp is within an acceptable window. Confirm the payload hash has not been seen before.

**Structured result per signature:**

```json
{
  "signer_card": "<mutable pointer>",
  "signature_valid": true | false,
  "chain_reaches_trusted_root": true | false,
  "scope_clean": true | false,
  "revocation": {
    "status": "none" | "revoked",
    "code": <integer | null>,
    "effective_date": "<ISO 8601 | null>",
    "data_freshness_seconds": <integer>
  },
  "was_valid_at_signing_time": true | false,
  "is_currently_valid": true | false,
  "addressed_to_verifier": true | false,
  "annotations": [ ... ]
}
```

**npm package API:** The concrete package API (function names and signatures) is deferred to a dedicated npm-package specification and is intentionally not fixed here. This spec defines the verification semantics and structured result that any such package must implement.

**Acceptance criteria:**
- [ ] A 5-link chain verifies in the same order of magnitude as a 1-link chain (parallel fetch via cached chain array and `ancestry_pubkeys`).
- [ ] For each entry in `ancestry_pubkeys`, the verifier confirms `keccak256(entry_pubkey)` equals the on-chain address being resolved before using the key to decrypt or verify; a mismatch causes the chain walk to abort with a rejection.
- [ ] A forged or substituted `ancestry_pubkeys` entry either yields an address mismatch (rejected) or produces an AES-GCM authentication failure on the encrypted ancestor document (rejected); a walker cannot be deceived into accepting a wrong ancestor.
- [ ] A trusted-root policy card carries `ancestry_pubkeys: []` (the empty array, present and signed — not omitted) and verifies as `chain_reaches_trusted_root: true` when its own on-chain address is found in `PolicyAuthorizerKeys`.
- [ ] A card with `ancestry_pubkeys: []` whose own on-chain address is **not** registered in `PolicyAuthorizerKeys` verifies as `chain_reaches_trusted_root: false`.
- [ ] A signature from a currently-revoked card with an 8xx code and an effective date after the signing timestamp returns `was_valid_at_signing_time: true` and `is_currently_valid: false`.
- [ ] A signature from a card with an 8xx revocation and an effective date before the signing timestamp returns `was_valid_at_signing_time: false` and `is_currently_valid: false`.
- [ ] A signature from a card with a 9xx revocation and an effective date before the signing timestamp returns `was_valid_at_signing_time: false` and `is_currently_valid: false`.
- [ ] A 1xx–7xx log entry on a card does not affect `is_currently_valid`; the card is still active.
- [ ] Stale revocation data beyond the freshness window is flagged in the result.
- [ ] A previously-seen payload hash is flagged as a replay.
- [ ] A policy card whose `field_definitions` violate an ancestor's `policy_creation` restrictions is flagged as non-compliant, and cards issued under it inherit the flag.

#### Nice-to-Have (P1)

- Result caching with configurable TTL to reduce redundant Arbitrum RPC and IPFS fetches for frequently-seen signers.
- Batch verification: verify multiple envelopes sharing a common signer in a single call.
- React trust-indicator component that renders a UI from the structured result.

#### Future Considerations (P2)

- Subscription-based revocation notification via HTTPS webhook: services register a callback URL and receive push notification when a card they care about is revoked, enabling mid-session revocation without polling.
- W3C Verifiable Credential compatibility layer.

### Open Questions

- **[Engineering]** Fetch budget and caching strategy for chain and annotation lookups on mobile clients with limited connectivity.
- **[Design]** How should the trust indicator distinguish "chain verified to a root I trust" from "chain verified to an unknown root"?
- **[Engineering]** How are trusted roots configured by the user and synced across devices?
- **[Engineering]** When the cached chain array's version CIDs differ from a link's current state (because the ancestor was updated after issuance), how should the verifier resolve the discrepancy?

---

## 8. Authenticating with a Card

**Revised 2026-11-08 (card login).** This section was rewritten to the decisions in `plans/card-login-strategic-plan.md`. CHAPI wallet discovery, the required `callbacks.https` back-channel, OHTTP response callbacks, and the `{code}` `redirect_uri` were removed; nothing implemented them. The step-by-step flow now lives in `process_specs/card_login.md`; objects are in `protocol-objects.md §8–9, §17–19`.

### Problem Statement

A website wants to let people log in with a membership card — "log in as a verified member of X" — without knowing in advance which wallet the person uses, and in a way that works in every major browser, including all of iOS. The site needs a statement it can verify itself, bound to the right browser session. The person needs to know who is really asking before their card signs anything, because a login prompt is the most phishable surface a wallet has.

### Goals

- Any site with a server can offer "Log in with a membership card," and it works in every major browser.
- The wallet shows — and enforces — who is asking before a card signs anything: the requester is tied to a certified login service and to the domain the response goes to.
- The site receives a statement it can verify end-to-end with the standard verifier, bound to the browser session that started the login, on the same device or across devices.
- Cards lead people to the services that accept them, and logging in from the wallet takes one tap.

### Non-Goals

- **Not:** A central authentication service. The protocol defines objects and checks; each site verifies responses itself.
- **Not:** Login for static sites. Every login site runs a server that holds a server card.
- **Not:** Session management after login. Cookies and session lifetime are the site's responsibility.
- **Not:** Full OpenID4VP conformance. Parameter names and DCQL are borrowed; encoding stays RFC 8785 + ML-DSA-44.

### User Stories

**As a site operator,** I want to add a login button, issue a signed request, and verify the response with a small amount of code, so that I can admit members of a community without managing an allowlist.

**As a user,** I want my wallet to show me which site is asking — verified against the domain the answer will go to — and what I'm signing, so that I am never tricked into logging a phishing site in as me.

**As a user on a laptop,** I want to scan a QR code with my phone's wallet to log in, and have the login go to my browser, not someone else's.

**As a user,** I want my card to show me the services my community uses and log me into them with one tap.

**As a community administrator,** I want to list the services our members can use on our policy, so new members find them immediately.

### Requirements

#### Must-Have (P0)

**Login request** (`protocol-objects.md §8`). The site creates an `AuthenticationRequest` signed by its **server card** and hosts it at a single-use `request_uri`. It names the cards it accepts with a DCQL query in the `mcard` format (a list of policy pointers, each with `include_children`, plus an optional predicate), a `nonce`, a `state` bound to the starting browser, a `response_mode`, and a `response_uri`.

**Requester identity** (`subcards.md §Server Cards`, `protocol-objects.md §17`). A server card is a sub-card of a **login service card**. Login service cards are issued under the login service branch of the app-certification root (`governance/AppCertificationBody/login_service_certification.md`) and bound to a DNS domain by an attestation from that domain's DNS admin card. The wallet rejects any request whose server card isn't login-service-scoped, whose login service card doesn't chain to the login service branch, or whose domain binding doesn't cover the `response_uri` origin.

**Wallet discovery: the login router** (`object_specs/login_router.md`). The site sends the browser to a static login router with the `request_uri` in the URL fragment. The router opens the wallet registered in its own first-party storage. Wallets register silently when the user accepts their first card; registration only adds, never replaces a default. With no wallet registered, the router shows recovery options rather than a dead end. Cross-device logins use a QR code or a `mcard://auth?r=<request_uri>` link instead of the router.

**Response modes** (`protocol-objects.md §9`).
- `form_post` (same device): the wallet's browser POSTs the signed response to `response_uri`; the `state` cookie binds it to the session.
- `mcard_message` (cross-device, native wallets): the wallet sends the signed response as a card message to the login service card; the site answers with an `auth_confirmation` carrying a one-time code. The browser must present both the `state` cookie and the code. On the same device the wallet opens the code link automatically; only QR-started cross-device logins ask the user to type the code. The site records wallet-send → server-receive latency for every `mcard_message` login.

**Warnings and blocks.** A revoked (8xx/9xx) server card, login service card, or login-service-branch ancestor, a suspended domain, or a stale domain binding blocks the login. Negative-context (6xx) and negative-update (7xx) codes on the login service card, and a monitored domain, show a warning the user can proceed past.

**Wallet-initiated login.** The wallet opens the service's start URL with a fresh `wallet_nonce`; the site creates a request echoing it. The wallet signs without a prompt only when the request matches a pending, single-use, short-lived login it started and nothing triggers a warning.

**Service discovery** (`protocol-objects.md §2`, `§18`). A policy may list `preferred_services`. Child policies inherit the nearest ancestor's list unless they set their own (an empty list means none). The wallet shows a service only if the service's signed `/.well-known/membership-login` confirms it accepts the card.

**Verification** (`object_specs/card_verifier.md §6.3`). The site verifies a response with the verifier's `verifyLoginResponse`: signature and sub-card link, chain and revocation, `state`, `nonce`, request hash, audience origin, freshness, and the DCQL match. The session or one-time code is issued only after every check passes.

**Acceptance criteria** (detailed criteria: `process_specs/card_login.md §Acceptance Criteria`, `object_specs/login_router.md §Acceptance Criteria`):

- [ ] A test site completes same-device login through the router in Chromium, Firefox, and WebKit.
- [ ] The wallet rejects, before display, every request that fails the server card, login service card, domain binding, or status checks — including a correctly signed request from a valid login service card whose `response_uri` is on a different domain.
- [ ] A response delivered to a browser other than the one that started the login does not establish a session there.
- [ ] `form_post` and `mcard_message` both complete end-to-end; every `mcard_message` login records its delivery latency.
- [ ] Wallet-initiated login completes with no prompt only when it matches a pending login.
- [ ] A card's effective services list can be computed from its policy chain, and the wallet shows only services whose metadata accepts the card.

#### Nice-to-Have (P1)

- **Wallet chooser.** When several held cards match the query, the wallet shows each card's policy and issuer so the user can choose.
- **Login service card annotations.** EAS annotations on login service cards feed the warn/block rules, as they do for app cards.

#### Future Considerations (P2)

- **Digital Credentials API.** On Android, a browser-native path alongside the router, with proximity-based cross-device binding.
- **URL-bound policy patterns** (e.g. `nytimes.com/staff/*`) in the DCQL query.
- **Per-service identifiers.** In v2 the site sees the presented card's pointer, so one card has the same identifier at every site.
- **Multi-card statements.** One request requiring several cards at once.
- **Requester anonymity.** The browser loads the site before any credential exchange, so the site always learns the browser's IP.

### Open Questions

- **[Engineering]** Whether `mcard_message` delivery latency is low enough to make it the only response mode. Answered by the latency metric above.
- **[Design]** Cleanup of unredeemed one-time codes and abandoned `state` values: `card_login.md` sets expiries; storage strategy is left to the site.

---


## 9. Notaries

**Added 2026-11-11.** Architecture: `ARCHITECTURE.md` ADR-013. Processes: `process_specs/notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md`. Objects: `protocol-objects.md` §2.1, §2.2, §20–§34. Components: `object_specs/notary_runtime.md`, `notary_host.md`. Design record: `plans/notary-design-decisions.md`. This section partly delivers the TEE-hardening items listed as P2 in §1 and §2.

> **Terminology.** "AWS Nitro Enclaves" and "the enclave" mean the trusted execution environment. "nitropack" means the web framework. "Enclave attestation" means the AWS Nitro Enclaves attestation document. See `ARCHITECTURE.md`, terminology note.

### Problem Statement

Communities want verified answers about their members without anyone seeing members' individual data:
- how much members talk to one another;
- the result of a vote;
- a reduced card that proves "Meta employee" without the full employee card.

Today, any service that computes over members' signed data sees all of it. Members have to trust the operator not to read, keep or alter it, and nobody outside can check the answer.

### Goals

- Communities can run trusted analyses over members' signed data, and get results anyone can verify. Aggregation, voting, derived cards and revocation propagation all work end to end.
- Before sharing anything, contributors can confirm exactly what code will run on their data, who gets the result, and that the operator can't read it.
- Activating a notary is lightweight. A community uses a template policy and an existing operator, with no code and no new infrastructure of its own.
- Long-running jobs survive enclave failures, and any data loss is visible and attributable.
- The specs stay the source of truth, and the AWS dependency is isolated so it can be replaced later.

### Non-Goals

- **Not:** a general cloud computing service. Programs are WASM modules with a fixed, minimal interface (`notary_runtime.md §7`). They have no network, clock or randomness.
- **Not:** protection against AWS itself, or against enclave side channels. Both are stated assumptions (`notary_lifecycle.md` §Threat Model).
- **Not:** guaranteed availability. The operator controls I/O and can stall or drop. The design makes that attributable, not impossible.
- **Not:** differential privacy in v1. It is specified and deferred.
- **Not:** refactoring the press. Notaries share object definitions with the press, and the press is unchanged.

### User Stories

**As a community organizer,** I want to learn how connected our members are as a k-anonymous aggregate, so that I can show funders evidence of community strength without seeing any member's answers.

**As a member asked to contribute,** I want my wallet to check, before it sends anything, which program will run on my answer, who gets the result, and that the operator can't read it, so that I don't have to take anyone's word for it.

**As a voter,** I want to change my ballot until the vote closes and have only my latest ballot count, and I want a receipt proving it was accepted, so that I can check my vote was counted.

**As a voter,** I want my ballot to survive a server failure, and if it has to be resent I want my wallet to do it automatically, so that an outage doesn't silently disenfranchise me.

**As an employee,** I want a card that says only "Meta employee", and can't be traced back to my full employee card, so that I can prove membership without revealing who I am.

**As a verifier of derived cards,** I want an employee's reduced card to stop being valid soon after their employee card is revoked, so that leaving the company ends the claim.

**As a notary operator,** I want to stand up a notary from documentation and Docker Compose and serve many communities from one deployment, so that running one is a modest operational commitment.

**As anyone,** I want to verify a published result from public data alone, so that I don't have to trust the organizer or the operator.

### Requirements

#### Must-Have (P0)

**Notary policies** (`protocol-objects.md §2.1`).
- A notary policy is a `PolicyCardDocument` with a `notary` section naming:
  - the program (`program_cid`) and `mode`;
  - the input schema and the replacement rule;
  - `contributor_predicate` and `job_requester_predicate`;
  - parameter bounds;
  - the output schema with its privacy transforms;
  - `output_action` and `output_recipients`;
  - `retention: "none"`, `platform`, `isolation` and `privacy.k_min`.
- **The program computes; the policy routes.** A program never chooses who receives its output.
- New protocol-defined policy fields: `approved_notaries` and `notary` (§1, protocol-defined fields of a policy card).
- Predicates inside a `notary` section may use **parameter references** (§Background Concepts, The Predicate System).

**Notary cards and operators** (`protocol-objects.md §20`).
- An operator serves a policy through a notary card. The notary card is issued by the policy holder under the single governance-registered `NotaryCardPolicy`, and listed in `approved_notaries`.
- The notary card's key is generated inside an enclave, never leaves enclaves, and countersigns the card there.
- The operator's own card is named on the notary card, for accountability.

**Measured runtime** (`notary_runtime.md`):
- one audited Rust runtime image, whose PCR0 is on the governance accepted-runtime list, serves many jobs;
- a broker process holds all keys;
- each job runs in its own worker process under the wasmi interpreter, with fuel, memory and time limits;
- program admission checks run before any job key exists;
- the runtime, not the program, applies the privacy transforms;
- only allowlisted programs may share an enclave (`isolation: "shared"`).

**Wallet enforcement before encryption** (`notary_lifecycle.md` Appendix A.2, `wallet_sdk.md §7b`). The wallet verifies the AWS root chain, debug off, PCR0 accepted, program hash, job hash, epoch, isolation, job key hash, an approved notary, parameter bounds, and attestation freshness **before** encrypting any input. The consent screen comes only from the policy and the job.

**Transport** (`protocol-objects.md §24`, `oblivious_transport.md`):
- the outer envelope is the existing oblivious transport to the notary host, which hides IP addresses;
- the inner envelope is X-Wing (ML-KEM-768 + X25519, draft-06) HPKE to the enclave's per-job key, which hides content from the host;
- inputs are signed by the contributor's sub-card over `{ job_hash, payload, revision, … }`.

**Receipts and inclusion.**
- The host signs a receipt for each ciphertext.
- The enclave returns a validation receipt only after a majority of replicas hold the input, sealed so the host can't read it.
- Contributors can check that their input is included in the notarization's input commitment.

**Processing.**
- The enclave checks signatures, chains, revocation and eligibility, using the contributor's evidence bundle and whole-policy snapshots, never per-card lookups.
- It dedupes by the contributor's root key.
- It applies the latest valid `revision` under `latest_wins`.
- It suppresses output below `k_min`.

**Public record** (`protocol-objects.md §27–§28`).
- A notarization (quorum-cosigned, on IPFS) records only that the notary acted: job, policy, input commitment, counts, attestation and chain state.
- An EAS-anchored job log records every epoch, handoff and close.
- Outputs are public only if the policy says so; otherwise they are sent as encrypted card messages.

**Replication and close** (`notary_replication_and_recovery.md`):
- a job names a replica set (default three instances across availability zones) and `min_live`;
- key handoff uses mutual attestation and is logged before the new replica acts;
- a result needs a cosigning majority quorum;
- a job whose quorum one operator can reach alone (a single-operator quorum) is allowed as a **bootstrap allowance**, for early deployment while few operators are active, and is disclosed: on the consent screen, and as the verifier warning `SINGLE_OPERATOR_QUORUM`. Such an operator could count contributors it invents (`notary_lifecycle.md` L4). As operators join, jobs are expected to use replicas from several operators, and governance retires the allowance (`single_operator_quorums`, `protocol-objects.md §34`);
- close needs both chain time and enclave hardware time to pass `closes_at`;
- a total loss starts a new, publicly logged epoch, and wallets resubmit their latest signed input automatically;
- runtime upgrades move work while it runs:
  - by rolling handoff between runtimes with the same `close_compat`;
  - by a logged `runtime_migration` epoch between runtimes whose validation or computation differs.
- after an emergency (`"vulnerable"`) retirement, every key that lived in that runtime is treated as exposed (algorithm E). Notary cards are rejected for anything dated after the retirement, jobs re-key, and `dup_tag` chains are re-seeded.

**Derived cards** (`derived_card_revocation_propagation.md`, `protocol-objects.md §2.2`):
- issued only under governance template policies;
- they state only the source policy and verbatim projected values;
- they carry `expires_at` and a keyed `dup_tag`;
- they are issued in batches only once at least `min_anonymity_set` holders share their values;
- the holder countersigns;
- they send no `PressIssuanceRecord`s.

**Revocation propagation.**
- `expiry_only` and `sealed_link` modes are built.
- Under `sealed_link`, the enclave watches whole-policy updates, follows key-rotation successors, and maps 8xx to 820 and 9xx to 920. It releases revocations after `min_delay`, in batches of at least `min_revocation_batch`.
- Timing defenses are named parameters with defaults.

**Governance** (`governance/PressRegistryBody/notary_certification.md`):
- PressRegistryBody maintains the accepted-runtime list and the program allowlist as cards, plus `NotaryCardPolicy` and the derived-card template policies. Every list version carries member signatures that runtimes, wallets and verifiers check: the quorum for any change, and 2 of 5 for a removal-only emergency retirement (`protocol-objects.md §34`, algorithm L);
- it authorizes each (template, operator) pair with `AuthorizePress`.

**Contract prerequisite.** The registry write gate binds every signed field to the calldata (`registry_contract.md §6.1` step 8) before derived cards ship.

**Acceptance criteria.** These map one to one onto the strategic plan's Key Objectives (`plans/notary-strategic-plan.md`).

*G1, trusted analyses:*
- [ ] An aggregation job with at least `k_min` contributors produces a notarization that `verifyNotarization` accepts using only CIDs and chain data. With fewer than `k_min`, it outputs `{ "insufficient_participation": true }`.
- [ ] A vote across a voting period produces a tally matching the cast ballots, finalized only after `closes_at` by chain time and enclave time.
- [ ] A derived card is issued containing only the projected fields, passes standard card verification, and can't be linked to the source card from the host's records.
- [ ] With `sealed_link`, revoking a source card revokes its derived card within `min_delay + batch_window` of eligibility, and the host's records alone can't match the two. With `expiry_only`, the derived card lapses at `expires_at`.
- [ ] *(Deferred until AWS is provisioned)* All four use cases run on real AWS Nitro Enclaves at least once, not only in the simulator.

*G2, contributor assurance:*
- [ ] The wallet SDK rejects each of: wrong PCR0, debug-mode attestation, program hash ≠ `program_cid`, stale or mismatched nonce, notary not in `approved_notaries`, and parameters outside `parameter_bounds`. Each is covered by a test.
- [ ] Contributors can verify inclusion of their input in `input_commitment` using their receipt.
- [ ] The consent screen is derived entirely from the policy and job. A test confirms requester-supplied text appears only as labelled requester text.
- [ ] The runtime rejects each class of non-compliant program (disallowed import, threads or shared memory, non-deterministic features including floating point, oversize limits, schema mismatch), and refuses to run a non-allowlisted program `shared`. Each is covered by a test.
- [ ] A deliberately leaky test program can't exceed the policy's privacy bounds, because k-suppression, clamping and rounding are applied by the runtime.

*G3, lightweight activation:*
- [ ] Three template policies are published: aggregation, vote, and derived card. A community activates each with no code. For aggregation and voting it issues a policy card from the template and signs a job. For derived cards it signs a job under the governance template.
- [ ] A new operator can stand up a notary from the `notary/` documentation and Docker Compose in under an hour.

*G4, failure tolerance:*
- [ ] Killing any single replica mid-vote loses no ballots, and tests cover re-replication back to `min_live`.
- [ ] Killing all replicas starts a new epoch, wallets resubmit stored ballots, and the final tally is correct for online voters, counting each card's latest valid ballot.
- [ ] Every key handoff appears in the job log, and voters hold enclave-signed receipts proving valid submission.

*G5, spec-first:*
- [ ] `specs/` contains the notary process and object specs, ADR-013 in `ARCHITECTURE.md`, and a README section, all reviewed before code starts.
- [ ] Integration tests derived from this section pass against the local simulator and against AWS Nitro Enclaves.
- [ ] No module outside the attestation verifier modules and runtime image packaging references AWS-specific attestation formats.

#### Nice-to-Have (P1)

- **Notarization verification in Python** (`verifier-py`), alongside the TypeScript verifier.
- **An EAS audit anchor for state-blob versions**, giving public timing evidence that sealed-link state changed.
- **Operator capacity reporting.** Per-operator job counts and replica health, published without job data.
- **Policy-builder integration** of `notary-lint`.

#### Future Considerations (P2)

- **Differential privacy:** per-job, then budgeted across jobs. Specified in `protocol-objects.md §2.1` and refused by v1 runtimes.
- **`escrowed_link`:** threshold-escrowed source links, opened only on challenge. Specified in `derived_card_revocation_propagation.md`.
- **Other TEEs** (AMD SEV-SNP, Intel TDX), through new attestation verifier modules and `platform` values.
- **Cryptographic templates:** Prio/DAP for aggregation, and client-side zero-knowledge proofs for derived cards (including a holder-computed `dup_tag`).
- **Verified chain reads:** Arbitrum state proofs, or TLS to several RPC providers with a quorum, closing limits L3–L5.
- **A threshold or oblivious PRF for `dup_tag`**, so that no single enclave holds the template key.
- **Delegated policy registration**, if communities need their own derived-card policies rather than governance templates.
- **A TEE-hardened press** reusing the governance list cards (ADR-013, OQ-12).
- **Web-evidence derived cards** (`source_kind: "web_evidence"`, reserved in `protocol-objects.md §2.1` and §2.2): cards derived from a verified HTTPS response, such as "this GitHub account is older than a year". The preferred approach takes a zkTLS attestor claim (for example from Reclaim Protocol) as the input. The enclave checks the attestor signatures, the claim, and that the claim is bound to the contributor's card key and the job. Checking signatures is deterministic, so the quorum close is unchanged. Accepted attestor sets would be a third governance list card. Making the enclave itself the TLS client is the alternative. It removes the external attestor but adds network egress, a pinned CA store and session credentials to the runtime, and replicas can't recompute a fetch. It is out of scope unless attestor trust is unacceptable.

### Open Questions

- **[Engineering — blocking launch]** Can the parent EC2 instance influence the enclave's attestation timestamp? Close relies on it not being able to (assumption T9). Confirm on real hardware; if it can, stop at CP9.
- **[Engineering]** Will the X-Wing draft change before it is final? The KEM and draft version are bound into every job, so a later draft can be added as a new `kem` value. Existing jobs keep theirs.
- **[Engineering]** At what policy size do whole-policy snapshots become too costly? This is measured in the capacity benchmark. Large source policies may need sharded snapshots, which would leak which shard.
- **[Design]** Is the governance template-policy model enough for communities that want their own derived-card schema or auditors? Revisit after v1 adoption.
- **[Security — for David, before web-evidence work]** Which zkTLS attestor sets would be accepted for web-evidence derived cards, and who governs that list? In the proxy model an attestor colluding with a user can fake a server, and an attestor learns which site was visited and when unless the traffic is routed obliviously. A proxy-model attestor can't usefully run inside the enclave, because the host controls the enclave's network.

---

### Leading Indicators (weeks 1–4 post-launch)

- **Policy creation completion rate:** % of started policy drafts that result in a live policy card
- **Issuance success rate:** % of card offers that result in a completed, posted card
- **Keychain setup completion rate:** % of invitation link opens that result in a completed keychain and countersigned card
- **Verification latency:** median and p95 wall-clock time for full 5-link chain verification
- **Press registration success rate:** % of press sub-card authorizations that complete without error

### Lagging Indicators (months 1–3 post-launch)

- **Recovery success rate:** % of recovery attempts that complete without incident
- **Revocation propagation time:** time between revocation entry publication and verification clients picking up the change
- **Developer SDK adoption:** number of services integrating the `app-sdk` login module (`object_specs/app_sdk.md §Login`)
- **Card reuse rate across sessions:** % of authenticated sessions that reuse a previously-established card vs. new issuance

---

## Timeline Considerations

- **Canonical serialization format** is resolved: RFC 8785 (JSON Canonicalization Scheme — JCS). Deterministic JSON with lexicographic key sorting, no whitespace, standard JSON string escaping. See Appendix A. This must be implemented in the npm package and validated against the conformance test corpus before the API is locked.
- **Arbitrum One registry contract** uses secp256r1 (P-256) via the RIP-7212 precompile (~3,450 gas per verify) for all on-chain write authorization in Phase 1. This is the split signing model (ADR-012): presses hold a secp256r1 key for on-chain authorization and an ML-DSA-44 key for IPFS content signing. The keccak256 hash of each press's ML-DSA-44 public key is stored on-chain in `PressAuthorizations`, enabling a Phase 3 upgrade to full on-chain post-quantum verification without re-registration. Full ML-DSA-44 on-chain verification via Stylus is deferred to Phase 3.
- **Trusted root configuration UX** is a dependency for client-side verification and keychain setup — design work should begin in parallel with protocol engineering.
- TEE hardening is explicitly P2 and does not gate v1 work.
- The Arbitrum One substrate is resolved. Gas cost estimates should be finalized against current Arbitrum One blob-era pricing; secp256r1 calldata (64 bytes per signature via RIP-7212) keeps per-write costs low, expected to remain well under $0.10 per write.

---

## Appendix A — Canonical Serialization (Normative)

All payloads that are signed or hashed in this protocol MUST use canonical RFC 8785 JSON as defined in this appendix. This applies to: card offers, completed cards, log entries (field updates and revocations), message envelope payloads, and authentication request/response objects.

### A.1 Base Standard

**RFC 8785** (JSON Canonicalization Scheme — JCS) defines the canonical serialization form. Implementations MUST produce output that is byte-for-byte identical to the RFC 8785 canonical form.

The canonical form rules are:

- **Key ordering**: Object keys MUST be sorted by Unicode code-point order (the ordering produced by JavaScript's standard `Array.prototype.sort()` on strings). This sort applies at every nesting level.
- **No whitespace**: No spaces or newlines between tokens.
- **Numbers**: Serialized per ECMAScript's `Number.prototype.toString()` (IEEE 754 double-precision; integers as plain integers, e.g., `1` not `1.0`).
- **Strings**: Serialized per JSON string escaping rules (RFC 8259 §7). Control characters (U+0000–U+001F) and `"` and `\` are escaped; other characters including non-ASCII are emitted as-is.
- **Booleans and null**: `true`, `false`, `null` as standard JSON literals.

The output MUST be encoded as UTF-8.

### A.2 Field Serialization

All field values — including binary fields (base64url strings) and timestamp fields (ISO 8601 strings) — are serialized as ordinary JSON strings. There is no schema-aware type coercion.

| Protocol field type | JSON form | Canonical JSON serialization |
|---|---|---|
| `text` | String | JSON string as-is |
| `base64url` | base64url string (RFC 4648 §5, no padding) | JSON string as-is |
| `integer` | Number | JSON number (e.g., `1`, `-1`, `256`) |
| `number` | Number | JSON number |
| `boolean` | `true` / `false` | `true` / `false` |
| `date` | `"YYYY-MM-DD"` string | JSON string as-is |
| `timestamp` | ISO 8601 string (e.g., `"2026-05-19T00:00:00Z"`) | JSON string as-is |
| `cid` | base64url string | JSON string as-is |
| `card-pointer` | base64url string | JSON string as-is |
| `card-pointer-array` | Array of base64url strings | JSON array of JSON strings |
| `append-only-array` | Array | JSON array, items per their own type |
| Absent optional field | omitted | Omitted from object entirely |

### A.3 Optional Field Omission

Optional fields that are absent MUST be omitted from the serialized object entirely. Protocol implementations MUST NOT include a field with a `null` or `undefined` value — the field must be absent from the object before it is passed to the canonicalizer. This is a **document authoring rule**, not a serialization rule: the RFC 8785 canonicalizer does not strip `null` values and will include them as the literal `null` if they are present. Implementations that set absent optional fields to `null` rather than omitting them will produce different bytes and will break signature verification across implementations.

### A.4 Conformance Test Corpus

The file `specs/serialization-conformance.json` contains 22 reference test cases. Each case specifies a JSON input object and the expected RFC 8785 canonical JSON output string. Implementations MUST produce byte-identical output for all cases before being considered conformant.

The corpus covers: string encoding, integer encoding, negative integers, boolean encoding, ISO 8601 timestamp strings (as plain strings), date strings, base64url strings (as plain strings), map key ordering (same-length and different-length keys at all nesting levels), optional field omission, Unicode text fields, and array fields.
