# Phase 1 Milestone Summary — Object Spec Consistency

**Date:** 2026-07-16
**Status:** Complete

## What happened

Phase 0 drafted the missing `specs/object_specs/ipfs_card.md` and resolved the `client_sdk.md` archival question (kept, archived). During drafting, David requested a design change to the `LogEntry` object: instead of each post-genesis update carrying only its own field diff (requiring a verifier to walk `prev_log_root` backward through the entire log to reconstruct current state or provenance), each `LogEntry` now reposts the card's complete current field state (`card_state`) and carries a flat `history` array of every predecessor CID. History is validated, when strict assurance is needed, against the registry contract's existing `CardRegistered`/`CardHeadUpdated` events — no new on-chain storage was added. This was applied to `protocol-objects.md §3` (authoritative), `object_specs/ipfs_card.md §5`, and `object_specs/press.md §5.3`.

Phase 1 then ran all 11 object-spec units through Step A (independent read-only review against every other in-scope spec) in parallel. This surfaced **~38 distinct findings after deduplication** — more than double the plan's ~15-finding pause threshold — triggering the plan's own safety valve. Rather than mechanically pushing a fix list through, the volume and two genuinely substantive items were surfaced to David directly:

- **App-certification chain re-walk**: resolved in favor of runtime re-verification (Position 2) — `card_verifier.md` gained a `VerifierConfig.appCertificationRoot` field, an `APP_CARD_CHAIN_NOT_TRUSTED` error code, and a new Stage 2 pipeline check; `card_validation.md` step 12 was rewritten to match. This closes a real defense-in-depth gap against a compromised press.
- **Transport privacy for wallet UUID registration**: resolved in favor of the oblivious-relay transport alone being sufficient (no additional Tor requirement) — `notification_relay.md` and `oblivious_transport.md` were both updated consistently so the resolution doesn't quietly relocate the contradiction.

With those two resolved, the full batch of 37 routine fixes plus the 2 decision-driven fixes (39 total) was approved and implemented across 15 files: `protocol-objects.md`, `registry_contract.md`, `ipfs_card.md`, `open_offer_creation.md`, `card_verifier.md`, `card_validation.md`, `press.md`, `wallet.md`, `wallet_sdk.md`, `notification_relay.md`, `oblivious_transport.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`, `matrix_room_membership.md`. Most fixes were one-directional syncs — an object spec having already been corrected while a dependent spec didn't track the correction — rather than live disagreements between the 11 Phase 1 units themselves.

A handful of Step C sub-agents hit a session usage limit mid-task; on resumption, spot-checking confirmed nearly all of their assigned fixes had already landed before the interruption. The one incomplete item (`oblivious_transport.md`'s stale "four-party system" naming) and all missing per-file changelog notes were completed directly.

## What's carried forward

Two items were explicitly flagged as out of Phase 1's scope and deferred rather than fixed now:
- The audit-epoch/AEK model still described in `log_auditing.md` and parts of `card_offering_and_acceptance.md` (process specs, Phase 2 scope) needs rewriting to match `press.md`'s already-corrected direct-auditor-messaging model.
- `dns_governance_verifier.md` (Phase 2 scope) should be cross-checked for the same DNS-admin secp256r1 gap that was just fixed in `press.md`.
- A minor open item: `registry_contract.md §5` still has no `GetProtocolVersion()` read-operation entry, noted in `press.md`'s Dependencies section for whoever picks it up.

All fixes trace back to `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`'s numbered list; no fix was made outside that approved list.

## Proceeding to Phase 2

Per the standing instruction to continue through all phases absent unexpected issues, and with the one issue that did arise (finding-count threshold, plus the two decision items) now resolved, Phase 2 (process-spec consistency, 15 units) begins next.
