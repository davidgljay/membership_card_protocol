# Phase 3 Step A — `code-matrix-room`

**Spec:** `specs/object_specs/matrix_room.md`
**Code:** `wallet-service/src/matrix/*` (primarily `room-creation.ts`, `room-discovery.ts`), `wallet-service/server/routes/matrix/*`, `wallet-service/matrix-policy-module/src/matrix_policy_module/predicates.py`, cross-checked against `specs/object_specs/wallet.md §7.10` (added today) and `specs/object_specs/matrix_synapse_module.md`.

Read-only review. No spec or code file modified.

---

## Summary

No contradictions found. One finding is a genuine, currently-existing **spec gap** (not a spec-vs-code contradiction, and not something Phase 1's doc fix introduced or missed) that is security-relevant enough to call out per the Phase 3 escalation criterion. Everything else checked out as consistent.

---

## Finding 1 — `m.room.encryption` / `m.room.power_levels`: code already had this; Phase 1's doc fix was catching up to existing code (no action needed)

`matrix_room.md §Room Creation` (as amended by Phase 1, changelog "Fixes #33–#37") states that room creation sets, in addition to `m.card.policy`/`m.room.name`/`m.room.topic`:

- an `m.room.encryption` state event (`m.megolm.v1.aes-sha2`)
- an `m.room.power_levels` state event granting kick-level power to `enforcement_matrix_user_id`

`wallet-service/src/matrix/room-creation.ts` (`createMatrixRoomViaSynapse`, lines 156–182) constructs exactly these two state events (plus `m.card.policy` and an `m.room.join_rules` override — see Finding 2) in its `initial_state` array passed to Synapse's `POST /createRoom`. The power_levels entry grants `ROOM_KICK_POWER_LEVEL` (50) to `enforcementUserId` while keeping the creator at 100. This is asserted directly in `wallet-service/test/matrix-room-creation.test.ts` (`'calls Synapse createRoom, authenticated as the creator, with all four expected initial_state entries'`), which checks all four state events, including the power-levels ordering (enforcement account < creator).

The code's own header comment states: *"The power_levels grant is new as of 2026-07-12 (not in the original matrix_room.md text)"* — i.e., the code added this behavior on 2026-07-12, predating the Phase 1 spec amendment (2026-07-11 amendment date on the doc, Phase 1 changelog entry added later, today). This confirms the direction of travel: **code implemented the behavior first; the Phase 1 doc fix correctly caught the spec up to it.** There is no residual gap — the code does set both state events, and the security-relevant power_levels grant (used by `matrix-policy-module/src/matrix_policy_module/watcher.py`'s force-part mechanism) is live in the implementation, not just on paper.

**Resolution:** none needed. This confirms the Phase 1 fix was correct; no further doc or code change required for this item.

---

## Finding 2 — `m.room.join_rules` override is undocumented in `matrix_room.md` (spec gap, security-relevant)

`room-creation.ts` sets a fourth, non-default initial state event that `matrix_room.md §Room Creation` does not mention at all: an explicit `m.room.join_rules` override to `"public"`.

The code's header comment (dated 2026-07-16, today) explains why this exists and that it is **not cosmetic**:

> `preset: "private_chat"` alone sets Synapse's default `m.room.join_rules` to `"invite"` ... Under an invite-only join rule, Synapse's core event-authorization ... rejects a non-invited user's `/join` with `403` — before `matrix_policy_module`'s `user_may_join_room`/`check_event_for_spam` callbacks ever run. That silently defeated the entire card-gating mechanism ... Confirmed live: attempting to join a room created with the old `private_chat`-only config always failed ... regardless of whether a valid attestation was presented, never reaching the module at all.

In other words: without this specific state event, `matrix_room_membership.md`'s entire predicate-evaluation model (a shadow account presents an attestation, the Synapse module evaluates it against the room predicate) never executes — every join attempt is rejected by Matrix's own invite-only auth first. This was evidently a real, live bug (caught in a Step 20 integration test the same day this review was run) and is now fixed in code and covered by a test assertion (`matrix-room-creation.test.ts`, the `joinRules` check).

Neither `matrix_room.md` nor `matrix_room_membership.md` mentions `join_rules` or `private_chat`/`invite` anywhere (confirmed via grep — zero hits in both files). The spec's Room Creation section enumerates `m.card.policy`, `m.room.name`, `m.room.topic`, `m.room.encryption`, and `m.room.power_levels` as the state set, but omits `m.room.join_rules` even though it is load-bearing for the entire gating mechanism to function at all — arguably more foundational than the power_levels grant, since power_levels only matters for *revocation* (force-part), whereas join_rules is what lets the *join-time* gate run in the first place.

**Which side is correct:** the code is correct (and has a same-day integration test proving the alternative — relying on `private_chat`'s default — is actively broken). The spec is incomplete: it documents a room-creation state set that, if implemented literally as written (four events, no `join_rules` override), would silently defeat card-gating exactly as the code's bug report describes.

**Recommended resolution:** update `matrix_room.md §Room Creation` to add a third bullet alongside the existing `m.room.encryption`/`m.room.power_levels` bullets, documenting the required `m.room.join_rules` → `"public"` initial state override and *why* it's required (Synapse's `private_chat` preset default is `invite`, which bypasses the policy module's callbacks entirely at the Matrix protocol-auth layer, before any card-gating logic runs). This is security-relevant in the sense the Phase 3 plan's escalation criterion describes (an auth-boundary behavior) — recommend flagging to David directly rather than folding into a routine consolidated fix list, even though the direction of the fix (spec should document what code already correctly does) is not in doubt.

---

## Finding 3 — Room predicate document schema (`ref_type`, `resolved_ref`) and evaluation semantics: code matches spec

Checked three places that touch the predicate-document schema:

1. **`wallet-service/matrix-policy-module/src/matrix_policy_module/predicates.py`** (`evaluate_room_predicate` / `_entry_conditions`): for each entry in `policies`, uses `entry.get("resolved_ref") or entry["ref"]` as the policy CID to evaluate against, and folds `field_match` into `PolicyMatchConditions`. Matches `matrix_room.md`'s description exactly: *"`resolved_ref` ... is what the module actually evaluates against; `ref` is retained solely as a record of where that snapshot came from."* No on-chain/pointer resolution happens in this module at evaluation time, consistent with the spec's claim that "the module never performs an on-chain pointer read as part of evaluating a join or a post."

2. **`wallet-service/src/matrix/room-discovery.ts`** (`evaluateRoomPredicate` / `entryConditions`, used by the server-hosted `POST /matrix/discover-rooms` fallback path): identical logic, `entry.resolved_ref ?? entry.ref`, same `any_of` loop, calling the shared `evaluatePolicyMatch` from `@membership-card-protocol/verifier` rather than a hand-rolled reimplementation — matching the spec's "no new leaf predicate is introduced" / single-evaluator design intent, and the file's own comments explicitly track this as intentionally parallel-but-shared logic across Python/TS/client-sdk.

3. **Pointer-to-CID resolution at authoring time** (the step that would populate `resolved_ref` from a `ref_type: "pointer"` entry's on-chain address): **not implemented anywhere in `wallet-service/src/matrix*`.** `POST /matrix/rooms` (`room-creation.ts` / `server/routes/matrix/rooms/index.post.ts`) takes `policy_id` directly as an already-resolved CID from the request body — it does not accept or construct a `{ policies: [...] }` predicate document, does not branch on `ref_type`, and performs no pointer resolution. This is **not a spec-vs-code contradiction**: `matrix_room.md`'s own "Open Items Carried to Later Phases" section explicitly says this is undecided — *"Where exactly `ref_type: "pointer"` resolution-at-authoring-time happens is not yet specified in code terms ... This document only specifies the resulting document shape and pinning semantics, not which component performs the one-time resolution."* The code's current scope (accept a pre-existing predicate-document CID, don't author one) is consistent with the spec deferring that question. Flagging for visibility only, not as an inconsistency: whoever builds the "author a predicate document" step later will need to implement the pointer-resolution logic somewhere (`wallet-service` or a client-side tool), and it doesn't exist yet in this codebase.

**Resolution:** no change needed for items 1–2 (already consistent). Item 3 is a known, spec-acknowledged open item, not a new finding — no action beyond what the spec's own Open Items section already tracks.

---

## Finding 4 — `wallet.md §7.10` cross-check: consistent with both spec and code

`wallet.md §7.10` (added today) documents `POST /matrix/rooms`, `GET /matrix/room-index`, and `POST /matrix/discover-rooms`. Verified against the actual route handlers:

- `POST /matrix/rooms` — request/response shape, session-token auth, `card_hash`-must-match-session check, and "creates the room (setting initial `m.room.encryption` and `m.room.power_levels` state)" all match `server/routes/matrix/rooms/index.post.ts` and `src/matrix/room-creation.ts`. (Same omission as Finding 2: `wallet.md §7.10` also doesn't mention the `m.room.join_rules` override, consistent with `matrix_room.md` not mentioning it either — the two specs are at least internally consistent with each other, they just share the same gap.)
- `GET /matrix/room-index` — no-auth, `{ rooms: [{room_id, policy_id, created_at}], updated_at }`, publicly cacheable — matches `server/routes/matrix/room-index.get.ts` and `server/db/matrix-rooms.ts` exactly, including the `Cache-Control: public, max-age=30` behavior described as "publicly cacheable."
- `POST /matrix/discover-rooms` — session-token auth, envelope-based request (not bare `card_hash`), response `{ room_ids: [...] }` — matches `server/routes/matrix/discover-rooms.post.ts` exactly, including the signature/signer_card verification the doc describes.

**Resolution:** none needed beyond Finding 2's recommendation, which would also touch this section's phrasing if David wants both updated together.

---

## Escalation note (per Phase 3 Clarification Checkpoints)

Finding 2 is being surfaced directly (not folded into a routine consolidated fix list) because it concerns an auth-boundary behavior (`m.room.join_rules`) that is currently undocumented but load-bearing for the entire card-gating mechanism — matching the plan's stated escalation criterion for "the code is right and the spec is wrong on something load-bearing." To be precise about severity: this is **not** a case of code being insecure — the code is correct and already tested. It's a documentation-completeness gap whose absence could mislead a future reader/implementer (e.g., someone reimplementing room creation from the spec alone would ship the exact bug the 2026-07-16 integration test just caught).
