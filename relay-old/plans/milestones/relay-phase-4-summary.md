# Relay Phase 4 — Milestone Summary

**Date:** 2026-06-28
**Status:** Complete

---

## Steps Completed

- **Step 11: Failure cases from spec** — All five rows of `notification_relay.md §Failure Handling` have corresponding tests in `tests/integration/failure-cases.test.ts`. Every scenario passes.

- **Step 12: UUID TTL and stuck-UUID startup scan** — `startup.ts` scans for `active` and `in_flight` UUIDs on startup via `scanActiveUuids()`, then transitions each to `consumed`. TTL expiry confirmed by test (seeded with 1s TTL, asserted null after 1.5s wait, then 404 on subsequent notify). Startup scan tested end-to-end via `runStartupChecks()`.

- **Step 13: Re-registration notifier** — `utils/reregistration.ts` fully implemented: checks `isStoreEmpty()`, queries SQLite for devices registered in last 90 days, dispatches `relay_reregistration_requested` silent push per device. Skips on non-empty Redis (normal startup). Skips when both Redis and SQLite are empty (first deploy). Push failures per device are logged and skipped without halting. Wired into `startup.ts`.

- **Step 14: SQLite pruning job** — `utils/pruning.ts` schedules weekly pruning with ±1h jitter via `setTimeout(...).unref()` (doesn't prevent process exit). Deletes device records with `last_registered_at < now - DEVICE_REGISTRY_RETENTION_DAYS`. Logs count of removed records. Wired into `startup.ts`.

---

## Failure Handling Table Coverage

| Scenario (notification_relay.md §Failure Handling) | Test | Result |
|---|---|---|
| UUID pool exhausted at wallet | 404/410 returned → wallet discards UUID | ✓ |
| Relay unreachable / push dispatch fails | UUID stays `in_flight` if transition fails before dispatch; 502 returned, UUID retryable | ✓ |
| WebSocket dropped mid-session | Both sides closed; UUID consumed; device falls back to push | ✓ |
| Push token rotated | New token creates new device registry entry; old UUIDs expire via TTL (1s TTL test) | ✓ |
| UUID rejected (used or unknown) | 410 returned for consumed UUID, 404 for unknown | ✓ |

---

## Test Results

45/45 tests passing across 4 test files:
- `tests/unit/sqlite.test.ts` — 4 tests
- `tests/integration/push-delivery.test.ts` — 11 tests
- `tests/integration/websocket-bridge.test.ts` — 9 tests
- `tests/integration/failure-cases.test.ts` — 21 tests (Steps 11–14)

---

## Checklist

- [x] All 5 failure scenarios from the spec table have a passing test
- [x] Startup scan detects `active` and `in_flight` UUIDs and resolves them to `consumed`
- [x] `runStartupChecks()` tested end-to-end (full sequence: stuck scan + re-registration check + pruning job start)
- [x] Re-registration fires on empty Redis + populated SQLite
- [x] Re-registration skipped on non-empty Redis (normal startup)
- [x] Re-registration skipped on first deploy (both stores empty)
- [x] Pruning removes records older than retention threshold, leaves recent records untouched
- [x] No WS teardown logs spurious errors for TTL-expired keys (NOT_FOUND treated as benign)

---

## Ready for Phase 5

All Phase 4 checks pass. Phase 5 (testing) builds on the existing test suite; some unit tests for the UUID lifecycle and additional integration coverage may be added.
