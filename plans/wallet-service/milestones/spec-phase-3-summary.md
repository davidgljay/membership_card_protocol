# Spec Phase 3 Milestone Summary — Object Spec Authoring

**Date:** 2026-07-04
**Status:** Complete

`specs/object_specs/wallet.md` (v0.1, draft) written in full: Overview, Relationship to Existing Specs, Actors, Privacy Properties, Data Model, Authentication, Endpoints (9 subsections), Error Codes, Open Questions.

## Consistency check against Phase 1 inventories

- **Endpoints:** all 27 routes from `spec-phase1-endpoint-inventory.md` appear in §7, none invented. Request/response shapes match the inventory's citations to route/logic-module source, including the two behavior details the original build plans never documented: `PUT /accounts/{card_hash}/keyring`'s `rotate_service_secret` parameter (§7.3) and the full OHTTP gateway (§7.9).
- **Data model:** all 11 current tables from `spec-phase1-data-model-inventory.md` documented with matching columns; the dropped `reencryption_keys` table included as an explicit historical note, not current schema.
- **Auth:** all 6 mechanisms from `spec-phase1-auth-crypto-inventory.md` documented, each tied to the endpoints that use it. `src/auth/peer-wallet-signature.ts`'s unclear call-site status (Phase 1 finding #8) is intentionally not mentioned in the object spec — it's an internal-implementation question, not an externally observable behavior the spec should assert either way; the spec instead describes the two functions actually confirmed wired to routes (`verifyAnnouncementEnvelope`, `verifySignedKeyringMessage`).
- **Privacy properties:** includes the audit-log test coverage gap from `spec-phase1-privacy-invariant-spotcheck.md`, stated honestly as a known gap rather than omitted or overclaimed.

## Discrepancy-log resolutions incorporated

All of Phase 2's direct-edit-scope findings (D-1 through D-7) are reflected in how §7 and §2 describe current behavior — the object spec was written from Phase 1's code-only ground truth throughout, so it was never at risk of repeating the process specs' stale language (the two now-superseded "retry same UUID" and "keyring via IPFS" descriptions never entered this document in the first place). D-8 (the `card_protocol_spec.md` IPFS staleness) doesn't affect this document either way — it's a correction owed to a different file, pending CP-SPEC-2.

## New findings surfaced while writing (added to §9 Open Questions)

- **OQ-WALLET-1:** `POST /messages` has no sender authentication — nothing verifies the caller is an actual peer wallet service, unlike the binding/federation endpoints. Not previously flagged in Phase 1 or 2; found while writing the endpoints section and comparing its auth posture against its siblings.
- **OQ-WALLET-2/3:** Carried forward from `docs/operations.md`'s known-gaps section (old backup registrations not revoked on rotation; no keyring-blob reconciliation sweep).
- **OQ-WALLET-4:** Carried forward from Phase 1's privacy-invariant spot-check (audit-log test coverage gap).
- **OQ-WALLET-5:** Carried forward from `docs/security-review-cp3.md` (KMS key policy is an out-of-repo operator responsibility).

No gap from `operations.md` or the discrepancy log was dropped silently.

## Ready for Phase 4

Draft is internally consistent with Phase 1's ground truth. Version header (`0.1, draft`) added, matching `relay.md`/`press.md` convention. Phase 4 will apply the discrepancy log's direct-edit resolutions to the process specs and the two acceptance-flow specs, and seek approval on the one CP-SPEC-2 item (`card_protocol_spec.md`) before editing it.
