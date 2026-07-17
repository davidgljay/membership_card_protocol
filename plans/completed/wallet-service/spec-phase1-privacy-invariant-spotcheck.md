# Phase 1, Step 1.4 — Privacy Invariant Spot-Check (2026-07-04)

Source: `wallet-service/test/audit-log-schema.test.ts`, `wallet-service/docs/audit-log-schema.md`, cross-referenced against the device-IO logic modules found in Step 1.1/1.3.

## What the automated test actually covers

`test/audit-log-schema.test.ts` defines `DEVICE_IO_ROOTS = ['server/routes/messages', 'server/routes/cards']` and walks every `.ts` file under those two directories, asserting: no `getRequestIP`/`x-forwarded-for` reference; no `console.*` call interpolating a `subcardHash` variable; no raw session token or `Authorization` value logged; no raw request body dumped.

## Finding: the test's scan roots no longer cover where the logging actually happens

As of the "thin H3 adapter" refactor (client-sdk implementation plan Step 1.4c), the route files under `server/routes/messages/` and `server/routes/cards/**` contain **no logging calls at all** — confirmed by direct read in Step 1.1. All `console.info` calls for these flows now live in `src/routes/messages-create.ts`, `src/routes/subcard-uuid-registration.ts`, and `src/routes/subcard-deregistration.ts`, none of which fall under `server/routes/messages` or `server/routes/cards` and so are **not scanned by the test at all**.

Concretely, these three `console.info` calls exist and are currently untested:
- `messages-create.ts`: `` `[wallet-service] message received card_hash=${to} message_id=${message.id}` ``
- `subcard-uuid-registration.ts`: `` `[wallet-service] uuids registered card_hash=${cardHashParam} count=${uuids.length} retransmitted=${uncleared.length}` ``
- `subcard-deregistration.ts`: `` `[wallet-service] subcard uuid pool deregistered card_hash=${cardHashParam}` ``

## Manual content check (spot check, not full audit)

Read all three lines directly (Step 1.1/1.3 reads): none references `subcard_hash`, IP, session token, or request body — only `card_hash` (the routing key, not device-correlating on its own) and aggregate counts/ids. **This is not an invariant violation** — the content itself is compliant with the stated privacy property. It is a **test-coverage gap**: the enforcement mechanism drifted out of sync with a refactor, and the guarantee is narrower than `phase-6-summary.md`'s claim ("An automated test... statically checks every device-IO route file") implies.

`docs/audit-log-schema.md §Non-audit operational logs` is honest about this in prose — it states these lines "are not part of the formal audit trail" and "every one of them was reviewed against the explicit-prohibitions list during Phases 4-6" (i.e., manual review, not automated). So the documentation doesn't overclaim; the discrepancy is narrower: `phase-6-summary.md`'s Step 6.2 description implies full automated coverage of "every device-IO route file," which is no longer accurate post-refactor.

## Disposition

**Not a CP-SPEC-1 trigger.** No evidence the code currently violates the unlinkability invariant — this is a coverage/tooling gap, not an active leak. Carrying forward to Phase 2 as a discrepancy against `phase-6-summary.md`'s Step 6.2 claim, and as a recommendation (not a requirement of this spec-writing initiative) that `DEVICE_IO_ROOTS` be extended to include `src/routes/` so the automated test actually covers where the logic lives now.

## Other privacy-relevant checks

- `federation/keyrings/index.post.ts` and `federation/keyrings/delete.post.ts` log via raw `console.info` (`federation keyring replica stored/deleted keyring_id=...`) — these are peer-to-peer federation traffic, not device IO, so they're out of scope for the device-correlation invariant, but they're also not using the structured `auditLog()` helper the way `docs/audit-log-schema.md`'s main event table implies is universal. Noted for Phase 2 alongside endpoint-inventory finding #5 (console.info vs. auditLog inconsistency) — a logging-consistency question, not a privacy violation.
- `admin/*` endpoints (Step 1.1) return `subcard_hash`-keyed data (`uuid-pool-sizes`) but never joined against any device identifier — consistent with `strategic-plan.md §Goal 5`'s framing that subcard_hash granularity alone is not the invariant's concern, only subcard_hash *combined with* a device/IP/session identifier is.
