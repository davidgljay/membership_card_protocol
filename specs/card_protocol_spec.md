# Card Protocol — Feature Specification

**Version:** 0.3 (draft)
**Date:** 2026-05-19
**Status:** In Review

---

## Overview

The Card Protocol is a decentralized, privacy-preserving credential system. A **card** is a cryptographically signed credential whose current state is tracked via a mutable pointer in the Card registry contract on Arbitrum One, whose full history lives in an append-only log on IPFS, and whose issuance is governed by a **policy card** — itself a card whose content specifies who may issue, what the credential contains, and how it can be updated or revoked.

This document specifies the behavior of eight core features:

1. [Creating Card Policies](#1-creating-card-policies)
2. [Pressing Cards and Updating Logs](#2-pressing-cards-and-updating-logs)
3. [Setting Up a Keychain and Backup Options](#3-setting-up-a-keychain-and-backup-options)
4. [Receiving a Card as a User](#4-receiving-a-card-as-a-user)
5. [Updating Cards](#5-updating-cards)
6. [Signing a Message with a Card](#6-signing-a-message-with-a-card)
7. [Validating That a Message Has Been Signed by a Card](#7-validating-that-a-message-has-been-signed-by-a-card)
8. [Authenticating with a Card](#8-authenticating-with-a-card)

---

## Background Concepts

### The Card Address Model

A card's stable address is an entry in the Card registry contract deployed on Arbitrum One. The on-chain entry is a mutable pointer to the current head CID of an append-only log stored on IPFS. The log is immutable and content-addressed; only the pointer moves as new entries are appended.

**Address derivation.** A card's registry address is always `keccak256(recipient_pubkey)` — a one-way derivation from the card's public key. The on-chain entry stores the current IPFS log head CID in plaintext, but the IPFS content at that CID is **encrypted**. (See `ARCHITECTURE.md` ADR-006.)

**Content encryption.** Every card document stored on IPFS is encrypted with AES-256-GCM using a content key derived from the card's public key:

```
content_key  = HKDF-SHA3-256(ikm=recipient_pubkey, info="card-content-v1")
ipfs_payload = { "nonce": <96-bit random, base64url>,
                 "ciphertext": AES-256-GCM.Encrypt(content_key, card_document_bytes, nonce) }
```

A fresh nonce is generated for each log entry. The public key is the single credential needed to derive the address (via `keccak256`) and decrypt the content (via HKDF). There is no separate address secret and no per-card decryption key distinct from the public key itself. A party cannot read a card's content by knowing its address alone — they must hold the public key. Sharing a card means sharing its public key.

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
| `issuer_signature` | `base64url` | The offerer's ML-DSA-44 signature over the constructed offer (first signature); `ancestry_pubkeys` is present and covered |
| `holder_signature` | `base64url` | The recipient's ML-DSA-44 countersignature over the offer including their `recipient_pubkey` (second signature); `ancestry_pubkeys` is present and covered |
| `press_signature` | `base64url` | The press's ML-DSA-44 signature over the completed, countersigned card, applied last after the press validates policy compliance (third signature); `ancestry_pubkeys` is present and covered |

Targeted cards are signed in a fixed three-party sequence: the **offerer** (issuer) constructs the offer and signs it with their own card key (`issuer_signature`); the **recipient** adds their public key and countersigns (`holder_signature`); the offerer validates the countersigned result; the card is then sent to the **press**, which validates policy compliance, signs with its press sub-card key (`press_signature`), and registers it on-chain. The press key is never held by the offerer's wallet service — these are distinct parties and keys.

**Exception — directly-issued policy cards.** A policy card is issued directly by an authorizer with no press in the loop (§1). Such a card carries `issuer_signature` (the authorizer) and `holder_signature` (the administrator) but **no** `press_signature` and no `press_card`; `press_signature`/`press_card` are required only for cards issued through a press.

**Policy compliance is always anchored to `policy_id`.** When verifying that a card conforms to its governing policy — checking `field_definitions`, `recipient_predicate`, `requester_predicate`, or `approved_presses` membership — verifiers MUST use the content at the `policy_id` CID (the immutable content snapshot embedded at issuance), not the policy's current mutable pointer head. Subsequent changes to the live policy card cannot retroactively invalidate cards issued under a prior policy snapshot.

This rule has one explicit carve-out: **update authorization** (§5 update and revocation flow) evaluates `update_policy` predicates and `revocation_permissions` against the **current live policy**, since these govern present-time operations. Whether a given party may submit an update intent today is a question about the policy's current state, not the policy as it existed when the card was issued.

These fields cannot be modified by any update, regardless of the card's update policy.

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

**`auditors`** is a `card-pointer-array`. Audit log access is organized into **epochs** — time-bounded periods each secured by a single Audit Encryption Key (AEK). At the start of each epoch, the press generates a fresh random AEK and wraps it under each auditor's current ML-KEM (FIPS 203) public key, posting the resulting key packages as an `AuditEpochEntry` in the policy log. Issuance records during that epoch are encrypted under the shared AEK (AES-GCM with a per-entry random nonce) rather than individually encapsulated under each auditor's key; each auditor's wrapped copy of the AEK is their decryption entry point.

When an epoch closes — at a calendar boundary, on auditor key rotation, or on auditor addition or removal — the auditor decrypts all entries from that epoch, produces a signed `AuditEpochCommitment` attesting to the entry count, a hash commitment over all decrypted entry CIDs, and any findings, and then destroys the AEK. Entries from closed epochs become permanently undecryptable by anyone, providing forward secrecy scoped to the epoch boundary. The commitment stands as the permanent audit record for that epoch.

If an auditor card is revoked, the press stops wrapping new epoch AEKs for that auditor. The current epoch closes — the departing auditor produces a final commitment — and a new epoch opens without key packages for the removed auditor. Multiple auditors each receive their own independently-wrapped copy of each epoch's AEK. See **Audit Epoch Lifecycle** below for the full open/close procedure.

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
- Trusted Execution Environment (TEE) hardening for high-stakes policies: an optional path where the press is additionally attested via hardware enclave, providing stronger enforcement of rate limits and revocation freshness timing.

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
5. The **offerer's wallet service** assembles the proposed card JSON: protocol-required fields populated (`issuer_card`, `press_card`, `policy_id`, `issued_at`, and `ancestry_pubkeys` — the ordered array of ancestor ML-DSA-44 public keys from immediate parent up toward the root; `recipient_pubkey` left empty), and all `field_definitions` fields populated per the policy. (In targeted mode the offerer constructs the offer; the request at step 1 carries the offerer's parameters.)
6. The **offerer** signs the canonical serialization of the offer with the **offerer's own card key**, producing `issuer_signature` — the **signed offer**. `ancestry_pubkeys` is included in the signed payload. The press key is not used here.
7. The offer is delivered to the recipient: as an invitation link (base64 payload in a URL, e.g., `card://invite?o=<base64>`) for first-time recipients, or via HTTPS POST to the recipient's wallet service endpoint for existing holders.
8. The recipient reviews the offer (see §4), generates a keypair, adds their public key, and countersigns → `holder_signature`. The countersigned card is returned to the offerer, who validates `holder_signature` and forwards it to the press.
9. The **press** validates the countersigned card (both `issuer_signature` and `holder_signature` verify; predicates and schema satisfied), signs the complete document with its press sub-card key → `press_signature`, and posts it to IPFS. Either the press or the recipient's client may perform the IPFS posting after `press_signature` is applied.
10. The press creates a registry entry on Arbitrum One for the new card, with the initial log head CID; the write is authorized on-chain by the press's secp256r1 key in `PressAuthorizations`.
11. The press constructs an issuance log entry containing the new card's CID and the current `epoch_id`, and encrypts it under the current audit epoch's AEK (AES-GCM). If no epoch is open for this policy, the press opens one first — generating a fresh AEK and posting an `AuditEpochEntry` to the policy log — before encrypting the entry. The press operator cannot read these entries.
12. The press appends the log entry to the policy card's IPFS log and updates the policy card's Arbitrum One registry entry to point to the new log head.
13. The press produces a **Signed Card Inclusion Proof (SCIP)**: a small signed object binding the new card's CID to its log entry index and the log root at time of inclusion. The SCIP is signed with the press's sub-card key.
14. The press sends the SCIP and a confirmation to the recipient, and an audit record (card CID + SCIP) to the administrator, both encrypted and delivered via HTTPS to their respective wallet service endpoints.

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
2. The wallet service stores the offer and generates a claim link (`card://claim?o=<base64>` or a wallet-service-hosted URL) for distribution.
3. The issuer distributes the claim link via any channel (private message, QR code, email, etc.). The security of the resulting cards is bounded by the channel's trustworthiness.
4. A recipient follows the claim link. The wallet service presents an offer review screen: issuer identity and chain summary, proposed field values, acceptance constraints (slots remaining if `max_acceptances` is set, expiry if `expires_at` is set), and the redirect destination URL.
5. The recipient's client verifies the issuer's card chain to a trusted root and confirms the named press sub-card appears in the policy's `approved_presses`. If either check fails, the offer is rejected before display.
6. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this card, stores the private key in the keyring, and assembles an **open offer claim payload**: `{ "offer": <verbatim OpenCardOffer document>, "recipient_pubkey": <new public key> }`. The client signs the canonical RFC 8785 JSON of this claim payload with the new private key, producing a `recipient_signature`.
7. The wallet service submits an **OpenOfferClaimSubmission** to the approved press via HTTPS POST: `{ "claim_payload": { "offer": ..., "recipient_pubkey": ... }, "recipient_signature": ... }`. See `protocol-objects.md` §7 for the full schema.
8. The press validates: (a) the issuer's signature over the offer document is valid; (b) the press's own sub-card is listed in `approved_presses`; (c) the policy card has `allow_open_offers: true`; (d) the press independently checks `expires_at` and reads `OpenOfferUseCounts[offer_id]` on-chain to confirm capacity — this is the press's own pre-flight, separate from the contract's atomic enforcement (see below). If validation fails at any step, the press rejects with a specific error code before submitting any transaction.
9. The press signs the per-recipient card with its press sub-card key (producing `press_signature`), calls `ClaimOpenOffer` on-chain (which atomically re-validates constraints and registers the card), then posts the completed card to IPFS. (The offerer's authorization for an open offer is the `issuer_signature` on the `OpenCardOffer` document; the recipient's countersignature is `holder_signature`.)
10. The press confirms completion to the wallet service. The wallet service updates the recipient's keyring to include the new card address and presents a confirmation screen, then redirects the recipient to `redirect_url` (displaying the destination URL to the recipient first).
11. An issuance log entry is encrypted to each auditor and appended to the policy card's IPFS log, as in the targeted issuance flow. A courtesy notification is sent to the issuer via HTTPS to their wallet service endpoint.

**Open offer smart contract enforcement.** For cards submitted under an open card offer, the press calls `ClaimOpenOffer` (see `registry_contract.md §4.5`) — a separate on-chain entrypoint that combines acceptance-count enforcement and card registration in a single atomic transaction. `ClaimOpenOffer` is distinct from `RegisterCard`; a press must not call `RegisterCard` for open-offer claims. No pre-registration of the offer on-chain is required; the acceptance counter (`OpenOfferUseCounts[offer_id]`) is lazily initialized on the first accepted claim.

**Press pre-flight verification.** Before submitting `ClaimOpenOffer`, the press verifies the issuer's ML-DSA-44 signature over the `OpenCardOffer` document (confirming `max_acceptances`, `expires_at`, and all offer terms were set by the issuer and have not been tampered with). A press that submits a claim for an offer with an invalid issuer signature violates press policy and is subject to observable detection and deregistration (E-14). The contract does not re-verify the issuer signature on-chain.

The press calls `ClaimOpenOffer` with: `offer_id` (keccak256 of the canonical RFC 8785 JSON of the complete offer document including `issuer_signature`), `max_acceptances` (`null` in the document is encoded as `type(uint64).max` in calldata; any other value is passed as-is), `expires_at` (`null` encoded as `0`), and the standard card registration fields.

The contract executes the following checks atomically with card registration:

1. Confirms `block.timestamp < expires_at` (skipped if `expires_at` is `0`, meaning unconstrained).
2. Looks up `OpenOfferUseCounts[offer_id]` and confirms the current count is less than `max_acceptances` (skipped if `max_acceptances` is `type(uint64).max`, meaning unconstrained).
3. Atomically increments `OpenOfferUseCounts[offer_id]` and registers the card (with press authorization checks per §6.1).

If any check fails, the transaction reverts and the card is not registered. The press surfaces a specific rejection reason to the wallet service (E-12: offer expired, E-13: offer at capacity). A recipient who loses the race to the last acceptance slot receives a clear error rather than a spinner timeout.

**Key separation.** The policy authorizer's card key and any auditor's card key must be separate from each other. A compromised auditor key must not grant policy control.

**Audit Epoch Lifecycle.**

Audit log entries are secured by a per-epoch Audit Encryption Key (AEK) rather than by per-entry ML-KEM encapsulations. This design provides epoch-scoped forward secrecy: once an epoch closes and its AEK is destroyed, those entries are permanently undecryptable — including by the auditor — regardless of any future key compromise. The commitment produced at epoch close is the permanent record.

*Opening an epoch.* Before posting the first issuance entry of a new epoch, the press:

1. Generates a fresh 256-bit AEK at random for this epoch.
2. For each active auditor in the policy's `auditors` array: runs ML-KEM.Encaps(auditor_pubkey) to produce a `(kem_ciphertext, kem_shared_secret)` pair, then derives a wrapping key from `kem_shared_secret` (HKDF-SHA3-256) and computes `wrapped_aek = AES-GCM.Encrypt(wrapping_key, AEK)`.
3. Posts an `AuditEpochEntry` (see `protocol-objects.md` §12) to the policy log containing all per-auditor key packages, the epoch's `epoch_id` and `epoch_start`, and the press's ML-DSA-44 signature.
4. Discards the raw AEK from memory immediately after distributing the wrapped copies. The press never retains plaintext access to the AEK.

During the epoch, the press encrypts each `PressIssuanceRecord` with the epoch AEK: `AES-GCM.Encrypt(AEK, record, nonce)` where `nonce` is a fresh 96-bit random value per entry. The encrypted record is stored on IPFS. Each entry's `epoch_id` field identifies which epoch key the auditor should use to decrypt it.

*Closing an epoch.* An epoch closes on any of the following triggers:

- **Calendar boundary:** The epoch's defined period ends (annual epochs close on December 31 UTC).
- **Auditor key rotation:** An auditor updates their ML-KEM public key via the standard update flow.
- **Auditor added or removed:** Any change to the `auditors` array closes the current epoch and opens a new one with key packages for the updated auditor set.

On epoch close, the procedure is:

1. The auditor fetches all `PressIssuanceRecord` entries for the epoch from the policy log. For each entry: decapsulates the `kem_ciphertext` using their private key to recover `kem_shared_secret`, derives the wrapping key, unwraps the AEK from `wrapped_aek`, then decrypts the entry body with the AEK.
2. The auditor produces an `AuditEpochCommitment` (see `protocol-objects.md` §13): a signed IPFS document containing the `epoch_id`, `entry_count`, a SHA3-256 hash commitment over all decrypted entry CIDs in log order, and a free-text `findings` field (any anomalies or compliance issues observed; "no issues found" if clean). The auditor signs the commitment with their card key.
3. The auditor publishes the `AuditEpochCommitment` to IPFS and sends its CID to the press via HTTPS.
4. The press posts an `AuditEpochEntry` with `status: "closed"` and `commitment_cid` to the policy log, recording the closed epoch and the commitment's location.
5. The auditor destroys the epoch AEK. This step is irreversible — entries from this epoch are now permanently undecryptable by anyone.

*Forward secrecy boundary.* A compromised auditor key exposes only the current open epoch's AEK — and only entries within that epoch. Closed epochs' AEKs have been destroyed; their records are permanently inaccessible. Shorter epoch durations (e.g., quarterly) reduce the maximum exposure window at the cost of more frequent commitment operations.

*Auditor key rotation within an epoch.* When an auditor's ML-KEM public key changes, the current epoch must close before the new key is used. The auditor produces an `AuditEpochCommitment` under their old key, destroys the old AEK, and the press opens a new epoch with key packages generated under the auditor's new public key. The press must not post issuance entries under the old epoch AEK after observing the auditor's key update on-chain.

*Adding a new auditor.* When a new auditor is added to the `auditors` array, the current epoch closes, the existing auditor(s) produce commitments, and a new epoch opens with key packages for all active auditors including the new one. The new auditor has no access to prior epochs' entries — their AEKs were destroyed at prior epoch close. This is by design: audit access is not retroactively granted.

**Acceptance criteria:**

- [ ] A press whose sub-card pointer does not appear in `approved_presses` cannot write to the Arbitrum One registry.
- [ ] A press whose sub-card is revoked with an effective date at or before now cannot write to the Arbitrum One registry.
- [ ] A completed card contains all three signatures — the offerer's `issuer_signature`, the recipient's `holder_signature`, and the press's `press_signature` — and any verifier can confirm all three independently without contacting the press.
- [ ] At epoch open, each active auditor receives an independently-wrapped copy of the epoch AEK, decryptable only with their card's private key; the AEK wrappings are posted in an `AuditEpochEntry` in the policy log.
- [ ] Issuance log entries are encrypted under the epoch AEK; neither the press operator nor any party without an auditor's private key can read them.
- [ ] On epoch close, the auditor produces a signed `AuditEpochCommitment` (entry count + hash commitment over all entry CIDs + findings) before destroying the AEK; the commitment CID is recorded in the policy log.
- [ ] A future compromise of an auditor's card key cannot decrypt entries from epochs whose AEKs have been destroyed.
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

- Trusted Execution Environment (TEE) hardening for high-stakes policies: optional hardware attestation proving the press is running unmodified open-source code.
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

**Keyring structure.** The keyring is an append-only encrypted blob stored on IPFS. It holds the master private key for each card the holder controls, the private keys for any sub-cards registered to those master cards, and metadata associating each key with its corresponding card mutable pointer. The keyring is encrypted with a key derived from `passkey + service_secret`. The primary service holds `service_secret` but never sees plaintext keys or the decryption key. Because the keyring is append-only, new keys are added without destroying prior entries.

**Sub-card keys.** Sub-card private keys are held in secure device storage (Secure Enclave on Apple devices, TPM on others). All routine signing operations use sub-card keys. The master card key is accessed only for: creating new sub-cards, performing key rotations, and other high-stakes operations. Sub-cards are registered to their master card: the master key signs each sub-card registration, making the link verifiable.

**YubiKey backup registration.** The holder registers with one or more backup services, presenting their YubiKey. The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The backup service never sees the decryption key in plaintext. The backup service returns a card (proof of registration) and records the holder's notification channels and cancellation credentials.

**Recovery flow.**
1. Holder presents their YubiKey to a backup service.
2. Backup service simultaneously sends notifications to all configured channels (email, SMS, HTTPS webhook, secondary contacts).
3. Backup service waits 72 hours for a cancellation signed by any registered cancellation credential.
4. If cancellation is received: the service aborts and notifies the holder to rotate their backup registration and treat the old YubiKey as potentially compromised.
5. If no cancellation after 72 hours: the service releases the CID of the encrypted keyring blob plus the wrapped decryption key blob. The holder's device presents the wrapped blob to the YubiKey (PIN required); the YubiKey unwraps it locally; the resulting key fetches and decrypts the keyring from IPFS.
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
3. The offer is encoded as `card://invite?o=<base64>` and delivered out of band.
4. The recipient opens the link. If no keychain exists, the client presents the keychain setup flow (§3) before proceeding.
5. The client verifies `issuer_signature` and walks the offerer's (`issuer_card`) chain to a trusted root. If verification fails, the offer is rejected before being shown to the user.
6. The client presents a review screen: offerer identity (chain summary), card content and field values, the policy and schema governing it, and what countersigning commits the recipient to.
7. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this card, stores the private key in the keyring, adds the public key to the card JSON, and signs the canonical serialization with the new private key → `holder_signature`.
8. The countersigned card is returned to the offerer, who validates `holder_signature` and forwards it to the press. The press validates predicates, revocation, and schema, then signs the completed card with its press sub-card key → `press_signature`. The completed card — `issuer_signature`, `recipient_pubkey`, `holder_signature`, `press_signature`, and `ancestry_pubkeys` — is posted to IPFS by the press or the recipient's client.
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
- **Not:** Retroactive removal of prior log entries (except `erasable: true` cards, opt-in at issuance).
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
   - No fields in `field_updates` are protocol-required immutable fields.
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

**History erasure.** If the policy specifies `erasable: true` for a card, a revocation entry with `erasure: true` may redact prior log entries, leaving only the revocation statement. Cached copies held by others become unauthenticatable. Cards without `erasable: true` may be revoked but not erased.

**On-chain anchoring.** After each update, the Arbitrum One registry entry for the card is updated to point to the new log head CID, providing a trusted timestamp and rollback resistance. Only the press sub-card key is required for this write; the contract verifies the press is in `approved_presses` for the policy.

**Acceptance criteria:**
- [ ] An update intent whose updater does not satisfy the relevant field's `update_policy` is rejected by the press.
- [ ] A revocation intent whose updater does not satisfy `revocation_permissions` for the given code range is rejected by the press.
- [ ] An 810 intent signed by the holder (satisfying `is_holder`) is accepted by the press without issuer involvement.
- [ ] A verifier re-checking an update entry can independently confirm the updater's card satisfies the relevant `update_policy` or `revocation_permissions` predicate by evaluating the predicate against the updater's card chain.
- [ ] An erasure update on a card whose policy does not have `erasable: true` is rejected by the press.
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

2. **Sub-card to master link.** Derive the signing sub-card's registry address as `keccak256(public_key)` from the `SignatureEntry`. Decrypt the leaf sub-card document (content key = `HKDF-SHA3-256(public_key, info="card-content-v1")`). Read `holder_primary_card_pubkey` and `app_card_pubkey` from the decrypted `SubCardDocument` (see `protocol-objects.md §16`); these are untrusted hints — confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address and `keccak256(app_card_pubkey)` equals the `app_card` pointer address before use (a mismatch or an AES-GCM decryption failure on either parent card is a hard rejection). Derive `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")` to decrypt the master card and confirm the sub-card appears in its active sub-card list; verify the master card holder's ML-DSA-44 signature on the sub-card registration using `holder_primary_card_pubkey`. See `process_specs/card_validation.md` Stage 2 for the full procedure.

2a. **Capability check (sub-cards only).** If the signing sub-card has an associated `SubCardDocument` (see `protocol-objects.md §16`), retrieve it and confirm the message's `type` field appears in the sub-card's `capabilities` array. If the message type is absent from the whitelist, reject the signature regardless of cryptographic validity. If no `SubCardDocument` exists (legacy or wallet primary-key signature), skip this step.

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

### Problem Statement

A service needs to verify that a user holds a card satisfying some predicate, or to receive a signed statement from a user's card, without knowing in advance which wallet service the user has registered with. The requesting site must be able to route the request to the correct wallet, receive a signed response, and confirm the user's browser session is associated with that response — all without requiring the wallet service to expose its identity to the requesting site, and without routing the full request payload through any intermediary.

### Goals

- Allow a requesting site to initiate a card authentication or signing request without knowing the user's wallet service in advance.
- Route the request to the user's wallet via a thin intermediary (CHAPI or future browser-native API) that sees only metadata, not payload content.
- Support the wallet fetching and responding to the request via a direct channel, with optional IP-level privacy via OHTTP.
- Provide a confirmation code mechanism that ties the browser session to the signed response received out-of-band.
- Make the resulting signed statement independently verifiable by any party, using the standard verification flow in §7.

### Non-Goals

- **Not:** A centralized authentication service. The protocol defines request and response formats; the requesting site does its own verification.
- **Not:** Session management beyond the confirmation code handoff. Cookie and session lifecycle is the requesting site's responsibility.
- **Not:** Requiring the user to hold a specific named card — the request specifies predicates, not identities.

### User Stories

**As a site operator,** I want to request that a visitor sign a statement using any card that satisfies a given predicate, so that I can confirm their trust lineage without managing an allowlist of specific public keys.

**As a user,** I want my wallet to receive a signing request, show me clearly what I am being asked to sign and why, and let me approve or decline, so that I am never surprised by what my card has signed.

**As a user,** I want to see the requesting site's card and verify their trust lineage before signing anything, so that I can assess whether the requester is trustworthy before committing my credential to their request.

**As a privacy-conscious user,** I want the wallet service's identity to remain hidden from the requesting site where possible, so that the requesting site cannot learn which wallet service I use.

**As a wallet service,** I want to respond to signing requests over HTTPS, with the option to use OHTTP for additional IP privacy where the requester supports it.

### Requirements

#### Must-Have (P0)

**Authentication request object.** The requesting site creates a JSON authentication request and hosts it at a single-use URL. The request object:

```json
{
  "session_id": "<UUID — stable identifier for this auth session>",
  "version": "1",
  "purpose": "<human-readable description shown to user in wallet UI>",
  "requesting_site": "<origin of the requesting site, for display>",
  "requester_card": "<mutable pointer of the requesting site's own card>",
  "payload": {
    "content": "<the content the user is being asked to sign>",
    "context": "<optional: additional human-readable context>",
    "nonce": "<random value — replay prevention>"
  },
  "required_predicate": <optional card predicate expression — same format as §1>,
  "required_policy": "<optional CID of a required policy card>",
  "callbacks": {
    "https": "<HTTPS URL to POST the signed response to — required>",
    "ohttp": {
      "relay": "<OHTTP relay URL>",
      "gateway_key": "<OHTTP gateway public key, base64url — optional>"
    }
  },
  "redirect_uri": "<URL to redirect user to after completion — must contain the literal string {code}>",
  "expires_at": "<ISO 8601 timestamp>",
  "request_signature": "<ML-DSA-44 signature from the requester's card key over the canonical serialization of all above fields>"
}
```

`requester_card` and `request_signature` are required. A request without either must be rejected by the wallet before being shown to the user. The requester's card gives the user a verifiable trust chain for the requesting site. `callbacks.https` is required; `callbacks.ohttp` is optional for deployments that want IP-level privacy on the response leg.

The request URL is single-use and expires at `expires_at`. Requests must not be reused across sessions. The `nonce` in the payload is incorporated into the signed statement and must be verified by the requesting site to prevent replay.

**Wallet discovery via CHAPI.** The requesting site includes the CHAPI polyfill and calls `navigator.credentials.get()` with a Web Credential request containing the authentication request URL (not the full request object). CHAPI routes this to the user's registered wallet service by opening the wallet's credential handler page in a controlled popup. The requesting site's code observes only a call to the CHAPI polyfill — it does not receive the wallet service's URL or identity from this call.

If no wallet is registered in CHAPI, the wallet's credential handler page is not opened. The requesting site should handle this case by presenting a prompt directing the user to register a wallet service.

**Direct fetch flow.**

1. The wallet service's credential handler page, once opened by CHAPI, receives the authentication request URL.
2. The wallet fetches the request object from that URL via HTTPS.
3. The wallet validates the request: confirms `expires_at` has not passed, confirms `requester_card` and `request_signature` are present, and verifies the `request_signature` against the canonical serialization of the request object using the requester's card public key.
4. The wallet walks the requester's card chain to a trusted root and checks for revocation, exactly as in §7. If the chain fails verification or any link is revoked, the request is rejected before display.
5. The wallet confirms the `required_predicate` against the user's available cards. If no qualifying card exists, the wallet shows a clear explanation rather than a generic error.
6. The wallet presents the signing request to the user: the `purpose`, the requester's verified card identity and chain summary, `payload.content`, and a summary of the `required_predicate` if set. The wallet must clearly show what will be signed and who is asking — including the requester's trust lineage, not just their domain name.
7. If the user approves: the wallet selects a qualifying card (or presents a chooser if multiple qualify), assembles a signed message envelope per §6 with `type: "auth_response"`, `content: { statement, context, nonce }` (copied from the request's `payload`), `senders` (the holder's master card pointer), `recipients` (`requester_card`), and `timestamp` (current time). The wallet signs the canonical RFC 8785 JSON of the payload with the selected sub-card key and assembles the authentication response.
8. The wallet sends the authentication response to the requester via the preferred transport (see below). On success, the requester returns a `confirmation_code` — a short-lived, single-use opaque token — in the response body.
9. The wallet redirects the user's browser to `redirect_uri` with `{code}` replaced by the `confirmation_code`. The requesting site's page picks up the code, looks up the associated signed response, and considers the session authenticated.

**Authentication response object** (posted by wallet to requester):

```json
{
  "session_id": "<matches the request>",
  "signed_statement": <signed message envelope per §6>,
  "card_pointer": "<mutable pointer of the card used to sign>"
}
```

**Transport options.** The wallet selects the most private transport available, in preference order: OHTTP > HTTPS. Because badges are associated with wallet addresses on-chain, the wallet service's identity is not considered sensitive, and HTTPS is acceptable as the primary transport.

- **OHTTP (Oblivious HTTP, RFC 9458)** — If the requester advertises an OHTTP gateway in `callbacks.ohttp`, the wallet may use it for IP-level privacy. The relay knows the wallet's IP but not the content; the requester's gateway sees the content but not the wallet's IP. No single party observes both. Latency is near-HTTPS (single relay hop).

- **HTTPS** — The wallet posts the response to `callbacks.https`. The requester can observe the wallet service's server IP. This is the standard transport and is required for all conforming implementations.

**Verification.** On receiving an authentication response, the requesting site verifies the signed statement per §7: signature validity, chain walk to a trusted root, revocation check, predicate evaluation, and nonce match. The confirmation code is only issued after successful verification.

**Acceptance criteria:**

- [ ] The requesting site's JavaScript code does not receive the wallet service's URL or identity from the CHAPI call.
- [ ] A request missing `requester_card` or `request_signature` is rejected by the wallet before display.
- [ ] A request whose `request_signature` does not verify against the requester's card public key is rejected before display.
- [ ] A request whose requester's card chain cannot be walked to a trusted root is rejected before display.
- [ ] The authentication request URL is single-use: a second fetch of the same URL after the response has been posted returns an error.
- [ ] The `nonce` from the auth request appears in `signed_statement.payload.content.nonce`; a response with a mismatched or absent nonce is rejected.
- [ ] The `expires_at` on the request is enforced: a wallet that fetches an expired request must reject it and notify the user.
- [ ] A confirmation code is only issued after the signed statement passes full §7 verification.
- [ ] The confirmation code is single-use: presenting the same code twice is rejected.
- [ ] A user who declines the signing request in the wallet UI is redirected to `redirect_uri?error=declined`.
- [ ] The wallet sends the authentication response via HTTPS to `callbacks.https`; OHTTP is used instead if `callbacks.ohttp` is present and the wallet supports it.
- [ ] The wallet presents the requester's verified card chain summary to the user before they approve or decline.

#### Nice-to-Have (P1)

- **Wallet chooser UI.** When multiple cards in the user's wallet satisfy `required_predicate`, the wallet presents a chooser showing each qualifying card's policy and issuer, so the user can select which credential to present.
- **CHAPI-free fallback.** A requesting site that does not use CHAPI can instead display a QR code or deep link (`card://auth?r=<request-url>`) that the user opens in their wallet app directly. Enables authentication flows on devices without CHAPI support.
- **OHTTP relay selection.** A protocol-level registry or well-known discovery endpoint for OHTTP relays trusted by the Card ecosystem, so requesting sites can advertise a relay without requiring wallet services to configure relay trust ad hoc.

#### Future Considerations (P2)

- **Digital Credentials API.** When the W3C Digital Credentials API reaches broad browser support, CHAPI can be replaced with a browser-native call (`navigator.identity.get({ digital: ... })`). The request object format and direct fetch flow remain unchanged; only the wallet discovery step changes. The browser-native path provides stronger privacy guarantees (routing is browser-enforced, not polyfill-enforced) and eliminates the CHAPI mediator's metadata visibility entirely.
- **Requester anonymity.** Currently the user's browser navigates to the requesting site before any credential exchange, so the requester always learns the browser's IP from the page load. Future work could explore flows where the credential exchange precedes site navigation.
- **Multi-card statements.** A single authentication request that requires signatures from multiple cards simultaneously (e.g., "sign with both your community membership and your identity card").

### Open Questions

- **[Design]** Should `required_predicate` be evaluated by the wallet before showing the request to the user (hiding requests the user can't fulfill), or shown regardless with a clear explanation of why no qualifying card is available?
- **[Engineering]** How does the requesting site manage confirmation code expiry and cleanup for sessions where the user never completes the redirect?
- **[Design]** Should the wallet service advertise its supported transports in a well-known manifest (e.g., `/.well-known/card-wallet.json`) so requesting sites can know whether to populate `callbacks.ohttp` before constructing the request?

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
- **Developer SDK adoption:** number of services integrating the `CardAuth` npm package
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
| Absent optional field | `null` / omitted | Omitted from object entirely |

### A.3 Optional Field Omission

Optional fields that are absent MUST be omitted from the serialized object entirely. A field present with a `null` or `undefined` value MUST be stripped before encoding. Including `null` would produce different bytes than omission and would break signature verification across implementations.

### A.4 Conformance Test Corpus

The file `specs/serialization-conformance.json` contains 22 reference test cases. Each case specifies a JSON input object and the expected RFC 8785 canonical JSON output string. Implementations MUST produce byte-identical output for all cases before being considered conformant.

The corpus covers: string encoding, integer encoding, negative integers, boolean encoding, ISO 8601 timestamp strings (as plain strings), date strings, base64url strings (as plain strings), map key ordering (same-length and different-length keys at all nesting levels), optional field omission, Unicode text fields, and array fields.
