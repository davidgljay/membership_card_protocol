# Card Signing — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-06-09  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

Card signing is the process by which a card holder signs an arbitrary message using their card identity. The result is a `SignedMessageEnvelope` — a payload object plus one or more signature entries — that any party can verify without a network call, using the inline public key. Signatures commit to specific recipients and a timestamp, preventing misquotation and replay. Multiple signers may independently sign the same payload in parallel.

---

## Actors

| Actor | Role |
|---|---|
| **Signer** | The card holder composing and signing the message |
| **Co-signer(s)** | Additional card holders independently signing the same payload (optional) |
| **Recipients** | Card holders listed in the `recipients` array; the intended audience |

---

## Preconditions

- The signer holds an active card with a registered sub-card keypair on their device.
- The signer's master card key is not required for routine signing; only the device sub-card private key is used.
- The signer knows the mutable pointers of the intended recipients' cards.

---

## Steps

### Phase 1: Payload Assembly

1. The signer assembles the `payload` object:
   ```json
   {
     "type":        "<string — see Message Types below>",
     "content":     "<message body — optional when forwards is set>",
     "senders":     ["<mutable pointer of signer's master card>", ...],
     "recipients":  ["<mutable pointer>", "<mutable pointer>", ...],
     "timestamp":   "<ISO 8601 timestamp>",
     "in_reply_to": "<hash of prior payload — optional>",
     "edit_of":     "<hash of prior payload — optional; mutually exclusive with retracts and forwards>",
     "retracts":    "<hash of prior payload — optional; mutually exclusive with edit_of and forwards>",
     "forwards":    "<hash of original payload being forwarded — optional; mutually exclusive with edit_of and retracts>"
   }
   ```
   - `type` is required. It distinguishes human communication from programmatic messages. See [Message Types](#message-types) below.
   - `content` carries the type-specific message body; it is optional only when `forwards` is set (the forwarded envelope provides the content).
   - `senders` is required. It lists the mutable pointer(s) of the signing party's master card(s) — parallel to `signatures`, identifying the signer's master-card identity in the signed payload. Because `signatures` carries only the sub-card public key (from which only the sub-card's address is derived), `senders` is the explicit link from the signed bytes to the master-card identity. Note: MSG-OQ-2 (whether to drop `senders` for sender-privacy purposes and infer master identity via the sub-card→master link instead) remains an open future option, but the current schema includes `senders` in the payload here, in `protocol-objects.md §5`, and in `messaging_protocol.md §1`.
   - `recipients` must include at least the intended recipient(s)' mutable pointers. Including the signer's own pointer is optional but conventional for self-addressed records.
   - `timestamp` is the signing time; it must be within the acceptable freshness window as defined by the verifying party.
   - `in_reply_to`, `edit_of`, `retracts`, and `forwards` are optional. `edit_of`, `retracts`, and `forwards` are mutually exclusive — a payload with more than one of these set must be rejected at the client before signing.

2. The client validates the payload locally:
   - Confirm `type` is a known value.
   - Confirm `senders` is non-empty and lists the signer's master card pointer(s).
   - Confirm at most one of `edit_of`, `retracts`, `forwards` is set.
   - Confirm `recipients` is non-empty.
   - Confirm `timestamp` is current.

### Phase 2: Canonical Serialization

3. The client canonically serializes the `payload` object per RFC 8785 (JSON Canonicalization Scheme). All field values — including binary fields and timestamps — are serialized as plain JSON strings; there is no schema-aware type coercion. See `card_protocol_spec.md` Appendix A for the full serialization rules.

   The **message ID** is the hash of this canonical serialization. There is no separate ID field; all references to this message use this hash.

### Phase 3: Signing

4. The client signs the canonical serialization of `payload` using the **current device's sub-card private key**. The master card key is not accessed.

5. The signer constructs a `SignatureEntry`:
   ```json
   {
     "public_key": "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
     "signature":  "<base64url — ML-DSA-44 signature over canonical RFC 8785 JSON of payload, 2420 bytes raw>"
   }
   ```
   The signer's address (and thus their card identity) is derived from `public_key` by verifiers; it is not included in the entry.

6. The signer assembles the `SignedMessageEnvelope`:
   ```json
   {
     "payload":    { <payload object from Step 1> },
     "signatures": [ <SignatureEntry from Step 5> ]
   }
   ```

### Phase 4: Parallel Co-signing (Optional)

7. If additional co-signers are required, each co-signer independently:
   - Receives the `payload` object (not the full envelope).
   - Verifies the payload content and recipients are as expected.
   - Canonically serializes the `payload` per the same rules in Step 3.
   - Signs the canonical serialization with their own sub-card private key.
   - Appends their `SignatureEntry` to the `signatures` array.

   All signers sign the same canonical payload bytes. No ordering of signers is required or enforced in v1.

### Phase 5: Sending

8. The completed `SignedMessageEnvelope` is transmitted to recipients via HTTPS (optionally via OHTTP for IP privacy). For authentication flows, the signed statement is wrapped in an `AuthenticationResponse` (see `card_protocol_spec.md §8`).

---

## Message Types

The `type` field classifies what a signed payload represents. Verifiers and clients use it to route, display, and apply policy to messages correctly — for example, suppressing auth challenges from a user's inbox, or rejecting a `text` message where an `auth_response` is expected.

The canonical type definitions (content schemas, field constraints, and notes) live in `messaging_protocol.md`. This table is the authoritative list of valid values for the `type` field.

### Human communication

| Value | Description |
|---|---|
| `text` | Free-form human-readable message |
| `reaction` | Emoji or short symbolic response to a prior message |
| `reply` | Text message explicitly threaded under a prior message |
| `edit` | Signed revision to a prior message (`edit_of` required) |
| `announcement` | One-to-many broadcast to a group of recipients |
| `introduction` | Introduces two cards that don't yet share a trust path |
| `read_receipt` | Acknowledges a message was delivered and opened (opt-in) |
| `delete` | Request to remove a message from one or more stores |
| `flag` | Reports a message to the issuing press; entry to the 6xx/9xx pipeline |

### Card lifecycle

| Value | Description |
|---|---|
| `card_offer` | Press delivers a targeted card offer to a prospective holder |
| `card_offer_accepted` | Holder returns the countersigned, completed card document |
| `card_offer_declined` | Holder declines an offer |
| `card_update_notification` | Press notifies a holder of a post-issuance update to one of their cards |

### Authentication

| Value | Description |
|---|---|
| `auth_request` | Service requests authentication from a card holder |
| `auth_response` | Holder responds to an `auth_request` |

### Programmatic / machine-to-machine

| Value | Description |
|---|---|
| `api.advertise` | Card declares the API capabilities it exposes |
| `api.invoke` | Card requests execution of a capability on a remote API card |
| `api.response` | API card returns the result of an invocation |
| `mcp.tool_call` | AI agent invokes a tool (includes `delegated_by` human card) |
| `mcp.tool_result` | Tool returns a result to the agent |
| `mcp.prompt` | Sends a named prompt to a model card |
| `mcp.resource` | Delivers a resource from a model card |

### System

| Value | Description |
|---|---|
| `error` | Structured error response to any message type that requires a reply |

The list of defined types will grow as new protocol features are added. Clients MUST reject payloads with an unrecognized `type` rather than silently treat them as a known type.

---

## Forwarding

A forwarded message must be transmitted as a **ForwardPackage** — a pair of envelopes that together identify the original sender, the forwarder, and the new recipients unambiguously. Delivering only the original envelope to a party not listed in its `recipients` is not a valid forward; it is an unauthenticated relay and MUST be rejected by verifiers.

A `ForwardPackage` has the following structure:

```json
{
  "original_envelope": { <original SignedMessageEnvelope, unmodified> },
  "forward_envelope":  { <new SignedMessageEnvelope signed by the forwarder> }
}
```

The **forward envelope's payload** MUST satisfy:
- `forwards` is set to the hash of `original_envelope.payload` (the canonical RFC 8785 JSON hash, same derivation as the message ID).
- `recipients` lists the mutable pointers of the new recipients (who the message is being forwarded to).
- `content` is optional and contains any commentary the forwarder wishes to add.
- `timestamp` is current at the time of forwarding.

From these two envelopes the following are unambiguously established:
- **Forwarded from:** the addresses derived from `public_key` entries in `original_envelope.signatures`.
- **Forwarded by:** the addresses derived from `public_key` entries in `forward_envelope.signatures`.
- **Forwarded to:** `forward_envelope.payload.recipients`.

The original envelope is not modified; all its signatures remain independently verifiable. The forwarder's signature commits only to the fact of forwarding and the new recipient set — not to the original content. The forwarder is not a co-signer of the original payload.

---

## Edits and Retractions

**Edit:** A new `SignedMessageEnvelope` with `edit_of` set to the hash of the prior payload. The original message is not mutated. The edit is only valid if the signer's master card chains to the same master as the original signer.

**Retraction:** A new `SignedMessageEnvelope` with `retracts` set to the hash of the prior payload. No new content is proposed; the sender formally withdraws the original statement.

**Successive edits** form a linked list (`A → A' → A''`). Each is independently verifiable. The latest edit supersedes prior ones for display purposes, but all prior versions remain verifiable.

---

## Recipient Binding

The `recipients` array is part of the signed `payload`. Modifying it after signing invalidates all signatures. A receiving party whose card pointer does not appear in `recipients` MUST NOT treat the envelope as a valid direct message — it is only valid if delivered as part of a `ForwardPackage` whose `forward_envelope.payload.recipients` includes that party's pointer (see Forwarding above).

---

## Postconditions

- The `SignedMessageEnvelope` contains a valid ML-DSA-44 signature over the canonical payload.
- Any party with the envelope can verify the signature using the inline public key without a network call.
- The message ID (payload hash) is deterministic from the same inputs across all compliant clients.
- Modifying any field in the payload invalidates all signatures.

---

## Error Paths

| Condition | Resolution |
|---|---|
| `type` is missing or unrecognized | Client rejects before signing; verifier rejects on receipt |
| More than one of `edit_of`, `retracts`, `forwards` set | Client rejects before signing; the signer must choose at most one |
| `forwards` hash does not match `original_envelope.payload` | Verifier rejects the ForwardPackage; the hash must be the canonical RFC 8785 JSON hash of the original payload |
| Original envelope delivered to a party not in its `recipients`, without a ForwardPackage | Verifier rejects as an unauthenticated relay; the receiving party has no verified forwarder identity |
| `recipients` is empty | Client rejects before signing |
| Sub-card key not available on device (e.g., device was wiped) | Signer must register a new sub-card from their master key before signing |
| Signing key's sub-card has been revoked | Verifiers will flag the signature; signer should rotate to a new sub-card and resign |
| Co-signer signs a different payload (content mismatch) | Verifiers will detect the divergence; the co-signer must sign the canonical payload as received |

---

## Related Specs

- `card_validation.md` — how recipients and third parties verify signed statements
- `wallet_backup_and_recovery.md` — key management for signing keys
- `card_protocol_spec.md §6` — full feature spec for signing a message with a card
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
