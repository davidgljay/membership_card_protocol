# Matrix Room Membership & Authorization — Process Spec

**Version:** 0.2 (draft)
**Date:** 2026-07-10 (amended 2026-07-11)
**Status:** Draft
**Companion documents:** `specs/object_specs/matrix_room.md`, `specs/object_specs/matrix_synapse_module.md`, `plans/matrix-strategic-plan.md §Goal 2`, `specs/process_specs/matrix_join_attestation_and_revocation.md`

**Amended 2026-07-11:** `§1` step 2 (wallet-service card-binding resolver), `§3` (Card Cache and TTL) in full, and the "wallet-service unreachable" row of `§4` are **superseded** by `specs/process_specs/matrix_join_attestation_and_revocation.md`. That document replaces the live resolver call with a client-presented signed attestation, and replaces the 60-second TTL cache with an event-driven watcher against the registry's `CardHeadUpdated` event. **§2 (Post Sequence) below is also partially superseded, not just historical**: its "Steps 1–6 above, identical, re-run for the posting card" phrasing assumed the old step 2 (a resolvable-on-demand `card_hash` lookup) still applied to posts the same way it applied to joins. It doesn't — a post carries no attestation of its own. `matrix_join_attestation_and_revocation.md §2a` (added 2026-07-11, during this Phase 1 review) specifies the actual mechanism: the module looks up `card_hash` from its own membership registry, populated once at join, not by re-resolving anything per post. §4's non-wallet-service failure rows and §5's per-room card binding are still current as written. Read `matrix_join_attestation_and_revocation.md` (including §2a) as authoritative wherever it and this document disagree.

**Changelog (spec-consistency Phase 1):** Fix #38 — struck the stale "wallet-service card-binding resolver" checklist line to match this document's own superseding note. See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 2):** Fix #45 — rewrote §2 Post Sequence step 1's body text to say steps 3–6 (not 1–6) are re-run for posts, with `card_hash` resolved via membership-registry lookup. Fix #46 — converted the bold `[Superseded]` tags in §1 step 2 and §3 to strikethrough, matching the convention already used in §4 and the Summary checklist. Fix #47 — added the new `matrix_join_attestation_and_revocation.md §3.3` failure-mode bullets to the Summary checklist and a pointer to that document as the authoritative current list. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

---

## Overview

This spec defines the exact sequence the Synapse policy module runs when a card attempts to join a room or post a message to one, the caching behavior that makes revocation enforcement practical without hammering Arbitrum RPC/IPFS on every action, and the failure-mode handling that keeps the module **deny-by-default** under every external-dependency failure.

The module enforces this **server-side** (Goal 2 of the strategic plan requires server-side enforcement, not just client-side) because Synapse's own room-membership and event-authorization machinery is the only component positioned to block a join or post before it takes effect — unlike message *content*, which the module can never see (Megolm-encrypted), room membership and the *fact* of posting are visible to Synapse and therefore enforceable by it.

---

## 1. Join Sequence

Triggered by Synapse's room-join module callback (exact callback name confirmed in `matrix_synapse_module.md`) when a card's shadow Matrix account attempts to join a room.

1. **Resolve the room's policy.** Read the room's current `m.card.policy` state event (`state_key: ""`) to get `policy_id`, which identifies the room's predicate document (see `matrix_room.md`).
2. ~~Resolve the joining card's hash via a private lookup, not computation. The shadow-account derivation (`matrix_encryption.md §3`) is a one-way commitment with no general inverse — the module cannot compute `card_hash` from a bare Matrix user ID. Instead, it calls `wallet-service`'s internal card-binding resolver (see `matrix_synapse_module.md` for the endpoint, config, and transport) with the joining Matrix user ID. `wallet-service` returns the `card_hash` it recorded for that Matrix ID at shadow-account provisioning time (when it authenticated the card holder via session token) — or a not-found response if this Matrix ID was never provisioned by this deployment's `wallet-service`, which is treated as a deny (§4).~~ Superseded 2026-07-11 — see `matrix_join_attestation_and_revocation.md §2`, which replaces this step with a client-presented signed attestation verified via `verifyMatrixUserIdBinding`.
3. **Resolve the joining card's chain data.** Call the cache (`cache.get_or_refresh(card_hash)`, §3 below) to get a fresh-enough chain-walk result for the card, refreshing via Arbitrum RPC + IPFS gateway if the cached entry is stale or absent.
4. **Fetch and parse the predicate document.** Fetch the content identified by `policy_id`; parse it as a predicate document (`{ "policies": [ { "ref_type", "ref", "resolved_ref"?, "field_match"? }, ... ] }`, per `matrix_room.md`). Every entry's effective CID is already concrete by this point — `ref` itself for a `cid` entry, `resolved_ref` for a `pointer` entry (resolved once, at authoring time, per `matrix_room.md §The Room Predicate Document`). **The module never performs an on-chain pointer read as part of this or any evaluation step** — that resolution already happened before the document was pinned to IPFS.
5. **Evaluate.** For each policy entry, check whether the joining card's chain-walk result includes a card issued under that entry's effective CID (`issued_under_template` semantics, identical regardless of whether the CID originated from `ref` or `resolved_ref`), and, if the entry carries a `field_match`, that a card in the chain issued under that same CID also satisfies `card_field_matches` for the given `field`/`regex`. The card is allowed if **any** entry in `policies` is satisfied (an implicit `any_of` across the list; each entry's own `issued_under`-plus-optional-`field_match` check is an implicit `all_of` of two conditions).
6. **Allow or deny.** If any entry is satisfied, allow the join. If none are, deny.

## 2. Post Sequence

Triggered by Synapse's `check_event_for_spam` callback (confirmed in `matrix_synapse_module.md`) on **every** message event, not only at join time.

1. **Steps 3–6 above (not 1–6) are re-run for the posting card on every message.** Step 1 (resolving the room's policy) is unnecessary per-post work already covered by step 2 below. **Step 2 (the wallet-service `card_hash` resolver) is not re-run and no longer applies to posts at all** — it is replaced by a membership-registry lookup keyed by `(room_id, event.sender)`, per `matrix_join_attestation_and_revocation.md §2a`: the module looks up the `card_hash` associated with this room membership (populated once, at join time, from the verified join attestation) rather than re-resolving it per message. Only after `card_hash` is obtained this way do steps 3–6 (chain-walk cache lookup, predicate document fetch, evaluation, allow/deny) run identically to the join sequence.
2. **The room's `policy_id` is re-read from room state on every post, not cached at the room level.** Only the per-card chain-walk result is cached (§3) — the predicate document's own contents (including any `resolved_ref` values) are treated as immutable once fetched, since the document itself is immutable IPFS content; there's nothing in it that goes stale the way a card's chain does. This avoids a stale-policy bug if a room's `m.card.policy` is updated to point at a new predicate document — the new policy takes effect on the very next post, not after some separate room-policy cache TTL.
3. Allow or deny exactly as in the join sequence.

**This re-evaluation on every post — not just at join — is what makes revocation enforcement work.** A card that satisfied the policy at join time but has since had its qualifying credential revoked will fail step 5 on its next post, once its cached chain-walk result (§3) expires and is refreshed.

## 3. Card Cache and TTL

Superseded 2026-07-11 — see `matrix_join_attestation_and_revocation.md §3`, which replaces the TTL model below with an event-driven watcher against `CardHeadUpdated`. Retained struck-through as historical context for why the design changed, per this document's header note.

~~Two distinct caches, with different TTLs, since they cache different kinds of fact:~~

~~**Chain-walk cache** (the revocation-sensitive one):~~
- ~~Cache key: `card_hash`.~~
- ~~Cache value: the chain-walk result (the data structure `chain_walk.py` produces — the full resolved chain used by the predicate evaluator) plus the timestamp it was computed.~~
- ~~**Default TTL: 60 seconds**, matching the general order of magnitude of TTL-based caching already used elsewhere in `wallet-service` (e.g. its own card cache, session-token TTLs). This is an assumption carried from the top-level implementation plan, not yet confirmed by David — see the plan's Clarification Checkpoint before Phase 3, Step 9.~~
- ~~**Staleness semantics:** a join or post request arriving within 60 seconds of the last chain-walk for that `card_hash` uses the cached result without re-hitting Arbitrum RPC or IPFS. A request arriving after the TTL has elapsed triggers a synchronous re-walk before the request is evaluated — **the module never evaluates a policy against a chain-walk result older than the TTL window**, and it never serves a request while a background refresh is "still in flight" using a stale value (the refresh is synchronous and blocking from the perspective of the request that triggered it).~~
- ~~This TTL is what bounds "how long can a revoked card still post after revocation": at most `TTL` seconds after the on-chain/IPFS revocation is itself visible to the module's RPC/IPFS reads (which, barring RPC/IPFS lag, is immediate).~~

~~**Matrix-ID-to-card-hash binding cache** (not revocation-sensitive):~~
- ~~Cache key: `matrix_user_id`.~~
- ~~Cache value: the `card_hash` returned by `wallet-service`'s binding resolver (§1, step 2).~~
- ~~**This binding never changes for a given card** — a card's shadow-account ID is fixed for the card's lifetime (`matrix_encryption.md §3`), unlike chain data, which can be revoked or updated at any time. There is therefore no revocation-driven reason to expire this cache entry on the same 60-second cadence as the chain-walk cache; it may be cached far longer (e.g. for the lifetime of the Synapse process, or with a long TTL purely as a memory-hygiene measure, not a correctness one). The 60-second TTL that matters for revocation applies entirely to the chain-walk cache above, not to this one.~~
- ~~A cache miss (or a `wallet-service` not-found response) is **not** cached as a negative result indefinitely — a card provisioned moments after a failed lookup should succeed on its next attempt without waiting out a stale negative cache entry. A short negative-cache TTL (or none at all) is acceptable here since a failed lookup already denies the request (§4); the concern is availability for legitimately-provisioned cards, not revocation responsiveness.~~

## 4. Failure Modes — Deny by Default

Every external dependency failure results in **denial**, never in falling back to an allow. This module never fails open.

| Failure | Behavior |
|---|---|
| ~~`wallet-service`'s binding resolver unreachable, errors, or returns not-found for the Matrix user ID attempting to join/post~~ | **Superseded 2026-07-11.** This dependency no longer exists — see `matrix_join_attestation_and_revocation.md §3.3`'s `"attestation_invalid"` row for the replacement failure mode. |
| Arbitrum RPC unreachable or errors (the joining/posting card's own chain walk) | Deny. Log `card_hash`, `room_id`, and `"rpc_unreachable"` as the reason. Do not use a stale cached result past its TTL to paper over the outage — if the cache is stale and the refresh fails, deny. |
| IPFS gateway timeout or non-200 response (fetching either chain content or the predicate document) | Deny. Log `card_hash`, `room_id`, and `"ipfs_unreachable"` (chain content) or `"predicate_document_unreachable"` (predicate document) as appropriate. |
| Malformed chain data (fails to parse, breaks an invariant the chain walk expects) | Deny. Log `card_hash`, `room_id`, and `"malformed_chain"`. |
| Malformed predicate document (not valid JSON, missing/empty `policies` array, an entry with an unrecognized `ref_type`, a `pointer`-originated entry missing `resolved_ref`, or a `field_match` missing `field`/`regex`) | Deny. Log `room_id` and `"malformed_predicate_document"` (no `card_hash` is relevant here — the failure is room-level, not card-level). |
| Predicate evaluation itself throws (a bug, an unexpected shape) | Deny. Log `card_hash`, `room_id`, and `"evaluation_error"`. This is the module's last line of defense — a bug in the evaluator must not become an accidental allow. |

In every case, the log line records `card_hash`, `room_id`, and a short failure/deny reason code — **never the full chain data or predicate document content** — consistent with the protocol's "operators see metadata, not content" posture (`matrix_room.md §What the Synapse Operator Can See`).

## 5. Per-Room Card Binding

Every message in a card-gated room must be signed by a card, and — this is the property this section defines — **once a card has joined or posted in a room, every later message attributed to that participant in that room must be signed by that same card.** A holder who controls several cards may not have their room identity drift message-to-message between different cards they hold. This mirrors the invariant Matrix rooms already give for free at the account level (a Matrix room participant is one Matrix user ID for the room's duration); this section extends it to say the card behind that Matrix user ID must also stay fixed.

**This cannot be enforced by the Synapse module.** The module authorizes the *Matrix account* (the shadow account, 1:1 with a card by construction — see `matrix_encryption.md`) to join and post; it cannot decrypt Megolm content to inspect which card's signature is embedded inside any given message. Structurally, the module's enforcement (§1–2 above) already guarantees "one Matrix account per card" and "this Matrix account's underlying card currently satisfies the room policy" — but it has no visibility into whether the *signature inside a specific ciphertext* matches the *card the Matrix sender ID implies*.

**This is therefore a client-side, receive-time obligation:**

1. On receipt of a decrypted message, a receiving client first verifies the embedded signature and recovers the signer's `card_hash` from it (this is the client's only candidate card hash — it never needs to determine one from the Matrix `sender` field directly, since the shadow-account derivation has no inverse; see `matrix_encryption.md §3`).
2. The client checks `verifyMatrixUserIdBinding(signer_card_hash, event.sender, server_name)` — a forward recomputation, not a lookup — to confirm the Matrix `sender` is indeed this card's shadow account.
3. If that check fails, the client **rejects the message** — it is not surfaced to the user as legitimate content, and the rejection is logged/surfaced distinctly from an ordinary invalid-signature rejection (see `matrix_encryption.md §Sender-Binding Check` for the precise worked example and error semantics).

**Residual trust assumption, stated explicitly:** a modified or malicious client *could* violate this rule for its own outgoing messages — nothing server-side stops a compromised client from signing with a different card than the one implied by its Matrix session. What is guaranteed is that **any honest client, and any auditor inspecting the room's history after the fact, will detect and reject the violation on receipt.** This is the same non-repudiation posture the rest of the protocol already relies on elsewhere (a signature proves what was signed and by whom; it does not prevent a compromised signer from signing something they shouldn't have — detection and accountability happen after the fact, not prevention before). It is not a new or weaker trust assumption relative to the rest of the protocol, just a new place the same assumption applies.

---

## Summary: Deny-by-Default Coverage Checklist

- ~~Wallet-service card-binding resolver unreachable, erroring, or not-found → deny~~ Superseded — see `matrix_join_attestation_and_revocation.md §3.3`'s `attestation_invalid` and `membership_not_registered` rows
- [x] RPC unreachable → deny
- [x] IPFS gateway unreachable (chain content) → deny
- [x] IPFS gateway unreachable (predicate document) → deny
- [x] Malformed chain data → deny
- [x] Malformed predicate document → deny
- [x] Predicate evaluator internal error → deny
- [x] No fallback to "last known good" beyond the TTL window in any failure case

**The rows above are this document's own, still-current failure modes. They are not the complete deny-by-default list as of the 2026-07-11 redesign** — `matrix_join_attestation_and_revocation.md §3.3` adds further failure modes introduced by the join-attestation/event-driven model, not enumerated here to avoid the two lists drifting out of sync:
- [x] Join attestation fails signature/freshness/`server_name`/sender-binding check → deny (`"attestation_invalid"`)
- [x] Post-time membership-registry lookup finds no entry for `(room_id, event.sender)` → deny (`"membership_not_registered"`)
- [x] Encrypted membership-registry file unreadable, or its decryption key unavailable, at module startup → fail loudly at startup, do not start with an empty registry

**The current authoritative deny-by-default list is `matrix_join_attestation_and_revocation.md §3.3` plus this document's non-superseded rows above.**
