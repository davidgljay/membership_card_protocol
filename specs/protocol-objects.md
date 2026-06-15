# Card Protocol — Object Reference

**Version:** 0.1 (draft)  
**Date:** 2026-05-21  
**Status:** In Review

This document is the canonical reference for every structured object in the Card Protocol. Each object is shown as an annotated JSON template (the developer-facing input surface). Objects that are signed or hashed use **canonical CBOR** (RFC 8949 deterministic encoding with protocol-specific overrides) as the byte sequence over which signatures are computed — see Appendix A of `card_protocol_spec.md` for the full serialization rules.

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

Appears inside several objects wherever a single party's ML-DSA-44 signature is recorded.

```json
{
  "signer_card": "<base64url — mutable pointer in registry of the signing sub-card>",
  "public_key":   "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
  "signature":    "<base64url — ML-DSA-44 signature, 2420 bytes raw>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `signer_card` | `card-pointer` | Yes | On-chain registry address of the signing sub-card |
| `public_key` | `base64url` | Yes | Must match the key registered to `signer_card` |
| `signature` | `base64url` | Yes | Over canonical CBOR of the stated payload (varies per object) |

---

## 1. CardDocument

**Stored on:** IPFS  
**Signed by:** Press (offer), then Holder (countersignature)  
**Serialized for signing:** Canonical CBOR of the full document (offer phase: without `holder_signature` and `recipient_pubkey`; final phase: complete document)

The genesis document of a card. Every card — including policy cards, press sub-cards, and user cards — begins life as a CardDocument posted to IPFS. Its CID is recorded as the initial log head in the Arbitrum One registry.

```json
{
  "policy_id":        "<base64url — CID of the governing policy card>",
  "press_card":      "<base64url — mutable pointer in registry of the issuing press sub-card>",
  "recipient_pubkey": "<base64url — recipient's ML-DSA-44 public key, 1312 bytes raw>",
  "issued_at":        "<ISO 8601 timestamp>",
  "offer_signature":  "<base64url — press's ML-DSA-44 signature over canonical CBOR of the offer payload>",
  "holder_signature": "<base64url — holder's ML-DSA-44 countersignature over canonical CBOR of the completed card>",

  "<policy-defined fields>": "..."
}
```

| Field | Type | Required | Mutable | Notes |
|---|---|---|---|---|
| `policy_id` | `cid` | Yes | No | Pinned to the policy at time of issuance |
| `press_card` | `card-pointer` | Yes | No | Identifies the issuing press; used to walk the authorization chain |
| `recipient_pubkey` | `base64url` | Yes | No | Added by holder before countersigning; empty in the offer phase |
| `issued_at` | `timestamp` | Yes | No | Set by press at offer creation |
| `offer_signature` | `base64url` | Yes | No | Press signs the offer payload (all fields except `recipient_pubkey` and `holder_signature`) |
| `holder_signature` | `base64url` | Yes | No | Holder signs the complete document (all fields including `recipient_pubkey`) |
| `supersedes` | `card-pointer` | No | No | Present only on un-revocation cards: the mutable pointer of the prior card this card corrects. Set by the issuer at genesis. See `card_protocol_spec.md §Background`. |
| `supersession_note` | `text` | No | No | Human-readable explanation of why this card supersedes the one pointed to by `supersedes`. Present only when `supersedes` is set. |

**Signing sequence:**
1. Press assembles the document with all policy-defined fields and `issued_at`, leaving `recipient_pubkey` and `holder_signature` absent.
2. Press signs canonical CBOR of the current document → `offer_signature`.
3. Holder reviews, generates fresh ML-DSA-44 keypair, adds `recipient_pubkey`.
4. Holder signs canonical CBOR of the complete document → `holder_signature`.
5. Completed document is posted to IPFS.

### 1.1 Protocol-Reserved Updatable Fields

These fields are NOT present at genesis. They are added to an existing card via a 1xx `LogEntry` and are enforced by the press and verifiers regardless of the card's policy `field_definitions`. They may not be redefined or overridden by any policy.

| Field | Type | Authorization | Codes | Meaning |
|---|---|---|---|---|
| `successor` | `card-pointer` | Codes 100, 101: `{ "is_holder": true }`. Code 102: `{ "is_issuer": true }` with 72-hour pending window. | 100, 101, 102 | Mutable pointer of the card that supersedes this one. May be set at most once; once effective, it is immutable. See `key_rotation.md §8`. |

A code-102 `successor` entry carries a `pending_until` field and is not effective until that timestamp is reached without a holder-submitted code-103 cancellation. See `key_rotation.md §3.5`.

---

## 2. PolicyCardDocument

**Stored on:** IPFS  
**Is a:** CardDocument (same protocol-required fields plus the policy fields below)

A policy card is a CardDocument whose content defines the rules for a class of cards. All the protocol-required fields of CardDocument apply. The additional fields below are the policy's own field values (analogous to the policy-defined fields of any card, but standardised across all policies).

```json
{
  "policy_id":        "<base64url — CID of the meta-policy governing this policy card>",
  "press_card":      "<base64url — mutable pointer in registry of the policy authorizer's card>",
  "recipient_pubkey": "<base64url — administrator's ML-DSA-44 public key>",
  "issued_at":        "<ISO 8601 timestamp>",
  "offer_signature":  "<base64url>",
  "holder_signature": "<base64url>",

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
| `auditors` | `card-pointer-array` | No | Auditors receive ML-KEM-encrypted copies of each issuance log entry |
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
- `intent_signature` covers canonical CBOR of the `UpdateIntentPayload` (see §4)
- `press_signature` covers canonical CBOR of the complete `LogEntry` document excluding the `press_signature` field itself

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
    "signer_card": "<base64url — mutable pointer in registry of updater's sub-card>",
    "public_key":   "<base64url — updater's ML-DSA-44 public key>",
    "signature":    "<base64url — sig over canonical CBOR of the UpdateIntentPayload>"
  },
  "press_signature": {
    "signer_card": "<base64url — mutable pointer in registry of press sub-card>",
    "public_key":   "<base64url — press's ML-DSA-44 public key>",
    "signature":    "<base64url — sig over canonical CBOR of the complete LogEntry excluding press_signature>"
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
**Serialized for signing:** Canonical CBOR of this object; becomes the `intent_signature` payload

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
| `timestamp` | `timestamp` | Yes | Prevents replay; press rejects intents with stale timestamps |

The intent does **not** include `version` or `prev_log_root` — those are added by the press when assembling the LogEntry.

---

## 5. SignedMessageEnvelope

**Transmitted via:** OHTTP (optional) / HTTPS  
**Signed by:** One or more card holders (parallel co-signing)  
**Serialized for signing:** Canonical CBOR of the `payload` object only (not the outer envelope)

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
    "edit_of":     "<base64url — hash of prior payload — optional; mutually exclusive with retracts>",
    "retracts":    "<base64url — hash of prior payload — optional; mutually exclusive with edit_of>"
  },
  "signatures": [
    {
      "signer_card": "<base64url — mutable pointer in registry of signing sub-card>",
      "public_key":   "<base64url — ML-DSA-44 public key>",
      "signature":    "<base64url — sig over canonical CBOR of the payload object>"
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
| `payload.edit_of` | `base64url` | No | Hash of the payload this supersedes; mutually exclusive with `retracts` |
| `payload.retracts` | `base64url` | No | Hash of the payload being retracted; mutually exclusive with `edit_of` |
| `signatures` | array of SignatureEntry | Yes | One entry per signer; each covers the same canonical payload bytes |

The **message ID** is the hash of the canonical CBOR of `payload`. There is no separate ID field.

---

## 6. OpenCardOffer

**Stored on:** Wallet service (HTTPS); may also be pinned to IPFS  
**Signed by:** Issuer  
**Serialized for signing:** Canonical CBOR of all fields except `issuer_signature`

A pre-signed batch authorization allowing any bearer to claim a card under this policy without individual issuer review. The policy card must have `allow_open_offers: true`.

When a recipient accepts, their wallet wraps this document in an `OpenOfferClaimSubmission` (§7), adds a freshly-generated public key, countersigns, and POSTs to the press. The press constructs the `CardDocument` from `proposed_fields` plus the recipient's public key.

```json
{
  "offer_type":        "open",
  "policy_id":         "<base64url — CID of the governing policy card>",
  "press_card":       "<base64url — mutable pointer in registry of the approved press>",
  "issuer_card":      "<base64url — mutable pointer in registry of the issuer's card>",
  "max_acceptances":   100,
  "expires_at":        "<ISO 8601 timestamp — null if unconstrained>",
  "display_message":   "<optional human-readable context shown to recipient>",
  "redirect_url":      "<URL to redirect recipient to after successful issuance>",
  "proposed_fields":   {
    "<field name>": "<issuer-populated value>",
    "...": "..."
  },
  "issuer_signature":  "<base64url — ML-DSA-44 sig over canonical CBOR of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `offer_type` | `text` | Yes | Always `"open"` for this object type |
| `policy_id` | `cid` | Yes | Must have `allow_open_offers: true` |
| `press_card` | `card-pointer` | Yes | Must appear in policy's `approved_presses` |
| `issuer_card` | `card-pointer` | Yes | Used to evaluate `requester_predicate` |
| `max_acceptances` | `integer` | No | Null = unconstrained |
| `expires_at` | `timestamp` | No | Null = unconstrained; enforced atomically on-chain |
| `display_message` | `text` | No | Human-readable context shown in wallet UI |
| `redirect_url` | `text` | No | Wallet redirects recipient here after issuance |
| `proposed_fields` | object | Yes | Issuer-populated field values for issued cards |
| `issuer_signature` | `base64url` | Yes | Covers canonical CBOR of all fields except itself |

The **offer ID** used for on-chain counter tracking is `hash(canonical CBOR of the complete document including issuer_signature)`. This binds the offer ID to the issuer's signature, making it unique per issuer and unforgeable. The contract stores a per-offer-ID acceptance counter in `openOfferUseCounts` (see §14).

---

## 7. OpenOfferClaimSubmission

**Transmitted to:** Press (via HTTPS POST from wallet service)  
**Signed by:** Recipient  
**Serialized for signing:** Canonical CBOR of `claim_payload` (see below)

The object the wallet service POSTs to the press when a recipient accepts an open card offer. The press uses `claim_payload.offer.proposed_fields` to construct the `CardDocument`, adding `recipient_pubkey` and signing the result as in the targeted issuance flow.

```json
{
  "claim_payload": {
    "offer":           { "<verbatim OpenCardOffer document including issuer_signature>" },
    "recipient_pubkey": "<base64url — recipient's freshly-generated ML-DSA-44 public key, 1312 bytes raw>"
  },
  "recipient_signature": "<base64url — recipient's ML-DSA-44 sig over canonical CBOR of claim_payload>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `claim_payload.offer` | OpenCardOffer | Yes | Verbatim; press re-verifies `issuer_signature` over this |
| `claim_payload.recipient_pubkey` | `base64url` | Yes | Public key for the new card; press copies this into the assembled `CardDocument` |
| `recipient_signature` | `base64url` | Yes | Sig over canonical CBOR of the entire `claim_payload` object (offer + recipient_pubkey); press verifies before proceeding |

**Press validation on receipt:**

1. Re-verify `claim_payload.offer.issuer_signature` over the offer document.
2. Verify `recipient_signature` over canonical CBOR of `claim_payload`.
3. Confirm `claim_payload.offer.press_card` matches the receiving press's own sub-card pointer.
4. Confirm the policy has `allow_open_offers: true`.
5. **Press pre-flight (before transaction):** read `OpenOfferUseCounts[offer_id]` on-chain and independently verify `expires_at` and capacity. Reject with a specific error before submitting any transaction if either constraint would be violated.
6. Assemble and countersign the `CardDocument` from `proposed_fields` + `recipient_pubkey`, then call `ClaimOpenOffer` on-chain (which independently re-validates constraints atomically with card registration). If the transaction reverts, surface the contract error code (E-12, E-13, or E-14) to the wallet service. See `registry_contract.md §4.5`.

**Note on the recipient's key:** `recipient_pubkey` in the claim payload is logically equivalent to the same field added by the holder in the targeted issuance flow — the recipient generates it fresh at claim time and its private counterpart never leaves their device.

---

## 8. AuthenticationRequest

**Hosted at:** Single-use HTTPS URL (requesting site's infrastructure)  
**Signed by:** Requesting site (using its own card key)  
**Serialized for signing:** Canonical CBOR of all fields except `request_signature`

The object a site creates when it wants a user to authenticate with a card. Hosted at a single-use URL and fetched by the wallet service via CHAPI.

```json
{
  "session_id":       "<UUID — stable identifier for this auth session>",
  "version":          "1",
  "purpose":          "<human-readable description shown to user>",
  "requesting_site":  "<origin of the requesting site, for display>",
  "requester_card":  "<base64url — mutable pointer in registry of the requesting site's card>",
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
  "request_signature":"<base64url — ML-DSA-44 sig from the requester's card key over canonical CBOR of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | UUID; ties the confirmation code to this session |
| `version` | `text` | Yes | Always `"1"` in v1 |
| `purpose` | `text` | Yes | Displayed to user in wallet UI |
| `requesting_site` | `text` | Yes | Display-only origin |
| `requester_card` | `card-pointer` | Yes | Wallet uses this for chain verification |
| `payload.content` | `text` | Yes | The statement the user will countersign |
| `payload.nonce` | `text` | Yes | Incorporated into signed statement; must be verified to prevent replay |
| `required_predicate` | predicate | No | Chain predicate the user's card must satisfy |
| `required_policy` | `cid` | No | Policy card CID the user's card must have been issued under |
| `callbacks.https` | `text` | Yes | Required fallback |
| `callbacks.ohttp` | object | No | For IP-private response |
| `redirect_uri` | `text` | Yes | Must contain `{code}` placeholder |
| `expires_at` | `timestamp` | Yes | Wallet rejects requests past this time |
| `request_signature` | `base64url` | Yes | Wallet verifies before displaying |

---

## 9. AuthenticationResponse

**Transmitted via:** OHTTP (optional) / HTTPS  
**Sent by:** Wallet service  
**Contains:** A `SignedMessageEnvelope` (§5) assembled by the wallet at signing time

The object the wallet posts after user approval. The `signed_statement` is a standard `SignedMessageEnvelope` (§5) with `type: "auth_response"`. The wallet constructs the envelope payload from the `AuthenticationRequest`'s content fields plus the standard envelope fields (`senders`, `recipients`, `timestamp`). This makes auth responses verifiable using the same path as any other envelope.

```json
{
  "session_id":       "<matches the AuthenticationRequest>",
  "signed_statement": {
    "payload": {
      "type":      "auth_response",
      "content": {
        "statement": "<copied from AuthenticationRequest.payload.content>",
        "context":   "<copied from AuthenticationRequest.payload.context — optional>",
        "nonce":     "<copied from AuthenticationRequest.payload.nonce>"
      },
      "senders":    ["<base64url — holder's master card mutable pointer>"],
      "recipients": ["<base64url — requester_card mutable pointer>"],
      "timestamp":  "<ISO 8601 — set by wallet at signing time>"
    },
    "signatures": [
      {
        "signer_card": "<base64url — mutable pointer of sub-card used to sign>",
        "public_key":   "<base64url>",
        "signature":    "<base64url — sig over canonical CBOR of payload>"
      }
    ]
  },
  "card_pointer":    "<base64url — mutable pointer in registry of the card used to sign>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | Must match the request |
| `signed_statement` | SignedMessageEnvelope | Yes | Requester verifies this per §7; `type` must be `"auth_response"` |
| `signed_statement.payload.content.nonce` | `text` | Yes | Must match `AuthenticationRequest.payload.nonce`; replay prevention |
| `signed_statement.payload.timestamp` | `timestamp` | Yes | Set by wallet at signing time; requester checks freshness |
| `card_pointer` | `card-pointer` | Yes | The card the user chose; used for chain walk and predicate evaluation |

The requesting site verifies `signed_statement` per §7 (chain walk, revocation check, predicate evaluation) and additionally confirms `content.nonce` matches the issued request nonce before issuing a confirmation code.

---

## 10. SCIP

**Signed Card Inclusion Proof**  
**Produced by:** Press  
**Delivered to:** Recipient (and courtesy copy to administrator) via HTTPS to wallet service endpoints  
**Serialized for signing:** Canonical CBOR of all fields except `press_signature`

A small signed object that binds a newly-issued card's CID to its position in the policy's issuance log at time of inclusion. The recipient retains this as verifiable proof of issuance.

```json
{
  "card_cid":                  "<base64url — CID of the completed CardDocument>",
  "policy_log_entry_index":     1,
  "policy_log_root_at_inclusion":"<base64url — CID of the policy card's log head at time of issuance>",
  "issued_at":                  "<ISO 8601 timestamp>",
  "press_signature": {
    "signer_card": "<base64url — mutable pointer in registry of press sub-card>",
    "public_key":   "<base64url>",
    "signature":    "<base64url — sig over canonical CBOR of all above fields>"
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

The plaintext content of each press log entry. Entries are encrypted under the epoch AEK shared across all auditors for that epoch (see `AuditEpochEntry` §12). Each entry carries `epoch_id` in plaintext so that auditors can identify which epoch key to use for decryption without reading the ciphertext.

```json
{
  "epoch_id":        "<string — identifies the audit epoch this entry belongs to>",
  "card_cid":       "<base64url — CID of the issued CardDocument>",
  "scip_cid":        "<base64url — CID of the SCIP posted to IPFS>",
  "issued_at":       "<ISO 8601 timestamp>",
  "requester_card": "<base64url — mutable pointer of the requester's card — optional>",
  "offer_type":      "targeted | open"
}
```

The on-IPFS storage format for each encrypted entry:

```json
{
  "epoch_id":   "<string — plaintext; identifies epoch key>",
  "nonce":      "<base64url — 96-bit random nonce>",
  "ciphertext": "<base64url — AES-GCM.Encrypt(AEK, PressIssuanceRecord plaintext, nonce)>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `epoch_id` | `text` | Yes | Identifies which epoch AEK decrypts this entry; stored in plaintext |
| `card_cid` | `cid` | Yes | Links to the issued card; enables auditor-assisted recovery if holder loses capability bundle |
| `scip_cid` | `cid` | Yes | Links to the SCIP for this issuance |
| `issued_at` | `timestamp` | Yes | Must match the card's `issued_at` |
| `requester_card` | `card-pointer` | No | Present for targeted issuance; absent for open offer claims |
| `offer_type` | `text` | Yes | `"targeted"` or `"open"` |

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
  "press_signature": "<ML-DSA-44 signature over canonical CBOR of all above fields>"
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
  "auditor_signature": "<ML-DSA-44 signature over canonical CBOR of all above fields>"
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
**Written by:** Press sub-card key (verified on-chain via Stylus ML-DSA-44)  
**Authoritative spec:** `specs/object_specs/registry_contract.md §3` — that document takes precedence over this section for all implementation details.

The on-chain records managed by the Card registry contract. Not JSON documents — this is the conceptual structure of the Stylus contract state.

**Per-card entry** (`CardEntries` mapping, keyed by `card_address`):

```
CardEntry {
    log_head_cid       bytes    — Current IPFS log head CID.
                                  Public mode:  plaintext CID bytes.
                                  Private mode: ML-KEM-encrypted CID bytes.
                                  Updated on every successful RegisterCard or UpdateMarkHead call.

    policy_address     bytes32  — On-chain registry address of the policy card under which
                                  this card was issued. Set at RegisterCard time; immutable
                                  thereafter. Used by the write gate to look up
                                  PressAuthorizations[policy_address, press_address].

    last_press_address bytes32  — On-chain registry address of the press sub-card whose key
                                  signed the most recent write (RegisterCard or UpdateMarkHead).
                                  Updated on every successful write. Provides an on-chain
                                  attribution trail independent of IPFS content.

    exists             bool     — True once the entry has been created by RegisterCard;
                                  used to distinguish unregistered addresses from cards
                                  whose log_head_cid is empty.
}
```

**Address derivation** (client-side; not enforced by the contract):

| Privacy mode | Derivation |
|---|---|
| Public | `keccak256(recipient_pubkey)` |
| Private | `keccak256(sign(recipient_private_key, "card-address-v1"))` |

**Write authorization:** A write to `log_head_cid` requires a valid ML-DSA-44 signature from a press whose key is registered in the on-chain `PressAuthorizations` table for the card's `policy_address`. The contract verifies this on-chain before accepting the write. (Note: the IPFS-stored `approved_presses` field in the policy card is an audit surface kept in sync with on-chain state; in the event of a discrepancy, on-chain state is authoritative — see ADR-011 in `ARCHITECTURE.md`.)

**Open offer counter table** (`OpenOfferUseCounts` mapping, keyed by offer ID):

```
OpenOfferUseCounts (mapping: bytes32 → uint64)
  offer_id   (bytes32)  — hash(canonical CBOR of the complete OpenCardOffer document
                           including issuer_signature); lazily initialized on first use
  use_count  (uint64)   — number of accepted claims; atomically incremented on each
                           successful card registration under this offer
```

The contract performs the following checks atomically with card registration for open offer submissions: (1) verifies the issuer's ML-DSA-44 signature over the offer payload; (2) confirms `block.timestamp < expires_at` (skipped if `expires_at` is null); (3) confirms `OpenOfferUseCounts[offer_id] < max_acceptances` (skipped if `max_acceptances` is null); (4) atomically increments the counter and registers the card. If any check fails, the transaction reverts.

For the full storage layout, write operations, read operations, governance tables, events, and error codes, see `specs/object_specs/registry_contract.md`.

---

## 15. SubCardRegistration

**Stored on:** Arbitrum One (on-chain)  
**Written by:** Holder's primary card key or press (open — see INC-10 / OQ-16)  
**IPFS document:** See §16 (SubCardDocument) for the full off-chain record; §15 describes only the on-chain registration entry.

Maps a sub-card's registry address to its holder's primary card and the requesting app's card. Also records the primary card's log head CID at registration time, enabling scope-attenuation checks — a sub-card cannot use authority the primary card did not have at the time of registration.

```json
{
  "holderPrimaryCardAddress": "<on-chain registry address of the holder's primary card>",
  "appCardAddress":            "<on-chain registry address of the app's card>",
  "registrationLogHeadCid":   "<base64url — log head CID of the primary card at registration time>"
}
```

| Field | Type | Notes |
|---|---|---|
| `holderPrimaryCardAddress` | `text` | Registry address of the holder's primary card; establishes the delegation chain |
| `appCardAddress` | `text` | Registry address of the app's card; used to verify the app's certification chain on-chain |
| `registrationLogHeadCid` | `base64url` | Snapshot of primary card log state at registration; used for scope-attenuation verification |

---

## 16. SubCardDocument

**Stored on:** IPFS  
**Signed by:** App card key (first), then Holder primary card key (countersignature)  
**Serialized for signing:** Canonical CBOR of the full document (offer phase: without `app_signature` and `holder_signature`; countersign phase: including `app_signature`, without `holder_signature`; final: complete)

The genesis document for a sub-card — a device-bound, app-specific credential that delegates a scoped subset of a holder's signing authority to a specific application. Unlike `CardDocument`, which is initiated by the press, a `SubCardDocument` is initiated and first-signed by the **requesting app** using its own app card key, then countersigned by the **holder** using their primary card key. There is no press in sub-card issuance; the wallet is the authorizing party.

```json
{
  "holder_primary_card": "<base64url — mutable pointer of the holder's primary card>",
  "app_card":            "<base64url — mutable pointer of the requesting app's card>",
  "capabilities":        ["<message type string>", "..."],
  "recipient_pubkey":    "<base64url — sub-card ML-DSA-44 public key, 1312 bytes raw>",
  "issued_at":           "<ISO 8601 timestamp>",
  "valid_until":         "<ISO 8601 timestamp — optional; absent means no expiry>",
  "app_signature":       "<base64url — app card key ML-DSA-44 signature over canonical CBOR of document without both signature fields>",
  "holder_signature":    "<base64url — holder primary card key ML-DSA-44 signature over canonical CBOR of document including app_signature, without holder_signature>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `holder_primary_card` | `card-pointer` | Yes | Mutable pointer of the card this sub-card delegates from; establishes the chain-of-trust link on verification |
| `app_card` | `card-pointer` | Yes | Mutable pointer of the requesting app's card; must chain to the governance authority's app-certification policy |
| `capabilities` | `array of text` | Yes | Whitelist of message type strings this sub-card may sign (e.g. `["auth_response", "exchange_offer"]`). An empty array is valid but non-functional. |
| `recipient_pubkey` | `base64url` | Yes | ML-DSA-44 public key generated in device hardware-backed secure storage; 1312 bytes raw |
| `issued_at` | `timestamp` | Yes | Set by the app at document assembly time |
| `valid_until` | `timestamp` | No | Optional expiry; verifiers must reject signatures from expired sub-cards |
| `app_signature` | `base64url` | Yes | App's card key signature over canonical CBOR of the document without `app_signature` or `holder_signature` |
| `holder_signature` | `base64url` | Yes | Holder's primary card key signature over canonical CBOR of the document including `app_signature`, without `holder_signature` |

**Signing sequence:**

1. App generates a fresh ML-DSA-44 keypair in device hardware-backed secure storage → `recipient_pubkey`. The private key is scoped to the app's signing identity; it cannot be exported.
2. App assembles the document with `holder_primary_card`, `app_card`, `capabilities`, `recipient_pubkey`, `issued_at` (and optionally `valid_until`), leaving both signature fields absent.
3. App signs canonical CBOR of that document → `app_signature`.
4. App sends the partially-signed document to the wallet.
5. Wallet verifies `app_signature` and walks the `app_card` chain to confirm it chains to the governance authority's app-certification policy root.
6. Wallet presents to the user: app identity (from `app_card`), requested `capabilities`, and optional `valid_until`. User approves or denies.
   - **Wallet self-signing exception:** When the wallet is the requesting app (i.e. `app_card` is the wallet's own card), step 6 is skipped. The user already trusts the wallet with their primary key.
7. Holder's primary card key signs canonical CBOR of the document including `app_signature`, without `holder_signature` → `holder_signature`.
8. Completed SubCardDocument is posted to IPFS.
9. Sub-card is registered on Arbitrum One via `RegisterSubCard` (see §15).

**Verifier chain walk.** A verifier encountering a signature from a sub-card must confirm: (1) the message type appears in the sub-card's `capabilities`; (2) `valid_until` has not passed; (3) `app_signature` is valid; (4) `holder_signature` is valid; (5) `app_card` chains to the governance app-certification policy root; (6) the sub-card is not revoked in the on-chain registry.

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
  └── on-chain registration → SubCardRegistration (Arbitrum One)

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

Objects marked **CBOR-signed** use canonical CBOR per Appendix A of `card_protocol_spec.md` as the byte sequence over which signatures are computed. Objects marked **JSON** use standard JSON (no canonical form required).

| Object | Storage | Signing serialization |
|---|---|---|
| CardDocument | IPFS | CBOR-signed (offer phase, then complete) |
| PolicyCardDocument | IPFS | CBOR-signed (same as CardDocument) |
| LogEntry | IPFS | CBOR-signed (`intent_signature` over UpdateIntentPayload; `press_signature` over complete LogEntry) |
| UpdateIntentPayload | In-transit | CBOR-signed |
| SignedMessageEnvelope | In-transit | CBOR-signed (payload only) |
| OpenCardOffer | HTTPS / IPFS | CBOR-signed (all except `issuer_signature`) |
| OpenOfferClaimSubmission | In-transit (HTTPS POST to press) | `recipient_signature` covers canonical CBOR of `claim_payload`; `claim_payload.offer.issuer_signature` separately verified by press |
| AuthenticationRequest | HTTPS | CBOR-signed (all except `request_signature`) |
| AuthenticationResponse | In-transit | Not signed as a whole; contains a SignedMessageEnvelope |
| SCIP | In-transit / IPFS | CBOR-signed (all except `press_signature`) |
| PressIssuanceRecord | IPFS (encrypted) | Not signed; encrypted via ML-KEM |
| CardEntry | Arbitrum One | On-chain; write authorized by ML-DSA-44 sig verified by Stylus against `PressAuthorizations` table |
| SubCardRegistration | Arbitrum One | On-chain; write authorized by master card key |
