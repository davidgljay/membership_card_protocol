# Spec Phase 1 Milestone Summary — Ground Truth Extraction

**Date:** 2026-07-04
**Status:** Complete

Four inventories produced directly from `wallet-service/` source, none derived from the plan documents' original design intent:

- `plans/wallet-service/spec-phase1-endpoint-inventory.md` — 27 routes across `server/routes/**`, with auth, request/response shape, status codes, and rate limits, each cited to its source file.
- `plans/wallet-service/spec-phase1-data-model-inventory.md` — current-state schema reconstructed from all 8 migrations in order, cross-checked against repo query files (`server/db/messages.ts`, `server/db/keyrings.ts` spot-checked directly; others consistent by naming/usage cross-reference).
- `plans/wallet-service/spec-phase1-auth-crypto-inventory.md` — every auth mechanism and the `SecretsBackend`/`SecretsService` implementation, matched to the endpoints that use them.
- `plans/wallet-service/spec-phase1-privacy-invariant-spotcheck.md` — confirmed the automated audit-log test's actual scan roots vs. where device-IO logging code now lives.

## Cross-inventory consistency check

Every endpoint in the endpoint inventory has its auth mechanism explained by the auth/crypto inventory (two exceptions noted below, not contradictions — open items for Phase 2). Every table referenced by a repo file in the endpoint/auth inventories exists in the data-model inventory with matching columns (`auth_challenges.purpose` enum matches exactly the three challenge-issuing endpoints found; `subcard_action_nonces.action` enum matches the two sub-card lifecycle endpoints; `routing_table.signatures` matches both binding endpoints' usage). No inconsistency found that required re-checking code before proceeding.

## Findings carried into Phase 2 (not resolved here — ground truth only)

1. **`PUT /accounts/{card_hash}/keyring`'s `rotate_service_secret` parameter** — real, tested behavior; not in `implementation-plan.md` §Step 2.4. Comment attributes it to a "client-sdk implementation plan Step 2.4 fix."
2. **Sub-card UUID registration/deregistration now require a signed envelope** proving sub-card key control, replacing the "no auth beyond valid card_hash" design in the original Steps 5.1/5.2. Comments cite "security-audit finding (a)" and an "`implementation-plan.md §Step 2.7`" that does not exist in this directory's implementation plan — likely a cross-plan citation (probably `plans/client-sdk/implementation-plan.md`) to trace in Phase 2.
3. **An undocumented OHTTP (Oblivious HTTP) subsystem** (`/ohttp/gateway`, `/ohttp/key-config`) exists, dispatching to the same logic as several other endpoints via `src/ohttp-router.ts`. Not mentioned in `strategic-plan.md`/`implementation-plan.md`. Ties to `specs/process_specs/oblivious_transport.md`, already in Phase 2's scope.
4. **`message_queue`'s schema (`subcard_hash`, `delivery_uuid`) diverged from the Phase 1 implementation-plan sketch**, which predates the sender-side-encryption architecture change; the Phase 4 prose in the same document describes the new behavior correctly even though the SQL block wasn't updated.
5. **Inconsistent logging convention**: `federation/keyrings/*.post.ts`, and the `src/routes/` logic modules for messages/uuid-registration/deregistration, use raw `console.info` rather than the structured `auditLog()` helper `docs/audit-log-schema.md`'s main table implies is universal. `docs/audit-log-schema.md` itself is honest about this (§Non-audit operational logs) — the discrepancy is narrower: `phase-6-summary.md` describes automated test coverage as broader than it actually is post-refactor.
6. **The automated privacy-invariant test (`test/audit-log-schema.test.ts`) no longer scans the files where device-IO logging actually happens** (`DEVICE_IO_ROOTS` points at `server/routes/messages`/`server/routes/cards`, but logging moved to `src/routes/*.ts` in the thin-adapter refactor). Manually spot-checked: the three affected log lines are content-compliant with the privacy invariant (no subcard_hash/IP/session logged) — **this is a coverage gap, not an active violation**, so it does not trigger CP-SPEC-1.
7. **A new spec dependency found**: `specs/subcards.md §Step 5` defines the on-chain-registry → IPFS → `recipient_pubkey` resolution chain that both sub-card auth modules rely on. Not in the strategic plan's original "Specs to verify and correct" list — recommend adding it to Phase 2's scope.
8. **`src/auth/peer-wallet-signature.ts` may be dead code** — no route file calls it directly; `bindings/announce.post.ts` and `federation/keyrings/*.post.ts` use separate verification functions (`src/federation/binding.ts`, `src/federation/keyring-sync.ts`) that appear to serve the same purpose. Needs a direct check in Phase 2 before the object spec's Authentication section is written, so it doesn't describe a mechanism that isn't actually wired to anything.

## Ready for Phase 2

No inconsistency blocks proceeding. Item 6 was evaluated against CP-SPEC-1's trigger condition (invariant violation vs. documentation/coverage gap) and classified as the latter — proceeding without pausing, per the plan's own disposition rule.
