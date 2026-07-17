# Wallet Service Object Spec — Implementation Plan

**Strategic plan:** [spec-strategic-plan.md](./spec-strategic-plan.md)
**Date:** 2026-07-04
**Status:** Draft

---

## Resolved Design Decisions

| Question | Decision |
|---|---|
| OQ-WS-SPEC-1: Genuine invariant conflicts (code violates a security/privacy property, not just a stale doc) | **Always pause.** Treated as a Clarification Checkpoint (CP-SPEC-1 below), not a documentation call. Do not write the "invariant" into any spec as new intended behavior until you've weighed in. |
| OQ-WS-SPEC-2: Depth of cross-check for object specs where the wallet service is a secondary mention | Full read-and-verify for every file the grep found; less time budgeted for passing mentions than for files describing wallet-service behavior in detail (see Phase 2). |
| OQ-WS-SPEC-3: Corrections to `ARCHITECTURE.md` / `card_protocol_spec.md` | Flag-first. Any proposed correction to these two specifically is presented before being made (Clarification Checkpoint CP-SPEC-2), not applied inline like a process-spec fix. |

**Standing rule for this entire plan:** every factual claim in the new object spec must trace to a specific file and, where practical, a line reference in `wallet-service/`. If a claim can't be traced to code, it doesn't go in the spec — it goes in the Open Questions section or the discrepancy log instead.

---

## Phases

---

### Phase 1: Ground Truth Extraction

**Goal:** A complete, code-derived inventory of the wallet service's actual endpoints, data model, and auth mechanisms — before touching any spec prose.

---

**Step 1.1 — Endpoint inventory**
- What: Walk every file under `wallet-service/server/routes/` (accounts, admin, auth, bindings, cards, federation, keyrings, messages, ohttp, recovery, plus `health.get.ts`). For each route, record: HTTP method + path, auth mechanism used, request body shape (from validation code, e.g. Zod schemas or manual checks), response shape, status codes returned, and rate limit (cross-reference `server/utils/enforce-rate-limit.ts` call sites). Output a working table, not prose yet.
- Who: Claude
- Context needed: `wallet-service/server/routes/**`, `wallet-service/server/utils/enforce-rate-limit.ts`, `wallet-service/server/utils/auth.ts`, `wallet-service/server/utils/admin-auth.ts`
- Done when: One row exists per route file found; every row cites the exact file path; no row is inferred from the implementation plan without a code citation.

**Step 1.2 — Data model inventory**
- What: Read every file in `wallet-service/server/db/migrations/` in order (not just the Phase 1 schema from `implementation-plan.md`, which is known to be stale — e.g. `reencryption_keys` was dropped). Reconstruct the current schema as it would exist after all migrations apply: table names, columns, types, constraints, indexes. Cross-reference against `wallet-service/server/db/*.ts` (accounts, backups, challenges, keyrings, messages, notification-jobs, recovery, routing, subcard-action-nonces, uuid-pools) to confirm each repo file's queries match the reconstructed schema.
- Who: Claude
- Context needed: `wallet-service/server/db/migrations/**`, `wallet-service/server/db/*.ts`
- Done when: A single current-state schema listing exists, with each table's presence/shape traced to the migration(s) that produced it; any table or column present in the Phase 1 plan's schema sketch but absent from migrations (or vice versa) is flagged explicitly.

**Step 1.3 — Auth and crypto inventory**
- What: Read `wallet-service/src/auth/*.ts` (master-card-signature, peer-wallet-signature, session-token, subcard-deregistration-signature, subcard-uuid-signature, webauthn) and `wallet-service/src/secrets/*.ts` (backend, index, kms-backend, secrets-service, webcrypto-backend). Record: each auth mechanism's actual verification logic, which endpoints use which mechanism (cross-reference Step 1.1), and confirm the `SecretsBackend` interface and both implementations match `strategic-plan.md §Secret Storage`.
- Who: Claude
- Context needed: `wallet-service/src/auth/**`, `wallet-service/src/secrets/**`
- Done when: Every auth mechanism named in Step 1.1's table is backed by a specific file/function citation; `SecretsBackend` interface matches (or explicitly diverges from) the strategic plan's description.

**Step 1.4 — Privacy invariant spot-check**
- What: Cross-reference `wallet-service/test/audit-log-schema.test.ts` (the automated enforcement of the "no device-to-card correlation" invariant) against `implementation-plan.md`'s explicit prohibitions list (Step 6.2) and `strategic-plan.md §Goal 3`. Confirm the test's actual assertions match the stated invariant, and skim (not full audit) the device-IO route handlers it covers (`server/routes/messages/**`, `server/routes/cards/**`) for anything the test wouldn't catch — e.g., a new field added after the test was written.
- Who: Claude
- Context needed: `wallet-service/test/audit-log-schema.test.ts`, `wallet-service/docs/audit-log-schema.md`, `strategic-plan.md §Goal 3`
- Done when: Confirmed the automated test's coverage matches the stated invariant, or a specific gap is identified and logged for Phase 2/3 review. **If a gap looks like an actual violation (not just missing test coverage for something that's still safe), stop — this triggers Clarification Checkpoint CP-SPEC-1, not a note in the log.**

**⬥ Phase 1 Milestone Review**
- Context needed: Outputs of Steps 1.1-1.4
- Done when: The four inventories (endpoints, data model, auth/crypto, privacy invariant) are internally consistent — every endpoint in 1.1 has its auth mechanism explained by 1.3, every table referenced by a repo file in 1.1/1.3 exists in 1.2's schema; any inconsistency between inventories is resolved (re-check the code) before Phase 2 begins; a one-paragraph summary written to `plans/wallet-service/milestones/spec-phase-1-summary.md`.

---

### Phase 2: Cross-Spec Verification

**Goal:** Every spec that describes or references wallet-service behavior has been checked against Phase 1's ground truth and a discrepancy list produced.

---

**Step 2.1 — Process specs deep check**
- What: Read `wallet_backup_and_recovery.md`, `message_routing.md`, and `notification_relay.md` in full. For each, walk section by section and check every claim about wallet-service behavior against Phase 1's inventories. Known likely discrepancies to confirm and scope precisely: UMBRAL re-encryption key material described anywhere (should be gone per Phase 4 of `implementation-plan.md`); the "100 UUIDs per device_key per 24 hours" rate limit or any other stale rate-limit description (removed per Phase 6, Step 6.1); the `PUT /accounts/{card_hash}/keyring` service_secret rotation behavior (corrected post-hoc per commit `40165c8d` — confirm the specs describe the corrected behavior, not the buggy one); any registration-token flow that assumes a third party mints one (resolved as CP-1 — no such token exists).
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md`, `specs/process_specs/message_routing.md`, `specs/process_specs/notification_relay.md`, Phase 1 outputs, `implementation-plan.md` (for the known-divergence list, as a checklist only — not as a source of truth for current behavior)
- Done when: Each of the three specs has a line-by-line discrepancy list (or a confirmation of "no discrepancy found") recorded in `plans/wallet-service/spec-discrepancies.md`; every discrepancy cites the spec section, the actual code behavior, and the file/commit that caused the divergence where known.

**Step 2.2 — Acceptance-flow and migration specs check**
- What: Read `open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_creation.md`, `card_migration.md`, `card_offering_and_acceptance.md`, `card_updates.md`, and `oblivious_transport.md`. These describe flows where the wallet service is one actor among several (card issuer, press, relay, holder device) — check specifically the wallet-service-facing steps (account creation, WebAuthn login, keyring update, binding announcements, `410 Gone` handling) against Phase 1's endpoint inventory.
- Who: Claude
- Context needed: The seven specs above, Phase 1 outputs (especially the endpoint table)
- Done when: Same discrepancy-list format as Step 2.1, appended to `plans/wallet-service/spec-discrepancies.md`; explicitly confirm or correct the CP-1 resolution (no external registration token) is reflected in `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`.

**Step 2.3 — Other object specs check (lighter pass)**
- What: Read `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`, `specs/object_specs/registry_contract.md`, and `specs/object_specs/card_verifier.md`. For `relay.md`/`relay_data_model.md` (the wallet service's primary counterparty), check the wallet-service-facing sections in full (e.g. `relay.md §7.2 POST /deliver/{uuid}`, §7.8 deprecated notify). For `registry_contract.md` and `card_verifier.md`, locate the "wallet service" mentions found by the earlier grep and check just those passages, per OQ-WS-SPEC-2's lighter-budget scoping.
- Who: Claude
- Context needed: The four specs above, Phase 1 outputs
- Done when: `relay.md`/`relay_data_model.md` sections fully checked against Phase 1's inventory; `registry_contract.md`/`card_verifier.md` passing mentions individually confirmed accurate or flagged; appended to `plans/wallet-service/spec-discrepancies.md`.

**Step 2.4 — Protocol-wide specs check (flag-first)**
- What: Read `specs/ARCHITECTURE.md` (especially ADR-009-AMEND, cited throughout the wallet-service plans for keyring storage) and `specs/card_protocol_spec.md` and `specs/protocol-objects.md` and `specs/messaging_protocol.md` for wallet-service mentions. Do not edit these in this step even if a discrepancy is found — record proposed corrections in the discrepancy log, marked for Clarification Checkpoint CP-SPEC-2 review before Phase 4 touches them.
- Who: Claude
- Context needed: The four specs above, Phase 1 outputs
- Done when: All wallet-service mentions in these four documents are individually confirmed accurate or logged as a proposed correction with exact before/after text; nothing in these four files has been edited yet.

**⬥ Phase 2 Milestone Review**
- Context needed: `plans/wallet-service/spec-discrepancies.md` (full, all four steps' entries), Phase 1 summary
- Done when: The discrepancy log is complete and organized by target file; every entry has a proposed resolution (or is marked for CP-SPEC-1/CP-SPEC-2); no entry is still "TBD"; summary written to `plans/wallet-service/milestones/spec-phase-2-summary.md`.

**⚑ Clarification Checkpoint CP-SPEC-1 — Invariant conflicts**
Triggered any time during Phase 1 or 2 that a discrepancy looks like the *code* violates a security or privacy property (not just that a doc is stale). Pause immediately, present the specific finding, and do not proceed with documenting it as intended behavior until you've responded. This may result in a code fix task outside this plan's scope, not a spec correction.

---

### Phase 3: Object Spec Authoring

**Goal:** `specs/object_specs/wallet.md` exists, structurally consistent with `relay.md`, fully sourced from Phase 1's ground truth and reconciled with Phase 2's discrepancy resolutions.

---

**Step 3.1 — Outline and structural skeleton**
- What: Draft the table of contents mirroring `relay.md`'s structure, adapted for the wallet service's two-role nature (primary service + backup service): Overview, Relationship to Existing Specs, Actors, Privacy Properties, Data Model, Authentication, Endpoints (grouped by area: accounts, keyrings, recovery, messages, bindings/federation, admin, ohttp), Error Codes, Open Questions.
- Who: Claude
- Context needed: `specs/object_specs/relay.md` (structural template), Phase 1 outputs (for section scope)
- Done when: Outline reviewed against Phase 1's endpoint table to confirm every route has a home section; no orphaned endpoints.

**Step 3.2 — Overview, Actors, and Relationship to Existing Specs**
- What: Write the Overview section describing the wallet service's dual role (primary/backup) per `strategic-plan.md §What This Service Is`, corrected for anything Phase 2 flagged as stale. Write Actors (holder device, peer wallet service, notification providers, relay, admin operator). Write the Relationship to Existing Specs table, listing every spec from the strategic plan's Related Specs section plus corrected status notes for any spec Phase 2 found and fixed.
- Who: Claude
- Context needed: `strategic-plan.md §What This Service Is`, `spec-discrepancies.md` entries relevant to relationship/scope claims
- Done when: Every relationship listed cites the current (post-Phase-2-fix) version of the referenced spec, not a stale one.

**Step 3.3 — Data Model section**
- What: Write the full schema documentation from Step 1.2's reconstructed current-state schema — not the Phase 1 implementation-plan sketch. Include the dropped `reencryption_keys` table as a documented historical note (matching how `relay.md` handles superseded designs), not as current schema.
- Who: Claude
- Context needed: Step 1.2 output
- Done when: Every table, column, and index in the actual database is documented; nothing appears that isn't in a migration; the historical note about `reencryption_keys` is present and clearly marked as removed.

**Step 3.4 — Authentication section**
- What: Document each auth mechanism from Step 1.3: session token, master-card-signature, WebAuthn passkey login, peer-wallet-service signature verification, admin bearer token. For each, specify exactly which endpoints require it (cross-reference Step 1.1).
- Who: Claude
- Context needed: Step 1.3 output
- Done when: Every endpoint in the Endpoints section (Step 3.5) has its auth mechanism defined here first, no forward references to undefined mechanisms.

**Step 3.5 — Endpoints section**
- What: Document every endpoint from Step 1.1's inventory, grouped by area, in the `relay.md` style (method, path, auth, request body, response body, status codes, rate limit). This is the bulk of the document. Explicitly incorporate every Phase 2 correction relevant to endpoint behavior (e.g., corrected `PUT /accounts/{card_hash}/keyring` behavior, no UUID registration rate limit, admin endpoints from Step 6.2a).
- Who: Claude
- Context needed: Step 1.1 output, `spec-discrepancies.md` entries tagged to specific endpoints
- Done when: One subsection per endpoint; every request/response field matches actual validation code (Step 1.1); every rate limit matches `enforce-rate-limit.ts` call sites exactly, including the explicit absence of a limit on UUID registration.

**Step 3.6 — Privacy Properties and Error Codes**
- What: Write the Privacy Properties section from Step 1.4's findings — the unlinkability invariant, what's enforced by test versus by design, and any CP-SPEC-1 resolution folded in as documented behavior (only once resolved). Write the Error Codes section enumerating actual HTTP status codes returned across all routes (from Step 1.1), not a generic REST error list.
- Who: Claude
- Context needed: Step 1.4 output, Step 1.1 output, CP-SPEC-1 resolution (if triggered)
- Done when: Every status code in Step 1.1's inventory appears in the Error Codes table with the condition that produces it; Privacy Properties section makes no claim unfalsified by the audit-log-schema test.

**Step 3.7 — Open Questions section**
- What: Carry forward anything from the strategic plan's own Open Questions (OQ-WS-SPEC-2/3 resolutions, and any genuinely unresolved item from the original `strategic-plan.md`/`implementation-plan.md` open questions that Phase 1/2 didn't resolve — e.g., the operational gaps `docs/operations.md` lists: keyring-blob reconciliation, old-backup-registration revocation on rotation).
- Who: Claude
- Context needed: `wallet-service/docs/operations.md` (final section), `spec-discrepancies.md`
- Done when: No known unresolved gap from `operations.md` or the discrepancy log is silently dropped; each appears here or is explicitly marked resolved with a citation.

**⬥ Phase 3 Milestone Review**
- Context needed: Full draft of `specs/object_specs/wallet.md`, Phase 1 and 2 outputs
- Done when: A full read-through of the draft against Phase 1's four inventories finds zero unsourced claims; version/status header added matching `relay.md`/`press.md` convention (`Version: 0.1`, `Status: Draft`, dated); summary written to `plans/wallet-service/milestones/spec-phase-3-summary.md`.

---

### Phase 4: Cross-Spec Corrections

**Goal:** Every discrepancy logged in Phase 2 is resolved in the referencing document, with proper amendment tracking — except protocol-wide docs, which route through CP-SPEC-2 first.

---

**Step 4.1 — Process spec corrections**
- What: Apply corrections to `wallet_backup_and_recovery.md`, `message_routing.md`, `notification_relay.md` per Step 2.1's discrepancy list. Follow `relay.md`'s "Amends" convention: bump the version number, add a dated amendment note at the top summarizing what changed and why, and edit the affected sections in place.
- Who: Claude
- Context needed: `spec-discrepancies.md` (Step 2.1 entries), the three target specs, `relay.md`'s header as a formatting example
- Done when: All Step 2.1 discrepancies are resolved in the actual document text; each file's version number and amendment note reflect the change; no stale UMBRAL/rate-limit/registration-token language remains in any of the three files.

**Step 4.2 — Acceptance-flow and migration spec corrections**
- What: Apply corrections to the seven specs from Step 2.2 per its discrepancy list, same amendment convention.
- Who: Claude
- Context needed: `spec-discrepancies.md` (Step 2.2 entries), the seven target specs
- Done when: All Step 2.2 discrepancies resolved in document text with amendment notes; CP-1 resolution (no external registration token) explicit and correct in both acceptance-flow specs.

**Step 4.3 — Other object spec corrections**
- What: Apply corrections to `relay.md`, `relay_data_model.md`, `registry_contract.md`, `card_verifier.md` per Step 2.3's discrepancy list.
- Who: Claude
- Context needed: `spec-discrepancies.md` (Step 2.3 entries), the four target specs
- Done when: All Step 2.3 discrepancies resolved with amendment notes; passing-mention corrections in `registry_contract.md`/`card_verifier.md` are minimal, scoped edits (not full rewrites of unrelated sections).

**⚑ Clarification Checkpoint CP-SPEC-2 — Protocol-wide spec corrections**
Present every proposed correction to `ARCHITECTURE.md`, `card_protocol_spec.md`, and `protocol-objects.md`/`messaging_protocol.md` (from Step 2.4) as an explicit before/after diff before editing. These documents are read by every other component's spec; get sign-off before changing them.

**Step 4.4 — Protocol-wide spec corrections (post-checkpoint)**
- What: Apply only the corrections approved at CP-SPEC-2, using the same amendment convention.
- Who: Claude
- Context needed: CP-SPEC-2 approved list, the target specs
- Done when: Approved corrections applied; any correction not approved is left as a documented Open Question in `wallet.md` instead (pointing at the unresolved cross-spec inconsistency) rather than silently dropped.

**⬥ Phase 4 Milestone Review**
- Context needed: All diffs made in Steps 4.1-4.4, `spec-discrepancies.md`
- Done when: Every entry in `spec-discrepancies.md` is marked resolved, deferred-to-CP-SPEC-2-and-declined (with the reason), or explicitly carried to `wallet.md`'s Open Questions; no entry left in an ambiguous state; summary written to `plans/wallet-service/milestones/spec-phase-4-summary.md`.

---

### Phase 5: Final Consistency Pass

**Goal:** The new object spec and every corrected document are mutually consistent, and the initiative's own record (discrepancy log, milestone summaries) is complete and legible to a future reader.

---

**Step 5.1 — Full re-read for internal consistency**
- What: Re-read `specs/object_specs/wallet.md` end to end alongside every document touched in Phase 4. Confirm terminology matches across all of them (e.g., `service_secret`, `keyring_id`, `subcard_hash` used consistently; no document still calling something a `device_key` if that term was retired elsewhere).
- Who: Claude
- Context needed: `specs/object_specs/wallet.md`, all Phase 4 output files
- Done when: No terminology or cross-reference mismatch found between `wallet.md` and any document it links to or is linked from.

**Step 5.2 — Discrepancy log closeout**
- What: Finalize `plans/wallet-service/spec-discrepancies.md` as a permanent record: every entry shows original text, corrected text, and the file/commit that justified the correction. This is the audit trail for "why does this spec say X when the plan said Y."
- Who: Claude
- Context needed: `spec-discrepancies.md`
- Done when: Log is complete, every entry has all three fields, no entry references a step number without also explaining the substance of the change in plain language.

**⬥ Phase 5 Milestone Review (Final)**
- Context needed: `specs/object_specs/wallet.md`, `spec-discrepancies.md`, all four prior milestone summaries
- Done when: You've reviewed and approved the final `wallet.md` and the set of corrected specs; a final summary written to `plans/wallet-service/milestones/spec-phase-5-summary.md` stating the spec is complete, code-accurate as of the commit reviewed, and consistent with every document it references.

---

## Clarification Checkpoints Summary

| ID | Where | Trigger |
|---|---|---|
| CP-SPEC-1 | Phase 1 or 2, any step | A discrepancy looks like the code violates a security/privacy invariant, not just that a doc is stale. Stop and present the finding before documenting it as intended behavior. |
| CP-SPEC-2 | Phase 4, before Step 4.4 | Any proposed correction to `ARCHITECTURE.md`, `card_protocol_spec.md`, `protocol-objects.md`, or `messaging_protocol.md`. Present as before/after diff; only apply what's approved. |

---

## Context Map

| Phase | Minimum context |
|---|---|
| Phase 1 | `wallet-service/server/**`, `wallet-service/src/**` (route/db/auth/secrets code only — no plans needed yet) |
| Phase 2 | Phase 1 outputs, the ~18 specs listed in the strategic plan's "Specs to verify and correct" |
| Phase 3 | Phase 1 and 2 outputs, `specs/object_specs/relay.md` as structural template |
| Phase 4 | Phase 2's `spec-discrepancies.md`, the specific target spec for each step |
| Phase 5 | `specs/object_specs/wallet.md`, all Phase 4 output files, `spec-discrepancies.md` |
