# Room Discovery by Card — Process Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-11
**Status:** Draft
**Companion documents:** `specs/object_specs/matrix_room.md`, `specs/process_specs/matrix_room_membership.md`, `specs/process_specs/matrix_join_attestation_and_revocation.md`

**This document supersedes `matrix_room.md`'s framing that card-gated rooms are "otherwise unlisted — no public directory entry."** That was correct for the Matrix room directory specifically (rooms still aren't published there), but it left no way for a card holder to learn which rooms their card qualifies for at all. This document adds that capability without adding a public directory, and without requiring a card to reveal itself to any server to get an answer.

---

## Overview

A card holder should be able to ask "which rooms can my card access" and get an answer. Nothing about that question requires new confidentiality machinery: a room's `policy_id` is already visible in cleartext room state to anyone who can see the room (`matrix_room.md §What the Synapse Operator Can See`), the predicate document at that CID is already public IPFS content by design, and a card's own chain is already public (`card_protocol_spec.md`'s general stance — only message content and room membership are meant to be private, not policy or chain data). Discovery is therefore a **read over public data**, not a privileged query — and the default implementation should reflect that: **a client-side function, not a server endpoint.**

A server-hosted convenience endpoint remains available as a secondary path for clients that can't do local RPC/IPFS work (thin mobile clients, primarily), but it is not the default, and it's designed to learn as little as possible when used.

---

## 1. The Room Index

The one piece of infrastructure this capability actually needs that doesn't exist yet: a way to enumerate "rooms that exist and what `policy_id` each has," since nothing tracks this today.

**Published as a plain, publicly fetchable, unauthenticated list** — not IPFS-pinned, not on-chain. Room existence and `policy_id` are already non-sensitive by the protocol's own posture (see Overview), so this doesn't need content-addressing rigor; it needs to be cheap to fetch and cheap to keep current.

```
GET https://<wallet-service-public-host>/matrix/room-index

Response:
{
  "rooms": [
    { "room_id": "!xyz:matrix.internal", "policy_id": "bafyreih6qivnk...roompredicate", "created_at": "2026-07-10T18:00:00Z" },
    ...
  ],
  "updated_at": "2026-07-11T09:00:00Z"
}
```

- Written by `wallet-service`'s `POST /matrix/rooms` handler (`matrix_room.md §Room Creation`) — appends an entry at room-creation time. No new write path is needed beyond that.
- Publicly cacheable (standard HTTP caching; a CDN in front of this is appropriate, since it's read-heavy, non-sensitive, and identical for every requester — nothing personalized about the index itself).
- Does **not** need authentication to read — the whole point is that a card holder shouldn't have to identify themselves to get the list of what exists. `wallet-service`'s existing session-token auth (`matrix_room.md §Room Creation`) still gates *writing* an entry (i.e., creating a room), unchanged.
- **Open item:** whether a large deployment needs pagination or a lighter delta-since-timestamp query instead of the full list every time. Not addressed here; the full-list shape above is the starting point.

---

## 2. Client-Side Discovery (default)

A pure function, runnable entirely offline against public data sources — no query ever leaves the client bound to a `card_hash`.

```
discoverRooms(card_hash, room_index, ipfs_gateway, arbitrum_rpc) -> [room_id, ...]
```

1. **Chain-walk the card** — identical mechanics to `card_validation.md` Stage 3 (walk `ancestry_pubkeys` to a trusted root) and Stage 4 (collect current revocation status for each card in the chain). This is the same walk a client already needs to do to use its own card for anything; discovery doesn't add a new kind of walk.
2. **Fetch the room index** (§1).
3. For each `{room_id, policy_id}` entry in the index:
   a. Fetch the predicate document at `policy_id` from IPFS (per `matrix_room.md §The Room Predicate Document`).
   b. Evaluate it against the card's chain-walk result using the **same evaluator** the Synapse module uses server-side (`issued_under_template` per entry, plus `card_field_matches` where a `field_match` is present, `any_of` across the `policies` list) — this is a direct reuse of `predicates.py`'s logic, not a reimplementation with different semantics. A client-side library and the Synapse module's evaluator should share this logic (or at minimum be tested against the same fixtures) to avoid the two drifting apart.
   c. If satisfied, include `room_id` in the result.
4. Return the list of eligible `room_id`s.

**Nothing in this flow contacts any server with the card's identity.** The room index fetch is anonymous and identical for every requester (cacheable, as noted in §1); the IPFS and RPC reads are the same reads any verifier already performs and don't require presenting `card_hash` to anything — Arbitrum reads are by address, not by authenticated identity, and IPFS fetches are by CID.

**What this does not do:** get the card *into* the room. Discovery only answers "which rooms would accept you" — actually joining still requires the join attestation flow (`matrix_join_attestation_and_revocation.md §1-2`).

---

## 3. Server-Hosted Discovery (secondary, opt-in)

For clients that can't run a local RPC/IPFS chain-walk (e.g. constrained mobile clients), a `wallet-service` endpoint performs the identical computation server-side:

```
POST /matrix/discover-rooms
{ "card_hash": "<card's registry address>" }
  — authenticated via existing session-token auth, same as other wallet-service endpoints requiring
    an authenticated card holder

Response:
{ "rooms": [ { "room_id": "...", "policy_id": "..." }, ... ] }
```

This endpoint runs exactly the algorithm in §2 — same evaluator, same room index, same chain-walk — just server-side. It is offered because it's a **strict subset of what the client-side path already computes on public data**, not because it needs privileged access to anything the client couldn't compute itself.

**This is a real, new metadata exposure, and should be treated as one.** Using this endpoint tells `wallet-service` "this `card_hash` is interested in room eligibility right now" — a signal that doesn't exist anywhere in the client-side path. Constraints on this endpoint:

- **No persistent query log.** Retain only what's needed for abuse rate-limiting (e.g. a short-window request counter), not a durable record of which cards queried when.
- **Not the default.** Client SDKs should attempt the local path first and fall back to this endpoint only when local RPC/IPFS access genuinely isn't available, not as a convenience shortcut when it is.
- **Same trust boundary as everything else `wallet-service` already sees.** In the single-operator deployment this protocol currently targets, `wallet-service` already learns `card_hash` at shadow-account provisioning (`matrix_encryption.md §3`'s "honest limit" caveat) — this endpoint doesn't cross a new trust boundary, it just adds one more thing that operator learns about *when* a card is active, on top of *that* it's active.

---

## Summary

| | Client-side (default) | Server-hosted (secondary) |
|---|---|---|
| Where the chain-walk + predicate evaluation runs | On-device | `wallet-service` |
| What the server learns | Nothing — the room index fetch is anonymous and identical for all requesters | `card_hash` + a timestamp, per query (not retained beyond abuse rate-limiting) |
| Requires | Local RPC + IPFS access | Only an HTTP client + existing session auth |
| New infrastructure required | Room index (§1) — needed by both paths | Room index (§1), plus the endpoint itself |
