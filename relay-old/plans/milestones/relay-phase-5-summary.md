# Relay Phase 5 & 6 — Milestone Summary

**Date:** 2026-06-29
**Status:** Complete

---

## Phase 5: Testing

### Step 15: UUID lifecycle unit tests

`tests/unit/uuid-lifecycle.test.ts` — 23 tests against real Redis.

**Coverage:**
- Every valid transition in the state machine (8 tests): `unused→in_flight`, `in_flight→consumed`, `in_flight→unused` (rollback), `unused→active`, `active→consumed`, full push path, full WebSocket path, push retry path
- Every invalid transition (5 tests): `consumed→any` (blocked at Lua script level), wrong-from checks for `active` and `in_flight`, unknown key returns `NOT_FOUND`
- TTL expiry (2 tests): UUID auto-expires from Redis; `NOT_FOUND` returned on transition after expiry
- Atomicity under concurrent requests (3 tests): exactly one of two/ten concurrent `unused→in_flight` transitions succeeds; same for `unused→active`
- `isStoreEmpty` (3 tests): empty store, non-empty store, re-empty after TTL
- `scanActiveUuids` (2 tests): finds `active` and `in_flight`, excludes `unused` and `consumed`

**Bug fixed during this phase:** The Lua transition script originally used `{err = ...}` table syntax but ioredis throws a `ReplyError` for those (not a return value). Fixed `transitionUuid` to catch the thrown error and parse the message. Also added an explicit `consumed` guard to the Lua script — previously `transitionUuid(uuid, "consumed", X)` would succeed if X matched, making `consumed` non-terminal.

**Total: 68 tests passing across 5 files.** No flaky tests; `fileParallelism: false` ensures shared Redis state is not corrupted across files.

---

## Phase 6: Documentation + Final Verification

### Step 18: README

`relay/README.md` — covers:
- What the relay does and links to process/API specs
- Prerequisites and quick start (local dev + production Docker Compose)
- Complete environment variable table
- App registry config format with annotated example
- How to add a new app (no code changes required)
- How a wallet service integrates (push and WebSocket flows)
- Privacy properties table (what is/isn't stored)
- How to run the test suite

### Step 19: Smoke test results

All six steps passed against `docker compose up`:

| Step | Test | Result |
|---|---|---|
| 1 | `GET /health` returns `{"status":"ok","redis":"ok","sqlite":"ok"}` | ✓ |
| 2 | `POST /register` returns 5 UUIDs | ✓ |
| 3 | `POST /notify/{uuid}` returns 200; second call returns 410 `UUID_CONSUMED` | ✓ |
| 4 | `GET /ws/{uuid}` opens connection, relay attempts wallet bridge, returns 4002 `WALLET_REJECTED` (wallet URL unreachable) | ✓ |
| 5 | Relay container restart: Redis retains UUID state; UUID usable after restart | ✓ |
| 6 | Redis container restart + relay restart: re-registration notifier fires for all 3 registered devices (`relay_reregistration_requested` dispatched in stub mode) | ✓ |

**Bug fixed during smoke test:** `ws.ts` sent close code 1001 (GOING_AWAY) on wallet connection failure, regardless of whether the bridge was established. Fixed to distinguish pre-bridge errors (send 4002 WALLET_REJECTED) from post-bridge wallet closes (send 1001 GOING_AWAY to device).

---

## Implementation Complete

All six phases done. The relay service is fully implemented, tested, containerized, and documented.
