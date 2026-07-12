Linked strategic plan: [strategic-plan.md](./strategic-plan.md)

# Spec Consistency Verification — Implementation Plan

## How each spec-consistency unit works (applies to every unit in Phases 1–3)

Every "unit" below (one spec, or one tightly-coupled cluster of spec files) goes through the same three-step cycle. This pattern is defined once here and referenced by ID from the phase tables so the tables stay readable.

**Step A — Review subagent (`general-purpose`, read-only).**
What: Spawned with the unit's file(s) plus a full list of all other in-scope object and process specs. The agent reads the unit, then reads every other spec that either (a) the unit references (by name, field, or behavior) or (b) references the unit back, and checks for contradictions: mismatched field/type names, conflicting lifecycle states, conflicting ownership/authority claims, conflicting error/status codes, stale references to superseded specs (`client_sdk.md`), or one-sided claims (spec A says it calls spec B's endpoint but spec B doesn't define it).
Who: Claude (spawns the subagent).
Context needed: the unit's file(s); `plans/spec-consistency/strategic-plan.md` §Scope for the full spec list; write access limited to `plans/spec-consistency/inconsistencies/<unit-id>.md`.
Done when: `plans/spec-consistency/inconsistencies/<unit-id>.md` exists, listing each inconsistency found (or explicitly stating none found) with: the two conflicting specs and sections, a description of the conflict, and a recommended resolution.

**Step B — Resolution review (`general-purpose`, one agent per phase, not per unit).**
What: After all units in a phase have completed Step A, one agent reads every file in `plans/spec-consistency/inconsistencies/` produced by that phase, deduplicates overlapping findings (the same conflict is often logged from both sides), checks recommended resolutions for soundness, and produces a single consolidated fix list.
Who: Claude (spawns the subagent) → then Claude presents the list to David.
Context needed: all `plans/spec-consistency/inconsistencies/*.md` files from the current phase.
Done when: `plans/spec-consistency/inconsistencies/phase-N-consolidated-fixes.md` exists with a numbered fix list, each entry naming the file(s) to change and the specific change; **David has reviewed and approved the list (see Clarification Checkpoints)**.

**Step C — Fix implementation (`general-purpose`, one agent per spec file needing changes).**
What: Implements only the approved fixes touching that file. Does not re-open judgment calls already made in Step B.
Who: Claude (spawns the subagent).
Context needed: the specific fix-list entries for that file, from `phase-N-consolidated-fixes.md`; the file itself.
Done when: the file reflects the approved fix; a one-line changelog note is appended noting the fix and linking back to the consolidated fix list entry number.

---

## Phase 0: Setup

- **What:** Create `plans/spec-consistency/inconsistencies/`. Draft the new `specs/object_specs/ipfs_card.md` (per the resolved decision in the strategic plan) covering: card JSON/CBOR structure, required and optional fields, the IPFS content-addressing/pinning scheme, the relationship between a card and its on-chain anchor in `registry_contract.md`, and card versioning. Base it on what `press.md` and `registry_contract.md` already assume about card structure so it doesn't invent a conflicting shape.
  Who: Claude (research the existing specs directly, then draft — no subagent needed for this step).
  Context needed: `specs/object_specs/press.md`, `specs/object_specs/registry_contract.md`, `specs/card_protocol_spec.md` (top-level overview).
  Done when: `specs/object_specs/ipfs_card.md` exists as a draft object spec in the same format as the others.
- **What:** Confirm the `client_sdk.md` archival decision (delete vs. mark superseded and keep) with David.
  Who: Claude ↔ David.
  Context needed: none.
  Done when: decision recorded back in `strategic-plan.md` §Decisions, and `client_sdk.md` handled accordingly.

**Phase 0 Milestone Review** — Done when: `ipfs_card.md` exists and doesn't contradict `press.md`/`registry_contract.md` on card structure (quick self-check, not a subagent), the `client_sdk.md` decision is recorded, and `inconsistencies/` exists. Proceed to Phase 1.

---

## Phase 1: Object Spec Consistency

11 units, each run through Steps A–C above.

| Unit ID | Spec file(s) |
|---|---|
| `obj-contracts` | `registry_contract.md` |
| `obj-card` | `specs/object_specs/ipfs_card.md` (drafted in Phase 0) |
| `obj-press` | `press.md` |
| `obj-wallet` | `wallet.md` |
| `obj-relay` | `relay.md` + `relay_data_model.md` |
| `obj-verifier-sdk` | `card_verifier.md` |
| `obj-app-sdk` | `app_sdk.md` |
| `obj-wallet-sdk` | `wallet_sdk.md` |
| `obj-matrix-encryption` | `matrix_encryption.md` |
| `obj-matrix-room` | `matrix_room.md` |
| `obj-matrix-synapse` | `matrix_synapse_module.md` |

**Step A** runs for all 11 units — can be parallelized (independent subagents, no shared write targets).
**Step B** runs once, phase-scoped: `phase-1-consolidated-fixes.md`.
**Step C** runs once per unit that has approved fixes.

**Phase 1 Milestone Review**
Context needed: all 11 `inconsistencies/obj-*.md` files, `phase-1-consolidated-fixes.md`, the updated spec files themselves.
Done when: every consolidated fix has been implemented and spot-checked (re-read the changed section, confirm it now matches the other side of the fix); a one-paragraph summary written to `plans/spec-consistency/milestones/phase-1-summary.md`; David has reviewed the summary and approved moving to Phase 2 (see Clarification Checkpoints — this is a hard gate per your pacing preference).

---

## Phase 2: Process Spec Consistency

Only starts after the Phase 1 Milestone Review is approved. Same Steps A–C pattern, but each unit's Step A also cross-checks against the now-consistent object specs from Phase 1, not just other process specs.

15 units:

| Unit ID | Spec file(s) | Maps to your requested process |
|---|---|---|
| `proc-message-routing` | `message_routing.md` | Message routing |
| `proc-oblivious-transport` | `oblivious_transport.md` | Obfuscated subcard-holder ↔ wallet-service communication via relay |
| `proc-card-creation` | `card_offering_and_acceptance.md`, `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`, `card_signing.md` | Card creation and acceptance |
| `proc-card-updates` | `card_updates.md` | Card updating and revocation |
| `proc-policy` | `policy_creation.md` | Policy creation, updating, and revocation |
| `proc-card-validation` | `card_validation.md` | Card verification |
| `proc-subcard` | `subcard_creation_policy.md` | Subcard creation, acceptance, and revocation |
| `proc-dns` | `dns_governance_verifier.md` | DNS route creation, updating, and removal |
| `proc-matrix-join` | `matrix_join_attestation_and_revocation.md` | Matrix service (added) |
| `proc-matrix-membership` | `matrix_room_membership.md` | Matrix service (added) |
| `proc-room-discovery` | `room_discovery.md` | Matrix service (added) |
| `proc-card-migration` | `card_migration.md` | Additional (included per your decision) |
| `proc-log-auditing` | `log_auditing.md` | Additional (included per your decision) |
| `proc-notification-relay` | `notification_relay.md` | Additional (included per your decision) |
| `proc-wallet-backup` | `wallet_backup_and_recovery.md` | Additional (included per your decision) |

For units named "creation, updating, and revocation" in your original list (policy, subcard) where only a "creation" file exists: Step A should explicitly check whether updating/revocation is covered elsewhere (e.g. inside `matrix_join_attestation_and_revocation.md` for subcards) or is a genuine spec gap. A gap is itself an inconsistency-log entry — "process X has no spec for lifecycle stage Y" — not a silent pass.

**Phase 2 Milestone Review**
Context needed: all 15 `inconsistencies/proc-*.md` files, `phase-2-consolidated-fixes.md`, updated process specs, and confirm no fix here re-broke a Phase 1 object spec (re-run a quick grep-level check, not full Step A, on any object spec touched by a Phase 2 fix).
Done when: fixes implemented and spot-checked; summary at `plans/spec-consistency/milestones/phase-2-summary.md`; David approves moving to Phase 3.

---

## Phase 3: Object Spec ↔ Codebase Alignment

Only starts after the Phase 2 Milestone Review is approved. Same Steps A–C pattern, but Step A is a spec-vs-code diff instead of spec-vs-spec: the reviewer subagent reads the object spec, then reads the corresponding source directory's actual types/endpoints/schemas, and logs every place the code contradicts or has silently diverged from the spec (renamed fields, removed endpoints, extra undocumented behavior, wrong status codes). Recommended resolutions must state which side is correct (spec is outdated → update spec; code is wrong → file it as a separate bug, don't silently "fix" running code as part of a spec-consistency pass) rather than auto-preferring one.

11 units:

| Unit ID | Spec | Code directory |
|---|---|---|
| `code-contracts` | `registry_contract.md` | `contracts/` |
| `code-card` | `ipfs_card.md` | wherever card serialization is implemented (likely `press/` and/or `app-sdk/` — confirm at kickoff) |
| `code-press` | `press.md` | `press/` |
| `code-wallet` | `wallet.md` | `wallet-service/` |
| `code-relay` | `relay.md` + `relay_data_model.md` | `relay/` |
| `code-verifier-sdk` | `card_verifier.md` | `membership_card_verifier/` |
| `code-app-sdk` | `app_sdk.md` | `app-sdk/` |
| `code-wallet-sdk` | `wallet_sdk.md` | `wallet-sdk/` |
| `code-matrix-encryption` | `matrix_encryption.md` | Matrix policy module code path (confirm exact directory — see strategic plan open question) |
| `code-matrix-room` | `matrix_room.md` | same |
| `code-matrix-synapse` | `matrix_synapse_module.md` | `wallet-service/matrix-policy-module/` (pending confirmation) |

Before Step A runs for any `code-matrix-*` unit, confirm the Matrix policy module's actual implementation path with David (strategic plan open question #2) — don't guess and point a subagent at the wrong directory.

**Phase 3 Milestone Review**
Context needed: all 11 `inconsistencies/code-*.md` files, `phase-3-consolidated-fixes.md`, updated specs and/or a filed list of code bugs (not silently patched).
Done when: fixes implemented and spot-checked; summary at `plans/spec-consistency/milestones/phase-3-summary.md`; David confirms the overall initiative is complete.

---

## Clarification Checkpoints

- **Before any Step C (fix implementation) runs**, David must have explicitly approved the corresponding phase's consolidated fix list. Do not implement a fix that wasn't in an approved list, even if it looks obviously correct — log it as a new finding instead.
- **Between phases** (Phase 0→1, 1→2, 2→3): hard stop. Present the milestone summary and wait for explicit go-ahead before spawning the next phase's Step A subagents. This matches your stated pacing preference.
- **If Step A finds that a "spec gap" is actually a missing spec entirely** (like the IPFS card case), stop and ask whether to draft a new spec (as was done in Phase 0) rather than having the fix-implementation agent invent one unilaterally.
- **In Phase 3, if a reviewer subagent finds the code is right and the spec is wrong** on something load-bearing (e.g. a security-relevant field, an auth boundary), flag it to David directly rather than folding it into the routine consolidated fix list — these warrant a real look, not a rubber-stamp.
- **If any single phase's Step A run surfaces more than ~15 inconsistencies**, pause before Step B and let David know — that volume likely means the spec set has a structural problem worth discussing before generating a mechanical fix list.
