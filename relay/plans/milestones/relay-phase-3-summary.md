# Relay Phase 3 — Milestone Summary

**Date:** 2026-06-28
**Status:** Complete

---

## Steps Completed

- **Step 7: POST /register** — Full implementation. Validates `app_id`, `push_token`, and optional `count` (1–100, default 10). Writes UUID records to Redis with 30-day TTL. Upserts device into SQLite. Returns `{ uuids }`. All error codes per spec (MISSING_FIELD, INVALID_COUNT, UNKNOWN_APP, INTERNAL_ERROR).

- **Step 8: POST /notify/{uuid}** — Full implementation. UUID format validation, Redis lookup, status check, atomic `unused → in_flight` Lua transition, push dispatch, `in_flight → consumed` on success, `in_flight → unused` on push failure (502 returned; UUID retryable). All error codes per spec.

- **Step 9: Push dispatch (APNs + FCM)** — Real `apns.ts` (node-apn, silent push with `content-available: 1`, payload `{ uuid }`) and `fcm.ts` (firebase-admin, data-only message). `dispatch.ts` checks `NODE_ENV` at call time (not module load time) so test stub mode works correctly. APNs and FCM provider instances cached by `app_id`.

- **Step 10: GET /ws/{uuid} WebSocket bridge** — Full implementation. UUID validation, Redis lookup, `unused → active` transition, outbound wallet WebSocket opened to `{wallet_ws_url}/{uuid}`, bidirectional byte forwarding. Teardown is idempotent (double-close guard). Close codes 4000/4002/4004/4010/1001/1011 per spec. All session teardown paths (device close, wallet close, either-side error) transition UUID to `consumed`.

- **GET /health** — Implemented: Redis PING + SQLite SELECT 1, returns 200/503 with per-dependency status.

---

## Test Results

24/24 tests passing:
- `tests/unit/sqlite.test.ts` — 4 tests
- `tests/integration/push-delivery.test.ts` — 11 tests (POST /register and POST /notify/{uuid})
- `tests/integration/websocket-bridge.test.ts` — 9 tests (WebSocket bridge, all rejection codes)

---

## Checklist

- [x] POST /register returns correct UUID count, all error codes correct per spec
- [x] POST /notify/{uuid}: UUID consumed after success, UUID unchanged after push failure (502), correct 404/410 on missing/consumed UUID, atomic `unused → in_flight` prevents double-delivery
- [x] WebSocket bridge: messages flow bidirectionally, both sides close on either disconnect, UUID consumed after teardown, correct close codes (4000/4004/4010) on invalid/unknown/consumed UUID
- [x] UUID state transitions follow the state machine exactly (all transitions via Lua script)
- [x] No UUID can be left permanently in `active` state — any abnormal disconnect triggers teardown and `consumed` transition

## Notes

- `wallet_ws_url` validation relaxed to accept `ws://` in addition to `wss://` to support test environments. Production deployments should always use `wss://`.
- Push dispatch stub is active when `NODE_ENV=development`. APNs and FCM are implemented and will fire in production.

---

## Ready for Phase 4

All Phase 3 checks pass. Phase 4 (resilience) may proceed.
