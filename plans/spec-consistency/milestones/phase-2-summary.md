# Phase 2 Milestone Summary — Process Spec Consistency

**Date:** 2026-07-16
**Status:** Complete

## What happened

All 15 process-spec units ran through Step A (independent read-only review against the 11 Phase-1-fixed object specs and the other 14 process specs). This surfaced 67 distinct findings post-dedup (62 routine + 5 needing David's direct decision) — again well over the plan's ~15-finding pause threshold, following the same pattern as Phase 1. Per the Phase 1 precedent, the volume was presented in full rather than blocked on.

Five items were resolved directly with David before any fix landed:

1. **Sub-card verification gap**: neither `card_validation.md` nor `card_verifier.md` checked a sub-card's `capabilities`, `valid_until`, or `attestation_level` at verification time, despite `protocol-objects.md §16` requiring all three. Resolved as a real gap — new checks (with error codes `CAPABILITY_NOT_GRANTED`, `SUBCARD_EXPIRED`, `ATTESTATION_LEVEL_INSUFFICIENT`) added to both specs.
2. **Sub-card revocation authority**: resolved in favor of allowing app/sub-card self-revocation as an *additional* authorization path alongside the master-key path (not replacing it), for both suspected-compromise (810) and benign (811) scenarios. This changed `registry_contract.md §4.4`'s `DeregisterSubCard` authorization model and `press.md §5.4`'s verification logic — an actual contract-level change, not just documentation.
3. **Policy self-issuance bypass**: resolved as a documentation error — no self-issuance path exists; every policy card goes through a press. `policy_creation.md` was corrected and gained a new subsection describing the one-time `RegisterPolicy` governance-quorum bootstrap step it had never mentioned.
4. **Sub-card policy-attachment gap**: resolved in favor of rewriting `subcard_creation_policy.md` (retitled "Sub-Card Governance") to describe what actually governs sub-cards — the app-certification chain, `capabilities`/`limitations` fixed at issuance, and `DeregisterSubCard`-based revocation — rather than a non-existent policy-card-enforcement model.
5. **Push-token-rotation credential handling**: a lower-ambiguity item, resolved by applying the already-correct object-spec behavior (`relay.md`/`relay_data_model.md`: replenishment preserves the credential) to `notification_relay.md`, which had described credential reissuance.

With those five resolved, the full batch of 62 routine fixes plus the 5 decision-driven fixes was implemented across roughly 25 files, including a full rewrite of `log_auditing.md` (the audit-epoch/AEK model removal from Phase 1 had never propagated to it, `card_offering_and_acceptance.md`, `card_protocol_spec.md`, `policy_creation.md`, or `ARCHITECTURE.md` — all five caught up in one coordinated pass).

As in Phase 1, several Step C sub-agents hit the session usage limit mid-task; spot-checking after resumption found nearly all assigned fixes had already landed. The few incomplete items (the `attestation_level` check in `card_validation.md`, and changelog notes in `card_validation.md`/`card_protocol_spec.md`) were completed directly.

## What's carried forward

- `specs/subcards.md` — the actual sub-card creation/acceptance flow lives in this root-level file, which fell outside both Phase 1's and Phase 2's formal in-scope lists. It received a scope note flagging this and a couple of targeted updates (DNS-admin secp256r1 mention) as part of the sub-card policy rewrite, but has not had a full Step A/B/C pass. Recommended for a supplemental review.
- `specs/messaging_protocol.md` — flagged by `proc-card-creation`'s review as a first-class dependency of the card-creation cluster that was never formally in scope either.
- Open architecture question, not resolved: where an `OpenCardOffer` claim link is hosted (wallet service, press, or a new component) — both `open_offer_creation.md` and `open_offer_acceptance_new_wallet.md` now cross-reference `wallet.md`'s existing `OQ-WALLET-6` rather than guessing.
- `app_sdk.md §4.7`'s relay file-path citations still need the same `relay/src/...` correction applied to `oblivious_transport.md` in this phase (noted but out of scope for the agent that made that fix).

All fixes trace back to `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`'s numbered list; no fix was made outside that approved list.

## Proceeding to Phase 3

Per the standing instruction to continue through all phases absent unexpected issues, Phase 3 (object spec ↔ codebase alignment, 11 units) begins next. Per the implementation plan, the Matrix policy module's actual code path should be confirmed before any `code-matrix-*` unit runs — this will be checked at Phase 3 kickoff.
