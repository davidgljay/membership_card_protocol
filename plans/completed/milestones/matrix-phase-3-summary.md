# Matrix Phase 3 Milestone Review — Synapse Policy Module

**Date:** 2026-07-12 (amended twice same day — join-attestation wire transport resolved, then the force-part mechanism resolved)
**Status:** Complete — all Steps 8–12a built and tested; one implementation-detail open item carried forward to Phase 4 (down from three — the join-attestation wire transport and the force-part mechanism were both resolved during this same session, see below).

## What was built

`wallet-service/matrix-policy-module/` — a standalone Python package, 74 passing tests (`pytest`), `pip install -e .` succeeds against a path dependency on `membership-card-verifier` (publish status: still unpublished as of this review — confirm before switching to a versioned dependency).

**Second amendment, same day:** the force-part mechanism (originally open item 3, below) is also resolved. Researched against current Synapse docs/source/issue tracker rather than guessed: there is no Synapse Admin API HTTP endpoint to force-remove a user from a room (`element-hq/synapse#17885` asked for exactly this, closed "not planned"). `watcher.py`'s `HttpSynapseAdminClient` (an unconfirmed, and now confirmed-wrong, placeholder) is replaced by `ModuleApiForcePartClient`, which calls `ModuleApi.update_room_membership(sender, target, room_id, new_membership="leave")` — an in-process, privileged call requiring no admin token at all. This drops the previously-planned Step 7b (watcher admin token) entirely; a new Step 7d provisions a dedicated enforcement account instead, and Step 16 (room creation, Phase 4) picks up a new requirement to grant that account kick-level power in every card-gated room's initial `m.room.power_levels`, or force-part will fail at runtime with a permission error. `specs/process_specs/matrix_join_attestation_and_revocation.md §3.1`, `specs/object_specs/matrix_synapse_module.md`'s config schema (new `enforcement_matrix_user_id` field), `wallet-service/.env.example`, and `plans/matrix-implementation-plan.md` (Steps 7b/7d/11a/16) were all updated to match. New test: `test_module_api_force_part_client.py`.

**Amended same day:** the join-attestation wire transport (open item 1, below, as originally written) was resolved with David before Phase 4 started: the attestation now rides as a custom, namespaced key (`io.cardprotocol.join_attestation`) in the `m.room.member` join event's own content — the same extensibility mechanism MSC3083 (restricted rooms) already uses for a signed join authorization, not a bespoke protocol extension. This was forced by a real constraint discovered, not designed around in the abstract: `user_may_join_room(user, room, is_invited)` has no parameter for arbitrary request content, so a custom `/join` parameter could never have reached it regardless of client behavior. `user_may_join_room` is now a permissive no-op; `check_event_for_spam` does the real join gating when it sees an `m.room.member`/join event in a card-gated room. `specs/process_specs/matrix_join_attestation_and_revocation.md §1` and `specs/object_specs/matrix_synapse_module.md`'s callback section were updated to match; `module.py` and `test_module.py` were rewritten around the resolved design (73 tests still pass, no `AttestationSource` abstraction remains — it's no longer needed since the attestation is read directly off `event.content`).

| Module | Step | Covers |
|---|---|---|
| `config.py` | 8 | Typed config, fails loudly on missing/malformed keys |
| `module.py` | 8, 12 | `PolicyModule` — `user_may_join_room` is a permissive no-op (see amendment above); `check_event_for_spam` handles both post authorization and join authorization (via `m.room.member`/join event content) |
| `rpc_provider.py` | 9a | `Web3RpcProvider` (registry contract reads) + `CardHeadEventSubscription` (watcher's WS feed) |
| `ipfs_provider.py` | 9b | `HttpxIpfsProvider` |
| `predicates.py` | 9c | Thin `any_of`-over-`policies` loop calling the verifier package's `evaluate_policy_match` |
| `chain_context.py` | 10 | `CardVerifier` integration — join-time full chain walk, post-time bare-address revocation re-check |
| `cache.py` | 11 | Event-invalidated chain-walk cache, no TTL |
| `watcher.py` | 11a | Watch-set ref-counting, force-part-on-any-revocation with retry, backstop re-walk, reconnect catch-up |
| `membership_registry.py` | 12a | Encrypted-at-rest `(room_id, matrix_user_id) → card_hash` + watch-set store, survives restart |
| `attestation.py` | 12 | Join-attestation verification + `deriveMatrixUserId`/`verifyMatrixUserIdBinding` (Python mirror of Step 13) |

## Checklist (per implementation plan's Phase 3 Milestone Review)

- **Deny-by-default coverage (`matrix_room_membership.md §4`, `matrix_join_attestation_and_revocation.md §3.3`):** all rows covered. One real gap was found and fixed during this review, not before: `evaluate_room_predicate` calls in both hooks were unguarded — an evaluator exception would have propagated out of a Synapse callback with undefined allow/deny consequences, violating the explicit "predicate evaluation itself throws → deny" row. Fixed via `PolicyModule._safe_evaluate_predicate`, now covered by `test_module.py::test_{join,post}_denied_when_predicate_evaluator_throws`.
- **`chain_context.py` integration:** confirmed — uses the verifier package's `return_chain`/`conditions` as shipped, no from-scratch chain walk. Documents (and tests, via `test_chain_context.py`) the real limitation that `verify_card()` can never populate `chain` (no pubkey for a bare address) — the watcher's per-address revocation re-checks rely on this being fine, since chain topology was already captured once at join time.
- **`predicates.py` scope:** confirmed thin — no `all_of`/`none_of`/`is_holder`/`is_issuer`/`chain_depth_at_most`/`code_equals`/`chain_includes`. Exactly the `any_of`-over-`policies` loop `matrix_room.md`'s fixed schema calls for.
- **Force-part immediacy, 8xx and 9xx:** `test_watcher.py::test_force_part_identical_for_8xx_and_9xx` (parametrized over both) confirms no code-range branching — matches the 2026-07-12 confirmation (this session) that force-part-on-every-revocation is still the intended behavior, and that `watcher_backstop_interval_seconds=3600` is the accepted default.
- **`check_event_for_spam`, not `check_event_allowed`:** confirmed present in `module.py`; `check_event_allowed` does not appear anywhere in `src/`.

## Open items carried forward (down to one — flagged rather than guessed)

1. ~~**Join-attestation wire transport**~~ — **Resolved 2026-07-12**, same day as this review. See the amendment at the top of this document.
2. **Room policy state read** — the exact Synapse `ModuleApi` call for reading a room's current `m.card.policy` state event content hasn't been confirmed against current Synapse docs (unlike `check_event_for_spam` vs. `check_event_allowed`, which was confirmed). Injected as `RoomPolicyResolver.get_policy_id(room_id)` so the authorization logic stays fully tested independent of the answer. **A real gap noted while resolving item 1, not yet fixed:** `_resolve_policy_id` currently can't distinguish "room genuinely has no `m.card.policy`" (should pass through) from "state read failed" (should deny, per `matrix_room_membership.md §4`'s deny-by-default table) — both collapse to `None` today. Flagged inline in `module.py`; revisit once `RoomPolicyResolver` has a real Synapse-backed implementation.
3. ~~**Synapse Admin API force-part endpoint**~~ — **Resolved 2026-07-12**, same day as this review, second amendment above. `watcher.py`'s `HttpSynapseAdminClient` placeholder is gone; force-part is `ModuleApiForcePartClient` calling `ModuleApi.update_room_membership` in-process.

The one remaining item doesn't block Phase 3's own correctness — it's isolated behind an interface (`RoomPolicyResolver`) with its own tests, and a real implementation can be substituted without touching the verified logic around it. Should be resolved before Phase 4's Application Service work wires a real implementation of it.

## Separately: verifier package TODO filed, not fixed

While reviewing `predicates.py`'s use of `evaluate_policy_match`, a real ambiguity in the verifier package's own API was noted (not a `matrix-policy-module` bug): its `bool` return conflates "no card in the chain matches this `policy_id` at all" with "a card matches the `policy_id` but fails `field_match`" — two different failure reasons, currently indistinguishable to any caller. Logged as `plans/membership_card_verifier_todo.md` item 1 rather than fixed now — no current caller needs the distinction, and refactoring an already-shipped, tested package's return shape for a distinction nothing currently consumes isn't worth doing pre-emptively.

## Test coverage: 74 passed, 0 failed, 0 skipped
