# Notification Relay — Data Model Spec

**Version:** 0.9
**Date:** 2026-07-11
**Status:** Draft — describes the Docker/self-hosted architecture implemented in `relay/` (a plain Node.js/Express-style process, self-hosted Redis, SQLite device registry). This is the currently-deployed-target architecture; `relay/`'s code has been brought to full compliance with this revision (see `plans/relay-old-restoration-plan.md`).
**Amends: v0.8 — reverts the serverless (Cloudflare Workers + Durable Objects + Redis Cloud + Cloudflare KV) architecture back to the Docker/self-hosted design, per `plans/relay-old-restoration-plan.md` (the authorizing decision for this reversion; see its "Why this plan exists" section).** The serverless design still needed a Redis instance, and running that Redis instance in Docker alongside the app is simpler than splitting state across a third-party Redis Cloud service and Cloudflare KV — so the project reverted to `relay/`, the pre-migration Docker implementation, rather than carrying the migration through.
**This is not a blind rollback to v0.4.** Several corrections made during the v0.5–v0.8 serverless-migration period are **preserved** here because they are substantive fixes to the relay's actual behavior, not artifacts of serverless infrastructure:
- **§3.1's `messages:{device_credential}` message-store keying correction.** v0.4/early text said `messages:{push_token}`, which contradicted §8 (Device Credential Store) and the actual running code (`relay/src/utils/storage/redis.ts`'s `storeMessage(credential, ...)`). Push-token-keying would also break the isolation guarantee §8.1 depends on. This was a real bug-vs-spec fix, unrelated to serverless infrastructure, and stays fixed.
- **The `wallet_base_url` field name and its `https://`-only semantics** (§2.2, §6.1) — an `https://` base URL used only for staggered `DELETE {wallet_base_url}/messages/{uuid}` calls, never for a relay-opened connection. This is confirmed correct against the current code (`relay/src/utils/storage/redis.ts`'s `UuidRecord.wallet_base_url`, `relay/src/utils/apps.ts`'s `AppConfig.wallet_base_url` validated as requiring `https://`).
- **The UUID state machine itself** (`unused` / `in_flight` / `active` / `consumed`, the Lua CAS transition script, the atomic transitions on `/deliver`) — none of this was serverless-specific and none of it changes here.
- **The staggered delete queue** (Redis sorted set, `ZADD`/`ZRANGEBYSCORE`, exponential backoff) — Redis-based, not serverless-specific, unchanged.
- **Device credential auth model** (bootstrap vs. replenishment, TTL refresh) — not serverless-specific, unchanged.

What *is* dropped, because it was purely serverless-infrastructure-specific with no Docker equivalent: Cloudflare KV as the device registry (reverts to SQLite, §5); Cloudflare Cron Triggers for the reconciliation scan and delete-queue polling (revert to a one-time process-startup scan plus `setInterval`-based background jobs, §2.5–§2.6, §4.4); the Redis-Cloud-vs-Durable-Object "authority split" (§10 of v0.8 is deleted entirely — a single long-running Docker process is simply, unambiguously authoritative for connection liveness; there is no split to describe); Redis Cloud/Upstash provisioning concerns and the dual Nitro preset split (revert to a single self-hosted Redis container, `REDIS_URL`).

**Amends (v0.7 → v0.8, historical, superseded by this revision):** device registry moved from a second Redis Cloud database to Cloudflare KV. **Amends (v0.6 → v0.7, historical):** hibernation-eviction test result recorded. **Amends (v0.5 → v0.6, historical):** device registry moved from SQLite/second-Redis to Cloudflare KV. **Amends (v0.4 → v0.5, historical):** replaced the single self-hosted Redis + SQLite topology with Redis Cloud + Durable Objects. All of the above are superseded by this v0.9 reversion; retained here only so the amendment history is traceable.

**Changelog (spec-consistency Phase 2):** Fix #6 — added §6.4 (Oblivious Target Registry Config) and the `OBLIVIOUS_TARGETS_PATH` environment variable (§9), backing `relay.md §7.9`'s new `POST /ohttp/{target_id}` endpoint, which this data-model spec had never documented. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, Tier 1 items 12–13):** §9's `OBLIVIOUS_TARGETS_PATH` row corrected from Required: Yes to Required: No, matching the deployed code's deliberately-optional treatment (deploying without OHTTP forwarding configured is supported); file-path citation typo fixed (`oblivious-targets.ts`→`oblivious_targets.ts`). See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

---

## Table of Contents

1. [Overview](#1-overview)
   - 1.1 [Topology](#11-topology)
2. [Redis — UUID Store](#2-redis--uuid-store)
   - 2.1 [Key Schema](#21-key-schema)
   - 2.2 [UUID Record Fields](#22-uuid-record-fields)
   - 2.3 [TTL and Expiry](#23-ttl-and-expiry)
   - 2.4 [Atomic Transitions](#24-atomic-transitions)
   - 2.5 [Startup Scan for Stuck Active/In-Flight UUIDs](#25-startup-scan-for-stuck-activein-flight-uuids)
   - 2.6 [Empty-Store Detection](#26-empty-store-detection)
3. [Redis — Message Store](#3-redis--message-store)
4. [Redis — Pending Delete Queue](#4-redis--pending-delete-queue)
5. [SQLite — Device Registry](#5-sqlite--device-registry)
   - 5.1 [Key Schema](#51-key-schema)
   - 5.2 [Fields](#52-fields)
   - 5.3 [Operations](#53-operations)
   - 5.4 [Retention](#54-retention)
6. [App Registry Config](#6-app-registry-config)
   - 6.1 [JSON Schema](#61-json-schema)
   - 6.2 [Example](#62-example)
   - 6.3 [Validation Rules](#63-validation-rules)
   - 6.4 [Oblivious Target Registry Config](#64-oblivious-target-registry-config)
7. [UUID State Machine](#7-uuid-state-machine)
   - 7.1 [States](#71-states)
   - 7.2 [Transitions](#72-transitions)
   - 7.3 [Invalid Transitions](#73-invalid-transitions)
8. [Device Credential Store](#8-device-credential-store)
9. [Environment Variables](#9-environment-variables)

---

## 1. Overview

The relay uses **two** storage systems, each matching the durability requirement of the data it holds:

| Store | Technology | Durability | Data stored | Why |
|---|---|---|---|---|
| Redis | Self-hosted, in a Docker container (`redis:7-alpine`), persistence explicitly disabled (`--save "" --appendonly no --maxmemory-policy noeviction`) | RAM only — cleared on container restart | UUID records (`uuid:*`), device credentials (`cred:*`), message blobs (`messages:*`), pending delete queue (`pending_deletes`) | UUID and credential associations must never touch disk |
| SQLite | `better-sqlite3`, file on a Docker volume mounted into the relay container | Durable — survives relay/Redis restarts | Device registry: push token → app, last seen, with 90-day retention enforced by an explicit prune job (§5) | Needed to detect a Redis reset and re-notify devices for re-registration; must survive the exact restart that clears Redis |

A third data source — the **app registry** — is a JSON config file loaded once at process startup (`APP_REGISTRY_PATH`). It is not a database; it is static configuration. Changes require a process restart.

Connection liveness for `GET /ws/{uuid}` and `GET /sse` is tracked in two in-process `Map`s (`relay/src/utils/ws_connections.ts`, `relay/src/utils/sse_connections.ts`), keyed by `device_credential` in both cases. Because the relay runs as a single long-running Node.js process, there is no "authority split" to reason about — the process holding the socket is simply the sole source of truth for whether that socket is open. This state does not survive a process restart, which is expected and correct: open connections cannot survive a restart on any architecture, and the reconciling backstop (§2.5) exists for exactly the case where a restart leaves a UUID stuck.

### 1.1 Topology

```
                    ┌──────────────────────────────────────────┐
                    │        Docker Compose (relay/)            │
                    │                                            │
  HTTPS  ──────────▶│  ┌──────────────────────────────────────┐ │
  (device, wallet)  │  │  relay container (Node.js, one       │ │
                     │  │  long-running process)                │ │
                     │  │                                        │ │
                     │  │  register / deliver / pending / ack /  │ │
                     │  │  health / ws / sse  (single process)   │ │
                     │  │                                        │ │
                     │  │  ws_connections.ts / sse_connections.ts│ │
                     │  │  (in-process Maps, keyed by            │ │
                     │  │   device_credential)                   │ │
                     │  │                                        │ │
                     │  │  SQLite file on Docker volume          │ │
                     │  │  (device registry, §5)                 │ │
                     │  └───────────────┬────────────────────────┘ │
                     │                  │                            │
                     │                  ▼                            │
                     │  ┌──────────────────────────────────────┐ │
                     │  │  redis container (redis:7-alpine)      │ │
                     │  │  persistence: OFF                       │ │
                     │  │  uuid:* / cred:* / messages:* /         │ │
                     │  │  pending_deletes                        │ │
                     │  └──────────────────────────────────────┘ │
                     └──────────────────────────────────────────┘
                                       │
                             WebSocket / SSE
                            (device only — see
                           relay.md §7.3, §7.4)
                                       │
                                       ▼
                                Device (holder)

APNs / FCM: invoked directly from the relay process on the delivery
path (relay.md §7.2 step 7) — not shown as a separate box since it is
an outbound HTTPS call, not a persistent connection.
```

This is the same two-container Docker Compose topology `relay/docker-compose.yml` already implements: one `relay` container built from `relay/Dockerfile`, one `redis` container, connected via `REDIS_URL=redis://redis:6379`. There is no separate SQLite container — it is a file on a named volume (`db_data:/data`) mounted into the `relay` container.

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

UUIDs are untyped — a UUID may be used at `POST /deliver/{uuid}` (message delivery) or `GET /ws/{uuid}` (WebSocket delivery channel). The device allocates UUIDs between these uses without the relay enforcing a split.

**`device_credential`:** All UUIDs returned in a single `POST /register` call share the same `device_credential` value. The relay can resolve `device_credential → push_token` by looking up any UUID that carries that credential. Credentials are opaque random tokens generated alongside the UUID pool; they carry no device-identifiable information beyond the push token association already present in the UUID record.

**Why `wallet_base_url` is stored per-UUID:** The app registry is mutable (reloaded on restart). Storing the wallet URL at registration time ensures that in-flight UUIDs always resolve to the correct endpoint, even if the app config changes between registration and use.

### 2.3 TTL and Expiry

Every UUID key is created with a TTL of **30 days** (2,592,000 seconds). Redis auto-expires the key after this period with no intervention required.

TTL is set at creation time via `HSET` + `EXPIRE` (or `HSET` with `EX` in Redis 7+). TTL is not refreshed on read or state transition. A UUID that is never used expires naturally after 30 days.

### 2.4 Atomic Transitions

UUID state transitions must be atomic to prevent race conditions (e.g. two simultaneous calls to `POST /deliver/{uuid}` both reading `unused` and both proceeding). All transitions are implemented as a **Lua script** executed via Redis `EVAL`:

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

Callers map these returns to HTTP/WebSocket error responses per the error code table in `relay.md §10`.

### 2.5 Startup Scan for Stuck Active/In-Flight UUIDs

A one-time scan runs at process startup, before the relay begins accepting requests (`relay/src/startup.ts`'s `runStartupChecks`, invoked from `relay/src/server.ts` before `server.listen(...)`). This is a natural fit for a single long-running Node.js process: connections and in-flight requests cannot survive a process restart, so any UUID left in `active` or `in_flight` from before the restart is, by construction, stuck and safe to resolve.

The scan itself: a Redis `SCAN` cursor loop with pattern `uuid:*` (`COUNT` hint of 100, not `KEYS *`, to avoid blocking Redis) — `scanActiveUuids()` in `relay/src/utils/storage/redis.ts`. For each key found with `status == "active"` or `status == "in_flight"`, the transition to `consumed` is executed using the Lua script above (`active → consumed` first, falling back to `in_flight → consumed` if that fails).

**Why this matters:** a device's WebSocket connection or an in-progress `/deliver` call cannot outlive the process that held it. If the relay process crashes or is restarted uncleanly (no chance to run the WebSocket close handler or complete the `/deliver` transition), the affected UUID is left stuck in Redis at `active` or `in_flight` — unable to be reused (§7.3) but also never resolved to `consumed`. This startup scan is the backstop that reconciles Redis's view of UUID state with reality every time the process (re)starts.

The count of stuck UUIDs transitioned is logged at `WARN` level. A non-zero count indicates the previous process instance exited uncleanly.

### 2.6 Empty-Store Detection

Also part of `runStartupChecks()`, run once at startup after the stuck-UUID scan: the relay checks whether the Redis UUID store is completely empty (`isStoreEmpty()` — a `SCAN 0 MATCH uuid:* COUNT 1` that returns true only if the cursor is exhausted with zero keys found).

An empty store at startup is ambiguous by itself — it is true both on first deployment ever (no devices have registered yet) and after Redis has lost its data (container recreated, volume-less restart, etc.). The relay disambiguates the two cases by checking the **SQLite device registry** (§5), which is durable and unaffected by a Redis reset: if the device registry is also empty, this is treated as a first deploy and no re-registration notification is sent; if the device registry has entries, Redis is confirmed to have been reset out from under an already-known device population, and the relay sends the re-registration push (`relay.md §9`) to every device currently in the SQLite registry (`getRecentDevices(cutoff)`, same 90-day retention window as §5.4).

Because this check runs once, at startup, rather than on a recurring schedule, it does not need the "was empty a moment ago, is non-empty now" transition-tracking flag a periodic version of this check would require — there is exactly one moment to evaluate, and Redis being briefly empty mid-run (e.g. after the last outstanding UUID naturally expired) is not a case this check ever observes, since it only runs once right after boot.

---

## 3. Redis — Message Store

### 3.1 Key Schema

**This key schema is `device_credential`-keyed, not `push_token`-keyed — a correction that predates and is independent of the serverless migration and survives this reversion unchanged.** An earlier revision of this subsection said `messages:{push_token}`, which contradicted §8 (Device Credential Store) later in this document and the actual behavior of the implementation (`relay/src/utils/storage/redis.ts`'s `storeMessage(credential, ...)`). Push-token-keying would also have broken the isolation guarantee §8.1 claims — see that section's threat model. The key is, and has always been in the running code, `device_credential`-keyed.

Pending message blobs are stored as a Redis list under the key:

```
messages:{device_credential}
```

where `{device_credential}` is the opaque credential issued at registration (§8) — not the push token. Keying by credential, rather than push token, is what makes the isolation property in §8.1 hold: two `POST /register` calls that happen to share a push token but produce different credentials get entirely separate message stores, so an attacker who has learned a device's push token cannot drain its pending messages without also possessing its credential. Each list entry is a JSON-encoded object:

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
RPUSH messages:{device_credential} <json entry>
EXPIRE messages:{device_credential} <UUID_TTL_SECONDS>  -- refreshed on each push
```

The handler resolves `uuid → device_credential` from the UUID record (§2.2) before this write — the wallet service supplies only the UUID; the relay is what maps it to the correct credential-keyed store.

**Retrieve and clear (on `GET /pending`):**

Implemented as a Lua script to atomically read and delete:

```lua
local key = KEYS[1]
local items = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return items
```

**Remove individual entry (after SSE/WebSocket delivery, before `POST /ack`):**

Not performed individually. The message store is cleared atomically on `GET /pending`. For SSE or WebSocket delivery, messages are removed from the store only after `POST /ack` is received; if no ack arrives (connection drop), the blob remains in the store for `GET /pending` pickup.

### 3.3 TTL

The `messages:{device_credential}` key TTL is reset to `UUID_TTL_SECONDS` (default 30 days) on each `RPUSH`. A device that is offline for more than 30 days after its last received message will have its pending blobs expired by Redis. On next wake, the device calls `GET /pending`, receives an empty list, and fetches messages via re-registration and wallet retransmission.

### 3.4 Privacy Note

The message store key includes the device credential, not the push token — see §8.1's threat model for why this distinction matters (push-token-keying would let anyone who learns a device's push token drain its message store; credential-keying requires possessing the credential itself, which is never transmitted alongside the push token). This is consistent with the relay's existing use of `device_credential` as the isolation boundary for all authenticated device-facing endpoints (§6.1 of `relay.md`, §8 below). The message store does not add any push-token-linked data beyond what is already present in the UUID store (§2.2, which does store `push_token` per UUID for push dispatch purposes).

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

The sort score is the Unix timestamp (milliseconds) at which the job should be executed.

### 4.2 Operations

**Enqueue a delete job (on `POST /ack`):**

```
ZADD pending_deletes <execute_at_ms> <json job>
```

where `execute_at_ms = now_ms + random(0, MAX_DELETE_DELAY_SECONDS) * 1000`.

**Dequeue ready jobs (background poll):**

```lua
-- Returns all jobs with score <= now, atomically removes them
local now = ARGV[1]
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #jobs > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
end
return jobs
```

**Requeue on failure (exponential backoff):**

```
ZADD pending_deletes <new_execute_at_ms> <updated_json_job>
```

Backoff schedule: `min(base_delay_ms * 2^attempts, max_backoff_ms)` where `base_delay_ms = 300000` (5 minutes) and the cap is `86400000` (24 hours). `attempts` is incremented in the job JSON before requeuing.

### 4.3 Durability

The pending delete queue is held in Redis (in-memory, no persistence). Jobs lost to a relay restart are benign: the wallet service retains messages until it receives the delete call. If the call never arrives, the wallet retransmits on device UUID re-registration; the device deduplicates by message ID within the decrypted blob.

### 4.4 Background Job

A `setInterval`-based polling loop runs inside the single long-running Node.js process for the lifetime of the process (`relay/src/utils/wallet_clearance.ts`'s `startWalletClearance()`, started from `relay/src/startup.ts`). The poll interval is controlled by `DELETE_JOB_POLL_INTERVAL_MS` (default `60000` — 60 seconds).

On each poll:

1. Dequeue all jobs with `score ≤ now` using the Lua script above.
2. For each job, call `DELETE {wallet_url}/messages/{uuid}`.
3. On success (2xx) or 404: discard the job.
4. On failure (5xx, timeout, network error): requeue with exponential backoff.

**Shutdown flush:** on `SIGTERM`/`SIGINT`, the relay stops the poll timer and performs a best-effort final flush — it dequeues any jobs currently due and attempts to execute them within a bounded window (5 seconds) before the process exits (`stopWalletClearance()`). This is not required for correctness (jobs left in the queue simply wait for the next process's first poll, or for the wallet's own retention fallback), but it reduces unnecessary delete latency across ordinary restarts/deploys.

---

## 5. SQLite — Device Registry

The device registry is a SQLite database file on a Docker volume (`DB_PATH`, default `/data/registry.db`, mounted at `db_data:/data` per `relay/docker-compose.yml`), accessed via `better-sqlite3` (`relay/src/utils/storage/sqlite.ts`). Its only purpose is holding enough information to send a re-registration push after Redis is confirmed reset (§2.6, `relay.md` §9) — it must survive exactly the kind of restart that clears Redis, which is why it lives on a separate, durable store rather than in Redis itself.

### 5.1 Key Schema

Each device is a row in the `device_registry` table, keyed by `push_token` (`PRIMARY KEY`):

```sql
CREATE TABLE IF NOT EXISTS device_registry (
  push_token         TEXT NOT NULL PRIMARY KEY,
  app_id             TEXT NOT NULL,
  last_registered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_last_registered
  ON device_registry(last_registered_at);
```

The index on `last_registered_at` supports the retention-window query used by both the re-registration check (§2.6) and the pruning job (§5.3) — both filter by this column.

### 5.2 Fields

| Field | Type | Description |
|---|---|---|
| `push_token` | TEXT (PK) | Platform push token; the row's identity |
| `app_id` | TEXT | App identifier |
| `last_registered_at` | TEXT | ISO 8601 UTC timestamp of the most recent `POST /register` for this push token |

No UUID associations, no device credentials, and no card-linkable data are stored here — same invariant the relay has always held for this store: its only purpose is enough information to know which devices to re-notify after a Redis reset.

### 5.3 Operations

**Upsert on registration:**

```sql
INSERT INTO device_registry (push_token, app_id, last_registered_at)
VALUES (?, ?, ?)
ON CONFLICT(push_token) DO UPDATE SET
  app_id = excluded.app_id,
  last_registered_at = excluded.last_registered_at
```

Called once per `POST /register` request (both bootstrap and replenishment paths), after UUID records are written to Redis (`upsertDevice(push_token, app_id)`).

**Query for re-registration:**

```sql
SELECT push_token, app_id, last_registered_at
FROM device_registry
WHERE last_registered_at >= ?
```

(`getRecentDevices(since)`.) Called by the empty-store detection flow (§2.6) when Redis is confirmed reset — returns every device registered within the retention window (§5.4).

**Prune stale entries — an explicit job, unlike TTL-based stores:** unlike a store with native per-key expiry, SQLite requires an application-level prune to actually remove rows once they age out. `relay/src/utils/pruning.ts`'s `startPruningJob()` schedules a recurring prune roughly once a week (`WEEK_MS` plus up to ±1 hour of jitter, via `setTimeout`, re-scheduling itself after each run — not a `setInterval`, and not tied to any external scheduler):

```sql
DELETE FROM device_registry WHERE last_registered_at < ?
```

(`pruneOldDevices(before)`, where `before = now - DEVICE_REGISTRY_RETENTION_DAYS days`.) This is a **real functional difference from a native-TTL store**: entries are not gone the instant they cross the retention threshold — they persist until the next scheduled prune run actually deletes them, so the true worst-case staleness is up to roughly a week past the nominal 90-day threshold. §2.6's query only reads rows still present at query time, so a not-yet-pruned stale row could in principle be included in a re-registration push; this is treated as an acceptable imprecision, not a correctness bug (an extra re-registration push to a genuinely dormant device is harmless — the device either responds or the push silently fails).

### 5.4 Retention

Records older than **90 days** (`DEVICE_REGISTRY_RETENTION_DAYS`) since last registration are pruned by the weekly job above. The 90-day threshold balances two concerns:

- **Too short:** legitimate users who are dormant (travel, infrequent use) are pruned and do not receive re-registration notifications after a Redis reset
- **Too long:** the device registry grows without bound; stale push tokens accumulate for uninstalled apps

90 days covers nearly all real-world dormancy patterns while keeping the registry lean. Enforcement has up to about a week of drift (§5.3), an acceptable imprecision given the same reasoning v0.4 originally used for this store.

---

## 6. App Registry Config

### 6.1 JSON Schema

The app registry is a JSON file at the path specified by the `APP_REGISTRY_PATH` environment variable. It is loaded exactly once, synchronously, at process startup (`relay/src/utils/apps.ts`'s `loadAppRegistry`, called from `relay/src/server.ts` before the HTTP server begins listening). Changes to the file require a process restart to take effect — there is no hot-reload.

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

`key_file` and `service_account_file` are ordinary filesystem paths, resolved relative to the relay container's filesystem (typically under a Docker volume mount, e.g. `/app/config/secrets/...` — see `relay/config/apps.json`). Both are validated to exist on disk at registry-load time (§6.3).

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

Note that two app entries can share the same `wallet_base_url` — iOS and Android variants of the same wallet are common.

### 6.3 Validation Rules

The service validates the registry on startup and exits with a clear error message (`process.exit(1)`) if any of the following conditions are violated:

- `app_id` must be unique across all entries
- `platform` must be `"apns"` or `"fcm"`
- `wallet_base_url` must be a valid `https://` URL
- If `platform == "apns"`: `apns` object must be present with all required fields (`key_file`, `key_id`, `team_id`, `bundle_id`); the credential file must exist at the specified path; `sandbox` defaults to `true` if absent
- If `platform == "fcm"`: `fcm` object must be present; `service_account_file` must exist at the specified path
- Cross-field: `apns` object present with `platform == "fcm"` is an error (and vice versa)

### 6.4 Oblivious Target Registry Config

A second static config file, structurally independent of the app registry (§6.1) — `AppConfig`'s `apns`/`fcm` fields have no meaning for a press, so the oblivious-forwarding registry is its own file rather than an extension of `AppRegistryFile`. It backs `POST /ohttp/{target_id}` (`relay.md §7.9`).

Loaded once, synchronously, at process startup from the path in `OBLIVIOUS_TARGETS_PATH` (`relay/src/utils/oblivious_targets.ts`), the same way `APP_REGISTRY_PATH` is loaded (§6.1). Changes require a process restart — there is no hot-reload.

```typescript
interface ObliviousTargetsFile {
  targets: ObliviousTarget[];
}

interface ObliviousTarget {
  target_id:         string;  // Required. Opaque identifier the device names in POST /ohttp/{target_id}.
                               // May reuse a wallet service's existing app_id, or a press's own
                               // identifier — the relay does not need to know which kind of
                               // destination a given target_id names.
  ohttp_gateway_url: string;  // Required. Base https:// URL of the destination's OHTTP gateway
                               // (its POST /ohttp/{target_id}-equivalent dispatch endpoint).
}
```

**Example:**

```json
{
  "targets": [
    { "target_id": "mutual-aid-wallet", "ohttp_gateway_url": "https://wallet.mutual-aid.example/ohttp/gateway" },
    { "target_id": "mutual-aid-press",  "ohttp_gateway_url": "https://press.mutual-aid.example/ohttp/gateway" }
  ]
}
```

**Validation rules** (checked at startup; `process.exit(1)` on violation): `target_id` must be unique across all entries; `ohttp_gateway_url` must be a valid `https://` URL.

---

## 7. UUID State Machine

### 7.1 States

| State | Meaning |
|---|---|
| `unused` | UUID has been issued to a device; not yet presented to the relay for delivery, and no WebSocket has been opened for it |
| `in_flight` | Push dispatch in progress after blob receipt. Transient — prevents double-delivery under concurrent `/deliver` requests. |
| `active` | UUID is registered as a device WebSocket delivery channel (inbound delivery only; relay holds no outbound wallet connection) |
| `consumed` | UUID has been permanently used (blob accepted, or WebSocket session closed) |

`consumed` is a terminal state. `in_flight` is transient: it is resolved to `consumed` or `unused` within the same request lifecycle.

Redis is the sole store of record for all four states. There is exactly one relay process, so there is no split of authority to describe: whichever code path is currently handling a UUID (the `/deliver` handler, or the WebSocket connection handler) is the only thing that can observe or change that UUID's Redis-recorded status at that moment, and the in-process `Map`s in `ws_connections.ts`/`sse_connections.ts` are a live-connection lookup index, not a second source of truth about UUID status.

**Key change from v0.2 (unaffected by this revision):** Delivery UUIDs transition to `consumed` when the relay accepts and stores the blob (`POST /deliver/{uuid}`), not when the device picks up the message. Message lifecycle is tracked separately in the message store (§3); UUID status is not used to track delivery to the device.

### 7.2 Transitions

| From | To | Trigger | Endpoint / mechanism |
|---|---|---|---|
| `unused` | `in_flight` | Blob receipt begins (atomic lock) | `POST /deliver/{uuid}` |
| `in_flight` | `consumed` | Blob stored successfully | `POST /deliver/{uuid}` |
| `in_flight` | `unused` | Blob storage or push dispatch failed | `POST /deliver/{uuid}` |
| `unused` | `active` | Device WebSocket connection accepted | `GET /ws/{uuid}` — the Redis transition happens synchronously as part of handling the upgrade request, before the connection is registered in the in-process `Map` |
| `active` | `consumed` | Session teardown (device close or network error) | The WebSocket's `close`/`error` handler performs the Redis transition directly and synchronously (`relay/src/routes/ws.ts`) — there is no second system to hand this off to |
| `active` | `consumed` | Startup scan (§2.5) — crash/unclean-restart recovery | Runs once, at process startup, before the server accepts requests |
| `in_flight` | `consumed` | Startup scan (§2.5) — crash/unclean-restart recovery | Runs once, at process startup, before the server accepts requests |
| TTL expiry | key deleted | 30 days elapsed with no transition | Redis automatic |

Because a single process holds both the Redis client and the in-process connection `Map`, the `active → consumed` teardown transition on ordinary connection close is synchronous with the socket actually closing — there is no bounded-staleness window in the ordinary case. The only case where a UUID can be left stuck at `active` is the process itself dying before the close handler runs (crash, `kill -9`, host failure) — exactly the case the startup scan (§2.5) exists to catch on the next boot.

### 7.3 Invalid Transitions

| Attempted transition | Error returned |
|---|---|
| Any → from `consumed` | `UUID_CONSUMED` (410 or WebSocket 4010) |
| `in_flight` → via a second `/deliver` call | `UUID_CONSUMED` (410) |
| `active` → `unused` | Rejected by Redis transition logic |
| Transition on unknown key | `UNKNOWN_UUID` (404 or WebSocket 4004) |

**Lua CAS retained for all transitions.** Unlike an architecture with multiple concurrent connection-holding instances per UUID, a single Node.js process handling all traffic still has concurrent HTTP requests (e.g. two near-simultaneous `POST /deliver/{uuid}` calls, or a `/deliver` racing a `GET /ws/{uuid}` upgrade for the same UUID) — so the Lua CAS script (§2.4) is used for every transition in the table above, including `unused → active`, not just the `/deliver` path's transitions. This is unchanged from the relay's original (pre-v0.5) design.

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
| `REDIS_URL` | Yes | — | Connection string for the self-hosted Redis container (`redis://redis:6379` in the default Docker Compose topology). No TLS requirement — this is a private container-to-container connection. |
| `DB_PATH` | No | `/data/registry.db` | Filesystem path (on the mounted Docker volume) to the SQLite device registry file |
| `APP_REGISTRY_PATH` | Yes | — | Path to the app registry JSON config file, read once at startup |
| `OBLIVIOUS_TARGETS_PATH` | No | — | Path to the oblivious target registry JSON config file (§6.4), read once at startup. Corrected 2026-07-16 (Phase 3 Tier 1 item 12): unlike `APP_REGISTRY_PATH`, a missing value here is not a fatal startup error — deploying without OHTTP forwarding configured is a supported configuration; the relay simply serves no oblivious targets. |
| `RELAY_ID` | Yes | — | Unique identifier for this relay deployment, included in re-registration push payloads |
| `PORT` | No | `3000` | HTTP/WebSocket listen port for the relay process |
| `UUID_TTL_SECONDS` | No | `2592000` | TTL for UUID records, device credentials, and the message store in Redis (default 30 days) |
| `DEVICE_REGISTRY_RETENTION_DAYS` | No | `90` | Age threshold for the weekly SQLite device-registry pruning job (§5.3) |
| `MAX_DELETE_DELAY_SECONDS` | No | `21600` | Upper bound of staggered wallet delete delay (default 6 hours) |
| `DELETE_JOB_POLL_INTERVAL_MS` | No | `60000` | Poll interval (milliseconds) for the delete-queue background job (§4.4) |
| `NODE_ENV` | No | `production` | Set to `development` for verbose logging and stub push mode |
