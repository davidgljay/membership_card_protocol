# Spec Phase 5 Milestone Summary — Final Consistency Pass (Final)

**Date:** 2026-07-04
**Status:** Complete pending your review and sign-off (per this plan's own Phase 5 milestone criterion)

## Step 5.1 — Consistency pass results

Re-read `specs/object_specs/wallet.md` end to end alongside all six files touched in Phase 4. Terminology (`service_secret`, `keyring_id`, `subcard_hash`, `card_hash`) is consistent throughout; no stale `device_key` usage remains as live terminology (only explanatory changelog mentions of its removal); the "advance to next UUID on failure" behavior is described identically in `message_routing.md`, `notification_relay.md`, and `wallet.md`.

The pass caught two discrepancies Phase 2/4 missed — both were second, separate occurrences of the same already-identified IPFS-keyring staleness pattern, not new categories of finding:

- `open_offer_acceptance_new_wallet.md` Step 10's wallet-creation summary repeated the Step-7 IPFS claim. Already in this initiative's direct-edit scope (Step 4.2) — corrected without a new checkpoint.
- `card_protocol_spec.md` line ~705's "Keyring structure" requirement had its own independent "stored on IPFS" claim, separate from the line ~715 passage CP-SPEC-2 already covered. Since this is a second, distinct edit to a protocol-wide document, it was presented as its own CP-SPEC-2 item and approved before being applied.

## Step 5.2 — Discrepancy log closeout

`plans/wallet-service/spec-discrepancies.md` now has a permanent "Closeout — Final Record" section: a single table with original text, corrected text, and justification for every resolved finding (D-1 through D-8, including the two Phase-5-discovered passages), plus an explicit list of everything checked and found already accurate. The log states plainly that it is now closed.

## Final state

- `specs/object_specs/wallet.md` — v0.1, draft, complete, every claim traced to `wallet-service/` source.
- Six specs corrected: `wallet_backup_and_recovery.md` (v0.4), `message_routing.md` (v0.5), `notification_relay.md` (v0.10), `open_offer_acceptance_new_wallet.md` (v0.2), `open_offer_acceptance_existing_wallet.md` (v0.2), `card_protocol_spec.md` (v0.4).
- Zero entries left open in the discrepancy log. Zero CP-SPEC-1 triggers across all five phases. Two CP-SPEC-2 triggers, both approved and applied.
- Five genuine open questions carried into `wallet.md §9` for your future attention (sender auth gap on `POST /messages`, unrevoked backup registrations on rotation, no keyring reconciliation sweep, audit-log test coverage gap, KMS policy being out-of-repo) — these are implementation gaps or design questions, not documentation problems, and are out of scope for this spec-writing initiative to fix.

## What's left

This plan's own Phase 5 Milestone Review is explicit that the final step is your review and approval of `wallet.md` and the corrected specs — not something I can mark complete unilaterally. Presenting everything now for that review.
