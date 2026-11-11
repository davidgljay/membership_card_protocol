# Card Protocol — Object Reference

**Version:** 0.2 (draft)  
**Date:** 2026-06-14  
**Status:** In Review  
**Amended 2026-11-08 (card login):** §8–9 rewritten as v2 (server-card-signed request, DCQL `mcard` query, `form_post`/`mcard_message` response modes); new §17 `DomainBindingAttestation`, §18 `LoginServiceMetadata`, §19 `WalletRegistrationToken`; §1.1 gains `domain_binding`; §2 gains `preferred_services`; §16 gains attestation level `S1` and the login service scope rule. See `process_specs/card_login.md`.  
**Amended 2026-10-23:** §11 `PressIssuanceRecord` gains `issuer_card`, `policy_id`, and `offer_id`, and is delivered to the issuer and the policy card's holder as well as to auditors; §10 SCIP no longer has an administrator courtesy copy.  
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
16. [SubCardDocument](#16-subcarddocument)
17. [DomainBindingAttestation](#17-domainbindingattestation)
18. [LoginServiceMetadata](#18-loginservicemetadata)
19. [WalletRegistrationToken](#19-walletregistrationtoken)

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
  "active_subcards": [
    "<base64url — ML-DSA-44 public key of an active sub-card, 1312 bytes raw>",
    "..."
  ],
  "ancestry_pubkeys": [
    "<base64url — ML-DSA-44 public key of the immediate parent (issuer card), 1312 bytes raw>",
    "<base64url — ML-DSA-44 public key of the next ancestor up the issuer chain>",
    "...",
    "<base64url — ML-DSA-44 public key of the press card>",
    "<base64url — ML-DSA-44 public key of the press card's issuer (policy card holder), if applicable>",
    "..."
  ],
  "holder_signature":  "<base64url — holder's ML-DSA-44 countersignature over the offer including recipient_pubkey (excludes holder_signature, press_signature)>",
  "issued_at":         "<ISO 8601 timestamp>",
  "issuer_card":       "<base64url — mutable pointer in registry of the offerer (issuer) who constructed the offer>",
  "issuer_signature":  "<base64url — offerer's ML-DSA-44 signature over canonical RFC 8785 JSON of the offer (excludes recipient_pubkey, holder_signature, press_signature)>",
  "past_keys": [
    {
      "pubkey":      "<base64url — ML-DSA-44 public key that was previously the recipient_pubkey, 1312 bytes raw>",
      "valid_from":  "<ISO 8601 — start of validity window for this key (typically the issued_at of the card that first used it)>",
      "rotated_at":  "<ISO 8601 — timestamp at which this key was superseded by the next key in the chain>"
    }
  ],
  "policy_id":         "<base64url — CID of the governing policy card>",
  "press_card":        "<base64url — mutable pointer in registry of the press sub-card that validated and registered this card>",
  "press_signature":   "<base64url — press's ML-DSA-44 signature over the complete countersigned document (excludes press_signature), applied last after validation>",
  "protocol_version":  "<string — protocol version in force at issuance, e.g. '0.1'; read from the logic contract via getProtocolVersion()>",
  "recipient_pubkey":  "<base64url — recipient's ML-DSA-44 public key, 1312 bytes raw>",

  "<policy-defined fields>": "..."
}
```

> **RFC 8785 field ordering note:** The JSON example above lists fields in their RFC 8785 canonical order (lexicographic by Unicode code point). The `protocol_version` field sorts between `press_signature` (`press_s` < `proto`) and `recipient_pubkey` (`proto` < `r`). The `active_subcards` field, when present, sorts before `ancestry_pubkeys` (`active_s` < `ancest`). Signing tools that construct the object and then canonicalize it do not need to insert fields in this order — RFC 8785 re-sorts regardless of construction order.

| Field | Type | Required | Mutable | Notes |
|---|---|---|---|---|
| `active_subcards` | `array of base64url` | No | Yes — codes 510, 511, 512 only | Flat array of ML-DSA-44 public keys (1312 bytes each, base64url) of the holder's currently-active sub-cards. **Not present at genesis** (see §1.1 for the protocol-reserved-field definition); absence means no active sub-cards, not an empty array — though once the field has been added by a code-510 entry, it is legal for it to be `[]` after all sub-cards are removed (the field itself is not deleted by removal, only its entries). Added, modified, and removed only via codes 510 (addition), 511 (removal), 512 (key rotation), each hardcoded to holder-only authorization (`{ "is_holder": true }`), not overridable by any policy's `field_definitions` or `update_policy`. See §1.1. |
| `policy_id` | `cid` | Yes | No | Pinned to the policy at time of issuance |
| `issuer_card` | `card-pointer` | Yes | No | The offerer who constructed and first-signed the offer; used to evaluate `requester_predicate` and verify `issuer_signature` |
| `press_card` | `card-pointer` | Yes | No | Identifies the press that validated and registered the card; used to walk the authorization chain |
| `protocol_version` | `string` | Yes | No | Protocol version string in force at the time of issuance (e.g. `"0.1"`). Set by the press: the press reads `getProtocolVersion()` from the logic contract and includes the returned value in the assembled card document. Covered by all three signatures. Verifiers reject cards whose `protocol_version` is not in their known-versions list. |
| `recipient_pubkey` | `base64url` | Yes | No | Added by holder before countersigning; empty in the offer phase |
| `issued_at` | `timestamp` | Yes | No | Set by the offerer at offer construction |
| `ancestry_pubkeys` | `array of base64url` | Yes | No | Ordered array of ML-DSA-44 public keys (1312 bytes each, base64url) for every ancestor card a verifier must resolve to walk this card's chain to a trusted root. Ordered from immediate parent (the issuer card's public key) up toward the root, covering the issuer chain and the press/policy chain as applicable. Set at issuance; covered by all three signatures. **Root base case:** a card whose own address is a registered trusted root (present in the on-chain `PolicyAuthorizerKeys` table) carries `ancestry_pubkeys: []` — the empty array. `[]` is a legal, signed value; omission of the field is a schema violation. A card whose immediate parent is a registered trusted root likewise carries `[]` (the parent is already the termination point). **This field is always present.** This is an **untrusted hint**: the verifier MUST confirm `keccak256(entry_pubkey)` equals the on-chain address it is resolving for each entry; a wrong or forged pubkey yields an address mismatch or an undecryptable ciphertext and MUST be rejected. Per-link on-chain addresses remain authoritative. |
| `past_keys` | `array of objects` | No | No | **Present only on cards produced by a master key rotation** (i.e., cards whose `recipient_pubkey` is a newly generated key replacing a prior key). Absent when inapplicable — a card that has never been the product of a rotation **omits `past_keys` entirely** (protocol convention: absent optional fields must be omitted from the document, not set to `null` or `[]`; the RFC 8785 canonicalizer does not strip `null` values, so `null` in the document would produce different bytes than omission). When present, lists all prior public keys the same holder controlled, **oldest-first**, each with its validity window: `{ "pubkey": "<base64url ML-DSA-44 public key, 1312 bytes>", "valid_from": "<ISO 8601>", "rotated_at": "<ISO 8601>" }`. `valid_from` is the `issued_at` of the first card that used that key; `rotated_at` is the timestamp at which that key was superseded by the next. A holder of the current `recipient_pubkey` can use each `past_keys` entry to derive the content key (`HKDF-SHA3-256(entry.pubkey, info="card-content-v1")`) for log entries produced during that key's validity window. **Provenance:** `past_keys` represents the **holder's** own key history. During a master-key rotation, the holder/wallet supplies their prior-key history to the offerer as part of the rotation request; the offerer includes it verbatim in the assembled offer. The **holder is the authority on their own key history**: although `past_keys` appears in the `issuer_signature` payload (because it is present in the assembled offer the offerer signs), the authoritative attestation is the `holder_signature` — the holder explicitly countersigns, confirming the listed prior keys are their own. `issuer_signature` and `press_signature` also cover the bytes (neither excludes `past_keys`). `past_keys` is immutable after issuance. **Signing coverage:** included in the `issuer_signature` payload (excludes `recipient_pubkey`, `holder_signature`, `press_signature`), the `holder_signature` payload (excludes `holder_signature`, `press_signature`), and the `press_signature` payload (excludes `press_signature` only). `past_keys` is **not** in any exclusion list. See `key_rotation.md §2.3` for full semantics. |
| `issuer_signature` | `base64url` | Yes | No | Offerer signs the offer (all fields except `recipient_pubkey`, `holder_signature`, `press_signature`) |
| `holder_signature` | `base64url` | Yes | No | Holder signs the offer plus `recipient_pubkey` (all fields except `holder_signature`, `press_signature`) |
| `press_signature` | `base64url` | Yes | No | Press signs the complete countersigned document (all fields except `press_signature`), applied last after validating policy compliance |
| `supersedes` | `card-pointer` | No | No | Present only on un-revocation cards: the mutable pointer of the prior card this card corrects. Set by the issuer at genesis. See `card_protocol_spec.md §Background`. |
| `supersession_note` | `text` | No | No | Human-readable explanation of why this card supersedes the one pointed to by `supersedes`. Present only when `supersedes` is set. |

**Signing sequence (three parties, fixed order):**
1. The **offerer's wallet service** assembles the document with all policy-defined fields, `issuer_card`, `press_card`, `issued_at`, `ancestry_pubkeys` (the ordered array of ancestor ML-DSA-44 public keys, from immediate parent toward root), and `past_keys` if applicable (present and oldest-first when this card is the product of a master key rotation; omitted otherwise), leaving `recipient_pubkey`, `holder_signature`, `press_signature`, and `protocol_version` absent. (`protocol_version` is added by the press in step 5 — the offerer does not know which version the press will attest to.)
2. The offerer signs canonical RFC 8785 JSON of that offer with the offerer's card key → `issuer_signature`. `ancestry_pubkeys` and `past_keys` (if present) are covered by this signature. `recipient_pubkey` and `protocol_version` are excluded (not yet present).
3. The offer is presented to the recipient, who reviews, generates a fresh ML-DSA-44 keypair, adds `recipient_pubkey`, and signs canonical RFC 8785 JSON of the offer-plus-pubkey → `holder_signature`. `ancestry_pubkeys` and `past_keys` (if present) are covered by this signature. `protocol_version` is excluded (not yet present).
4. The offerer validates the countersigned result (confirms the recipient countersigned the intended offer).
5. The countersigned card is sent to the **press**, which calls `getProtocolVersion()` on the logic contract to obtain the current protocol version string, adds `protocol_version` to the document, validates policy compliance, signs canonical RFC 8785 JSON of the complete document (including `protocol_version`) with its press sub-card key → `press_signature`, posts it to IPFS encrypted under the ADR-006 content key, and registers it on-chain. `ancestry_pubkeys`, `past_keys` (if present), and `protocol_version` are all covered by `press_signature`.

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
| `active_subcards` | `array of base64url` | Codes 510, 511, 512: `{ "is_holder": true }`, hardcoded — **not policy-configurable, not overridable by any policy's `field_definitions` or `update_policy`.** This is a hard protocol limit for this version of the protocol, not a default that policies may loosen or tighten. | 510, 511, 512 | Flat array of the holder's currently-active sub-card ML-DSA-44 public keys (1312 bytes each). Not present at genesis; added by the first code-510 entry. Entries are deleted outright from the array on removal (code 511) or rotation (code 512) — the array always reflects the live/current set; historical additions and removals are recorded permanently in the master card's append-only log, not in the field itself. See `subcards.md` and `update_codes.md §5xx`. |

| `domain_binding` | `DomainBindingAttestation` (§17) | Code 520: `{ "is_holder": true }`, hardcoded, **plus** a valid attestation (§17) naming this card. Not policy-configurable. | 520 | Binds a **login service card** (a card under the login service branch, `subcards.md §Server Cards`) to a DNS domain for card login. Set at most once; immutable once set. To change domains, the site operator gets a new login service card. A press rejects code 520 on a card not under the login service branch. See `process_specs/card_login.md` Phase 0. |

A code-102 `successor` entry carries a `pending_until` field and is not effective until that timestamp is reached without a holder-submitted code-103 cancellation. See `key_rotation.md §2.6`.

**Codes 510/511/512 scope.** These three codes apply only to `LogEntry` records on the **master (primary) card's own log** — they record changes the holder makes to their own `active_subcards` directory. This is distinct from the general prohibition on 5xx updates targeting a **sub-card's** log, which remains prohibited per `process_specs/subcard_creation_policy.md §Update Card Content`. A code-510/511/512 entry is never posted to a sub-card's log; it is always posted to the master card's log by the master card's own holder key.

- **Code 510 (subcard addition):** `field_updates` sets `active_subcards` to the current array plus one new pubkey (or, if the field is absent, initializes it to a single-element array).
- **Code 511 (subcard removal):** `field_updates` sets `active_subcards` to the current array with exactly one pubkey deleted.
- **Code 512 (subcard key rotation):** `field_updates` sets `active_subcards` to the current array with exactly one old pubkey replaced by exactly one new pubkey in a single atomic entry (not a separate 511 + 510 pair) — see `registry_contract.md` for the corresponding on-chain rotation path.

In all three cases, the press and every verifier reject the entry unless it is signed by the card's own holder key, regardless of what the governing policy's `update_policy` states — the authorization predicate above is hardcoded and takes precedence over any policy-supplied value for this field.

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
  "preferred_services":  [
    { "origin": "<https origin>", "name": "<text>", "icon": "<cid — optional>", "description": "<text — optional>" }
  ],
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
| `auditors` | `card-pointer-array` | No | Card addresses that the press notifies at issuance time by delivering a `PressIssuanceRecord` via E2E encrypted message. See `PressIssuanceRecord` §11 and press spec §5.6. |
| `approved_presses` | `card-pointer-array` | No | Presses whose sub-card pointers may write to this policy's cards |
| `valid_until` | `timestamp` | No | Press rejects issuance requests after this time |
| `allow_open_offers` | `boolean` | No | Default `false`; must be `true` to permit open card offers under this policy |
| `revocation_permissions` | object | No | Predicates controlling who may post 8xx and 9xx entries; defaults to holder-or-issuer for 8xx, issuer-only for 9xx |
| `notes` | `append-only-array` of `text` | No | Append-only annotations |
| `policy_creation` | object | No | Constraints on policies that holders of this policy's cards may create |
| `preferred_services` | `service-array` | No | Services card holders can log in to (card login). **Absent** = inherit the nearest ancestor policy's list along the issuance chain (§8.1); **present, including `[]`** = this list replaces the inherited one. Entries: `origin` (`https:` origin, unique), `name`, optional `icon` (CID), optional `description`. Read from the live policy head. Updated with code 302. See `card_protocol_spec.md §1`. Added 2026-11-08. |

---

## 3. LogEntry

**Changelog:** Fix #7 (`plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`) — corrected the worked example's `"version"` value below to match this section's own rule that version 1 is the first post-genesis entry.

**Stored on:** IPFS (chained via `prev_log_root`; also self-describing via `history`)  
**On-chain pointer:** Arbitrum One registry entry for the card points to the current log head CID  
**Signed by:** Updater (`intent_signature`) then Press (`press_signature`)  
**Serialized for signing:**
- `intent_signature` covers canonical RFC 8785 JSON of the `UpdateIntentPayload` (see §4)
- `press_signature` covers canonical RFC 8785 JSON of the complete `LogEntry` document excluding the `press_signature` field itself

**Amended 2026-07-16** (see `plans/spec-consistency/`): a `LogEntry` now reposts the card's complete current field state (`card_state`) and carries a flat `history` array of every predecessor object's CID, rather than requiring a reader to walk `prev_log_root` backward one hop at a time to reconstruct current state or full provenance. `prev_log_root` is retained as the hash-chain integrity link (this entry cryptographically commits to the exact CID it supersedes); `history` is a convenience index over the same chain, always ending in `prev_log_root`'s own value.

Every post-genesis state change to a card — field updates, annotations, and revocations — is a LogEntry appended to the card's IPFS log. The log is a singly-linked list; each entry points back to the prior head via `prev_log_root`, and separately lists every prior CID in `history`. The Arbitrum One registry tracks only the current head CID.

```json
{
  "version":         1,
  "code":            300,
  "entry_type":      "field_update",
  "prev_log_root":   "<base64url — CID of the prior log entry (or genesis CardDocument for version 1)>",
  "history": [
    "<base64url — CID of the genesis CardDocument>",
    "<base64url — CID of LogEntry version 1>",
    "..."
  ],
  "card_state": {
    "<policy-defined field or protocol-reserved field>": "<its complete current value, post this entry's update>"
  },

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
| `prev_log_root` | `cid` | Yes | CID of the prior log entry; genesis CardDocument CID for `version == 1`. The hash-chain integrity anchor — this entry's signatures cover this value, so it cannot be forged after signing. |
| `history` | `array of cid` | Yes | Ordered oldest-first (genesis CID first), listing every predecessor IPFS object's CID for this card **excluding this entry's own CID** (which the reader derives after fetching). For `version == 1`, `history` is `["<genesis CardDocument CID>"]`, identical to `[prev_log_root]`. For every later version, `history = [...prior entry's history, prior entry's own CID]`, so its last element always equals this entry's own `prev_log_root`. Lets a reader reconstruct full provenance (every CID this card has ever had) from a single fetch of the current head, with no backward IPFS walk. See "Provenance verification" below for the on-chain cross-check. |
| `card_state` | object | Yes | The card's complete current field state — every policy-defined field plus any protocol-reserved field (`active_subcards`, `successor`, etc.) — with this entry's own `field_updates`/`revocation` already applied. Same field *set* as the genesis `CardDocument`'s policy-defined fields, but this object is not itself a `CardDocument`: it carries no `issuer_signature`/`holder_signature`/`press_signature`/`ancestry_pubkeys`/`recipient_pubkey` (those are genesis-only and immutable; see §1). Lets a reader learn a card's current values from the current head object alone, with no need to fold `field_updates` across every entry in the log. |
| `field_updates` | array | Conditional | Present for codes 1xx–7xx; absent for 8xx–9xx. Retained (alongside `card_state`) as the explicit, minimal record of exactly what this entry changed — useful for audit trails and for evaluating `update_policy` predicates against a single field's before/after, without diffing two full `card_state` snapshots. |
| `revocation` | object | Conditional | Present for codes 8xx–9xx; absent for 1xx–7xx |
| `revocation.effective_date` | `timestamp` | Yes (if revocation) | May predate the posting date |
| `revocation.note` | `text` | No | Human-readable context |
| `notify_holder` | `boolean` | Yes | Defaults to `true`; set `false` to suppress holder notification |
| `updater_message` | `text` | No | Forwarded to holder in the HTTPS notification |
| `intent_signature` | SignatureEntry | Yes | Updater's signature over the UpdateIntentPayload |
| `press_signature` | SignatureEntry | Yes | Press's signature over the complete LogEntry, including `history` and `card_state` |

**Code → entry_type mapping:**

| Code range | `entry_type` | `field_updates` | `revocation` |
|---|---|---|---|
| 1xx–7xx | `"field_update"` | Present | Absent |
| 8xx–9xx | `"revocation"` | Absent | Present |

**Provenance verification.** `history` is a claim made by the press that assembled and signed this `LogEntry` — it is not separately stored on-chain; the registry contract's `CardEntries` mapping (§14) still stores only the current `log_head_cid`, unchanged by this amendment. A verifier or auditor that needs cryptographic assurance the reported `history` is genuine (rather than trusting the press's self-consistency) reconstructs the ground-truth CID sequence by replaying that card's `CardRegistered` (genesis, `initial_log_cid`) and `CardHeadUpdated` (each subsequent entry, `new_log_cid`) events from the registry contract — both events are already emitted per write today (`registry_contract.md §7`) — and confirms the replayed sequence matches `history` plus this entry's own CID, in the same order. This is a strict-verification step for auditors and any verifier that must not merely trust the press; a reader fetching a single card only needs today's existing check (the on-chain `log_head_cid` matches the CID of the object actually fetched) to trust that object's content — `history`/`card_state` do not introduce a new mandatory on-chain check for routine reads.

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

**Hosted at:** Single-use HTTPS URL on the requesting site (the `request_uri`)  
**Signed by:** The requesting site's **server card** (a login-service-scoped sub-card — see §16 and `subcards.md §Server Cards`)  
**Serialized for signing:** Canonical RFC 8785 JSON of all fields except `request_signature`

The object a site creates when it wants a user to log in with a card. The site hosts it at a single-use `request_uri` and hands that URL to the user's wallet through the login router (`object_specs/login_router.md`), a QR code, or a `mcard://auth?r=<request_uri>` deep link. The wallet fetches it, validates it, and answers with an `AuthenticationResponse` (§9). Parameter names follow OpenID for Verifiable Presentations 1.0 (`state`, `nonce`, `response_mode`, `response_uri`, `dcql_query`, `wallet_nonce`), but the object is protocol-native: RFC 8785 JSON signed with ML-DSA-44, not a JWT. See `process_specs/card_login.md` for the full flow.

**Changed in v2 (2026-11-08):** replaces the v1 object. Removed: `session_id` (→ `state`), `requesting_site` (the wallet displays the verified `response_uri` origin instead), `payload` (→ top-level `statement`, `context`, `nonce`), `required_predicate` and `required_policy` (→ `dcql_query`), `callbacks` (→ `response_mode` + `response_uri`), and `redirect_uri` (the site redirects on `form_post`; the one-time code handles `mcard_message`). The CHAPI discovery path is removed. No implementation of v1 existed.

```json
{
  "context":           { "<optional display-only key>": "<text>" },
  "dcql_query": {
    "credentials": [
      {
        "id":     "<text — query-local identifier, e.g. 'membership'>",
        "format": "mcard",
        "meta": {
          "policies": [
            { "id": "<base64url — registry address (card pointer) of a policy card>", "include_children": false }
          ],
          "predicate": { "<optional card predicate expression — card_protocol_spec.md §The Predicate System>" }
        }
      }
    ]
  },
  "expires_at":        "<ISO 8601 — at most 10 minutes after creation>",
  "nonce":             "<base64url — 32 random bytes>",
  "purpose":           "<text — shown to the user in the wallet>",
  "request_signature": "<base64url — ML-DSA-44 signature by the server card over all other fields>",
  "requester_card":    "<base64url — card pointer of the site's server card>",
  "requester_pubkey":  "<base64url — ML-DSA-44 public key of the server card, 1312 bytes raw>",
  "response_mode":     "form_post | mcard_message",
  "response_uri":      "<HTTPS URL on the site — where the browser posts or redeems>",
  "state":             "<base64url — at least 16 random bytes; binds the response to one browser session>",
  "statement":         "<text — the statement the user signs>",
  "version":           "2",
  "wallet_nonce":      "<base64url — optional; present only on wallet-initiated logins>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `context` | object | No | Display-only key/value text shown with the statement. Not echoed into the response; covered by `request_hash`. |
| `dcql_query` | object | Yes | Exactly one entry in `credentials` in v2 (multi-card requests are P2). `format` MUST be `"mcard"`. Matching rules: §8.1. |
| `expires_at` | `timestamp` | Yes | Wallet rejects the request after this time. MUST be no more than 10 minutes after the site created the request. |
| `nonce` | `base64url` | Yes | 32 random bytes; echoed in the signed response. |
| `purpose` | `text` | Yes | Why the site is asking, shown in the wallet. |
| `request_signature` | `base64url` | Yes | Covers every other field, including `requester_pubkey`. |
| `requester_card` | `card-pointer` | Yes | The **server card**. Its `SubCardDocument` MUST name a login-service-branch card as both `holder_primary_card` and `app_card`, MUST carry `attestation_level: "S1"`, and its `capabilities` MUST include `auth_request`. |
| `requester_pubkey` | `base64url` | Yes | Untrusted hint; binding check below. |
| `response_mode` | `text` | Yes | `"form_post"` (same-device, through the browser) or `"mcard_message"` (card message to the login service card; required for cross-device). |
| `response_uri` | `text` | Yes | Absolute `https:` URL, default port, no fragment, no userinfo. Its **origin** is what the wallet displays and checks against the login service card's `domain_binding` (§17). `form_post`: the wallet's browser POSTs the response here. `mcard_message`: the browser redeems the one-time code here (`response_uri` with query parameter `code`). |
| `state` | `base64url` | Yes | At least 16 random bytes. The site also sets it in a cookie on the starting browser (`card_login.md` Phase 1). Echoed in the signed response. |
| `statement` | `text` | Yes | Echoed verbatim in the signed response. Sites with nothing specific to say use `card_login.md`'s default login statement. |
| `version` | `text` | Yes | `"2"`. Wallets reject other values. |
| `wallet_nonce` | `base64url` | No | Copied from the `wallet_nonce` query parameter of the site's start URL on a wallet-initiated login (`card_login.md` Phase 6). The wallet skips its approval prompt only when this matches a pending login it created. |

**Binding check (wallet):** `requester_pubkey` is an untrusted hint. The wallet MUST confirm `keccak256(requester_pubkey)` equals the `requester_card` pointer address before using it to verify `request_signature` or to derive the server card's content key. A mismatch — or an AES-GCM authentication failure when decrypting the server card's `SubCardDocument` — is a hard rejection.

**Requester validation (wallet):** after the binding check and signature check, the wallet resolves the server card's `SubCardDocument` and runs the chain, scope, domain-binding, and status checks in `card_login.md` Phase 3 before showing anything to the user. In summary: the server card is a login-service-scoped sub-card (§16 login service scope rule) whose master — the login service card — chains to `loginServiceCertificationRoot`; the login service card's `domain_binding` (§17) covers the `response_uri` origin and is still current; and no card on that chain is revoked. Every check failure is a rejection before display.

**Request hash.** `request_hash = base64url(keccak256(canonical RFC 8785 JSON of the complete AuthenticationRequest, including request_signature))`. The wallet puts it in the signed response so a response cannot be replayed against any other request (OpenID4VP `transaction_data` semantics). keccak256 is the same function the protocol uses for message IDs (§5).

### 8.1 `mcard` DCQL credential query

A held card **matches** the query when all of the following hold:

1. **Policy match.** For at least one entry `p` in `meta.policies`: resolve the card's `policy_id` (a snapshot CID) to its policy card's registry address `A`.
   - `include_children: false` — `A` equals `p.id`.
   - `include_children: true` — `A` equals `p.id`, **or** `p.id` is an ancestor of `A`. A policy's ancestors are found by walking its **issuance chain**: the policy card's `ancestry_pubkeys[0]` is its issuer (authorizer) card; that card's `policy_id` resolves to the parent policy; repeat until a trusted root or `maxChainDepth`. This is the same walk used for `preferred_services` inheritance (§2) and is deliberately not the holder-lineage walk used for `policy_creation` constraints (`card_protocol_spec.md §1`).
   Policies are compared by registry address, never by CID, so a policy update (new CID) does not break matching. The card's own policy address is the `policy_address` in its on-chain `CardEntry` (authoritative); deriving it from the policy snapshot's `recipient_pubkey` is a fallback. *(2026-11-10: today's press records `keccak256(policy CID)` as a card's `policy_address` rather than a policy card's key-derived address — see `plans/card-login-code-plan.md` F13 — so in current deployments `include_children` can only match a card's own policy.)*
2. **Predicate.** If `meta.predicate` is present, the card's chain satisfies it, evaluated by the existing predicate engine with the presented card as the subject.
3. **Status.** The card is not revoked (no 8xx/9xx with `effective_date` ≤ now) and its chain reaches a trusted root.

The site re-runs the same three checks on the presented card when verifying the response (`card_verifier.md §6.3`).

---

## 9. AuthenticationResponse

**Transmitted via:** `form_post` (browser POST to `response_uri`) or `mcard_message` (routed card message to the login service card)  
**Sent by:** The user's wallet  
**Contains:** A `SignedMessageEnvelope` (§5) with `type: "auth_response"`

**Changed in v2 (2026-11-08):** `session_id` → `state` (now a fixed signed field rather than inside `context`); `card_pointer` removed (redundant with `senders`); `request_hash` and `audience` added; `recipients` is the login service card, not `requester_card`; OHTTP and `callbacks.https` transports replaced by the two response modes.

```json
{
  "state": "<unsigned copy of AuthenticationRequest.state — for routing/lookup only>",
  "signed_statement": {
    "payload": {
      "type":    "auth_response",
      "content": {
        "audience":     "<origin of AuthenticationRequest.response_uri, e.g. 'https://example.com'>",
        "nonce":        "<copied from AuthenticationRequest.nonce>",
        "request_hash": "<base64url — §8 request hash>",
        "state":        "<copied from AuthenticationRequest.state>",
        "statement":    "<copied verbatim from AuthenticationRequest.statement>"
      },
      "protocol_version": "<current protocol version>",
      "recipients": ["<base64url — the login service card: holder_primary_card of the server card>"],
      "senders":    ["<base64url — card pointer of the presented card>"],
      "timestamp":  "<ISO 8601 — set by the wallet at signing time>"
    },
    "signatures": [
      { "public_key": "<base64url>", "signature": "<base64url>" }
    ]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `state` | `base64url` | Yes | Unsigned convenience copy for server-side lookup. The verifier MUST also check the signed `content.state`. |
| `signed_statement` | SignedMessageEnvelope | Yes | `type` MUST be `"auth_response"`. Signed by one of the presented card's active device sub-cards, whose `capabilities` include `auth_response` (messaging_protocol.md §14; the verifier accepts sub-card signatures only, `card_verifier.md §7.2`). |
| `content.audience` | `text` | Yes | Origin (scheme + host, plus port if non-default) of `response_uri`. The site rejects a response whose `audience` is not its own origin. |
| `content.nonce` | `base64url` | Yes | Must equal the issued `nonce`. |
| `content.request_hash` | `base64url` | Yes | Must equal the hash of the request the site issued for this `state`. |
| `content.state` | `base64url` | Yes | Signed copy; must equal the issued `state`. |
| `content.statement` | `text` | Yes | Must equal the issued `statement`. |
| `payload.senders` | `card-pointer-array` | Yes | Exactly one entry: the **presented card** — the card that satisfies `dcql_query`. This is the identifier the site binds the account to. |
| `payload.recipients` | `card-pointer-array` | Yes | Exactly one entry: the login service card (master of `requester_card`). Messages route only to master cards (`process_specs/message_routing.md`), so this is also the `mcard_message` delivery address. |
| `payload.timestamp` | `timestamp` | Yes | Must fall between the request's creation and `expires_at`, and within the site's freshness window (default 5 minutes). |

**On the wire.**
- `form_post`: the browser POSTs `application/x-www-form-urlencoded` to `response_uri` with fields `state` and `auth_response`, where `auth_response` is base64url(canonical RFC 8785 JSON of `signed_statement`). A declined request posts `state` and `error=access_denied` instead.
- `mcard_message`: the wallet sends `signed_statement` as an ordinary routed message to the login service card (`messaging_protocol.md §14`). The `state` wrapper field is not sent; the site reads `content.state`. A declined request sends an `error` message (`messaging_protocol.md §22`) to the login service card with `content.code: "access_denied"` and `content.state` set; `content.in_reply_to` is omitted because the request was fetched, not received as a message.

**Verification (site).** `card_verifier.md §6.3` `verifyLoginResponse`: envelope signature and sub-card link, presented card chain and revocation, `type`, `state`, `nonce`, `request_hash`, `audience`, `recipients`, `timestamp` freshness, then the §8.1 DCQL match. Only after every check passes does the site establish a session (`form_post`) or issue a one-time code (`mcard_message`).

---

## 10. SCIP

**Signed Card Inclusion Proof**  
**Produced by:** Press  
**Delivered to:** Recipient, via HTTPS to their wallet service endpoint. The issuer, the policy card's holder, and auditors learn of the issuance from the `PressIssuanceRecord` (§11), which carries `scip_cid`.  
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

**Delivered by:** Press, via E2E-encrypted message (normal message routing layer) immediately after assembling and signing the `CardDocument`
**Delivered to:** Every active auditor in `policy.auditors`, the issuing card (`issuer_card`), and the policy card (the card at `policy_id`, whose messaging address reaches the policy card's holder). Duplicates are removed: a card that fills more than one of these roles receives one record.

The record of a single issuance. Each recipient receives its own independently encrypted copy and keeps it locally. Together, a recipient's records form its **list of issued cards**:

- **Auditors** use the list to inspect issuances for policy compliance (`log_auditing.md`).
- **The issuer** gets records only for cards it issued, and uses the list to see and message those cards.
- **The policy card's holder** gets records for every card issued under the policy, including cards issued by delegated issuers.

`recipient_pubkey` is the issued card's messaging address (`keccak256(recipient_pubkey)`) and the key to its content, so holding the record is enough to message the card individually or as part of a collective `announcement`. The list is visible only to the parties that receive these records. It is never posted to IPFS or on-chain.

```json
{
  "card_cid":         "<base64url — CID of the issued CardDocument>",
  "recipient_pubkey": "<base64url — ML-DSA-44 public key of the issued CardDocument, 1312 bytes raw>",
  "issuer_card":      "<card-pointer — the issuing card>",
  "policy_id":        "<cid — the policy the card was issued under>",
  "scip_cid":         "<base64url — CID of the SCIP posted to IPFS>",
  "issued_at":        "<ISO 8601 timestamp>",
  "offer_type":       "targeted | open",
  "offer_id":         "<hex — open offers only; omitted for targeted issuance>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `card_cid` | `cid` | Yes | Links to the issued card |
| `recipient_pubkey` | `base64url` | Yes | ML-DSA-44 public key of the issued `CardDocument` (1312 bytes raw). Gives the card's messaging address (`keccak256(recipient_pubkey)`) and its content key (`HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`), which recipients use to decrypt the card, read its current log state, and message it. Populated by the press from the `CardDocument` it just assembled. |
| `issuer_card` | `card-pointer` | Yes | Copied from the issued card's `issuer_card`. Lets the policy holder and auditors group cards by issuer (for example, by delegated steward). |
| `policy_id` | `cid` | Yes | Copied from the issued card's `policy_id`. Lets a holder of several policies, or an issuer under several policies, group cards by policy. |
| `scip_cid` | `cid` | Yes | Links to the SCIP for this issuance |
| `issued_at` | `timestamp` | Yes | Must match the card's `issued_at` |
| `offer_type` | `text` | Yes | `"targeted"` or `"open"` |
| `offer_id` | `text` | Open offers only | The open offer's `offer_id`, letting the issuer see which invite link a card was claimed through. Omitted for targeted issuance. |

**Binding and consistency check.** After decrypting the issued card at `card_cid`, a recipient SHOULD confirm `keccak256(recipient_pubkey)` equals the card's on-chain registry address, and that `issuer_card` and `policy_id` match the decrypted card. A mismatch indicates a malformed or forged record; an auditor MUST flag it in the audit findings, and an issuer or policy holder MUST NOT add the card to their list.

**Current state and display.** The record is a snapshot at issuance. Wallets resolve each listed card's current state from its log. Revoked cards (8xx or 9xx) remain in the list and are shown greyed out.

---

## 12. AuditEpochEntry

**Removed.** Audit epoch key distribution via ML-KEM is replaced by direct auditor messaging. See press spec §5.6 for the current auditor notification model.

---

## 13. AuditEpochCommitment

**Removed.** Audit epoch key distribution via ML-KEM is replaced by direct auditor messaging. See press spec §5.6 for the current auditor notification model.

---

## 14. CardEntry (on-chain)

**Changelog:** Fix #1 (`plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`) — added the `forward_to` field below, bringing this struct in line with `registry_contract.md §3.1`'s 5-field version.

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

    forward_to         bytes32  — If non-zero, the registry address of the card that supersedes
                                  this one following a key rotation; immutable once set.

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
  "limitations":                [
    {
      "applies_to": ["<message type string>", "..."],
      "field_requirements": [
        { "field": "<dot-path into the signed payload>", "regex": "<pattern the value must match>" }
      ]
    }
  ],
  "recipient_pubkey":           "<base64url — sub-card ML-DSA-44 public key, 1312 bytes raw>",
  "dns_path_scope":             "<regex string — optional; present only when holder_primary_card is a DNS admin card>",
  "issued_at":                  "<ISO 8601 timestamp>",
  "valid_until":                "<ISO 8601 timestamp — optional; absent means no expiry>",
  "attestation_level":          "T2 | T1 | S1",
  "attestation_proof":          "<base64url — App Attest / Play Integrity assertion scoped to recipient_pubkey hash; omitted if attestation_level is T1 or S1>",
  "app_signature":              "<base64url — app card key ML-DSA-44 signature over canonical RFC 8785 JSON of document without both signature fields>",
  "holder_signature":           "<base64url — holder primary card key ML-DSA-44 signature over canonical RFC 8785 JSON of document including app_signature, without holder_signature>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `holder_primary_card` | `card-pointer` | Yes | Mutable pointer of the card this sub-card delegates from; establishes the chain-of-trust link on verification |
| `holder_primary_card_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `holder_primary_card`. **Untrusted hint**: the verifier MUST confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address before using it to derive a content key or verify a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Set at sub-card issuance; covered by both `app_signature` and `holder_signature`. |
| `app_card` | `card-pointer` | Yes | Mutable pointer of the requesting app's card; must chain to the governance authority's app-certification policy. **Login service scope rule (2026-11-08):** if the chain passes through `loginServiceCertificationRoot` (the login service branch), `app_card` MUST equal `holder_primary_card` — a login service card may only authorize its own server cards (`subcards.md §Server Cards`). |
| `app_card_pubkey` | `base64url` | Yes | ML-DSA-44 public key (1312 bytes raw) of the card referenced by `app_card`. **Untrusted hint**: the verifier MUST confirm `keccak256(app_card_pubkey)` equals the `app_card` pointer address before using it to derive a content key or verify a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Set at sub-card issuance; covered by both `app_signature` and `holder_signature`. |
| `capabilities` | `array of text` | Yes | Whitelist of message type strings this sub-card may sign (e.g. `["auth_response", "exchange_offer"]`). An empty array is valid but non-functional. |
| `limitations` | `array of objects` | No | Additional constraints on statements this sub-card may sign, beyond the `capabilities` whitelist, expressed using the protocol's existing predicate/`field_requirements` grammar (`card_protocol_spec.md` §The Field Type System, §The Predicate System) rather than a new vocabulary. Absent means no additional limitations. Each entry has an optional `applies_to` (array of message type strings this entry constrains; absent means it applies to all message types in `capabilities`) and `field_requirements` (array of `{ "field": "<dot-path into the signed message payload>", "regex": "<pattern>" }` pairs — the same shape used elsewhere for `card-pointer`/`cid` field validation, here evaluated against the payload of the statement being signed rather than a referenced card's fields). Combinators (`any_of`/`all_of`/`none_of`) may wrap multiple `limitations` entries the same way they wrap predicate leaves elsewhere. Covered by both `app_signature` and `holder_signature`, like `capabilities`. See `subcards.md §Limitations` for worked examples and the stateless-evaluation caveat (count-based rate limits are out of scope for this mechanism — see that section). |
| `recipient_pubkey` | `base64url` | Yes | ML-DSA-44 public key generated in device hardware-backed secure storage; 1312 bytes raw |
| `issued_at` | `timestamp` | Yes | Set by the app at document assembly time |
| `valid_until` | `timestamp` | No | Optional expiry; verifiers must reject signatures from expired sub-cards |
| `attestation_level` | `text` | Yes | `"T2"` (full app attestation; default and required), `"T1"` (hardware-backed key storage only; permitted only if the governing policy explicitly accepts it), or `"S1"` (server key; permitted **only** for server cards — login-service-branch `app_card` equal to `holder_primary_card`). See `subcards.md §Attestation Tiers`. |
| `attestation_proof` | `base64url` | Conditional | Present when `attestation_level` is `"T2"`: the platform attestation assertion (iOS App Attest certificate / Android Play Integrity token) scoped to the hash of `recipient_pubkey`. Omitted when `attestation_level` is `"T1"` or `"S1"`. |
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

**Verifier chain walk (runtime).** A verifier encountering a signature from a sub-card must: (1) confirm the message type appears in the sub-card's `capabilities`; (2) confirm `valid_until` has not passed; (3) verify `app_signature` is valid; (4) verify `holder_signature` is valid; (5) read `holder_primary_card_pubkey` from the decrypted sub-card document; (6) confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address — if the addresses do not match, reject; (7) derive the master card's content key as `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")` and decrypt the master card from IPFS — if AES-GCM authentication fails, reject; (8) read `active_subcards` from the now-decrypted master card (§1.1) and, for each entry, derive `keccak256(entry_pubkey)`; confirm one of these matches the sub-card's own registry address (`keccak256` of the `SignatureEntry`'s `public_key`) — **hard-reject if absent, independent of the on-chain `SubCardRegistrations[sub_card_address].active` flag checked in step 10** (the on-chain flag and the IPFS directory are two independent sources that could in principle desync; absence from `active_subcards` is a hard rejection on its own regardless of the on-chain flag's value); if `active_subcards` is absent from the master card entirely, treat it as an empty directory and reject; (9) walk the holder's master card chain to a trusted root using the master card's `ancestry_pubkeys` (Stage 3 of `card_validation.md`); (10) confirm the sub-card is not revoked in the on-chain registry (check `SubCardRegistrations[sub_card_address].active`); (11) confirm `attestation_level` is `"T2"` unless the governing policy explicitly accepts `"T1"`, or is `"S1"` on a server card (step 13); (12) walk the `app_card` chain: derive `app_card` content key via `HKDF-SHA3-256(app_card_pubkey_bytes, "card-content-v1")`; fetch and decrypt the app card document from IPFS; walk `ancestry_pubkeys` hop by hop until the chain reaches `VerifierConfig.appCertificationRoot`. Hard-reject with `APP_CARD_CHAIN_NOT_TRUSTED` and `scope_clean: false` if the chain exhausts without reaching the configured root or exceeds `maxChainDepth`. (13) **Login service scope rule:** if the step-12 walk passed through `loginServiceCertificationRoot`, confirm `app_card` equals `holder_primary_card`; otherwise hard-reject with `LOGIN_SERVICE_SCOPE` and `scope_clean: false`. A sub-card with `attestation_level: "S1"` that does not satisfy this rule is rejected with `ATTESTATION_LEVEL_INSUFFICIENT`.

**Server cards (2026-11-08).** A server card is a sub-card with `holder_primary_card == app_card ==` a login-service-branch card and `attestation_level: "S1"`. Its signing sequence collapses: the site operator's wallet signs steps 4 and 8 with the same login service card key, and step 7 (user consent) is skipped. See `subcards.md §Server Cards`.

**App-certification chain: verifier-enforced.** Runtime verifiers independently walk the `app_card` chain from `app_card_pubkey` up to the governance authority's app-certification policy root configured as `appCertificationRoot` in `VerifierConfig`. A sub-card whose `app_card` does not reach that root is rejected at Stage 2 (`APP_CARD_CHAIN_NOT_TRUSTED`) regardless of whether a press accepted it at registration time. The press also performs this check as an early gate before submitting `RegisterSubCard` (see §5.4 of press.md), but the verifier's check is the binding enforcement layer. Per-link on-chain addresses remain authoritative; `holder_primary_card_pubkey` and `app_card_pubkey` are untrusted hints whose validity is established by the binding check before use.

---

## 17. DomainBindingAttestation

**Stored in:** the login service card's `domain_binding` protocol-reserved field (§1.1), set once by a code-520 `LogEntry`  
**Signed by:** The domain's **full-domain DNS admin card** (ML-DSA-44 holder key — the same key that signs `SetPolicyAddressIntent`s, `dns_resolution.md §6.2`)  
**Serialized for signing:** Canonical RFC 8785 JSON of all fields except `admin_signature`

Binds a login service card to a DNS domain, so that a wallet can check that the site asking for a login controls the domain it claims. Added 2026-11-08 for card login (`process_specs/card_login.md`).

```json
{
  "admin_card":            "<base64url — card pointer of the full-domain DNS admin card>",
  "admin_card_pubkey":     "<base64url — ML-DSA-44 public key of admin_card, 1312 bytes raw>",
  "admin_signature":       "<base64url — ML-DSA-44 signature by admin_card over all other fields>",
  "login_service_card":        "<base64url — card pointer of the login service card being bound>",
  "login_service_card_pubkey": "<base64url — ML-DSA-44 public key of login_service_card, 1312 bytes raw>",
  "domain":                "<lowercase DNS name, no trailing dot — e.g. 'example.com'>",
  "issued_at":             "<ISO 8601>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `admin_card` | `card-pointer` | Yes | MUST be `DomainRegistrations[domain].admin_card_address` (`dns_resolution.md §4.1`) when the binding is set **and** whenever it is used. Sub-path-scoped admin sub-cards (`dns_resolution.md §5.2`) cannot sign a binding. |
| `admin_card_pubkey` | `base64url` | Yes | Untrusted hint; `keccak256(admin_card_pubkey)` MUST equal `admin_card`. |
| `admin_signature` | `base64url` | Yes | |
| `login_service_card` | `card-pointer` | Yes | The card whose log carries this attestation. |
| `login_service_card_pubkey` | `base64url` | Yes | `keccak256(login_service_card_pubkey)` MUST equal `login_service_card`. |
| `domain` | `text` | Yes | RFC 1123 name, lowercase, no trailing dot. Must be a registered domain (`DomainRegistrations[domain].exists`). |
| `issued_at` | `timestamp` | Yes | |

**Coverage rule.** A binding to `domain` covers an origin when the origin's scheme is `https`, its port is the default (443), and its host equals `domain` or ends with `"." + domain`. Nothing else is covered (no `http`, no non-default ports, no IP literals).

**Currency rule (checked at every use, not just when set).** The binding is usable only while: `admin_card` is still `DomainRegistrations[domain].admin_card_address` (so a domain handoff, `dns_resolution.md §8`, silently retires every binding the old owner signed); the admin card is not revoked; and the domain is not suspended (`fraud_risk == 2` with `block.timestamp < suspension_expires_at` → `DOMAIN_SUSPENDED`).

**Verifier usage:** binding checks on both pubkeys; verify `admin_signature` with `admin_card_pubkey`; read `DomainRegistrations[domain]` and apply the currency rule; apply the coverage rule to the origin being checked.

---

## 18. LoginServiceMetadata

**Served at:** `https://<origin>/.well-known/membership-login` (`Content-Type: application/json`)  
**Signed by:** The site's server card  
**Serialized for signing:** Canonical RFC 8785 JSON of `metadata`

Lets a wallet confirm that a site listed in a card's `preferred_services` (§2) accepts that card, and tells the wallet where to start a wallet-initiated login. Added 2026-11-08.

```json
{
  "metadata": {
    "accepts":            [ { "id": "<base64url — policy card pointer>", "include_children": true } ],
    "name":               "<text — the site's own name; informational only>",
    "origin":             "<origin this document is served from>",
    "response_modes":     ["form_post", "mcard_message"],
    "server_card":        "<base64url — card pointer of the server card>",
    "server_card_pubkey": "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
    "start_url":          "<https URL on origin — wallet-initiated login entry point>",
    "updated_at":         "<ISO 8601>",
    "version":            "1"
  },
  "signature": "<base64url — ML-DSA-44 signature by server_card over canonical metadata>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `metadata.accepts` | array | Yes | Same shape and matching rules as `dcql_query…meta.policies` (§8.1 step 1). |
| `metadata.name` | `text` | Yes | Not used for display when the service came from a policy's `preferred_services`; the policy's `name` is shown instead. |
| `metadata.origin` | `text` | Yes | MUST equal the origin the document was fetched from. |
| `metadata.response_modes` | `array of text` | Yes | Modes the site supports. |
| `metadata.server_card`, `server_card_pubkey` | | Yes | Binding check as §8. The server card MUST pass the same requester validation as a login request for `origin` (`card_login.md` Phase 3). |
| `metadata.start_url` | `text` | Yes | `https:` URL with the same origin. The wallet appends `wallet_nonce` and `wallet_hint` query parameters. |
| `metadata.updated_at` | `timestamp` | Yes | |
| `metadata.version` | `text` | Yes | `"1"`. |
| `signature` | `base64url` | Yes | |

Wallets may cache a validated document for up to 24 hours.

---

## 19. WalletRegistrationToken

**Presented to:** the login router's `/register` route; also served by the wallet operator at `https://<wallet domain>/.well-known/membership-wallet` for the router's address lookup (`object_specs/login_router.md §4, §6`)  
**Signed by:** a **wallet card** — a card under the wallet branch of the app-certification root (`subcards.md §App Cards and the Trust Chain`)  
**Serialized for signing:** Canonical RFC 8785 JSON of `token`

Proves to the login router that a wallet asking to be registered is a certified wallet application. One token per wallet deployment, not per user: it carries nothing about the user, so registering reveals nothing about them to the router. Added 2026-11-08.

```json
{
  "token": {
    "app_card":        "<base64url — the wallet's app card pointer>",
    "app_card_pubkey": "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
    "expires_at":      "<ISO 8601 — at most 1 year after issued_at>",
    "handler_url":     "<https URL — the wallet's login handler; the router navigates to handler_url#request_uri=…>",
    "icon":            "<data: URI, image/png or image/svg+xml, at most 16 KB — optional>",
    "issued_at":       "<ISO 8601>",
    "name":            "<text — wallet name shown in the router's picker>",
    "router_origin":   "<origin of the login router this token is for>",
    "version":         "1"
  },
  "signature": "<base64url — ML-DSA-44 signature by app_card over canonical token>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `token.app_card` | `card-pointer` | Yes | Must be a wallet card (wallet branch). The router checks this against its build-time list of certified wallets (`login_router.md §5`). |
| `token.app_card_pubkey` | `base64url` | Yes | Binding check as §8. |
| `token.expires_at` | `timestamp` | Yes | Router rejects expired tokens. |
| `token.handler_url` | `text` | Yes | `https:` URL. For a native wallet, a universal/app link. |
| `token.icon` | `text` | No | Inline only, so displaying it makes no network request. |
| `token.issued_at` | `timestamp` | Yes | |
| `token.name` | `text` | Yes | |
| `token.router_origin` | `text` | Yes | MUST equal the router's own origin, so a token can't be replayed against a different router. |
| `token.version` | `text` | Yes | `"1"`. |
| `signature` | `base64url` | Yes | |

---

## Object Relationship Summary

```
PolicyCardDocument (IPFS)
  └── preferred_services → [{ origin, name, ... }] → LoginServiceMetadata (HTTPS /.well-known/membership-login)
  └── approved_presses → [CardDocument (press sub-card)] (IPFS)
  └── auditors → [CardDocument (auditor card)] (IPFS)
  └── issuance records → [PressIssuanceRecord] (E2E message to auditors, issuer_card, and policy card holder; kept locally by each)
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
       └── app-certification chain walk: performed by the PRESS at registration and again by every runtime verifier (card_verifier.md §7.2 step 16)
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
| AuthenticationRequest | HTTPS (`request_uri`) | RFC 8785-signed by the server card (all except `request_signature`) |
| AuthenticationResponse | `form_post` / `mcard_message` | Not signed as a whole; contains a SignedMessageEnvelope |
| SCIP | In-transit / IPFS | RFC 8785-signed (all except `press_signature`) |
| PressIssuanceRecord | Delivered by message to auditor card addresses | Not signed separately; delivered E2E encrypted via normal message routing layer |
| CardEntry | Arbitrum One | On-chain; write authorized by secp256r1 sig verified via RIP-7212 precompile against `PressAuthorizations` table |
| SubCardRegistration | Arbitrum One | On-chain; stores `master_card_address`, `registration_log_head`, `sub_card_doc_cid` (CID of IPFS SubCardDocument). Write authorized by press secp256r1 sig (§6.1 write gate); master card holder ML-DSA-44 sig verified off-chain by press; app-certification chain walk also performed off-chain by press before submission. |
| SubCardDocument | IPFS | RFC 8785-signed (`app_signature` over all fields except both signature fields; `holder_signature` over all fields including `app_signature`); `holder_primary_card_pubkey` and `app_card_pubkey` are present and covered by both signatures |
| DomainBindingAttestation | IPFS (in login service card's `domain_binding`) | RFC 8785-signed by the full-domain DNS admin card (all except `admin_signature`) |
| LoginServiceMetadata | HTTPS (`/.well-known/membership-login`) | RFC 8785-signed by the server card (`metadata` only) |
| WalletRegistrationToken | Login router fragment | RFC 8785-signed by a wallet card (`token` only) |
