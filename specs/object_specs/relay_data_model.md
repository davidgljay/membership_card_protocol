# Notification Relay — Data Model Spec

**Version:** 0.2 (draft)
**Date:** 2026-06-28
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Redis — UUID Store](#2-redis--uuid-store)
   - 2.1 [Key Schema](#21-key-schema)
   - 2.2 [UUID Record Fields](#22-uuid-record-fields)
   - 2.3 [TTL and Expiry](#23-ttl-and-expiry)
   - 2.4 [Atomic Transitions](#24-atomic-transitions)
   - 2.5 [Startup Scan for Stuck Active UUIDs](#25-startup-scan-for-stuck-active-uuids)
   - 2.6 [Empty-Store Detection](#26-empty-store-detection)
3. [SQLite — Device Registry](#3-sqlite--device-registry)
   - 3.1 [Schema](#31-schema)
   - 3.2 [Operations](#32-operations)
   - 3.3 [Pruning](#33-pruning)
4. [App Registry Config](#4-app-registry-config)
   - 4.1 [JSON Schema](#41-json-schema)
   - 4.2 [Example](#42-example)
   - 4.3 [Validation Rules](#43-validation-rules)
5. [UUID State Machine](#5-uuid-state-machine)
   - 5.1 [States](#51-states)
   - 5.2 [Transitions](#52-transitions)
   - 5.3 [Invalid Transitions](#53-invalid-transitions)
6. [Environment Variables](#6-environment-variables)

---

## 1. Overview

The relay uses two storage systems with deliberately different durability characteristics, chosen to match the privacy requirements of each data type:

| Store | Technology | Durability | Data stored | Why |
|---|---|---|---|---|
| UUID store | Redis (in-memory, no persistence) | RAM only — cleared on Redis restart | UUID → delivery target | UUID associations must never touch disk |
| Device registry | SQLite (Docker volume) | Durable — survives all restarts | Push token → app, last seen | Required for re-registration notification after Redis restart |

A third data source — the **app registry** — is a JSON config file loaded at startup. It is not a database; it is static configuration.

---

## 2. Redis — UUID Store

### 2.1 Key Schema

Each UUID is stored as a Redis hash under the key:

```
uuid:{uuid}
```

Where `{uuid}` is a UUID v4 string in lowercase hyphenated format (e.g. `uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479`).

No other key namespaces are used in Redis. The relay does not share a Redis instance with other services.

### 2.2 UUID Record Fields

Each UUID key is a Redis hash with the following fields:

| Field | Type | Description |
|---|---|---|
| `app_id` | string | App identifier; references the app registry |
| `push_token` | string | Platform push token for the device; used when the UUID is presented to `/notify/{uuid}` |
| `wallet_ws_url` | string | Base WebSocket URL of the wallet service; used when the UUID is presented to `/ws/{uuid}` |
| `status` | string | `"unused"`, `"in_flight"`, `"active"`, or `"consumed"` |
| `created_at` | string | ISO 8601 UTC timestamp of UUID creation |

UUIDs are untyped — both `push_token` and `wallet_ws_url` are stored on every record. The endpoint the UUID is presented to determines which field is used. This allows the device to freely allocate UUIDs between push delivery and WebSocket use without the relay enforcing a split.

**Why `wallet_ws_url` is stored per-UUID:** The app registry is mutable (reloaded on restart). Storing the wallet URL at registration time ensures that in-flight UUIDs always resolve to the correct endpoint, even if the app config changes between registration and use.

### 2.3 TTL and Expiry

Every UUID key is created with a TTL of **30 days** (2,592,000 seconds). Redis auto-expires the key after this period with no intervention required.

TTL is set at creation time via `HSET` + `EXPIRE` (or `HSET` with `EX` in Redis 7+). TTL is not refreshed on read or state transition. A UUID that is never used expires naturally after 30 days.

### 2.4 Atomic Transitions

UUID state transitions must be atomic to prevent race conditions (e.g. two simultaneous calls to `POST /notify/{uuid}` both reading `unused` and both proceeding). All transitions are implemented as a **Lua script** executed via Redis `EVAL`:

```lua
-- Args: KEYS[1] = uuid key, ARGV[1] = expected current status, ARGV[2] = new status
local current = redis.call('HGET', KEYS[1], 'status')
if current == false then
  return {err = 'NOT_FOUND'}
end
if current ~= ARGV[1] then
  return {err = 'WRONG_STATUS:' .. current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 'OK'
```

The script returns:
- `'OK'` — transition succeeded
- `{err = 'NOT_FOUND'}` — UUID key does not exist (expired or never created)
- `{err = 'WRONG_STATUS:<current>'}` — current status did not match expected; includes the actual current status for caller logging

Callers map these returns to HTTP/WebSocket error responses per the error code table in `relay.md §9`.

### 2.5 Startup Scan for Stuck Active UUIDs

On relay service startup (before accepting requests), the service scans for UUIDs in `active` status using a Redis `SCAN` cursor loop with pattern `uuid:*`. For each key found with `status == "active"`, the transition `active → consumed` is executed using the Lua script above.

The count of stuck UUIDs transitioned is logged at `WARN` level. A non-zero count indicates the previous process exited uncleanly (crash or SIGKILL during an active WebSocket session).

The scan uses `SCAN` with a `COUNT` hint of 100 (not `KEYS *`) to avoid blocking Redis.

### 2.6 Empty-Store Detection

On startup, after the stuck-UUID scan, the service checks whether the Redis store is empty by running:

```
SCAN 0 MATCH uuid:* COUNT 1
```

If the cursor returns 0 results and the returned cursor is 0 (scan complete), the store is considered empty. This triggers the re-registration notification flow (§3 of `relay.md`).

Note: a store is also empty immediately after first deployment (before any registrations). To avoid spuriously sending re-registration notifications on first deploy, the service checks the SQLite device registry for any records before sending notifications. If the device registry is also empty, no notifications are sent.

---

## 3. SQLite — Device Registry

### 3.1 Schema

```sql
CREATE TABLE IF NOT EXISTS device_registry (
  push_token        TEXT    NOT NULL PRIMARY KEY,
  app_id            TEXT    NOT NULL,
  last_registered_at TEXT   NOT NULL  -- ISO 8601 UTC, e.g. "2026-06-28T14:23:00Z"
);

CREATE INDEX IF NOT EXISTS idx_last_registered
  ON device_registry(last_registered_at);
```

The `push_token` is the primary key. A device that re-registers with the same push token updates its `last_registered_at` timestamp (upsert). If the platform rotates the device's push token, the new token is inserted as a new row; the old token is not explicitly removed (it expires naturally after 90 days via the pruning job).

No UUID associations are stored in SQLite. The only purpose of this table is to hold enough information to send a re-registration push after a Redis restart.

### 3.2 Operations

**Upsert on registration:**

```sql
INSERT INTO device_registry (push_token, app_id, last_registered_at)
VALUES (?, ?, ?)
ON CONFLICT(push_token) DO UPDATE SET
  app_id = excluded.app_id,
  last_registered_at = excluded.last_registered_at;
```

Called once per `POST /register` request, after UUID records are written to Redis.

**Query for re-registration:**

```sql
SELECT push_token, app_id
FROM device_registry
WHERE last_registered_at >= ?;  -- cutoff = now - 90 days
```

Called on startup when an empty Redis store is detected (and device registry is non-empty).

**Prune old records:**

```sql
DELETE FROM device_registry
WHERE last_registered_at < ?;  -- cutoff = now - 90 days
```

Run weekly on a randomized schedule (± up to 1 hour jitter to avoid thundering herd across instances).

### 3.3 Pruning

Records older than **90 days** are deleted. The 90-day threshold balances two concerns:

- **Too short:** legitimate users who are dormant (travel, infrequent use) are pruned and do not receive re-registration notifications after a Redis restart
- **Too long:** the device registry grows without bound; stale push tokens accumulate for uninstalled apps

90 days covers nearly all real-world dormancy patterns while keeping the registry lean. Pruning runs weekly; between runs, a small number of records older than 90 days may remain — this is acceptable.

---

## 4. App Registry Config

### 4.1 JSON Schema

The app registry is a JSON file at the path specified by the `APP_REGISTRY_PATH` environment variable. It is loaded once at startup; changes require a service restart.

```typescript
interface AppRegistryFile {
  apps: AppConfig[];
}

interface AppConfig {
  app_id:        string;          // Required. Unique identifier used in API requests.
  platform:      "apns" | "fcm"; // Required. Determines which push provider to use.
  wallet_ws_url: string;          // Required. Base wss:// URL; UUID is appended as path segment.
  apns?: {
    key_file:   string;             // Path to .p8 private key file
    key_id:     string;             // 10-character APNs key ID
    team_id:    string;             // 10-character Apple Team ID
    bundle_id:  string;             // App bundle ID (e.g. "com.example.wallet")
    sandbox?:   boolean;            // Default: true (APNs sandbox). Set false for production.
  };
  fcm?: {
    service_account_file: string;   // Path to Firebase service account JSON
  };
}
```

### 4.2 Example

```json
{
  "apps": [
    {
      "app_id": "mutual-aid-wallet",
      "platform": "apns",
      "wallet_ws_url": "wss://wallet.mutual-aid.example/ws",
      "apns": {
        "key_file": "/app/config/secrets/apns-key.p8",
        "key_id": "ABCD123456",
        "team_id": "WXYZ789012",
        "bundle_id": "org.mutualaid.wallet",
        "sandbox": false
      }
    },
    {
      "app_id": "mutual-aid-wallet-android",
      "platform": "fcm",
      "wallet_ws_url": "wss://wallet.mutual-aid.example/ws",
      "fcm": {
        "service_account_file": "/app/config/secrets/fcm-service-account.json"
      }
    }
  ]
}
```

Note that two app entries can share the same `wallet_ws_url` — iOS and Android variants of the same wallet are common.

### 4.3 Validation Rules

The service validates the registry on startup and exits with a clear error message if any of the following conditions are violated:

- `app_id` must be unique across all entries
- `platform` must be `"apns"` or `"fcm"`
- `wallet_ws_url` must be a valid `wss://` URL
- If `platform == "apns"`: `apns` object must be present with all required fields (`key_file`, `key_id`, `team_id`, `bundle_id`); credential files must exist at the specified paths; `sandbox` defaults to `true` if absent
- If `platform == "fcm"`: `fcm` object must be present; `service_account_file` must exist at the specified path
- Cross-field: `apns` object present with `platform == "fcm"` is an error (and vice versa)

---

## 5. UUID State Machine

### 5.1 States

| State | Meaning |
|---|---|
| `unused` | UUID has been issued to a device; not yet presented to the relay for delivery |
| `in_flight` | Push dispatch is in progress. Transient — prevents double-delivery under concurrent `/notify` requests. |
| `active` | UUID is currently bridging a live device ↔ wallet WebSocket session. |
| `consumed` | UUID has been permanently used (push delivered or WebSocket session closed). |

`consumed` is a terminal state. There is no transition out of `consumed`. `in_flight` is transient and should never be a resting state under normal operation; it is resolved to `consumed` or `unused` within the same request lifecycle.

### 5.2 Transitions

| From | To | Trigger | Endpoint |
|---|---|---|---|
| `unused` | `in_flight` | Push dispatch begins (atomic lock) | `POST /notify/{uuid}` |
| `in_flight` | `consumed` | Push dispatched successfully | `POST /notify/{uuid}` |
| `in_flight` | `unused` | Push dispatch failed (APNs/FCM error) | `POST /notify/{uuid}` |
| `unused` | `active` | Device WebSocket connection accepted | `GET /ws/{uuid}` on open |
| `unused` | `consumed` | Wallet service rejects outbound WebSocket | `GET /ws/{uuid}` on wallet rejection |
| `active` | `consumed` | Session teardown (device close, wallet close, network error) | `GET /ws/{uuid}` on close |
| `active` | `consumed` | Relay startup scan (unclean shutdown recovery) | Startup hook |
| `in_flight` | `consumed` | Relay startup scan (crash during push dispatch) | Startup hook |
| TTL expiry | key deleted | 30 days elapsed with no transition | Redis automatic |

### 5.3 Invalid Transitions

The Lua transition script enforces that the current status matches the expected `from` state before applying any transition. The following are explicitly invalid and return an error:

| Attempted transition | Error returned |
|---|---|
| Any → from `consumed` | `UUID_CONSUMED` (410 or WebSocket 4010) |
| `in_flight` → via a second `/notify` call | `UUID_CONSUMED` (410) — the `unused → in_flight` transition fails because status is already `in_flight` |
| `active` → `unused` | Not representable; Lua script rejects wrong-status transitions |
| Transition on unknown key | `UNKNOWN_UUID` (404 or WebSocket 4004) |

**Startup scan and `in_flight`:** If the relay crashes while a push dispatch is in progress, the UUID is left in `in_flight`. On next startup, the stuck-state scan treats `in_flight` as unrecoverable (we cannot know whether the push was delivered before the crash) and transitions it to `consumed`. This is the conservative choice: the wallet service's next `POST /notify/{uuid}` call will receive 410 and move to the next UUID in its pool.

**Note on `active` UUID startup scan:** The data model spec previously noted that `in_flight` is "push UUID only." With untyped UUIDs (v0.2+), any UUID can be used for either delivery mode. `in_flight` is still specific to the push path (`POST /notify/{uuid}` is the only endpoint that uses it); WebSocket UUIDs go directly `unused → active`. The startup scan handles both stuck states.

---

## 6. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection URL, e.g. `redis://redis:6379` |
| `DB_PATH` | No | `/data/registry.db` | Path to the SQLite device registry file |
| `APP_REGISTRY_PATH` | Yes | — | Path to the app registry JSON config file |
| `RELAY_ID` | Yes | — | Unique identifier for this relay instance, included in re-registration push payloads |
| `PORT` | No | `3000` | HTTP port the relay listens on |
| `UUID_TTL_SECONDS` | No | `2592000` | TTL for UUID records in Redis (default 30 days) |
| `DEVICE_REGISTRY_RETENTION_DAYS` | No | `90` | Age threshold for device registry pruning |
| `NODE_ENV` | No | `production` | Set to `development` for verbose logging and stub push mode |
