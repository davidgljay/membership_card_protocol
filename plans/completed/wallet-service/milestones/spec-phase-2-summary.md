# Spec Phase 2 Milestone Summary — Cross-Spec Verification

**Date:** 2026-07-04
**Status:** Complete

All four steps done. Full findings in `plans/wallet-service/spec-discrepancies.md`, organized below by target file with resolution status.

## Discrepancy log, by file

| File | Discrepancy | Resolution |
|---|---|---|
| `wallet_backup_and_recovery.md` | D-1: backup-registration wire format field names stale (`wrapped_decryption_key`/`cancellation_credentials` vs. actual `wrapped_blob`/`cancellation_pubkey`) | Resolved — direct edit in Phase 4, Step 4.1 |
| `wallet_backup_and_recovery.md` | D-2: "any registered cancellation credential" doesn't name the master card key as the sole implemented type | Resolved — direct edit in Phase 4, Step 4.1 |
| `wallet_backup_and_recovery.md` | D-3: Related Specs could add `open_offer_acceptance_existing_wallet.md` | Resolved (optional) — direct edit in Phase 4, Step 4.1 |
| `message_routing.md` | D-4: "retry with backoff, same UUID" on 5xx/network error contradicts implemented advance-to-next-UUID behavior | Resolved — direct edit in Phase 4, Step 4.1 |
| `notification_relay.md` | D-5: same stale "retry same UUID" language in Failure Handling table | Resolved — direct edit in Phase 4, Step 4.1 |
| `open_offer_acceptance_new_wallet.md` | D-6a: keyring described as posted to IPFS (contradicts ADR-009-AMEND) | Resolved — direct edit in Phase 4, Step 4.2 |
| `open_offer_acceptance_existing_wallet.md` | D-6b: same IPFS staleness in keyring-update step + error path | Resolved — direct edit in Phase 4, Step 4.2 |
| `open_offer_acceptance_new_wallet.md` / `_existing_wallet.md` | D-7: could cross-reference `specs/object_specs/wallet.md` once it exists | Resolved (optional) — direct edit in Phase 4, Step 4.2, once Phase 3 produces the object spec |
| `card_protocol_spec.md` | D-8: §3 repeats the same IPFS-keyring staleness as D-6 | **Deferred to CP-SPEC-2** — protocol-wide doc, requires your sign-off before editing (Phase 4) |

**No discrepancies found** (fully consistent with Phase 1's code inventories): `card_migration.md`, `card_offering_and_acceptance.md`, `card_updates.md`, `open_offer_creation.md`, `oblivious_transport.md`, `specs/object_specs/relay.md`, `relay_data_model.md`, `registry_contract.md`, `ARCHITECTURE.md`, `protocol-objects.md`, `messaging_protocol.md`. `card_verifier.md` was in the strategic plan's original check list but contains no wallet-service-relevant content at all on direct grep — appears to have been a false positive in the initial scoping grep; no further action needed.

## Notable non-discrepancy findings (revised earlier Phase 1 assumptions)

- **Phase 1 finding #2** (sub-card signed-envelope tightening) is fully and correctly documented in `notification_relay.md` v0.9 already — the only stale documents on this point are the wallet-service *build plans* (`strategic-plan.md`/`implementation-plan.md`), which are outside this initiative's correction scope. No spec edit needed for this finding.
- **Phase 1 finding #3** (the "undocumented" OHTTP subsystem) is fully specified in `specs/process_specs/oblivious_transport.md`, cross-referenced from `message_routing.md §Transport Extensibility` and `ARCHITECTURE.md`. Only the wallet-service build plans omit it. No spec edit needed.
- The relay's own object spec (`relay.md`) independently corroborates the "advance to next UUID on 404/410" behavior (D-4/D-5) — the wallet-service code comment cites `relay.md §7.2` directly. This strengthens confidence that D-4/D-5 are correcting the process specs *toward* an already-consistent relay/wallet-service pairing, not introducing a new interpretation.

## CP-SPEC-1 status

**Not triggered during Phase 2.** Every discrepancy found was either a stale/outdated spec description of a design that was later deliberately changed (with plan-documented rationale), or a wire-format naming mismatch. No case where the code appeared to violate a security or privacy invariant.

## Ready for Phase 3

The discrepancy log is complete, every entry has a resolution path (direct fix or CP-SPEC-2-gated), and no entry is left "TBD." Phase 3 (object spec authoring) can proceed using Phase 1's inventories as the primary source and this log's resolutions as the corrected framing for cross-references. Phase 4 will apply the direct-edit resolutions and seek your approval on D-8 via CP-SPEC-2 before touching `card_protocol_spec.md`.
