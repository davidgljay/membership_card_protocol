# Phase 1 Milestone Review — Spec Division

**Date:** 2026-07-07
**Status:** Complete

`specs/object_specs/client_sdk.md` has been split into `specs/object_specs/app_sdk.md` and `specs/object_specs/wallet_sdk.md`, with `client_sdk.md` marked superseded via a status banner (unchanged otherwise). Every §-numbered capability in the original spec was checked off against exactly one location in exactly one new spec; three defects surfaced during review and were corrected in place before closing this phase: (1) the offer-countersign module (`offers/countersign.ts`, the "persist before sign" keypair helper for offer acceptance) had been placed in App SDK, contradicting the strategic and implementation plans' explicit assignment to Wallet SDK — moved to `wallet_sdk.md` §7.1, with App SDK's former §9 removed and subsequent sections renumbered; (2) the `active_subcards` code-510/511 posting gap (writing the directory on sub-card registration/deregistration, distinct from the read-only `resolveActiveSubCardTargets` helper) was missing entirely — added as `wallet_sdk.md` §6.6, cross-referenced against the existing read-side helper at §8.1; (3) sub-card press-registration submission (`subcards/pressSubmission.ts`'s `submitSubCardRegistration`/`createPressSubCardRegistrar`) was referenced from `wallet_sdk.md` in two places but never actually documented — added as `app_sdk.md` §7.3, with both dangling wallet-side references corrected to point at it. After these fixes, the `deviceSubCard` collapse is described consistently and only as its target shape (a thin Wallet SDK wrapper over App SDK's `requestSubCard`/`countersignSubCardRequest`) with no reappearance of the old self-signing implementation as current behavior anywhere, shared provider interfaces and functions are named identically across both specs, and no capability ownership remains ambiguous — clear to proceed to Phase 2 (codebase division).

## Capability Traceability Checklist

| Original §-section | Capability | New spec location |
|---|---|---|
| §1 | Overview | Both (adapted per scope) |
| §2 | Design Principles | Both (adapted per scope) |
| §3 | Package Structure | Both (adapted per scope) |
| §4.1–4.7 | Provider Interfaces (all 7) | `app_sdk.md` §4 (definitions); `wallet_sdk.md` §4 (inherited reference) |
| §5 | Crypto/Canonicalization Core | `app_sdk.md` §5 |
| §6 | Verifier Integration | `app_sdk.md` §6 |
| §7.1–7.3, 7.5–7.7 | Wallet setup, KDF, keyring, backup, recovery, post-recovery deregistration | `wallet_sdk.md` §5.1–5.3, 5.5–5.7 |
| §7.4 | Device Sub-Card (old self-signing shape) | `wallet_sdk.md` §5.4, rewritten as target (collapsed) shape only |
| §8.1 | Offer Construction | `app_sdk.md` §8.1 |
| §8.2 | Offer Verification (review) | `app_sdk.md` §8.2 |
| §8.3 | Countersigning (offer acceptance) | `wallet_sdk.md` §7.1 |
| §8.4 | New-Wallet Open-Offer Acceptance | `wallet_sdk.md` §7.2 |
| §8.5 | Existing-Wallet Open-Offer Acceptance | `wallet_sdk.md` §7.3 |
| §8.6 (recipient half) | Targeted Offer Acceptance | `wallet_sdk.md` §7.4 |
| §8.6 (offerer half) | Press Finalization (`forwardCountersignedTargetedOffer`) | `app_sdk.md` §8.3 |
| §9.1 | Requester-Side Sub-Card Request | `app_sdk.md` §7.1 |
| §9.2 | Wallet-Side Validation | `wallet_sdk.md` §6.1 |
| §9.3 | Consent Assembly + Countersigning | `wallet_sdk.md` §6.2, §6.3 |
| §9.4 (registration half) | Press Submission (`submitSubCardRegistration`) | `app_sdk.md` §7.3 |
| §9.4 (revocation half) | Sub-Card Revocation (8xx) | `wallet_sdk.md` §6.4 |
| §9.4 (gap) | `active_subcards` 510/511 posting | `wallet_sdk.md` §6.6 (Planned) |
| §9.5 | Sub-Card Deregistration | `wallet_sdk.md` §6.5 |
| §10.1–10.6 | Messaging, fan-out, UUID lifecycle, replenishment, realtime delivery | `app_sdk.md` §9.1–9.6 |
| §10.1 (gap) | `resolveActiveSubCardTargets` (read side) | `wallet_sdk.md` §8.1 (Planned) |
| §11 | Cross-Platform Hardening (Planned) | Both (scoped per package) |
| §12 | Security Invariants | Both (scoped per package) |
| §13 | Result/Error Conventions | Both (identical convention, restated) |
| §14 | Implementation Status | Both (split by ownership) |
| §15 | Dependencies | Both (split by ownership) |
| §16 | Resolved Design Decisions | Both, plus new Split-SDK-2/3/4 decisions |
| Related Specs | — | Both, cross-linked to each other |

New capability introduced by the split itself: "sign arbitrary data with a sub-card" (`app_sdk.md` §7.2, Planned) — not present in the original spec, per the strategic plan.

## Clarification Checkpoint

No capability surfaced that failed to fit cleanly into one package or the other. All three defects found during review were misattribution/omission errors in the initial draft, not genuine ownership ambiguities — each had an unambiguous answer once checked against `plans/sdk-split-strategic-plan.md`'s capability table and `plans/sdk-split-implementation-plan.md`'s salvage lists. No check-in needed before proceeding to Phase 2.
