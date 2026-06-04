# Chitt Protocol — Object Reference

**Version:** 0.1 (draft)  
**Date:** 2026-05-21  
**Status:** In Review

This document is the canonical reference for every structured object in the Chitt Protocol. Each object is shown as an annotated JSON template (the developer-facing input surface). Objects that are signed or hashed use **canonical CBOR** (RFC 8949 deterministic encoding with protocol-specific overrides) as the byte sequence over which signatures are computed — see Appendix A of `chitt_protocol_spec.md` for the full serialization rules.

---

## Contents

1. [ChittDocument](#1-chittdocument)
2. [PolicyChittDocument](#2-policychittdocument)
3. [LogEntry](#3-logentry)
4. [UpdateIntentPayload](#4-updateintentpayload)
5. [SignedMessageEnvelope](#5-signedmessageenvelope)
6. [OpenChittOffer](#6-openchittoffer)
7. [OpenOfferClaimSubmission](#7-openofferclaimsubmission)
8. [AuthenticationRequest](#8-authenticationrequest)
9. [AuthenticationResponse](#9-authenticationresponse)
10. [SCIP](#10-scip)
11. [PressIssuanceRecord](#11-pressissuancerecord)
12. [AuditEpochEntry](#12-auditepochentry)
13. [AuditEpochCommitment](#13-auditepochcommitment)
14. [RegistryEntry](#14-registryentry)
15. [SubChittRegistration](#15-subchittregistration)

---

## Common Sub-Objects

### SignatureEntry

Appears inside several objects wherever a single party's ML-DSA-44 signature is recorded.

```json
{
  "signer_chitt": "<base64url — mutable pointer in registry of the signing sub-chitt>",
  "public_key":   "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
  "signature":    "<base64url — ML-DSA-44 signature, 2420 bytes raw>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `signer_chitt` | `chitt-pointer` | Yes | On-chain registry address of the signing sub-chitt |
| `public_key` | `base64url` | Yes | Must match the key registered to `signer_chitt` |
| `signature` | `base64url` | Yes | Over canonical CBOR of the stated payload (varies per object) |

---

## 1. ChittDocument

**Stored on:** IPFS  
**Signed by:** Press (offer), then Holder (countersignature)  
**Serialized for signing:** Canonical CBOR of the full document (offer phase: without `holder_signature` and `recipient_pubkey`; final phase: complete document)

The genesis document of a chitt. Every chitt — including policy chitts, press sub-chitts, and user chitts — begins life as a ChittDocument posted to IPFS. Its CID is recorded as the initial log head in the Arbitrum One registry.

```json
{
  "policy_id":        "<base64url — CID of the governing policy chitt>",
  "press_chitt":      "<base64url — mutable pointer in registry of the issuing press sub-chitt>",
  "recipient_pubkey": "<base64url — recipient's ML-DSA-44 public key, 1312 bytes raw>",
  "issued_at":        "<ISO 8601 timestamp>",
  "offer_signature":  "<base64url — press's ML-DSA-44 signature over canonical CBOR of the offer payload>",
  "holder_signature": "<base64url — holder's ML-DSA-44 countersignature over canonical CBOR of the completed chitt>",

  "<policy-defined fields>": "..."
}
```

| Field | Type | Required | Mutable | Notes |
|---|---|---|---|---|
| `policy_id` | `cid` | Yes | No | Pinned to the policy at time of issuance |
| `press_chitt` | `chitt-pointer` | Yes | No | Identifies the issuing press; used to walk the authorization chain |
| `recipient_pubkey` | `base64url` | Yes | No | Added by holder before countersigning; empty in the offer phase |
| `issued_at` | `timestamp` | Yes | No | Set by press at offer creation |
| `offer_signature` | `base64url` | Yes | No | Press signs the offer payload (all fields except `recipient_pubkey` and `holder_signature`) |
| `holder_signature` | `base64url` | Yes | No | Holder signs the complete document (all fields including `recipient_pubkey`) |

**Signing sequence:**
1. Press assembles the document with all policy-defined fields and `issued_at`, leaving `recipient_pubkey` and `holder_signature` absent.
2. Press signs canonical CBOR of the current document → `offer_signature`.
3. Holder reviews, generates fresh ML-DSA-44 keypair, adds `recipient_pubkey`.
4. Holder signs canonical CBOR of the complete document → `holder_signature`.
5. Completed document is posted to IPFS.

---

## 2. PolicyChittDocument

**Stored on:** IPFS  
**Is a:** ChittDocument (same protocol-required fields plus the policy fields below)

A policy chitt is a ChittDocument whose content defines the rules for a class of chitts. All the protocol-required fields of ChittDocument apply. The additional fields below are the policy's own field values (analogous to the policy-defined fields of any chitt, but standardised across all policies).

```json
{
  "policy_id":        "<base64url — CID of the meta-policy governing this policy chitt>",
  "press_chitt":      "<base64url — mutable pointer in registry of the policy authorizer's chitt>",
  "recipient_pubkey": "<base64url — administrator's ML-DSA-44 public key>",
  "issued_at":        "<ISO 8601 timestamp>",
  "offer_signature":  "<base64url>",
  "holder_signature": "<base64url>",

  "field_definitions": [
    {
      "name":          "<field name>",
      "type":          "<text | base64url | integer | number | boolean | date | timestamp | cid | chitt-pointer | chitt-pointer-array | append-only-array>",
      "required":      true,
      "description":   "<human-readable description>",
      "update_policy": { "<predicate expression>" },
      "<type-specific validation options>": "..."
    }
  ],
  "recipient_predicate":   { "<optional chitt predicate expression>" },
  "requester_predicate":   { "<optional chitt predicate expression>" },
  "auditors":              ["<base64url chitt-pointer>", "..."],
  "approved_presses":      ["<base64url chitt-pointer>", "..."],
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
| `field_definitions` | array | Yes | Schema for chitts issued under this policy |
| `recipient_predicate` | predicate | No | Chain predicate the recipient must satisfy; absent = unconstrained |
| `requester_predicate` | predicate | No | Chain predicate the requester must satisfy; absent = unconstrained |
| `auditors` | `chitt-pointer-array` | No | Auditors receive ML-KEM-encrypted copies of each issuance log entry |
| `approved_presses` | `chitt-pointer-array` | No | Presses whose sub-chitt pointers may write to this policy's chitts |
| `valid_until` | `timestamp` | No | Press rejects issuance requests after this time |
| `allow_open_offers` | `boolean` | No | Default `false`; must be `true` to permit open chitt offers under this policy |
| `revocation_permissions` | object | No | Predicates controlling who may post 8xx and 9xx entries; defaults to holder-or-issuer for 8xx, issuer-only for 9xx |
| `notes` | `append-only-array` of `text` | No | Append-only annotations |
| `policy_creation` | object | No | Constraints on policies that holders of this policy's chitts may create |

---

## 3. LogEntry

**Stored on:** IPFS (chained via `prev_log_root`)  
**On-chain pointer:** Arbitrum One registry entry for the chitt points to the current log head CID  
**Signed by:** Updater (`intent_signature`) then Press (`press_signature`)  
**Serialized for signing:**
- `intent_signature` covers canonical CBOR of the `UpdateIntentPayload` (see §4)
- `press_signature` covers canonical CBOR of the complete `LogEntry` document excluding the `press_signature` field itself

Every post-genesis state change to a chitt — field updates, annotations, and revocations — is a LogEntry appended to the chitt's IPFS log. The log is a singly-linked list; each entry points back to the prior head. The Arbitrum One registry tracks only the current head CID.

```json
{
  "version":         2,
  "code":            300,
  "entry_type":      "field_update",
  "prev_log_root":   "<base64url — CID of the prior log entry (or genesis ChittDocument for version 2)>",

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
    "signer_chitt": "<base64url — mutable pointer in registry of updater's sub-chitt>",
    "public_key":   "<base64url — updater's ML-DSA-44 public key>",
    "signature":    "<base64url — sig over canonical CBOR of the UpdateIntentPayload>"
  },
  "press_signature": {
    "signer_chitt": "<base64url — mutable pointer in registry of press sub-chitt>",
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
| `prev_log_root` | `cid` | Yes | CID of the prior log entry; genesis ChittDocument CID for `version == 1` |
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
  "target_chitt":  "<base64url — mutable pointer in registry of the chitt being updated>",
  "updater_chitt": "<base64url — mutable pointer in registry of the updater's chitt>",
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
| `target_chitt` | `chitt-pointer` | Yes | The chitt being updated |
| `updater_chitt` | `chitt-pointer` | Yes | The updater's chitt; used to evaluate `update_policy` predicates |
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
**Signed by:** One or more chitt holders (parallel co-signing)  
**Serialized for signing:** Canonical CBOR of the `payload` object only (not the outer envelope)

The primary object for chitt-authenticated communication and for authentication responses (§8).

```json
{
  "payload": {
    "content":      "<message body>",
    "recipients":   ["<base64url — mutable pointer>", "..."],
    "timestamp":    "<ISO 8601 timestamp>",
    "in_reply_to":  "<base64url — hash of prior payload — optional>",
    "edit_of":      "<base64url — hash of prior payload — optional; mutually exclusive with retracts>",
    "retracts":     "<base64url — hash of prior payload — optional; mutually exclusive with edit_of>"
  },
  "signatures": [
    {
      "signer_chitt": "<base64url — mutable pointer in registry of signing sub-chitt>",
      "public_key":   "<base64url — ML-DSA-44 public key>",
      "signature":    "<base64url — sig over canonical CBOR of the payload object>"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `payload.content` | `text` | Yes | The message body |
| `payload.recipients` | `chitt-pointer-array` | Yes | Mutable pointers of intended recipients; part of the signed payload |
| `payload.timestamp` | `timestamp` | Yes | ISO 8601; replay prevention |
| `payload.in_reply_to` | `base64url` | No | Hash of the payload this is replying to |
| `payload.edit_of` | `base64url` | No | Hash of the payload this supersedes; mutually exclusive with `retracts` |
| `payload.retracts` | `base64url` | No | Hash of the payload being retracted; mutually exclusive with `edit_of` |
| `signatures` | array of SignatureEntry | Yes | One entry per signer; each covers the same canonical payload bytes |

The **message ID** is the hash of the canonical CBOR of `payload`. There is no separate ID field.

---

## 6. OpenChittOffer

**Stored on:** Wallet service (HTTPS); may also be pinned to IPFS  
**Signed by:** Issuer  
**Serialized for signing:** Canonical CBOR of all fields except `issuer_signature`

A pre-signed batch authorization allowing any bearer to claim a chitt under this policy without individual issuer review. The policy chitt must have `allow_open_offers: true`.

When a recipient accepts, their wallet wraps this document in an `OpenOfferClaimSubmission` (§7), adds a freshly-generated public key, countersigns, and POSTs to the press. The press constructs the `ChittDocument` from `proposed_fields` plus the recipient's public key.

```json
{
  "offer_type":        "open",
  "policy_id":         "<base64url — CID of the governing policy chitt>",
  "press_chitt":       "<base64url — mutable pointer in registry of the approved press>",
  "issuer_chitt":      "<base64url — mutable pointer in registry of the issuer's chitt>",
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
| `press_chitt` | `chitt-pointer` | Yes | Must appear in policy's `approved_presses` |
| `issuer_chitt` | `chitt-pointer` | Yes | Used to evaluate `requester_predicate` |
| `max_acceptances` | `integer` | No | Null = unconstrained |
| `expires_at` | `timestamp` | No | Null = unconstrained; enforced atomically on-chain |
| `display_message` | `text` | No | Human-readable context shown in wallet UI |
| `redirect_url` | `text` | No | Wallet redirects recipient here after issuance |
| `proposed_fields` | object | Yes | Issuer-populated field values for issued chitts |
| `issuer_signature` | `base64url` | Yes | Covers canonical CBOR of all fields except itself |

The **offer ID** used for on-chain counter tracking is `hash(canonical CBOR of the complete document including issuer_signature)`. This binds the offer ID to the issuer's signature, making it unique per issuer and unforgeable. The contract stores a per-offer-ID acceptance counter in `openOfferUseCounts` (see §14).

---

## 7. OpenOfferClaimSubmission

**Transmitted to:** Press (via HTTPS POST from wallet service)  
**Signed by:** Recipient  
**Serialized for signing:** Canonical CBOR of `claim_payload` (see below)

The object the wallet service POSTs to the press when a recipient accepts an open chitt offer. The press uses `claim_payload.offer.proposed_fields` to construct the `ChittDocument`, adding `recipient_pubkey` and signing the result as in the targeted issuance flow.

```json
{
  "claim_payload": {
    "offer":           { "<verbatim OpenChittOffer document including issuer_signature>" },
    "recipient_pubkey": "<base64url — recipient's freshly-generated ML-DSA-44 public key, 1312 bytes raw>"
  },
  "recipient_signature": "<base64url — recipient's ML-DSA-44 sig over canonical CBOR of claim_payload>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `claim_payload.offer` | OpenChittOffer | Yes | Verbatim; press re-verifies `issuer_signature` over this |
| `claim_payload.recipient_pubkey` | `base64url` | Yes | Public key for the new chitt; press copies this into the assembled `ChittDocument` |
| `recipient_signature` | `base64url` | Yes | Sig over canonical CBOR of the entire `claim_payload` object (offer + recipient_pubkey); press verifies before proceeding |

**Press validation on receipt:**

1. Re-verify `claim_payload.offer.issuer_signature` over the offer document.
2. Verify `recipient_signature` over canonical CBOR of `claim_payload`.
3. Confirm `claim_payload.offer.press_chitt` matches the receiving press's own sub-chitt pointer.
4. Confirm the policy has `allow_open_offers: true`.
5. Check on-chain open offer constraints (`max_acceptances`, `expires_at`) atomically with chitt registration.
6. Assemble and countersign the `ChittDocument` from `proposed_fields` + `recipient_pubkey`, then proceed as in targeted issuance (steps 9–14 of the issuance flow).

**Note on the recipient's key:** `recipient_pubkey` in the claim payload is logically equivalent to the same field added by the holder in the targeted issuance flow — the recipient generates it fresh at claim time and its private counterpart never leaves their device.

---

## 8. AuthenticationRequest

**Hosted at:** Single-use HTTPS URL (requesting site's infrastructure)  
**Signed by:** Requesting site (using its own chitt key)  
**Serialized for signing:** Canonical CBOR of all fields except `request_signature`

The object a site creates when it wants a user to authenticate with a chitt. Hosted at a single-use URL and fetched by the wallet service via CHAPI.

```json
{
  "session_id":       "<UUID — stable identifier for this auth session>",
  "version":          "1",
  "purpose":          "<human-readable description shown to user>",
  "requesting_site":  "<origin of the requesting site, for display>",
  "requester_chitt":  "<base64url — mutable pointer in registry of the requesting site's chitt>",
  "payload": {
    "content": "<the content the user is being asked to sign>",
    "context": "<optional additional human-readable context>",
    "nonce":   "<random value — replay prevention>"
  },
  "required_predicate": { "<optional chitt predicate expression — same format as §1>" },
  "required_policy":    "<base64url — CID of a required policy chitt — optional>",
  "callbacks": {
    "https": "<HTTPS URL to POST the signed response to — required>",
    "ohttp": {
      "relay":       "<OHTTP relay URL>",
      "gateway_key": "<base64url — OHTTP gateway public key — optional>"
    }
  },
  "redirect_uri":     "<URL to redirect user to after completion; must contain literal {code}>",
  "expires_at":       "<ISO 8601 timestamp>",
  "request_signature":"<base64url — ML-DSA-44 sig from the requester's chitt key over canonical CBOR of all above fields>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | UUID; ties the confirmation code to this session |
| `version` | `text` | Yes | Always `"1"` in v1 |
| `purpose` | `text` | Yes | Displayed to user in wallet UI |
| `requesting_site` | `text` | Yes | Display-only origin |
| `requester_chitt` | `chitt-pointer` | Yes | Wallet uses this for chain verification |
| `payload.content` | `text` | Yes | The statement the user will countersign |
| `payload.nonce` | `text` | Yes | Incorporated into signed statement; must be verified to prevent replay |
| `required_predicate` | predicate | No | Chain predicate the user's chitt must satisfy |
| `required_policy` | `cid` | No | Policy chitt CID the user's chitt must have been issued under |
| `callbacks.https` | `text` | Yes | Required fallback |
| `callbacks.ohttp` | object | No | For IP-private response |
| `redirect_uri` | `text` | Yes | Must contain `{code}` placeholder |
| `expires_at` | `timestamp` | Yes | Wallet rejects requests past this time |
| `request_signature` | `base64url` | Yes | Wallet verifies before displaying |

---

## 9. AuthenticationResponse

**Transmitted via:** OHTTP (optional) / HTTPS  
**Sent by:** Wallet service  
**Contains:** A `SignedMessageEnvelope` (§5) over `payload` from the request

The object the wallet posts after user approval. The `signed_statement` is a `SignedMessageEnvelope` whose payload is the canonical CBOR of the `payload` object from the `AuthenticationRequest`.

```json
{
  "session_id":       "<matches the AuthenticationRequest>",
  "signed_statement": {
    "payload": {
      "content":    "<copied from AuthenticationRequest.payload.content>",
      "context":    "<copied from AuthenticationRequest.payload.context — optional>",
      "nonce":      "<copied from AuthenticationRequest.payload.nonce>",
      "recipients": ["<base64url — requester_chitt mutable pointer>"]
    },
    "signatures": [
      {
        "signer_chitt": "<base64url — mutable pointer of sub-chitt used to sign>",
        "public_key":   "<base64url>",
        "signature":    "<base64url — sig over canonical CBOR of payload>"
      }
    ]
  },
  "chitt_pointer":    "<base64url — mutable pointer in registry of the chitt used to sign>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | `text` | Yes | Must match the request |
| `signed_statement` | SignedMessageEnvelope | Yes | Requester verifies this per §7 |
| `chitt_pointer` | `chitt-pointer` | Yes | The chitt the user chose; used to look up chain and predicate evaluation |

The requesting site verifies `signed_statement` per §7 (chain walk, revocation check, predicate evaluation, nonce match) before issuing a confirmation code.

---

## 10. SCIP

**Signed Chitt Inclusion Proof**  
**Produced by:** Press  
**Delivered to:** Recipient (and courtesy copy to administrator) via HTTPS to wallet service endpoints  
**Serialized for signing:** Canonical CBOR of all fields except `press_signature`

A small signed object that binds a newly-issued chitt's CID to its position in the policy's issuance log at time of inclusion. The recipient retains this as verifiable proof of issuance.

```json
{
  "chitt_cid":                  "<base64url — CID of the completed ChittDocument>",
  "policy_log_entry_index":     1,
  "policy_log_root_at_inclusion":"<base64url — CID of the policy chitt's log head at time of issuance>",
  "issued_at":                  "<ISO 8601 timestamp>",
  "press_signature": {
    "signer_chitt": "<base64url — mutable pointer in registry of press sub-chitt>",
    "public_key":   "<base64url>",
    "signature":    "<base64url — sig over canonical CBOR of all above fields>"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `chitt_cid` | `cid` | Yes | Content address of the issued chitt; verifier can fetch and inspect |
| `policy_log_entry_index` | `integer` | Yes | Position of the issuance record in the policy's press log |
| `policy_log_root_at_inclusion` | `cid` | Yes | Allows the recipient to anchor the issuance to the policy log state at a specific point in time |
| `issued_at` | `timestamp` | Yes | Must match the chitt's `issued_at` field |
| `press_signature` | SignatureEntry | Yes | Binds all above fields; verifier confirms press is in `approved_presses` |

---

## 11. PressIssuanceRecord

**Stored on:** IPFS, within the policy chitt's append-only press log  
**Encrypted with:** The current audit epoch's AEK (AES-GCM, per-entry random nonce)  
**Access:** Only by auditors holding a wrapped copy of the epoch AEK; press operator cannot decrypt

The plaintext content of each press log entry. Entries are encrypted under the epoch AEK shared across all auditors for that epoch (see `AuditEpochEntry` §12). Each entry carries `epoch_id` in plaintext so that auditors can identify which epoch key to use for decryption without reading the ciphertext.

```json
{
  "epoch_id":        "<string — identifies the audit epoch this entry belongs to>",
  "chitt_cid":       "<base64url — CID of the issued ChittDocument>",
  "scip_cid":        "<base64url — CID of the SCIP posted to IPFS>",
  "issued_at":       "<ISO 8601 timestamp>",
  "requester_chitt": "<base64url — mutable pointer of the requester's chitt — optional>",
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
| `chitt_cid` | `cid` | Yes | Links to the issued chitt; enables auditor-assisted recovery if holder loses capability bundle |
| `scip_cid` | `cid` | Yes | Links to the SCIP for this issuance |
| `issued_at` | `timestamp` | Yes | Must match the chitt's `issued_at` |
| `requester_chitt` | `chitt-pointer` | No | Present for targeted issuance; absent for open offer claims |
| `offer_type` | `text` | Yes | `"targeted"` or `"open"` |

---

## 12. AuditEpochEntry

**Stored on:** IPFS, within the policy chitt's append-only press log  
**Written by:** Press (at epoch open and epoch close)  
**Signed by:** Press sub-chitt key

Posted to the policy log at the start and end of each audit epoch. On open, it distributes the epoch AEK wrapped under each active auditor's ML-KEM public key. On close, it records the epoch's `AuditEpochCommitment` CID and marks the epoch as permanently closed.

```json
{
  "type":           "audit_epoch_entry",
  "status":         "open | closed",
  "epoch_id":       "<string — e.g. '2026' for annual epochs, or sequential integer>",
  "epoch_start":    "<ISO 8601 timestamp — set on open; null on close>",
  "epoch_end":      "<ISO 8601 timestamp — set on close; null on open>",
  "auditor_key_packages": [
    {
      "auditor_chitt":  "<base64url — mutable pointer of the auditor's chitt>",
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
| `auditor_key_packages[].auditor_chitt` | `chitt-pointer` | Yes (per package) | Identifies the auditor |
| `auditor_key_packages[].kem_ciphertext` | `bytes` | Yes (per package) | ML-KEM.Encaps output; auditor decapsulates with their private key to recover `kem_shared_secret` |
| `auditor_key_packages[].wrapped_aek` | `bytes` | Yes (per package) | AEK wrapped under `HKDF-SHA3-256(kem_shared_secret, "audit-epoch-aek-v1")`; 32-byte AEK + 12-byte nonce + 16-byte GCM tag |
| `commitment_cid` | `cid` | On close | Points to the `AuditEpochCommitment` IPFS document |
| `close_reason` | `text` | On close | Why the epoch closed; informational |
| `press_signature` | `SignatureEntry` | Yes | Binds all fields; signed with the press sub-chitt key |

The press must not generate issuance entries for an epoch after posting a `status: "closed"` entry for it.

---

## 13. AuditEpochCommitment

**Stored on:** IPFS (standalone document, not part of the policy log directly)  
**Written by:** Auditor  
**Signed by:** Auditor chitt key  
**Referenced by:** The `AuditEpochEntry` with `status: "closed"` in the policy log

The permanent audit record for a closed epoch. The auditor produces this document after decrypting all entries in the epoch, then destroys the epoch AEK. The commitment is the only remaining evidence of what the epoch contained; it is signed by the auditor and publicly verifiable.

```json
{
  "type":             "audit_epoch_commitment",
  "epoch_id":         "<string — matches the epoch_id in the corresponding AuditEpochEntry>",
  "policy_chitt":     "<base64url — mutable pointer of the policy chitt>",
  "auditor_chitt":    "<base64url — mutable pointer of this auditor's chitt>",
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
| `policy_chitt` | `chitt-pointer` | Yes | Identifies the policy this commitment covers |
| `auditor_chitt` | `chitt-pointer` | Yes | Identifies the signing auditor |
| `period_start` | `timestamp` | Yes | Must match the `epoch_start` from the opening `AuditEpochEntry` |
| `period_end` | `timestamp` | Yes | Must match the `epoch_end` from the closing `AuditEpochEntry` |
| `entry_count` | `integer` | Yes | Number of `PressIssuanceRecord` entries decrypted; enables detection of missing entries |
| `entries_hash` | `bytes` | Yes | SHA3-256(concat of all entry CIDs in log order); a verifier with the raw entries can confirm the auditor processed all of them |
| `findings` | `text` | Yes | Human-readable audit summary; required even if empty |
| `auditor_signature` | `SignatureEntry` | Yes | Binds all fields; signed with the auditor's chitt key |

The `entries_hash` is a completeness commitment: it proves the auditor saw all entries in sequence and did not skip any. A verifier who later obtains the decrypted entries (through any channel) can recompute the hash and confirm it matches the commitment. The commitment does not prove the auditor correctly classified each entry — it proves they processed them.

---

## 14. RegistryEntry

**Stored on:** Arbitrum One (on-chain)  
**Written by:** Press sub-chitt key (verified on-chain via Stylus ML-DSA-44)

The on-chain records managed by the Chitt registry contract. Not JSON documents — this is the conceptual structure of the Stylus contract state.

**Per-chitt registry entry** (one per registered chitt):

```
address (bytes32)          — The chitt's registry address:
                               public mode:  hash(public_key)
                               private mode: hash(sign(private_key, "chitt-log-v1"))
log_head_cid (bytes)       — Current log head CID:
                               public mode:  plaintext CID bytes
                               private mode: ML-KEM-encrypted CID bytes
```

A write to `log_head_cid` requires a valid ML-DSA-44 signature from a press sub-chitt key that appears in the policy chitt's `approved_presses`. The contract verifies this on-chain before accepting the write.

**Open offer counter table** (shared; keyed by offer ID):

```
openOfferUseCounts (mapping: bytes32 → uint64)
  offer_id   (bytes32)     — hash(canonical CBOR of the complete OpenChittOffer document
                               including issuer_signature); lazily initialized on first use
  use_count  (uint64)      — number of accepted claims; atomically incremented on each
                               successful chitt registration under this offer
```

The contract performs the following checks atomically with chitt registration for open offer submissions: (1) verifies the issuer's ML-DSA-44 signature over the offer payload; (2) confirms `block.timestamp < expires_at` (skipped if `expires_at` is null); (3) confirms `openOfferUseCounts[offer_id] < max_acceptances` (skipped if `max_acceptances` is null); (4) atomically increments the counter and registers the chitt. If any check fails, the transaction reverts.

---

## 15. SubChittRegistration

**Stored on:** Arbitrum One (on-chain)  
**Written by:** Master chitt key at sub-chitt creation time

Maps a sub-chitt's registry address to its master chitt's registry address. Also records the master chitt's log head CID at registration time, enabling scope-attenuation checks — a sub-chitt cannot use authority its master did not have at the time of registration.

```json
{
  "masterChittAddress":      "<on-chain registry address of the master chitt>",
  "registrationLogHeadCid":  "<base64url — log head CID of the master chitt at registration time>"
}
```

| Field | Type | Notes |
|---|---|---|
| `masterChittAddress` | `text` | Registry address string; used as the stable identity of the master chitt |
| `registrationLogHeadCid` | `base64url` | Snapshot of master log state; used for scope-attenuation verification |

---

## Object Relationship Summary

```
PolicyChittDocument (IPFS)
  └── approved_presses → [ChittDocument (press sub-chitt)] (IPFS)
  └── auditors → [ChittDocument (auditor chitt)] (IPFS)
  └── policy press log → [PressIssuanceRecord (encrypted)] (IPFS)
       └── chitt_cid → ChittDocument (issued chitt) (IPFS)
       └── scip_cid → SCIP (IPFS)

ChittDocument (IPFS)
  └── policy_id → PolicyChittDocument (IPFS)
  └── press_chitt → ChittDocument (press sub-chitt) (IPFS)
  └── chitt log → [LogEntry (IPFS, chained via prev_log_root)]
  └── sub-chitts → SubChittRegistration (Arbitrum One)
       └── sub-chitt keys → SignatureEntry (in SignedMessageEnvelope / AuthRequest / LogEntry)

OpenChittOffer (HTTPS / IPFS)          — issuer-side
  └── policy_id → PolicyChittDocument (IPFS)
  └── press_chitt → ChittDocument (press sub-chitt) (IPFS)
  └── issuer_chitt → ChittDocument (issuer's master chitt) (IPFS)
  └── claimed via → OpenOfferClaimSubmission (in-transit to press)
       └── → ChittDocument (issued chitt) (IPFS, assembled by press)
       └── → offer_id entry in openOfferUseCounts (Arbitrum One)

RegistryEntry (Arbitrum One)
  └── log_head_cid → ChittDocument | LogEntry (IPFS, current head)
  └── openOfferUseCounts[offer_id] → acceptance counter
```

---

## Serialization Quick Reference

Objects marked **CBOR-signed** use canonical CBOR per Appendix A of `chitt_protocol_spec.md` as the byte sequence over which signatures are computed. Objects marked **JSON** use standard JSON (no canonical form required).

| Object | Storage | Signing serialization |
|---|---|---|
| ChittDocument | IPFS | CBOR-signed (offer phase, then complete) |
| PolicyChittDocument | IPFS | CBOR-signed (same as ChittDocument) |
| LogEntry | IPFS | CBOR-signed (`intent_signature` over UpdateIntentPayload; `press_signature` over complete LogEntry) |
| UpdateIntentPayload | In-transit | CBOR-signed |
| SignedMessageEnvelope | In-transit | CBOR-signed (payload only) |
| OpenChittOffer | HTTPS / IPFS | CBOR-signed (all except `issuer_signature`) |
| OpenOfferClaimSubmission | In-transit (HTTPS POST to press) | `recipient_signature` covers canonical CBOR of `claim_payload`; `claim_payload.offer.issuer_signature` separately verified by press |
| AuthenticationRequest | HTTPS | CBOR-signed (all except `request_signature`) |
| AuthenticationResponse | In-transit | Not signed as a whole; contains a SignedMessageEnvelope |
| SCIP | In-transit / IPFS | CBOR-signed (all except `press_signature`) |
| PressIssuanceRecord | IPFS (encrypted) | Not signed; encrypted via ML-KEM |
| RegistryEntry | Arbitrum One | On-chain; write authorized by ML-DSA-44 sig verified by Stylus |
| SubChittRegistration | Arbitrum One | On-chain; write authorized by master chitt key |
