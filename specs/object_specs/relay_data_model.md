# Notification Relay — Data Model Spec

**Version:** 0.8 (draft)
**Date:** 2026-07-03
**Status:** Draft — describes the target serverless architecture. Phase 2 (Core Build) and Phase 3 (Documentation & CI/CD) of `plans/relay-serverless-migration-implementation-plan.md` are complete and committed as of this revision.
**Amends:** v0.7 — §1 records a temporary, explicitly-flagged pre-deployment exception: Upstash is in use for `REDIS_PRIMARY_URL` during testing because Redis Cloud's free tier has no TLS support at any level (confirmed by direct testing) and `relay-next`'s client hardcodes TLS as mandatory, while Upstash supports TLS on its free tier. This does not change the design — Upstash cannot satisfy the no-persistence invariant at any tier, so this is a knowing, temporary trade-off for non-real test data only, with a required cutover to a paid Redis Cloud tier before production. See `relay-next/PROVISIONING.md` §1a/§1b.
**Amends (v0.6 → v0.7, carried forward):** §2.5 updated with a real hibernation-eviction test result run against a deployed Worker (2026-07-03): the reconciliation scan's 5-minute `RECONCILIATION_CRON_SCHEDULE` default is confirmed adequate and is no longer a placeholder, though the test could not cleanly isolate the exact eviction boundary due to an apparent client-side interruption late in the run — see §2.5 for the full honest accounting.
**Amends (v0.5 → v0.6, carried forward):** the device registry (§5) moves from a second Redis Cloud database to **Cloudflare KV**, accessed through Nitro's `storage()` abstraction (revised decision #2 in `plans/relay-serverless-migration-implementation-plan.md`). Trigger for this change: the free Redis Cloud tier, used for the test deployment, turns out to disable persistence by default — which is exactly wrong for this specific store, and there was no actual technical reason it needed to be Redis at all (v0.5's stated rationale was "reuse the same client/Lua infrastructure as the primary store," not a property only Redis has). KV's native per-key TTL also removes the need for the separate weekly pruning job (old §5.3/§5.4). §1 (Overview table, topology diagram), §2.6 (empty-store detection flag location), §5 (rewritten), §9 (environment variables), and §10.4 (clarified scope of the disk-write prohibition) are updated accordingly.
**Amends (v0.4 → v0.5, carried forward):** replaces the single self-hosted Redis + SQLite-on-Docker-volume topology with a Redis Cloud primary (persistence-off) and a Cloudflare Durable-Object-backed connection layer, per `plans/relay-serverless-migration-strategic-plan.md`. §2.4 (Atomic Transitions), §2.5–2.6 (startup scans), and §7 (UUID state machine) reflect the authority split between Redis Cloud and Durable Objects; §10 specifies exactly which system is authoritative for which piece of state.

---

## Table of Contents

1. [Overview](#1-overview)
   - 1.1 [Topology](#11-topology)
2. [Redis Cloud (Primary) — UUID Store](#2-redis-cloud-primary--uuid-store)
   - 2.1 [Key Schema](#21-key-schema)
   - 2.2 [UUID Record Fields](#22-uuid-record-fields)
   - 2.3 [TTL and Expiry](#23-ttl-and-expiry)
   - 2.4 [Atomic Transitions](#24-atomic-transitions)
   - 2.5 [Startup Scan for Stuck Active UUIDs](#25-startup-scan-for-stuck-active-uuids)
   - 2.6 [Empty-Store Detection](#26-empty-store-detection)
3. [Redis Cloud (Primary) — Message Store](#3-redis-cloud-primary--message-store)
4. [Redis Cloud (Primary) — Pending Delete Queue](#4-redis-cloud-primary--pending-delete-queue)
5. [Cloudflare KV — Device Registry](#5-cloudflare-kv--device-registry)
   - 5.1 [Key Schema](#51-key-schema)
   - 5.2 [Fields](#52-fields)
   - 5.3 [Operations](#53-operations)
   - 5.4 [Retention](#54-retention)
6. [App Registry Config](#6-app-registry-config)
   - 6.1 [JSON Schema](#61-json-schema)
   - 6.2 [Example](#62-example)
   - 6.3 [Validation Rules](#63-validation-rules)
7. [UUID State Machine](#7-uuid-state-machine)
   - 7.1 [States](#71-states)
   - 7.2 [Transitions](#72-transitions)
   - 7.3 [Invalid Transitions](#73-invalid-transitions)
8. [Device Credential Store](#8-device-credential-store)
9. [Environment Variables](#9-environment-variables)
10. [Authority Split: Redis Cloud vs. Durable Objects](#10-authority-split-redis-cloud-vs-durable-objects)

---

## 1. Overview

The relay uses **three** storage/state systems with deliberately different durability and locality characteristics, chosen to match the privacy and connection-lifecycle requirements of each data type:

| Store | Technology | Durability | Data stored | Why |
|---|---|---|---|---|
| Primary Redis Cloud database | Redis Cloud, RDB and AOF both explicitly disabled | RAM only — cleared on database restart | UUID records (`uuid:*`), device credentials (`cred:*`), message blobs (`messages:*`), pending delete queue (`pending_deletes`) | UUID and credential associations must never touch disk (unchanged invariant from v0.4 — see `plans/relay-strategic-plan.md`) |
| Cloudflare KV (device registry) | Cloudflare KV, accessed via Nitro's `storage()` abstraction | Durable — platform default; survives primary database resets | Device registry: push token → app, last seen, with a native per-key TTL (90 days) | Required for re-registration notification after the primary database resets. Replaces the second Redis Cloud database from v0.5 (which itself replaced the SQLite-on-Docker-volume store from v0.4) — see §5. |
| Durable Object (live connections only) | Cloudflare Durable Objects, one instance per connection key, in-memory instance state and `WebSocket.serializeAttachment` only — **never DO storage** | Ephemeral — gone on hibernation-context loss beyond what `serializeAttachment` preserves, and gone entirely on eviction with no reconnect | Which specific edge location currently holds an open `GET /ws/{uuid}` or `GET /sse` socket, for as long as that socket is open | Durable Object *storage* is SQLite-backed and disk-resident with point-in-time recovery on by default — using it for UUID/credential-linked data would violate the same invariant Redis persistence-off protects. In-memory DO state carries no such risk because it is never written to disk by the platform. See §10 for the precise authority split this creates. |

A fourth data source — the **app registry** — is a JSON config file loaded at startup. It is not a database; it is static configuration. Unchanged from v0.4.

**Why the device registry is Cloudflare KV, not a second Redis Cloud database (changed in v0.6):** v0.5 put the device registry on a second Redis Cloud database mainly to reuse the same client and Lua-script infrastructure as the primary store — not because Redis has a property this specific store actually needs. The device registry's access pattern (upsert by key, list current entries, expire after 90 days) has no requirement for Redis's data structures (Lua CAS scripts, sorted sets) the way the UUID store does. Two things motivated revisiting it: (1) the free Redis Cloud tier — used for the test deployment — disables persistence by default, which defeats the one property this store exists for, and can't be worked around without paying for a tier that was otherwise only needed for production; (2) Cloudflare KV supports per-key TTL natively (`relay-next` uses unstorage's `cloudflare-kv-binding` driver, `ttl` option), which lets §5.3/§5.4's old prune-by-timestamp-index job be deleted entirely rather than ported — expired entries just stop existing. KV is free at this scale (100k reads/day, 1k writes/day, 1GB storage) and durable by default, so both the free-tier testing gap and the manual pruning logic disappear at once. This does not weaken the portability goal (Goal 3, strategic plan): Nitro's `storage()` abstraction is the point of using it here — the `node-server` preset can back the same calls with a different unstorage driver (filesystem or in-memory) for local development, without needing Redis Cloud credentials for this store at all.

**Why the primary store is still Redis Cloud, not also moved off it:** the primary store's access pattern genuinely needs Redis — atomic CAS transitions via Lua `EVAL` (§2.4) for concurrent `/deliver` requests, and a sorted-set-equivalent for the delete queue (§4). Redis Cloud was chosen over Upstash specifically because Upstash always persists to disk regardless of configuration, which would violate the primary database's requirement outright (see `plans/relay-serverless-migration-strategic-plan.md` §Rationale). That reasoning is unaffected by the device-registry change above — it applies only to the store that actually needs Redis's specific capabilities.

**Pre-deployment exception, 2026-07-03 — Upstash is temporarily in use for `REDIS_PRIMARY_URL` despite the paragraph above.** Redis Cloud's free tier was found to have no TLS support at any level, and `relay-next`'s Redis client hardcodes TLS as mandatory — making free-tier Redis Cloud unusable as built. Upstash supports TLS on its free tier and requires no code changes, so it's being used to unblock pre-deployment testing, with the explicit, documented understanding that **the no-persistence invariant this section describes does not hold while Upstash is in use** — this is a knowing, temporary trade-off for testing with non-real data, not a design change. See `relay-next/PROVISIONING.md` §1a/§1b for the full accounting and the required cutover to a paid Redis Cloud tier before any deployment handling real users.

### 1.1 Topology

Replaces the v0.4 Docker Compose topology diagram (previously in `plans/relay-strategic-plan.md` §Docker Compose topology, now superseded — see that plan's Resolved Questions table).

```
                         ┌─────────────────────────────┐
                         │   Cloudflare Workers (Nitro) │
                         │                              │
  HTTPS  ───────────────▶│  register / deliver /        │
  (device, wallet)       │  pending / ack / health      │
                         │  (stateless handlers)         │
                         └──────────┬───────────────────┘
                                    │
                    ┌───────────────┼────────────────────┐
                    │               │                    │
                    ▼               ▼                    ▼
        ┌───────────────────┐ ┌────────────────┐ ┌──────────────────┐
        │ Redis Cloud        │ │ Cloudflare KV   │ │ Durable Objects   │
        │ PRIMARY            │ │ (device registry)│ │ (Cloudflare-native)│
        │ persistence: OFF   │ │ durable by      │ │                    │
        │                     │ │ platform default│ │ One instance per   │
        │ uuid:*              │ │                 │ │ UUID (WS) or       │
        │ cred:*              │ │ registry:{push_ │ │ device_credential  │
        │ messages:*          │ │ token} → app_id,│ │ (SSE).             │
        │ pending_deletes     │ │ last_registered,│ │                    │
        │                     │ │ TTL 90 days     │ │ In-memory / socket │
        └───────────────────┘ └────────────────┘ │ attachment only —  │
                                                    │ never DO storage.  │
                                                    └─────────┬──────────┘
                                                              │
                                                   WebSocket / SSE
                                                    (device only —
                                                  see relay.md §7.3, §7.4)
                                                              │
                                                              ▼
                                                        Device (holder)

APNs / FCM: invoked from the stateless Workers handlers on the delivery
path (relay.md §7.2 step 7), same as v0.4 — not shown as a separate box
since its role is unchanged by this migration.
```

Key differences from the v0.4 Docker Compose topology this replaces:

- There is no single always-on Node.js process. The stateless HTTP handlers
  run as Cloudflare Workers, invoked per-request.
- The single self-hosted Redis container becomes a single managed Redis
  Cloud database, persistence explicitly disabled (§1's table).
- The SQLite-on-Docker-volume device registry becomes Cloudflare KV,
  accessed via Nitro's `storage()` abstraction (§5).
- The in-process `Map`-based WS/SSE connection tracking
  (`relay/src/routes/ws.ts`'s `activePeers`, `relay/src/utils/sse_connections.ts`)
  becomes per-connection Durable Object instances. This is not merely a
  storage substitution — it changes which system is authoritative for
  connection-liveness state. See §10.

---

## 2. Redis Cloud (Primary) — UUID Store

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

### 2.5 Scan for Stuck Active UUIDs

**Changed from v0.4:** this was a one-time scan run at process startup,
before accepting requests — a natural fit for a single long-running
Node.js process. Cloudflare Workers have no equivalent "process startup"
moment: Workers are invoked per-request with no persistent lifecycle to
hook a one-time scan into. This scan is instead invoked by a **Cloudflare
Cron Trigger** on a short, fixed interval (5 minutes — **confirmed
adequate 2026-07-03** against a real deployed Worker, see below; this is
no longer a placeholder pending real-infrastructure data).

**Real hibernation-eviction test result (2026-07-03):** a single open
WebSocket to a deployed Durable Object (`relay-next/spike-do-ws/`,
`test-hibernation.mjs`) was left idle and probed at increasing intervals.
It survived cleanly through 1, 2, 5, 10, 20, and 30 minutes idle (each
probe confirmed a message actually arrived on the still-open socket, not
just that the socket object was present). The run's later checkpoints are
harder to interpret cleanly: the client process itself showed a ~6-minute
scheduling gap around the 45-minute mark (that checkpoint fired at 51.2
minutes of connection age instead of 45, consistent with the test client
machine being suspended or heavily throttled around that time, not a
server-side event) — it still passed once it ran. The socket then closed
abnormally (code 1006, no clean close handshake) about one minute later,
at 52.3 minutes. Because a client-side interruption (e.g. the client
machine sleeping) would independently sever the underlying TCP connection
regardless of what Cloudflare's own eviction policy does, this one run
cannot cleanly distinguish "Cloudflare evicted the DO around 52 minutes"
from "the test client's own disconnection caused the close" — both are
consistent with the log. **What this run does establish without
ambiguity: hibernation reliably holds a connection open for at least 30
minutes of genuine idle time**, comfortably longer than the 5-minute
reconciliation interval needs to be a safe backstop regardless of the
exact upper bound. No change to `RECONCILIATION_CRON_SCHEDULE`'s 5-minute
default is warranted by this data — if anything it confirms 5 minutes is
conservative, not that it needs tuning tighter or looser. A longer,
multi-run test (ideally from infrastructure that can't itself sleep mid-
test) would be needed to pin down a precise eviction boundary, but no
part of the current design depends on knowing that exact number.

The scan itself is unchanged: a Redis `SCAN` cursor loop with pattern
`uuid:*` (`COUNT` hint of 100, not `KEYS *`, to avoid blocking Redis) over
the **primary** Redis Cloud database. For each key found with
`status == "active"` or `status == "in_flight"`, the transition to
`consumed` is executed using the Lua script above.

**Why this scan still matters even though Durable Objects now own the
`active` state's liveness (see §10):** a DO instance's in-memory state
(and its knowledge of whether its own WebSocket is still genuinely open)
can become inconsistent with the primary database's `status` field if the
Worker or DO crashes, or if Cloudflare evicts a DO instance in a way that
never runs its `webSocketClose` handler (rare, but not impossible — the
Workers platform does not guarantee this handler always fires on every
possible termination path). This scan is the backstop that reconciles
Redis's view of UUID state with reality on a bounded delay, independent of
whether any particular DO instance is alive to report its own status. It
is the direct replacement for the "previous process exited uncleanly"
recovery case in v0.4 — just triggered on a timer instead of at process
start, since there is no process start to hook.

The count of stuck UUIDs transitioned is logged at `WARN` level (via
whatever the Cloudflare-native logging/observability integration is —
Phase 2 detail). A non-zero count indicates a DO instance was evicted, or
crashed, in a way that its own teardown path never ran.

### 2.6 Empty-Store Detection

**Changed from v0.4:** same "no startup moment" issue as §2.5. This check
now runs as part of the same Cloudflare Cron Trigger invocation as the
stuck-UUID scan (§2.5), not as a separate startup-only step.

```
SCAN 0 MATCH uuid:* COUNT 1
```

If the cursor returns 0 results and the returned cursor is 0 (scan
complete), the primary database is considered empty. This triggers the
re-registration notification flow (relay.md §9).

Note: the primary database is also empty immediately after first
deployment (before any registrations) and, more routinely under this
architecture, briefly empty-looking any time the cron interval fires
during a lull with zero currently-outstanding UUIDs — **this is not the
same condition as "the database was reset."** To avoid spuriously sending
re-registration notifications in either case, the check must also confirm
the Cloudflare KV device registry is non-empty AND that this is
the first time the check has observed an empty primary database since the
last time it observed a non-empty one (i.e., detect a transition from
non-empty → empty, not merely "empty right now"). The simplest
implementation: store a single `primary_db_was_empty` boolean-equivalent
flag as a **Cloudflare KV** entry (durable by platform default, so the
flag itself survives primary resets — same store as §5, distinct key) and
only fire the re-registration flow on the false → true transition of that
flag, resetting it to false as soon as any UUID write succeeds again. This
is a behavioral change from v0.4
(which only had one "empty at startup" moment to consider, since startup
was infrequent) and needs unit test coverage in Phase 2 for exactly this
false-positive case: cron fires while zero UUIDs happen to be outstanding,
but the database was never actually reset.

---

## 3. Redis Cloud (Primary) — Message Store

### 3.1 Key Schema

**Corrected during Phase 1 review — this subsection previously said `messages:{push_token}`, which contradicted §8.4 (Device Credential Store) later in this same document, and contradicted the actual behavior of the current implementation (`relay/src/utils/storage/redis.ts`'s `storeMessage(credential, ...)`). Push-token-keying would also have broken the isolation guarantee §8.1 claims — see that section's threat model. The key is, and has always been in the running code, `device_credential`-keyed.**

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

Not performed individually. The message store is cleared atomically on `GET /pending`. For SSE delivery, messages are removed from the store only after `POST /ack` is received; if no ack arrives (connection drop), the blob remains in the store for `GET /pending` pickup.

### 3.3 TTL

The `messages:{device_credential}` key TTL is reset to `UUID_TTL_SECONDS` (default 30 days) on each `RPUSH`. A device that is offline for more than 30 days after its last received message will have its pending blobs expired by Redis. On next wake, the device calls `GET /pending`, receives an empty list, and fetches messages via re-registration and wallet retransmission.

### 3.4 Privacy Note

The message store key includes the device credential, not the push token — see §8.1's threat model for why this distinction matters (push-token-keying would let anyone who learns a device's push token drain its message store; credential-keying requires possessing the credential itself, which is never transmitted alongside the push token). This is consistent with the relay's existing use of `device_credential` as the isolation boundary for all authenticated device-facing endpoints (§6.1, §8). The message store does not add any push-token-linked data beyond what is already present in the UUID store (§2.2, which does store `push_token` per UUID for push dispatch purposes).

---

## 4. Redis Cloud (Primary) — Pending Delete Queue

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

**Changed from v0.4:** this was a `setInterval`-style polling loop inside
the single long-running Node.js process, controlled by
`DELETE_JOB_POLL_INTERVAL_MS`. It is now invoked by a **Cloudflare Cron
Trigger** on the schedule `RECONCILIATION_CRON_SCHEDULE` (§9; default
every 5 minutes — tighter than v0.4's 60-second default, since Cron
Triggers have a practical minimum granularity and this job shares its
trigger with the reconciliation scan, §2.5). The dequeue/retry logic
itself — the actual Redis operations and business rules — is unchanged
and remains portable Nitro application code, not Cloudflare-specific code
(decision #3 in `plans/relay-serverless-migration-implementation-plan.md`:
logic stays portable, only the *trigger* is platform-native).

On each invocation:

1. Dequeue all jobs with `score ≤ now` using the Lua script above.
2. For each job, call `DELETE {wallet_url}/messages/{uuid}`.
3. On success (2xx) or 404: discard the job.
4. On failure (5xx, timeout, network error): requeue with exponential backoff.

**No shutdown-flush equivalent.** v0.4 performed a best-effort final flush
on `SIGTERM` before the long-running process exited. There is no
equivalent lifecycle event for a Cron-Trigger-invoked Worker — each
invocation runs to completion (or Cloudflare's execution-time limit) and
then simply ends; there is no "the service is shutting down, hurry up"
signal to react to. This is not a functional gap: because jobs are
dequeued from Redis before processing (step 1) and only removed from the
queue on confirmed success (step 3), an invocation that is cut off
mid-batch simply leaves its remaining jobs to be picked up by the *next*
scheduled invocation — the same at-least-once guarantee v0.4's shutdown
flush was approximating, achieved here as a natural consequence of the
dequeue-then-process-then-acknowledge ordering rather than as an explicit
shutdown hook.

---

## 5. Cloudflare KV — Device Registry

**Changed from v0.5:** this store was a second Redis Cloud database,
persistence enabled. It is now **Cloudflare KV**, accessed through Nitro's
`storage()` abstraction (the `cloudflare-kv-binding` unstorage driver under
the `cloudflare` preset; a filesystem or in-memory unstorage driver under
`node-server` for local development — see §9's note on portability). Two
things motivated this change, detailed in §1: the free Redis Cloud tier
used for test deployment disables persistence by default (defeating the
one property this store exists for), and KV's native per-key TTL removes
the need for a separate pruning job entirely (old §5.3/§5.4 — see §5.3
below). The durability requirement — survive a primary-database reset — is
unchanged; only the technology and the pruning mechanism changed.

### 5.1 Key Schema

Each device is stored as a single KV entry under the key:

```
registry:{push_token}
```

Unlike Redis, KV has no secondary-index or sorted-set primitive, and none
is needed here: instead of a separate recency index queried by score
range, entries carry their own TTL and simply cease to exist once expired
(§5.3). The "query for re-registration" operation becomes "list current
keys," since anything still present is by construction within the
retention window.

### 5.2 Fields

Each `registry:{push_token}` entry's value is a JSON-encoded object:

```json
{
  "app_id": "<app identifier>",
  "last_registered_at": "<ISO 8601 UTC timestamp, e.g. 2026-06-28T14:23:00Z>"
}
```

`push_token` is the key, not a field (unchanged from v0.5's schema). No
UUID associations are stored here — same invariant as v0.4/v0.5: this
store's only purpose is holding enough information to send a
re-registration push after the primary database resets.

### 5.3 Operations

**Upsert on registration:**

```ts
await storage.setItem(
  `registry:${pushToken}`,
  { app_id: appId, last_registered_at: new Date().toISOString() },
  { ttl: DEVICE_REGISTRY_RETENTION_DAYS * 86400 }
);
```

Called once per `POST /register` request (both bootstrap and
replenishment paths), after UUID records are written to the primary
database. The `ttl` option maps to Cloudflare KV's `expirationTtl`
(minimum 60 seconds; the 90-day default is far above that floor). Because
each upsert re-sets the TTL from that write's timestamp, a device that
re-registers periodically never expires — the same effect v0.5's
recency-indexed prune achieved, now a direct consequence of the storage
primitive rather than a separately-run job.

**Query for re-registration:**

```ts
const keys = await storage.getKeys('registry:');
const devices = await Promise.all(keys.map((k) => storage.getItem(k)));
```

Returns every currently-live device registry entry — anything expired per
its TTL is already gone, so no cutoff-timestamp filtering is needed.
Cloudflare's underlying `list()` operation returns up to 1000 keys per
call and is cursor-paginated for registries larger than that; `storage()`
callers should page through the full key set rather than assume a single
call is exhaustive once the registry grows past 1000 devices. Called when
the primary database is found empty (see §2.6).

**No separate prune operation.** v0.5's weekly `ZRANGEBYSCORE`-based
pruning job is deleted, not ported — KV's `expirationTtl` is enforced by
the platform per entry, so there is nothing left for application code to
do. The 90-day threshold itself (§5.4) is unchanged; only its enforcement
mechanism moved from "a weekly scan deletes old rows" to "each entry
carries its own expiry, set at write time."

**Note on "startup" in a Workers deployment:** unlike the v0.4 long-running
Node.js process, there is no single process "startup" moment in a
Cloudflare Workers deployment — Workers are invoked per-request with no
persistent process lifecycle. The empty-primary-database check and
re-registration trigger (§2.6) instead run as a scheduled task (Cloudflare
Cron Trigger) that periodically checks primary-database health/emptiness,
rather than a one-time startup hook. This is a Phase 2 implementation
detail (decision #3 in
`plans/relay-serverless-migration-implementation-plan.md`: business logic
stays portable, the *trigger* invoking it is necessarily platform-native)
— noted here because it changes when this query actually runs, which is
data-model-relevant.

### 5.4 Retention

Unchanged from v0.4/v0.5: records older than **90 days** since last
registration are gone. The 90-day threshold balances two concerns:

- **Too short:** legitimate users who are dormant (travel, infrequent use) are pruned and do not receive re-registration notifications after a primary-database reset
- **Too long:** the device registry grows without bound; stale push tokens accumulate for uninstalled apps

90 days covers nearly all real-world dormancy patterns while keeping the registry lean. Enforcement is now exact and immediate (platform TTL expiry) rather than a weekly scan with up to a week of drift, which was v0.5's stated acceptable imprecision — this is a strict improvement, not a behavior change requiring new tolerance.

---

## 6. App Registry Config

**Note on this section under the serverless architecture:** the schema,
content, and validation rules below (§6.1–§6.3) are unchanged from v0.4 —
what an app registry entry *contains* is not affected by this migration.
How it is *loaded* is a Phase 2 question this document does not resolve
yet: `key_file` and `service_account_file` are filesystem paths, and
Cloudflare Workers have no local filesystem to read them from at request
time. Candidate approaches (Workers Secrets, KV, or bundling credential
material into the Worker at build time) all have different exposure and
rotation tradeoffs and are explicitly deferred to Phase 2 step 2.5,
alongside the still-unconfirmed decision #4 (in-house vs. third-party
APNs client) — the two are related, since whatever loads and holds the
key material at runtime is shaped by which client reads it. This section
should be revised again once that decision is made; until then, treat
`key_file` and `service_account_file` below as placeholders for "however
Phase 2 ends up sourcing this credential," not as a claim that literal
filesystem paths will work under the `cloudflare` preset.

### 6.1 JSON Schema

The app registry is a JSON file at the path specified by the `APP_REGISTRY_PATH` environment variable. It is loaded once at startup; changes require a service restart. **Under the `node-server` preset this is unchanged.** Under the `cloudflare` preset, "loaded once at startup" has no equivalent moment (see §5.2's note on Workers having no persistent process lifecycle) — the registry must instead be loaded per-invocation from wherever Phase 2 decides it lives (bundled asset, KV, etc.), which may also change what "changes require a restart" means in practice (redeploy vs. an update propagating on next invocation).

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

| State | Meaning | Authoritative system while in this state |
|---|---|---|
| `unused` | UUID has been issued to a device; not yet presented to the relay for delivery | Primary Redis Cloud database |
| `in_flight` | Push dispatch in progress after blob receipt. Transient — prevents double-delivery under concurrent `/deliver` requests. | Primary Redis Cloud database |
| `active` | UUID is registered as a device WebSocket delivery channel (inbound delivery only; relay holds no outbound wallet connection). | **Split** — see below and §10 |
| `consumed` | UUID has been permanently used (blob accepted, or WebSocket session closed). | Primary Redis Cloud database |

`consumed` is a terminal state. `in_flight` is transient: it is resolved to `consumed` or `unused` within the same request lifecycle.

**Key change from v0.2:** Delivery UUIDs now transition to `consumed` when the relay accepts and stores the blob (`POST /deliver/{uuid}`), not when the device picks up the message. Message lifecycle is tracked separately in the message store (§3); UUID status is not used to track delivery to the device.

**Authority split for `active` (new in v0.5 — see §10 for the full model):**
Redis holds the *durable record* that a UUID transitioned to `active` (so
it survives across requests and is what `POST /deliver/{uuid}` checks),
but the Durable Object instance for that UUID is the *sole authority on
whether the connection is still actually live right now*. These can
briefly disagree — e.g., a DO instance's socket drops in a way its
`webSocketClose` handler hasn't yet processed — and that disagreement is
resolved by whichever of the two paths in §7.2 fires first (client
reconnect attempt, delivery attempt, or the periodic reconciliation scan
in §2.5), not by one system unilaterally overriding the other.

### 7.2 Transitions

| From | To | Trigger | Endpoint / mechanism |
|---|---|---|---|
| `unused` | `in_flight` | Blob receipt begins (atomic lock) | `POST /deliver/{uuid}` |
| `in_flight` | `consumed` | Blob stored successfully | `POST /deliver/{uuid}` |
| `in_flight` | `unused` | Blob storage or push dispatch failed | `POST /deliver/{uuid}` |
| `unused` | `active` | Device WebSocket connection accepted | `GET /ws/{uuid}` — Redis transition happens first (plain HTTP handler, before the Durable Object is invoked), then the request is routed to the UUID's Durable Object to actually accept the WebSocket. See §10. |
| `active` | `consumed` | Session teardown (device close or network error) | The Durable Object's `webSocketClose` handler calls back into the stateless layer to perform the Redis transition — the DO itself does not talk to Redis directly (see §10's "why the DO never calls Redis directly"). |
| `active` | `consumed` | Periodic reconciliation scan (§2.5) — replaces v0.4's startup-only unclean-shutdown recovery | Cloudflare Cron Trigger, on a fixed interval |
| `in_flight` | `consumed` | Periodic reconciliation scan (§2.5) — replaces v0.4's startup-only crash recovery | Cloudflare Cron Trigger, on a fixed interval |
| TTL expiry | key deleted | 30 days elapsed with no transition | Redis automatic |

### 7.3 Invalid Transitions

| Attempted transition | Error returned |
|---|---|
| Any → from `consumed` | `UUID_CONSUMED` (410 or WebSocket 4010) |
| `in_flight` → via a second `/deliver` call | `UUID_CONSUMED` (410) |
| `active` → `unused` | Rejected by Redis transition logic |
| Transition on unknown key | `UNKNOWN_UUID` (404 or WebSocket 4004) |

**Reconciliation scan (replaces v0.4's "startup scan"):** `in_flight` and
`active` UUIDs found stuck by the periodic scan (§2.5) are transitioned to
`consumed` — same logic as v0.4, just triggered by a Cron Trigger instead
of process startup, since Cloudflare Workers have no process-startup
moment to hook this into (there is no long-running process at all). Both
counts are logged at `WARN` level.

**Simplification enabled by Durable Objects (Goal 2 of
`plans/relay-serverless-migration-strategic-plan.md`):** v0.4's
`unused → active` and `active → consumed` transitions used the same
Lua-script CAS pattern as the `/deliver` path, because the v0.4
architecture had multiple Node.js processes/connections that could race
on the same UUID's WebSocket slot. Under the Durable Object model, at most
one DO instance ever exists for a given UUID, and that instance is
single-threaded — there is no possible race on "did a WebSocket already
open for this UUID" once the DO is actually handling it. The Lua CAS
script is retained *only* for the `unused ⇄ in_flight ⇄ consumed`
transitions on the `/deliver/{uuid}` path (a plain, potentially
concurrent, stateless HTTP handler — see decision context in
`plans/relay-serverless-migration-implementation-plan.md` step 2.1). The
initial `unused → active` transition (§7.2) is a simple conditional
update, not a CAS retry loop, because by the time the Durable Object is
invoked, the plain-HTTP-handler layer has already resolved any race on
"is this UUID currently claimable" via the existing Redis transition
logic — the DO is only reached at all if that succeeded.

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

**Changed from v0.4:** `REDIS_URL` and `DB_PATH` are replaced by one Redis
Cloud connection string plus a Cloudflare KV binding (see
`relay-next/PROVISIONING.md` for the provisioning steps that produce
these). `PORT` is removed — a Cloudflare Workers deployment does not bind
a listening port the way a Node.js process does; the `node-server` Nitro
preset (used for local development and for the non-Cloudflare portability
target — see `plans/relay-serverless-migration-strategic-plan.md` Goal 3)
still uses a port, but that is a Nitro/Node runtime concern, not part of
this data model's environment contract. `DELETE_JOB_POLL_INTERVAL_MS` is
replaced by a Cloudflare Cron Trigger schedule expression rather than a
millisecond poll interval, consistent with §2.5/§7.2's platform-native-
trigger notes.

**Changed from v0.5:** `REDIS_REGISTRY_URL` is removed — the device
registry (§5) moved to Cloudflare KV, which is not addressed by a
connection-string env var the way Redis is. Under the `cloudflare`
preset, the KV namespace is wired as a binding in `wrangler.toml`
(conventionally named `DEVICE_REGISTRY`) rather than an environment
variable — Nitro's `storage()` picks it up via that binding automatically
when configured with the `cloudflare-kv-binding` driver. Under
`node-server`, `storage()` is instead configured with a different
unstorage driver (filesystem or in-memory) directly in `nitro.config.ts`,
requiring no env var either — this is the portability benefit noted in §1:
local development needs no Redis Cloud credentials for this store at all.

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_PRIMARY_URL` | Yes | — | Connection string (TLS, `rediss://`) for the persistence-off Redis Cloud database — UUIDs, credentials, messages, delete queue |
| `APP_REGISTRY_PATH` | Yes | — | Path to the app registry JSON config file. On Cloudflare, this is expected to be bundled at build time or loaded from a KV/Workers-static-asset equivalent — Phase 2 implementation detail; the app registry's *content* and *validation rules* (§6) are unchanged. |
| `RELAY_ID` | Yes | — | Unique identifier for this relay deployment, included in re-registration push payloads |
| `UUID_TTL_SECONDS` | No | `2592000` | TTL for UUID records and device credentials in the primary Redis Cloud database (default 30 days) |
| `DEVICE_REGISTRY_RETENTION_DAYS` | No | `90` | Age threshold for device registry pruning |
| `MAX_DELETE_DELAY_SECONDS` | No | `21600` | Upper bound of staggered wallet delete delay (default 6 hours) |
| `RECONCILIATION_CRON_SCHEDULE` | No | `*/5 * * * *` | Cloudflare Cron Trigger expression for the reconciliation scan (§2.5) and delete-queue/pruning jobs (§4.4, §5.3). Replaces v0.4's `DELETE_JOB_POLL_INTERVAL_MS`. |
| `NODE_ENV` | No | `production` | Set to `development` for verbose logging and stub push mode. Applies under the `node-server` preset; behavior under the `cloudflare` preset uses Workers' own environment/`wrangler` environment concept instead — Phase 2 detail. |

---

## 10. Authority Split: Redis Cloud vs. Durable Objects

This section exists because Phase 1 review of this migration found that
"Durable Objects hold the live connection, Redis holds everything else"
is not precise enough to implement against — the two systems both have
something to say about a UUID or device credential's state while a
connection is open, and a spec that leaves their interaction implicit
invites Phase 2 to invent an ad hoc answer per code path. This section is
the single authoritative statement of which system decides what.

### 10.1 The two systems and what each one is FOR

| System | Is authoritative for | Is NOT authoritative for |
|---|---|---|
| **Primary Redis Cloud database** | Whether a UUID exists at all, its `status` field's durable value, message blob contents, the delete queue, device credential validity/TTL | Whether a WebSocket/SSE connection is *actually still open right now* at the edge |
| **Durable Object (per UUID, or per `device_credential` for SSE)** | Whether a specific connection is actually open right now, delivering a message into that connection if it is, hibernation/eviction of the connection's compute | Whether the UUID is allowed to be used at all, the UUID's `status` field's durable value, anything that must survive a DO instance being evicted with no reconnect |

Neither system is "more authoritative" in general — they are authoritative
for different questions. A request handler that needs to answer "is this
UUID valid and unused" asks Redis. A request handler that needs to answer
"is there a live connection to push this blob into right now" asks the
relevant Durable Object. `POST /deliver/{uuid}` (relay.md §7.2) asks both,
in sequence, precisely because it needs both answers.

### 10.2 Why the Durable Object never calls Redis directly

The Durable Object classes (one per UUID for `GET /ws/{uuid}`, one per
`device_credential` for `GET /sse`) do not hold a Redis client and do not
make Redis calls themselves. All Redis reads/writes happen in the
stateless Nitro HTTP-handler layer, which then invokes the Durable Object
(or is invoked by it) via ordinary `fetch()` calls between Workers. Two
reasons:

1. **Portability (Goal 3).** Keeping all Redis access in the stateless
   layer means that layer genuinely runs unmodified under both the
   `cloudflare` and `node-server` Nitro presets (strategic-plan.md Goal 3,
   Key Objective: "the `register`/`deliver`/`pending`/`ack`/`health`
   handlers and the Redis Cloud data-access layer run unmodified under
   both presets"). If DO classes also embedded Redis calls, that code
   would only ever run on Cloudflare, quietly widening the portability
   gap beyond what Goal 3 says is acceptable (DO-backed connections
   themselves are Cloudflare-specific by design; the *storage access
   pattern* does not need to be).
2. **Simplicity of the DO's own concurrency model.** A Durable Object
   instance is single-threaded and already the sole authority on its own
   connection's liveness (§10.1). Giving it a second responsibility —
   also being a Redis client, also handling Redis connection failures,
   retries, and TLS — adds failure modes to the one thing DOs are
   supposed to do simply. The plain HTTP-handler layer already has to
   handle Redis connectivity for every other endpoint; reusing it here
   avoids a second, DO-specific Redis error-handling path.

### 10.3 The interaction, step by step

**Opening a connection (`GET /ws/{uuid}`):**

1. The stateless Nitro handler receives the upgrade request. It performs
   the Redis-side validation and transition exactly as today: look up
   `uuid:{uuid}`, confirm `status == "unused"`, transition to `active`
   (relay.md §7.3, relay_data_model.md §7.2). This is a plain,
   potentially-concurrent HTTP handler, so this step still needs the
   existing conditional-update safety it has today (not a full CAS retry
   loop — see §7.2's simplification note — but still a check-then-set
   that must not race).
2. Only after that Redis transition succeeds does the handler forward the
   upgrade to the UUID's Durable Object (`idFromName(uuid)`), which
   accepts the WebSocket via the Hibernation API (`acceptWebSocket`, not
   the interactive `accept()`).
3. If step 1 fails (UUID unknown, already consumed, etc.), the DO is never
   invoked — the rejection happens entirely in the stateless layer, same
   error codes as before (relay.md §7.3's WebSocket close codes).

**Delivering a message (`POST /deliver/{uuid}`):**

1. The stateless Nitro handler performs the existing Redis-side
   transition (`unused → in_flight → consumed`, relay.md §7.2) exactly as
   today — this part of the flow does not involve the Durable Object at
   all, and is unchanged by this migration.
2. Once the blob is durably stored, the handler asks the UUID's Durable
   Object (via `fetch()`) whether it currently holds an open connection.
   If yes, the DO delivers the blob directly into that connection and
   reports success back to the handler. If no live connection exists (DO
   reports none, or the DO instance doesn't exist because no connection
   was ever opened for this UUID), the handler falls back to silent push,
   exactly as today.
3. **This is a two-step check, not a single combined operation**, and
   step 2's outcome never changes step 1's Redis transition — the blob is
   already durably stored in the message store regardless of whether a
   live connection happens to exist. This preserves the existing
   at-least-once delivery guarantee: if the DO's connection state turns
   out to be stale (e.g., the socket dropped microseconds before this
   check), the blob is still safely in the message store for the device
   to pick up via `GET /pending`, same as any other missed-live-delivery
   case today.

**Closing a connection (device disconnect, error, or DO eviction with a
running teardown path):**

1. The Durable Object's `webSocketClose` (or equivalent error) handler
   fires inside the DO.
2. The DO calls back into the stateless layer (a `fetch()` to an internal
   endpoint, or an equivalent Nitro-native mechanism — Phase 2
   implementation detail) to request the Redis `active → consumed`
   transition. The DO does not perform this Redis write itself (§10.2).
3. If the DO is evicted in a way that this handler never runs (§2.5's
   caveat), the UUID is left in `active` in Redis until the periodic
   reconciliation scan catches it. This is a **bounded staleness window**,
   not a correctness violation: the UUID cannot be reused while stuck in
   `active` (relay_data_model.md §7.3, `active → unused` is rejected), and
   the reconciliation scan resolves it within one scan interval
   (`RECONCILIATION_CRON_SCHEDULE`, default every 5 minutes).

### 10.4 What must never happen (privacy invariant, restated for this split)

Neither the stateless handler layer nor any Durable Object may write a
UUID, `device_credential`, or any value derived from either, to: Cloudflare
KV, Cloudflare D1, or Durable Object *storage* (`this.ctx.storage.*`
methods). Durable Object storage is SQLite-backed, disk-resident, with
30-day point-in-time recovery on by default (strategic-plan.md
"Why Durable Object storage is the wrong place for UUID associations") —
writing UUID-linked data there would silently reintroduce the exact
disk-recoverability risk the primary Redis Cloud database's
persistence-off configuration exists to prevent. In-memory Durable Object
instance fields and `WebSocket.serializeAttachment`/`deserializeAttachment`
are the only DO-side state permitted, because both are RAM-scoped by the
platform and never written to disk.

**This does not conflict with §5's use of Cloudflare KV for the device
registry.** The prohibition above is scoped to UUID- and
`device_credential`-linked data specifically — the privacy-critical
associations Redis's persistence-off configuration protects. The device
registry has never stored UUID associations or device credentials (§5.2:
only `push_token`, `app_id`, `last_registered_at`); it is explicitly meant
to be durable, which is the entire reason it lives outside the primary
Redis Cloud database in the first place (§1). Writing it to KV is the
store doing its intended job, not an exception to this invariant.
