# Notification Relay — Service Spec

**Version:** 0.3 (draft)
**Date:** 2026-06-28
**Status:** Draft
**Changes from v0.2:** UUIDs are no longer typed. `POST /register` returns a single `uuids` array instead of separate `notification_uuids` and `websocket_uuids` arrays. Any UUID may be used at either `/notify/{uuid}` or `/ws/{uuid}`. The `type` field is removed from UUID records. `WRONG_UUID_TYPE` error code removed. The device allocates UUIDs between push delivery and WebSocket use as it sees fit.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Relationship to Existing Specs](#2-relationship-to-existing-specs)
3. [Actors](#3-actors)
4. [Privacy Properties](#4-privacy-properties)
5. [App Registry](#5-app-registry)
6. [Endpoints](#6-endpoints)
   - 6.1 [POST /register](#61-post-register)
   - 6.2 [POST /notify/{uuid}](#62-post-notifyuuid)
   - 6.3 [GET /ws/{uuid}](#63-get-wsuuid)
   - 6.4 [GET /health](#64-get-health)
7. [UUID Lifecycle](#7-uuid-lifecycle)
8. [Re-registration on Store Reset](#8-re-registration-on-store-reset)
9. [Error Codes](#9-error-codes)
10. [Open Questions](#10-open-questions)

---

## 1. Overview

The notification relay is a stateless-by-design HTTP and WebSocket service that bridges wallet services to holder devices without allowing either party to identify the other. It supports two delivery modes:

- **Push** — a silent wake-up delivered via APNs (iOS) or FCM (Android) when the device app is backgrounded
- **WebSocket** — a low-latency bidirectional bridge when the app is in the foreground

The relay stores a mapping from opaque single-use UUIDs to delivery targets (push tokens or WebSocket slots). It does not store card identities, message content, or any data that would allow it to correlate a UUID to a card or a device to a holder.

UUID associations are held exclusively in RAM (Redis with no persistence). The relay never writes UUID-to-device mappings to disk in any form — no write-ahead log, no snapshot, no OS swap. See §4 for the full privacy model and §8 for the store-reset recovery flow.

The relay is a multi-app service: a single relay deployment serves multiple wallet service apps. Each app is identified by an `app_id` and has its own APNs or FCM credentials and wallet service WebSocket endpoint, registered in the relay's app registry (§5).

---

## 2. Relationship to Existing Specs

| Spec | Relationship |
|---|---|
| `specs/process_specs/notification_relay.md` | Process-level spec this document implements. Defines the three delivery processes, UUID pools, and privacy properties. This document specifies the service that executes those processes. |
| `specs/process_specs/message_routing.md` | Defines how wallet services route messages to recipient cards. The relay is the delivery bridge called by the wallet service after routing. |
| `specs/process_specs/wallet_backup_and_recovery.md` | Defines device registration and key management. Replenishment of UUID pools is triggered by the device and is part of the wallet backup lifecycle. |
| `specs/object_specs/relay_data_model.md` | Companion document specifying the Redis key schema, UUID state machine, SQLite device registry schema, and app registry config format. |

---

## 3. Actors

| Actor | Role |
|---|---|
| **Device** | iOS or Android client. Calls `POST /register` to obtain UUID pools. Opens WebSocket via `GET /ws/{uuid}`. Receives silent pushes triggered by `POST /notify/{uuid}`. |
| **Wallet service** | Holds the card's message queue. Calls `POST /notify/{uuid}` to trigger a push. Accepts inbound WebSocket connections from the relay proxying a device session. |
| **Relay service** | This service. Stores UUID → delivery target mappings in RAM. Never sees card identities or message content. |
| **APNs / FCM** | Platform push infrastructure. Receives delivery requests from the relay and delivers silent pushes to the device. |

---

## 4. Privacy Properties

The relay is designed so that neither the relay nor the wallet service alone can link a card to a device. The knowledge split is:

| Party | Knows | Does not know |
|---|---|---|
| Wallet service | Card hash → UUID(s) | Device identity, push token, which UUIDs belong to the same person |
| Relay service | UUID → push token or WebSocket slot | Card hash, card identity, message content |

**UUID associations must never be written to disk.** The relay stores UUID records only in Redis with persistence explicitly disabled (`--save "" --appendonly no`). Redis runs in a separate container from the Node.js process. This ensures:

- Node.js restarts (deploys, crashes) do not wipe UUID state; Redis persists across them
- Redis restarts (rarer: container upgrades, host reboots) do clear UUID state, triggering the re-registration flow (§8)

The device registry (SQLite, §8) stores only push tokens and `app_id` — no UUID associations, no wallet service URLs, no card-linkable data. It exists solely to support re-registration notification after a Redis restart.

---

## 5. App Registry

The relay serves multiple apps. Each app is a distinct wallet service deployment identified by an `app_id` string. The app registry maps `app_id` to:

| Field | Description |
|---|---|
| `app_id` | Unique string identifier supplied by the device at registration |
| `platform` | `"apns"` or `"fcm"` |
| `wallet_ws_url` | Base WebSocket URL of the wallet service (`wss://...`). The relay connects to `{wallet_ws_url}/{uuid}` when bridging a device WebSocket session. |
| `apns` | APNs credentials object (required if `platform == "apns"`): `key_file` (path to `.p8`), `key_id`, `team_id`, `bundle_id`, `sandbox` (boolean, default `true`) |
| `fcm` | FCM credentials object (required if `platform == "fcm"`): `service_account_file` (path to service account JSON) |

The registry is loaded from a JSON config file at service startup (`APP_REGISTRY_PATH` env var). It does not change at runtime. Adding or removing an app requires a config update and service restart.

If a device supplies an `app_id` that is not present in the registry, all requests referencing that `app_id` return `404 Unknown App`.

---

## 6. Endpoints

### 6.1 POST /register

Generates a device-specified number of single-use UUIDs in a single call. UUIDs are untyped — any UUID returned may be used at either `/notify/{uuid}` (push delivery, called by the wallet service) or `/ws/{uuid}` (WebSocket bridging, opened by the device). The device decides how to allocate UUIDs between these two uses and communicates that allocation to the wallet service separately.

**Privacy note:** Because all UUIDs from one call are associated with the same push token, the relay can infer that all UUIDs returned in a single registration belong to the same device. This is a deliberate tradeoff — batching reduces network overhead at the cost of the per-card session unlinkability described in `notification_relay.md §Registration Privacy`. Devices with strong privacy requirements may still make separate calls per card.

#### Request

```
POST /register
Content-Type: application/json
```

```json
{
  "app_id":     "string — required. Must match a registered app in the app registry.",
  "push_token": "string — required. Platform push token (APNs device token or FCM registration token). Opaque to the relay; passed through to APNs/FCM on delivery.",
  "count":      "integer — optional. Number of UUIDs of each type to return. Min: 1, max: 100. Default: 10."
}
```

**Validation:**
- `app_id`: required, non-empty string, must exist in the app registry
- `push_token`: required, non-empty string; format is platform-specific and not validated by the relay
- `count`: optional integer, 1–100 inclusive; defaults to 10 if absent; rejected with 400 if present but out of range

#### Response — 200 OK

```json
{
  "uuids": ["uuid-v4", "..."]
}
```

The array has length equal to `count` (default 10). All UUIDs are UUID v4 strings (RFC 4122 format, lowercase, hyphenated: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`). The device allocates these UUIDs between push delivery and WebSocket use as needed.

The relay stores each UUID in Redis with status `unused` and a TTL of 30 days.

#### State effects

- `count` new UUID records written to Redis, each with `status: "unused"` and TTL 30 days
- Device push token upserted in SQLite device registry with current timestamp

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `MISSING_FIELD` | `app_id` or `push_token` is absent or empty |
| 400 | `INVALID_COUNT` | `count` is present but outside the range 1–100 |
| 404 | `UNKNOWN_APP` | `app_id` not found in app registry |
| 500 | `INTERNAL_ERROR` | Redis write failed |

---

### 6.2 POST /notify/{uuid}

Triggers a silent push notification to the device associated with the given UUID. Called by the wallet service when a message arrives for a card whose app is backgrounded.

No request body. The wallet service does not supply card identity, message content, or any other context — only the UUID.

#### Request

```
POST /notify/{uuid}
```

`uuid`: path parameter, UUID v4 format.

#### Processing

1. Validate `uuid` format. Return 400 if not a valid UUID v4.
2. Look up UUID in Redis. Return 404 if not found.
3. Check `status == "unused"`. Return 410 if status is `consumed`, `active`, or `in_flight`.
4. Look up app config for `record.app_id`. Return 500 if app config is missing (config/Redis inconsistency).
5. Atomically transition UUID status from `unused` to `in_flight`. If the transition fails (another caller already moved the UUID out of `unused`), return 410.
6. Dispatch silent push to `record.push_token` via APNs or FCM (per app platform):
   - APNs: `content-available: 1`, no `alert`, payload `{ "uuid": "<uuid>" }`
   - FCM: data-only message (no `notification` block), data `{ "uuid": "<uuid>" }`
7. On successful dispatch: transition UUID status from `in_flight` to `consumed`. Return 200.
8. On push dispatch failure: transition UUID status from `in_flight` back to `unused`. Return 502. The wallet service may retry the same UUID or move to the next in its pool.

#### Response — 200 OK

Empty body.

#### State effects

- UUID transitions `unused → in_flight` before dispatch (atomic; prevents double-delivery)
- UUID transitions `in_flight → consumed` on successful dispatch
- UUID transitions `in_flight → unused` on failed dispatch (wallet service may retry)

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `INVALID_UUID` | `uuid` path param is not a valid UUID v4 |
| 404 | `UNKNOWN_UUID` | UUID not found in Redis |
| 410 | `UUID_CONSUMED` | UUID found but status is `"consumed"`, `"active"`, or `"in_flight"` |
| 502 | `PUSH_FAILED` | APNs or FCM returned an error; UUID not consumed |
| 500 | `INTERNAL_ERROR` | Redis read/write failed |

---

### 6.3 GET /ws/{uuid}

Upgrades the connection to a WebSocket and bridges the device to the wallet service. The relay opens a second outbound WebSocket connection to the wallet service, presenting the UUID as its credential, then forwards bytes between the two connections without inspection.

#### Upgrade request

```
GET /ws/{uuid}
Connection: Upgrade
Upgrade: websocket
```

`uuid`: path parameter, UUID v4 format.

#### Connection establishment

1. Validate `uuid` format. Close with code 4000 (`INVALID_UUID`) if not a valid UUID v4.
2. Look up UUID in Redis. Close with code 4004 (`UNKNOWN_UUID`) if not found.
3. Check `status == "unused"`. Close with code 4010 (`UUID_CONSUMED`) if status is `"consumed"`, `"active"`, or `"in_flight"`.
4. Transition UUID status from `unused` to `active`.
6. Open outbound WebSocket to the wallet service: `{app.wallet_ws_url}/{uuid}`. The wallet service validates the UUID against its own pool and accepts or rejects the connection.
7. If the wallet service rejects the outbound connection: close the device connection with code 4002 (`WALLET_REJECTED`); transition UUID to `consumed`.
8. Relay is now bridging: **device ↔ relay ↔ wallet service**.

#### Message flow

- **Device → wallet:** bytes received from the device WebSocket are forwarded to the wallet WebSocket without modification.
- **Wallet → device:** bytes received from the wallet WebSocket are forwarded to the device WebSocket without modification.

Message content is end-to-end encrypted and opaque to the relay.

#### Session teardown

Any of the following closes both sides and marks the UUID consumed:

- Device closes its connection (normal or abnormal)
- Wallet service closes its connection (normal or abnormal)
- Either side sends a WebSocket error frame
- Network error on either leg

On teardown: close the non-initiating side with code 1001 (Going Away), then transition UUID from `active` to `consumed`.

#### WebSocket close codes

| Code | Name | Condition |
|---|---|---|
| 4000 | `INVALID_UUID` | Path param is not a valid UUID v4 |
| 4002 | `WALLET_REJECTED` | Wallet service refused the outbound connection |
| 4004 | `UNKNOWN_UUID` | UUID not found in Redis |
| 4010 | `UUID_CONSUMED` | UUID status is `"consumed"`, `"active"`, or `"in_flight"` |
| 1001 | `GOING_AWAY` | Other side disconnected; this side is being closed in response |
| 1011 | `INTERNAL_ERROR` | Redis error during UUID transition |

#### State effects

- On connection accepted: UUID transitions from `unused` to `active`
- On teardown (any cause): UUID transitions from `active` to `consumed`
- On wallet rejection before bridge established: UUID transitions from `active` to `consumed` (UUID was already transitioned to `active` in step 4; wallet rejection is treated as an immediate teardown)

---

### 6.4 GET /health

Returns the operational status of the relay and its dependencies. Intended for Docker Compose `healthcheck` directives and load balancer probes.

#### Request

```
GET /health
```

No authentication required.

#### Response — 200 OK (healthy)

```json
{
  "status": "ok",
  "redis":  "ok",
  "sqlite": "ok"
}
```

#### Response — 503 Service Unavailable (degraded)

```json
{
  "status": "degraded",
  "redis":  "ok" | "error",
  "sqlite": "ok" | "error"
}
```

The relay returns 503 if either Redis or SQLite is unreachable. Each dependency reports independently, so a Redis failure does not mask a concurrent SQLite failure. The `message` field may be included under a failing dependency key with a brief error description.

The health check does not perform a deep probe (no UUID round-trip, no push dispatch). It performs a Redis `PING` and a SQLite `SELECT 1` to confirm connectivity.

---

## 7. UUID Lifecycle

A UUID moves through the following states. All transitions are atomic (Lua script in Redis) to prevent race conditions under concurrent requests.

```
             ┌─────────┐
             │ unused  │ ← created by POST /register (TTL: 30 days)
             └────┬────┘
                  │
        ┌─────────┴──────────┐
        │                    │
   push notify           websocket open
   (§6.2 step 6)        (§6.3 step 5)
        │                    │
        ▼                    ▼
  ┌───────────┐        ┌──────────┐
  │ in_flight │        │  active  │ ← device ↔ relay ↔ wallet bridge open
  └─────┬─────┘        └────┬─────┘
        │                   │
   ┌────┴────┐          session close
   │         │          (§6.3 teardown)
success   failure            │
   │         │               ▼
   │         │         ┌──────────┐
   │         └──────── │ consumed │
   │       (→ unused)  └──────────┘
   ▼
┌──────────┐
│ consumed │
└──────────┘
```

**Invalid transitions** (return error, do not change state):
- `consumed` → any: return 410 / close code 4010
- `in_flight` → any (via a concurrent second request): return 410
- `active` → any (via a `/notify` call on a UUID currently bridging a WebSocket session): return 410

**TTL expiry:** Redis auto-expires UUID keys after 30 days with no transition. No explicit cleanup is needed; the TTL covers the case of UUIDs never consumed (device uninstalled, wallet service never called).

**Stuck `active` UUIDs:** On relay startup, any UUID found in `active` state (indicating an unclean shutdown mid-session) is transitioned to `consumed`. The count is logged as an operational signal.

---

## 8. Re-registration on Store Reset

When the Redis container restarts, all UUID state is lost. The relay detects this at startup by checking whether the Redis store is empty (no `uuid:*` keys). If empty, the relay sends a silent re-registration notification to all devices registered in the last 90 days via the SQLite device registry.

**Re-registration push payload:**

```json
{ "type": "relay_reregistration_requested", "relay_id": "<RELAY_ID>" }
```

This payload is delivered as a silent push (APNs `content-available: 1`, no `alert`; FCM data-only message). The device app must handle `relay_reregistration_requested` by triggering a background call to `POST /register` for each of its cards and re-registering the new UUID pools with the wallet service. No user-visible notification is shown.

**Device registry:**

The SQLite device registry stores `(push_token, app_id, last_registered_at)` only. It does not store UUID associations. Records are pruned weekly; any record with `last_registered_at` older than 90 days is deleted.

A device is upserted into the registry on every `POST /register` call, refreshing its `last_registered_at` timestamp.

**Re-registration notification failures** for individual devices (invalid push token, device uninstalled) are logged and skipped. They do not halt the startup sequence.

---

## 9. Error Codes

Structured error responses use the following JSON shape:

```json
{ "error": "<CODE>", "message": "<human-readable detail>" }
```

| Code | HTTP status | Meaning |
|---|---|---|
| `MISSING_FIELD` | 400 | Required request field absent or empty |
| `INVALID_COUNT` | 400 | `count` field is present but outside the range 1–100 |
| `INVALID_UUID` | 400 | Path parameter is not a valid UUID v4 |
| `UNKNOWN_APP` | 404 | `app_id` not found in app registry |
| `UNKNOWN_UUID` | 404 | UUID not found in Redis |
| `UUID_CONSUMED` | 410 | UUID has already been used, is in an active WebSocket session, or is currently in_flight |
| `PUSH_FAILED` | 502 | APNs or FCM returned a delivery error |
| `WALLET_REJECTED` | — | Wallet service rejected the outbound WebSocket (WebSocket close code 4002 only) |
| `INTERNAL_ERROR` | 500 | Unexpected internal error (Redis failure, config inconsistency) |

---

## 10. Open Questions

All open questions resolved. No blocking items remain.

| ID | Resolution |
|---|---|
| ~~OQ-RLY-1~~ | **Closed.** `POST /register` accepts a device-controlled `count` field (1–100, default 10). One call yields UUIDs for all of a device's cards. Privacy tradeoff documented in §6.1. |
| ~~OQ-RLY-2~~ | **Closed — deferred.** Rate limiting is out of scope for initial implementation. Revisit before production deployment. |
| ~~OQ-RLY-3~~ | **Closed.** APNs sandbox is the default per-app (`sandbox: true`). Configurable per-app in the app registry. |
| ~~OQ-RLY-4~~ | **Closed.** `GET /health` endpoint added (§6.4). |
