# Chitt Protocol — Feature Specification

**Version:** 0.3 (draft)
**Date:** 2026-05-19
**Status:** In Review

---

## Overview

The Chitt Protocol is a decentralized, privacy-preserving credential system. A **chitt** is a cryptographically signed credential whose current state is tracked via a mutable pointer in the Chitt registry contract on Arbitrum One, whose full history lives in an append-only log on IPFS, and whose issuance is governed by a **policy chitt** — itself a chitt whose content specifies who may issue, what the credential contains, and how it can be updated or revoked.

This document specifies the behavior of eight core features:

1. [Creating Chitt Policies](#1-creating-chitt-policies)
2. [Pressing Chitts and Updating Logs](#2-pressing-chitts-and-updating-logs)
3. [Setting Up a Keychain and Backup Options](#3-setting-up-a-keychain-and-backup-options)
4. [Receiving a Chitt as a User](#4-receiving-a-chitt-as-a-user)
5. [Updating Chitts](#5-updating-chitts)
6. [Signing a Message with a Chitt](#6-signing-a-message-with-a-chitt)
7. [Validating That a Message Has Been Signed by a Chitt](#7-validating-that-a-message-has-been-signed-by-a-chitt)
8. [Authenticating with a Chitt](#8-authenticating-with-a-chitt)

---

## Background Concepts

### The Chitt Address Model

A chitt's stable address is an entry in the Chitt registry contract deployed on Arbitrum One. The on-chain entry is a mutable pointer to the current head CID of an append-only log stored on IPFS. The log is immutable and content-addressed; only the pointer moves as new entries are appended.

**Privacy posture** is determined entirely by client-side choices at creation time. The contract is neutral. Three modes are supported:

- **Fully public:** pubkey-derived registry address; plaintext CID on-chain. Discoverable by anyone who knows the owner's public key.
- **Selectively shared:** secret-derived registry address (from `hash(sign(private_key, "chitt-log-v1"))`); encrypted CID on-chain. Only parties holding the capability bundle (address + decryption key) can find and read the chitt.
- **Fully private:** secret-derived registry address; encrypted CID; encrypted IPFS content. Only capability bundle holders can read any layer.

**Two keys per private chitt:**

- **Address secret** — derives the registry address. Controls who can locate the account. Never shared.
- **Decryption key** — decrypts the on-chain CID. Grants read access. Can be shared independently.

### Protocol-Required Fields

Every issued chitt contains a fixed set of immutable protocol-required fields set at issuance and never subsequently changed:

| Field | Type | Description |
|---|---|---|
| `policy_id` | `cid` | CID of the policy chitt at time of issuance |
| `press_chitt` | `chitt-pointer` | Mutable pointer in registry of the press sub-chitt that issued this chitt |
| `recipient_pubkey` | `base64url` | The recipient's ML-DSA-44 public key (1,312 bytes) |
| `issued_at` | `timestamp` | Timestamp of issuance |
| `offer_signature` | `base64url` | The press's ML-DSA-44 signature over the canonical offer payload |
| `holder_signature` | `base64url` | The recipient's ML-DSA-44 countersignature over the completed chitt |

These fields cannot be modified by any update, regardless of the chitt's update policy.

### The Field Type System

All chitt fields — whether in policy chitts or in issued chitts — use a common type system. Each field definition specifies a type, optional validation, and an update policy.

| Type | Validation options |
|---|---|
| `text` | `regex` (optional — pattern the value must match) |
| `base64url` | — (value is a base64url-encoded binary field per RFC 4648 §5, no padding; encoded as CBOR byte string in canonical serialization) |
| `integer` | `min`, `max` |
| `number` | `min`, `max` |
| `boolean` | — |
| `date` | `min`, `max` |
| `timestamp` | `min`, `max` |
| `cid` | `required_template` (optional), `field_requirements` (optional) |
| `chitt-pointer` | `required_template` (optional), `field_requirements` (optional) |
| `chitt-pointer-array` | `min_count`, `max_count`, `required_template` (optional), `field_requirements` (optional) |
| `append-only-array` | `item_type` (any of the above), plus that item type's validation options |
| `policy-creation-constraint` | Structured object — see §1, *The `policy_creation` Field* |

**Notes on types:**

`text` with a `regex` replaces both the legacy `enum` type (use `^(option1|option2|option3)$`) and explicit length limits (use `^[\s\S]{0,500}$`). The regex applies to the full string value.

`chitt-pointer` and `chitt-pointer-array` accept `field_requirements` — a list of `{ field, regex }` pairs that the referenced chitt's fields must satisfy. For example, "must be an employee chitt whose `role` field is `admin`":

```json
{
  "name": "approver",
  "type": "chitt-pointer",
  "required_template": "<employee-policy-id CID>",
  "field_requirements": [
    { "field": "role", "regex": "^admin$" }
  ]
}
```

`cid` with `field_requirements` applies when the CID points to structured JSON content; the requirements are evaluated against the parsed content at that CID.

`append-only-array` items can only be added, never removed or edited. For `append-only-array` items of type `chitt-pointer`, `required_template` and `field_requirements` apply to each item.

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
// The subject's chitt was issued under this policy

{ "chain_includes": "<mutable pointer>" }
// This specific chitt appears somewhere in the subject's chain

{ "chitt_field_matches": { "template": "<policy_id CID>", "field": "<name>", "regex": "<pattern>" } }
// A chitt in the subject's chain issued under the named template has a field matching the regex

{ "is_holder": true }
// The subject is the holder of the chitt being updated

{ "is_issuer": true }
// The subject is the issuer (press) of the chitt being updated

{ "chain_depth_at_most": <integer> }
// The subject's chain has at most N links
```

Predicates are finite and non-recursive. Evaluation is deterministic from publicly-available chain data; any verifier can re-evaluate independently.

### The Update & Revocation Code System

Every log entry carries a required `code` field — a three-digit integer signaling the semantic nature of the update to verifiers and downstream systems. Codes are grouped into ranges by their trust implication. Within each range, lower subcodes indicate more favorable outcomes and higher subcodes indicate less favorable ones.

**Code ranges:**

| Range | Semantics | Entry type | Chitt status after |
|---|---|---|---|
| 1xx | Positive update — the holder has earned additional standing, often by linking to a new chitt (e.g. a promotion). | `field_update` | Active |
| 2xx | Positive context — an annotation indicating the holder is deserving of additional trust; no field changes implied. | `field_update` | Active |
| 3xx | Neutral update — a field change with no trust implication (e.g. a `valid_until` refresh). | `field_update` | Active |
| 4xx | Neutral context — pertinent information added for verifiers that carries no positive or negative trust signal. | `field_update` | Active |
| 5xx | Programmatic update — an automated field change triggered by protocol or policy logic, not a human decision. | `field_update` | Active |
| 6xx | Negative context — an annotation suggesting reduced trustworthiness that does not yet warrant revocation. | `field_update` | Active |
| 7xx | Negative update — a field change that reduces the holder's privileges (e.g. removing admin rights). Within the 7xx range, lower subcodes indicate the reduction is honorable (retiring with distinction); higher subcodes indicate it is less so. | `field_update` | Active |
| 8xx | Quiet revocation — the chitt is revoked; the holder is not considered an active risk to other communities. The holder's standing in other contexts is unaffected by this revocation alone. | `revocation` | Revoked |
| 9xx | Loud revocation — the chitt is revoked and the holder may pose risks to other communities. Verifiers operating multi-chitt communities may wish to notify issuers of other chitts they have seen this holder use. | `revocation` | Revoked |

Entries with codes 1xx–7xx use `field_updates` to record changes and do not carry an `effective_date`; the update takes effect at the time it is posted. Entries with codes 8xx–9xx are revocations and carry an `effective_date` that may be earlier than the posting date — the issuer is asserting when the relevant condition began.

**Initial defined codes:**

| Code | Meaning |
|---|---|
| 100 | Positive update — linked to successor or additional chitt (e.g. promotion) |
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
| 810 | Quiet revocation — this chitt's signing key compromised |
| 811 | Quiet revocation — device sub-chitt lost or stolen (this chitt only) |
| 900 | Loud revocation — credential obtained under false pretenses |
| 901 | Loud revocation — policy violation identified post-issuance |
| 910 | Loud revocation — full wallet compromise suspected |
| 911 | Loud revocation — bad actor or harmful conduct |

Additional codes within each range may be defined as use cases arise.

**Verification rule for revocations:** When evaluating any chitt or signature, walk the full chain. For each link, check whether any 8xx or 9xx entry exists with an `effective_date` at or before the timestamp of the thing being evaluated. If so, apply the appropriate semantics: for 8xx, things before the effective date remain trusted; for 9xx, things on or after the effective date are invalid or suspect. If multiple revocation entries exist, the one with the earliest effective date governs. 1xx–7xx entries do not affect the chitt's revocation status.

**Historical signature semantics by code range:**

| Range | Historical signatures |
|---|---|
| 1xx–7xx | Fully trusted; the chitt was not revoked at any point. |
| 8xx | Trusted before effective date. The revocation signals a change of state, not a claim that prior actions were invalid. |
| 9xx | Trusted before effective date; suspect or invalid on or after it. Verifiers should apply judgment based on the subcode and context. |

**Propagation of loud revocations.** A 9xx revocation is a signal, not an automatic action, against other chitts the holder may hold. Presses and community operators who observe a 9xx entry may choose to notify issuers of other chitts they have interacted with from the same holder — but this is a social protocol, not a cryptographic one. No automatic cascading revocation occurs.

**Un-revocation.** The append-only log cannot remove a revocation entry. To restore standing after an erroneous 8xx or 9xx revocation, the authorizer issues a new **successor chitt** with a `supersedes` field pointing to the old chitt's mutable pointer, and a `supersession_note` field explaining the context. The successor chitt has a clean history; the old revocation remains visible in the old chitt's log for auditability.

### The Press Model

**Key custody is user-sovereign.** The press never holds a chitt holder's signing key. The press signs chitt offers with its own chitt key — attesting that it verified policy compliance — but the holder generates their own keypair and countersigns the offer to accept it. The press's signature is a statement about policy adherence, not an identity claim on behalf of the holder.

A **chitt press** is a service (self-hosted or commercial) that:
1. Holds a **press sub-chitt** — a sub-chitt of a specific policy chitt, authorizing it to issue chitts under that policy.
2. Verifies that issuance requests satisfy the policy's predicates.
3. Signs chitt offers with its press sub-chitt key.
4. Posts completed chitts to IPFS and updates the Arbitrum One registry.
5. Logs each issuance in the policy chitt's audit log, encrypted to each auditor chitt's public key.

The press's signing key is the private key for its press sub-chitt — no separate press key type exists. Presses hold funded Arbitrum One wallets to pay for on-chain writes. Most end users never interact with IPFS or the chain directly.

---

## 1. Creating Chitt Policies

### Problem Statement

A chitt authorizer needs to define the rules governing what chitts may be issued under their authority — including field schema, who may request and receive them, how they can be updated, who can audit issuances, and which presses may operate the policy. Without a signed, verifiable policy, presses cannot be constrained and the trust model breaks down.

### Goals

- Express a policy as a chitt, so that all standard chitt machinery — updating, revocation, audit logs, sub-chitt authorization — applies to policies without special-case infrastructure.
- Produce a content-addressed policy chitt whose registry address and log are the stable, living record of that policy.
- Enable verifiers to independently confirm that any issued chitt was produced under a valid, currently-active policy.
- Allow granular delegation: different parties can update different aspects of the policy (e.g., the administrator manages auditors; the authorizer must co-sign schema changes).

### Non-Goals

- **Not:** A visual policy builder. Policy creation in v1 is a structured JSON authoring workflow.
- **Not:** Policy search or discovery. There is no global registry of policies; distribution is the authorizer's responsibility.
- **Not:** Policy inheritance or composition. A policy stands alone; referencing another policy's predicates is done by including the same predicate expression, not by reference.

### User Stories

**As a policy drafter (e.g., a school administrator),** I want to assemble a policy JSON defining the schema, predicates, and update rules for a class of chitt, so that any press operating under this policy knows exactly what it may issue and under what conditions.

**As a policy authorizer (e.g., a superintendent),** I want to review the proposed policy, approve it by issuing a policy chitt to the administrator, and publish it to IPFS, so that any verifier can confirm my authorization without contacting me again.

**As a verifier,** I want to fetch a chitt's policy chitt by CID from IPFS, confirm the authorizer's signature chains to a root I trust, and evaluate whether an issuance was properly authorized, so that I can assess the chitt's validity without trusting any intermediary.

**As an administrator,** I want to add or remove auditors from a running policy by updating the `auditors` field in the policy chitt, so that audit access can be adjusted without revoking and reissuing the policy.

### Requirements

#### Must-Have (P0)

**The policy chitt is a chitt.** Policy chitts are issued directly by authorizers — not through a press. The authorizer signs with their own chitt key; the administrator (or the authorizer themselves) countersigns as the holder. The policy chitt is published to IPFS; its Arbitrum One registry entry is created at issuance and its append-only log tracks all subsequent updates.

**Protocol-defined fields of a policy chitt:**

| Field | Type | Required | Default update policy |
|---|---|---|---|
| `field_definitions` | `field-definition-array` | Yes | `{ "is_issuer": true }` |
| `recipient_predicate` | `chitt-predicate` | No | `{ "is_issuer": true }` |
| `requester_predicate` | `chitt-predicate` | No | `{ "is_issuer": true }` |
| `auditors` | `chitt-pointer-array` | No | `{ "is_holder": true }` |
| `approved_presses` | `chitt-pointer-array` | No | `{ "is_holder": true }` |
| `valid_until` | `timestamp` | No | `{ "is_issuer": true }` |
| `allow_open_offers` | `boolean` | No | `{ "is_issuer": true }` |
| `revocation_permissions` | structured object | No | `{ "is_issuer": true }` |
| `notes` | `append-only-array` of `text` | No | `{ "is_holder": true }` |
| `policy_creation` | `policy-creation-constraint` | No | `{ "is_issuer": true }` |

These are the standardized fields all verifiers know to look for. Their update policies above are defaults; the authorizer may override them at issuance. For example, requiring both holder and issuer to co-sign auditor changes: `{ "all_of": [{ "is_holder": true }, { "is_issuer": true }] }`.

**`field_definitions`** is an array of field definition objects describing the fields of chitts issued under this policy. Each object:

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

Example — a student chitt policy with three fields:

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
    { "chitt_field_matches": {
        "template": "<school-staff-policy-id>",
        "field": "role",
        "regex": "^administrator$"
    }}
  ]
}
```

**`auditors`** is a `chitt-pointer-array`. Each auditor chitt's current public key (resolved via mutable pointer) is used by the press to encrypt a copy of each issuance log entry via ML-KEM (FIPS 203). If an auditor chitt is revoked, the press stops encrypting new entries for that auditor; their existing entries remain. Multiple auditors each receive their own independently-encrypted copy of each entry.

**`approved_presses`** is a `chitt-pointer-array` listing the mutable pointers of press sub-chitts authorized to issue under this policy. A press whose sub-chitt pointer does not appear here must not be accepted by the smart contract.

**`allow_open_offers`** is a boolean flag that, when `true`, permits issuers to create open chitt offers under this policy — pre-signed batch authorizations that any bearer may claim up to a stated limit or expiry window, without individual issuer review at claim time. When absent or `false`, only targeted issuance (press-initiated, addressed to a specific recipient) is permitted. See §2 for the open offer issuance flow.

**`revocation_permissions`** defines who may publish revocation entries (8xx and 9xx codes) to chitts issued under this policy. Non-revocation updates (1xx–7xx) are governed by the relevant field's `update_policy`, not by `revocation_permissions`.

```json
"revocation_permissions": {
  "8xx": { "any_of": [{ "is_holder": true }, { "is_issuer": true }] },
  "9xx": { "is_issuer": true }
}
```

If absent, the default is: 8xx by holder or issuer; 9xx by issuer only.

**The `policy_creation` field.** A policy chitt may include a `policy_creation` field that constrains the policies which holders of chitts issued under this policy are permitted to create. This is an opt-in governance mechanism: without it, holders are unconstrained in what policies they create. With it, any new policy created by such a holder must satisfy the stated restrictions.

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

**The policy creation chain walk.** When evaluating whether a holder is permitted to create a given policy, walkers traverse an alternating chain of chitts and policies:

1. Start with the **holder's chitt** (the administrator who is creating the new policy).
2. Resolve that chitt's **policy chitt**. Collect any `policy_creation` restrictions.
3. Resolve that policy chitt's **holder** (the administrator who holds the policy chitt). Find that holder's own chitt.
4. Resolve that chitt's **policy chitt**. Collect any `policy_creation` restrictions.
5. Continue alternating (holder's chitt → its policy → that policy's holder → their chitt → ...) until reaching a chitt with no further policy, or a trusted root.

Constraints collected at each step accumulate: the proposed policy must satisfy **all** restrictions from all policies encountered in the walk. Restrictions can only narrow permissible field definitions, never expand them — a policy higher in the chain cannot grant permission that a lower policy has already forbidden.

This walk is independent of the standard chain walk used for chitt issuance. It traverses the **holder lineage** of policies, not the issuance authorization chain. The distinction matters: a constraint at the "NYT internship program" policy level applies to policies created by coordinators — it does not affect chitts that coordinators receive from unrelated organizations.

**Important scoping rule:** `policy_creation` constraints do **not** propagate to sub-chitts or to chitts that holders receive from other chains. They constrain only what the holder can actively create. If an NYT intern holds credentials from other organizations, those organizations' constraints are irrelevant to policies the intern creates; only the restrictions from the intern's NYT-lineage policy chain apply.

**Enforcement note on regex subsumption.** Exactly verifying that one regex is "at least as restrictive" as another is computationally hard in the general case. The press performs a conservative best-effort check (e.g., literal string matching for simple enumerations). Definitive enforcement happens at chitt issuance time: when chitts are issued under the policy, field values are checked against the policy's regex directly — if the policy's regex would allow a value that the ancestor's `policy_creation` constraint forbids, the issuance fails. Press reputation is at stake if it accepts non-compliant policies; independent verifiers can re-check compliance post-hoc.

**Press authorization.** The policy chitt holder authorizes presses by issuing a **press sub-chitt** — a sub-chitt of the policy chitt — to each press operator. The press operator countersigns, explicitly accepting authorization and responsibility. The press sub-chitt's mutable pointer is added to `approved_presses`. Revoking a press sub-chitt removes the press's ability to issue under this policy; previously-issued chitts are unaffected (they pre-date the revocation's effective date).

**Policy creation flow:**
1. The drafter assembles the policy JSON.
2. The drafter submits the proposed policy to the authorizer out of band.
3. The authorizer reviews and, if approved, issues the policy chitt to the administrator (the holder). The policy JSON is the chitt's IPFS content.
4. The policy chitt is published to IPFS. Its Arbitrum One registry entry is created.
5. The administrator registers one or more presses by issuing press sub-chitts and adding their pointers to `approved_presses`.
6. The policy is live. The press begins accepting issuance requests.

**Acceptance criteria:**
- [ ] A policy chitt without a `field_definitions` field is rejected by the press at policy load time.
- [ ] A policy chitt whose `valid_until` has passed is rejected by the press at policy load time.
- [ ] A verifier who fetches the policy chitt by CID can confirm the authorizer's signature and walk the chain to a trusted root without contacting the authorizer.
- [ ] Updating a policy field with a signature that does not satisfy the field's `update_policy` is rejected by verifiers as invalid.
- [ ] A press sub-chitt whose mutable pointer does not appear in `approved_presses` is rejected by the Arbitrum One registry contract.

#### Nice-to-Have (P1)

- A CLI tool that validates a policy JSON against the protocol schema before submission.
- A human-readable policy summary auto-generated alongside the JSON for authorizer review.
- A standard policy template library for common use cases (employee credentials, community membership, event attendance).

#### Future Considerations (P2)

- Visual policy builder UI.
- Policy composition: a policy that references another policy's predicates by pointer rather than embedding them.
- Trusted Execution Environment (TEE) hardening for high-stakes policies: an optional path where the press is additionally attested via hardware enclave, providing stronger enforcement of rate limits and revocation freshness timing.

### Open Questions

- **[Engineering — RESOLVED]** Canonical serialization format: canonical CBOR per RFC 8949 §4.2, JSON input surface per RFC 8949 §6.1, with protocol-specific overrides for binary fields (base64url → CBOR byte string) and timestamps (ISO 8601 → CBOR Tag 1 uint). See Appendix A and ARCHITECTURE.md ADR-010.
- **[Engineering]** How are field definition changes (adding a new field to an existing policy) handled for chitts already issued under the old schema? Are those chitts now non-conforming, or do they remain valid?

---

## 2. Pressing Chitts and Updating Logs

### Problem Statement

Once a policy chitt is live and a press is authorized, the press must accept issuance requests, verify they satisfy the policy's predicates, produce signed chitt offers, log each issuance in an auditor-encrypted record, and update the Arbitrum One registry. The smart contract enforces that only authorized presses can write to the registry; the press enforces policy compliance; verifiers can confirm both independently after the fact.

### Goals

- Allow an authorized press to issue chitts without requiring hardware attestation or a trusted execution environment.
- Make all policy compliance checks independently verifiable by any observer post-issuance.
- Ensure the issuance log is readable by auditors and opaque to everyone else, including the press operator.
- Prevent spam writes to the registry by requiring a valid press sub-chitt key for all registry operations.

### Non-Goals

- **Not:** Cryptographic enforcement of rate limits. Rate limits stated in a policy are a social and legal commitment enforced by the press; they are auditable by the policy authorizer (who holds the audit key) but not verifiable by outside parties without the audit key.
- **Not:** Guaranteeing delivery of chitt offers. Delivery is best-effort via invitation link or Nym.
- **Not:** Hardware attestation in v1. This is a future consideration for high-stakes policies.

### User Stories

**As a press operator,** I want to accept an issuance request, verify the requester's and recipient's chains against the policy predicates, sign the offer with my press sub-chitt key, and log the issuance encrypted to each auditor, so that the issuance is policy-compliant and auditable.

**As an administrator,** I want the press to post the completed chitt to IPFS and register it on Arbitrum One, so that the chitt's mutable pointer is stable and independently resolvable by anyone.

**As an auditor,** I want to decrypt my copy of each log entry using my chitt's private key, so that I can review the full issuance history for this policy without the press operator or any other party being able to read it.

**As any verifier,** I want to confirm post-hoc that an issued chitt's content conforms to the policy schema, that the press sub-chitt that signed it is listed in `approved_presses`, and that the recipient's chain satisfied the recipient predicate, so that I can assess validity without trusting the press.

**As an issuer,** I want to create an open chitt offer and distribute it as a link, so that up to N recipients can claim a chitt under my policy without requiring me to be online for each individual acceptance.

### Requirements

#### Must-Have (P0)

**Policy registration check.** Before a press begins operating under a new policy, it performs a one-time pre-flight check to confirm the policy itself was authorized to exist. The press:

1. Resolves the **policy chitt's holder** (the administrator who holds it).
2. Walks the policy creation chain: holder's chitt → its policy → that policy's holder → their chitt → ..., collecting all `policy_creation` field restrictions encountered along the way.
3. Confirms that the new policy's `field_definitions` satisfy all accumulated restrictions: required fields are present, prohibited fields are absent, and text field regexes are at least as restrictive as the inherited constraint (best-effort check).
4. If any restriction is violated, the press refuses to register under the policy and reports the violation to the administrator.

This check does not prevent issuance from proceeding if the press is already registered — it is a gate applied when the press first loads a policy. Re-running it when the policy chitt or any ancestor is updated is recommended.

**Smart contract enforcement.** The Arbitrum One registry contract enforces a single rule: writes to the registry must be signed by a key that is registered as an active press sub-chitt for the relevant policy. Specifically:

- Creating a new chitt registry entry requires a signature from a key registered as a press sub-chitt whose mutable pointer appears in the policy chitt's `approved_presses`.
- The contract verifies this by checking the press sub-chitt's own registry entry (which is on-chain) and confirming it is not revoked.
- Updating an existing chitt registry entry (posting a new log head) requires a signature from the press key (for press-initiated updates) or from a key that has been explicitly granted write authority for that entry via a prior on-chain grant.
- The contract does **not** evaluate predicate expressions, walk chains, or fetch IPFS content. Semantic compliance is verified post-hoc by observers.

**Issuance flow.**

1. A request arrives at the press — from the administrator (targeted mode), directly from the requester (open mode), or from the recipient (requested mode), as specified by the policy.
2. The press resolves the requester's chitt chain and evaluates `requester_predicate`. If absent, this step passes automatically.
3. The press resolves the recipient's chitt chain and evaluates `recipient_predicate`. If absent, this step passes automatically.
4. For each chitt in both chains, the press checks for revocation entries. For each revocation found, the press confirms the effective date is after the current time (i.e., the chitt was valid when evaluated). If any ancestor is revoked with an effective date at or before now, the press refuses to issue.
5. The press assembles the proposed chitt JSON: all protocol-required fields populated (with `recipient_pubkey` left empty), and all `field_definitions` fields populated per the policy.
6. The press signs the canonical serialization of the proposed chitt JSON with its press sub-chitt key, producing the **signed offer**. This signature attests that this press verified policy compliance and generated this offer.
7. The offer is delivered to the recipient: as an invitation link (base64 payload in a URL, e.g., `chitt://invite?o=<base64>`) for first-time recipients, or via Nym to an existing chitt gateway.
8. The recipient reviews the offer (see §4), generates a keypair, adds their public key, and countersigns the completed chitt.
9. The completed chitt — containing both the press's offer signature and the recipient's countersignature — is posted to IPFS. Either the recipient's client or the press may perform this posting.
10. The press creates a registry entry on Arbitrum One for the new chitt, with the initial log head CID, signed with its press sub-chitt key.
11. The press constructs an issuance log entry containing the new chitt's CID, encrypted separately to each auditor chitt's current public key via ML-KEM (FIPS 203). The press operator cannot read these entries.
12. The press appends the log entry to the policy chitt's IPFS log and updates the policy chitt's Arbitrum One registry entry to point to the new log head.
13. The press produces a **Signed Chitt Inclusion Proof (SCIP)**: a small signed object binding the new chitt's CID to its log entry index and the log root at time of inclusion. The SCIP is signed with the press's sub-chitt key.
14. The press sends the SCIP and a confirmation to the recipient, and an audit record (chitt CID + SCIP) to the administrator, both encrypted to their respective chitts via Nym.

**Open chitt offer document structure.** An open chitt offer is a signed JSON document created by an issuer (not a press) and hosted on a wallet service. It serves as a pre-signed batch authorization: any recipient who countersigns and submits to the named press is authorized to receive a chitt, subject to the stated constraints. The policy chitt must have `allow_open_offers: true` for the press to accept submissions under an open offer.

```json
{
  "offer_type": "open",
  "policy_id": "<CID of the policy chitt>",
  "press_chitt": "<mutable pointer of the approved press to submit to>",
  "issuer_chitt": "<mutable pointer of the issuer's chitt>",
  "max_acceptances": <integer | null>,
  "expires_at": "<ISO 8601 timestamp | null>",
  "display_message": "<optional human-readable context for the recipient>",
  "redirect_url": "<URL to redirect recipient to after successful issuance>",
  "proposed_fields": { "<issuer-populated field values for chitts issued under this offer>" },
  "issuer_signature": "<ML-DSA-44 signature over the canonical serialization of all above fields>"
}
```

`max_acceptances` and `expires_at` may each be null (unconstrained), but an offer with both null is valid only if the policy constrains issuance in some other way. An open chitt offer with no constraints whatsoever requires explicit acknowledgment from the issuer at creation time. The `offer_id` used for on-chain counter tracking is `hash(canonical CBOR of the complete open chitt offer document including `issuer_signature`)`. This binds the offer ID to the issuer's key, making it unforgeable and unique per issuance.

**Open offer issuance flow.**

1. The issuer assembles the open chitt offer JSON, populates `proposed_fields` with all issuer-defined field values, signs the canonical serialization with their chitt key, and submits the signed offer to a wallet service.
2. The wallet service stores the offer and generates a claim link (`chitt://claim?o=<base64>` or a wallet-service-hosted URL) for distribution.
3. The issuer distributes the claim link via any channel (private message, QR code, email, etc.). The security of the resulting chitts is bounded by the channel's trustworthiness.
4. A recipient follows the claim link. The wallet service presents an offer review screen: issuer identity and chain summary, proposed field values, acceptance constraints (slots remaining if `max_acceptances` is set, expiry if `expires_at` is set), and the redirect destination URL.
5. The recipient's client verifies the issuer's chitt chain to a trusted root and confirms the named press sub-chitt appears in the policy's `approved_presses`. If either check fails, the offer is rejected before display.
6. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this chitt, stores the private key in the keyring, and assembles an **open offer claim payload**: `{ "offer": <verbatim OpenChittOffer document>, "recipient_pubkey": <new public key> }`. The client signs the canonical CBOR of this claim payload with the new private key, producing a `recipient_signature`.
7. The wallet service submits an **OpenOfferClaimSubmission** to the approved press via HTTPS POST: `{ "claim_payload": { "offer": ..., "recipient_pubkey": ... }, "recipient_signature": ... }`. See `protocol-objects.md` §7 for the full schema.
8. The press validates: (a) the issuer's signature over the offer document is valid; (b) the press's own sub-chitt is listed in `approved_presses`; (c) the policy chitt has `allow_open_offers: true`; (d) on-chain open offer constraints are not violated (see below). If validation fails at any step, the press rejects with a specific error code.
9. The press signs the per-recipient chitt with its press sub-chitt key (producing `offer_signature`), submits an atomic on-chain transaction registering the chitt and incrementing the open offer counter, then posts the completed chitt to IPFS.
10. The press confirms completion to the wallet service. The wallet service updates the recipient's keyring to include the new chitt address and presents a confirmation screen, then redirects the recipient to `redirect_url` (displaying the destination URL to the recipient first).
11. An issuance log entry is encrypted to each auditor and appended to the policy chitt's IPFS log, as in the targeted issuance flow. A courtesy notification is sent to the issuer via HTTPS (or Nym if the issuer has configured a Nym gateway).

**Open offer smart contract enforcement.** For chitts submitted under an open chitt offer, the Arbitrum One registry contract performs additional inline validation. No separate registration transaction is required; the counter is lazily initialized on first use.

The press includes the following fields in calldata alongside the standard chitt registration payload: `offer_id` (the hash of the canonical offer document), `max_acceptances`, `expires_at`, and `issuer_signature` (the issuer's ML-DSA-44 signature over the canonical offer payload, which commits to `max_acceptances` and `expires_at`).

The contract executes the following checks atomically with the chitt registration:

1. Verifies the issuer's ML-DSA-44 signature over the offer payload (confirms `max_acceptances` and `expires_at` were set by the issuer and have not been tampered with).
2. Confirms `block.timestamp < expires_at` (skipped if `expires_at` is null).
3. Looks up `openOfferUseCounts[offer_id]` and confirms the current count is less than `max_acceptances` (skipped if `max_acceptances` is null).
4. Atomically increments `openOfferUseCounts[offer_id]` and registers the chitt.

If any check fails, the transaction reverts and the chitt is not registered. The press surfaces a specific rejection reason to the wallet service (offer full, offer expired, or signature invalid). A recipient who loses the race to the last acceptance slot receives a clear error rather than a spinner timeout.

**Key separation.** The policy authorizer's chitt key and any auditor's chitt key must be separate from each other. A compromised auditor key must not grant policy control.

**Acceptance criteria:**

- [ ] A press whose sub-chitt pointer does not appear in `approved_presses` cannot write to the Arbitrum One registry.
- [ ] A press whose sub-chitt is revoked with an effective date at or before now cannot write to the Arbitrum One registry.
- [ ] A completed chitt contains both the press's offer signature and the recipient's countersignature; any verifier can confirm both independently without contacting the press.
- [ ] Each auditor receives an independently-encrypted copy of each log entry decryptable only with their chitt's private key.
- [ ] A post-hoc verifier can confirm: (a) the chitt's content conforms to the policy's `field_definitions`, (b) the press sub-chitt that signed it appears in `approved_presses`, and (c) the recipient's chain satisfies `recipient_predicate` if one is specified.
- [ ] The SCIP is delivered to recipient and administrator within one Nym round-trip of the chitt being posted.
- [ ] A press refuses to accept an open chitt offer submission when the policy chitt does not have `allow_open_offers: true`.
- [ ] A press refuses to accept an open chitt offer submission when the issuer's signature over the offer document does not verify.
- [ ] An on-chain transaction submitting a chitt under an open offer whose `max_acceptances` has been reached is reverted by the registry contract.
- [ ] An on-chain transaction submitting a chitt under an open offer whose `expires_at` has passed is reverted by the registry contract.
- [ ] Two concurrent submissions racing for the last open offer slot result in exactly one accepted chitt and one clean rejection, with no double-issuance.
- [ ] The open offer counter is lazily initialized on first use; no pre-registration transaction is required.

#### Nice-to-Have (P1)

- Batched registry writes: multiple log updates anchored in a single Arbitrum One transaction to reduce gas costs during high-volume periods.
- Press health endpoint exposing operational metrics (issuance count, log head freshness, uptime) without exposing chitt content.
- Reference docker-compose stack for self-hosted press deployment.
- Paymaster integration: the press sponsors gas for recipient-initiated registry writes (e.g., self-revocations) so recipients never need to hold ETH.

#### Future Considerations (P2)

- Trusted Execution Environment (TEE) hardening for high-stakes policies: optional hardware attestation proving the press is running unmodified open-source code.
- Multi-tenant press: one press service managing sub-chitts for multiple policies simultaneously.
- Cross-press portability: a recipient can migrate their chitt from one press to another without reissuance.
- Open offer waitlist: when an open offer is full, the wallet service optionally collects waitlist registrations and notifies the issuer, who may create a follow-on offer.

### Open Questions

- **[Engineering]** What is the minimum IPFS replication count for the policy chitt's log before the Arbitrum One registry pointer update is considered safe?
- **[Engineering]** For recipient-initiated registry writes (e.g., self-revocation), should the press always mediate, or should the protocol support direct writes from the holder using a paymaster?
- **[Engineering]** Is a transparency log of approved press implementations operated by the protocol foundation or a decentralized committee? (Relevant if TEE attestation is added in P2.)

---

## 3. Setting Up a Keychain and Backup Options

### Problem Statement

A chitt holder's private keys are the root of their identity in the protocol. Loss of these keys means loss of access to all chitts and any services authenticated with them. At the same time, keys that are too easy to recover are vulnerable to theft. The system must support a practical recovery path that is independent of any single service while resisting unauthorized recovery.

### Goals

- Provide a default key management model that is secure, recoverable, and does not require users to manage raw seed phrases.
- Ensure master chitt keys are never used for routine operations — sub-chitt keys handle day-to-day signing.
- Make recovery fully independent of the primary service.
- Resist unauthorized recovery attempts with a time-windowed cancellation mechanism.

### Non-Goals

- **Not:** Supporting seed-phrase-based key management as a first-class option.
- **Not:** Social recovery via guardian quorum in v1.
- **Not:** Automatic key rotation. Rotation is a deliberate operation triggered by the holder.

### User Stories

**As a new chitt holder,** I want my client to create a keyring, generate a master keypair for my first chitt, and store the private key encrypted with my passkey, so that I do not need to manage raw key material.

**As a holder with multiple devices,** I want device-specific sub-chitt keys stored in secure device storage, so that my master key stays cold while I sign routine operations from any device.

**As a holder,** I want a YubiKey-based backup so that if my primary service is unavailable I can recover my full keyring independently.

**As a holder who suspects their YubiKey has been stolen,** I want a 72-hour cancellation window with multi-channel notifications, so that I can abort an unauthorized recovery before it completes.

### Requirements

#### Must-Have (P0)

**Keyring structure.** The keyring is an append-only encrypted blob stored on IPFS. It holds the master private key for each chitt the holder controls, the private keys for any sub-chitts registered to those master chitts, and metadata associating each key with its corresponding chitt mutable pointer. The keyring is encrypted with a key derived from `passkey + service_secret`. The primary service holds `service_secret` but never sees plaintext keys or the decryption key. Because the keyring is append-only, new keys are added without destroying prior entries.

**Sub-chitt keys.** Sub-chitt private keys are held in secure device storage (Secure Enclave on Apple devices, TPM on others). All routine signing operations use sub-chitt keys. The master chitt key is accessed only for: creating new sub-chitts, performing key rotations, and other high-stakes operations. Sub-chitts are registered to their master chitt: the master key signs each sub-chitt registration, making the link verifiable.

**YubiKey backup registration.** The holder registers with one or more backup services, presenting their YubiKey. The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The backup service never sees the decryption key in plaintext. The backup service returns a chitt (proof of registration) and records the holder's notification channels and cancellation credentials.

**Recovery flow.**
1. Holder presents their YubiKey to a backup service.
2. Backup service simultaneously sends notifications to all configured channels (Nym gateway, email, SMS, secondary contacts).
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
- [ ] After recovery, the holder can register sub-chitts for new devices and deregister potentially-compromised ones.

#### Nice-to-Have (P1)

- Multiple YubiKey backup registrations (primary + spare).
- Configurable notification window duration for high-value use cases (e.g., 7 days).
- On-chain sub-chitt deregistration wizard exposed in the client after recovery.

#### Future Considerations (P2)

- Guardian-quorum social recovery (M-of-N trusted parties initiate time-windowed key rotation).

### Open Questions

- **[Design]** What is the recovery UX when the holder has both a lost primary service and a lost YubiKey? Out of scope for v1?
- **[Engineering]** How are sub-chitt deregistrations for compromised devices handled when the holder has only recovery access and no active device sub-chitt?

---

## 4. Receiving a Chitt as a User

### Problem Statement

A chitt recipient — whether a first-time participant or an existing holder — must be able to review an issuance offer, verify it was produced by an authorized press operating under a valid policy, generate their own keypair, countersign, and establish ownership of the resulting chitt — all without trusting the press.

### Goals

- Guide first-time recipients through keychain setup and offer acceptance in a single flow.
- Enable existing holders to receive additional chitts without repeating onboarding.
- Ensure the mutual-signing pattern: the press commits to content before the recipient; the recipient accepts by countersigning.
- Make the completed chitt independently verifiable by any party without trust in the press.

### Non-Goals

- **Not:** Automatic offer acceptance. Every offer requires explicit recipient review.
- **Not:** Accepting offers from a press whose sub-chitt is not in `approved_presses` or whose chain cannot be verified.

### User Stories

**As a first-time recipient,** I want to open an invitation link, set up my keychain, review the offer, and countersign, so that I own the resulting chitt immediately and can use it without understanding IPFS or Arbitrum.

**As an existing holder receiving an offer via Nym,** I want to review who is offering the chitt and what it contains, generate a fresh keypair, countersign, and have my client post the result, so that I hold a new credential under my existing identity.

**As a first-time recipient following a claim link,** I want to set up my keychain, review the open chitt offer's constraints and issuer identity, and countersign, so that I receive the chitt without the issuer needing to be online or approve my specific request.

**As a recipient reviewing an offer,** I want to see who issued it, what chain they trace to, what the chitt contains, and what countersigning commits me to, so that I can make an informed decision.

### Requirements

#### Must-Have (P0)

**First-time recipient flow (invitation link).**
1. The administrator or press assembles the proposed chitt JSON with all issuer-populated fields and `recipient_pubkey` left empty.
2. The press verifies requester and recipient predicates (if present), checks chain revocation, then signs the proposed chitt JSON with its press sub-chitt key — producing the **signed offer**.
3. The offer is encoded as `chitt://invite?o=<base64>` and delivered out of band.
4. The recipient opens the link. If no keychain exists, the client presents the keychain setup flow (§3) before proceeding.
5. The client decodes the offer and walks the press sub-chitt's chain to a trusted root. If the chain fails verification, the offer is rejected before being shown to the user.
6. The client presents a review screen: issuer identity (chain summary), chitt content and field values, the policy and schema governing it, and what countersigning commits the recipient to.
7. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this chitt, stores the private key in the keyring, adds the public key to the chitt JSON, and signs the canonical serialization with the new private key.
8. The completed chitt — containing the press's offer signature, the recipient's public key, and the recipient's countersignature — is posted to IPFS. Either the recipient's client or the press may post it.
9. The press creates the chitt's registry entry on Arbitrum One and logs the issuance.
10. The press delivers the SCIP and confirmation to the recipient via Nym.

**Existing recipient flow (Nym delivery).** Steps 1–2 as above. The press sends the signed offer to the recipient's existing chitt Nym gateway. Steps 4–10 as above, omitting keychain setup.

**Open chitt offer receipt flow.**

1. The recipient follows a claim link to the wallet service hosting the open chitt offer.
2. The wallet service presents an offer review screen: issuer identity and chain summary, proposed field values, acceptance constraints (slots remaining if `max_acceptances` is set, expiry if `expires_at` is set), and the redirect destination URL.
3. If no keychain exists, the client presents the keychain setup flow (§3) before proceeding. For first-time recipients, keypair generation and keyring initialization occur in-browser before countersigning.
4. The client verifies the issuer's chitt chain to a trusted root and confirms the named press sub-chitt appears in the policy's `approved_presses`. If either check fails, the offer is rejected before display.
5. If the recipient accepts: the client generates a fresh ML-DSA-44 keypair for this chitt, stores the private key in the keyring, and countersigns the canonical serialization of the open chitt offer document (with the recipient's public key included in the signed payload).
6. The wallet service submits the countersigned offer to the approved press via HTTPS. The press validates and issues the chitt per the open offer issuance flow in §2.
7. The press confirms completion to the wallet service. The wallet service updates the recipient's keyring to include the new chitt address and presents a confirmation screen.
8. The wallet service redirects the recipient to the `redirect_url` specified in the offer, displaying the destination to the recipient before navigating and warning against known phishing domains.

**Offer review requirements.**
- The client must verify the press sub-chitt chain before displaying the offer.
- The review screen must show: the press's identity and chain, the full field values from the offer, the policy chitt's mutable pointer and `valid_until` if set.
- If the policy chitt or any ancestor is revoked with an effective date at or before the current time, the offer is rejected with a reason shown to the user.

**Acceptance criteria:**
- [ ] A first-time recipient can complete the full flow (keychain setup through SCIP receipt) without prior knowledge of IPFS or Arbitrum.
- [ ] A completed chitt is verifiable by any third party with access to IPFS and the Arbitrum One registry, without contacting the issuer or recipient.
- [ ] An offer from a press whose sub-chitt cannot be verified to a trusted root is rejected before being shown to the user.
- [ ] The recipient's private key is stored in the keyring before countersigning, so it is recoverable via the YubiKey backup flow.
- [ ] A first-time recipient can complete the open chitt offer receipt flow (keychain setup through confirmation) without prior knowledge of IPFS or Arbitrum.
- [ ] The wallet service displays the `redirect_url` to the recipient before navigating away.
- [ ] An open chitt offer whose issuer chain cannot be verified to a trusted root is rejected before display.
- [ ] A recipient who attempts to claim a full or expired open offer receives a clear rejection with a reason, not a timeout.

#### Nice-to-Have (P1)

- QR code encoding of claim links for desktop-to-mobile handoff.
- Offer expiry: press sets an expiry on the offer; client rejects expired offers.
- "Why am I eligible for this?" — human-readable explanation pulled from the policy's `description` field.
- Named progress states during open offer claim ("Generating your keys", "Sending to press", "Finalizing") rather than a blank spinner.

#### Future Considerations (P2)

- Recipient-initiated issuance: the recipient requests a targeted chitt from a press without a prior invitation or open offer.
- Open offer provenance metadata: a structured field on issued chitts recording the distribution channel type (private link, public QR code, etc.) to help relying parties calibrate trust appropriately.

### Open Questions

- **[Design]** What is the UX when a recipient declines an offer? Should a decline notification be sent to the press?
- **[Engineering]** How long should unsigned offers be retained by the press before expiring?

---

## 5. Updating Chitts

### Problem Statement

After issuance, authorized parties need to record changes to a chitt — from positive endorsements to field edits to revocations. The full range of update types is codified in the 1xx–9xx code system. Authority is field-granular: different parties may update different fields, and revocation rights are separately controlled by `revocation_permissions`. The append-only log preserves full history; nothing is silently removed. Holders are notified of updates by default so they remain aware of their credential's state.

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
- **Not:** Retroactive removal of prior log entries (except `erasable: true` chitts, opt-in at issuance).
- **Not:** Special direct-write paths for any code range. All updates, including self-revocations, go through an approved press. Resilience against press downtime is achieved by listing multiple approved presses in `approved_presses`.

### User Stories

**As an administrator with update authority,** I want to submit a 2xx update intent to add a positive annotation to a student's chitt, so that verifiers see an official endorsement on the credential.

**As an administrator,** I want to submit an 800 revocation intent to a press for a chitt whose holder departed the organization, so that future authentications are rejected while historical signatures remain valid.

**As a holder,** I want to submit an 810 self-revocation intent to any approved press for my policy, so that my compromised signing key is invalidated without requiring the issuer's involvement.

**As a verifier,** I want to fetch the current log head, walk back to the original issuance, and confirm each entry's authorization against the policy's field definitions and `revocation_permissions` — including confirming the updater's chitt satisfies the relevant predicate — so that I can determine the chitt's current state without trusting the press.

**As a holder,** I want to receive a Nym notification whenever my chitt is updated by a third party, optionally including a message from the updater, so that I am not surprised by changes to my credential.

### Requirements

#### Must-Have (P0)

**Update entry structure.** Each log entry is a signed JSON object assembled by the press from the updater's signed intent:

```json
{
  "version": <monotonically increasing integer>,
  "code": <integer 100–999>,
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
    "signer_chitt": "<mutable pointer in registry of updater's chitt>",
    "public_key": "<ML-DSA-44 public key>",
    "signature": "<ML-DSA-44 sig over canonical serialization of the update intent payload>"
  },
  "press_signature": {
    "signer_chitt": "<mutable pointer in registry of press sub-chitt>",
    "public_key": "<ML-DSA-44 public key>",
    "signature": "<ML-DSA-44 sig over canonical serialization of the complete entry>"
  }
}
```

`field_updates` is present for codes 1xx–7xx. `revocation` is present for codes 8xx–9xx. The two are mutually exclusive. `notify_holder` defaults to `true`; the updater may set it to `false` in the intent. The policy may suppress notification for specific code prefixes (see below).

**The update intent payload** is what the updater signs before submitting to the press:

```json
{
  "target_chitt": "<mutable pointer of the chitt being updated>",
  "updater_chitt": "<mutable pointer of the updater's chitt>",
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

1. The updater assembles the update intent, signs it with their chitt key, and sends the signed intent to any press listed in `approved_presses` for the chitt's policy — via Nym preferably, HTTPS as fallback. The client discovers available presses from `approved_presses` on the policy chitt.
2. The press fetches the chitt's current log head from IPFS and confirms the on-chain registry pointer matches.
3. The press validates the intent:
   - Intent signature is cryptographically valid.
   - Updater's chitt is not revoked (effective date check against current time).
   - For codes 1xx–7xx: the updater's chitt satisfies the `update_policy` predicate for each field in `field_updates`. If multiple fields are updated in one entry, all `update_policy` predicates must be satisfied by the same updater.
   - For codes 8xx–9xx: the updater's chitt satisfies the `revocation_permissions` predicate for the code range. If `revocation_permissions` is absent from the policy, the default is: 8xx by holder or issuer; 9xx by issuer only.
   - No fields in `field_updates` are protocol-required immutable fields.
   - The code range is consistent with the entry content (8xx–9xx entries must include `revocation`; 1xx–7xx entries must include `field_updates`).
   - If any check fails, the press rejects the intent with a specific error code and does not post.
4. The press assembles the complete entry: intent payload verbatim + `version` (current head version + 1) + `prev_log_root` (current head CID). The press signs the complete entry with its press sub-chitt key, producing `press_signature`.
5. The press posts the new log entry to IPFS and updates the on-chain registry pointer for the chitt with its press sub-chitt key.
6. If `notify_holder` is `true` and the policy does not suppress notification for this code prefix: the press sends a Nym notification to the holder's registered Nym gateway containing the update code, the `updater_message` if present, and the CID of the new log entry. If the holder has no registered Nym gateway, the notification is silently dropped.
7. The press confirms success to the updater (via Nym or HTTPS, matching the submission channel).

**Presses as neutral infrastructure.** Approved presses are community infrastructure: they hold a funded Arbitrum One wallet, maintain a reputation for policy compliance, and receive update submissions. Any press listed in `approved_presses` may process any update for a chitt governed by that policy. The press does not exercise independent judgment about whether an update is desirable — it validates predicates mechanically and posts if valid. This means issuers should list multiple presses in `approved_presses` to ensure availability; the likelihood that all listed presses are simultaneously unreachable is the practical bound on update resilience.

**Holder notification suppression.** A policy may declare code prefixes for which holder notification is always suppressed, regardless of the `notify_holder` field in the intent:

```json
"suppress_notification_for_codes": [5]
```

This suppresses notification for all 5xx entries (programmatic updates). The updater may also suppress notification per-intent by setting `notify_holder: false`. If either the policy suppression or the per-intent flag suppresses notification, no notification is sent. For adversarial scenarios — such as a 9xx revocation where tipping off the holder would be harmful — the issuer should configure the policy accordingly or set `notify_holder: false` in the intent.

**Field update authorization.** For each field in `field_updates`, the updater's chitt chain must satisfy that field's `update_policy` in the policy's `field_definitions`. If a field has no `update_policy` specified, the policy's default applies; if no default is specified, only the issuer may update.

**Revocation semantics.**
- The `effective_date` in a revocation entry may be earlier than the posting date. The updater is asserting when the relevant condition began.
- If multiple revocation entries exist on a chitt, the one with the earliest effective date governs.
- The append-only log cannot remove a revocation entry. Un-revocation requires a successor chitt (see Background Concepts).

**History erasure.** If the policy specifies `erasable: true` for a chitt, a revocation entry with `erasure: true` may redact prior log entries, leaving only the revocation statement. Cached copies held by others become unauthenticatable. Chitts without `erasable: true` may be revoked but not erased.

**On-chain anchoring.** After each update, the Arbitrum One registry entry for the chitt is updated to point to the new log head CID, providing a trusted timestamp and rollback resistance. Only the press sub-chitt key is required for this write; the contract verifies the press is in `approved_presses` for the policy.

**Acceptance criteria:**
- [ ] An update intent whose updater does not satisfy the relevant field's `update_policy` is rejected by the press.
- [ ] A revocation intent whose updater does not satisfy `revocation_permissions` for the given code range is rejected by the press.
- [ ] An 810 intent signed by the holder (satisfying `is_holder`) is accepted by the press without issuer involvement.
- [ ] A verifier re-checking an update entry can independently confirm the updater's chitt satisfies the relevant `update_policy` or `revocation_permissions` predicate by evaluating the predicate against the updater's chitt chain.
- [ ] An erasure update on a chitt whose policy does not have `erasable: true` is rejected by the press.
- [ ] The monotonic version number and `prev_log_root` chain prevent replay and out-of-order posting of stale entries.
- [ ] A verifier can reconstruct the full current state of a chitt by reading the append-only log from the first entry to the current head.
- [ ] The press sends a Nym notification to the holder after posting any update where `notify_holder` is true and the code prefix is not suppressed by the policy.
- [ ] A concurrent update submission that arrives after a conflicting entry has already been posted is rejected by the press due to a stale `prev_log_root`; the submitter receives a clear error and can resubmit against the new head.

#### Nice-to-Have (P1)

- Multi-party update approval: a field's `update_policy` can require M-of-N co-signers; the press collects partial intent signatures before assembling and posting the complete entry.
- Revocation notification to services the holder has authenticated with (via Nym to stored gateway addresses from prior auth sessions).
- Per-press submission receipts: the press returns a signed acknowledgment of the intent before posting, so the updater has proof of submission independent of the on-chain write.

#### Future Considerations (P2)

- Cascading revocation: revoking a policy chitt triggers batch revocation intents on all chitts issued under it (per `revocation_cascade` setting in the policy).
- Update dispute: the holder can publish a counter-statement (a 4xx annotation) to a contested annotation or revocation, visible to verifiers alongside the original entry.

### Open Questions

- **[Engineering]** How does the client efficiently detect new log entries since its last check — polling the Arbitrum One registry pointer, or subscribing via Nym?
- **[Engineering]** When a policy's `field_definitions` are updated (a new field added), how are previously-issued chitts that lack that field treated by verifiers?

---

## 6. Signing a Message with a Chitt

### Problem Statement

Chitt holders need to sign arbitrary messages using their chitt identity. Signatures must commit to specific recipients and content, support parallel co-signers, prevent replay, and keep the master chitt key cold.

### Goals

- Produce signed message envelopes verifiable by anyone without network access.
- Commit the signature to the specific audience to prevent misquotation.
- Support parallel co-signing for multi-author statements.
- Keep the master chitt key cold during all routine signing.

### Non-Goals

- **Not:** Encrypting message content as part of the signing flow. Encryption is a separate layer.
- **Not:** Ordered sequential co-signing. All signatures in v1 are parallel and independent.

### User Stories

**As a chitt holder,** I want to compose a message, sign it with my device sub-chitt key, and send it to specified recipients, so they can verify it came from me and was addressed to them.

**As a co-author,** I want to independently sign the same message payload, with my signature added to the `signatures` array, so that verifiers can confirm both commitments.

**As a sender editing a prior message,** I want to publish a new signed envelope with an `edit_of` pointer to the prior hash, so the edit is verifiable and the original remains intact.

### Requirements

#### Must-Have (P0)

**Message envelope structure:**

```json
{
  "payload": {
    "content": "<message body>",
    "recipients": ["<mutable pointer>", "<mutable pointer>"],
    "timestamp": "<ISO 8601>",
    "in_reply_to": "<hash of prior payload — optional>",
    "edit_of": "<hash of prior payload — optional, mutually exclusive with retracts>",
    "retracts": "<hash of prior payload — optional, mutually exclusive with edit_of>"
  },
  "signatures": [
    {
      "signer_chitt": "<mutable pointer in registry of signing sub-chitt>",
      "public_key": "<ML-DSA-44 public key>",
      "signature": "<sig over canonical serialization of payload>"
    }
  ]
}
```

**Signing process.**
1. The sender assembles the payload: content, recipient mutable pointers, timestamp, and optional reply/edit/retraction fields.
2. The client canonically serializes the payload (canonical CBOR per RFC 8949 §4.2, with protocol-specific overrides for binary fields and timestamps — see Appendix A).
3. The client signs the canonical serialization using the current device's sub-chitt private key. The master key is not accessed.
4. The signature, sub-chitt registry address, and ML-DSA-44 public key are added to the `signatures` array.
5. For parallel co-signing, each additional signer independently repeats steps 3–4 and appends their entry.
6. The message ID is the hash of the canonical payload serialization. There is no separate ID field.

**Recipient binding.** The `recipients` array is part of the signed payload; modifying it invalidates all signatures. A message whose recipient list does not include the receiving chitt is valid but flagged as forwarded rather than direct.

**Edit and retraction.**
- An **edit** is a new signed envelope with `edit_of` pointing to the prior payload hash. The original is not mutated. Authorization: signers must chain to the same master chitt(s) as the original.
- A **retraction** is a new signed envelope with `retracts` pointing to the prior payload hash. No new content is proposed; the sender formally withdraws the original statement. Same authorization rules as edits.
- Successive edits form a linked list (`A → A' → A''`). Each is independently verifiable.
- `edit_of` and `retracts` are mutually exclusive.

**Acceptance criteria:**
- [ ] Any party with the signed envelope can verify the signature using the inline public key without a network call.
- [ ] Modifying any field in the payload invalidates all signatures.
- [ ] Two independent signers over the same canonical payload produce independently-verifiable signatures in the same envelope.
- [ ] An edit signed by a party who does not chain to the original signer's master chitt is flagged as unauthorized by verifiers.
- [ ] A payload with both `edit_of` and `retracts` set is rejected at the client before signing.
- [ ] The message ID (payload hash) is deterministic across clients given the same inputs.

#### Nice-to-Have (P1)

- Signer state snapshot: each signature entry includes the sub-chitt's master pointer, version CID, and log root at signing time, enabling retroactive chain-state verification.

#### Future Considerations (P2)

- Threshold signing: M of N designated parties must sign before the message is considered valid.

### Open Questions

- **[Design]** Is there a maximum size for the `recipients` array? Should broadcast messages use a different primitive?
- **[Engineering]** For edits to private (encrypted) messages: how are edits delivered to recipients who did not receive the original?

---

## 7. Validating That a Message Has Been Signed by a Chitt

### Problem Statement

A recipient or service needs to determine: whether each signature is cryptographically valid; whether the signing chitt was valid at the time of signing; whether it is currently valid; and what revocation and annotation context surrounds it. The verification process must be independently executable and must respect the distinction between historical validity and current validity.

### Goals

- Return a structured result per signature covering all four validity dimensions.
- Parallelize chain walks using the cached chain array in each chitt's signed metadata.
- Apply revocation effective dates precisely, distinguishing 7xx / 8xx / 9xx semantics.
- Provide a verifiable npm package API for server-side and client-side use.

### Non-Goals

- **Not:** Making trust decisions on behalf of the application. The verification machinery returns facts; the application layer acts on them.
- **Not:** Verifying encrypted messages without the decryption key.

### User Stories

**As a message recipient,** I want my client to automatically verify every received message and surface a trust indicator, so that I can assess the content without manually checking chain validity.

**As a server operator,** I want to call `ChittAuth.verifyResponse(request, response, policy)` and receive a structured result, so that I do not implement chain verification myself.

**As a verifier checking historical validity,** I want to confirm whether a message signed six months ago by a now-revoked chitt was valid at the time, so that I can treat historical statements appropriately depending on the revocation code.

### Requirements

#### Must-Have (P0)

**Verification stages** (executed per signature entry in the envelope):

1. **Signature validity.** Verify the signature against the canonical serialization of the payload using the inline public key. No network call required.

2. **Sub-chitt to master link.** Resolve the signing sub-chitt's registry address. Confirm the sub-chitt appears in the active sub-chitt list of its claimed master chitt's current metadata, and that the master chitt's signature on the sub-chitt registration is valid.

3. **Chain walk (historical).** Using the cached chain array in the chitt's signed metadata, fetch all ancestor version CIDs from IPFS in parallel. For each link: verify the issuer's signature, confirm scope attenuation, confirm the chain array matches the per-link issuer references (array is a hint; per-link references are authoritative).

4. **Revocation check (current).** Resolve all mutable pointers in the chain on Arbitrum One in parallel. For each link, read the append-only log for entries with codes 8xx or 9xx. Apply semantics by code range:
   - **1xx–7xx entries:** Not revocations; do not affect the chitt's validity status.
   - **8xx:** Quiet revocation. Things before the effective date remain trusted; new actions are rejected.
   - **9xx:** Loud revocation. Things on or after the effective date are suspect or invalid; things before the effective date are trusted. Verifiers should note the 9xx signal may warrant notifying issuers of other chitts from the same holder.
   - If multiple 8xx or 9xx entries exist, the one with the earliest effective date governs.
   - If revocation data is stale beyond an acceptable freshness window, flag as stale (default: treat as rejection).

5. **Policy match (for authentication flows).** Evaluate the policy's `requester_predicate` and `recipient_predicate` against the presented chain. If any predicate fails, reject.

5a. **Policy creation compliance check (for policy-level verification).** When verifying a policy chitt itself (rather than an ordinary issued chitt), walk the policy creation chain — alternating between the policy chitt's holder chitt and that chitt's own policy — and collect all `policy_creation` field restrictions. Confirm the policy's `field_definitions` satisfy every collected restriction. If any restriction is violated, the policy is flagged as non-compliant; chitts issued under it inherit this flag. Verifiers may apply their own tolerance policy for non-compliant policies (e.g., reject entirely, warn, or accept with reduced trust).

6. **Annotation lookup (optional).** Query EAS on Arbitrum One for third-party annotations on chitts in the chain. Filter by whether the annotation signer's chain validates to a trusted root. Assemble annotation context.

7. **Recipient-set check.** Confirm the verifying party's chitt mutable pointer appears in the `recipients` array. If absent, flag as forwarded.

8. **Replay and freshness check.** Confirm the timestamp is within an acceptable window. Confirm the payload hash has not been seen before.

**Structured result per signature:**

```json
{
  "signer_chitt": "<mutable pointer>",
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

**npm package API:**

```javascript
// Server — authentication request lifecycle
ChittAuth.createRequest({ requesterChitt, policyCid, purpose, callback, sessionId })
ChittAuth.verifyResponse(request, response, policy)

// Server — session and account management
ChittAuth.bindSession(masterChittPointer, sessionData)
ChittAuth.lookupAccount(masterChittPointer)
ChittAuth.notifyUser(masterChittPointer, message, signingChitt)

// Client — message verification
ChittAuth.verifyEnvelope(signedEnvelope, trustedRoots, freshnessPolicy)

// Client — keyring integration
ChittAuth.parseRequest(deepLinkOrQrPayload)
ChittAuth.findMatchingChitts(request, localKeyring)
ChittAuth.signResponse(request, chosenChitt, subChittKey)
ChittAuth.deliverResponse(request, signedResponse)
```

**Acceptance criteria:**
- [ ] A 5-link chain verifies in the same order of magnitude as a 1-link chain (parallel fetch via cached chain array).
- [ ] A signature from a currently-revoked chitt with an 8xx code and an effective date after the signing timestamp returns `was_valid_at_signing_time: true` and `is_currently_valid: false`.
- [ ] A signature from a chitt with an 8xx revocation and an effective date before the signing timestamp returns `was_valid_at_signing_time: false` and `is_currently_valid: false`.
- [ ] A signature from a chitt with a 9xx revocation and an effective date before the signing timestamp returns `was_valid_at_signing_time: false` and `is_currently_valid: false`.
- [ ] A 1xx–7xx log entry on a chitt does not affect `is_currently_valid`; the chitt is still active.
- [ ] Stale revocation data beyond the freshness window is flagged in the result.
- [ ] A previously-seen payload hash is flagged as a replay.
- [ ] A policy chitt whose `field_definitions` violate an ancestor's `policy_creation` restrictions is flagged as non-compliant, and chitts issued under it inherit the flag.

#### Nice-to-Have (P1)

- Result caching with configurable TTL to reduce redundant Arbitrum RPC and IPFS fetches for frequently-seen signers.
- Batch verification: verify multiple envelopes sharing a common signer in a single call.
- React trust-indicator component that renders a UI from the structured result.

#### Future Considerations (P2)

- Subscription-based revocation notification via Nym: services receive push notification when a chitt they care about is revoked, enabling mid-session revocation without polling.
- W3C Verifiable Credential compatibility layer.

### Open Questions

- **[Engineering]** Fetch budget and caching strategy for chain and annotation lookups on mobile clients with limited connectivity.
- **[Design]** How should the trust indicator distinguish "chain verified to a root I trust" from "chain verified to an unknown root"?
- **[Engineering]** How are trusted roots configured by the user and synced across devices?
- **[Engineering]** When the cached chain array's version CIDs differ from a link's current state (because the ancestor was updated after issuance), how should the verifier resolve the discrepancy?

---

## 8. Authenticating with a Chitt

### Problem Statement

A service needs to verify that a user holds a chitt satisfying some predicate, or to receive a signed statement from a user's chitt, without knowing in advance which wallet service the user has registered with. The requesting site must be able to route the request to the correct wallet, receive a signed response, and confirm the user's browser session is associated with that response — all without requiring the wallet service to expose its identity to the requesting site, and without routing the full request payload through any intermediary.

### Goals

- Allow a requesting site to initiate a chitt authentication or signing request without knowing the user's wallet service in advance.
- Route the request to the user's wallet via a thin intermediary (CHAPI or future browser-native API) that sees only metadata, not payload content.
- Support the wallet fetching and responding to the request via a direct channel, with optional transport-layer anonymity for the wallet service.
- Provide a confirmation code mechanism that ties the browser session to the signed response received out-of-band.
- Make the resulting signed statement independently verifiable by any party, using the standard verification flow in §7.

### Non-Goals

- **Not:** A centralized authentication service. The protocol defines request and response formats; the requesting site does its own verification.
- **Not:** Session management beyond the confirmation code handoff. Cookie and session lifecycle is the requesting site's responsibility.
- **Not:** Requiring the user to hold a specific named chitt — the request specifies predicates, not identities.

### User Stories

**As a site operator,** I want to request that a visitor sign a statement using any chitt that satisfies a given predicate, so that I can confirm their trust lineage without managing an allowlist of specific public keys.

**As a user,** I want my wallet to receive a signing request, show me clearly what I am being asked to sign and why, and let me approve or decline, so that I am never surprised by what my chitt has signed.

**As a user,** I want to see the requesting site's chitt and verify their trust lineage before signing anything, so that I can assess whether the requester is trustworthy before committing my credential to their request.

**As a privacy-conscious user,** I want the wallet service's identity to remain hidden from the requesting site where possible, so that the requesting site cannot learn which wallet service I use.

**As a wallet service,** I want to respond to signing requests over Nym by default, using the requester's chitt Nym gateway, so that the requester does not learn my server identity from the response.

### Requirements

#### Must-Have (P0)

**Authentication request object.** The requesting site creates a JSON authentication request and hosts it at a single-use URL. The request object:

```json
{
  "session_id": "<UUID — stable identifier for this auth session>",
  "version": "1",
  "purpose": "<human-readable description shown to user in wallet UI>",
  "requesting_site": "<origin of the requesting site, for display>",
  "requester_chitt": "<mutable pointer of the requesting site's own chitt>",
  "payload": {
    "content": "<the content the user is being asked to sign>",
    "context": "<optional: additional human-readable context>",
    "nonce": "<random value — replay prevention>"
  },
  "required_predicate": <optional chitt predicate expression — same format as §1>,
  "required_policy": "<optional CID of a required policy chitt>",
  "callbacks": {
    "https": "<HTTPS URL to POST the signed response to — required>",
    "ohttp": {
      "relay": "<OHTTP relay URL>",
      "gateway_key": "<OHTTP gateway public key, base64url — optional>"
    }
  },
  "redirect_uri": "<URL to redirect user to after completion — must contain the literal string {code}>",
  "expires_at": "<ISO 8601 timestamp>",
  "request_signature": "<ML-DSA-44 signature from the requester's chitt key over the canonical serialization of all above fields>"
}
```

`requester_chitt` and `request_signature` are required. A request without either must be rejected by the wallet before being shown to the user. The requester's chitt serves two purposes: it provides a Nym gateway address the wallet uses to send the response (see transport options below), and it gives the user a verifiable trust chain for the requesting site. `callbacks.https` is required as a fallback; `callbacks.ohttp` is optional. There is no separate `callbacks.nym` field — the Nym address is taken from the requester's chitt metadata.

The request URL is single-use and expires at `expires_at`. Requests must not be reused across sessions. The `nonce` in the payload is incorporated into the signed statement and must be verified by the requesting site to prevent replay.

**Wallet discovery via CHAPI.** The requesting site includes the CHAPI polyfill and calls `navigator.credentials.get()` with a Web Credential request containing the authentication request URL (not the full request object). CHAPI routes this to the user's registered wallet service by opening the wallet's credential handler page in a controlled popup. The requesting site's code observes only a call to the CHAPI polyfill — it does not receive the wallet service's URL or identity from this call.

If no wallet is registered in CHAPI, the wallet's credential handler page is not opened. The requesting site should handle this case by presenting a prompt directing the user to register a wallet service.

**Direct fetch flow.**

1. The wallet service's credential handler page, once opened by CHAPI, receives the authentication request URL.
2. The wallet fetches the request object from that URL via HTTPS.
3. The wallet validates the request: confirms `expires_at` has not passed, confirms `requester_chitt` and `request_signature` are present, and verifies the `request_signature` against the canonical serialization of the request object using the requester's chitt public key.
4. The wallet walks the requester's chitt chain to a trusted root and checks for revocation, exactly as in §7. If the chain fails verification or any link is revoked, the request is rejected before display.
5. The wallet confirms the `required_predicate` against the user's available chitts. If no qualifying chitt exists, the wallet shows a clear explanation rather than a generic error.
6. The wallet presents the signing request to the user: the `purpose`, the requester's verified chitt identity and chain summary, `payload.content`, and a summary of the `required_predicate` if set. The wallet must clearly show what will be signed and who is asking — including the requester's trust lineage, not just their domain name.
7. If the user approves: the wallet selects a qualifying chitt (or presents a chooser if multiple qualify), generates a signed message envelope per §6 over the canonical serialization of `payload`, and assembles the authentication response.
8. The wallet sends the authentication response to the requester via the preferred transport (see below). On success, the requester returns a `confirmation_code` — a short-lived, single-use opaque token — in the response body (for HTTPS) or in a Nym reply.
9. The wallet redirects the user's browser to `redirect_uri` with `{code}` replaced by the `confirmation_code`. The requesting site's page picks up the code, looks up the associated signed response, and considers the session authenticated.

**Authentication response object** (posted by wallet to requester):

```json
{
  "session_id": "<matches the request>",
  "signed_statement": <signed message envelope per §6>,
  "chitt_pointer": "<mutable pointer of the chitt used to sign>"
}
```

**Transport options.** Because every requester must hold a chitt — and every chitt carries a Nym gateway address — Nym is always available as a response channel. The wallet selects the most private transport available, in preference order: Nym > OHTTP > HTTPS.

- **Nym (default)** — The wallet sends the authentication response to the Nym gateway address in the requester's chitt metadata. The requester sends the `confirmation_code` back via Nym. Full sender anonymity: the requester never learns the wallet service's IP or identity. No separate `callbacks.nym` field is needed; the address is resolved from the requester's chitt. Adds mixnet latency (~3–10 seconds for the round trip).

- **OHTTP (Oblivious HTTP, RFC 9458)** — If the requester advertises an OHTTP gateway in `callbacks.ohttp`, the wallet may use it for lower latency with IP privacy. The relay knows the wallet's IP but not the content; the requester's gateway sees the content but not the wallet's IP. No single party observes both. Latency is near-HTTPS (single relay hop).

- **HTTPS** — The wallet posts the response to `callbacks.https`. The requester can observe the wallet service's server IP. This is the least private option and should only be used as a fallback if Nym is unavailable or if the latency is unacceptable for the use case. The requester must still advertise `callbacks.https` since it is the universally-supported fallback.

**Verification.** On receiving an authentication response, the requesting site verifies the signed statement per §7: signature validity, chain walk to a trusted root, revocation check, predicate evaluation, and nonce match. The confirmation code is only issued after successful verification.

**Acceptance criteria:**

- [ ] The requesting site's JavaScript code does not receive the wallet service's URL or identity from the CHAPI call.
- [ ] A request missing `requester_chitt` or `request_signature` is rejected by the wallet before display.
- [ ] A request whose `request_signature` does not verify against the requester's chitt public key is rejected before display.
- [ ] A request whose requester's chitt chain cannot be walked to a trusted root is rejected before display.
- [ ] The authentication request URL is single-use: a second fetch of the same URL after the response has been posted returns an error.
- [ ] The `nonce` in the payload is present in the signed statement; a response with a mismatched or absent nonce is rejected.
- [ ] The `expires_at` on the request is enforced: a wallet that fetches an expired request must reject it and notify the user.
- [ ] A confirmation code is only issued after the signed statement passes full §7 verification.
- [ ] The confirmation code is single-use: presenting the same code twice is rejected.
- [ ] A user who declines the signing request in the wallet UI is redirected to `redirect_uri?error=declined`.
- [ ] The wallet sends the authentication response via Nym by default, using the Nym gateway in the requester's chitt metadata; HTTPS is used only as a fallback.
- [ ] The wallet presents the requester's verified chitt chain summary to the user before they approve or decline.

#### Nice-to-Have (P1)

- **Wallet chooser UI.** When multiple chitts in the user's wallet satisfy `required_predicate`, the wallet presents a chooser showing each qualifying chitt's policy and issuer, so the user can select which credential to present.
- **CHAPI-free fallback.** A requesting site that does not use CHAPI can instead display a QR code or deep link (`chitt://auth?r=<request-url>`) that the user opens in their wallet app directly. Enables authentication flows on devices without CHAPI support.
- **OHTTP relay selection.** A protocol-level registry or well-known discovery endpoint for OHTTP relays trusted by the Chitt ecosystem, so requesting sites can advertise a relay without requiring wallet services to configure relay trust ad hoc.

#### Future Considerations (P2)

- **Digital Credentials API.** When the W3C Digital Credentials API reaches broad browser support, CHAPI can be replaced with a browser-native call (`navigator.identity.get({ digital: ... })`). The request object format and direct fetch flow remain unchanged; only the wallet discovery step changes. The browser-native path provides stronger privacy guarantees (routing is browser-enforced, not polyfill-enforced) and eliminates the CHAPI mediator's metadata visibility entirely.
- **Requester anonymity.** Currently the user's browser navigates to the requesting site before any credential exchange, so the requester always learns the browser's IP from the page load. Future work could explore flows where the credential exchange precedes site navigation.
- **Multi-chitt statements.** A single authentication request that requires signatures from multiple chitts simultaneously (e.g., "sign with both your community membership and your identity chitt").

### Open Questions

- **[Design]** Should `required_predicate` be evaluated by the wallet before showing the request to the user (hiding requests the user can't fulfill), or shown regardless with a clear explanation of why no qualifying chitt is available?
- **[Engineering]** How does the requesting site manage confirmation code expiry and cleanup for sessions where the user never completes the redirect?
- **[Engineering]** For the Nym transport path, what is the maximum acceptable round-trip latency before the wallet should fall back to HTTPS?
- **[Design]** Should the wallet service advertise its supported transports in a well-known manifest (e.g., `/.well-known/chitt-wallet.json`) so requesting sites can know which `callbacks` fields to populate before constructing the request?

---



### Leading Indicators (weeks 1–4 post-launch)

- **Policy creation completion rate:** % of started policy drafts that result in a live policy chitt
- **Issuance success rate:** % of chitt offers that result in a completed, posted chitt
- **Keychain setup completion rate:** % of invitation link opens that result in a completed keychain and countersigned chitt
- **Verification latency:** median and p95 wall-clock time for full 5-link chain verification
- **Press registration success rate:** % of press sub-chitt authorizations that complete without error

### Lagging Indicators (months 1–3 post-launch)

- **Recovery success rate:** % of recovery attempts that complete without incident
- **Revocation propagation time:** time between revocation entry publication and verification clients picking up the change
- **Developer SDK adoption:** number of services integrating the `ChittAuth` npm package
- **Chitt reuse rate across sessions:** % of authenticated sessions that reuse a previously-established chitt vs. new issuance

---

## Timeline Considerations

- **Canonical serialization format** is resolved: canonical CBOR per RFC 8949 §4.2 with a JSON input surface on the npm package. See Appendix A for the full type mapping. This must be implemented in the npm package and validated against the conformance test corpus before the API is locked.
- **Arbitrum One registry contract** must implement ML-DSA-44 signature verification via Stylus, performed in full on-chain. The hash-commitment shortcut pattern (store only a hash of the press public key, verify signature off-chain) is explicitly rejected: it degrades the contract from a write gatekeeper to a passive log, enabling spam writes from anyone who knows a valid press public key. Full on-chain verification is required before contract deployment.
- **Trusted root configuration UX** is a dependency for client-side verification and keychain setup — design work should begin in parallel with protocol engineering.
- TEE hardening is explicitly P2 and does not gate v1 work.
- The Arbitrum One substrate is resolved. Gas cost estimates should be finalized against current Arbitrum One blob-era pricing; ML-DSA-44 signature calldata (~2,420 bytes per registry write vs. 64 bytes for Ed25519) will increase per-write cost by an estimated 3–8x, expected to remain under $0.25 per write.

---

## Appendix A — Canonical Serialization (Normative)

All payloads that are signed or hashed in this protocol MUST use canonical CBOR as defined in this appendix. This applies to: chitt offers, completed chitts, log entries (field updates and revocations), message envelope payloads, and authentication request/response objects.

### A.1 Base Standard

**RFC 8949 §6.1** ("Converting from JSON to CBOR") defines the base conversion. **RFC 8949 §4.2** ("Deterministic Encoding Requirements") defines the canonical form. Implementations MUST satisfy both.

The deterministic encoding rules (§4.2) require:
- Integers encoded in the shortest form (e.g., value 1 → `0x01`, not `0x1800 01`).
- Floats encoded in the shortest IEEE 754 form that round-trips. Whole-number values that fit in an integer MUST be encoded as integers, not floats (`1` not `1.0`).
- Map keys sorted by the byte length of their CBOR-encoded form first; for equal lengths, sorted lexicographically by the CBOR-encoded key bytes. This sort applies at every nesting level.
- No indefinite-length encodings.

### A.2 Protocol-Specific Overrides

Two field categories require schema-aware handling that generic RFC 8949 §6.1 cannot provide. These overrides are applied by the npm package before RFC 8949 §6.1 encoding.

#### A.2.1 Binary Fields

Fields carrying cryptographic material are accepted as **base64url strings** (RFC 4648 §5, no padding) in the JSON input surface and MUST be encoded as **CBOR byte strings (major type 2)**.

| Field name | Logical type | JSON input form | CBOR encoding |
|---|---|---|---|
| `recipient_pubkey`, `public_key` | ML-DSA-44 public key | base64url string | Major type 2 byte string |
| `offer_signature`, `holder_signature`, `signature` | ML-DSA-44 signature | base64url string | Major type 2 byte string |
| `policy_id` | CID | base64url string | Major type 2 byte string |
| `press_chitt`, `signer_chitt`, `issuer_chitt` | Mutable pointer in registry | base64url string | Major type 2 byte string |
| `prev_log_root` | CID | base64url string | Major type 2 byte string |
| Any field of type `cid` or `chitt-pointer` | CID / mutable pointer in registry | base64url string | Major type 2 byte string |
| `in_reply_to`, `edit_of`, `retracts` | Payload hash | base64url string | Major type 2 byte string |

#### A.2.2 Timestamp Fields

Fields of type `timestamp` are accepted as ISO 8601 strings in the JSON input surface and MUST be encoded as **CBOR Tag 1** (Epoch-Based Date/Time, RFC 8949 §3.4.2) wrapping an **unsigned integer** (Unix epoch seconds, UTC). Sub-second precision is not used.

| Field name | JSON input form | CBOR encoding |
|---|---|---|
| `issued_at` | `"2026-05-19T14:30:00Z"` | Tag 1 + uint (e.g., `0xc1 0x1a ...`) |
| `effective_date` | ISO 8601 string | Tag 1 + uint |
| `expires`, `expires_at`, `valid_until` | ISO 8601 string | Tag 1 + uint |
| Any field of type `timestamp` | ISO 8601 string | Tag 1 + uint |

Fields of type `date` (e.g., `enrollment_date`) are **not** Tag 1. They remain **CBOR text strings** in `YYYY-MM-DD` format.

#### A.2.3 Optional Field Omission

Optional fields that are absent MUST be omitted from the CBOR map entirely. A field present with a `null` or `undefined` value MUST be stripped before encoding. Encoding `null` produces different bytes than omission and would invalidate signatures across implementations.

### A.3 Type Mapping Summary

| Protocol field type | JSON input form | CBOR encoding |
|---|---|---|
| `text` | String | Major type 3 text string (UTF-8, no NFC normalization required) |
| `base64url` | base64url string (RFC 4648 §5, no padding) | Major type 2 byte string |
| `integer` | Number (whole) | Major type 0 (unsigned) or 1 (negative), shortest form |
| `number` | Number | Major type 7 float, shortest round-trippable form |
| `boolean` | `true` / `false` | Simple value `0xf5` / `0xf4` |
| `date` | `"YYYY-MM-DD"` string | Major type 3 text string |
| `timestamp` | ISO 8601 string | Tag 1 + major type 0 uint (Unix epoch seconds) |
| `cid` | base64url string | Major type 2 byte string |
| `chitt-pointer` | base64url string | Major type 2 byte string |
| `chitt-pointer-array` | Array of base64url strings | Major type 4 array of major type 2 byte strings |
| `append-only-array` | Array | Major type 4 array, items encoded per their own type |
| Binary cryptographic field | base64url string | Major type 2 byte string |
| Absent optional field | `null` / omitted | Omitted from map entirely |

### A.4 Conformance Test Corpus

The file `specs/serialization-conformance.json` contains reference test cases. Each case specifies a JSON input object, the names of any binary or timestamp fields requiring protocol-specific overrides, and the expected canonical CBOR output as a lowercase hex string. Implementations MUST produce identical hex output for all cases before being considered conformant.

The corpus covers: binary field encoding, Tag 1 timestamp encoding, `date` text field encoding, integer shortest-form encoding, map key ordering (same-length and different-length keys, nested maps), optional field omission, boolean encoding, Unicode text fields, and array fields.
