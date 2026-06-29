# Relay Service — Implementation Plan

**Date:** 2026-06-28
**Status:** Draft
**Strategic plan:** [relay-strategic-plan.md](./relay-strategic-plan.md)

---

## Clarification Checkpoints

Before proceeding past these points, Claude must pause and get explicit confirmation:

- **Before writing any code in Phase 2:** confirm the Phase 1 spec documents have been reviewed and approved
- **Before implementing APNs or FCM dispatch (Phase 3, Step 9):** confirm APNs credentials (`.p8` key file, team ID, bundle ID) and FCM credentials (service account JSON) are available or confirm test/stub mode is acceptable
- **Before any file deletion or schema migration:** show the plan and get confirmation
- **Before implementing the re-registration notifier (Phase 4, Step 13):** confirm the silent push payload format with the client team, since the device app must handle `relay_reregistration_requested` correctly

---

## Phase 1: Spec Completion

*Goal: Close all remaining engineering ambiguities before any code is written. Output is two documents that fully specify what will be built.*

### Step 1: Write relay API spec

**What:** Produce `specs/object_specs/relay.md` covering all three endpoints in full detail.

For each endpoint, specify:
- Method, path, request headers, request body schema (with field types, required/optional, validation rules)
- Success response schema and HTTP status
- All error responses (status code, error body, and the condition that triggers each)
- UUID lifecycle state transitions triggered by each endpoint

Endpoints to cover:
- `POST /register` — accepts `{ app_id, push_token, count? }`, returns `{ uuids: string[] }`
- `POST /notify/{uuid}` — no body; returns 200 on success, 404 if UUID unknown, 410 if UUID already consumed
- `GET /ws/{uuid}` — WebSocket upgrade; 101 on success, 404/410 on invalid UUID

Also specify:
- The `app_id` contract: what it is, how it's validated, what happens if the relay doesn't recognize it
- UUID format (standard UUID v4)
- Pool sizes (default 10 each; configurable per app in the app registry)
- Rate limiting expectations (document intent; implementation may be deferred)

**Who:** Claude

**Context needed:** `specs/process_specs/notification_relay.md` (all three process sections + failure handling table)

**Done when:** `specs/object_specs/relay.md` exists and covers all endpoints with no ambiguous fields, all error conditions have documented HTTP responses, and UUID lifecycle transitions are explicitly called out for each endpoint.

---

### Step 2: Write data model spec

**What:** Produce `specs/object_specs/relay_data_model.md` covering:

**Redis key schema:**
```
uuid:{uuid}  →  {
  app_id: string,
  push_token: string,
  wallet_ws_url: string,
  status: "unused" | "in_flight" | "active" | "consumed",
  created_at: ISO 8601
}
TTL: 30 days (auto-expire stale UUIDs)
```

UUIDs are untyped — both `push_token` and `wallet_ws_url` are stored on every record.

**UUID state machine** (enumerate all valid transitions):
- `unused` → `in_flight` (push dispatch begins, atomic lock)
- `in_flight` → `consumed` (push dispatched successfully)
- `in_flight` → `unused` (push dispatch failed — UUID may be retried)
- `unused` → `active` (WebSocket session opened)
- `active` → `consumed` (WebSocket session closed or dropped)
- Any state → deleted by TTL expiry
- Invalid transitions (e.g. `consumed` → any) and how they're handled (return 410)

**SQLite schema:**
```sql
CREATE TABLE device_registry (
  push_token TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  last_registered_at TEXT NOT NULL  -- ISO 8601
);
CREATE INDEX idx_last_registered ON device_registry(last_registered_at);
```

**App registry config schema** (`config/apps.json`):
```json
{
  "apps": [
    {
      "app_id": "string",
      "platform": "apns" | "fcm",
      "wallet_ws_url": "wss://...",
      "apns": { "key_file": "path", "key_id": "...", "team_id": "...", "bundle_id": "...", "sandbox": true },
      "fcm": { "service_account_file": "path" }
    }
  ]
}
```

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md` (Step 1 output), `specs/process_specs/notification_relay.md §UUID Pools` and `§Failure Handling`

**Done when:** `specs/object_specs/relay_data_model.md` exists with complete Redis schema, UUID state machine diagram, SQLite DDL, and app registry JSON schema. No field is left as "TBD."

---

### Phase 1 Milestone Review

**Context needed:** `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`, `specs/process_specs/notification_relay.md`

**Check:**
- Do all three process flows from `notification_relay.md` map cleanly onto the API spec endpoints? No flow step is unaddressed.
- Does the UUID state machine cover every failure case in the spec's failure handling table?
- Is the app registry schema sufficient to support both APNs and FCM apps simultaneously?
- Are there any contradictions between the API spec and the data model?

**Done when:** A one-paragraph Phase 1 summary is written to `plans/milestones/relay-phase-1-summary.md` and all contradictions (if any) are resolved in the spec documents before Phase 2 begins.

> **Checkpoint:** Pause here and present Phase 1 documents to David for review before writing any code.

---

## Phase 2: Project Scaffolding

*Goal: A working skeleton — compilable, containerized, with all dependencies wired but no business logic yet.*

### Step 3: Initialize project

**What:** Create the `/relay` directory as a plain Node.js + TypeScript project. No framework — HTTP server is `node:http`, WebSockets are handled by the `ws` package directly.

Files to produce:
```
relay/
  package.json          — ioredis, better-sqlite3, node-apn, firebase-admin, ws, @types/ws, typescript, tsx, vitest
  tsconfig.json         — strict TypeScript, NodeNext modules, outDir: dist
  src/
    server.ts           — creates http.Server, mounts router, starts listening
    router.ts           — minimal request router: matches method + path, extracts params
    routes/
      register.ts       — POST /register stub (returns 501)
      notify.ts         — POST /notify/:uuid stub (returns 501)
      ws.ts             — GET /ws/:uuid WebSocket upgrade stub (returns 501)
      health.ts         — GET /health stub (returns 501)
    utils/
      storage/
        redis.ts        — UuidRecord type + get/set/transition functions (stubbed)
        sqlite.ts       — DeviceRecord type + upsert/query/prune functions (stubbed)
      push/
        apns.ts         — sendApnsPush stub
        fcm.ts          — sendFcmPush stub
        dispatch.ts     — dispatchPush stub (routes to apns or fcm)
      apps.ts           — AppConfig type + loadAppRegistry stub
      reregistration.ts — sendReregistrationNotifications stub
  .env.example          — REDIS_URL, APP_REGISTRY_PATH, DB_PATH, RELAY_ID, PORT, NODE_ENV
  .gitignore
```

The router is hand-rolled — approximately 30 lines. It matches `method + pathname`, extracts a single path parameter (`:uuid`), and calls the matching handler. No routing library needed for four routes.

`tsx` is used for development (`tsx watch src/server.ts`); production runs compiled JS from `dist/`.

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`

**Done when:** `cd relay && npm install && npm run build` completes without errors. `npm start` starts the server. All route stubs return 501. TypeScript compiles with no errors.

---

### Step 4: Set up Docker Compose

**What:** Produce `relay/docker-compose.yml` and `relay/Dockerfile`.

`docker-compose.yml` services:
- **`relay`** — builds from `./Dockerfile`; mounts `./config:/app/config` (app registry) and `db_data:/data` (SQLite); env vars from `.env`; depends on `redis`
- **`redis`** — `redis:7-alpine`; command: `redis-server --save "" --appendonly no --maxmemory-policy noeviction`; no volume mount

`Dockerfile`:
- Multi-stage: `node:20-alpine` build stage (`npm run build` → `tsc`), minimal runtime stage
- Copies `dist/` and `node_modules/` to runtime image
- Sets `NODE_ENV=production`
- Exposes port 3000

`relay/docker-compose.dev.yml` (development override):
- Mounts source and runs `tsx watch src/server.ts` for hot reload
- Adds `redis-commander` or similar for Redis inspection during development

**Who:** Claude

**Context needed:** Step 3 output, `plans/relay-strategic-plan.md §Docker Compose topology`

**Done when:** `docker compose up` starts both containers without errors. `curl http://localhost:3000/register` returns 501.

---

### Step 5: Wire Redis and SQLite clients

**What:** Implement the storage utility layer (no UUID business logic yet — just connection management and typed CRUD).

`relay/utils/storage/redis.ts`:
- Creates `ioredis` client from `REDIS_URL` env var
- Exports `getUuid(uuid)`, `setUuid(uuid, record, ttlSeconds)`, `deleteUuid(uuid)`, `transitionUuid(uuid, from, to)` — all typed against `UuidRecord`
- `transitionUuid` is atomic (Lua script): reads current status, rejects if not `from`, sets to `to`, returns success/failure
- Exports `isStoreEmpty()` — returns true if Redis has no `uuid:*` keys (used by startup re-registration check)

`relay/utils/storage/sqlite.ts`:
- Opens SQLite at `DB_PATH` env var (defaults to `/data/registry.db`)
- Runs schema migration on startup (CREATE TABLE IF NOT EXISTS)
- Exports `upsertDevice(push_token, app_id)`, `getRecentDevices(since: Date)`, `pruneOldDevices(before: Date)`

**Who:** Claude

**Context needed:** `specs/object_specs/relay_data_model.md` (Redis schema, SQLite schema, UUID state machine), Step 3 output

**Done when:** Unit tests for `transitionUuid` pass against a real Redis instance (Docker). Unit tests for SQLite CRUD pass. Both clients handle connection errors gracefully (log and throw, not silent swallow).

---

### Step 6: Implement app registry loader

**What:** Implement `relay/utils/apps.ts`.

- Reads `APP_REGISTRY_PATH` env var (path to `apps.json`)
- Validates config against the schema defined in `specs/object_specs/relay_data_model.md`; throws on startup if invalid
- Exports `getApp(app_id: string): AppConfig | null`
- Exports `getAllApps(): AppConfig[]` (used by re-registration notifier)

**Who:** Claude

**Context needed:** `specs/object_specs/relay_data_model.md §App registry config schema`, `relay/config/apps.json` (example file created here with one stub app entry)

**Done when:** `getApp('unknown')` returns null. `getApp` with a valid `app_id` returns the full config object. Invalid `apps.json` (missing required field) causes process to exit with a clear error message on startup.

---

### Phase 2 Milestone Review

**Context needed:** Step 3–6 outputs, `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`

**Check:**
- Does `docker compose up` start cleanly with no errors?
- Do all typed interfaces in `utils/` match the schemas in the data model spec exactly?
- Does the app registry loader reject invalid configs at startup?
- Are connection errors in Redis and SQLite surfaced (not silently swallowed)?

**Done when:** Summary written to `plans/milestones/relay-phase-2-summary.md`. All interfaces verified consistent with data model spec.

---

## Phase 3: Core Endpoints

*Goal: All three endpoints fully implemented and manually testable.*

### Step 7: Implement `POST /register`

**What:** Full implementation of `relay/routes/register.post.ts`.

Logic:
1. Parse and validate request body: `{ app_id, push_token, count? }`. Return 400 on validation failure.
2. Look up app config via `getApp(app_id)`. Return 404 if unknown.
3. Parse `count` (default 10). Return 400 `INVALID_COUNT` if present but outside range 1–100.
4. Generate `count` UUIDs (UUID v4, `crypto.randomUUID()`).
5. For each UUID, call `setUuid(uuid, { app_id, push_token, wallet_ws_url, status: 'unused', created_at }, ttlSeconds)` in Redis. TTL = 30 days. `wallet_ws_url` comes from the app config.
6. Upsert device into SQLite registry: `upsertDevice(push_token, app_id)`.
7. Return `{ uuids }`.

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md §POST /register`, `relay/utils/storage/redis.ts`, `relay/utils/storage/sqlite.ts`, `relay/utils/apps.ts`

**Done when:** `curl -X POST /register -d '{"app_id":"test","push_token":"abc","count":20}'` returns 200 with a single array of 20 UUIDs. Omitting `count` returns 10. `count: 101` returns 400 `INVALID_COUNT`. Unknown `app_id` returns 404. Redis contains the correct number of `uuid:*` keys.

---

### Step 8: Implement `POST /notify/{uuid}`

**What:** Full implementation of `relay/routes/notify/[uuid].post.ts`.

Logic:
1. Extract `uuid` from path param. Validate it's a valid UUID v4 format; return 400 if not.
2. Call `getUuid(uuid)`. Return 404 `UNKNOWN_UUID` if null, 410 `UUID_CONSUMED` if `status !== 'unused'`.
3. Atomically transition `unused → in_flight` via Lua script. If transition fails (concurrent request won the race), return 410.
4. Look up app config via `getApp(record.app_id)`.
5. Call `dispatchPush(record.push_token, uuid, app)` — sends silent push with payload `{ uuid }`.
6. On successful dispatch: call `transitionUuid(uuid, 'in_flight', 'consumed')`. Return 200.
7. On APNs/FCM error: call `transitionUuid(uuid, 'in_flight', 'unused')`. Return 502 — UUID is not consumed, wallet service may retry.

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md §POST /notify/{uuid}`, `specs/object_specs/relay_data_model.md §UUID state machine`, `relay/utils/push/dispatch.ts`, `relay/utils/storage/redis.ts`

**Done when:** With a stub push dispatcher that always succeeds, calling `/notify/{uuid}` returns 200 and the UUID status in Redis transitions to `consumed`. A second call to the same UUID returns 410. Unknown UUID returns 404.

---

### Step 9: Implement push dispatch (APNs + FCM)

**What:** Implement `relay/utils/push/apns.ts`, `relay/utils/push/fcm.ts`, and `relay/utils/push/dispatch.ts`.

`apns.ts`:
- Initializes `node-apn` provider from app config (`key_file`, `key_id`, `team_id`, `bundle_id`)
- `sendApnsPush(push_token, uuid)` — sends silent notification (`content-available: 1`, no `alert`, payload `{ uuid }`)
- Returns success/failure; throws on unrecoverable error

`fcm.ts`:
- Initializes `firebase-admin` from app config (`service_account_file`)
- `sendFcmPush(push_token, uuid)` — sends data-only message (`data: { uuid }`, no `notification` block)
- Returns success/failure; throws on unrecoverable error

`dispatch.ts`:
- Routes to `sendApnsPush` or `sendFcmPush` based on `app.platform`

> **Checkpoint:** Pause before implementing this step. Confirm APNs sandbox credentials (`.p8` key, team ID, bundle ID) and FCM credentials are available, or confirm that stub/mock mode is acceptable for now. APNs defaults to sandbox (`sandbox: true` in app config).

**Who:** Claude

**Context needed:** `specs/object_specs/relay_data_model.md §App registry config schema`, `relay/utils/apps.ts`, Step 8 output

**Done when:** With a real (or sandbox) APNs/FCM credential, a push is delivered to a test device. With missing credentials, the service starts in stub mode and logs a warning rather than crashing.

---

### Step 10: Implement WebSocket bridge (`GET /ws/{uuid}`)

**What:** Full implementation of `relay/routes/ws/[uuid].ts`.

Logic:
1. On connection open (`open` hook):
   a. Extract `uuid` from path. Validate format; close with 4000 if invalid.
   b. Call `getUuid(uuid)`. Close with 4004 if null, 4010 if `status !== 'unused'`.
   c. Call `transitionUuid(uuid, 'unused', 'active')`.
   d. Open outbound WebSocket to `record.wallet_ws_url` using the `ws` package: `new WebSocket(wallet_ws_url)`.
   e. Store `peer.id → walletSocket` in a module-level Map.
   f. Forward wallet socket messages to the device peer. Forward device peer messages to wallet socket.
   g. On wallet socket error or close: close the device peer connection; call `transitionUuid(uuid, 'active', 'consumed')`.

2. On message from device (`message` hook):
   - Forward raw bytes to wallet socket.

3. On device connection close (`close` hook):
   - Close wallet socket.
   - Call `transitionUuid(uuid, 'active', 'consumed')`.
   - Remove from peer Map.

Implementation note: the HTTP server in `server.ts` handles the WebSocket upgrade explicitly — on `upgrade` event, confirm the path matches `/ws/:uuid`, then hand off to the `ws` `WebSocket.Server` via `handleUpgrade`. Both the inbound device socket and the outbound wallet socket are plain `ws` `WebSocket` instances.

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md §GET /ws/{uuid}`, `specs/object_specs/relay_data_model.md §UUID state machine`, `relay/src/utils/storage/redis.ts`, `ws` package docs

**Done when:** With two local processes (a stub wallet service and a test client), messages flow bidirectionally through the relay. Closing the device connection closes the wallet socket. UUID status transitions to `consumed` after close. A second connection attempt with the same UUID is rejected.

---

### Phase 3 Milestone Review

**Context needed:** Step 7–10 outputs, `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`

**Check:**
- Does each endpoint's behavior match the API spec exactly (status codes, error bodies, state transitions)?
- Do all UUID state transitions follow the state machine in the data model spec?
- Does the WebSocket bridge correctly close both sides on any single-side disconnect?
- Are there any conditions where a UUID could be left in `active` state indefinitely (e.g. wallet socket connects but device never sends)?

**Done when:** Summary written to `plans/milestones/relay-phase-3-summary.md`. Any state machine gaps identified are fixed before Phase 4.

---

## Phase 4: Resilience

*Goal: All failure cases from the spec are handled; Redis restart recovery is implemented.*

### Step 11: Implement failure cases from spec

**What:** Audit each row of the `notification_relay.md §Failure Handling` table and confirm it is handled. Add any missing behavior.

| Scenario | Expected behavior | Where to implement |
|---|---|---|
| UUID pool exhausted at wallet | Wallet retries with next UUID; relay returns 404/410; no relay change needed | Covered by Step 8 |
| Relay unreachable | Wallet retries with backoff; relay returns 502 on push error without consuming UUID | Step 8 |
| WebSocket dropped mid-session | Both sides closed; UUID consumed; device falls back to push path | Step 10 |
| Push token rotated | Device re-registers with new token; old UUIDs expire naturally via TTL | TTL in Step 7 |
| UUID rejected (used or unknown) | 404 or 410 returned; wallet skips to next UUID | Steps 8 and 10 |

Write a test for each row confirming correct behavior.

**Who:** Claude

**Context needed:** `specs/process_specs/notification_relay.md §Failure Handling`, Phase 3 outputs

**Done when:** Each failure scenario has a corresponding test that passes. No scenario is left untested.

---

### Step 12: Implement UUID TTL and stale state cleanup

**What:** Confirm TTL behavior in Redis and add a startup check for stuck `active` UUIDs.

- Verify that Redis TTL auto-expires `uuid:*` keys after 30 days (test with a short TTL in test mode).
- On startup: scan for any UUIDs in `active` state (indicating a crash mid-session) and transition them to `consumed`. Log the count — this is a signal that the previous process exited uncleanly.

**Who:** Claude

**Context needed:** `relay/utils/storage/redis.ts`, `specs/object_specs/relay_data_model.md §UUID state machine`

**Done when:** Startup scan runs and logs results. A UUID artificially set to `active` in Redis is detected and consumed on next startup. TTL expiry is confirmed by test.

---

### Step 13: Implement startup re-registration notifier

**What:** Implement `relay/utils/reregistration.ts` and wire it into the Nitro startup hook.

Logic (runs once on startup, after Redis and SQLite clients are initialized):
1. Call `isStoreEmpty()` — if Redis has UUID keys, nothing to do (normal startup).
2. If empty (Redis was restarted): query SQLite for all devices with `last_registered_at > now - 90 days`.
3. For each device: look up app config, call `dispatchPush(push_token, null, app)` with a special payload:
   ```json
   { "type": "relay_reregistration_requested", "relay_id": "<RELAY_ID env var>" }
   ```
4. Log the count of devices notified. Failures for individual devices are logged but do not halt the process.

Wire into `relay/plugins/startup.ts` (Nitro plugin, runs on server start).

> **Checkpoint:** Pause before implementing. Confirm the `relay_reregistration_requested` payload format with the client team — the device app must handle this message type to trigger automated re-registration.

**Who:** Claude

**Context needed:** `relay/utils/storage/redis.ts (isStoreEmpty)`, `relay/utils/storage/sqlite.ts (getRecentDevices)`, `relay/utils/push/dispatch.ts`, `plans/relay-strategic-plan.md §Re-registration on Redis restart`

**Done when:** On startup with an empty Redis store and a populated SQLite registry, re-registration pushes are dispatched to all registered devices within the last 90 days. On startup with a populated Redis store, no pushes are sent.

---

### Step 14: SQLite pruning job

**What:** Add a weekly pruning job that deletes device registry records older than 90 days.

Use Nitro's `scheduledTasks` (if available in the Node.js preset) or a simple `setInterval` on startup (once per week, with jitter to avoid thundering herd on multi-instance deployments).

**Who:** Claude

**Context needed:** `relay/utils/storage/sqlite.ts (pruneOldDevices)`

**Done when:** With a device record manually inserted with `last_registered_at` older than 90 days, the pruning job removes it on next run. Pruning logs the count of removed records.

---

### Phase 4 Milestone Review

**Context needed:** Phase 3 and 4 outputs, `specs/process_specs/notification_relay.md §Failure Handling`

**Check:**
- Is every failure scenario from the spec table covered by a test?
- Does the startup scan correctly identify and resolve stuck `active` UUIDs?
- Does the re-registration notifier fire correctly on empty-Redis startup and skip correctly on normal startup?
- Is the pruning job confirmed to run and produce correct results?

**Done when:** Summary written to `plans/milestones/relay-phase-4-summary.md`.

---

## Phase 5: Testing

*Goal: Confidence that the service behaves correctly under normal and failure conditions.*

### Step 15: Unit tests — UUID lifecycle

**What:** `relay/tests/unit/uuid-lifecycle.test.ts`

Test all state machine transitions:
- `unused → consumed` (push delivery)
- `unused → active` (WebSocket open)
- `active → consumed` (WebSocket close)
- Reject `consumed → any`
- Reject `active → active`
- Reject unknown UUID (return null, not throw)
- `transitionUuid` atomicity: two concurrent transitions of the same UUID, only one succeeds

Uses real Redis (Docker); not mocked.

**Who:** Claude

**Context needed:** `relay/utils/storage/redis.ts`, `specs/object_specs/relay_data_model.md §UUID state machine`

**Done when:** All tests pass. `npm run test` runs the suite in under 10 seconds.

---

### Step 16: Integration tests — push delivery

**What:** `relay/tests/integration/push-delivery.test.ts`

Test the full `POST /register` → `POST /notify/{uuid}` path with a mocked push dispatcher (replace `dispatchPush` with a stub that records calls).

Scenarios:
- Successful registration and notification delivery
- Notification UUID consumed after successful delivery
- Second notification attempt on consumed UUID returns 410
- Push dispatcher failure: UUID not consumed, 502 returned
- Unknown UUID: 404 returned
- Invalid UUID format: 400 returned

**Who:** Claude

**Context needed:** Phase 3 output, `specs/object_specs/relay.md`

**Done when:** All scenarios have passing tests. Push dispatcher is injectable (not hard-coded) to support stubbing.

---

### Step 17: Integration tests — WebSocket bridge

**What:** `relay/tests/integration/websocket-bridge.test.ts`

Spin up a stub wallet service (simple `ws` server) and test the full bridging path.

Scenarios:
- Device connects → relay connects to wallet → messages flow device → wallet
- Messages flow wallet → device
- Device disconnects → wallet socket closes → UUID consumed
- Wallet socket closes → device connection closes → UUID consumed
- Invalid UUID: connection rejected with close code 4004
- Already-consumed UUID: connection rejected with close code 4010
- UUID previously used for push notification: connection rejected with close code 4010 (already consumed)

**Who:** Claude

**Context needed:** Phase 3 output, `specs/object_specs/relay.md §GET /ws/{uuid}`

**Done when:** All scenarios have passing tests. Stub wallet service is a reusable test fixture.

---

### Phase 5 Milestone Review

**Context needed:** Phase 5 test outputs

**Check:**
- Do all unit and integration tests pass in CI (GitHub Actions or equivalent)?
- Is test coverage sufficient for the UUID state machine? (Every edge in the state diagram is exercised.)
- Are there any test gaps that would leave a failure scenario from the spec table untested?

**Done when:** Summary written to `plans/milestones/relay-phase-5-summary.md`. Test suite passes cleanly.

---

## Phase 6: Documentation

### Step 18: Write README

**What:** `relay/README.md` covering:
- What the relay does (one paragraph, referencing `notification_relay.md`)
- Prerequisites (Docker, Node.js 20+)
- Local development: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`
- Environment variables (table: name, description, required/optional, default)
- App registry config format (annotated example `apps.json`)
- How to connect a wallet service (what URL to configure, what to expect)
- How to add a new app
- Privacy properties and what data is and is not persisted

**Who:** Claude

**Context needed:** `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`, `plans/relay-strategic-plan.md §Storage Architecture`



**Done when:** A developer unfamiliar with the relay can follow the README to run the service locally and send a test notification without reading any other document.

---

### Step 19: Final verification

**What:** End-to-end smoke test using `docker compose up`:
1. Start relay + Redis via Docker Compose
2. `POST /register` with a test app — confirm 200 and UUID pools returned
3. `POST /notify/{uuid}` with a notification UUID — confirm 200 and push delivered (stub mode)
4. Open WebSocket to `/ws/{uuid}` with a WebSocket UUID — confirm connection bridges to stub wallet service
5. Restart the relay container — confirm Redis retains UUID state
6. Restart the Redis container — confirm startup re-registration notifier fires

**Who:** Claude + David (confirm push arrives on a real device if credentials are available)

**Context needed:** All Phase 1–6 outputs, a real or sandbox APNs/FCM credential (or confirmed stub mode)

**Done when:** All six smoke test steps pass. Any failures are fixed before marking the plan complete.
