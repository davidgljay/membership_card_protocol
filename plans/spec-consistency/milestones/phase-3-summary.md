# Phase 3 Milestone Summary — Object Spec ↔ Codebase Alignment

**Date:** 2026-07-16
**Status:** Complete

## What happened

All 11 code-alignment units ran through Step A (spec-vs-code diff against each object spec's actual implementation directory) in parallel, after confirming the Matrix policy module's code path (`wallet-service/matrix-policy-module/`) at kickoff. This phase surfaced qualitatively different findings than Phases 1–2: rather than spec-vs-spec documentation drift, several were **live security bugs in running code**, discovered by close code reading rather than just cross-referencing prose.

Step B consolidated 11 files into three tiers: 19 routine spec-vs-code syncs, 9 known "spec is ahead of code" backlog items (mostly the same-day `LogEntry` redesign not yet implemented), and 12 items escalated for direct decision rather than folded into a routine fix list — per the plan's rule that code-vs-spec conflicts on security-relevant or load-bearing points must go to David directly, not be auto-resolved.

All 12 escalations were resolved directly with David, several requiring actual code fixes (not just documentation), each verified by running the affected test suites:

- **On-chain write-gate doesn't bind signed payload fields to calldata** — confirmed as a real gap; documented in `registry_contract.md` as a known issue pending a proper fix (a full field-binding authorization check), not fixed in this pass.
- **`DeregisterPolicy` shipped despite unresolved governance question (OQ-20)** — resolved by confirming the capability as intended; OQ-20 marked resolved in the spec, the code's doc comment updated to match.
- **Verifier Stage 2 missing a `return` after an app-signature failure** — a real bug allowing a sub-card with an invalid `app_signature` to still pass verification. Fixed in both TypeScript and Python ports, with new regression tests; both suites green.
- **`app-sdk`'s inbound message handler only checks raw signature validity** — confirmed as intentional design (a card the verifier flags as untrusted/revoked may still be displayed, with the full verification result attached so the host app can warn the user) rather than a bug; `app_sdk.md` clarified to state this precisely.
- **Matrix revocation watcher built but never started** — confirmed real; a TODO was filed at the exact wiring site in code (construction/start of the `Watcher`, plus startup `reconcile()`), and the spec/docker-compose corrected to stop implying it already runs.
- **Verifier's `getLogEntries` modeled a fictional on-chain-enumerable log** — a substantial architecture fix: replaced with event-log replay (`getCardEventLog`, reconstructing the ground-truth CID/timestamp sequence from `CardRegistered`/`CardHeadUpdated` events) cross-checked against the IPFS-reported `history` array. Fixed in both language ports plus the `verifier-rpc-provider` companion package; all suites green.
- **Sub-card revocation authority (app/sub-card self-revoke)** — resolved in favor of an additional authorization path (alongside the existing master-key path, for both compromise and benign scenarios). This changed `registry_contract.md`'s `DeregisterSubCard` on-chain authorization model and `press.md`'s verification logic.
- **Matrix join-authorization callback silently differs from spec** — `matrix_synapse_module.md` corrected to describe `check_event_allowed` (not `check_event_for_spam`) as the real join gate, matching a live-testing discovery already reflected in shipped code.
- **Undocumented but load-bearing `m.room.join_rules` state event** — documented in `matrix_room.md`/`wallet.md`; code was already correct and tested.
- **Two actively-developed client packages for Matrix code** (`client-sdk/` vs. `app-sdk`/`wallet-sdk`) — `client-sdk/` marked deprecated in its README, with an explicit warning that it still holds the only working Matrix implementation pending a port, so it isn't accidentally deleted or left unmaintained.
- **Migration signing scope** — narrowed to master-card-key-only, correcting a Phase 2 spec addition that had allowed a sub-card-chain path the code never implemented.
- **`appCertificationRoot` unconditionally required** — relaxed to match the spec's conditional design, with new code added to hard-reject (not silently skip) if a sub-card signature is actually encountered on an unconfigured instance. Both language ports updated and tested.

With escalations resolved, the 19 Tier 1 routine fixes were implemented directly (not delegated) across the registry contract (Rust), the verifier package (TypeScript and Python), `wallet.md`, `relay.md`/`relay_data_model.md`, `press.md`, `wallet-sdk`'s `setupWallet.ts` (a real ordering bug, fixed and verified against the existing test suite), and two `app-sdk` doc-comment corrections. The 9 Tier 2 items remain a logged backlog — they're expected implementation lag behind same-day spec changes, not treated as bugs.

## What's carried forward

- The on-chain write-gate's field-binding gap (`registry_contract.md §6.1`) is documented but not fixed — flagged for dedicated remediation work outside this initiative's scope.
- The Matrix revocation watcher's production wiring has a TODO filed but is not yet implemented — blocked on confirming the chain-event subscription interface is ready for production use.
- A repo-wide `getLogEntries`→`getCardEventLog` mock/reference update across `app-sdk`, `wallet-sdk`, `client-sdk`, `press`, and `wallet-service` test suites was flagged as a background task by the agent that completed the verifier-side fix — out of scope for this initiative, tracked separately.
- `client-sdk/`'s Matrix code still needs an actual decision and port to `app-sdk`/`wallet-sdk` (or a decision to keep it as the canonical home) — marked deprecated with a warning in the interim, not yet resolved.
- Tier 2's 9 items (the `LogEntry` redesign not yet implemented in `press.md`'s `appendLogEntry`, the verifier's `capabilities`/`valid_until`/`attestation_level` checks, DNS-admin secp256r1 press-side pre-checks, Stage 7/`verifierCardAddress`, `app_sdk.md §9.7` room discovery) remain a logged implementation backlog.

## Initiative status

All three phases of the spec-consistency initiative are now complete: Phase 1 (11 object specs), Phase 2 (15 process specs), Phase 3 (11 code-alignment units), plus the mid-initiative `LogEntry` full-repost design change. Every fix traces back to a logged finding and, where a decision was required, an explicit resolution recorded in the corresponding consolidated-fixes file.
