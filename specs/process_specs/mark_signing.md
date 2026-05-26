# Mark Signing — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt." The rename is in progress; treat the terms as interchangeable.

---

## Overview

Mark signing is the process by which a mark holder signs an arbitrary message using their mark identity. The result is a `SignedMessageEnvelope` — a payload object plus one or more signature entries — that any party can verify without a network call, using the inline public key. Signatures commit to specific recipients and a timestamp, preventing misquotation and replay. Multiple signers may independently sign the same payload in parallel.

---

## Actors

| Actor | Role |
|---|---|
| **Signer** | The mark holder composing and signing the message |
| **Co-signer(s)** | Additional mark holders independently signing the same payload (optional) |
| **Recipients** | Mark holders listed in the `recipients` array; the intended audience |

---

## Preconditions

- The signer holds an active mark with a registered sub-mark keypair on their device.
- The signer's master mark key is not required for routine signing; only the device sub-mark private key is used.
- The signer knows the mutable pointers of the intended recipients' marks.

---

## Steps

### Phase 1: Payload Assembly

1. The signer assembles the `payload` object:
   ```json
   {
     "content":     "<message body>",
     "recipients":  ["<mutable pointer>", "<mutable pointer>", ...],
     "timestamp":   "<ISO 8601 timestamp>",
     "in_reply_to": "<hash of prior payload — optional>",
     "edit_of":     "<hash of prior payload — optional; mutually exclusive with retracts>",
     "retracts":    "<hash of prior payload — optional; mutually exclusive with edit_of>"
   }
   ```
   - `recipients` must include at least the intended recipient(s)' mutable pointers. Including the signer's own pointer is optional but conventional for self-addressed records.
   - `timestamp` is the signing time; it must be within the acceptable freshness window as defined by the verifying party.
   - `in_reply_to`, `edit_of`, and `retracts` are optional. `edit_of` and `retracts` are mutually exclusive — a payload with both set must be rejected at the client before signing.

2. The client validates the payload locally:
   - Confirm `edit_of` and `retracts` are not both set.
   - Confirm `recipients` is non-empty.
   - Confirm `timestamp` is current.

### Phase 2: Canonical Serialization

3. The client canonically serializes the `payload` object per canonical CBOR (RFC 8949 §4.2) with protocol-specific overrides:
   - Binary fields (`recipients` entries, `in_reply_to`, `edit_of`, `retracts`) are base64url on the JSON surface but encoded as CBOR byte strings in the canonical form.
   - Timestamps are ISO 8601 on the JSON surface but encoded as CBOR Tag 1 uint in the canonical form.

   The **message ID** is the hash of this canonical serialization. There is no separate ID field; all references to this message use this hash.

### Phase 3: Signing

4. The client signs the canonical serialization of `payload` using the **current device's sub-mark private key**. The master mark key is not accessed.

5. The signer constructs a `SignatureEntry`:
   ```json
   {
     "signer_mark": "<base64url — mutable pointer of the signing sub-mark in the registry>",
     "public_key":  "<base64url — ML-DSA-44 public key, 1312 bytes raw>",
     "signature":   "<base64url — ML-DSA-44 signature over canonical CBOR of payload, 2420 bytes raw>"
   }
   ```

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
   - Signs the canonical serialization with their own sub-mark private key.
   - Appends their `SignatureEntry` to the `signatures` array.

   All signers sign the same canonical payload bytes. No ordering of signers is required or enforced in v1.

### Phase 5: Sending

8. The completed `SignedMessageEnvelope` is transmitted to recipients via the appropriate channel (Nym preferred; HTTPS fallback). For authentication flows, the signed statement is wrapped in an `AuthenticationResponse` (see `chitt_protocol_spec.md §8`).

---

## Edits and Retractions

**Edit:** A new `SignedMessageEnvelope` with `edit_of` set to the hash of the prior payload. The original message is not mutated. The edit is only valid if the signer's master mark chains to the same master as the original signer.

**Retraction:** A new `SignedMessageEnvelope` with `retracts` set to the hash of the prior payload. No new content is proposed; the sender formally withdraws the original statement.

**Successive edits** form a linked list (`A → A' → A''`). Each is independently verifiable. The latest edit supersedes prior ones for display purposes, but all prior versions remain verifiable.

---

## Recipient Binding

The `recipients` array is part of the signed `payload`. Modifying it after signing invalidates all signatures. A message whose `recipients` list does not include the receiving party's mark pointer is valid but flagged as **forwarded** by verifiers.

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
| `edit_of` and `retracts` both set | Client rejects before signing; the signer must choose one or neither |
| `recipients` is empty | Client rejects before signing |
| Sub-mark key not available on device (e.g., device was wiped) | Signer must register a new sub-mark from their master key before signing |
| Signing key's sub-mark has been revoked | Verifiers will flag the signature; signer should rotate to a new sub-mark and resign |
| Co-signer signs a different payload (content mismatch) | Verifiers will detect the divergence; the co-signer must sign the canonical payload as received |

---

## Related Specs

- `mark_validation.md` — how recipients and third parties verify signed statements
- `wallet_backup_and_recovery.md` — key management for signing keys
- `chitt_protocol_spec.md §6` — full feature spec for signing a message with a mark
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
