# Wallet Service Object Spec — Strategic Plan

**Date:** 2026-07-04
**Status:** Draft
**Companion document:** [spec-implementation-plan.md](./spec-implementation-plan.md)
**Distinct from:** `strategic-plan.md` / `implementation-plan.md` in this same directory, which planned and tracked *building* the wallet service. This plan is about *documenting* the service that build produced — a specs-as-built exercise, not new feature work.

---

## What This Initiative Is

The wallet service has been built (Phases 1-6 of `implementation-plan.md`, all complete; production launch blocked only on CP-3's independent security review). Every other major protocol component with running code has a corresponding object spec in `specs/object_specs/` — `press.md`, `relay.md`, `card_verifier.md`, `registry_contract.md` — except the wallet service. There is no `specs/object_specs/wallet.md`. Anyone trying to understand the wallet service's actual API surface, data model, and behavior today has to read the implementation plan (a build log, not a reference) or the source directly.

This initiative writes that missing object spec from the code as it actually exists, cross-checks it against the process specs the wallet service implements (`wallet_backup_and_recovery.md`, `message_routing.md`, `notification_relay.md`) and the specs that reference it (`ARCHITECTURE.md`, `card_protocol_spec.md`, `messaging_protocol.md`, `protocol-objects.md`, `open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `card_migration.md`, `card_offering_and_acceptance.md`, `card_updates.md`, `open_offer_creation.md`, `oblivious_transport.md`, and the other object specs that describe wallet-service interactions), and corrects whatever discrepancies that cross-check surfaces — in the object spec itself and, per your scope decision, in the process specs and other referencing documents wherever the code has moved on without them.

---

## Goals

### 1. Produce an authoritative, code-accurate wallet service object spec

`specs/object_specs/wallet.md` should describe the wallet service the way `relay.md` describes the relay: actors, endpoints (request/response shapes as actually implemented), data model, privacy properties, and error codes. Every claim in it should be traceable to a specific file in `wallet-service/server/` or `wallet-service/src/`, not to the implementation plan's original intent.

### 2. Close the drift between plan-era design and shipped code

The implementation plan itself documents several places where the built system diverged from its own original steps: UMBRAL re-encryption was removed entirely in favor of sender-side per-sub-card encryption (Phase 4), the UUID-registration rate limit was dropped (Phase 6), admin endpoints were added that no phase step specified (Step 6.2a), and `PUT /accounts/{card_hash}/keyring`'s `service_secret`-rotation behavior was corrected post-hoc (commit `40165c8d`). A reader going only from the process specs or the strategic/implementation plan would get some of this wrong. The object spec is the place this gets reconciled once, in one document.

### 3. Verify and correct cross-references, not just author new content

Because the wallet service touches so many other specs — it's the primary service, the backup service, the message router's terminus, and the counterparty for two open-offer-acceptance flows — writing its spec is also the first complete check of whether those other documents still describe the wallet service accurately. Several were last substantively touched before Phase 4's architecture change (removal of UMBRAL re-encryption) and Phase 6's additions (admin endpoints, rate-limit removal); they may still describe the old design.

### 4. Leave a durable, low-maintenance reference

Once written, `wallet.md` should be maintainable the way `relay.md` is: versioned, with an amendment history, and structured so that a future code change to the wallet service has an obvious place to update. This is not a one-time snapshot to be abandoned the moment the code changes again.

---

## Rationale

### Why now, and why from the code rather than the plans

The implementation plan is 650+ lines of build narrative — phase-by-phase steps, resolved open questions, mid-phase revisions, and milestone reviews. It is an excellent record of *how* the service came to be, but a poor reference for *what it currently does*, because superseded design decisions (UMBRAL re-encryption, the UUID rate limit, the original CP-1 registration-token assumption) are preserved in place, struck through in prose, rather than removed. A spec written by re-reading the plan risks resurrecting dead design. A spec written from `wallet-service/server/routes/` and the DB schema as it exists today cannot make that mistake — it can only describe what actually runs. The plans and process specs are consulted for intent and terminology, but the code is the source of truth for behavior.

### Why the cross-spec check is part of this, not a separate effort

Object specs in this codebase (`relay.md` is the clearest example, with its "Amends" changelog tracking exactly this) are written to be internally consistent with the process specs they implement and the specs that reference them. The wallet service sits at the intersection of more of these than any other component: it's named in `wallet_backup_and_recovery.md`, `message_routing.md`, `notification_relay.md`, `open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `card_migration.md`, and `ARCHITECTURE.md`'s ADR-009-AMEND, among others. If those documents describe wallet-service behavior that Phase 4 or Phase 6 changed, publishing a correct `wallet.md` next to still-stale references elsewhere just relocates the inconsistency instead of resolving it. You've scoped this plan to fix those documents directly, not just flag them, so the two are one initiative.

### Why discrepancies get raised, not silently fixed

Some corrections are unambiguous (e.g., a process spec describing a UMBRAL re-encryption key format that no longer exists in the schema — Phase 4 already documents this removal). Others may involve a judgment call about which document is actually wrong — the code, the process spec, or an assumption baked into a downstream spec like `open_offer_acceptance_existing_wallet.md`. The implementation plan surfaces this pattern must be handled by checking in when the "obviously fix it" test fails, rather than the object-spec author guessing.

---

## Key Objectives

### Goal 1: Authoritative object spec

- `specs/object_specs/wallet.md` exists, follows the structural convention of `relay.md` (Overview, Relationship to Existing Specs, Actors, Privacy Properties, Data Model, Endpoints, Error Codes, Open Questions), and covers every route file under `wallet-service/server/routes/`.
- Every endpoint's request/response shape in the spec matches the corresponding Zod/type validation (or equivalent) in the route handler, not the implementation plan's original sketch.
- The data model section matches the current migration state in `wallet-service/server/db/migrations/`, including tables added or dropped after Phase 1 (e.g., the dropped `reencryption_keys` table).

### Goal 2: Drift closed

- A written list exists (in the implementation plan for this initiative, not just in this author's head) of every place the shipped code diverged from the original process specs or plan, with the resolution recorded: UMBRAL removal, UUID rate-limit removal, admin endpoints, the `PUT /keyring` fix.
- Each divergence is reflected consistently across `wallet.md` and any process spec that described the old behavior.

### Goal 3: Cross-references verified and corrected

- Every spec in the "grep for 'wallet service'" list (see Related Specs below) has been read against the current wallet-service code and either confirmed accurate or corrected.
- Corrections are made directly in those documents (per your scope decision), with a version bump and changelog note in each file that changes, following the `relay.md` "Amends" convention.
- A summary of what changed in each file, and why, is recorded in a findings/discrepancies log for this initiative (not lost in individual diffs).

### Goal 4: Durable reference

- `wallet.md` carries a version number and status line matching the convention in `relay.md` and `press.md`.
- The document's "Relationship to Existing Specs" section lists every process spec it implements and every object spec it interacts with, so a future reader (or agent) knows what else to check when either side changes.

---

## Open Questions

**OQ-WS-SPEC-1: Resolving genuine conflicts between code and process spec**

Most expected discrepancies are cases where the process spec describes an old design the code has moved past (UMBRAL, the rate limit) — these resolve in the code's favor by construction, since the goal is a code-accurate spec. But if the review finds a case where the code appears to violate a *security or privacy invariant* the process spec establishes (e.g., something that looks like it could leak a device-to-card correlation), that is not a documentation call — implementation may need to change, not just the spec. The implementation plan below should stop and flag this to you rather than document the invariant violation as if it were the new intended behavior.

**OQ-WS-SPEC-2: Depth of the "other object specs" cross-check**

`registry_contract.md`, `card_verifier.md`, and `press.md` all mention "wallet service" in some capacity per the earlier grep. Should this initiative verify and correct all of them with the same rigor as the process specs, or only the ones where the wallet service is a primary actor (`relay.md`, and the process specs)? Recommend: full read-and-verify for all files the grep found, but budget less time for files where the wallet service is mentioned only in passing (e.g., a single cross-reference line) versus files that describe wallet-service behavior in detail.

**OQ-WS-SPEC-3: What "corrected" means for `card_protocol_spec.md` and `ARCHITECTURE.md`**

These are higher-level, protocol-wide documents rather than wallet-specific ones. A correction here is riskier — it affects how every other component's spec describes its relationship to the wallet service. Recommend treating these two as read-and-flag-only in the first pass (Objective 3's "confirmed accurate or corrected" applies, but any correction to these two specifically gets a checkpoint before being made, rather than being made inline like a process-spec fix).

---

## Related Specs

**Primary specs this initiative implements/documents:**
- `wallet-service/` (all source — the ground truth)
- `plans/wallet-service/strategic-plan.md`, `plans/wallet-service/implementation-plan.md`, and its six milestone summaries — build history and design rationale, consulted but not treated as authoritative over the code
- `specs/object_specs/relay.md` — structural template for the new object spec, and the wallet service's primary counterparty (message delivery)

**Specs to verify and correct (from grep "wallet service" across `specs/`):**
- `specs/process_specs/wallet_backup_and_recovery.md`
- `specs/process_specs/message_routing.md`
- `specs/process_specs/notification_relay.md`
- `specs/process_specs/open_offer_acceptance_new_wallet.md`
- `specs/process_specs/open_offer_acceptance_existing_wallet.md`
- `specs/process_specs/open_offer_creation.md`
- `specs/process_specs/card_migration.md`
- `specs/process_specs/card_offering_and_acceptance.md`
- `specs/process_specs/card_updates.md`
- `specs/process_specs/oblivious_transport.md`
- `specs/object_specs/relay_data_model.md`
- `specs/object_specs/registry_contract.md`
- `specs/object_specs/card_verifier.md`
- `specs/object_specs/press.md`
- `specs/messaging_protocol.md`
- `specs/ARCHITECTURE.md` (flag-first, per OQ-WS-SPEC-3)
- `specs/card_protocol_spec.md` (flag-first, per OQ-WS-SPEC-3)
- `specs/protocol-objects.md`
