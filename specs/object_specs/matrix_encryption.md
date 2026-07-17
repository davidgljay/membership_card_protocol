# Matrix Megolm Encryption & Card Signature — Object Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-10
**Status:** Draft
**Companion documents:** `specs/messaging_protocol.md §Common Envelope, §Address Model`, `specs/object_specs/matrix_room.md`, `specs/object_specs/matrix_synapse_module.md` (cited in §3/§4 — e.g. `matrix_server_name` config), `specs/process_specs/matrix_room_membership.md §5 (Per-Room Card Binding)`, `specs/process_specs/matrix_join_attestation_and_revocation.md` (reuses `verifyMatrixUserIdBinding` for join-time attestation verification, per that document's §2), `plans/matrix-strategic-plan.md §Rationale (why native Matrix E2EE)`

**Note (2026-07-11):** §3's discussion of how the Synapse module resolves a bare Matrix ID to a `card_hash` at authorization time is superseded by `specs/process_specs/matrix_join_attestation_and_revocation.md` — the module no longer queries `wallet-service` for this at all (that resolver endpoint was removed from scope entirely). See §3's updated text below; this note exists so the change is visible without reading the whole section.

**Changelog (spec-consistency Phase 1):** Fix #28 — corrected the retired `client-sdk` signing-call-site citation to `app-sdk`; Fix #37 — added `matrix_synapse_module.md` to companion documents. See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**This document supersedes `raw_notes/matrix.md §Message Structure and Encryption` in its entirety.** The note's hybrid AES-256 room-key model, its `unsigned.card_signatures` block, and its "server signature over ciphertext" concept do not appear anywhere below and should not be treated as residual design intent.

---

## 1. Room Encryption: Standard Megolm, No Custom Algorithm

Rooms use Matrix's own end-to-end encryption exactly as specified by the Matrix protocol: an `m.room.encryption` state event with

```json
{
  "type": "m.room.encryption",
  "state_key": "",
  "content": { "algorithm": "m.megolm.v1.aes-sha2" }
}
```

No custom algorithm string, no protocol-native re-implementation of group ratcheting. This is deliberate (per the strategic plan's rationale): Matrix's Megolm implementation is standard, audited, and has forward secrecy properties a from-scratch scheme would not have on day one. Session/room-key distribution to newly joining members is handled entirely by the Matrix client crypto stack (Olm-encrypted `m.room_key` to-device messages) — this protocol adds nothing to that mechanism and does not need to, per `matrix_room.md`'s framing that Matrix's own client libraries handle key exchange.

The only thing this protocol adds is **what goes inside** the Megolm-encrypted plaintext, defined next.

---

## 2. The Card-Signature Envelope

The Megolm-encrypted event body's plaintext (i.e., the `content` object of an `m.room.message` event, once Matrix's own layer has decrypted it) **is** the existing protocol envelope from `messaging_protocol.md §Common Envelope`, reused as closely as the shape allows, with one addition.

```json
{
  "payload": {
    "type":              "text",
    "content":           { "body": "<string>", "format": "plain | markdown", "attachments": [...] },
    "matrix_event_id":   "<the Matrix event ID this payload is carried inside, once known>",
    "protocol_version":  "<string, same as elsewhere>",
    "timestamp":         "<ISO 8601>"
  },
  "signatures": [
    {
      "public_key":  "<ML-DSA-44 public key, base64url>",
      "signature":   "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    }
  ]
}
```

### What is reused, unchanged, from `messaging_protocol.md`

- The two-part `payload` / `signatures` shape.
- `type` and `content` follow the same message-type taxonomy (`text`, `reaction`, `reply`, `edit`, etc. — `messaging_protocol.md §Message Type Taxonomy`); a room message is typed and structured exactly like a 1:1 message's payload.
- Signing: `signatures[].signature` is an ML-DSA-44 signature (`mlDsa44Sign`, `app-sdk/packages/app-sdk/src/crypto/mldsa.ts`) over the canonical RFC 8785 JSON encoding (`canonicalize()`, `app-sdk/packages/app-sdk/src/crypto/canonicalize.ts`, per `app_sdk.md §5`) of `payload` — the identical signing call site and canonicalization function used for every other message type, not a new one.
- The signer's card hash is derived from `signatures[].public_key` via `keccak256(public_key)`, exactly as in `messaging_protocol.md` — it is not stored redundantly in the envelope.
- `protocol_version` is required, with the same semantics (read from `getProtocolVersion()`, reject on unknown/missing version).

### What changes relative to `messaging_protocol.md`

- **`recipients` and `senders` are omitted from the room-message payload.** In 1:1/small-group messaging these fields carry the addressing and sender-assertion information the wallet-service routing layer needs; in a Matrix room, **Matrix's own room membership is the recipient set** (anyone who can decrypt the room's Megolm session is, by definition, a room member), and **the Matrix event's `sender` field is the sender-assertion** (see §4, the sender-binding check, for how this is verified against the embedded signature rather than trusted at face value). Carrying a redundant `recipients`/`senders` array inside the payload would duplicate information Matrix already provides structurally and would need to be kept consistent with it for no benefit.
- **`matrix_event_id` is a new, optional field**, added for cross-referencing a decrypted payload back to the Matrix event that carried it (useful for `in_reply_to`/`edit_of`/`retracts` targets that need to resolve against Matrix's own event graph, e.g. Matrix-native threading or redaction). It is not present in the general `messaging_protocol.md` envelope and is not signed retroactively into non-room messages.
- `edit_of`, `retracts`, `forwards`, `in_reply_to` remain available and behave identically to `messaging_protocol.md` when present, now referencing either another room-message payload hash or (via `matrix_event_id`) a Matrix event ID, at the sending client's discretion.

**Worked example — a `text` message in a card-gated room:**

```json
{
  "payload": {
    "type": "text",
    "content": { "body": "meeting moved to 3pm", "format": "plain" },
    "protocol_version": "0.1",
    "timestamp": "2026-07-10T18:04:00Z"
  },
  "signatures": [
    {
      "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...base64url...",
      "signature": "3081...base64url..."
    }
  ]
}
```

This JSON object is the plaintext handed to the Megolm encryption layer; the resulting ciphertext becomes the `content` field of the `m.room.message` event actually stored by Synapse. Synapse only ever sees the ciphertext — never this plaintext.

---

## 3. Shadow Matrix Account Derivation

Every card that participates in Matrix rooms has exactly one corresponding Matrix user account, derived from its `card_hash` via a **one-way cryptographic commitment** — not a reversible encoding. This is deliberate: the naive alternative (embedding `card_hash` directly, e.g. `hex(card_hash)`, in the Matrix ID) would put a card's on-chain registry address in plaintext in every room's membership list and every event's `sender` field, readable by any other room participant or federated peer with zero special access — a far more serious exposure than anything the Synapse operator specifically could do. The commitment scheme below closes that off while still supporting everything the protocol actually needs from this mapping.

```
shadowAccountCommitment(card_hash: string, server_name: string): string
  = keccak256(card_hash || "matrix-shadow-account-v1" || server_name)   // domain-separated

deriveMatrixUserId(card_hash: string, server_name: string): string
  = "@card_" + lowercaseHex(shadowAccountCommitment(card_hash, server_name)) + ":" + server_name

verifyMatrixUserIdBinding(candidate_card_hash: string, matrix_user_id: string, server_name: string): boolean
  = deriveMatrixUserId(candidate_card_hash, server_name) === matrix_user_id
```

- `card_hash` is the same registry-address hash used everywhere else in the protocol (`keccak256(recipient_pubkey)`, `messaging_protocol.md §Address Model`). The domain-separation string (`"matrix-shadow-account-v1"`) prevents this commitment from colliding with `card_hash`'s use elsewhere as a hash input for unrelated purposes, and versions the scheme for any future change to the derivation.
- `server_name` is the homeserver's own domain (`MATRIX_SERVER_NAME` / the module's `matrix_server_name` config, `matrix_synapse_module.md`) — a fixed, known constant for a given deployment, not looked up per call.
- **There is deliberately no general inverse function.** Given only a Matrix user ID, recovering the `card_hash` that produced it requires inverting a keccak256 preimage over a domain-separated input — computationally infeasible, the same security property every other hash in the protocol already relies on. No such function is specified, and none should be implemented; a "clever" partial inversion attempt (e.g. a lookup table built by brute-forcing plausible `card_hash` values) is exactly the attack this design exists to make impractical.
- **Claiming an account still requires the card.** Only a party that already knows `card_hash` — the card holder themselves, or `wallet-service` acting on their behalf after verifying their session-token auth — can compute the one correct Matrix ID to register via the Application Service (Step 15b). Registering a shadow account under any other ID would be pointless: no message signed by that card would ever satisfy `verifyMatrixUserIdBinding` against it (§4), so no receiving client would accept the sender's claimed identity.
- **Forward verification needs no lookup and no server involvement.** Any party that already holds a *candidate* `card_hash` — most importantly, a receiving client that just recovered `signer_card_hash` from a verified signature — can confirm or deny that a given Matrix user ID belongs to that card by recomputing `deriveMatrixUserId` and comparing, with no query to `wallet-service`, the registry contract, or any other party. This is exactly what the sender-binding check (§4) needs, and it needs nothing more.
- **The one thing this scheme cannot do — discover a card from a bare Matrix ID with no candidate in hand — is not solved by any function in this document.** **Superseded 2026-07-11:** this used to be resolved by a wallet-service-held registration-time binding record, queried privately by the Synapse module at join and post time. That resolver dependency has been **removed entirely** — see `specs/process_specs/matrix_join_attestation_and_revocation.md`. In its place, the joining client presents a **signed attestation** of its own `card_hash` and target `matrix_user_id`, which the module verifies using exactly this section's `verifyMatrixUserIdBinding` (a forward check, no lookup) — the same primitive already used for the sender-binding check (§4), just applied at join time instead of message-receive time. For an already-joined member's subsequent *posts*, the module reuses the `card_hash` it resolved once at join, held in its own in-process membership registry (`matrix_join_attestation_and_revocation.md §2a`) — not a fresh attestation, and not a wallet-service query. **`wallet-service` is never queried by the Synapse module at authorization time, for either join or post, under the current design** — its only remaining role is provisioning the shadow account in the first place (Step 15b) and room creation (`matrix_room.md §Room Creation`).

`wallet-service/src/matrix/account-id.ts` (Step 13) implements `deriveMatrixUserId` and `verifyMatrixUserIdBinding` in TypeScript; the Python module (Step 12/`attestation.py`) implements the identical forward function for its own use verifying join attestations. **Both implementations must agree on every input** — the implementation plan's shared fixture file (Step 13's Done-when criterion) is now a set of `(card_hash, expected_matrix_user_id)` pairs verified via `verifyMatrixUserIdBinding` returning `true`, plus at least one negative case (a `card_hash` that must verify `false` against another card's Matrix ID) — there is no round-trip property to test anymore, since there is no inverse.

**Honest limit on what this achieves, stated explicitly — now stronger than originally written.** In a single-operator deployment where one entity runs both `wallet-service` and Synapse (per this plan's scope), that operator can still connect a Matrix ID to a card_hash by consulting their own `wallet-service` instance at the moment it provisions a shadow account — nothing makes the mapping unknowable to the entity that itself issues the binding, and no scheme could. What this section's design achieves is (a) eliminating the mapping's exposure to every other room participant and federated peer, who previously could read `card_hash` directly out of any Matrix ID with no privileged access at all, and (b) establishing a genuine internal boundary — a compromise of Synapse's own Postgres or logs alone, or a future deployment where Synapse and `wallet-service` are operated by different parties, no longer leaks the mapping. **As of the 2026-07-11 join-attestation redesign, (b) is stronger than originally specified: Synapse never queries `wallet-service` at authorization time at all**, so there isn't even a private runtime channel between the two components carrying `card_hash` — only `wallet-service`'s one-time provisioning step and the client's own self-presented attestation ever put a `card_hash` in front of anything Matrix-side.

---

## 4. Sender-Binding Check

**Rule:** a receiving client, after decrypting a room message, must verify that the card hash implied by the Matrix event's `sender` field matches the card hash recovered from the embedded, verified ML-DSA-44 signature. If they don't match, the message is rejected — not surfaced to the user as legitimate content.

```
on_receive(event, decrypted_payload):
    # Check 1 — signature validity
    if not mlDsa44Verify(decrypted_payload.signatures[0].public_key,
                          canonicalize(decrypted_payload.payload),
                          decrypted_payload.signatures[0].signature):
        reject("invalid_signature")
        return

    signer_card_hash = keccak256(decrypted_payload.signatures[0].public_key)

    # Check 2 — sender-binding (forward verification, no inversion needed)
    if not verifyMatrixUserIdBinding(signer_card_hash, event.sender, server_name):
        reject("sender_binding_mismatch")   # distinct from invalid_signature — see below
        return

    accept(decrypted_payload)
```

**Worked example of a violation:** Suppose card `A` (`card_hash_A`, shadow account `@card_9f3e...:matrix.internal` — the commitment of `card_hash_A`, not `card_hash_A` itself in any decodable form) has joined room `!xyz:matrix.internal` and posted messages there. A compromised client controlling that Matrix session crafts a message whose embedded envelope is signed by a *different* card `B`'s key (`card_hash_B`). Check 1 passes — the signature is a perfectly valid ML-DSA-44 signature, just from the wrong card. Check 2 fails: `verifyMatrixUserIdBinding(card_hash_B, "@card_9f3e...:matrix.internal", server_name)` recomputes the commitment of `card_hash_B` and finds it doesn't match `@card_9f3e...` (which is the commitment of `card_hash_A`). The message is rejected with `sender_binding_mismatch`, not `invalid_signature`. Note the receiving client never needed to know `card_hash_A` at all to catch this — it only ever worked forward from the candidate (`card_hash_B`) it already had.

**Why the two rejection reasons must be distinct:** `invalid_signature` describes an ordinary integrity/formatting failure (corrupted ciphertext, a bug, a non-card sender). `sender_binding_mismatch` describes a *valid* signature attached to the *wrong* identity — this is evidence of an attempted identity-drift attack (per `matrix_room_membership.md §5`), not a formatting error, and should be logged/surfaced distinctly so a client or auditor can tell the two apart. Collapsing them into one generic "message rejected" would erase exactly the signal that makes this check useful for post-hoc accountability.

**Enforcement boundary, restated from `matrix_room_membership.md §5`:** this check is enforced by every honest receiving client. It is **not**, and cannot be, enforced by Synapse — the server never decrypts the Megolm plaintext and therefore never sees either the embedded signature or which card it belongs to. Synapse's structural guarantee (via the policy module, `matrix_synapse_module.md`) is limited to "this Matrix account may currently post in this room"; it says nothing about which card's signature ends up inside any specific ciphertext that account submits. A malicious client can violate the sender-binding rule for its own outgoing messages; it cannot prevent honest receiving clients from detecting the violation on receipt. This is the same non-repudiation posture — signatures prove authorship after the fact, they don't prevent misuse before it — that the rest of the protocol already relies on.

---

## 5. Summary Table — What Changed vs. What Didn't

| | `messaging_protocol.md` (1:1 / small group) | Matrix rooms (this document) |
|---|---|---|
| Envelope shape | `payload` / `signatures` | Same, minus `recipients`/`senders`, plus optional `matrix_event_id` |
| Signing algorithm | ML-DSA-44 over canonical RFC 8785 payload | Identical |
| Recipient/routing model | `recipients` array + wallet-service routing table | Matrix room membership (structural, via Megolm session access) |
| Sender assertion | `senders` array, parallel to `signatures` | Matrix event `sender` field, cross-checked against the embedded signature (§4) — not trusted at face value |
| Confidentiality | Sender-side per-subcard encryption (`message_routing.md`) | Native Megolm (Matrix client crypto stack) |
| Non-repudiation | Signature verification | Identical, plus the additional sender-binding check (§4), which has no analog in 1:1 messaging because 1:1 messaging has no shared "room identity" for a card's signature to drift away from |
