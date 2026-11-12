# Card Protocol — Messaging Protocol Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-28  
**Status:** Draft  
**Amended 2026-11-08 (card login):** §13 `auth_request` is now a reference to a signed `AuthenticationRequest`; §14 `auth_response` content revised; new §23 `auth_confirmation`; MSG-OQ-8 and MSG-OQ-9 resolved; Summary Table numbering corrected.

> **Terminology note.** This spec uses the canonical "card" terminology per the Naming Convention. The issuance service is the "press".

---

## Overview

Every message in the Card Protocol shares a common signed envelope. The envelope binds the message content, type, and recipient set together under one or more ML-DSA-44 signatures. Recipients and senders are expressed as **card hashes** — the on-chain registry addresses that serve as each card's stable identity. The same hash is the card's mutable pointer, its on-chain address, and its messaging address; no separate addressing scheme exists.

### Address Model

A card's **registry address** (its mutable pointer hash in the Arbitrum One card registry) is its messaging address. It is always derived from the card's public key: `keccak256(recipient_pubkey)` (see `ARCHITECTURE.md` ADR-006). This hash appears in the `recipients` and `senders` fields of every message envelope.

**Routing** (determining which wallet service holds a given card hash and delivering the encrypted payload to it) is handled by the wallet service layer, not the message envelope. See `process_specs/message_routing.md` for the routing protocol. The message envelope itself is E2E encrypted; wallet services see only the recipient hash from the routing header, not sender identity or message content.

### Common Envelope

```json
{
  "payload": {
    "type":              "<message type — see taxonomy below>",
    "content":           { ... },
    "edit_of":           "<hash of prior payload>",
    "forwards":          "<hash of the original payload being forwarded — set only on a ForwardPackage forward_envelope>",
    "in_reply_to":       "<hash of prior payload>",
    "protocol_version":  "<string — current protocol version, e.g. '0.1'; read from the logic contract via getProtocolVersion()>",
    "recipients":        ["<card hash — on-chain registry address>", ...],
    "retracts":          "<hash of prior payload>",
    "senders":           ["<card hash — on-chain registry address>", ...],
    "timestamp":         "<ISO 8601>"
  },
  "signatures": [
    {
      "public_key":   "<ML-DSA-44 public key, base64url>",
      "signature":    "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    }
  ]
}
```

> **RFC 8785 field ordering note:** The payload fields above are listed in their canonical lexicographic order. `protocol_version` sorts between `in_reply_to` (`in_r` < `proto`) and `recipients` (`proto` < `r`). `edit_of`, `retracts`, and `forwards` are optional; when absent they are omitted from the document (not set to `null`). Signing tools do not need to insert fields in this order — the RFC 8785 canonicalizer re-sorts automatically.

`edit_of`, `retracts`, and `forwards` are mutually exclusive (`in_reply_to` may accompany any of them). `forwards` is set only on the `forward_envelope` of a `ForwardPackage` (see `protocol-objects.md §5.1` and `process_specs/card_signing.md`). `type` is inside the payload and therefore covered by the signature — a recipient cannot be tricked about what kind of message they received. The hash of the canonical payload is the message ID; there is no separate `id` field. Each entry in `signatures` carries only `public_key` and `signature`; the signer's card hash is derived as `keccak256(public_key)` and is not stored in the entry.

`protocol_version` is required on every message payload. Senders populate it by calling `getProtocolVersion()` on the logic contract (or using the last known value, which is stable between protocol upgrades). Verifiers reject envelopes whose `protocol_version` is missing or not in their known-versions list.

`senders` lists the card hashes of the cards whose identity is being asserted by this message, parallel to the `signatures` array. A signer sub-card maps to exactly one sender master card. For most message types the sender list has one entry; co-signed messages may have several.

**The entire envelope is E2E encrypted before delivery.** The routing layer (wallet-service-to-wallet-service transport) sees only the recipient card hash from the outer routing header; it does not see `senders`, `type`, `content`, or any other envelope field. See `process_specs/message_routing.md` for the routing envelope format.

---

## Message Type Taxonomy

### 1. `text`

A free-form human-readable message.

```json
{
  "type": "text",
  "content": {
    "body":        "<string>",
    "format":      "plain | markdown",
    "attachments": [{ "cid": "<IPFS CID>", "mime_type": "<string>", "name": "<string>" }]
  }
}
```

**Notes.** Attachments are posted to IPFS separately; the message carries only the CID. Format defaults to `plain` if absent. Edits and retractions use the envelope-level `edit_of` / `retracts` fields rather than a separate type.

---

### 2. `reaction`

An emoji or short symbolic response attached to a specific prior message.

```json
{
  "type": "reaction",
  "content": {
    "emoji":      "<Unicode emoji or shortcode>",
    "target":     "<hash of the payload being reacted to>",
    "retract":    false
  }
}
```

**Notes.** `retract: true` withdraws a prior reaction from the same sender. Reactions are not themselves replyable; `in_reply_to` should not be set on a reaction. The `recipients` list on a reaction should match the `recipients` of the target message.

---

### 3. `reply`

A text message explicitly threaded under a prior message. Semantically equivalent to `text` with `in_reply_to` set, but typed separately to allow clients to handle threading logic without inspecting `in_reply_to` presence.

```json
{
  "type": "reply",
  "content": {
    "body":    "<string>",
    "format":  "plain | markdown",
    "quote":   "<optional excerpt of the referenced message for display>"
  }
}
```

**Notes.** `in_reply_to` in the envelope is required for this type. `quote` is informational only; verifiers should not trust it as an accurate representation of the referenced message — clients should fetch the original by hash.

---

### 4. `edit`

A signed revision to a prior message. Both sender and recipient maintain the full edit log locally as a linked chain.

```json
{
  "type": "edit",
  "content": {
    "body":         "<string — the new content>",
    "format":       "plain | markdown",
    "edit_summary": "<optional human-readable description of what changed>"
  }
}
```

`edit_of` in the envelope is **required** for this type and must be the hash of the immediately preceding version (original or prior edit, not the root). This forms a singly-linked chain: `A → A' → A''`.

**Edit log maintenance.** Both sender and recipient store the complete edit chain locally, keyed by the root message hash (the hash of the original `edit_of`-less payload). The root hash is stable across all edits and serves as the canonical conversation-thread anchor. Clients derive the root hash by following `edit_of` pointers until they reach a payload with no `edit_of` field.

**Authorization.** An edit is valid only if its signers chain to the same master card(s) as the original message's signers. Editing from a different sub-card of the same master is permitted (Alice editing from her phone what she sent from her laptop). Edits from an unrelated card are invalid. For co-signed originals, an edit signed by the full original signer set is a full edit; an edit signed by a subset is a partial amendment and should be displayed differently.

**Recipient set.** Edits are encrypted and delivered to the same recipient set as the original. Delivery is best-effort — a recipient who received the original but not the edit will see the original only.

**Relationship to `retracts`.** A `retracts` field in the envelope on any message type performs a retraction (no new content proposed). `edit` is the correct type when replacing content; `retracts` on a `text` or other type is correct when withdrawing without replacement. Using `type: edit` with `retracts` set is invalid.

---

### 5. `card_offer`

The offerer delivers a targeted card offer to a prospective holder.

```json
{
  "type": "card_offer",
  "content": {
    "offer_cid":        "<IPFS CID of the signed CardDocument offer>",
    "policy_pointer":   "<mutable pointer of the governing policy card>",
    "issuer_signature": "<offerer ML-DSA-44 signature over the offer, base64url>",
    "expires":          "<ISO 8601>"
  }
}
```

**Notes.** The full `CardDocument` (offer phase, without `recipient_pubkey`, `holder_signature`, and `press_signature`) is posted to IPFS first; this message carries the CID and a copy of the offerer's `issuer_signature` for immediate verification without an IPFS fetch. The `senders` list contains the offerer's card pointer; `recipients` contains the prospective holder's card pointer.

**Offer-phase content encryption.** The offer-phase document referenced by `offer_cid` is **not** content-encrypted under the ADR-006 scheme (it has no `recipient_pubkey` yet, so the content key is undefined). If posted to IPFS, it is stored in plaintext at that CID. The confidentiality of the offer is instead provided by the E2E encryption of this `card_offer` message itself (ML-KEM per ADR-007) — the offer document is protected in transit, not at rest. If public IPFS posting is a concern (e.g. for a sensitive targeted offer), the offerer MAY omit the IPFS post and carry the full offer document inline in the E2E-encrypted `card_offer` message body instead of as a CID reference; in that case `offer_cid` may be absent. Either way, the offer-phase `CardDocument` is not content-encrypted at rest until the press posts the completed, registered card (which has `recipient_pubkey` and all three signatures).

---

### 6. `card_offer_accepted`

The holder sends back the countersigned, completed card document.

```json
{
  "type": "card_offer_accepted",
  "content": {
    "card_cid":          "<IPFS CID of the completed CardDocument>",
    "offer_cid":         "<IPFS CID of the original offer, for correlation>",
    "holder_signature":  "<holder ML-DSA-44 countersignature, base64url>",
    "recipient_pubkey":  "<holder's new ML-DSA-44 public key for this card, base64url>"
  }
}
```

**Notes.** Sent from the holder back to the press (and optionally to an administrator). The press uses this to complete on-chain registration and issue the SCIP. The `senders` list contains the holder's existing master card pointer (not the new card's pointer, which doesn't exist yet on-chain). The `card_cid` in this message references the **completed, registered** `CardDocument` that the press posts to IPFS after registration — the first document that has `recipient_pubkey` present and is therefore content-encrypted under ADR-006 (`content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`). The `offer_cid` still references the unencrypted offer-phase document.

---

### 7. `card_offer_declined`

The holder declines an offer.

```json
{
  "type": "card_offer_declined",
  "content": {
    "offer_cid": "<IPFS CID of the declined offer>",
    "reason":    "<optional human-readable string>"
  }
}
```

**Notes.** The decline is signed by the holder so the press has a record that the offer was actively refused rather than simply undelivered. The press may retain this for audit purposes per its retention policy.

---

### 8. `card_update_notification`

The press notifies a holder of a post-issuance update to one of their cards.

```json
{
  "type": "card_update_notification",
  "content": {
    "card_pointer":    "<mutable pointer of the updated card>",
    "update_code":     <integer 100–999>,
    "log_entry_cid":   "<IPFS CID of the new LogEntry>",
    "effective_date":  "<ISO 8601 — for 8xx/9xx revocations>",
    "updater_message": "<optional string from the updater>"
  }
}
```

**Notes.** Sent by the press on behalf of the updater. `effective_date` is present only for revocation codes (8xx, 9xx). The holder's client should re-verify the card chain on receipt. For quiet revocations (8xx) with `notify_holder: false`, this message is never sent.

---

### 9. `subcard_sibling_added`

The press notifies a subcard that a new sibling has been registered on the same master card.

```json
{
  "type": "subcard_sibling_added",
  "content": {
    "master_card":    "<mutable pointer of the master card>",
    "new_pubkey":     "<base64url — ML-DSA-44 public key of the newly-added subcard>",
    "log_entry_cid":  "<IPFS CID of the code-510 LogEntry that added it>",
    "timestamp":      "<ISO 8601 — when the addition was recorded>"
  }
}
```

**Notes.** Sent by the press to all existing subcards listed in the master card's `active_subcards` immediately after a code-510 entry is accepted. Security purpose: alerts the holder's legitimate subcards (on their other devices) that a new sibling has been registered, enabling detection of unauthorized additions. The `senders` list contains the press card's pointer; `recipients` is the registry address of the receiving subcard.

---

### 10. `subcard_sibling_removed`

The press notifies a subcard that a sibling has been deregistered from the same master card.

```json
{
  "type": "subcard_sibling_removed",
  "content": {
    "master_card":    "<mutable pointer of the master card>",
    "removed_pubkey": "<base64url — ML-DSA-44 public key of the deregistered subcard>",
    "log_entry_cid":  "<IPFS CID of the code-511 LogEntry that removed it>",
    "timestamp":      "<ISO 8601 — when the removal was recorded>"
  }
}
```

**Notes.** Sent by the press to all remaining subcards after a code-511 entry is accepted. Informs the holder's remaining devices that a sibling has been deregistered (whether by the holder's intentional revocation or by loss/compromise).

---

### 11. `subcard_sibling_rotated`

The press notifies a subcard that a sibling's key has been rotated on the same master card.

```json
{
  "type": "subcard_sibling_rotated",
  "content": {
    "master_card":    "<mutable pointer of the master card>",
    "old_pubkey":     "<base64url — ML-DSA-44 public key that was rotated out>",
    "new_pubkey":     "<base64url — ML-DSA-44 public key that replaced it>",
    "log_entry_cid":  "<IPFS CID of the code-512 LogEntry that performed the rotation>",
    "timestamp":      "<ISO 8601 — when the rotation was recorded>"
  }
}
```

**Notes.** Sent by the press to all remaining subcards after a code-512 entry is accepted. Informs the holder's devices that a sibling's key has been rotated (typically due to key compromise or device replacement). The subcard identified by `old_pubkey` should be considered compromised/lost and its old registry address invalidated.

---

### 13. `auth_request`

A site pushes a login prompt to a card it already knows — "Log in to example.com?" — instead of sending the user through the login router. **Revised 2026-11-08:** the message carries only a reference; the signed `AuthenticationRequest` (`protocol-objects.md §8`) at `request_uri` is the single source of truth for every field.

```json
{
  "type": "auth_request",
  "content": {
    "request_uri": "<https URL of an AuthenticationRequest>"
  }
}
```

**Notes.** Sent from the login service card (signed by a server card whose `capabilities` include `auth_request`) to the user's card. The wallet fetches `request_uri` and runs `process_specs/card_login.md` from Phase 3, exactly as if it had arrived through the router. The message envelope's own signature is not a substitute for `request_signature`; the wallet validates the fetched request in full. The request should use `response_mode: "mcard_message"`, since the wallet may not be on the device where the user's browser is.

Also deliverable as a deep link or QR code: `mcard://auth?r=<percent-encoded request_uri>`. The link carries only the URL, never the request itself.

---

### 14. `auth_response`

The user's wallet answers a login request (`process_specs/card_login.md` Phase 5). Used directly as the message on `response_mode: "mcard_message"`, and carried as the `auth_response` form field on `form_post` (`protocol-objects.md §9`).

```json
{
  "type": "auth_response",
  "content": {
    "audience":     "<origin of AuthenticationRequest.response_uri>",
    "nonce":        "<copied from AuthenticationRequest.nonce>",
    "request_hash": "<base64url — keccak256 of the canonical AuthenticationRequest>",
    "state":        "<copied from AuthenticationRequest.state>",
    "statement":    "<copied verbatim from AuthenticationRequest.statement>"
  }
}
```

**Notes.** `senders` contains the presented card — the card that satisfies the request's DCQL query and the identifier the site binds the account to. `recipients` contains the **login service card** (the server card's `holder_primary_card`), because messages route only to master cards; the login service card's wallet service delivers a copy to each of its active sub-cards, which include the site's server cards. Signed by one of the presented card's device sub-cards (`capabilities` include `auth_response`); verifiers accept sub-card signatures only.

The site verifies with `card_verifier.md §6.3` (`verifyLoginResponse`): signature and sub-card link, chain and revocation, `type`, `state`, `nonce`, `statement`, `request_hash`, `audience`, `recipients`, `timestamp` freshness, then the DCQL match. Error codes: `process_specs/card_login.md §Error Codes`.

---

### 15. `api`

A message to or from a card that instruments an API capability. Subtypes handle the full request/response cycle.

#### `api.advertise`

The card declares the API capabilities it exposes.

```json
{
  "type": "api.advertise",
  "content": {
    "endpoint":     "<base HTTPS URL>",
    "schema_cid":   "<IPFS CID of OpenAPI or similar schema document>",
    "auth_policy":  "<mutable pointer of the policy cards required to call this API>",
    "version":      "<semver string>"
  }
}
```

#### `api.invoke`

A card requests execution of a capability on a remote API card.

```json
{
  "type": "api.invoke",
  "content": {
    "operation":    "<operation ID from the schema>",
    "params":       { ... },
    "idempotency_key": "<random string — for deduplication>",
    "expires":      "<ISO 8601>"
  }
}
```

#### `api.response`

The API card returns the result.

```json
{
  "type": "api.response",
  "content": {
    "in_reply_to_key": "<idempotency_key from the invoke>",
    "status":          <integer — HTTP-style status code>,
    "body":            { ... },
    "error":           "<optional human-readable error string>"
  }
}
```

**Notes.** The calling card's identity and chain are verified before any operation is executed; the API card's policy defines which caller chains are authorized for which operations. `idempotency_key` guards against duplicate invocations due to retries — the API card should track keys within a freshness window.

---

### 16. `mcp`

A message to or from a card attached to an LLM or other AI model, following the Model Context Protocol message shape. Enables AI agent identities to be card-anchored.

#### `mcp.tool_call`

```json
{
  "type": "mcp.tool_call",
  "content": {
    "tool_name":      "<string>",
    "tool_input":     { ... },
    "call_id":        "<string — MCP correlation ID>",
    "model_card":     "<mutable pointer of the AI agent's card>",
    "delegated_by":   "<mutable pointer of the human card that authorized this call>"
  }
}
```

#### `mcp.tool_result`

```json
{
  "type": "mcp.tool_result",
  "content": {
    "call_id":    "<echoed from mcp.tool_call>",
    "result":     { ... },
    "is_error":   false
  }
}
```

#### `mcp.prompt`

```json
{
  "type": "mcp.prompt",
  "content": {
    "prompt_name": "<string>",
    "arguments":   { ... }
  }
}
```

#### `mcp.resource`

```json
{
  "type": "mcp.resource",
  "content": {
    "uri":      "<resource URI>",
    "mime_type": "<string>",
    "content_cid": "<IPFS CID of the resource content, if persisted>"
  }
}
```

**Notes.** `model_card` identifies the AI agent making the call; `delegated_by` identifies the human card that authorized the agent to act. Both appear in `senders`. The receiving tool can verify both chains independently — confirming both that the agent has appropriate credentials and that the human who delegated to it does too. This preserves the full accountability chain even when the immediate actor is a model, not a person.

---

### 17. `introduction`

A card introduces two cards that don't yet share a trust path, bootstrapping their mutual discovery.

```json
{
  "type": "introduction",
  "content": {
    "introducing":  "<mutable pointer of the card being introduced>",
    "to":           "<mutable pointer of the card being introduced to>",
    "note":         "<human-readable context for the introduction>",
    "vouch":        false
  }
}
```

**Notes.** `vouch: true` means the introducer is actively asserting good standing, not merely facilitating contact. An introduction is sent to both parties (both appear in `recipients`). Recipients should treat the introduced card pointer as an unverified starting point and do their own chain verification before trusting it.

---

### 18. `announcement`

A one-to-many broadcast from a card to a group of recipients, such as a press or community announcement.

```json
{
  "type": "announcement",
  "content": {
    "subject":  "<string>",
    "body":     "<string>",
    "format":   "plain | markdown",
    "priority": "normal | high"
  }
}
```

**Notes.** `recipients` may be a large list of card pointers. For very large distributions, clients may receive the announcement via a shared CID rather than individual encrypted envelopes — the tradeoff between privacy and delivery efficiency is an open question (see below).

---

### 19. `read_receipt`

Acknowledges that a message was delivered and opened.

```json
{
  "type": "read_receipt",
  "content": {
    "target":     "<hash of the acknowledged payload>",
    "delivered":  "<ISO 8601 — when device received it>",
    "read":       "<ISO 8601 — when user opened it>"
  }
}
```

**Notes.** Read receipts are opt-in and their generation should be a per-conversation or per-account user preference. Sending a read receipt discloses timing metadata to the sender. Clients should not send read receipts for system messages (auth_request, card_offer, etc.) without explicit user opt-in.

---

### 20. `delete`

A recipient's request to remove a message from one or more stores. Not guaranteed — the request may be declined, and is always declined if the target message has an active `flag` against it.

```json
{
  "type": "delete",
  "content": {
    "target":  "<hash of the payload to be deleted>",
    "scope":   "local | sender | all",
    "reason":  "<optional human-readable string>"
  }
}
```

**Scope semantics:**
- `local` — remove from the requester's own store only. Always honored; no message is sent to anyone.
- `sender` — ask the original sender to remove the message from their sent store. The sender may decline.
- `all` — ask all parties (sender, any message servers, other recipients) to purge. Best-effort; each recipient honors or declines independently.

**Flag hold.** If any party holds an active `flag` referencing the target message hash, they must not honor a `delete` request for that message. The delete request should be answered with an `error` response indicating the hold. This prevents a sender or recipient from destroying evidence after a report has been filed.

**Relationship to `retracts`.** `retracts` is a sender-initiated withdrawal of their own statement — a speech act. `delete` is a recipient-initiated request to purge a message from storage — a housekeeping act. They are orthogonal: a message can be retracted without being deleted (the retraction is on record), or deleted without being retracted (the sender made no formal withdrawal).

**Notes.** The `senders` list is the requesting card (always the recipient of the target message or one of its co-recipients). `recipients` is whoever the delete request is directed at: the original sender for `scope: sender`, or all conversation participants for `scope: all`. For `scope: local`, no outbound message is sent.

---

### 21. `flag`

Reports a message to the press (or any authorized card) that issued a card attached to that message. Flags are the entry point to the 6xx/9xx revocation pipeline and serve as a community safety mechanism.

```json
{
  "type": "flag",
  "content": {
    "target_message":  "<hash of the flagged payload>",
    "flagged_card":    "<mutable pointer of the card whose holder sent the message>",
    "reason_code":     "<string — see reason code registry below>",
    "description":     "<optional human-readable detail>",
    "evidence_cids":   ["<IPFS CIDs of supporting evidence>"]
  }
}
```

**`recipients`** must include the press card(s) that issued `flagged_card`, identified by walking the card's issuance chain. The flagger may also include their own press or a trusted community safety card.

**`senders`** is the flagging card — the card of the person making the report. Flags are not anonymous: the flagger's identity is signed into the envelope, making false or malicious flags attributable. A flagger's card chain must itself be valid and unrevoked; flags from revoked cards may be deprioritized or discarded by the receiving press.

**What the press receives.** The press receives: the hash of the flagged message (so it can request the content from the flagger or other parties), the pointer of the card in question, the reason code, optional narrative, and any IPFS-pinned evidence. The press does not automatically receive the message content — the flagger decides what evidence to include.

**Reason codes (initial registry):**

| Code | Meaning |
|---|---|
| `harassment` | Targeted harassment or threats |
| `impersonation` | Sender misrepresenting their identity |
| `spam` | Unsolicited bulk or commercial content |
| `misinformation` | Deliberate false statements |
| `harm` | Content that poses risk to persons |
| `policy_violation` | Violation of a specific community policy (cite in `description`) |
| `other` | Catch-all; `description` required |

**Downstream effects.** A flag has no automatic effect on the `flagged_card`. It is a report, not a revocation. The receiving press may: take no action, issue a 6xx annotation (concern noted), issue a 7xx privilege reduction, initiate a 9xx revocation, or forward the flag to other presses in the network if the concern is cross-community. These are press-level policy decisions, not protocol-level enforcement.

**Flag hold on delete.** Any party holding a flag message referencing a given payload hash must not honor a `delete` request for that payload (see type 16).

---

### 22. `error`

A structured error response to any message type that requires a reply.

```json
{
  "type": "error",
  "content": {
    "in_reply_to":  "<hash of the payload this error responds to>",
    "code":         "<string error code>",
    "message":      "<human-readable description>",
    "retryable":    true
  }
}
```

**Notes.** Used for `card_offer` rejections, `auth_request` failures, `api.invoke` errors that warrant a signed response, and similar. The `code` string space is per-domain (offer errors, auth errors, API errors); a registry of error codes is a follow-on artifact.

**Login.** A user declining a `mcard_message` login sends `error` to the login service card with `code: "access_denied"` and an extra `state` field (the request's `state`); `in_reply_to` is omitted because the request was fetched, not messaged. A site rejecting a response does **not** send `error` to the wallet — the wallet learns of failure by timeout (`card_login.md` step 21). Login error codes: `process_specs/card_login.md §Error Codes`.

---

### 23. `auth_confirmation`

A site tells the wallet that a `mcard_message` login response was accepted, and hands over the one-time code that binds the login to the user's browser. Added 2026-11-08 (`process_specs/card_login.md` steps 24–26).

```json
{
  "type": "auth_confirmation",
  "in_reply_to": "<message ID of the auth_response>",
  "content": {
    "code":         "<8 characters, Crockford base32>",
    "expires_at":   "<ISO 8601 — 5 minutes after issue>",
    "request_hash": "<base64url — same value as in the auth_response>"
  }
}
```

**Notes.** Sent from the login service card (signed by a server card whose `capabilities` include `auth_confirmation`) to the presented card. The wallet accepts it only if the signing server card is the request's `requester_card`, `in_reply_to` is its own `auth_response`, and `request_hash` matches; otherwise it reports `LOGIN_CONFIRMATION_INVALID` and does not show the code. On a login reached on the same device, the wallet opens `response_uri?code=<code>`; on a QR-started login, it shows the code for the user to type into their browser. The code works only together with the `state` cookie in the browser that started the login.

---

## Summary Table

| § | Type | Sender | Recipient | Signed | Notes |
|---|---|---|---|---|---|
| 1 | `text` | Any card | Any card(s) | Yes | Core human messaging primitive |
| 2 | `reaction` | Any card | Message recipients | Yes | References target by payload hash |
| 3 | `reply` | Any card | Any card(s) | Yes | `in_reply_to` required |
| 4 | `edit` | Original signer(s) | Original recipients | Yes | `edit_of` required; both sides maintain edit log |
| 5 | `card_offer` | Press | Prospective holder | Yes | Full offer doc on IPFS |
| 6 | `card_offer_accepted` | Holder | Press (+ admin) | Yes | Triggers on-chain registration |
| 7 | `card_offer_declined` | Holder | Press | Yes | Audit record of refusal |
| 8 | `card_update_notification` | Press | Holder | Yes | Covers all 1xx–9xx update codes |
| 9 | `subcard_sibling_added` | Press | Holder's other sub-cards | Yes | |
| 10 | `subcard_sibling_removed` | Press | Holder's remaining sub-cards | Yes | |
| 11 | `subcard_sibling_rotated` | Press | Holder's remaining sub-cards | Yes | |
| 13 | `auth_request` | Login service card (server card signs) | User card | Yes | Reference only: `{ request_uri }` |
| 14 | `auth_response` | Presented card | Login service card | Yes | Signed by device sub-card |
| 15 | `api.advertise` | API card | Any card(s) | Yes | Schema + auth policy |
| 15 | `api.invoke` | Caller card | API card | Yes | Includes idempotency key |
| 15 | `api.response` | API card | Caller card | Yes | Correlates via idempotency key |
| 16 | `mcp.tool_call` | Agent card | Tool card | Yes | `delegated_by` human card |
| 16 | `mcp.tool_result` | Tool card | Agent card | Yes | Correlates via call_id |
| 16 | `mcp.prompt` | Any card | Model card | Yes | |
| 16 | `mcp.resource` | Model card | Any card | Yes | Content pinned to IPFS |
| 17 | `introduction` | Any card | Both parties | Yes | `vouch` flag |
| 18 | `announcement` | Any card | Many cards | Yes | Broadcast |
| 19 | `read_receipt` | Any card | Original sender | Yes | Opt-in only |
| 20 | `delete` | Recipient card | Sender / all | Yes | Not honored if flagged |
| 21 | `flag` | Any card | Press of flagged card | Yes | Entry to 6xx/9xx pipeline; not anonymous |
| 22 | `error` | Any card | Request sender | Yes | Structured error response |
| 23 | `auth_confirmation` | Login service card (server card signs) | Presented card | Yes | One-time code for browser binding |

Section 12 is unused; the number is retained so existing cross-references stay valid. The `§` column was previously a running count that did not match the section headings (corrected 2026-11-08).
---

## Open Questions

### Envelope design

**MSG-OQ-1: Type field routing vs. encryption.** `type` is inside the payload, covered by the signature. This means a message server cannot route by type without decrypting the envelope. Should `type` (or a coarse routing category like `system | human | machine`) be in an unencrypted outer header, accepting that it leaks traffic metadata? Or should all routing be by recipient address only?

**MSG-OQ-2: `senders` field necessity.** The `signatures` array already implies sender identity via the signing `public_key` (the signer's card hash is `keccak256(public_key)`). The proposed `senders` field (master card pointer) is a convenience, but it requires the sender to include their master card pointer in the plaintext payload — which may be more than they want to reveal. Should `senders` be omitted and clients infer master identity via the sub-card to master link, or is the explicit field worth the disclosure?

**MSG-OQ-3: Message type versioning.** As new types are added, clients that don't recognize a type will fail silently or noisily. Should the envelope include a `min_version` field, a capability negotiation phase, or just rely on `type` namespacing (e.g., `text/v2`)?

**MSG-OQ-3a: One-time prekeys for forward secrecy.** Messages are currently encrypted to the recipient's static ML-KEM public key on their card. If that key is later compromised, an attacker holding captured ciphertext can decrypt past messages. One-time prekeys (as in X3DH) would prevent this: wallet services distribute a bundle of ephemeral prekeys per card; the sender consumes one per message; used prekeys are discarded, making captured ciphertext undecryptable retroactively. This is a meaningful upgrade for high-sensitivity messaging contexts. However, because wallet services are not required to retain messages (delivery is immediate; no ciphertext sits at rest), the practical exposure window is limited — a key compromise doesn't help an attacker who didn't capture traffic in transit. Prekeys are therefore a P2 consideration rather than a baseline requirement, and would add wallet-service infrastructure for prekey distribution and replenishment.

### Reaction semantics

**MSG-OQ-4: Reaction storage model.** Are reactions stored as first-class messages in the conversation log (each reaction is a separate delivered envelope), or as sidecars attached to the target message's CID on IPFS? The first approach is simpler but creates message volume; the second requires a separate aggregation mechanism.

**MSG-OQ-5: Reactions to edited messages.** If a user reacts to a message and the sender then edits it, does the reaction transfer to the edit, apply to the original only, or require re-confirmation from the reactor?

### Group messaging

**MSG-OQ-6: Dynamic recipient sets.** The `recipients` list in the signature binds a message to a specific set of card pointers. Adding or removing participants after the fact produces new messages with a different recipient set. How are conversation membership changes represented — as a new typed message (`group_update`?), and how do clients reconstruct group history across membership changes?

**MSG-OQ-7: Announcement delivery scale.** For `announcement` messages with large recipient lists, encrypting the envelope separately per recipient is expensive. Should large-audience announcements be encrypted to a shared group key (and if so, how is that key managed and rotated), or delivered unencrypted (accepting the privacy cost)?

### Auth flow

**MSG-OQ-8: ~~OHTTP for `auth_request` callback.~~ Resolved 2026-11-08.** Superseded: the HTTPS callback is gone. Same-device responses go through the browser (`form_post`); cross-device responses are card messages (`mcard_message`), which already have transport-privacy options (ADR-007). See `process_specs/card_login.md`.

**MSG-OQ-9: ~~Multi-predicate auth.~~ Resolved 2026-11-08.** Out of scope for v2: a request names exactly one DCQL credential. Multi-card statements are a P2 item in `card_protocol_spec.md §8`.

### API and MCP types

**MSG-OQ-10: `api` vs. card sub-type.** The `api` message types describe messages to cards that instrument APIs. Should a card that is an API endpoint have a distinct card type (declared in its policy), or is the API capability entirely inferred from the messages it accepts? Conflating these risks making the card type system implicitly polymorphic.

**MSG-OQ-11: MCP schema alignment.** MCP messages in their canonical form use JSON-RPC 2.0 envelopes. Should the `mcp.*` types wrap JSON-RPC payloads verbatim (preserving MCP tool compatibility) or translate them into the card envelope shape (losing direct MCP compatibility)? Wrapping verbatim means the MCP payload is not independently signed; translating means the receiving tool must be card-aware.

**MSG-OQ-12: MCP delegation depth.** `mcp.tool_call` includes a `delegated_by` field for one level of human-to-agent delegation. What is the right model for multi-hop delegation (human → agent → sub-agent)? A delegation chain? A single root authority field? This touches the broader question of how the card protocol handles delegated action chains.

**MSG-OQ-13: `api.invoke` idempotency window.** How long should the API card retain idempotency keys? A short window (minutes) handles network retries; a longer window (hours) handles unusual delivery delays. The window length is a deployment decision but should probably be a recommended default in the spec.

### Capability grants and introductions

**MSG-OQ-14: ~~Capability grant revocation.~~ Removed 2026-06-15.** The `capability_grant` message type was removed along with the private-card privacy model (ADR-006 revision). Cards are public; there is no per-card decryption key to grant or revoke. (Number retained to preserve cross-references.)

**MSG-OQ-15: Introduction acceptance semantics.** An `introduction` message does not require a response. Should there be a corresponding `introduction_accepted` / `introduction_declined` type, or is first contact after an introduction sufficient signal?

### Delivery and receipts

**MSG-OQ-16: Read receipt privacy.** Read receipts signed by the reader disclose both that the reader received the message and when. For sensitive contexts (e.g., a user reading a card revocation notice), is there a privacy-preserving alternative — perhaps an unsigned delivery signal from the message server rather than a signed message from the card itself?

**MSG-OQ-17: Ephemeral message types.** Some signals (typing indicators, presence pings) don't warrant ML-DSA-44 signatures or IPFS storage. Should the spec define an explicit `ephemeral` envelope class that is unauthenticated (or uses a lighter MAC), or should ephemeral signals be handled entirely outside the message protocol?

### Error handling

**MSG-OQ-18: Error code registry.** The `error` type's `code` field is left as a string. Should this spec define a shared error code namespace (similar to HTTP status codes), or should each domain (`offer`, `auth`, `api`, `mcp`) define its own codes independently?

---

## Related Specs

- `process_specs/message_routing.md` — how wallet services route envelopes to the correct destination using card hashes; routing table maintenance; transport extensibility
- `ARCHITECTURE.md ADR-007` — HTTPS transport layer, sender-side per-subcard encryption, OHTTP/Nym transport flags
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
- `process_specs/card_offering_and_acceptance.md` — `card_offer` flow
- `process_specs/card_updates.md` — `card_update_notification` source
- `process_specs/card_login.md` — card login: `auth_request`, `auth_response`, `auth_confirmation` (replaces `raw_notes/Card Auth.md`)
- `raw_notes/Message composition and verification.md` — envelope design rationale, edit/retraction semantics
