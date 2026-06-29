# Relay Phase 5 & 6 — Milestone Summary

**Date:** 2026-06-29
**Status:** Complete

---

## Phase 5: Testing

### Step 15: UUID lifecycle unit tests (`tests/unit/uuid-lifecycle.test.ts`)

23 tests covering every edge of the state machine diagram from `relay_data_model.md §5`:

**Valid transitions (8 tests)**
- `unused → in_flight` (push dispatch begins)
- `in_flight → consumed` (push succeeded)
- `in_flight → unused` (push failed — rollback)
- `unused → active` (WebSocket opened)
- `active → consumed` (WebSocket closed)
- Full push path end-to-end
- Full WebSocket path end-to-end
- Push retry path (rollback then re-use)

**Invalid transitions (5 tests)**
- `consumed → any` (all four targets): WRONG_STATUS, state unchanged
- `active → any` via wrong-from: WRONG_STATUS returned, state unchanged
- `in_flight → any` via wrong-from: WRONG_STATUS returned, state unchanged
- Unknown key: NOT_FOUND (does not throw)
- `getUuid` on unknown key: returns null (does not throw)

**TTL expiry (2 tests)**
- UUID auto-expires after TTL; `getUuid` returns null
- Transition on expired UUID returns NOT_FOUND

**Atomicity (3 tests)**
- Two concurrent `unused → in_flight`: exactly one succeeds
- Ten concurrent `unused → in_flight`: exactly one succeeds
- Two concurrent `unused → active`: exactly one succeeds

**Utility (5 tests)**
- `isStoreEmpty`: true when empty, false after seed, true after TTL expiry
- `scanActiveUuids`: returns active/in_flight UUIDs, excludes unused/consumed, returns empty when no stuck UUIDs

### Bug fix discovered during testing

The Lua transition script previously used `{err = ...}` but did not block transitions *from* `consumed` — any caller that passed `"consumed"` as the expected `from` state could move a consumed UUID to another state. Fixed: the script now explicitly rejects `consumed` as a source state regardless of the `from` argument.

Also fixed: ioredis throws a `ReplyError` for Lua `{err = ...}` responses rather than returning a value. `transitionUuid` now catches these thrown errors and maps them to the `TransitionResult` type.

---

## Phase 6: Documentation & Verification

### Step 18: README (`relay/README.md`)

Covers: what the relay does, prerequisites, local dev quick start, production deployment, environment variables table, app registry config format (annotated), adding a new app, wallet service integration guide, privacy properties table, and how to run tests.

### Step 19: Final smoke test (all 6 steps passed)

| Step | Result |
|---|---|
| 1. `docker compose up` — both containers start cleanly | ✓ Healthy |
| 2. `POST /register` — 5 UUIDs returned | ✓ 200, array of 5 UUIDs |
| 3. `POST /notify/{uuid}` — stub push dispatched; second call returns 410 | ✓ 200 then 410 UUID_CONSUMED |
| 4. `GET /ws/{uuid}` — relay attempts wallet connection, returns 4002 when unreachable | ✓ 4002 WALLET_REJECTED |
| 5. Restart relay — Redis UUID state preserved across relay restart | ✓ UUID still `unused` |
| 6. Restart Redis then relay — re-registration pushes sent to 2 registered devices | ✓ "2 sent, 0 failed" |

**Also fixed during smoke test:** WebSocket `walletSocket.on("error")` was calling `teardown("wallet")` before the bridge was established, sending close code 1001 (GOING_AWAY) to the device. Fixed to send 4002 (WALLET_REJECTED) when the wallet connection fails before the bridge opens, and 1001 only for mid-session disconnects.

---

## Final test count

68 tests, 5 test files, all passing:
- `tests/unit/sqlite.test.ts` — 4
- `tests/unit/uuid-lifecycle.test.ts` — 23
- `tests/integration/push-delivery.test.ts` — 11
- `tests/integration/websocket-bridge.test.ts` — 9
- `tests/integration/failure-cases.test.ts` — 21

---

## Implementation complete

All 6 phases of `relay-implementation-plan.md` are done. The relay service is ready for Phase 3 step 9 follow-up (real APNs/FCM credentials) when available.
