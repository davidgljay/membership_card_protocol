# Spec Phase 4 Milestone Summary — Cross-Spec Corrections

**Date:** 2026-07-04
**Status:** Complete

## Discrepancy log closeout

| ID | File | Status |
|---|---|---|
| D-1 | `wallet_backup_and_recovery.md` | Resolved — wire-format fields corrected (v0.3 → v0.4) |
| D-2 | `wallet_backup_and_recovery.md` | Resolved — cancellation credential named explicitly (v0.4) |
| D-3 | `wallet_backup_and_recovery.md` | Resolved — Related Specs extended (v0.4) |
| D-4 | `message_routing.md` | Resolved — delivery failure-handling corrected (v0.4 → v0.5) |
| D-5 | `notification_relay.md` | Resolved — Failure Handling table corrected (v0.9 → v0.10) |
| D-6a | `open_offer_acceptance_new_wallet.md` | Resolved — keyring storage description corrected (v0.1 → v0.2) |
| D-6b | `open_offer_acceptance_existing_wallet.md` | Resolved — keyring update description corrected (v0.1 → v0.2) |
| D-7 | Both acceptance-flow specs | Resolved — `specs/object_specs/wallet.md` added to Related Specs |
| D-8 | `card_protocol_spec.md` | Resolved — CP-SPEC-2 presented, approved, applied (v0.3 → v0.4) |

**Every entry in `spec-discrepancies.md` is now marked resolved.** None left in an ambiguous or TBD state. No entry was deferred-and-declined — all nine proposed corrections (across the eight discrepancy IDs, D-6 counted for both files) were approved and applied, including the one CP-SPEC-2 item.

## Correction style applied

Per your instruction given before this phase started, all corrected passages state current, accurate behavior directly — no inline narration of "this used to say X." The historical reasoning stays in `spec-discrepancies.md` and in each file's own versioned "Changes from vN" changelog line (the pre-existing convention in these documents, matching `relay.md`'s "Amends" pattern) — not in the body text describing behavior.

## Files touched this phase

`specs/process_specs/wallet_backup_and_recovery.md` (v0.3→0.4), `specs/process_specs/message_routing.md` (v0.4→0.5), `specs/process_specs/notification_relay.md` (v0.9→0.10), `specs/process_specs/open_offer_acceptance_new_wallet.md` (v0.1→0.2), `specs/process_specs/open_offer_acceptance_existing_wallet.md` (v0.1→0.2), `specs/card_protocol_spec.md` (v0.3→0.4). No other object specs required edits (Phase 2's Step 2.3 found `relay.md`, `relay_data_model.md`, `registry_contract.md`, and `card_verifier.md` already consistent).

## Ready for Phase 5

All corrections applied and cross-referenced. Phase 5 will do a full terminology/cross-reference consistency pass across `specs/object_specs/wallet.md` and every file touched this phase, then finalize the discrepancy log as a permanent audit trail.
