# Mark Protocol — Messaging Protocol Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-28  
**Status:** Draft

> **Terminology note.** This spec uses "mark" for "chitt" and "press" for the issuance service. Treat the terms as interchangeable.

---

## Overview

Every message in the Mark Protocol shares a common signed envelope. The envelope binds the message content, type, and recipient set together under one or more ML-DSA-44 signatures. Recipients are expressed as mutable pointers — registry addresses that resolve to a mark's current state — so that the signature covers not just who the sender intended to reach but the specific credential-bearing identities in the conversation.

### Common Envelope

```json
{
  "payload": {
    "type":         "<message type — see taxonomy below>",
    "content":      { ... },
    "recipients":   ["<mutable pointer>", ...],
    "senders":      ["<mutable pointer>", ...],
    "timestamp":    "<ISO 8601>",
    "in_reply_to":  "<hash of prior payload>",
    "edit_of":      "<hash of prior payload>",
    "retracts":     "<hash of prior payload>"
  },
  "signatures": [
    {
      "signer_chitt": "<Arbitrum One registry address of signing sub-mark>",
      "public_key":   "<ML-DSA-44 public key, base64url>",
      "signature":    "<ML-DSA-44 signature over canonical CBOR of payload, base64url>"
    }
  ]
}
```

`in_reply_to`, `edit_of`, and `retracts` are mutually exclusive. `type` is inside the payload and therefore covered by the signature — a recipient cannot be tricked about what kind of message they received. The hash of the canonical payload is the message ID; there is no separate `id` field.

`senders` lists the mutable pointers of the marks whose identity is being asserted by this message, parallel to the `signatures` array. A signer sub-mark maps to exactly one sender master mark. For most message types the sender list has one entry; co-signed messages may have several.

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

**Authorization.** An edit is valid only if its signers chain to the same master mark(s) as the original message's signers. Editing from a different sub-mark of the same master is permitted (Alice editing from her phone what she sent from her laptop). Edits from an unrelated mark are invalid. For co-signed originals, an edit signed by the full original signer set is a full edit; an edit signed by a subset is a partial amendment and should be displayed differently.

**Recipient set.** Edits are encrypted and delivered to the same recipient set as the original. Delivery is best-effort — a recipient who received the original but not the edit will see the original only.

**Relationship to `retracts`.** A `retracts` field in the envelope on any message type performs a retraction (no new content proposed). `edit` is the correct type when replacing content; `retracts` on a `text` or other type is correct when withdrawing without replacement. Using `type: edit` with `retracts` set is invalid.

---

### 5. `mark_offer`

A press delivers a targeted mark offer to a prospective holder.

```json
{
  "type": "mark_offer",
  "content": {
    "offer_cid":       "<IPFS CID of the signed MarkDocument offer>",
    "policy_pointer":  "<mutable pointer of the governing policy mark>",
    "offer_signature": "<press ML-DSA-44 signature over the offer, base64url>",
    "expires":         "<ISO 8601>"
  }
}
```

**Notes.** The full `MarkDocument` (offer phase, without `recipient_pubkey` and `holder_signature`) is posted to IPFS first; this message carries the CID and a copy of the press signature for immediate verification without an IPFS fetch. The `senders` list contains the press sub-mark pointer; `recipients` contains the prospective holder's mark pointer.

---

### 5. `mark_offer_accepted`

The holder sends back the countersigned, completed mark document.

```json
{
  "type": "mark_offer_accepted",
  "content": {
    "mark_cid":          "<IPFS CID of the completed MarkDocument>",
    "offer_cid":         "<IPFS CID of the original offer, for correlation>",
    "holder_signature":  "<holder ML-DSA-44 countersignature, base64url>",
    "recipient_pubkey":  "<holder's new ML-DSA-44 public key for this mark, base64url>"
  }
}
```

**Notes.** Sent from the holder back to the press (and optionally to an administrator). The press uses this to complete on-chain registration and issue the SCIP. The `senders` list contains the holder's existing master mark pointer (not the new mark's pointer, which doesn't exist yet on-chain).

---

### 6. `mark_offer_declined`

The holder declines an offer.

```json
{
  "type": "mark_offer_declined",
  "content": {
    "offer_cid": "<IPFS CID of the declined offer>",
    "reason":    "<optional human-readable string>"
  }
}
```

**Notes.** The decline is signed by the holder so the press has a record that the offer was actively refused rather than simply undelivered. The press may retain this for audit purposes per its retention policy.

---

### 7. `mark_update_notification`

The press notifies a holder of a post-issuance update to one of their marks.

```json
{
  "type": "mark_update_notification",
  "content": {
    "mark_pointer":    "<mutable pointer of the updated mark>",
    "update_code":     <integer 100–999>,
    "log_entry_cid":   "<IPFS CID of the new LogEntry>",
    "effective_date":  "<ISO 8601 — for 8xx/9xx revocations>",
    "updater_message": "<optional string from the updater>"
  }
}
```

**Notes.** Sent by the press on behalf of the updater. `effective_date` is present only for revocation codes (8xx, 9xx). The holder's client should re-verify the mark chain on receipt. For quiet revocations (8xx) with `notify_holder: false`, this message is never sent.

---

### 8. `auth_request`

A service requests authentication from a mark holder — "Sign in with your mark."

```json
{
  "type": "auth_request",
  "content": {
    "requester_mark": "<mutable pointer of the requesting service's mark>",
    "policy_cid":     "<IPFS CID of the required policy>",
    "challenge":      "<32-byte random nonce, base64url>",
    "purpose":        "<human-readable string — shown to user>",
    "session_id":     "<opaque string>",
    "callback":       "<https:<url>>",
    "expires":        "<ISO 8601>"
  }
}
```

**Notes.** The `senders` list contains the requesting service's mark pointer. The `signatures` array contains the service's signature over the request — the keyring verifies this before showing anything to the user, defending against forged auth prompts. The `callback` field is an HTTPS URL; the auth response is POSTed there directly.

Also deliverable as a deep link: `mark://auth?r=<base64(envelope)>` or QR code for desktop-to-mobile handoff.

---

### 9. `auth_response`

The holder responds to an `auth_request`.

```json
{
  "type": "auth_response",
  "content": {
    "challenge":        "<echoed nonce from the request>",
    "session_id":       "<echoed session_id>",
    "requester_mark":   "<mutable pointer of the requester — binds response to this service>",
    "presented_mark":   "<mutable pointer of the holder's presented master mark>",
    "timestamp":        "<ISO 8601>"
  }
}
```

**Notes.** Signed by the holder's current device sub-mark (not the master key). The `presented_mark` pointer is the stable account identifier the service binds the session to. The service verifies: challenge freshness, signature validity, sub-mark to master link, master mark chain walk, and policy predicate match — in that order.

---

### 10. `api`

A message to or from a mark that instruments an API capability. Subtypes handle the full request/response cycle.

#### `api.advertise`

The mark declares the API capabilities it exposes.

```json
{
  "type": "api.advertise",
  "content": {
    "endpoint":     "<base HTTPS URL>",
    "schema_cid":   "<IPFS CID of OpenAPI or similar schema document>",
    "auth_policy":  "<mutable pointer of the policy marks required to call this API>",
    "version":      "<semver string>"
  }
}
```

#### `api.invoke`

A mark requests execution of a capability on a remote API mark.

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

The API mark returns the result.

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

**Notes.** The calling mark's identity and chain are verified before any operation is executed; the API mark's policy defines which caller chains are authorized for which operations. `idempotency_key` guards against duplicate invocations due to retries — the API mark should track keys within a freshness window.

---

### 11. `mcp`

A message to or from a mark attached to an LLM or other AI model, following the Model Context Protocol message shape. Enables AI agent identities to be mark-anchored.

#### `mcp.tool_call`

```json
{
  "type": "mcp.tool_call",
  "content": {
    "tool_name":      "<string>",
    "tool_input":     { ... },
    "call_id":        "<string — MCP correlation ID>",
    "model_mark":     "<mutable pointer of the AI agent's mark>",
    "delegated_by":   "<mutable pointer of the human mark that authorized this call>"
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

**Notes.** `model_mark` identifies the AI agent making the call; `delegated_by` identifies the human mark that authorized the agent to act. Both appear in `senders`. The receiving tool can verify both chains independently — confirming both that the agent has appropriate credentials and that the human who delegated to it does too. This preserves the full accountability chain even when the immediate actor is a model, not a person.

---

### 12. `capability_grant`

Shares a capability bundle (address + decryption key) for a private mark, enabling selective disclosure.

```json
{
  "type": "capability_grant",
  "content": {
    "mark_address":     "<address secret-derived address of the private mark>",
    "decryption_key":   "<decryption key for the private mark's content>",
    "scope":            "read | read_and_share",
    "expires":          "<ISO 8601 — optional>",
    "context":          "<human-readable note on intended use>"
  }
}
```

**Notes.** This message should always be encrypted (end-to-end encryption required). The `decryption_key` in the content is the per-mark decryption key from the mark's privacy model — not the holder's master key. `scope: read_and_share` permits the recipient to further delegate the capability; `read` does not.

---

### 13. `introduction`

A mark introduces two marks that don't yet share a trust path, bootstrapping their mutual discovery.

```json
{
  "type": "introduction",
  "content": {
    "introducing":  "<mutable pointer of the mark being introduced>",
    "to":           "<mutable pointer of the mark being introduced to>",
    "note":         "<human-readable context for the introduction>",
    "vouch":        false
  }
}
```

**Notes.** `vouch: true` means the introducer is actively asserting good standing, not merely facilitating contact. An introduction is sent to both parties (both appear in `recipients`). Recipients should treat the introduced mark pointer as an unverified starting point and do their own chain verification before trusting it.

---

### 14. `announcement`

A one-to-many broadcast from a mark to a group of recipients, such as a press or community announcement.

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

**Notes.** `recipients` may be a large list of mark pointers. For very large distributions, clients may receive the announcement via a shared CID rather than individual encrypted envelopes — the tradeoff between privacy and delivery efficiency is an open question (see below).

---

### 15. `read_receipt`

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

**Notes.** Read receipts are opt-in and their generation should be a per-conversation or per-account user preference. Sending a read receipt discloses timing metadata to the sender. Clients should not send read receipts for system messages (auth_request, mark_offer, etc.) without explicit user opt-in.

---

### 16. `delete`

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

**Notes.** The `senders` list is the requesting mark (always the recipient of the target message or one of its co-recipients). `recipients` is whoever the delete request is directed at: the original sender for `scope: sender`, or all conversation participants for `scope: all`. For `scope: local`, no outbound message is sent.

---

### 17. `flag`

Reports a message to the press (or any authorized mark) that issued a mark attached to that message. Flags are the entry point to the 6xx/9xx revocation pipeline and serve as a community safety mechanism.

```json
{
  "type": "flag",
  "content": {
    "target_message":  "<hash of the flagged payload>",
    "flagged_mark":    "<mutable pointer of the mark whose holder sent the message>",
    "reason_code":     "<string — see reason code registry below>",
    "description":     "<optional human-readable detail>",
    "evidence_cids":   ["<IPFS CIDs of supporting evidence>"]
  }
}
```

**`recipients`** must include the press mark(s) that issued `flagged_mark`, identified by walking the mark's issuance chain. The flagger may also include their own press or a trusted community safety mark.

**`senders`** is the flagging mark — the mark of the person making the report. Flags are not anonymous: the flagger's identity is signed into the envelope, making false or malicious flags attributable. A flagger's mark chain must itself be valid and unrevoked; flags from revoked marks may be deprioritized or discarded by the receiving press.

**What the press receives.** The press receives: the hash of the flagged message (so it can request the content from the flagger or other parties), the pointer of the mark in question, the reason code, optional narrative, and any IPFS-pinned evidence. The press does not automatically receive the message content — the flagger decides what evidence to include.

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

**Downstream effects.** A flag has no automatic effect on the `flagged_mark`. It is a report, not a revocation. The receiving press may: take no action, issue a 6xx annotation (concern noted), issue a 7xx privilege reduction, initiate a 9xx revocation, or forward the flag to other presses in the network if the concern is cross-community. These are press-level policy decisions, not protocol-level enforcement.

**Flag hold on delete.** Any party holding a flag message referencing a given payload hash must not honor a `delete` request for that payload (see type 16).

---

### 18. `error`

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

**Notes.** Used for `mark_offer` rejections, `auth_request` failures, `api.invoke` errors that warrant a signed response, and similar. The `code` string space is per-domain (offer errors, auth errors, API errors); a registry of error codes is a follow-on artifact.

---

## Summary Table

| # | Type | Sender | Recipient | Signed | Notes |
|---|---|---|---|---|---|
| 1 | `text` | Any mark | Any mark(s) | Yes | Core human messaging primitive |
| 2 | `reaction` | Any mark | Message recipients | Yes | References target by payload hash |
| 3 | `reply` | Any mark | Any mark(s) | Yes | `in_reply_to` required |
| 4 | `edit` | Original signer(s) | Original recipients | Yes | `edit_of` required; both sides maintain edit log |
| 5 | `mark_offer` | Press | Prospective holder | Yes | Full offer doc on IPFS |
| 6 | `mark_offer_accepted` | Holder | Press (+ admin) | Yes | Triggers on-chain registration |
| 7 | `mark_offer_declined` | Holder | Press | Yes | Audit record of refusal |
| 8 | `mark_update_notification` | Press | Holder | Yes | Covers all 1xx–9xx update codes |
| 9 | `auth_request` | Service mark | User mark | Yes | Challenge-response initiation |
| 10 | `auth_response` | User mark | Service | Yes | Signed by device sub-mark |
| 11 | `api.advertise` | API mark | Any mark(s) | Yes | Schema + auth policy |
| 11 | `api.invoke` | Caller mark | API mark | Yes | Includes idempotency key |
| 11 | `api.response` | API mark | Caller mark | Yes | Correlates via idempotency key |
| 12 | `mcp.tool_call` | Agent mark | Tool mark | Yes | `delegated_by` human mark |
| 12 | `mcp.tool_result` | Tool mark | Agent mark | Yes | Correlates via call_id |
| 12 | `mcp.prompt` | Any mark | Model mark | Yes | |
| 12 | `mcp.resource` | Model mark | Any mark | Yes | Content pinned to IPFS |
| 13 | `capability_grant` | Any mark | Any mark | Yes | Always encrypted |
| 14 | `introduction` | Any mark | Both parties | Yes | `vouch` flag |
| 15 | `announcement` | Any mark | Many marks | Yes | Broadcast |
| 16 | `read_receipt` | Any mark | Original sender | Yes | Opt-in only |
| 17 | `delete` | Recipient mark | Sender / all | Yes | Not honored if flagged |
| 18 | `flag` | Any mark | Press of flagged mark | Yes | Entry to 6xx/9xx pipeline; not anonymous |
| 19 | `error` | Any mark | Request sender | Yes | Structured error response |

---

## Open Questions

### Envelope design

**OQ-1: Type field routing vs. encryption.** `type` is inside the payload, covered by the signature. This means a message server cannot route by type without decrypting the envelope. Should `type` (or a coarse routing category like `system | human | machine`) be in an unencrypted outer header, accepting that it leaks traffic metadata? Or should all routing be by recipient address only?

**OQ-2: `senders` field necessity.** The `signatures` array already implies sender identity via `signer_chitt`. The proposed `senders` field (master mark pointer) is a convenience, but it requires the sender to include their master mark pointer in the plaintext payload — which may be more than they want to reveal. Should `senders` be omitted and clients infer master identity via the sub-mark to master link, or is the explicit field worth the disclosure?

**OQ-3: Message type versioning.** As new types are added, clients that don't recognize a type will fail silently or noisily. Should the envelope include a `min_version` field, a capability negotiation phase, or just rely on `type` namespacing (e.g., `text/v2`)?

### Reaction semantics

**OQ-4: Reaction storage model.** Are reactions stored as first-class messages in the conversation log (each reaction is a separate delivered envelope), or as sidecars attached to the target message's CID on IPFS? The first approach is simpler but creates message volume; the second requires a separate aggregation mechanism.

**OQ-5: Reactions to edited messages.** If a user reacts to a message and the sender then edits it, does the reaction transfer to the edit, apply to the original only, or require re-confirmation from the reactor?

### Group messaging

**OQ-6: Dynamic recipient sets.** The `recipients` list in the signature binds a message to a specific set of mark pointers. Adding or removing participants after the fact produces new messages with a different recipient set. How are conversation membership changes represented — as a new typed message (`group_update`?), and how do clients reconstruct group history across membership changes?

**OQ-7: Announcement delivery scale.** For `announcement` messages with large recipient lists, encrypting the envelope separately per recipient is expensive. Should large-audience announcements be encrypted to a shared group key (and if so, how is that key managed and rotated), or delivered unencrypted (accepting the privacy cost)?

### Auth flow

**OQ-8: OHTTP for `auth_request` callback.** The `callback` field is HTTPS. Should an OHTTP variant of the callback be included in the `auth_request` message type to give wallet services the option of IP privacy on the response leg?

**OQ-9: Multi-predicate auth.** Can a single `auth_request` require the holder to present multiple marks simultaneously (e.g., "prove you hold both a student mark AND a staff mark")? If so, `policy_cid` becomes a list and the response needs to present multiple marks in one signed payload.

### API and MCP types

**OQ-10: `api` vs. mark sub-type.** The `api` message types describe messages to marks that instrument APIs. Should a mark that is an API endpoint have a distinct mark type (declared in its policy), or is the API capability entirely inferred from the messages it accepts? Conflating these risks making the mark type system implicitly polymorphic.

**OQ-11: MCP schema alignment.** MCP messages in their canonical form use JSON-RPC 2.0 envelopes. Should the `mcp.*` types wrap JSON-RPC payloads verbatim (preserving MCP tool compatibility) or translate them into the mark envelope shape (losing direct MCP compatibility)? Wrapping verbatim means the MCP payload is not independently signed; translating means the receiving tool must be mark-aware.

**OQ-12: MCP delegation depth.** `mcp.tool_call` includes a `delegated_by` field for one level of human-to-agent delegation. What is the right model for multi-hop delegation (human → agent → sub-agent)? A delegation chain? A single root authority field? This touches the broader question of how the mark protocol handles delegated action chains.

**OQ-13: `api.invoke` idempotency window.** How long should the API mark retain idempotency keys? A short window (minutes) handles network retries; a longer window (hours) handles unusual delivery delays. The window length is a deployment decision but should probably be a recommended default in the spec.

### Capability grants and introductions

**OQ-14: Capability grant revocation.** Once a `capability_grant` message delivers a decryption key, the sender cannot un-deliver it. Revocation of the underlying mark revokes chain validity, but the decryption key for already-fetched content remains valid. Should capability grants have an explicit expiry enforced by the mark's privacy model, or is this a policy concern outside the message spec?

**OQ-15: Introduction acceptance semantics.** An `introduction` message does not require a response. Should there be a corresponding `introduction_accepted` / `introduction_declined` type, or is first contact after an introduction sufficient signal?

### Delivery and receipts

**OQ-16: Read receipt privacy.** Read receipts signed by the reader disclose both that the reader received the message and when. For sensitive contexts (e.g., a user reading a mark revocation notice), is there a privacy-preserving alternative — perhaps an unsigned delivery signal from the message server rather than a signed message from the mark itself?

**OQ-17: Ephemeral message types.** Some signals (typing indicators, presence pings) don't warrant ML-DSA-44 signatures or IPFS storage. Should the spec define an explicit `ephemeral` envelope class that is unauthenticated (or uses a lighter MAC), or should ephemeral signals be handled entirely outside the message protocol?

### Error handling

**OQ-18: Error code registry.** The `error` type's `code` field is left as a string. Should this spec define a shared error code namespace (similar to HTTP status codes), or should each domain (`offer`, `auth`, `api`, `mcp`) define its own codes independently?

---

## Related Specs

- `ARCHITECTURE.md` — envelope crypto, HTTPS transport, UMBRAL re-encryption
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
- `process_specs/mark_offering_and_acceptance.md` — `mark_offer` flow
- `process_specs/mark_updates.md` — `mark_update_notification` source
- `raw_notes/Chit Auth.md` — `auth_request` / `auth_response` detailed flow
- `raw_notes/Message composition and verification.md` — envelope design rationale, edit/retraction semantics
