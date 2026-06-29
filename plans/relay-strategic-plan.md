# Relay Service — Strategic Plan

**Date:** 2026-06-28
**Status:** Draft — open questions resolved
**Companion document:** [relay-implementation-plan.md](./relay-implementation-plan.md)

---

## Goals

### 1. Deliver a privacy-preserving notification relay that never links cards to devices

The relay must be the blind bridge the spec describes: it knows UUID → push token or WebSocket slot, but never sees a card hash, message content, or which cards a device holds. The privacy model — where neither the relay nor the wallet service alone can link a card to a device — must be an explicit design constraint honored at every layer of the implementation, not just in the spec. Critically, UUID associations must never be written to disk in any form, including database write-ahead logs, persistence snapshots, or OS swap.

### 2. Implement both delivery modes correctly and robustly

Push (APNs/FCM) and WebSocket delivery are both required. Each mode has distinct failure paths, lifetime management for UUIDs, and interaction with the device's UUID pools. The implementation must handle the full lifecycle — registration, delivery, teardown, and replenishment signaling — without data races or UUID reuse.

### 3. Produce a spec that closes open holes before code is written

`notification_relay.md` leaves several engineering questions open — most critically, how the relay knows which wallet service to connect to for WebSocket bridging, and how push credentials are managed across multiple apps. The spec phase exists to answer these questions with enough precision that implementation can proceed without ambiguity.

### 4. Establish a testable, deployable service that integrates cleanly with the existing TypeScript codebase

Other services in this project (verifier, message routing) are TypeScript/Node.js. The relay should fit the same stack and be runnable standalone for local development via Docker Compose. A clear container configuration should make it deployable alongside a wallet service with minimal operator effort.

---

## Rationale

**Why spec first?** The notification relay spec (v0.1) is a clean description of intent, but it underspecifies several engineering-critical decisions — particularly around WebSocket proxying and credential management. Writing code against an underspecified design produces a service that satisfies the spec as written while silently violating its intent.

**Why plain Node.js (`node:http` + `ws`)?** The existing codebase is TypeScript. The relay has four endpoints and a small, well-defined routing surface — a framework adds dependencies without meaningful benefit. `node:http` handles HTTP; `ws` handles WebSocket upgrades directly. Keeping the dependency tree thin makes the service easier to audit, easier to understand, and reduces supply-chain risk. `tsx` is used for development; `tsc` compiles to `dist/` for production.

**Why must the relay be a long-running process, not serverless?** WebSocket connections are long-lived and stateful. Serverless targets (Lambda, Cloudflare Workers) do not support persistent WebSocket connections. The relay must be deployed as a long-running Node.js process. This also makes in-process and Redis state coherent across requests.

**Why is UUID lifetime management the central privacy concern?** Single-use UUIDs are the core privacy primitive. A UUID association persisted to disk — even temporarily, even in a write-ahead log — can be recovered after deletion by an adversary with disk access. UUID associations must exist only in RAM. The two-layer storage architecture below is designed specifically around this constraint.

---

## Storage Architecture

The relay uses two storage layers with different privacy properties and durability requirements.

### Layer 1: Redis (in-memory, no persistence) — UUID associations

`uuid → { app_id, push_token, wallet_ws_url, status }`

Redis runs in its own Docker container with persistence **explicitly disabled** (`--save "" --appendonly no`). UUID associations exist only in RAM. They are never written to disk by Redis, never swapped by the OS (Redis is configured to avoid swap), and are gone the moment they are deleted or Redis restarts.

Redis running in a separate container from the Node.js service means that **Node.js restarts do not wipe UUID state**. This is the primary operational benefit of the container split: deploys, crashes, and config changes in the relay service are invisible to devices with active UUID pools.

UUID associations are lost only when the Redis container itself restarts — an infrequent event (Redis upgrades, host reboots). This is handled by the device re-registration flow below.

### Layer 2: SQLite on a Docker volume — device registry

`push_token → { app_id, last_registered_at }`

SQLite runs embedded in the Node.js container, backed by a Docker volume that persists across container restarts. This layer records which devices have registered with the relay, so that if Redis restarts and UUID state is lost, the relay can reach devices and ask them to re-register.

Push tokens are less sensitive than UUID associations: they identify delivery addresses, not card relationships; APNs and FCM already hold them; and the device chose to register with this relay. Persisting push tokens to enable re-registration notification is an acceptable tradeoff. The registry stores only `(push_token, app_id, last_registered_at)` — no UUID associations, no wallet URLs, no card-linkable data.

Records older than **90 days** are pruned on a weekly schedule. A device that hasn't re-registered in 90 days is assumed to have uninstalled or permanently migrated.

### Re-registration on Redis restart

On startup, if the relay detects that its Redis UUID store is empty (indicating a Redis restart), it:

1. Queries the SQLite device registry for all devices registered within the last 90 days
2. Sends each a silent push notification via APNs or FCM:
   ```json
   { "type": "relay_reregistration_requested", "relay_id": "<relay_id>" }
   ```
3. The device app receives this silently, triggers a background `POST /register` call to replenish UUID pools for all its cards, and re-registers those UUIDs with the wallet service

No user-visible notification is shown. The process is fully automated. The window between Redis restart and device re-registration is the only period during which push delivery for affected cards may fail; the wallet service's retry-with-next-UUID behavior covers this gracefully.

### Docker Compose topology

```
relay (Node.js container — node:http + ws)
  └── mounts: /data/registry.db → db volume (SQLite device registry)
  └── connects to: redis container (UUID associations)

redis (Redis container, in-memory only)
  └── no volume mount
  └── started with --save "" --appendonly no

db (Docker volume)
  └── mounted into relay container at /data/
```

---

## App Registry

The relay serves multiple apps (wallet service deployments). Each app is identified by an `app_id` supplied by the device at registration time. The relay maps `app_id` to:

- **APNs or FCM credentials** — for push delivery
- **Wallet service WebSocket URL** — for WebSocket bridging (`wss://wallet.example/ws/{uuid}`)

This registry is loaded from a config file at startup (e.g. `config/apps.json`). It does not change at runtime. Adding a new app requires a config update and service restart.

When a device calls `POST /register`, it supplies its `app_id`, push token, and optional count. The relay looks up the app, generates UUIDs, and stores each one mapped to `{ app_id, push_token, wallet_ws_url, status }` in Redis. UUIDs are untyped — both fields are stored on every record regardless of how the device ultimately uses each UUID.

---

## Key Objectives

### Goal 1: Privacy-preserving design
- UUID associations stored only in Redis (in-memory, no persistence) — never written to disk in any form, including WAL, AOF, RDB snapshots, or OS swap.
- SQLite device registry stores only `(push_token, app_id, last_registered_at)` — no UUID associations, no wallet URLs.
- `POST /register` accepts only a push token and `app_id` — no card identifier, device identifier, or user identifier.
- WebSocket bridging adds no identifying information to the proxied connection.

### Goal 2: Both delivery modes, full lifecycle
- `POST /register` generates a single pool of untyped UUIDs (1–100, default 10) and returns them to the device. The device allocates UUIDs between push and WebSocket use.
- `POST /notify/{uuid}` delivers a silent push via APNs or FCM within 2 seconds under normal conditions.
- `wss://relay/ws/{uuid}` establishes a bidirectional bridge to the wallet service; bytes flow without inspection.
- UUID is consumed on use, on connection close, or on failure — never left in an ambiguous state.
- All failure cases from `notification_relay.md` §Failure Handling are implemented with documented behavior.

### Goal 3: Spec completeness
- API spec document (`relay/docs/api-spec.md`) covers all endpoints, payloads, error codes, and UUID lifecycle transitions.
- Data model document (`relay/docs/data-model.md`) covers Redis key schema, SQLite schema, and UUID state machine.
- No engineering decisions remain open when Phase 1 is complete.

### Goal 4: Testable, deployable service
- Unit tests cover UUID lifecycle state machine (all state transitions and failure paths).
- Integration tests cover push delivery path (mocked APNs/FCM) and WebSocket bridging (two local processes).
- `docker-compose.yml` runs the relay alongside a stub wallet service for local development.
- README documents env vars, app registry config format, startup, and how to connect a wallet service.

---

## Resolved Questions

| Question | Resolution |
|---|---|
| How does relay know wallet service URL? | Device supplies `app_id` at registration; relay maps `app_id → wallet_ws_url` from config |
| UUID storage backend? | Redis in-memory (no persistence), separate container from Node.js |
| APNs/FCM credential management? | Per-app credentials in config file, loaded at startup; `app_id` selects credentials |
| Deployment model? | Docker Compose: `relay` (plain Node.js + `ws`), `redis` (in-memory), `db` volume (SQLite) |
| What if Redis restarts? | Device registry in SQLite; startup re-registration notification to all recently-seen devices |
| Why not AOF/RDB persistence for Redis? | AOF logs UUID associations to disk; associations must exist only in RAM — persistence explicitly rejected on privacy grounds |
| Why not serverless? | WebSocket connections require a long-running process; Lambda/Workers cannot support them |
