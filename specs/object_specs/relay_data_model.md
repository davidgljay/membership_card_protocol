# Notification Relay — Data Model Spec

**Version:** 0.4 (draft)
**Date:** 2026-06-29
**Status:** Draft
**Changes from v0.3:** `wallet_ws_url` field renamed to `wallet_base_url` in UUID records and app registry config; value changes from `wss://` to `https://`. `WALLET_REJECTED` close code (4002) removed — relay no longer opens outbound WebSocket to wallet service. `active` UUID state now represents a device WebSocket delivery channel, not a bidirectional relay-to-wallet bridge. App registry validation rule updated accordingly.

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
3. [Redis — Message Store](#3-redis--message-store)
4. [Redis — Pending Delete Queue](#4-redis--pending-delete-queue)
5. [SQLite — Device Registry](#5-sqlite--device-registry)
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
| `push_token` | string | Platform push token for the device |
| `wallet_base_url` | string | Base HTTPS URL of the wallet service; used when sending staggered deletes (`DELETE {wallet_base_url}/messages/{uuid}`). Not used by the relay for any outbound connection to the wallet service. |
| `device_credential` | string | Opaque token shared by all UUIDs in the same registration session; authenticates `GET /sse`, `GET /pending`, and `POST /ack` |
| `status` | string | `"unused"`, `"in_flight"`, `"active"`, or `"consumed"` |
| `created_at` | string | ISO 8601 UTC timestamp of UUID creation |

UUIDs are untyped — a UUID may be used at `POST /deliver/{uuid}` (message delivery) or `GET /ws/{uuid}` (WebSocket bridging). The device allocates UUIDs between these uses without the relay enforcing a split.

**`device_credential`:** All UUIDs returned in a single `POST /register` call share the same `device_credential` value. The relay can resolve `device_credential → push_token` by looking up any UUID that carries that credential. Credentials are opaque random tokens generated alongside the UUID pool; they carry no device-identifiable information beyond the push token association already present in the UUID record.

**Why `wallet_base_url` is stored per-UUID:** The app registry is mutable (reloaded on restart). Storing the wallet URL at registration time ensures that in-flight UUIDs always resolve to the correct endpoint, even if the app config changes between registration and use.

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

## 3. Redis — Message Store

### 3.1 Key Schema

Pending message blobs are stored as a Redis list under the key:

```
messages:{push_token}
```

where `{push_token}` is the platform push token for the device. Each list entry is a JSON-encoded object:

```json
{
  "uuid":         "<delivery UUID — used as message identifier and for staggered delete>",
  "blob":         "<E2E encrypted message blob, base64url>",
  "wallet_url":   "<wallet service base URL — used for staggered delete>",
  "received_at":  "<ISO 8601 UTC timestamp>"
}
```

### 3.2 Operations

**Store a message (on `POST /deliver/{uuid}`):**

```
RPUSH messages:{push_token} <json entry>
EXPIRE messages:{push_token} <UUID_TTL_SECONDS>  -- refreshed on each push
```

**Retrieve and clear (on `GET /pending`):**

Implemented as a Lua script to atomically read and delete:

```lua
local key = KEYS[1]
local items = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return items
```

**Remove individual entry (after SSE/WebSocket delivery, before `POST /ack`):**

Not performed individually. The message store is cleared atomically on `GET /pending`. For SSE delivery, messages are removed from the store only after `POST /ack` is received; if no ack arrives (connection drop), the blob remains in the store for `GET /pending` pickup.

### 3.3 TTL

The `messages:{push_token}` key TTL is reset to `UUID_TTL_SECONDS` (default 30 days) on each `RPUSH`. A device that is offline for more than 30 days after its last received message will have its pending blobs expired by Redis. On next wake, the device calls `GET /pending`, receives an empty list, and fetches messages via re-registration and wallet retransmission.

### 3.4 Privacy Note

The message store key includes the push token in plaintext. This is consistent with the relay's existing storage of push tokens in UUID records; the relay already associates push tokens with delivery events. The message store does not add new push-token-linked data beyond what is already present in the UUID store.

---

## 4. Redis — Pending Delete Queue

### 4.1 Key Schema

Staggered wallet delete jobs are stored in a Redis sorted set:

```
pending_deletes
```

Each member is a JSON-encoded job object:

```json
{
  "wallet_url": "<wallet service base URL>",
  "uuid":       "<delivery UUID>",
  "attempts":   0
}
```

The sort score is the Unix timestamp (seconds) at which the job should be executed.

### 4.2 Operations

**Enqueue a delete job (on `POST /ack`):**

```
ZADD pending_deletes <execute_at_unix_ts> <json job>
```

where `execute_at_unix_ts = now + random(0, MAX_DELETE_DELAY_SECONDS)`.

**Dequeue ready jobs (background poll):**

```lua
-- Returns all jobs with score <= now, atomically removes them
local now = ARGV[1]
local jobs = redis.call('ZRANGEBYSCORE', 'pending_deletes', '-inf', now)
if #jobs > 0 then
  redis.call('ZREMRANGEBYSCORE', 'pending_deletes', '-inf', now)
end
return jobs
```

**Requeue on failure (exponential backoff):**

```
ZADD pending_deletes <new_execute_at> <updated_json_job>
```

Backoff schedule: `min(base_delay * 2^attempts, 86400)` seconds, where `base_delay = 300` (5 minutes) and the cap is 86400 (24 hours). `attempts` is incremented in the job JSON before requeuing.

### 4.3 Durability

The pending delete queue is held in Redis (in-memory, no persistence). Jobs lost to a relay restart are benign: the wallet service retains messages until it receives the delete call. If the call never arrives, the wallet retransmits on device UUID re-registration; the device deduplicates by message ID within the decrypted blob.

### 4.4 Background Job

A background polling loop runs on `DELETE_JOB_POLL_INTERVAL_MS` (default 60,000 ms). On each tick:

1. Dequeue all jobs with `score ≤ now` using the Lua script above.
2. For each job, call `DELETE {wallet_url}/messages/{uuid}`.
3. On success (2xx) or 404: discard the job.
4. On failure (5xx, timeout, network error): requeue with exponential backoff.

On relay shutdown (`SIGTERM`), the background job performs one final flush (best-effort, 5-second timeout) before the process exits.

---

## 5. SQLite — Device Registry

### 5.1 Schema

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

### 5.2 Operations

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

### 5.3 Pruning

Records older than **90 days** are deleted. The 90-day threshold balances two concerns:

- **Too short:** legitimate users who are dormant (travel, infrequent use) are pruned and do not receive re-registration notifications after a Redis restart
- **Too long:** the device registry grows without bound; stale push tokens accumulate for uninstalled apps

90 days covers nearly all real-world dormancy patterns while keeping the registry lean. Pruning runs weekly; between runs, a small number of records older than 90 days may remain — this is acceptable.

---

## 6. App Registry Config

### 6.1 JSON Schema

The app registry is a JSON file at the path specified by the `APP_REGISTRY_PATH` environment variable. It is loaded once at startup; changes require a service restart.

```typescript
interface AppRegistryFile {
  apps: AppConfig[];
}

interface AppConfig {
  app_id:        string;          // Required. Unique identifier used in API requests.
  platform:      "apns" | "fcm"; // Required. Determines which push provider to use.
  wallet_base_url: string;         // Required. Base https:// URL of the wallet service; used for staggered delete calls.
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

### 6.2 Example

```json
{
  "apps": [
    {
      "app_id": "mutual-aid-wallet",
      "platform": "apns",
      "wallet_base_url": "https://wallet.mutual-aid.example",
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
      "wallet_base_url": "https://wallet.mutual-aid.example",
      "fcm": {
        "service_account_file": "/app/config/secrets/fcm-service-account.json"
      }
    }
  ]
}
```

Note that two app entries can share the same `wallet_ws_url` — iOS and Android variants of the same wallet are common.

### 6.3 Validation Rules

The service validates the registry on startup and exits with a clear error message if any of the following conditions are violated:

- `app_id` must be unique across all entries
- `platform` must be `"apns"` or `"fcm"`
- `wallet_base_url` must be a valid `https://` URL
- If `platform == "apns"`: `apns` object must be present with all required fields (`key_file`, `key_id`, `team_id`, `bundle_id`); credential files must exist at the specified paths; `sandbox` defaults to `true` if absent
- If `platform == "fcm"`: `fcm` object must be present; `service_account_file` must exist at the specified path
- Cross-field: `apns` object present with `platform == "fcm"` is an error (and vice versa)

---

## 7. UUID State Machine

### 7.1 States

| State | Meaning |
|---|---|
| `unused` | UUID has been issued to a device; not yet presented to the relay for delivery |
| `in_flight` | Push dispatch in progress after blob receipt. Transient — prevents double-delivery under concurrent `/deliver` requests. |
| `active` | UUID is registered as a device WebSocket delivery channel (inbound delivery only; relay holds no outbound wallet connection). |
| `consumed` | UUID has been permanently used (blob accepted, or WebSocket session closed). |

`consumed` is a terminal state. `in_flight` is transient: it is resolved to `consumed` or `unused` within the same request lifecycle.

**Key change from v0.2:** Delivery UUIDs now transition to `consumed` when the relay accepts and stores the blob (`POST /deliver/{uuid}`), not when the device picks up the message. Message lifecycle is tracked separately in the message store (§3); UUID status is not used to track delivery to the device.

### 7.2 Transitions

| From | To | Trigger | Endpoint |
|---|---|---|---|
| `unused` | `in_flight` | Blob receipt begins (atomic lock) | `POST /deliver/{uuid}` |
| `in_flight` | `consumed` | Blob stored successfully | `POST /deliver/{uuid}` |
| `in_flight` | `unused` | Blob storage or push dispatch failed | `POST /deliver/{uuid}` |
| `unused` | `active` | Device WebSocket connection accepted | `GET /ws/{uuid}` on open |
| `active` | `consumed` | Session teardown (device close or network error) | `GET /ws/{uuid}` on close |
| `active` | `consumed` | Relay startup scan (unclean shutdown recovery) | Startup hook |
| `in_flight` | `consumed` | Relay startup scan (crash during delivery) | Startup hook |
| TTL expiry | key deleted | 30 days elapsed with no transition | Redis automatic |

### 7.3 Invalid Transitions

| Attempted transition | Error returned |
|---|---|
| Any → from `consumed` | `UUID_CONSUMED` (410 or WebSocket 4010) |
| `in_flight` → via a second `/deliver` call | `UUID_CONSUMED` (410) |
| `active` → `unused` | Rejected by Lua script |
| Transition on unknown key | `UNKNOWN_UUID` (404 or WebSocket 4004) |

**Startup scan:** `in_flight` UUIDs found on startup are transitioned to `consumed` (we cannot know if the blob was stored before the crash). `active` UUIDs are also transitioned to `consumed` (WebSocket sessions do not survive restarts). Both counts are logged at `WARN` level.

---

## 8. Device Credential Store

### 8.1 Purpose and Threat Model

The device credential authenticates the device to the relay for all device-facing endpoints: `POST /register` (replenishment), `GET /sse`, `GET /pending`, and `POST /ack`. It prevents the following attacks:

- **Message interception:** An attacker who knows the device's push token cannot drain the message store without also possessing the device credential.
- **False ack / clearance hijacking:** An attacker cannot cause the relay to schedule wallet deletes for messages the device has not received.
- **UUID registration abuse:** A `POST /register` call without a valid credential creates a new isolated credential — it cannot inject UUIDs into an existing device's pool or access its messages.

The message store is keyed by `device_credential` (not `push_token`). Two registrations with the same push token but different credentials produce isolated message stores; only the credential associated with the UUIDs the wallet actually uses will receive wallet-originated blobs.

### 8.2 Key Schema

Device credentials are stored in Redis as a hash under:

```
cred:{device_credential}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `push_token` | string | Platform push token associated with this credential |
| `app_id` | string | App identifier |
| `created_at` | string | ISO 8601 UTC timestamp |

TTL: 30 days, refreshed on every `POST /register` call that presents this credential.

### 8.3 Bootstrap vs. Replenishment

**Bootstrap (first registration):** `POST /register` with no `Authorization` header. The relay generates a new credential, stores it under `cred:{credential}`, and returns it in the response. The device must store this credential in device secure storage (iOS Keychain / Android Keystore) immediately.

**Replenishment:** `POST /register` with `Authorization: Bearer {device_credential}`. The relay validates the credential exists and is not expired, issues new UUIDs under the same credential (updating the `push_token` if it has rotated), and refreshes the credential TTL.

Attempting replenishment with an unknown or expired credential returns `401 INVALID_CREDENTIAL`. The device must re-bootstrap (new `POST /register` without auth) and re-register UUIDs with all wallet services.

### 8.4 Message Store Key

The message store (§3) uses `device_credential` as the key:

```
messages:{device_credential}
```

This ensures that blobs delivered to a UUID are only accessible to the device that registered that UUID — even if another entity independently calls `POST /register` with the same push token.

---

## 9. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection URL, e.g. `redis://redis:6379` |
| `DB_PATH` | No | `/data/registry.db` | Path to the SQLite device registry file |
| `APP_REGISTRY_PATH` | Yes | — | Path to the app registry JSON config file |
| `RELAY_ID` | Yes | — | Unique identifier for this relay instance, included in re-registration push payloads |
| `PORT` | No | `3000` | HTTP port the relay listens on |
| `UUID_TTL_SECONDS` | No | `2592000` | TTL for UUID records and device credentials in Redis (default 30 days) |
| `DEVICE_REGISTRY_RETENTION_DAYS` | No | `90` | Age threshold for device registry pruning |
| `MAX_DELETE_DELAY_SECONDS` | No | `21600` | Upper bound of staggered wallet delete delay (default 6 hours) |
| `DELETE_JOB_POLL_INTERVAL_MS` | No | `60000` | How often the delete background job polls Redis (default 60 seconds) |
| `NODE_ENV` | No | `production` | Set to `development` for verbose logging and stub push mode |
