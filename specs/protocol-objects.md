# Card Protocol — Object Reference

**Version:** 0.2 (draft)  
**Date:** 2026-06-14  
**Status:** In Review  
**Amends:** v0.1 — §14 write authorization updated from ML-DSA-44/Stylus to secp256r1/RIP-7212 per ADR-012. Press dual-key model note added.

This document is the canonical reference for every structured object in the Card Protocol. Each object is shown as an annotated JSON template (the developer-facing input surface). Objects that are signed or hashed use **canonical RFC 8785 JSON** (JSON Canonicalization Scheme — deterministic Unicode code-point ordered JSON, no whitespace) as the byte sequence over which signatures are computed — see Appendix A of `card_protocol_spec.md` for the full serialization rules.

---

## Contents

1. [CardDocument](#1-carddocument)
2. [PolicyCardDocument](#2-policycarddocument)
3. [LogEntry](#3-logentry)
4. [UpdateIntentPayload](#4-updateintentpayload)
5. [SignedMessageEnvelope](#5-signedmessageenvelope)
6. [OpenCardOffer](#6-opencardoffer)
7. [OpenOfferClaimSubmission](#7-openofferclaimsubmission)
8. [AuthenticationRequest](#8-authenticationrequest)
9. [AuthenticationResponse](#9-authenticationresponse)
10. [SCIP](#10-scip)
11. [PressIssuanceRecord](#11-pressissuancerecord)
12. [AuditEpochEntry](#12-auditepochentry)
13. [AuditEpochCommitment](#13-auditepochcommitment)
14. [CardEntry (on-chain)](#14-cardentry-on-chain)
15. [SubCardRegistration](#15-subcardregistration)

---

## Common Sub-Objects

### SignatureEntry

Appears inside several objects wherever a single party's ML-DSA-44 signature is recorded. A SignatureEntry carries only the public key and the signature; the signer's registry address is derived as `keccak256(public_key)` and is never stored in the entry. (All cards use public-key-derived addresses — see §1 *Address derivation* and `ARCHITECTURE.md` ADR-006.)

```json
{
  "public_key":   "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
  "signature":    "<base64url — ML-DSA-44 signature, 2420 bytes raw>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `public_key` | `base64url` | Yes | The signing sub-card's ML-DSA-44 public key; the signer's registry address is derived as `keccak256(public_key)` |
| `signature` | `base64url` | Yes | Over canonical RFC 8785 JSON of the stated payload (varies per object) |

---

## 1. CardDocument

**Stored on:** IPFS  
**Signed by:** Issuer/offerer (`issuer_signature`), then Holder (`holder_signature` countersignature), then Press (`press_signature`, applied last after validation)  
**Serialized for signing:** Canonical RFC 8785 JSON. `issuer_signature` covers the offer (all fields except `recipient_pubkey`, `holder_signature`, `press_signature`; `ancestry_pubkeys` and `past_keys` — if present — are included). `holder_signature` covers the offer plus `recipient_pubkey` (all fields except `holder_signature` and `press_signature`; `ancestry_pubkeys` and `past_keys` — if present — are included). `press_signature` covers the complete countersigned document (all fields except `press_signature`; `ancestry_pubkeys` and `past_keys` — if present — are included). `past_keys` is never in an exclusion list and is immutable from genesis.

The genesis document of a card. Every card — including policy cards, press sub-cards, and user cards — begins life as a CardDocument posted to IPFS. Its CID is recorded as the initial log head in the Arbitrum One registry.

```json
{
  "policy_id":        "<base64url — CID of the governing policy card>",
  "issuer_card":      "<base64url — mutable pointer in registry of the offerer (issuer) who constructed the offer>",
  "press_card":      "<base64url — mutable pointer in registry of the press sub-card that validated and registered this card>",
  "recipient_pubkey": "<base64url — recipient's ML-DSA-44 public key, 1312 bytes raw>",
  "issued_at":        "<ISO 8601 timestamp>",
  "ancestry_pubkeys": [
    "<base64url — ML-DSA-44 public key of the immediate parent (issuer card), 1312 bytes raw>",
    "<base64url — ML-DSA-44 public key of the next ancestor up the issuer chain>",
    "...",
    "<base64url — ML-DSA-44 public key of the press card>",
    "<base64url — ML-DSA-44 public key of the press card's issuer (policy card holder), if applicable>",
    "..."
  ],
  "past_keys": [
    {
      "pubkey":      "<base64url — ML-DSA-44 public key that was previously the recipient_pubkey, 1312 bytes raw>",
      "valid_from":  "<ISO 8601 — start of validity window for this key (typically the issued_at of the card that first used it)>",
      "rotated_at":  "<ISO 8601 — timestamp at which this key was superseded by the next key in the chain>"
    }
  ],
  "issuer_signature": "<base64url — offerer's ML-DSA-44 signature over canonical RFC 8785 JSON of the offer (excludes recipient_pubkey, holder_signature, press_signature)>",
  "holder_signature": "<base64url — holder's ML-DSA-44 countersignature over the offer including recipient_pubkey (excludes holder_signature, press_signature)>",
  "press_signature":  "<base64url — press's ML-DSA-44 signature over the complete countersigned document (excludes press_signature), applied last after validation>",

  "<policy-defined fields>": "..."
}
```

| Field | Type | Required | Mutable | Notes |
|---|---|---|---|---|
| `policy_id` | `cid` | Yes | No | Pinned to the policy at time of issuance |
| `issuer_card` | `card-pointer` | Yes | No | The offerer who constructed and first-signed the offer; used to evaluate `requester_predicate` and verify `issuer_signature` |
| `press_card` | `card-pointer` | Yes | No | Identifies the press that validated and registered the card; used to walk the authorization chain |
| `recipient_pubkey` | `base64url` | Yes | No | Added by holder before countersigning; empty in the offer phase |
| `issued_at` | `timestamp` | Yes | No | Set by the offerer at offer construction |
| `ancestry_pubkeys` | `array of base64url` | Yes | No | Ordered array of ML-DSA-44 public keys (1312 bytes each, base64url) for every ancestor card a verifier must resolve to walk this card's chain to a trusted root. Ordered from immediate parent (the issuer card's public key) up toward the root, covering the issuer chain and the press/policy chain as applicable. Set at issuance; covered by all three signatures. **Root base case:** a card whose own address is a registered trusted root (present in the on-chain `PolicyAuthorizerKeys` table) carries `ancestry_pubkeys: []` — the empty array. `[]` is a legal, signed value; omission of the field is a schema violation. A card whose immediate parent is a registered trusted root likewise carries `[]` (the parent is already the termination point). **This field is always present.** This is an **untrusted hint**: the verifier MUST confirm `keccak256(entry_pubkey)` equals the on-chain address it is resolving for each entry; a wrong or forged pubkey yields an address mismatch or an undecryptable ciphertext and MUST be rejected. Per-link on-chain addresses remain authoritative. |
| `past_keys` | `array of objects` | No | No | **Present only on cards produced by a master key rotation** (i.e., cards whose `recipient_pubkey` is a newly generated key replacing a prior key). Absent when inapplicable — a card that has never been the product of a rotation **omits `past_keys` entirely** (consistent with the RFC 8785 rule that absent optional fields must be omitted rather than set to `null` or `[]`). When present, lists all prior public keys the same holder controlled, **oldest-first**, each with its validity window: `{ "pubkey": "<base64url ML-DSA-44 public key, 1312 bytes>", "valid_from": "<ISO 8601>", "rotated_at": "<ISO 8601>" }`. `valid_from` is the `issued_at` of the first card that used that key; `rotated_at` is the timestamp at which that key was superseded by the next. A holder of the current `recipient_pubkey` can use each `past_keys` entry to derive the content key (`HKDF-SHA3-256(entry.pubkey, info="card-content-v1")`) for log entries produced during that key's validity window. **Provenance:** `past_keys` represents the **holder's** own key history. During a master-key rotation, the holder/wallet supplies their prior-key history to the offerer as part of the rotation request; the offerer includes it verbatim in the assembled offer. The **holder is the authority on their own key history**: although `past_keys` appears in the `issuer_signature` payload (because it is present in the assembled offer the offerer signs), the authoritative attestation is the `holder_signature` — the holder explicitly countersigns, confirming the listed prior keys are their own. `issuer_signature` and `press_signature` also cover the bytes (neither excludes `past_keys`). `past_keys` is immutable after issuance. **Signing coverage:** included in the `issuer_signature` payload (excludes `recipient_pubkey`, `holder_signature`, `press_signature`), the `holder_signature` payload (excludes `holder_signature`, `press_signature`), and the `press_signature` payload (excludes `press_signature` only). `past_keys` is **not** in any exclusion list. See `key_rotation.md §2.3` for full semantics. |
| `issuer_signature` | `base64url` | Yes | No | Offerer signs the offer (all fields except `recipient_pubkey`, `holder_signature`, `press_signature`) |
| `holder_signature` | `base64url` | Yes | No | Holder signs the offer plus `recipient_pubkey` (all fields except `holder_signature`, `press_signature`) |
| `press_signature` | `base64url` | Yes | No | Press signs the complete countersigned document (all fields except `press_signature`), applied last after validating policy compliance |
| `supersedes` | `card-pointer` | No | No | Present only on un-revocation cards: the mutable pointer of the prior card this card corrects. Set by the issuer at genesis. See `card_protocol_spec.md §Background`. |
| `supersession_note` | `text` | No | No | Human-readable explanation of why this card supersedes the one pointed to by `supersedes`. Present only when `supersedes` is set. |

**Signing sequence (three parties, fixed order):**
1. The **offerer's wallet service** assembles the document with all policy-defined fields, `issuer_card`, `press_card`, `issued_at`, `ancestry_pubkeys` (the ordered array of ancestor ML-DSA-44 public keys, from immediate parent toward root), and `past_keys` if applicable (present and oldest-first when this card is the product of a master key rotation; omitted otherwise), leaving `recipient_pubkey`, `holder_signature`, and `press_signature` absent.
2. The offerer signs canonical RFC 8785 JSON of that offer with the offerer's card key → `issuer_signature`. `ancestry_pubkeys` and `past_keys` (if present) are covered by this signature.
3. The offer is presented to the recipient, who reviews, generates a fresh ML-DSA-44 keypair, adds `recipient_pubkey`, and signs canonical RFC 8785 JSON of the offer-plus-pubkey → `holder_signature`. `ancestry_pubkeys` and `past_keys` (if present) are covered by this signature.
4. The offerer validates the countersigned result (confirms the recipient countersigned the intended offer).
5. The countersigned card is sent to the **press**, which validates policy compliance, signs canonical RFC 8785 JSON of the complete document with its press sub-card key → `press_signature`, posts it to IPFS encrypted under the ADR-006 content key, and registers it on-chain. `ancestry_pubkeys` and `past_keys` (if present) are covered by this signature.

**Content encryption and the offer phase.** ADR-006 content encryption (`content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, AES-256-GCM) applies only to the **registered** card document the press posts in step 5. The offer-phase document assembled in steps 1–2 (without `recipient_pubkey`, `holder_signature`, or `press_signature`) has no `recipient_pubkey` yet, so the content key is undefined for it. Offer-phase `CardDocument`s are **not** content-encrypted under this scheme. They are conveyed to the prospective recipient either in the clear within the invite payload (e.g. a `mcard://invite` URL) or protected only by the transport / E2E message encryption used to deliver the `card_offer` message (ML-KEM per ADR-007). The distinction is important: the ADR-007 E2E transport encryption that protects the `card_offer` message in transit is separate from the ADR-006 at-rest content encryption that protects the registered card on IPFS. Content encryption begins only at step 5.

**Press dual-key model:** Each press card carries two distinct public keys with separate roles:
- `recipient_pubkey` (ML-DSA-44, 1312 bytes) — the press's IPFS identity key. Used for `press_signature` above and for all content stored on IPFS. Quantum-resistant from day one because IPFS content is permanent.
- secp256r1 key (64 bytes, uncompressed x||y) — the press's on-chain write authorization key. Registered separately in the on-chain `PressAuthorizations` table (not in this CardDocument). Verified via RIP-7212 precompile on each `RegisterCard` / `UpdateCardHead` call. Rotatable; upgradeable to ML-DSA-44 via ADR-012 upgrade path.

These are independent keys. Rotating the secp256r1 on-chain key does not affect the ML-DSA-44 IPFS identity key, and vice versa.

### 1.1 Protocol-Reserved Updatable Fields

These fields are NOT present at genesis. They are added to an existing card via a 1xx `LogEntry` and are enforced by the press and verifiers regardless of the card's policy `field_definitions`. They may not be redefined or overridden by any policy.

| Field | Type | Authorization | Codes | Meaning |
|---|---|---|---|---|
| `successor` | `card-pointer` | Codes 100, 101: `{ "is_holder": true }`. Code 102: `{ "is_issuer": true }` with 72-hour pending window. | 100, 101, 102 | Mutable pointer of the card that supersedes this one. May be set at most once; once effective, it is immutable. See `key_rotation.md §8`. |

A code-102 `successor` entry carries a `pending_until` field and is not effective until that timestamp is reached without a holder-submitted code-103 cancellation. See `key_rotation.md §2.6`.

---

## 2. PolicyCardDocument

**Stored on:** IPFS  
**Is a:** CardDocument (same protocol-required fields plus the policy fields below)

A policy card is a CardDocument whose content defines the rules for a class of cards. All the protocol-required fields of CardDocument apply, including `ancestry_pubkeys`. The additional fields below are the policy's own field values (analogous to the policy-defined fields of any card, but standardised across all policies).

**`ancestry_pubkeys` on policy cards:** Policy cards have ancestry chains (the authorizer's card chain, and for press-issued policies, the press chain as well). The `ancestry_pubkeys` array is required on policy cards and follows the same convention as for ordinary cards: ordered from the immediate parent (the authorizer/issuer card's public key) up toward the root of the trust chain. A verifier walking the policy creation chain to evaluate `policy_creation` constraints uses the same `ancestry_pubkeys` hint and the same binding check (`keccak256(entry_pubkey)` must equal the on-chain address being resolved). **Root base case for policy cards:** a self-rooted trusted-root policy card — one whose own address is registered in `PolicyAuthorizerKeys` — carries `ancestry_pubkeys: []`. The empty array `[]` is the valid, signed value for this case; the field is still REQUIRED and MUST be present (not omitted).

```json
{
  "policy_id":        "<base64url — CID of the meta-policy governing this policy card>",
  "issuer_card":      "<base64url — mutable pointer in registry of the policy authorizer's card>",
  "recipient_pubkey": "<base64url — administrator's ML-DSA-44 public key>",
  "issued_at":        "<ISO 8601 timestamp>",
  "ancestry_pubkeys": [
    "<base64url — ML-DSA-44 public key of the authorizer (issuer) card, 1312 bytes raw>",
    "<base64url — ML-DSA-44 public key of the next ancestor up the issuer chain>",
    "..."
  ],
  "issuer_signature": "<base64url — authorizer's signature over the offer>",
  "holder_signature": "<base64url — administrator's countersignature>",

  "field_definitions": [
    {
      "name":          "<field name>",
      "type":          "<text | base64url | integer | number | boolean | date | timestamp | cid | card-pointer | card-pointer-array | append-only-array>",
      "required":      true,
      "description":   "<human-readable description>",
      "update_policy": { "<predicate expression>" },
      "<type-specific validation options>": "..."
    }
  ],
  "recipient_predicate":   { "<optional card predicate expression>" },
  "requester_predicate":   { "<optional card predicate expression>" },
  "auditors":              ["<base64url card-pointer>", "..."],
  "approved_presses":      ["<base64url card-pointer>", "..."],
  "valid_until":           "<ISO 8601 timestamp — optional>",
  "allow_open_offers":     false,
  "revocation_permissions": {
    "8xx": { "<predicate expression>" },
    "9xx": { "<predicate expression>" }
  },
  "notes":               ["<text>"],
  "policy_creation":     {
    "field_restrictions": [
      {
        "name":       "<field name>",
        "required":   true,
        "prohibited": false,
        "type":       "<optional — required type>",
        "regex":      "<optional — for text fields>"
      }
    ]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `field_definitions` | array | Yes | Schema for cards issued under this policy |
| `recipient_predicate` | predicate | No | Chain predicate the recipient must satisfy; absent = unconstrained |
| `requester_predicate` | predicate | No | Chain predicate the requester must satisfy; absent = unconstrained |
| `auditors` | `card-pointer-array` | No | Auditors receive a per-epoch AEK (wrapped via ML-KEM-768 per auditor) giving them read access to all issuance log entries in that epoch. See `PressIssuanceRecord` §11 and `AuditEpochEntry` §12. |
| `approved_presses` | `card-pointer-array` | No | Presses whose sub-card pointers may write to this policy's cards |
| `valid_until` | `timestamp` | No | Press rejects issuance requests after this time |
| `allow_open_offers` | `boolean` | No | Default `false`; must be `true` to permit open card offers under this policy |
| `revocation_permissions` | object | No | Predicates controlling who may post 8xx and 9xx entries; defaults to holder-or-issuer for 8xx, issuer-only for 9xx |
| `notes` | `append-only-array` of `text` | No | Append-only annotations |
| `policy_creation` | object | No | Constraints on policies that holders of this policy's cards may create |

---

## 3. LogEntry

**Stored on:** IPFS (chained via `prev_log_root`)  
**On-chain pointer:** Arbitrum One registry entry for the card points to the current log head CID  
**Signed by:** Updater (`intent_signature`) then Press (`press_signature`)  
**Serialized for signing:**
- `intent_signature` covers canonical RFC 8785 JSON of the `UpdateIntentPayload` (see §4)
- `press_signature` covers canonical RFC 8785 JSON of the complete `LogEntry` document excluding the `press_signature` field itself

Every post-genesis state change to a card — field updates, annotations, and revocations — is a LogEntry appended to the card's IPFS log. The log is a singly-linked list; each entry points back to the prior head. The Arbitrum One registry tracks only the current head CID.

```json
{
  "version":         2,
  "code":            300,
  "entry_type":      "field_update",
  "prev_log_root":   "<base64url — CID of the prior log entry (or genesis CardDocument for version 2)>",

  "field_updates": [
    { "field": "<field name>", "value": "<new value>" }
  ],

  "revocation": {
    "effective_date": "<ISO 8601 timestamp>",
    "note":           "<optional human-readable explanation>"
  },

  "notify_holder":   true,
  "updater_message": "<optional text — included in holder notification if notify_holder is true>",

  "intent_signature": {
    "public_key":   "<base64url — updater's ML-DSA-44 public key>",
    "signature":    "<base64url — sig over canonical RFC 8785 JSON of the UpdateIntentPayload>"
  },
  "press_signature": {
    "public_key":   "<base64url — press's ML-DSA-44 public key>",
    "signature":    "<base64url — sig over canonical RFC 8785 JSON of the complete LogEntry excluding press_signature>"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | `integer` | Yes | Monotonically increasing; version 1 is the first post-genesis entry |
| `code` | `integer` | Yes | 100–999; present in **all** entries, not only revocations. Determines `entry_type`. |
| `entry_type` | `text` | Yes | `"field_update"` for codes 1xx–7xx; `"revocation"` for codes 8xx–9xx |
| `prev_log_root` | `cid` | Yes | CID of the prior log entry; genesis CardDocument CID for `version == 1` |
| `field_updates` | array | Conditional | Present for codes 1xx–7xx; absent for 8xx–9xx |
| `revocation` | object | Conditional | Present for codes 8xx–9xx; absent for 1xx–7xx |
| `revocation.effective_date` | `timestamp` | Yes (if revocation) | May predate the posting date |
| `revocation.note` | `text` | No | Human-readable context |
| `notify_holder` | `boolean` | Yes | Defaults to `true`; set `false` to suppress holder notification |
| `updater_message` | `text` | No | Forwarded to holder in the HTTPS notification |
| `intent_signature` | SignatureEntry | Yes | Updater's signature over the UpdateIntentPayload |
| `press_signature` | SignatureEntry | Yes | Press's signature over the complete LogEntry |

**Code → entry_type mapping:**

| Code range | `entry_type` | `field_updates` | `revocation` |
|---|---|---|---|
| 1xx–7xx | `"field_update"` | Present | Absent |
| 8xx–9xx | `"revocation"` | Absent | Present |

---

## 4. UpdateIntentPayload

**Transmitted to:** Press (via HTTPS)  
**Signed by:** Updater  
**Serialized for signing:** Canonical RFC 8785 JSON of this object; becomes the `intent_signature` payload

The object the updater signs before submitting to a press. The press validates predicates against this payload and, if valid, assembles it into a LogEntry by adding `version`, `prev_log_root`, and `press_signature`.

```json
{
  "target_card":  "<base64url — mutable pointer in registry of the card being updated>",
  "updater_card": "<base64url — mutable pointer in registry of the updater's card>",
  "code":          300,
  "field_updates": [
    { "field": "<field name>", "value": "<new value>" }
  ],
  "revocation": {
    "effective_date": "<ISO 8601 timestamp>",
    "note":           "<optional>"
  },
  "notify_holder":   true,
  "updater_message": "<optional>",
  "note":            "<optional human-readable note>",
  "timestamp":       "<ISO 8601 timestamp — replay prevention>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `target_card` | `card-pointer` | Yes | The card being updated |
| `updater_card` | `card-pointer` | Yes | The updater's card; used to evaluate `update_policy` predicates |
| `code` | `integer` | Yes | 100–999 |
| `field_updates` | array | Conditional | Present for codes 1xx–7xx; null or absent for 8xx–9xx |
| `revocation` | object | Conditional | Present for codes 8xx–9xx; null or absent for 1xx–7xx |
| `notify_holder` | `boolean` | Yes | Copied verbatim into the LogEntry |
| `updater_message` | `text` | No | Copied verbatim into the LogEntry |
| `note` | `string?` | No | Optional human-readable note attached to this update intent |
| `timestamp` | `timestamp` | Yes | Prevents replay; press rejects intents with stale timestamps |

The intent does **not** include `version` or `prev_log_root` — those are added by the press when assembling the LogEntry.

---

## 5. SignedMessageEnvelope

**Transmitted via:** OHTTP (optional) / HTTPS  
**Signed by:** One or more card holders (parallel co-signing)  
**Serialized for signing:** Canonical RFC 8785 JSON of the `payload` object only (not the outer envelope)

The primary object for card-authenticated communication and for authentication responses (§9). The canonical envelope format is defined in `messaging_protocol.md §1`; this section is the normative schema reference.

```json
{
  "payload": {
    "type":        "<message type — see messaging_protocol.md §2>",
    "content":     { "<type-specific fields — structure defined per type in messaging_protocol.md §2>" },
    "senders":     ["<base64url — mutable pointer of sender's master card>", "..."],
    "recipients":  ["<base64url — mutable pointer>", "..."],
    "timestamp":   "<ISO 8601 timestamp>",
    "in_reply_to": "<base64url — hash of prior payload — optional>",
    "edit_of":     "<base64url — hash of prior payload — optional; mutually exclusive with retracts and forwards>",
    "retracts":    "<base64url — hash of prior payload — optional; mutually exclusive with edit_of and forwards>",
    "forwards":    "<base64url — hash of the original payload being forwarded — optional; mutually exclusive with edit_of and retracts; see ForwardPackage below>"
  },
  "signatures": [
    {
      "public_key":   "<base64url — ML-DSA-44 public key>",
      "signature":    "<base64url — sig over canonical RFC 8785 JSON of the payload object>"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `payload.type` | `text` | Yes | Message type identifier; determines the `content` schema |
| `payload.content` | `object` | Yes | Type-specific content; structure defined per type in `messaging_protocol.md §2` |
| `payload.senders` | `card-pointer-array` | Yes | Master card mutable pointers of the sending parties; parallel to `signatures` |
| `payload.recipients` | `card-pointer-array` | Yes | Mutable pointers of intended recipients; part of the signed payload |
| `payload.timestamp` | `timestamp` | Yes | ISO 8601; replay prevention |
| `payload.in_reply_to` | `base64url` | No | Hash of the payload this is replying to |
| `payload.edit_of` | `base64url` | No | Hash of the payload this supersedes; mutually exclusive with `retracts` and `forwards` |
| `payload.retracts` | `base64url` | No | Hash of the payload being retracted; mutually exclusive with `edit_of` and `forwards` |
| `payload.forwards` | `base64url` | No | Hash of the original payload being forwarded; mutually exclusive with `edit_of` and `retracts`. Set only on the `forward_envelope` of a `ForwardPackage` (§5.1) |
| `signatures` | array of SignatureEntry | Yes | One entry per signer; each covers the same canonical payload bytes |

The **message ID** is the hash of the canonical RFC 8785 JSON of `payload`. There is no separate ID field.

### 5.1 ForwardPackage

**Transmitted via:** OHTTP (optional) / HTTPS  
**Signed by:** The original signer(s) (inside `original_envelope`) and the forwarder (inside `forward_envelope`)

Forwarding a message to a party not in the original `recipients` array MUST use a `ForwardPackage` — a pair of envelopes that together establish the original sender, the forwarder, and the new recipients. Delivering only the original envelope to a party not listed in its `recipients` is an unauthenticated relay and MUST be rejected by verifiers (see `card_protocol_spec.md §6` and `process_specs/card_signing.md`).

```json
{
  "original_envelope": { "<original SignedMessageEnvelope, unmodified>" },
  "forward_envelope":  { "<new SignedMessageEnvelope signed by the forwarder>" }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `original_envelope` | SignedMessageEnvelope | Yes | The original message, unmodified; all its signatures remain independently verifiable |
| `forward_envelope` | SignedMessageEnvelope | Yes | Signed by the forwarder; its `payload.forwards` MUST equal the message ID (canonical-payload hash) of `original_envelope.payload`, and its `payload.recipients` lists the new recipients |

The forwarder's signature commits only to the fact of forwarding and the new recipient set — not to the original content. The forwarder is not a co-signer of the original payload. From the pair, verifiers establish: **forwarded from** (addresses derived from `original_envelope.signatures[].public_key`), **forwarded by** (addresses derived from `forward_envelope.signatures[].public_key`), and **forwarded to** (`forward_envelope.payload.recipients`).

---

## 6. OpenCardOffer

**Stored on:** Wallet service (HTTPS); may also be pinned to IPFS  
**Signed by:** Issuer  
**Serialized for signing:** Canonical RFC 8785 JSON of all fields except `issuer_signature` (i.e. `display_message`, `expires_at`, `issuer_card`, `issuer_pubkey`, `max_acceptances`, `offer_type`, `policy_id`, `press_card`, `proposed_fields`, `redirect_url` — in Unicode code-point key order)

A pre-signed batch authorization allowing any bearer to claim a card under this policy without individual issuer review. The policy card must have `allow_open_offers: true`.

When a recipient accepts, their wallet wraps this document in an `OpenOfferClaimSubmission` (§7), adds a freshly-generated public key, countersigns, and POSTs to the press. The press constructs the `CardDocument` from `proposed_fields` plus the recipient's public key.

```json
{
  "offer_type":        "open",
  "policy_id":         "<base64url — CID of the governing policy card>",
  "press_card":       "<base64url — mutable pointer in registry of the approved press>",
  "issuer_card":      "<base64url — mutable pointer in registry of the issuer's card>",
  "issuer_pubkey":    "<base64url — ML-DSA-44 public key of the card referenced by issuer_card, 1312 bytes raw>",
  "max_acceptances":   100,
  "expires_at":        "<ISO 8601 timestamp — null if unconstrained>",
  "display_message":   "<optional human-readable context shown to recipient>",
  "redirect_url":      "<URL to redirect recipient to after successful issuance>",
  "proposed_fields":   {
    "<field name>": "<issuer-populated value>",
    "...": "..."
  },
  "issuer_signature":  "<base64url — ML-DSA-44 sig over canonical RFC 8785 JSON of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `offer_type` | `text` | Yes | Always `"open"` for this object type |
| `policy_id` | `cid` | Yes | Must have `allow_open_offers: true` |
| `press_card` | `card-pointer` | Yes | Must appear in policy's `approved_presses` |
| `issuer_card` | `card-pointer` | Yes | Used to evaluate `requester_predicate` |
| `issuer_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `issuer_card`; set by the issuer at offer creation; **covered by `issuer_signature`** |
| `max_acceptances` | `integer` | No | Null = unconstrained |
| `expires_at` | `timestamp` | No | Null = unconstrained; enforced atomically on-chain |
| `display_message` | `text` | No | Human-readable context shown in wallet UI |
| `redirect_url` | `text` | No | Wallet redirects recipient here after issuance |
| `proposed_fields` | object | Yes | Issuer-populated field values for issued cards |
| `issuer_signature` | `base64url` | Yes | Covers canonical RFC 8785 JSON of all fields except itself, including `issuer_pubkey` |

**Binding check (recipient wallet and press):** `issuer_pubkey` is an untrusted hint. Any verifier MUST confirm `keccak256(issuer_pubkey)` equals the `issuer_card` pointer address before using it to verify `issuer_signature` or to derive the issuer card's content key. A mismatch — or an AES-GCM authentication failure when decrypting the issuer card — is a hard rejection.

**Verifier usage:** verify `issuer_signature` with `issuer_pubkey`, then derive the issuer card's content key as `HKDF-SHA3-256(issuer_pubkey, info="card-content-v1")`, decrypt the issuer card, and walk the rest of the chain via that card's `ancestry_pubkeys`.

The **offer ID** used for on-chain counter tracking is `hash(canonical RFC 8785 JSON of the complete document including issuer_signature)`. Adding `issuer_pubkey` changes the bytes hashed relative to older versions of this object; the offer ID remains "the complete document" and is still unique per issuer and unforgeable. The contract stores a per-offer-ID acceptance counter in `openOfferUseCounts` (see §14).

---

## 7. OpenOfferClaimSubmission

**Transmitted to:** Press (via HTTPS POST from wallet service)  
**Signed by:** Recipient  
**Serialized for signing:** Canonical RFC 8785 JSON of `claim_payload` (see below)

The object the wallet service POSTs to the press when a recipient accepts an open card offer. The press uses `claim_payload.offer.proposed_fields` to construct the `CardDocument`, adding `recipient_pubkey` and signing the result as in the targeted issuance flow.

```json
{
  "claim_payload": {
    "offer":           { "<verbatim OpenCardOffer document including issuer_signature>" },
    "recipient_pubkey": "<base64url — recipient's freshly-generated ML-DSA-44 public key, 1312 bytes raw>"
  },
  "recipient_signature": "<base64url — recipient's ML-DSA-44 sig over canonical RFC 8785 JSON of claim_payload>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `claim_payload.offer` | OpenCardOffer | Yes | Verbatim; press re-verifies `issuer_signature` over this |
| `claim_payload.recipient_pubkey` | `base64url` | Yes | Public key for the new card; press copies this into the assembled `CardDocument` |
| `recipient_signature` | `base64url` | Yes | Sig over canonical RFC 8785 JSON of the entire `claim_payload` object (offer + recipient_pubkey); press verifies before proceeding |

**Press validation on receipt:**

1. Confirm `keccak256(claim_payload.offer.issuer_pubkey)` equals the `claim_payload.offer.issuer_card` pointer address. A mismatch is a hard rejection (E-14, press-side). Re-verify `claim_payload.offer.issuer_signature` over the canonical RFC 8785 JSON of all offer fields except `issuer_signature`, using `issuer_pubkey`. An AES-GCM failure when subsequently decrypting the issuer card is also a hard rejection.
2. Verify `recipient_signature` over canonical RFC 8785 JSON of `claim_payload`.
3. Confirm `claim_payload.offer.press_card` matches the receiving press's own sub-card pointer.
4. Confirm the policy has `allow_open_offers: true`.
5. **Press pre-flight (before transaction):** read `OpenOfferUseCounts[offer_id]` on-chain and independently verify `expires_at` and capacity. Reject with a specific error before submitting any transaction if either constraint would be violated.
6. Assemble and countersign the `CardDocument` from `proposed_fields` + `recipient_pubkey`, then call `ClaimOpenOffer` on-chain (which independently re-validates constraints atomically with card registration). If the transaction reverts, surface the contract error code (E-12 or E-13) to the wallet service. Note: E-14 (invalid issuer signature) is a press-side rejection at step 1 above — it is never surfaced from the contract. See `registry_contract.md §4.5`.

**Note on the recipient's key:** `recipient_pubkey` in the claim payload is logically equivalent to the same field added by the holder in the targeted issuance flow — the recipient generates it fresh at claim time and its private counterpart never leaves their device.

**Note on `ancestry_pubkeys` in open offer claims:** When the press assembles the `CardDocument` from an `OpenOfferClaimSubmission`, it populates `ancestry_pubkeys` from the issuer card's chain (resolved at claim time) plus the press card's chain as applicable. The `issuer_signature` in the original `OpenCardOffer` covers `proposed_fields` but not `ancestry_pubkeys` (because the open offer does not include per-recipient card assembly); the per-recipient `holder_signature` and `press_signature` on the assembled `CardDocument` cover `ancestry_pubkeys` and bind it to the specific issuance.

---

## 8. AuthenticationRequest

**Hosted at:** Single-use HTTPS URL (requesting site's infrastructure)  
**Signed by:** Requesting site (using its own card key)  
**Serialized for signing:** Canonical RFC 8785 JSON of all fields except `request_signature` (i.e. `callbacks`, `expires_at`, `payload`, `purpose`, `required_policy`, `required_predicate`, `redirect_uri`, `requester_card`, `requester_pubkey`, `requesting_site`, `session_id`, `version` — in Unicode code-point key order)

The object a site creates when it wants a user to authenticate with a card. Hosted at a single-use URL and fetched by the wallet service via CHAPI.

```json
{
  "session_id":       "<UUID — stable identifier for this auth session>",
  "version":          "1",
  "purpose":          "<human-readable description shown to user>",
  "requesting_site":  "<origin of the requesting site, for display>",
  "requester_card":  "<base64url — mutable pointer in registry of the requesting site's card>",
  "requester_pubkey": "<base64url — ML-DSA-44 public key of the card referenced by requester_card, 1312 bytes raw>",
  "payload": {
    "content": "<the content the user is being asked to sign>",
    "context": "<optional additional human-readable context>",
    "nonce":   "<random value — replay prevention>"
  },
  "required_predicate": { "<optional card predicate expression — same format as §1>" },
  "required_policy":    "<base64url — CID of a required policy card — optional>",
  "callbacks": {
    "https": "<HTTPS URL to POST the signed response to — required>",
    "ohttp": {
      "relay":       "<OHTTP relay URL>",
      "gateway_key": "<base64url — OHTTP gateway public key — optional>"
    }
  },
  "redirect_uri":     "<URL to redirect user to after completion; must contain literal {code}>",
  "expires_at":       "<ISO 8601 timestamp>",
  "request_signature":"<base64url — ML-DSA-44 sig from the requester's card key over canonical RFC 8785 JSON of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | UUID; ties the confirmation code to this session |
| `version` | `text` | Yes | Always `"1"` in v1 |
| `purpose` | `text` | Yes | Displayed to user in wallet UI |
| `requesting_site` | `text` | Yes | Display-only origin |
| `requester_card` | `card-pointer` | Yes | Wallet uses this for chain verification |
| `requester_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `requester_card`; set by the requesting site; **covered by `request_signature`** |
| `payload.content` | `text` | Yes | The statement the user will countersign |
| `payload.nonce` | `text` | Yes | Incorporated into signed statement; must be verified to prevent replay |
| `required_predicate` | predicate | No | Chain predicate the user's card must satisfy |
| `required_policy` | `cid` | No | Policy card CID the user's card must have been issued under |
| `callbacks.https` | `text` | Yes | Required fallback |
| `callbacks.ohttp` | object | No | For IP-private response |
| `redirect_uri` | `text` | Yes | Must contain `{code}` placeholder |
| `expires_at` | `timestamp` | Yes | Wallet rejects requests past this time |
| `request_signature` | `base64url` | Yes | Wallet verifies before displaying; covers all fields except itself, including `requester_pubkey` |

**Binding check (wallet):** `requester_pubkey` is an untrusted hint. The wallet MUST confirm `keccak256(requester_pubkey)` equals the `requester_card` pointer address before using it to verify `request_signature` or to derive the requester card's content key. A mismatch — or an AES-GCM authentication failure when decrypting the requester card — is a hard rejection.

**Verifier usage:** verify `request_signature` with `requester_pubkey`, then derive the requester card's content key as `HKDF-SHA3-256(requester_pubkey, info="card-content-v1")`, decrypt the requester card, and walk the rest of the chain via that card's `ancestry_pubkeys`.

---

## 9. AuthenticationResponse

**Transmitted via:** OHTTP (optional) / HTTPS  
**Sent by:** Wallet service  
**Contains:** A `SignedMessageEnvelope` (§5) assembled by the wallet at signing time

The object the wallet posts after user approval. The `signed_statement` is a standard `SignedMessageEnvelope` (§5) with `type: "auth_response"`. The wallet constructs the envelope payload from the `AuthenticationRequest`'s content fields plus the standard envelope fields (`senders`, `recipients`, `timestamp`). This makes auth responses verifiable using the same path as any other envelope.

```json
{
  "session_id":       "<matches the AuthenticationRequest — unsigned correlation field; NOT inside signed_statement>",
  "signed_statement": {
    "payload": {
      "type":      "auth_response",
      "content": {
        "statement": "<copied from AuthenticationRequest.payload.content — the text the user signed>",
        "context":   { "session_id": "<echoed from AuthenticationRequest.session_id — binds response to session>", "<other contextual fields>": "..." },
        "nonce":     "<copied from AuthenticationRequest.payload.nonce — replay prevention>"
      },
      "senders":    ["<base64url — holder's master card mutable pointer>"],
      "recipients": ["<base64url — requester_card mutable pointer>"],
      "timestamp":  "<ISO 8601 — set by wallet at signing time>"
    },
    "signatures": [
      {
        "public_key":   "<base64url>",
        "signature":    "<base64url — sig over canonical RFC 8785 JSON of payload>"
      }
    ]
  },
  "card_pointer":    "<base64url — mutable pointer in registry of the card used to sign>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | Top-level unsigned correlation field; must match `AuthenticationRequest.session_id`. Also echoed inside `content.context.session_id` (signed) — see note below |
| `signed_statement` | SignedMessageEnvelope | Yes | Requester verifies this per §7; `type` must be `"auth_response"` |
| `signed_statement.payload.content` | object | Yes | Canonical schema: `{ statement, context, nonce }`. `context` is an **object** (not a plain string); `session_id` lives inside `context` as a signed correlation field |
| `signed_statement.payload.content.statement` | `text` | Yes | Copied verbatim from `AuthenticationRequest.payload.content` |
| `signed_statement.payload.content.context.session_id` | `text` | Yes | Echoed from `AuthenticationRequest.session_id`; **signed** inside `content`; requester verifies this matches the issued session before accepting the response |
| `signed_statement.payload.content.nonce` | `text` | Yes | Must match `AuthenticationRequest.payload.nonce`; replay prevention |
| `signed_statement.payload.timestamp` | `timestamp` | Yes | Set by wallet at signing time; requester checks freshness |
| `card_pointer` | `card-pointer` | Yes | The card the user chose; used for chain walk and predicate evaluation |

**`session_id`: signed vs unsigned.** There are two occurrences of `session_id` in an `AuthenticationResponse`:
1. **Top-level `session_id`** (outside `signed_statement`) — unsigned convenience field for HTTP routing and server-side session lookup. The requester's server uses this to find the pending session without parsing the signed payload.
2. **`signed_statement.payload.content.context.session_id`** — the same value, inside the signed envelope. Because `content` is signed byte-for-byte, this copy is cryptographically bound to the holder's signature. The requester MUST verify this value matches the issued `session_id` to prevent session-fixation attacks.

The requesting site verifies `signed_statement` per §7 (chain walk, revocation check, predicate evaluation) and additionally confirms `content.context.session_id` matches the issued `session_id` and `content.nonce` matches the issued request nonce before issuing a confirmation code.

---

## 10. SCIP

**Signed Card Inclusion Proof**  
**Produced by:** Press  
**Delivered to:** Recipient (and courtesy copy to administrator) via HTTPS to wallet service endpoints  
**Serialized for signing:** Canonical RFC 8785 JSON of all fields except `press_signature`

A small signed object that binds a newly-issued card's CID to its position in the policy's issuance log at time of inclusion. The recipient retains this as verifiable proof of issuance.

```json
{
  "card_cid":                  "<base64url — CID of the completed CardDocument>",
  "policy_log_entry_index":     1,
  "policy_log_root_at_inclusion":"<base64url — CID of the policy card's log head at time of issuance>",
  "issued_at":                  "<ISO 8601 timestamp>",
  "press_signature": {
    "public_key":   "<base64url>",
    "signature":    "<base64url — sig over canonical RFC 8785 JSON of all above fields>"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `card_cid` | `cid` | Yes | Content address of the issued card; verifier can fetch and inspect |
| `policy_log_entry_index` | `integer` | Yes | Position of the issuance record in the policy's press log |
| `policy_log_root_at_inclusion` | `cid` | Yes | Allows the recipient to anchor the issuance to the policy log state at a specific point in time |
| `issued_at` | `timestamp` | Yes | Must match the card's `issued_at` field |
| `press_signature` | SignatureEntry | Yes | Binds all above fields; verifier confirms press is in `approved_presses` |

---

## 11. PressIssuanceRecord

**Stored on:** IPFS, within the policy card's append-only press log  
**Encrypted with:** The current audit epoch's AEK (AES-GCM, per-entry random nonce)  
**Access:** Only by auditors holding a wrapped copy of the epoch AEK; press operator cannot decrypt  
**Written by:** Press (immediately after assembling and signing the `CardDocument`; the press already holds `recipient_pubkey` at that point — it is in the `CardDocument` the press just assembled)

The plaintext content of each press log entry. Entries are encrypted under the epoch AEK shared across all auditors for that epoch (see `AuditEpochEntry` §12). Each entry carries `epoch_id` in plaintext so that auditors can identify which epoch key to use for decryption without reading the ciphertext.

**Envelope vs. plaintext.** `recipient_pubkey` and all other fields in the JSON example below live inside the AEK-encrypted plaintext. The outer on-IPFS storage envelope — `epoch_id` (plaintext), `nonce`, and `ciphertext` — is unchanged and contains no public key material.

```json
{
  "epoch_id":         "<string — identifies the audit epoch this entry belongs to>",
  "card_cid":         "<base64url — CID of the issued CardDocument>",
  "recipient_pubkey": "<base64url — ML-DSA-44 public key of the issued CardDocument, 1312 bytes raw>",
  "scip_cid":         "<base64url — CID of the SCIP posted to IPFS>",
  "issued_at":        "<ISO 8601 timestamp>",
  "requester_card":   "<base64url — mutable pointer of the requester's card — optional>",
  "offer_type":       "targeted | open"
}
```

The on-IPFS storage format for each encrypted entry (outer envelope — unchanged):

```json
{
  "epoch_id":   "<string — plaintext; identifies epoch key>",
  "nonce":      "<base64url — 96-bit random nonce>",
  "ciphertext": "<base64url — AES-GCM.Encrypt(AEK, PressIssuanceRecord plaintext, nonce)>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `epoch_id` | `text` | Yes | Identifies which epoch AEK decrypts this entry; stored in plaintext in the outer envelope |
| `card_cid` | `cid` | Yes | Links to the issued card; gives auditors an issuance record for the policy |
| `recipient_pubkey` | `base64url` | Yes | ML-DSA-44 public key of the issued `CardDocument` (1312 bytes raw). Auditor usage: derive `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, decrypt the issued card at `card_cid`, then inspect its field values and verify predicate compliance against the policy. This field is populated by the press from the `CardDocument` it just assembled — no extra work is required at issuance time. Lives inside the AEK-encrypted plaintext; exposed only to auditors. |
| `scip_cid` | `cid` | Yes | Links to the SCIP for this issuance |
| `issued_at` | `timestamp` | Yes | Must match the card's `issued_at` |
| `requester_card` | `card-pointer` | No | Present for targeted issuance; absent for open offer claims |
| `offer_type` | `text` | Yes | `"targeted"` or `"open"` |

**Binding and consistency check.** After decrypting the issued card at `card_cid`, the auditor SHOULD confirm `keccak256(recipient_pubkey)` equals the card's on-chain registry address (the card's mutable pointer in the registry). A mismatch indicates a malformed or forged record and MUST be flagged in the audit `findings`. Decryption success (AES-GCM authentication tag passes) also confirms the key is correct — an authentication failure is likewise a hard rejection and MUST be flagged.

---

## 12. AuditEpochEntry

**Stored on:** IPFS, within the policy card's append-only press log  
**Written by:** Press (at epoch open and epoch close)  
**Signed by:** Press sub-card key

Posted to the policy log at the start and end of each audit epoch. On open, it distributes the epoch AEK wrapped under each active auditor's ML-KEM public key. On close, it records the epoch's `AuditEpochCommitment` CID and cards the epoch as permanently closed.

```json
{
  "type":           "audit_epoch_entry",
  "status":         "open | closed",
  "epoch_id":       "<string — e.g. '2026' for annual epochs, or sequential integer>",
  "epoch_start":    "<ISO 8601 timestamp — set on open; null on close>",
  "epoch_end":      "<ISO 8601 timestamp — set on close; null on open>",
  "auditor_key_packages": [
    {
      "auditor_card":  "<base64url — mutable pointer of the auditor's card>",
      "kem_ciphertext": "<base64url — ML-KEM.Encaps(auditor_pubkey) ciphertext; 1088 bytes for ML-KEM-768>",
      "wrapped_aek":    "<base64url — AES-GCM.Encrypt(HKDF-SHA3-256(kem_shared_secret), AEK)>"
    }
  ],
  "commitment_cid": "<base64url — CID of the AuditEpochCommitment on IPFS; present only when status is 'closed'>",
  "close_reason":   "<text — 'calendar_boundary' | 'key_rotation' | 'auditor_change'; present only when status is 'closed'>",
  "press_signature": "<ML-DSA-44 signature over canonical RFC 8785 JSON of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | Always `"audit_epoch_entry"` |
| `status` | `text` | Yes | `"open"` when starting an epoch; `"closed"` when recording epoch closure |
| `epoch_id` | `text` | Yes | Unique per epoch within a policy; convention is ISO year string for annual epochs |
| `epoch_start` | `timestamp` | On open | UTC timestamp when this epoch began |
| `epoch_end` | `timestamp` | On close | UTC timestamp when this epoch closed |
| `auditor_key_packages` | `array` | On open | One entry per active auditor; empty array on close entry |
| `auditor_key_packages[].auditor_card` | `card-pointer` | Yes (per package) | Identifies the auditor |
| `auditor_key_packages[].kem_ciphertext` | `bytes` | Yes (per package) | ML-KEM.Encaps output; auditor decapsulates with their private key to recover `kem_shared_secret` |
| `auditor_key_packages[].wrapped_aek` | `bytes` | Yes (per package) | AEK wrapped under `HKDF-SHA3-256(kem_shared_secret, "audit-epoch-aek-v1")`; 32-byte AEK + 12-byte nonce + 16-byte GCM tag |
| `commitment_cid` | `cid` | On close | Points to the `AuditEpochCommitment` IPFS document |
| `close_reason` | `text` | On close | Why the epoch closed; informational |
| `press_signature` | `SignatureEntry` | Yes | Binds all fields; signed with the press sub-card key |

The press must not generate issuance entries for an epoch after posting a `status: "closed"` entry for it.

---

## 13. AuditEpochCommitment

**Stored on:** IPFS (standalone document, not part of the policy log directly)  
**Written by:** Auditor  
**Signed by:** Auditor card key  
**Referenced by:** The `AuditEpochEntry` with `status: "closed"` in the policy log

The permanent audit record for a closed epoch. The auditor produces this document after decrypting all entries in the epoch, then destroys the epoch AEK. The commitment is the only remaining evidence of what the epoch contained; it is signed by the auditor and publicly verifiable.

```json
{
  "type":             "audit_epoch_commitment",
  "epoch_id":         "<string — matches the epoch_id in the corresponding AuditEpochEntry>",
  "policy_card":     "<base64url — mutable pointer of the policy card>",
  "auditor_card":    "<base64url — mutable pointer of this auditor's card>",
  "period_start":     "<ISO 8601 timestamp>",
  "period_end":       "<ISO 8601 timestamp>",
  "entry_count":      <integer>,
  "entries_hash":     "<base64url — SHA3-256 of the concatenated CIDs of all decrypted entries in log order>",
  "findings":         "<free text — summary of audit findings; 'no issues found' if clean>",
  "auditor_signature": "<ML-DSA-44 signature over canonical RFC 8785 JSON of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | Always `"audit_epoch_commitment"` |
| `epoch_id` | `text` | Yes | Must match the epoch being committed |
| `policy_card` | `card-pointer` | Yes | Identifies the policy this commitment covers |
| `auditor_card` | `card-pointer` | Yes | Identifies the signing auditor |
| `period_start` | `timestamp` | Yes | Must match the `epoch_start` from the opening `AuditEpochEntry` |
| `period_end` | `timestamp` | Yes | Must match the `epoch_end` from the closing `AuditEpochEntry` |
| `entry_count` | `integer` | Yes | Number of `PressIssuanceRecord` entries decrypted; enables detection of missing entries |
| `entries_hash` | `bytes` | Yes | SHA3-256(concat of all entry CIDs in log order); a verifier with the raw entries can confirm the auditor processed all of them |
| `findings` | `text` | Yes | Human-readable audit summary; required even if empty |
| `auditor_signature` | `SignatureEntry` | Yes | Binds all fields; signed with the auditor's card key |

The `entries_hash` is a completeness commitment: it proves the auditor saw all entries in sequence and did not skip any. A verifier who later obtains the decrypted entries (through any channel) can recompute the hash and confirm it matches the commitment. The commitment does not prove the auditor correctly classified each entry — it proves they processed them.

---

## 14. CardEntry (on-chain)

**Stored on:** Arbitrum One (on-chain)  
**Written by:** Press sub-card key (verified on-chain via secp256r1 / RIP-7212 precompile in Phase 1; upgradeable to ML-DSA-44 via ADR-012 upgrade path)  
**Authoritative spec:** `specs/object_specs/registry_contract.md §3` — that document takes precedence over this section for all implementation details.

The on-chain records managed by the Card registry contract. Not JSON documents — this is the conceptual structure of the Stylus contract state.

**Per-card entry** (`CardEntries` mapping, keyed by `card_address`):

```
CardEntry {
    log_head_cid       bytes    — Current IPFS log head CID, stored as plaintext CID bytes.
                                  Updated on every successful RegisterCard or UpdateCardHead call.

    policy_address     bytes32  — On-chain registry address of the policy card under which
                                  this card was issued. Set at RegisterCard time; immutable
                                  thereafter. Used by the write gate to look up
                                  PressAuthorizations[policy_address, press_address].

    last_press_address bytes32  — On-chain registry address of the press sub-card whose key
                                  signed the most recent write (RegisterCard or UpdateCardHead).
                                  Updated on every successful write. Provides an on-chain
                                  attribution trail independent of IPFS content.

    exists             bool     — True once the entry has been created by RegisterCard;
                                  used to distinguish unregistered addresses from cards
                                  whose log_head_cid is empty.
}
```

**Address derivation** (client-side; not enforced by the contract): a card's address is always `keccak256(recipient_pubkey)`. There is a single public derivation — no private/secret-derived addresses (see `ARCHITECTURE.md` ADR-006).

**Write authorization:** A write to `log_head_cid` requires a valid secp256r1 signature (r||s, 64 bytes) from a press whose key is registered in the on-chain `PressAuthorizations` table for the card's `policy_address`. The contract verifies this signature via the RIP-7212 precompile before accepting the write. The press also registers an `mldsa44_key_hash` at authorization time to support the future on-chain key scheme upgrade to ML-DSA-44 (see ADR-012 in `ARCHITECTURE.md`). Note: the `recipient_pubkey` in the IPFS-stored `CardDocument` is always ML-DSA-44 (IPFS identity key) — the secp256r1 key is a separate on-chain-only authorization key. (Note: the IPFS-stored `approved_presses` field in the policy card is an audit surface kept in sync with on-chain state; in the event of a discrepancy, on-chain state is authoritative — see ADR-011 in `ARCHITECTURE.md`.)

**Open offer counter table** (`OpenOfferUseCounts` mapping, keyed by offer ID):

```
OpenOfferUseCounts (mapping: bytes32 → uint64)
  offer_id   (bytes32)  — hash(canonical RFC 8785 JSON of the complete OpenCardOffer document
                           including issuer_signature); lazily initialized on first use
  use_count  (uint64)   — number of accepted claims; atomically incremented on each
                           successful card registration under this offer
```

The press verifies the issuer's ML-DSA-44 signature over the offer payload before submitting any transaction (press-side pre-flight; see `registry_contract.md §4.5`). The contract then performs the following checks atomically with card registration: (1) verifies the press's secp256r1 signature via RIP-7212; (2) confirms `block.timestamp < expires_at` (skipped if `expires_at` is null); (3) confirms `OpenOfferUseCounts[offer_id] < max_acceptances` (skipped if `max_acceptances` is null); (4) atomically increments the counter and registers the card. If any check fails, the transaction reverts.

For the full storage layout, write operations, read operations, governance tables, events, and error codes, see `specs/object_specs/registry_contract.md`.

---

## 15. SubCardRegistration

**Stored on:** Arbitrum One (on-chain)  
**Written by:** Press (authorized for the card's policy), on behalf of the holder — see `registry_contract.md §4.3` for the authoritative on-chain schema, preconditions, and state changes. §15 here is a high-level summary only.  
**IPFS document:** See §16 (SubCardDocument) for the full off-chain record; §15 describes only the on-chain registration entry.

Maps a sub-card's registry address to the holder's master card address, a CID pointer to the IPFS SubCardDocument, and a snapshot of the master card's log head at registration time (for scope-attenuation checks). The on-chain entry does **not** store the app card address — that lives in the IPFS `SubCardDocument` (§16) along with the app's signature and public key.

**App-chain verification is press-side, not on-chain.** Before submitting `RegisterSubCard`, the press fetches the `SubCardDocument` from IPFS, verifies `app_signature`, and walks the `app_card` chain to confirm it reaches the governance authority's app-certification policy root. The contract stores only the `sub_card_doc_cid` pointer to that document; no app-chain check runs on-chain. Runtime verifiers rely on the press having completed this check at registration time and do not re-walk the app-certification chain independently (see §16 Verifier chain walk for runtime verifier responsibilities).

**Note on parent public keys:** The on-chain entry stores only the *address* (`master_card_address`) of the holder's master card — not its public key. The ML-DSA-44 public keys needed to decrypt the master and app cards and walk their chains are carried in the IPFS `SubCardDocument` (§16) as `holder_primary_card_pubkey` and `app_card_pubkey`. Verifiers read those fields from the decrypted sub-card document and apply the keccak256 binding check before using them.

```
SubCardEntry (on-chain) {
  master_card_address    — Registry address of the holder's master (primary) card.
  registration_log_head  — Log head CID of the master card at registration time;
                           used for scope-attenuation verification.
  sub_card_doc_cid       — CID of the SubCardDocument stored on IPFS; points to the
                           full off-chain record containing app_card, app_card_pubkey,
                           app_signature, holder_signature, capabilities, and all
                           other sub-card metadata.
  active                 — True until DeregisterSubCard is called.
  registered_at          — Unix timestamp of registration.
  deregistered_at        — Unix timestamp of deregistration; 0 if still active.
}
```

| Field | Type | Notes |
|---|---|---|
| `master_card_address` | `bytes32` | Registry address of the holder's master card; establishes the delegation chain |
| `registration_log_head` | `bytes` | CID snapshot of master card log state at registration; used for scope-attenuation verification |
| `sub_card_doc_cid` | `bytes` | CID of the `SubCardDocument` on IPFS; contains `app_card`, `app_card_pubkey`, `app_signature`, `holder_signature`, and all other sub-card metadata. The app card address is **not** on-chain — it is in this document. |
| `active` | `bool` | True until `DeregisterSubCard` is called |
| `registered_at` | `uint64` | Unix timestamp of registration |
| `deregistered_at` | `uint64` | Unix timestamp of deregistration; 0 if still active |

---

## 16. SubCardDocument

**Stored on:** IPFS  
**Signed by:** App card key (first), then Holder primary card key (countersignature)  
**Serialized for signing:** Canonical RFC 8785 JSON of the full document (offer phase: without `app_signature` and `holder_signature`; countersign phase: including `app_signature`, without `holder_signature`; final: complete)

The genesis document for a sub-card — a device-bound, app-specific credential that delegates a scoped subset of a holder's signing authority to a specific application. A `SubCardDocument` is initiated and first-signed by the **requesting app** using its own app card key, then countersigned by the **holder** using their primary card key (authorizing the delegation). A **press** also participates: after both signatures are in place, the press verifies the app-certification chain off-chain and submits `RegisterSubCard` on-chain (see `registry_contract.md §4.3`). The holder/wallet is the delegating party; the press is the on-chain registration party.

```json
{
  "holder_primary_card":        "<base64url — mutable pointer of the holder's primary card>",
  "holder_primary_card_pubkey": "<base64url — ML-DSA-44 public key of the holder's primary card, 1312 bytes raw>",
  "app_card":                   "<base64url — mutable pointer of the requesting app's card>",
  "app_card_pubkey":            "<base64url — ML-DSA-44 public key of the app's card, 1312 bytes raw>",
  "capabilities":               ["<message type string>", "..."],
  "recipient_pubkey":           "<base64url — sub-card ML-DSA-44 public key, 1312 bytes raw>",
  "issued_at":                  "<ISO 8601 timestamp>",
  "valid_until":                "<ISO 8601 timestamp — optional; absent means no expiry>",
  "attestation_level":          "T2 | T1",
  "attestation_proof":          "<base64url — App Attest / Play Integrity assertion scoped to recipient_pubkey hash; omitted if attestation_level is T1>",
  "app_signature":              "<base64url — app card key ML-DSA-44 signature over canonical RFC 8785 JSON of document without both signature fields>",
  "holder_signature":           "<base64url — holder primary card key ML-DSA-44 signature over canonical RFC 8785 JSON of document including app_signature, without holder_signature>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `holder_primary_card` | `card-pointer` | Yes | Mutable pointer of the card this sub-card delegates from; establishes the chain-of-trust link on verification |
| `holder_primary_card_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `holder_primary_card`. **Untrusted hint**: the verifier MUST confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address before using it to derive a content key or verify a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Set at sub-card issuance; covered by both `app_signature` and `holder_signature`. |
| `app_card` | `card-pointer` | Yes | Mutable pointer of the requesting app's card; must chain to the governance authority's app-certification policy |
| `app_card_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `app_card`. **Untrusted hint**: the verifier MUST confirm `keccak256(app_card_pubkey)` equals the `app_card` pointer address before using it to derive a content key or verify a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Set at sub-card issuance; covered by both `app_signature` and `holder_signature`. |
| `capabilities` | `array of text` | Yes | Whitelist of message type strings this sub-card may sign (e.g. `["auth_response", "exchange_offer"]`). An empty array is valid but non-functional. |
| `recipient_pubkey` | `base64url` | Yes | ML-DSA-44 public key generated in device hardware-backed secure storage; 1312 bytes raw |
| `issued_at` | `timestamp` | Yes | Set by the app at document assembly time |
| `valid_until` | `timestamp` | No | Optional expiry; verifiers must reject signatures from expired sub-cards |
| `attestation_level` | `text` | Yes | `"T2"` (full app attestation; default and required) or `"T1"` (hardware-backed key storage only; permitted only if the governing policy explicitly accepts it). See `subcards.md §Attestation Tiers`. |
| `attestation_proof` | `base64url` | Conditional | Present when `attestation_level` is `"T2"`: the platform attestation assertion (iOS App Attest certificate / Android Play Integrity token) scoped to the hash of `recipient_pubkey`. Omitted when `attestation_level` is `"T1"`. |
| `app_signature` | `base64url` | Yes | App's card key signature over canonical RFC 8785 JSON of the document without `app_signature` or `holder_signature`. Covers `holder_primary_card_pubkey` and `app_card_pubkey`. |
| `holder_signature` | `base64url` | Yes | Holder's primary card key signature over canonical RFC 8785 JSON of the document including `app_signature`, without `holder_signature`. Covers `holder_primary_card_pubkey` and `app_card_pubkey`. |

**Serialized for signing:** Canonical RFC 8785 JSON. `app_signature` covers all fields except `app_signature` and `holder_signature` (both `holder_primary_card_pubkey` and `app_card_pubkey` are present and included). `holder_signature` covers all fields including `app_signature`, except `holder_signature` (both `holder_primary_card_pubkey` and `app_card_pubkey` are present and included).

**Signing sequence:**

1. App generates a fresh ML-DSA-44 keypair in device hardware-backed secure storage → `recipient_pubkey`. The private key is scoped to the app's signing identity; it cannot be exported.
2. App requests an attestation assertion scoped to `hash(recipient_pubkey)` from the platform (iOS App Attest / Android Play Integrity for T2; or skips for T1) → `attestation_proof`.
3. App assembles the document with all fields — including `holder_primary_card_pubkey` (the ML-DSA-44 public key of the holder's primary card) and `app_card_pubkey` (the ML-DSA-44 public key of the app's card) — except the two signature fields.
4. App signs canonical RFC 8785 JSON of that document → `app_signature`. Both `holder_primary_card_pubkey` and `app_card_pubkey` are present and covered by this signature.
5. App sends the partially-signed document to the wallet.
6. Wallet verifies `app_signature`, confirms `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address and `keccak256(app_card_pubkey)` equals the `app_card` pointer address (binding checks), walks the `app_card` chain using `app_card_pubkey` to confirm it chains to the governance authority's app-certification policy root, and verifies the `attestation_proof` (or confirms T1 is policy-permitted if `attestation_level` is `"T1"`).
7. Wallet presents to the user: app identity (from `app_card`), requested `capabilities`, and optional `valid_until`. User approves or denies.
   - **Wallet self-signing exception:** When the wallet is the requesting app (i.e. `app_card` is the wallet's own card), step 7 is skipped. The user already trusts the wallet with their primary key.
8. Holder's primary card key signs canonical RFC 8785 JSON of the document including `app_signature`, without `holder_signature` → `holder_signature`. Both `holder_primary_card_pubkey` and `app_card_pubkey` are present and covered by this signature.
9. Completed SubCardDocument is posted to IPFS.
10. Sub-card is registered on Arbitrum One via `RegisterSubCard` (see §15).

**Verifier chain walk (runtime).** A verifier encountering a signature from a sub-card must: (1) confirm the message type appears in the sub-card's `capabilities`; (2) confirm `valid_until` has not passed; (3) verify `app_signature` is valid; (4) verify `holder_signature` is valid; (5) read `holder_primary_card_pubkey` from the decrypted sub-card document; (6) confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address — if the addresses do not match, reject; (7) derive the master card's content key as `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")` and decrypt the master card from IPFS — if AES-GCM authentication fails, reject; (8) confirm the sub-card appears in the master card's active sub-card list; (9) walk the holder's master card chain to a trusted root using the master card's `ancestry_pubkeys` (Stage 3 of `card_validation.md`); (10) confirm the sub-card is not revoked in the on-chain registry (check `SubCardRegistrations[sub_card_address].active`); (11) confirm `attestation_level` is `"T2"` unless the governing policy explicitly accepts `"T1"`.

**App-certification chain: press-side, not runtime.** Runtime verifiers do NOT independently walk the `app_card` chain to the governance app-certification policy root. That walk is performed **by the press at registration time** (before the press submits `RegisterSubCard`) — the press verifies `app_card_pubkey`, applies the keccak256 binding check, decrypts the app card, and walks `app_card`'s `ancestry_pubkeys` to confirm it reaches the governance authority's app-certification root. Runtime verifiers trust that the press completed this check; the `sub_card_doc_cid` on the on-chain `SubCardEntry` (§15) is the on-chain evidence that the press reviewed and accepted the document. The `app_card_pubkey` field is still present and covered by both signatures — it is needed by the press at registration time and may be used by auditors; it is NOT re-walked by runtime verifiers. Per-link on-chain addresses remain authoritative; `holder_primary_card_pubkey` and `app_card_pubkey` are untrusted hints whose validity is established by the binding check before use.

---

## Object Relationship Summary

```
PolicyCardDocument (IPFS)
  └── approved_presses → [CardDocument (press sub-card)] (IPFS)
  └── auditors → [CardDocument (auditor card)] (IPFS)
  └── policy press log → [PressIssuanceRecord (encrypted)] (IPFS)
       └── card_cid → CardDocument (issued card) (IPFS)
       └── scip_cid → SCIP (IPFS)

CardDocument (IPFS)
  └── policy_id → PolicyCardDocument (IPFS)
  └── press_card → CardDocument (press sub-card) (IPFS)
  └── card log → [LogEntry (IPFS, chained via prev_log_root)]
  └── sub-cards → SubCardRegistration (Arbitrum One) → SubCardDocument (IPFS)
       └── sub-card keys → SignatureEntry (in SignedMessageEnvelope / AuthRequest / LogEntry)

SubCardDocument (IPFS)
  └── holder_primary_card → CardDocument (holder's primary card) (IPFS + Arbitrum One)
  └── app_card → CardDocument (app's card) (IPFS + Arbitrum One)
       └── policy_id → app-certification PolicyCardDocument (governance root) (IPFS)
       └── app-certification chain walk: performed by PRESS at registration; not by runtime verifiers
  └── on-chain registration → SubCardEntry (Arbitrum One)
       └── master_card_address → holder's master card (Arbitrum One)
       └── sub_card_doc_cid → SubCardDocument (IPFS) [this document — the CID pointer back to here]

OpenCardOffer (HTTPS / IPFS)          — issuer-side
  └── policy_id → PolicyCardDocument (IPFS)
  └── press_card → CardDocument (press sub-card) (IPFS)
  └── issuer_card → CardDocument (issuer's master card) (IPFS)
  └── claimed via → OpenOfferClaimSubmission (in-transit to press)
       └── → CardDocument (issued card) (IPFS, assembled by press)
       └── → offer_id entry in openOfferUseCounts (Arbitrum One)

CardEntry (Arbitrum One)
  └── log_head_cid → CardDocument | LogEntry (IPFS, current head)
  └── policy_address → policy CardEntry (Arbitrum One)
  └── last_press_address → press sub-card CardEntry (Arbitrum One)
  └── OpenOfferUseCounts[offer_id] → acceptance counter
```

---

## Serialization Quick Reference

Objects marked **RFC 8785-signed** use canonical RFC 8785 JSON per Appendix A of `card_protocol_spec.md` as the byte sequence over which signatures are computed. Objects marked **JSON** use standard JSON (no canonical form required).

| Object | Storage | Signing serialization |
|---|---|---|
| CardDocument | IPFS | RFC 8785-signed (offer phase, then complete); `ancestry_pubkeys` is in the signed payload for all three signatures |
| PolicyCardDocument | IPFS | RFC 8785-signed (same as CardDocument); `ancestry_pubkeys` is required and in the signed payload |
| LogEntry | IPFS | RFC 8785-signed (`intent_signature` over UpdateIntentPayload; `press_signature` over complete LogEntry) |
| UpdateIntentPayload | In-transit | RFC 8785-signed |
| SignedMessageEnvelope | In-transit | RFC 8785-signed (payload only) |
| OpenCardOffer | HTTPS / IPFS | RFC 8785-signed (all except `issuer_signature`) |
| OpenOfferClaimSubmission | In-transit (HTTPS POST to press) | `recipient_signature` covers canonical RFC 8785 JSON of `claim_payload`; `claim_payload.offer.issuer_signature` separately verified by press |
| AuthenticationRequest | HTTPS | RFC 8785-signed (all except `request_signature`) |
| AuthenticationResponse | In-transit | Not signed as a whole; contains a SignedMessageEnvelope |
| SCIP | In-transit / IPFS | RFC 8785-signed (all except `press_signature`) |
| PressIssuanceRecord | IPFS (encrypted) | Not signed; encrypted via ML-KEM |
| CardEntry | Arbitrum One | On-chain; write authorized by secp256r1 sig verified via RIP-7212 precompile against `PressAuthorizations` table |
| SubCardRegistration | Arbitrum One | On-chain; stores `master_card_address`, `registration_log_head`, `sub_card_doc_cid` (CID of IPFS SubCardDocument). Write authorized by press secp256r1 sig (§6.1 write gate); master card holder ML-DSA-44 sig verified off-chain by press; app-certification chain walk also performed off-chain by press before submission. |
| SubCardDocument | IPFS | RFC 8785-signed (`app_signature` over all fields except both signature fields; `holder_signature` over all fields including `app_signature`); `holder_primary_card_pubkey` and `app_card_pubkey` are present and covered by both signatures |
