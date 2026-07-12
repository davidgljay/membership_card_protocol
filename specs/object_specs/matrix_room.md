# Matrix Room — Object Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-10
**Status:** Draft
**Companion documents:** `plans/matrix-strategic-plan.md`, `plans/matrix-implementation-plan.md`, `specs/process_specs/matrix_room_membership.md`, `specs/object_specs/matrix_synapse_module.md`, `specs/object_specs/matrix_encryption.md`

---

## Overview

A **Matrix room** is a card-gated group chat surface, additive to the protocol's existing 1:1/small-group messaging path (`process_specs/message_routing.md`). Access to a room — who may join it and who may continue posting to it — is governed by the same predicate system already specified in `card_protocol_spec.md §The Predicate System`, not by a new grammar. This document defines the room-level policy object, the room creation API shape, and what a Synapse operator can and cannot observe about a card-gated room.

This document supersedes `raw_notes/matrix.md §Room State and Policy` and `§What the Server Operator Can See`, which described an ad hoc `m.card.policy` predicate grammar (`issued_by` / `inherits_from` / `card_set`) that does not exist in the implemented protocol.

---

## The Room Predicate Document

A room's access rule is a **predicate document**: a JSON object, stored on IPFS, addressed by CID exactly like any other policy content in the protocol. Rather than an arbitrary, freely-nestable predicate tree, a room predicate document has a fixed, constrained shape: **a list of acceptable policies, each optionally refined by a single field-match regex.** A card is allowed if it was issued under *any* policy in the list (and, where present, satisfies that entry's field-match refinement).

```json
{
  "policies": [
    {
      "ref_type": "cid | pointer",
      "ref":      "<policy_id CID, if ref_type is \"cid\" — or the policy card's mutable pointer registry address, if ref_type is \"pointer\">",
      "field_match": { "field": "<name>", "regex": "<pattern>" }
    }
  ]
}
```

- `ref_type: "cid"` — `ref` is a `policy_id` CID, an immutable content snapshot, supplied directly by whoever authors the room predicate document. Evaluated with the protocol's existing `issued_under_template` leaf predicate, unchanged: **pinned** to that exact snapshot, matching how `issued_under_template` behaves everywhere else in the protocol (`card_protocol_spec.md §71`: compliance anchored to the CID pinned at issuance, not the policy's current mutable head).
- `ref_type: "pointer"` — `ref` is the policy card's **mutable pointer** (its on-chain registry address), given purely as an **authoring convenience**: whoever creates the room predicate document doesn't have to look up the policy's current CID by hand. The system resolves the pointer to its current CID **once, at the moment the predicate document is authored and pinned to IPFS**, and bakes that resolved CID into the document exactly as if `ref_type: "cid"` had been used with that value from the start. **There is no live re-resolution at evaluation time** — once the predicate document exists on IPFS, a `pointer`-originated entry is indistinguishable in behavior from a `cid` entry: both are evaluated with the same `issued_under_template` leaf, both pin to whatever policy content was current when the document was created, and a later edit to the policy at that pointer has no effect on rooms already using this document. This matches how `issued_under_template` pins everywhere else in the protocol — a room's access rule references **the policy in effect at the time the room's predicate document was created**, the same way a card's `policy_id` pins the policy in effect at the time the card was issued. `ref_type` is retained in the document purely as provenance metadata (so an author or auditor can tell how a given CID was originally obtained), not because the module branches on it at evaluation time.
- `field_match` (optional, per entry) — if present, a card must *also* satisfy `card_field_matches` against the same resolved policy CID for that entry, with the given `field`/`regex`, in addition to being issued under that policy. Kept per-entry rather than as one global constraint across the whole list, since `card_field_matches` needs a specific template to check fields against, and different listed policies may have entirely different field schemas.

**No new leaf predicate is introduced.** Every entry, regardless of `ref_type`, is evaluated with the existing `issued_under_template` (plus optional `card_field_matches`) — the module never performs an on-chain pointer read as part of evaluating a join or a post; any pointer resolution happens once, earlier, when the document is authored (see `matrix_room.md §Room Creation` / `wallet-service`'s document-authoring step, not the Synapse module).

**On IPFS and federation, for the record:** this predicate document's CID does not exist to solve cross-server visibility for a future federated deployment — Matrix's own room-state federation already replicates the `m.card.policy` state event (and its `policy_id` pointer) across every server participating in a room, the same mechanism that replicates `m.room.name`. The CID/IPFS choice is about **content-addressed pinning and independent verifiability** (a card holder or auditor can fetch and re-evaluate the exact predicate without trusting any single homeserver's account of it), consistent with how every other `policy_id` in the protocol works — not a federation-transport requirement.

**Two notes on scope, carried over from the general predicate system:**
- `is_holder` and `is_issuer` are not used within this fixed schema (there is no general predicate-tree nesting in which they'd appear); they remain reserved for the general predicate grammar elsewhere in the protocol.
- `code_equals` likewise has no place in this schema — it was never applicable outside `revocation_permissions` (8xx/9xx) context.

The predicate document's own CID — the same content-addressing scheme used for every other IPFS-stored object in the protocol — is referred to as the room's `policy_id`, regardless of what mix of `cid`/`pointer`-originated entries it contains internally.

**Worked example — a room open to two communities, both pinned as of document authoring, with a field restriction on the second:**

```json
{
  "policies": [
    {
      "ref_type": "cid",
      "ref": "bafyreigh2akiscaildc...community-policy-v1"
    },
    {
      "ref_type": "pointer",
      "ref": "0x9f2c...partner-org-policy-address",
      "resolved_ref": "bafyreiabc123...partner-org-policy-v3-at-authoring-time",
      "field_match": { "field": "status", "regex": "^(?!suspended$).*" }
    }
  ]
}
```

`resolved_ref` — present only on `pointer`-originated entries, recording the CID the pointer resolved to at authoring time — is what the module actually evaluates against; `ref` is retained solely as a record of where that snapshot came from. A card is allowed if it was issued under the exact `community-policy-v1` snapshot, **or** if it was issued under the partner org's policy exactly as it read at the time this room predicate document was authored (`resolved_ref`) *and* its `status` field does not read `suspended` under that same pinned snapshot. If the partner org's policy is later edited, rooms using this document are unaffected — a new predicate document (a new CID) would be needed to pick up the change, exactly as updating any other room policy requires posting a new `m.card.policy` state event pointing at a new `policy_id`.

---

## The `m.card.policy` Room State Event

Stored as Matrix room state (one instance per room, `state_key: ""`):

```json
{
  "type": "m.card.policy",
  "state_key": "",
  "content": {
    "policy_id": "<CID of the room predicate document>"
  }
}
```

That is the entire event — no `rules`, no `visibility` field, no locally-defined predicate tree (all present in `raw_notes/matrix.md`'s version, all removed here). `content.policy_id` is the only field: a CID, resolved by the Synapse policy module (see `matrix_synapse_module.md`) by fetching the predicate document at that CID and evaluating it against a card's chain, exactly as any other verifier in the protocol evaluates a predicate. Updating a room's policy means posting a new `m.card.policy` state event with a new `policy_id` (a new predicate document CID) — the state event itself is mutable Matrix room state even though the predicate document it points to is immutable content.

**Worked example — full state event:**

```json
{
  "type": "m.card.policy",
  "state_key": "",
  "sender": "@card_3f9a...:matrix.internal",
  "content": {
    "policy_id": "bafyreih6qivnk...roompredicate"
  },
  "event_id": "$abc123...",
  "room_id": "!xyz:matrix.internal",
  "origin_server_ts": 1751500000000
}
```

---

## Room Creation: `POST /matrix/rooms`

New `wallet-service` endpoint (implemented in Phase 4, Step 16). Requires an authenticated card holder (existing session-token auth, per `wallet-service/src/auth/session-token.ts`).

**Request:**

```json
{
  "card_hash": "<the creating card's registry address>",
  "policy_id": "<CID of an existing room predicate document>",
  "name": "<optional — human-readable room name>",
  "topic": "<optional — human-readable room topic>"
}
```

- `card_hash` — the card whose shadow Matrix account creates and auto-joins the room. Must belong to the authenticated session.
- `policy_id` — CID of a predicate document, per the shape above. `wallet-service` does not validate that the CID resolves to well-formed predicate content at creation time beyond a basic parse (the Synapse module is the authority on evaluation; see `matrix_room_membership.md` for deny-by-default handling of a malformed or unreachable predicate document at evaluation time).
- `name`, `topic` — optional, passed through to Matrix's own `m.room.name` / `m.room.topic` state events.

**Response:**

```json
{
  "room_id": "<Matrix room ID, e.g. !xyz:matrix.internal>",
  "matrix_alias": "<optional — Matrix room alias, if one was assigned>"
}
```

`matrix_alias` is present only if the deployment assigns human-readable aliases to card-gated rooms; this pass does not require it (rooms are not listed in Matrix's own public room directory, consistent with `raw_notes/matrix.md`'s "not listed in standard Matrix public room directory" intent). **They are, however, discoverable by card** — see `specs/process_specs/room_discovery.md` (2026-07-11), which adds a lightweight room index (`room_id` + `policy_id` pairs, published by this same endpoint's handler) and a client-side function that evaluates a card's chain against every listed room's predicate document, entirely on public data with no server query required by default.

---

## What the Synapse Operator Can See

| | Visible to Synapse operator | Notes |
|---|---|---|
| Room ID, creation/join/leave timestamps | ✓ | Standard Matrix room metadata |
| `m.card.policy` state event (`policy_id` CID) | ✓ | Cleartext room state; the CID itself, not the predicate content unless the operator independently fetches it from IPFS |
| Room membership (which Matrix user IDs have joined) | ✓ (Matrix user IDs only — not `card_hash`) | Matrix user IDs are a one-way cryptographic commitment of `card_hash` (`matrix_encryption.md §3`), not `card_hash` itself in any decodable form. A Synapse-only observer — including any other room participant or, in a future federated deployment, any federated peer server — **cannot** invert a Matrix user ID back to `card_hash`; there is no function that does this. **As of the 2026-07-11 join-attestation redesign (`matrix_join_attestation_and_revocation.md`), the Synapse module never queries `wallet-service` to resolve this either** — the joining client self-presents a signed attestation, verified with a forward check (`verifyMatrixUserIdBinding`), and the module retains the resolved `card_hash` only in its own in-process membership registry for the room's duration, not via any call to `wallet-service`. `wallet-service`'s only remaining involvement is provisioning the shadow account once, at first use. In a deployment where the same operator runs both `wallet-service` and Synapse, that operator can still connect the two by consulting `wallet-service`'s own provisioning records — this table entry describes what's derivable from Synapse's own visible state and protocol traffic alone, not an absolute guarantee against the entity that issues the binding in the first place. |
| Message plaintext (body, attachments, reactions, etc.) | ✗ | Megolm-encrypted; see `matrix_encryption.md` |
| Card signature embedded in a message | ✗ | Inside the Megolm-encrypted plaintext; operator cannot decrypt it |
| Predicate document content (the actual predicate rules) | ✗ (indirectly available) | The `policy_id` CID is visible in cleartext room state, and the predicate document is public IPFS content by construction (same as any other policy/card content in the protocol) — so an operator (or anyone) *can* fetch and read the rules if they choose to, but this is no different from any other protocol content addressed by CID. This is **not** a confidentiality property; it mirrors `card_protocol_spec.md`'s general stance that policy and chain data are public, only message content is private. |

This table corrects `raw_notes/matrix.md §What the Server Operator Can See`, which conflated "card IDs from unsigned signatures" (a design this protocol does not have — signatures are inside the encrypted body, not in an `unsigned` block) with an encryption model this protocol does not use.

---

## Open Items Carried to Later Phases

- Where exactly `ref_type: "pointer"` resolution-at-authoring-time happens is not yet specified in code terms — presumably `wallet-service`'s `POST /matrix/rooms` handler (Step 16) or a preceding "create predicate document" step reads the mutable pointer once (same RPC path `wallet-service` already uses elsewhere) and writes the resolved `resolved_ref` CID into the document before pinning it to IPFS. This document only specifies the resulting document shape and pinning semantics, not which component performs the one-time resolution.
- Whether a room predicate document's `policies` list has a practical size limit is not yet specified — since every entry is a plain CID by the time the Synapse module evaluates it (no per-request on-chain reads), this is a matter of IPFS-fetch and predicate-evaluation cost only, not RPC cost, and is likely a non-issue for realistic list sizes.
