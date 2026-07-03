# Notification Relay — Service Spec

**Version:** 0.8 (draft)
**Date:** 2026-07-02
**Status:** Draft — describes the target serverless architecture; not yet implemented (Phase 2 of `plans/relay-serverless-migration-implementation-plan.md`). This revision is itself a draft pending user review and approval — see that plan's step 1.4.
**Amends:** v0.7 — the device registry moves from a second Redis Cloud database to **Cloudflare KV** (via Nitro's `storage()` abstraction), per revised decision #2 in `plans/relay-serverless-migration-implementation-plan.md`. §9 (re-registration on store reset) updated accordingly. §2 and §4 also corrected: they still referred to the device registry as SQLite, a stale holdover from v0.4 that v0.6/v0.7's amendments missed. Full authoritative detail lives in `specs/object_specs/relay_data_model.md` §5 and §10.4 — this document defers to that one rather than duplicating it.
**Amends (v0.6 → v0.7, carried forward):** §7.3 (`GET /ws/{uuid}`) and §7.4 (`GET /sse`) describe a Cloudflare Durable-Object-backed connection model (one Durable Object instance per UUID for WS, one per `device_credential` for SSE) replacing the in-process `Map`-based connection tracking (`activePeers` in `relay/src/routes/ws.ts`, the module-level `Map` in `relay/src/utils/sse_connections.ts`). §5 (App Registry) startup-loading note qualified for the loss of a single-process "startup" moment. See `plans/relay-serverless-migration-strategic-plan.md` and its companion implementation plan for the full rationale.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Relationship to Existing Specs](#2-relationship-to-existing-specs)
3. [Actors](#3-actors)
4. [Privacy Properties](#4-privacy-properties)
5. [App Registry](#5-app-registry)
6. [Authentication](#6-authentication)
7. [Endpoints](#7-endpoints)
   - 7.1 [POST /register](#71-post-register)
   - 7.2 [POST /deliver/{uuid}](#72-post-deliveruuid)
   - 7.3 [GET /ws/{uuid}](#73-get-wsuuid)
   - 7.4 [GET /sse](#74-get-sse)
   - 7.5 [GET /pending](#75-get-pending)
   - 7.6 [POST /ack](#76-post-ack)
   - 7.7 [GET /health](#77-get-health)
   - 7.8 [POST /notify/{uuid} (deprecated)](#78-post-notifyuuid-deprecated)
8. [UUID Lifecycle](#8-uuid-lifecycle)
9. [Re-registration on Store Reset](#9-re-registration-on-store-reset)
10. [Error Codes](#10-error-codes)
11. [Open Questions](#11-open-questions)

---

## 1. Overview

The notification relay is an HTTP and WebSocket service that bridges wallet services to holder devices without allowing either party to identify the other. It now operates as a **message buffer**: the wallet service deposits encrypted blobs at the relay, and the relay delivers them to the device via the highest-priority available channel.

Delivery priority (highest to lowest):

1. **SSE** — device-level event stream, used when the app is in the foreground but not in active chat
2. **WebSocket** — per-card bidirectional bridge, used when the app is in an active chat session
3. **Silent push** — APNs/FCM wakeup, used when the app is backgrounded
4. **`GET /pending`** — device pull on wake, after receiving a push or returning from offline

The relay stores a mapping from opaque single-use UUIDs to device credentials and push tokens. It also holds encrypted message blobs in RAM until the device picks them up. It does not store card identities, message content in readable form, or any data that would allow it to correlate a UUID to a card.

UUID associations and message blobs are held exclusively in RAM (Redis with no persistence). The relay never writes UUID-to-device mappings or message blobs to disk. See §4 for the full privacy model and §9 for the store-reset recovery flow.

---

## 2. Relationship to Existing Specs

| Spec | Relationship |
|---|---|
| `specs/process_specs/notification_relay.md` | Process-level spec this document implements. Defines delivery processes, UUID pools, device credentials, multi-device, and privacy properties. |
| `specs/process_specs/message_routing.md` | Defines how wallet services route messages to recipient cards and deliver blobs to the relay. |
| `specs/process_specs/wallet_backup_and_recovery.md` | Device registration and key management; UUID pool replenishment lifecycle. |
| `specs/object_specs/relay_data_model.md` | Redis key schema, message store, delete queue, device credential store, UUID state machine, Cloudflare-KV-backed device registry, and app registry config. |

---

## 3. Actors

| Actor | Role |
|---|---|
| **Device** | iOS or Android client. Calls `POST /register` to obtain UUIDs and device credential. Opens SSE stream via `GET /sse`. Polls `GET /pending` on wake. Calls `POST /ack` to confirm receipt. Opens per-card WebSocket via `GET /ws/{uuid}`. |
| **Wallet service** | Deposits encrypted blobs via `POST /deliver/{uuid}`. Retains messages until `DELETE /messages/{uuid}` arrives from the relay. |
| **Relay service** | This service. Buffers blobs in RAM. Delivers via SSE, WebSocket, or silent push. Sends staggered deletes to wallet after device ack. |
| **APNs / FCM** | Platform push infrastructure. Receives delivery requests from the relay; delivers silent pushes to backgrounded devices. |

---

## 4. Privacy Properties

| Party | Knows | Does not know |
|---|---|---|
| Wallet service | Card hash → subcard_hash → UUID(s) | Device identity, push token, device credential, which subcards belong to the same physical device |
| Relay service | UUID → device credential + push token; device credential → pending blobs | Card hash, card identity, message content (blobs are E2E encrypted) |

UUID associations must never be written to disk. Redis runs with persistence explicitly disabled (`--save "" --appendonly no`).

The device registry (Cloudflare KV) stores only push tokens and `app_id` — no UUID associations, no device credentials, no card-linkable data.

---

## 5. App Registry

The relay serves multiple apps. Each app is a distinct wallet service deployment identified by an `app_id`. The app registry maps `app_id` to:

| Field | Description |
|---|---|
| `app_id` | Unique string identifier supplied by the device at registration |
| `platform` | `"apns"` or `"fcm"` |
| `wallet_base_url` | Base HTTPS URL of the wallet service. Used for staggered delete calls (`DELETE {wallet_base_url}/messages/{uuid}`). Outbound device messages go directly from device to this URL, not via the relay. |
| `apns` | APNs credentials (required if `platform == "apns"`): `key_file`, `key_id`, `team_id`, `bundle_id`, `sandbox` |
| `fcm` | FCM credentials (required if `platform == "fcm"`): `service_account_file` |

Loaded from JSON at startup (`APP_REGISTRY_PATH`). Changes require a restart. **Under the Cloudflare Workers deployment target, there is no single-process "startup" moment, and how the registry is sourced at all is a Phase 2 open item — see `relay_data_model.md` §6's note.** This section's description of the registry's *content* is otherwise unchanged.

---

## 6. Authentication

### 6.1 Device Credential

All device-facing endpoints except the bootstrap `POST /register` require a **device credential** in the `Authorization` header:

```
Authorization: Bearer {device_credential}
```

The device credential is an opaque random token issued by the relay at first registration and stored by the device in secure storage (iOS Keychain / Android Keystore). It authenticates the device for the lifetime of the UUID pool.

**What it protects:**

- `GET /sse`, `GET /pending`, `POST /ack`: Only the legitimate device (which holds the credential) can receive messages or trigger wallet clearance. An attacker who knows the push token but not the credential cannot drain the message store or falsely ack messages.
- `POST /register` (replenishment): Only the device holding the existing credential can add UUIDs to its pool. A fresh `POST /register` without auth creates a new isolated credential — it cannot inject UUIDs into or access messages from an existing device's pool.

**Message store isolation:** The message store is keyed by `device_credential`, not by `push_token`. Two `POST /register` calls with the same push token but no shared credential produce entirely isolated message stores. Wallet-originated blobs only arrive in the store associated with the credential whose UUIDs the wallet was given.

### 6.2 Wallet Service Authentication

`POST /deliver/{uuid}` is called by the wallet service. The UUID itself is the credential — it is a single-use secret known only to the wallet service (received from the device at UUID registration time). No additional authentication header is required; UUID possession is sufficient proof.

The relay validates that the UUID exists, is in `unused` status, and atomically transitions it to `in_flight` before processing — preventing double-delivery if two wallet service instances race on the same UUID.

### 6.3 Credential Lifecycle

| Event | Credential behavior |
|---|---|
| First `POST /register` (no auth) | New credential issued; stored in Redis with 30-day TTL |
| Replenishment `POST /register` (with auth) | Existing credential TTL refreshed; push_token updated if rotated |
| Credential not presented on authenticated endpoint | 401 `MISSING_CREDENTIAL` |
| Credential unknown or expired | 401 `INVALID_CREDENTIAL` |
| Redis restart | All credentials lost; device must re-bootstrap; wallet re-registration triggered via push |

---

## 7. Endpoints

### 7.1 POST /register

Generates a pool of single-use UUIDs and (on first call) a device credential.

#### Request

```
POST /register
Content-Type: application/json
Authorization: Bearer {device_credential}   ← omit on first (bootstrap) call
```

```json
{
  "app_id":     "string — required",
  "push_token": "string — required",
  "count":      "integer — optional, 1–100, default 10"
}
```

#### Processing

**Bootstrap (no `Authorization` header):**

1. Validate `app_id` and `push_token`.
2. Generate a new `device_credential` (cryptographically random, 32 bytes, hex or base64url encoded).
3. Store `cred:{device_credential} → { push_token, app_id, created_at }` with TTL `UUID_TTL_SECONDS`.
4. Generate `count` UUIDs, each stored as `uuid:{uuid} → { app_id, push_token, wallet_base_url, device_credential, status: "unused" }` with TTL `UUID_TTL_SECONDS`.
5. Upsert push token in the Cloudflare KV device registry.
6. Return UUIDs and device credential.

**Replenishment (`Authorization: Bearer {credential}` present):**

1. Validate credential against `cred:{credential}`. Return 401 if unknown or expired.
2. Validate `app_id` and `push_token`.
3. Update `cred:{credential}` with new `push_token` (if rotated) and refresh TTL.
4. Generate `count` new UUIDs under the same credential.
5. Upsert push token in the Cloudflare KV device registry.
6. Return only the new UUIDs (no credential in response — device already has it).

#### Response — 200 OK

Bootstrap:
```json
{
  "uuids":             ["uuid-v4", "..."],
  "device_credential": "opaque-token-string"
}
```

Replenishment:
```json
{
  "uuids": ["uuid-v4", "..."]
}
```

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `MISSING_FIELD` | `app_id` or `push_token` absent or empty |
| 400 | `INVALID_COUNT` | `count` present but outside 1–100 |
| 401 | `INVALID_CREDENTIAL` | `Authorization` header present but credential unknown or expired |
| 404 | `UNKNOWN_APP` | `app_id` not in app registry |
| 500 | `INTERNAL_ERROR` | Redis write failed |

---

### 7.2 POST /deliver/{uuid}

Accepts an encrypted message blob from the wallet service, stores it, and delivers to the device via the best available channel.

**Called by the wallet service.** No `Authorization` header — UUID possession is the credential.

#### Request

```
POST /deliver/{uuid}
Content-Type: application/json
```

```json
{
  "blob": "string — E2E encrypted message, base64url encoded"
}
```

#### Processing

1. Validate `uuid` format. Return 400 if not UUID v4.
2. Look up UUID in Redis. Return 404 if not found.
3. Confirm `status == "unused"`. Return 410 if `consumed`, `active`, or `in_flight`.
4. Atomically transition UUID `unused → in_flight`. Return 410 if transition fails (concurrent race).
5. Store blob in message store: `RPUSH messages:{device_credential} <entry>` where entry includes `uuid`, `blob`, `wallet_url`, `received_at`.
6. Transition UUID `in_flight → consumed`.
7. Attempt immediate delivery (in order):
   - If SSE connection open for this `device_credential`: stream `data: {"uuid":"<uuid>","blob":"<blob>"}`. Do not remove from message store yet — wait for `POST /ack`.
   - Else if WebSocket session active: forward blob. Schedule staggered delete on delivery.
   - Else: dispatch silent push via APNs/FCM with payload `{ "uuid": "<uuid>" }`.
8. Return 200.

On storage failure (Redis error): transition UUID `in_flight → unused` and return 500.

#### Response — 200 OK

Empty body.

#### State effects

- UUID: `unused → in_flight → consumed` (or rolls back to `unused` on storage failure)
- Blob stored in `messages:{device_credential}`
- Silent push dispatched if device not reachable via SSE or WebSocket

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `INVALID_UUID` | Path param not a valid UUID v4 |
| 400 | `MISSING_FIELD` | `blob` absent or empty |
| 404 | `UNKNOWN_UUID` | UUID not found in Redis |
| 410 | `UUID_CONSUMED` | UUID already used or in use |
| 500 | `INTERNAL_ERROR` | Redis failure |

---

### 7.3 GET /ws/{uuid}

Opens an inbound WebSocket delivery channel for the device. While this connection is open, the relay delivers incoming message blobs directly over the WebSocket rather than via silent push. Used when the app is in an active chat session.

**Inbound only.** Outbound messages (device → wallet) are sent by the device directly to the wallet service HTTPS endpoint (`wallet_base_url`). The relay does not proxy outbound messages and does not open any connection to the wallet service on behalf of this endpoint.

**Connection model (changed from v0.6):** the connection is now backed by a
Cloudflare Durable Object, one instance per UUID, addressed via
`idFromName(uuid)`, using the Workers Hibernation API
(`acceptWebSocket`/`getWebSockets`, not the interactive `accept()`) so
billable compute stops accruing while the connection is idle. This
replaces the in-process `activePeers` `Map` the current Node.js
implementation uses. The full statement of which system (the stateless
Redis-backed HTTP layer, or the Durable Object) is authoritative for which
part of this connection's state — and exactly how the two stay
consistent — is specified in `specs/object_specs/relay_data_model.md`
§10; this section describes the resulting request-visible behavior, not
the internal split (see that section for the internal detail).

#### Upgrade request

```
GET /ws/{uuid}
Connection: Upgrade
Upgrade: websocket
```

#### Connection establishment

1. Validate UUID format. Close 4000 if invalid.
2. Look up UUID in Redis (primary database). Close 4004 if not found.
3. Confirm `status == "unused"`. Close 4010 if not.
4. Transition `unused → active` in Redis.
5. Forward the upgrade to the UUID's Durable Object instance
   (`idFromName(uuid)`), which accepts the WebSocket via the Hibernation
   API. The Durable Object is only reached if step 4 succeeded — a
   rejection at steps 1–3 never invokes the Durable Object at all.
6. Confirm connection to device (no outbound wallet connection is opened).

Steps 1–4 happen in the stateless Nitro HTTP-handler layer, not inside
the Durable Object — see `relay_data_model.md` §10.2 for why the Durable
Object never talks to Redis directly.

#### Message flow

**Inbound (wallet → device):** When `POST /deliver/{uuid}` arrives for a
UUID whose Durable Object currently holds an open WebSocket, the relay
delivers the blob over the open WebSocket:

```
{"uuid": "<uuid>", "blob": "<base64url>"}
```

This is now a direct UUID → Durable Object address (`idFromName(uuid)`),
not a `device_credential`-keyed lookup — the addressing key for `GET
/ws/{uuid}` connections is the UUID itself, matching the endpoint's own
path parameter. (Contrast with `GET /sse`, §7.4, which is keyed by
`device_credential` because it is a device-level, not per-UUID, channel.)

**Outbound (device → wallet):** The device sends outbound messages directly to the wallet service HTTPS endpoint. Any frames sent by the device over this WebSocket connection are ignored by the relay (the connection is delivery-only). The device is responsible for tracking the `wallet_base_url` for its wallet service.

#### Session teardown

On device-side close or network error: the Durable Object's close/error
handler fires, and it requests the Redis `active → consumed` transition
via the stateless layer (`relay_data_model.md` §10.3) — the Durable
Object does not write to Redis itself. If the Durable Object is evicted
in a way that this handler never runs, the UUID remains `active` in Redis
until the periodic reconciliation scan (`relay_data_model.md` §2.5, §7.2)
transitions it to `consumed` on a bounded delay (default every 5 minutes).
This is a change from v0.6's assumption that teardown is always
synchronous with the connection closing — see `relay_data_model.md` §10.3
for the bounded-staleness reasoning.

#### WebSocket close codes

| Code | Name | Condition |
|---|---|---|
| 4000 | `INVALID_UUID` | Path param not a valid UUID v4 |
| 4004 | `UNKNOWN_UUID` | UUID not found in Redis |
| 4010 | `UUID_CONSUMED` | UUID already used or in-flight |
| 1001 | `GOING_AWAY` | Device disconnected |
| 1011 | `INTERNAL_ERROR` | Redis error during transition |

---

### 7.4 GET /sse

Opens a device-level Server-Sent Events stream. Receives delivery events for all of the device's cards in the foreground.

**Called by the device.** Requires device credential.

**Connection model (changed from v0.6):** like `GET /ws/{uuid}` (§7.3),
this connection is now backed by a Cloudflare Durable Object using the
Hibernation API — but addressed by `idFromName(device_credential)`, not
by UUID, since this is a device-level channel shared across all of a
device's cards, not a per-UUID channel. This replaces the module-level
`Map<device_credential, SSEConnection>` the current Node.js implementation
uses (`relay/src/utils/sse_connections.ts`). Nitro's `crossws` adapters
support both WebSocket and SSE-shaped connections; whether this endpoint
is implemented as a genuine long-lived SSE response streamed from within
the Durable Object, or reimplemented as a WebSocket-shaped connection that
the stateless layer translates back into SSE framing for the device, is a
Phase 2 implementation decision — either is compatible with this section's
request/response contract, which is unchanged from v0.6.

#### Request

```
GET /sse
Authorization: Bearer {device_credential}
Accept: text/event-stream
```

#### Processing

1. Validate credential. Return 401 if missing or invalid.
2. Resolve `device_credential → push_token`.
3. Forward the connection to the `device_credential`'s Durable Object
   instance (`idFromName(device_credential)`), which registers the
   connection using the Hibernation API. As with §7.3, this happens in
   the stateless Nitro HTTP-handler layer first (steps 1–2), and the
   Durable Object is only reached after credential validation succeeds —
   see `relay_data_model.md` §10.2 for why Redis access stays out of the
   Durable Object entirely.
4. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
5. Send heartbeat comment every 30 seconds: `:\n\n`.
6. On `POST /deliver/{uuid}` arriving for a UUID whose `device_credential`
   matches this connection's Durable Object, while the SSE connection is
   open: stream the event immediately (§7.2 step 7). This requires the
   stateless handler to resolve `uuid → device_credential` (already part
   of the existing UUID record, §7.2) before checking whether that
   credential's Durable Object holds a live connection — same two-step
   check-then-deliver pattern as §7.3's WebSocket delivery path
   (`relay_data_model.md` §10.3).
7. On connection close (app backgrounds, network drop): the Durable
   Object's close handler fires and the connection is torn down. Unlike
   `GET /ws/{uuid}`, there is no UUID state transition to perform here —
   the SSE channel is not itself tied to any single UUID's lifecycle, so
   there is nothing in Redis for this teardown to update.

#### Event format

```
data: {"uuid":"<uuid>","blob":"<base64url>"}

```

(One event per delivered message. Each event is followed by a blank line per SSE spec.)

#### Response

`200 OK` with `Content-Type: text/event-stream`. Connection held open until closed by client or server.

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `MISSING_CREDENTIAL` | No `Authorization` header |
| 401 | `INVALID_CREDENTIAL` | Credential unknown or expired |

---

### 7.5 GET /pending

Returns all pending blobs for the device. Called on wake (after silent push or app launch).

**Called by the device.** Requires device credential.

#### Request

```
GET /pending
Authorization: Bearer {device_credential}
```

#### Processing

1. Validate credential. Return 401 if missing or invalid.
2. Atomically read and clear `messages:{device_credential}` (Lua script: LRANGE then DEL).
3. Return all entries.

If no messages are pending, returns an empty array (not an error).

#### Response — 200 OK

```json
{
  "messages": [
    { "uuid": "<uuid>", "blob": "<base64url>" },
    ...
  ]
}
```

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `MISSING_CREDENTIAL` | No `Authorization` header |
| 401 | `INVALID_CREDENTIAL` | Credential unknown or expired |
| 500 | `INTERNAL_ERROR` | Redis failure |

---

### 7.6 POST /ack

Acknowledges successful receipt of one or more delivered messages. Triggers staggered wallet clearance for each UUID.

**Called by the device.** Requires device credential.

#### Request

```
POST /ack
Authorization: Bearer {device_credential}
Content-Type: application/json
```

```json
{
  "uuids": ["<uuid>", "..."]
}
```

#### Processing

1. Validate credential. Return 401 if missing or invalid.
2. For each UUID in `uuids`:
   a. Look up UUID record to retrieve `wallet_base_url`.
   b. Compute `execute_at = now + random(0, MAX_DELETE_DELAY_SECONDS)`.
   c. `ZADD pending_deletes <execute_at> <job_json>` where job includes `wallet_url`, `uuid`, `attempts: 0`.
3. Return 200.

UUIDs not found in Redis (expired or unknown) are silently skipped — they were already consumed and cleared.

#### Response — 200 OK

Empty body.

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 401 | `MISSING_CREDENTIAL` | No `Authorization` header |
| 401 | `INVALID_CREDENTIAL` | Credential unknown or expired |
| 400 | `MISSING_FIELD` | `uuids` absent or empty array |
| 500 | `INTERNAL_ERROR` | Redis failure |

---

### 7.7 GET /health

Returns operational status of the relay and its dependencies.

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
  "status":  "degraded",
  "redis":   "ok" | "error",
  "sqlite":  "ok" | "error"
}
```

The relay returns 503 if either dependency is unreachable. Each reports independently. The health check performs a Redis `PING` and a SQLite `SELECT 1` — no UUID round-trip, no push dispatch.

---

### 7.8 POST /notify/{uuid} (Deprecated)

This endpoint has been superseded by `POST /deliver/{uuid}` (§7.2). It accepted a bodyless trigger from the wallet service and dispatched a silent push without storing a blob.

**All callers must migrate to `POST /deliver/{uuid}`.**

#### Current behavior

Returns `410 Gone` with error code `ENDPOINT_DEPRECATED` and a `Location` header pointing to `POST /deliver/{uuid}`.

```json
{ "error": "ENDPOINT_DEPRECATED", "message": "Use POST /deliver/{uuid}" }
```

This behavior will be removed in a future version.

---

## 8. UUID Lifecycle

```
             ┌─────────┐
             │ unused  │ ← created by POST /register (TTL: 30 days)
             └────┬────┘
                  │
        ┌─────────┴──────────┐
        │                    │
   blob delivery         websocket open
   (§7.2 step 4)        (§7.3 step 4)
        │                    │
        ▼                    ▼
  ┌───────────┐        ┌──────────┐
  │ in_flight │        │  active  │ ← device WebSocket delivery channel open
  └─────┬─────┘        └────┬─────┘   (inbound delivery only; relay does not
        │                   │          open any connection to wallet service)
   ┌────┴────┐          session close
   │         │          (§7.3 teardown)
 stored   failed               │
   │         │                 ▼
   │         │           ┌──────────┐
   │         └──────────▶│ consumed │
   ▼          (→ unused) └──────────┘
┌──────────┐
│ consumed │  ← blob stored in messages:{credential}
└──────────┘     delivery to device tracked separately
```

UUID `consumed` means the relay has accepted responsibility for the blob — not that the device has received it. Message lifecycle continues independently in the message store.

**Note on "session close" under the Durable-Object-backed connection model (v0.7):** the diagram's `active → consumed` transition on session close is usually synchronous with the WebSocket actually closing, but is not guaranteed to be — see §7.3's teardown description and `relay_data_model.md` §10.3 for the case where a Durable Object is evicted before its close handler runs. The diagram describes the common case; the bounded-staleness fallback (periodic reconciliation scan) is the correctness backstop, not shown here to keep the diagram legible.

**Latency note (HTTPS delivery vs. prior WebSocket bridging):** The wallet service delivers message blobs to the relay via `POST /deliver/{uuid}` (HTTPS). With HTTP/2 or keep-alive connection pooling between wallet service and relay, the per-delivery overhead is the TCP round-trip plus relay processing — typically 5–20 ms on the same cloud provider or data center. This is undetectable for human chat (conversations typically have 200–2000 ms natural pacing). The wallet service should maintain a persistent HTTP connection pool to the relay to avoid per-message TCP handshake overhead. **This figure was measured against the original same-process Node.js/self-hosted-Redis architecture and has not been re-validated against the Cloudflare Workers + Redis Cloud topology** — Redis Cloud is not colocated with Cloudflare's edge the way the original self-hosted Redis was colocated with the relay process, so actual latency under the new architecture should be measured once both are provisioned (see `relay-next/PROVISIONING.md` §5) rather than assumed to still hold.

---

## 9. Re-registration on Store Reset

**Changed from v0.7:** the device registry is no longer a second Redis
Cloud database — it is Cloudflare KV, accessed via Nitro's `storage()`
abstraction (`relay_data_model.md` §5, §1). "Redis restarts" still means
only the **primary** Redis Cloud database (persistence off) resetting; KV
is durable by platform default and is not expected to reset under normal
operation, which is the whole reason the device registry lives there
rather than in the primary database. When the primary database resets,
all UUID state and message blobs are lost, exactly as in v0.7.

**Detection mechanism unchanged from v0.7:** performed by a periodic
Cloudflare Cron Trigger that scans for `uuid:*` keys in the primary
database (`relay_data_model.md` §2.5–§2.6), on the schedule
`RECONCILIATION_CRON_SCHEDULE` (default every 5 minutes). This check must
distinguish "database was actually reset" from "database happens to be
momentarily empty because there are no outstanding UUIDs right now" — see
`relay_data_model.md` §2.6 for the false-positive-avoidance mechanism this
requires (a transition-detecting flag, now stored as a KV entry rather
than in a second Redis database — same logic, different store).

If the primary database is confirmed reset (per that mechanism), the
relay lists the current contents of the KV device registry (all entries
present are, by construction, within the retention window — see
`relay_data_model.md` §5's note on TTL-based expiry replacing the old
prune-by-timestamp query) and sends a re-registration push to each:

```json
{ "type": "relay_reregistration_requested", "relay_id": "<RELAY_ID>" }
```

The device handles this silent push by calling `POST /register` (replenishment if it has a stored credential, bootstrap if the credential was also lost) for each of its cards and re-registering new UUIDs with wallet services. The wallet service, on receiving new UUIDs, retransmits any messages it retained. The device deduplicates by message ID within the decrypted blob.

**Live WebSocket/SSE connections during a primary-database reset:**
Durable Object instances holding open connections are unaffected by a
Redis Cloud primary-database reset — the two systems are operationally
independent (`relay_data_model.md` §10.1). A device with an open `GET
/ws/{uuid}` or `GET /sse` connection at the moment of a primary-database
reset keeps that connection open, but any *new* delivery attempt for its
UUIDs will fail Redis-side validation (the UUID record is gone) until the
device re-registers and the wallet service re-delivers with fresh UUIDs.
This is the same "window during which push delivery may fail" v0.6
already describes for the non-connected case; connected devices are not
better protected against it, since the UUID→Durable-Object mapping itself
depends on Redis still knowing about that UUID (`relay_data_model.md`
§10.3, step 1 of connection establishment).

---

## 10. Error Codes

```json
{ "error": "<CODE>", "message": "<human-readable detail>" }
```

| Code | HTTP status | Meaning |
|---|---|---|
| `MISSING_FIELD` | 400 | Required request field absent or empty |
| `INVALID_COUNT` | 400 | `count` outside 1–100 |
| `INVALID_UUID` | 400 | Path parameter not a valid UUID v4 |
| `UNKNOWN_APP` | 404 | `app_id` not in app registry |
| `UNKNOWN_UUID` | 404 | UUID not found in Redis |
| `UUID_CONSUMED` | 410 | UUID already used, active, or in-flight |
| `ENDPOINT_DEPRECATED` | 410 | `POST /notify/{uuid}` called; use `POST /deliver/{uuid}` |
| `MISSING_CREDENTIAL` | 401 | `Authorization` header absent on authenticated endpoint |
| `INVALID_CREDENTIAL` | 401 | Device credential unknown or expired |
| `PUSH_FAILED` | 502 | APNs or FCM returned a delivery error (blob is retained in message store) |
| `WALLET_REJECTED` | — | *(Removed in v0.5 — relay no longer opens outbound WebSocket to wallet)* |
| `INTERNAL_ERROR` | 500 | Unexpected error (Redis failure, config inconsistency) |

---

## 11. Open Questions

All prior open questions resolved. New items raised by v0.4:

| ID | Question |
|---|---|
| OQ-RLY-5 | Should `POST /ack` be implicit in `GET /pending` (relay schedules deletes immediately on pickup) or explicit (device must call `/ack` separately)? Explicit ack is safer (device confirms it has processed the messages before clearing) but adds a round trip. Implicit is simpler. Currently specced as explicit. |
| OQ-RLY-6 | Device credential revocation for lost/stolen devices: no mechanism currently. Options include a relay-side credential invalidation endpoint (requires device to authenticate somehow) or expiry-only (30-day TTL). Deferred. |
| OQ-RLY-7 | Rate limiting on `POST /register` bootstrap path (unauthenticated). Without rate limiting, an attacker can create unbounded device credentials and UUID records, filling Redis. Deferred to pre-production hardening. |
