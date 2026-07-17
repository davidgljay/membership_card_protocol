# Spec Consistency Verification — Strategic Plan

## Goals

1. **Every core protocol component has one authoritative object spec, and every spec agrees with the others it touches.** Contradictions between specs (data formats, field names, lifecycle states, ownership boundaries) are the main source of divergent implementations across teams working on different components.
2. **Every cross-component process is fully and consistently specified end-to-end.** Process specs (e.g. card creation, subcard revocation, DNS routing) span multiple object specs; if the object specs they reference drift, the process spec silently goes stale.
3. **The specs accurately describe the code that currently exists.** Several specs already carry "describes code as implemented" status notes (`relay.md`, `wallet.md`), which means spec/code drift is an active, not hypothetical, risk.
4. **A repeatable, low-effort process exists for catching this drift going forward**, not just a one-time cleanup.

## Rationale

The protocol spans smart contracts, IPFS-stored objects, a wallet service, a relay, a Matrix-based messaging layer, and three SDKs (verifier, app, wallet), each with its own spec authored at a different time (dates in `specs/object_specs/` range from 2026-06-16 to 2026-07-12). Several specs already show signs of drift: `client_sdk.md` is marked superseded and split into `app_sdk.md` / `wallet_sdk.md`; `relay.md` and `wallet.md` explicitly describe "as-implemented" behavior rather than a clean design. With this many independently-evolving documents, undetected inconsistency is the default state, not the exception — the discipline has to be systematic and repeatable, not a one-off read-through.

Doing object specs before process specs, and process specs before code, is intentional: process specs assume their referenced object specs are correct, and code review assumes the spec set is internally consistent. Checking in the wrong order means re-doing work every time an earlier layer turns out to be wrong.

## Key Objectives

- **Object specs:** Every object spec in scope (see list below) has been reviewed by a dedicated subagent against every other object/process spec that references it or that it references; all identified inconsistencies are logged with a recommended resolution in `plans/spec-consistency/inconsistencies/`; a reviewed, deduplicated fix list has been approved by David; all approved fixes have been implemented and the object-spec pass is marked complete.
- **Process specs:** Same bar as above, applied to every process spec in scope.
- **Code alignment:** Every object spec has been checked against the corresponding codebase endpoints/implementation (contracts, `wallet-service/`, `relay/`, `app-sdk/`, `wallet-sdk/`, `membership_card_verifier/`, Matrix policy module) for drift, with the same log → review → fix cycle.
- **No inconsistency is fixed silently** — every fix implemented in this initiative traces back to a logged inconsistency with a recommendation David (or the resolution-review agent) approved.

## Scope

**Object specs in scope** (from `specs/object_specs/`, `matrix_synapse_module.md` scope added per your follow-up on the Matrix service):

| # | Spec | File(s) |
|---|------|---------|
| 1 | Smart contracts | `registry_contract.md` |
| 2 | Cards stored on IPFS | **gap — see Open Questions** |
| 3 | Presses | `press.md` |
| 4 | Wallet services | `wallet.md` |
| 5 | Relay | `relay.md`, `relay_data_model.md` |
| 6 | Verifier SDK | `card_verifier.md` |
| 7 | App SDK | `app_sdk.md` |
| 8 | Wallet SDK | `wallet_sdk.md` |
| 9 | Matrix service (encryption) | `matrix_encryption.md` |
| 10 | Matrix service (room model) | `matrix_room.md` |
| 11 | Matrix service (Synapse policy module) | `matrix_synapse_module.md` |

`client_sdk.md` is explicitly superseded by `app_sdk.md`/`wallet_sdk.md` and is excluded from the active consistency pass (flagged for archival, not review).

**Process specs in scope** (from `specs/process_specs/`), mapped to your requested list plus Matrix processes:

| Requested process | File(s) found |
|---|---|
| Message routing | `message_routing.md` |
| Obfuscated communication (subcard holder ↔ wallet service via relay) | `oblivious_transport.md` |
| Card creation and acceptance | `card_offering_and_acceptance.md`, `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`, `card_signing.md` |
| Card updating and revocation | `card_updates.md` |
| Policy creation, updating and revocation | `policy_creation.md` |
| Card verification | `card_validation.md` |
| Subcard creation, acceptance and revocation | `subcard_creation_policy.md` |
| DNS route creation, updating, and removal | `dns_governance_verifier.md` |
| *(added)* Matrix service processes | `matrix_join_attestation_and_revocation.md`, `matrix_room_membership.md`, `room_discovery.md` |

Four additional process spec files exist in the repo that weren't named in your request: `card_migration.md`, `log_auditing.md`, `notification_relay.md`, `wallet_backup_and_recovery.md`. Flagged as an open question below rather than silently included or excluded.

**Code alignment scope** (Phase 3, after specs are internally consistent): `contracts/`, `wallet-service/`, `relay/`, `app-sdk/`, `wallet-sdk/`, `membership_card_verifier/`, and the Matrix policy module (`wallet-service/matrix-policy-module/` and/or a dedicated directory — to be confirmed at Phase 3 kickoff). `client-sdk-old/` and `relay_serverless_old/` are excluded as legacy.

## Decisions (resolved 2026-07-12)

1. **IPFS card object spec**: none exists today. A new `specs/object_specs/ipfs_card.md` will be drafted as the first step of Phase 1, before any consistency-checking subagents run, so the pass has something to check against.
2. **Unrequested process specs**: `card_migration.md`, `log_auditing.md`, `notification_relay.md`, and `wallet_backup_and_recovery.md` are **included** in Phase 2 scope, since they reference in-scope object specs.
3. **Pacing**: phases run as separate batches with a checkpoint between each — Phase 1 (object specs) runs to completion and is presented for review before Phase 2 (process specs) starts; same gate between Phase 2 and Phase 3 (code alignment).

## Design Changes Made Mid-Initiative

1. **2026-07-16 — `LogEntry` full-repost model.** David reviewed the drafted `ipfs_card.md` and requested a design change to reduce read-time latency: instead of each `LogEntry` carrying only its own field diff (requiring a verifier to walk `prev_log_root` backward through the entire log to reconstruct current state or provenance), each `LogEntry` now reposts the card's complete current field state (`card_state`) and carries a flat `history` array of every predecessor CID. Resolved sub-decisions: (a) `history` is validated, when strict assurance is needed, against the registry contract's existing `CardRegistered`/`CardHeadUpdated` events — no new on-chain storage added; (b) `card_state` carries the full merged current state, not just this entry's own history-list addition. Applied to `protocol-objects.md §3` (authoritative), `object_specs/ipfs_card.md §5`, and `object_specs/press.md §5.3` (`appendLogEntry`). Flagged as a Phase 3 code-alignment item: the verifier package's `RpcProvider.getLogEntries()` (`press.md` OQ-B3) currently implements the old backward-walk and needs to change to read `history` directly.

## Remaining Open Questions

1. ~~**Should `client_sdk.md` be deleted or kept as an archived/marked-superseded reference?**~~ **Resolved 2026-07-16:** kept, archived. It already carries a `SUPERSEDED` banner pointing to `app_sdk.md`/`wallet_sdk.md`; it remains excluded from the active consistency pass.
2. **Matrix policy module code location** — `wallet-service/matrix-policy-module/` appears to be the implementation directory; confirm this (vs. some other path) is what Phase 3 should check `matrix_synapse_module.md` against.
