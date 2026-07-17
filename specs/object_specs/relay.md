# Notification Relay — Service Spec

**Version:** 0.9
**Date:** 2026-07-11
**Status:** Draft — describes the Docker/self-hosted architecture implemented in `relay/` (a plain Node.js/Express-style HTTP+WebSocket process, self-hosted Redis, SQLite device registry). `relay/`'s code has been brought to full compliance with this revision (see `plans/relay-old-restoration-plan.md`).
**Amends: v0.8 — reverts the serverless (Cloudflare Workers + Durable Objects + Redis Cloud + Cloudflare KV) architecture back to the Docker/self-hosted design, per `plans/relay-old-restoration-plan.md` (the authorizing decision for this reversion).** The serverless design still needed a Redis instance, and running that Redis instance in Docker alongside the app turned out simpler than splitting state across a third-party Redis Cloud service and Cloudflare KV — so the project reverted to `relay/`, the pre-migration Docker implementation.
**This is not a blind rollback to v0.4/v0.5.** Several corrections made during the v0.5–v0.8 serverless-migration period are **preserved**, because they are substantive behavior specs, not serverless artifacts:
- **The inbound-only `GET /ws/{uuid}` delivery model** (§7.3): the relay never opens a connection to the wallet service; the wallet is reached only via `wallet_base_url` for staggered deletes. This was introduced during the v0.5 migration but is not itself serverless-specific — it reflects the actual, currently-correct wire contract with the wallet service (`wallet-service/src/relay-client.ts` only ever calls `POST /deliver/{uuid}` over HTTPS; it has no WebSocket client). **One part of the v0.8 text describing this model was itself a Durable-Object-specific artifact and has been corrected back**: v0.8 said the connection is addressed by "the UUID itself" (tied to Cloudflare's `idFromName(uuid)` addressing). The actual, currently-implemented, and correct behavior — confirmed against `relay/src/routes/ws.ts` and `relay/src/routes/deliver.ts` — is that the connection is addressed by **`device_credential`**, exactly like `GET /sse`. This matches `specs/process_specs/notification_relay.md`'s unchanged "Process 3" description. See §7.3 for the corrected text.
- **`wallet_base_url`** (§5, §6.1): an `https://` base URL used only for staggered `DELETE {wallet_base_url}/messages/{uuid}` calls. Confirmed correct and consistent throughout this revision — no `wallet_ws_url`/`ws://`/`wss://` language remains.
- **The UUID state machine** (`unused` / `in_flight` / `active` / `consumed`) and the staggered delete queue — not serverless-specific, unchanged.
- **Device credential auth model** — not serverless-specific, unchanged.

What is dropped, because it was purely serverless-infrastructure-specific: the Durable-Object-backed connection model for §7.3/§7.4 (revert to in-process `Map`-based tracking, since there is only one relay process and no "authority split" to describe); Cloudflare KV as the device registry (revert to SQLite, §9); Cloudflare Cron Triggers (revert to a one-time startup scan, per `relay_data_model.md` §2.5–§2.6); the "no single startup moment under Workers" framing in §5 (a Docker process has an ordinary, single startup moment).

**Amends (v0.6 → v0.8, historical, superseded by this revision):** §7.3/§7.4 described a Cloudflare Durable-Object-backed connection model; §5 described the app registry as having no single startup moment under Workers. See `plans/relay-serverless-migration-strategic-plan.md` and its companion implementation plan for that migration's rationale — both are superseded by this v0.9 reversion.

**Changelog (spec-consistency Phase 2):** Fix #6 — added the `POST /ohttp/{target_id}` oblivious-forwarding endpoint (§7.9) and its `relay/src/...` file citations, which this spec had never documented despite `oblivious_transport.md` assuming it exists; added a `specs/process_specs/oblivious_transport.md` row to the §2 Relationship table. Fix #57 — removed the "UUID pool replenishment lifecycle" overclaim from `wallet_backup_and_recovery.md`'s §2 row; that document does not cover UUID pools. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, Tier 1 items 11, 13):** §7.9/§10 error-code strings corrected to match the deployed code (`UNKNOWN_TARGET`→`NOT_FOUND`, `BAD_GATEWAY`→`GATEWAY_UNREACHABLE`; status codes were already correct, only the label strings differed), and §10's master error table gained rows for both; file-path citation typo fixed (`oblivious-targets.ts`→`oblivious_targets.ts`, underscore matching the codebase's actual naming). See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

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
   - 7.9 [POST /ohttp/{target_id}](#79-post-ohttptarget_id)
8. [UUID Lifecycle](#8-uuid-lifecycle)
9. [Re-registration on Store Reset](#9-re-registration-on-store-reset)
10. [Error Codes](#10-error-codes)
11. [Open Questions](#11-open-questions)

---

## 1. Overview

The notification relay is an HTTP and WebSocket service that bridges wallet services to holder devices without allowing either party to identify the other. It operates as a **message buffer**: the wallet service deposits encrypted blobs at the relay, and the relay delivers them to the device via the highest-priority available channel.

Delivery priority (highest to lowest):

1. **SSE** — device-level event stream, used when the app is in the foreground but not in active chat
2. **WebSocket** — per-card bidirectional bridge, used when the app is in an active chat session
3. **Silent push** — APNs/FCM wakeup, used when the app is backgrounded
4. **`GET /pending`** — device pull on wake, after receiving a push or returning from offline

The relay stores a mapping from opaque single-use UUIDs to device credentials and push tokens. It also holds encrypted message blobs in RAM until the device picks them up. It does not store card identities, message content in readable form, or any data that would allow it to correlate a UUID to a card.

UUID associations and message blobs are held exclusively in RAM (Redis with no persistence). The relay never writes UUID-to-device mappings or message blobs to disk. See §4 for the full privacy model and §9 for the store-reset recovery flow.

The relay runs as a single long-running Node.js process (deployed via Docker Compose — see `relay_data_model.md` §1.1 for the topology), with a self-hosted Redis container as its primary store and a SQLite file on a Docker volume as its device registry.

---

## 2. Relationship to Existing Specs

| Spec | Relationship |
|---|---|
| `specs/process_specs/notification_relay.md` | Process-level spec this document implements. Defines delivery processes, UUID pools, device credentials, multi-device, and privacy properties. |
| `specs/process_specs/message_routing.md` | Defines how wallet services route messages to recipient cards and deliver blobs to the relay. |
| `specs/process_specs/wallet_backup_and_recovery.md` | Device registration and key management. |
| `specs/object_specs/relay_data_model.md` | Redis key schema, message store, delete queue, device credential store, UUID state machine, SQLite-backed device registry, and app registry config. |
| `specs/process_specs/oblivious_transport.md` | Defines the oblivious-forwarding mechanism (`POST /ohttp/{target_id}`, §7.9) that lets devices reach a wallet service or press without exposing their IP to the destination. |

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

UUID associations must never be written to disk. Redis runs with persistence explicitly disabled (`--save "" --appendonly no --maxmemory-policy noeviction`).

The device registry (SQLite, on a Docker volume) stores only push tokens and `app_id` — no UUID associations, no device credentials, no card-linkable data.

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

Loaded once, synchronously, from a JSON file at process startup (`APP_REGISTRY_PATH`), before the relay begins accepting requests. Changes require a process restart — there is no hot-reload. Full authoritative detail (schema, validation rules) lives in `relay_data_model.md` §6.

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
5. Upsert push token in the SQLite device registry.
6. Return UUIDs and device credential.

**Replenishment (`Authorization: Bearer {credential}` present):**

1. Validate credential against `cred:{credential}`. Return 401 if unknown or expired.
2. Validate `app_id` and `push_token`.
3. Update `cred:{credential}` with new `push_token` (if rotated) and refresh TTL.
4. Generate `count` new UUIDs under the same credential.
5. Upsert push token in the SQLite device registry.
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
   - Else if WebSocket connection open for this `device_credential`: forward the blob directly over that socket. Do not remove from message store yet — wait for `POST /ack`.
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

**Inbound only.** Outbound messages (device → wallet) are sent by the device directly to the wallet service HTTPS endpoint (`wallet_base_url`). The relay does not proxy outbound messages and does not open any connection to the wallet service on behalf of this endpoint or any other.

**Connection model:** the connection is tracked in an in-process `Map<device_credential, WebSocket>` (`relay/src/utils/ws_connections.ts`), populated when the connection is accepted and removed on teardown. Because the relay runs as a single long-running process, this in-memory map is simply, unambiguously authoritative for "is there a live WebSocket connection for this device right now" — there is no second system whose view of connection liveness could disagree with it.

**Addressing key: `device_credential`, not the UUID.** The UUID in the path (`GET /ws/{uuid}`) is consumed by the act of opening the connection — it transitions to `active` and can never again be a valid `POST /deliver/{uuid}` target. When a *different* UUID from the same device's pool is later delivered via `POST /deliver/{uuid'}`, the relay must find this open connection by asking "does this device (identified by its `device_credential`) currently have a live WebSocket," not "does UUID `{uuid'}` have one" — no connection was ever opened for `uuid'` itself. The connection is therefore registered and looked up by `device_credential`, exactly the same way `GET /sse` (§7.4) is. This matches `specs/process_specs/notification_relay.md`'s "Process 3" description (the relay detects the active WebSocket connection for a device credential) and the actual implementation (`relay/src/routes/ws.ts`'s `registerWsConnection(record.device_credential, deviceSocket)`; `relay/src/routes/deliver.ts`'s `getWsConnection(record.device_credential)`).

#### Upgrade request

```
GET /ws/{uuid}
Connection: Upgrade
Upgrade: websocket
```

#### Connection establishment

1. Validate UUID format. Close 4000 if invalid.
2. Look up UUID in Redis. Close 4004 if not found.
3. Confirm `status == "unused"`. Close 4010 if not.
4. Transition `unused → active` in Redis.
5. Register the connection in the in-process `Map`, keyed by the UUID record's `device_credential`.
6. Confirm connection to device (no outbound wallet connection is opened).

#### Message flow

**Inbound (wallet → device):** When `POST /deliver/{uuid'}` arrives for a *different* UUID that shares this connection's `device_credential`, and this WebSocket is currently open, the relay delivers the blob over the open WebSocket:

```
{"uuid": "<uuid'>", "blob": "<base64url>"}
```

(Contrast with `GET /sse`, §7.4, which is also keyed by `device_credential` — both are device-level channels, not per-UUID channels; the UUID in the `GET /ws/{uuid}` path only ever identifies *this* connection's own opening request, never a future delivery target.)

**Outbound (device → wallet):** The device sends outbound messages directly to the wallet service HTTPS endpoint. Any frames sent by the device over this WebSocket connection are ignored by the relay (the connection is delivery-only). The device is responsible for tracking the `wallet_base_url` for its wallet service.

#### Session teardown

On device-side close or network error, the WebSocket's `close`/`error` handler fires synchronously and performs the Redis `active → consumed` transition directly, then removes the connection from the in-process `Map` (`relay/src/routes/ws.ts`). Because this all happens in the same process holding both the Redis client and the connection map, there is no bounded-staleness window in the ordinary case — teardown is synchronous with the connection actually closing.

The only case where a UUID can be left stuck at `active` is the relay process itself dying before this handler runs (crash, forced kill, host failure). That case is caught on the next process startup by the reconciliation scan (`relay_data_model.md` §2.5), which transitions any UUID still `active` or `in_flight` to `consumed` before the relay begins accepting new requests.

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

**Connection model:** tracked in an in-process `Map<device_credential, ServerResponse>` (`relay/src/utils/sse_connections.ts`), populated when the connection is established and removed on close. As with `GET /ws/{uuid}` (§7.3), because there is only one relay process, this map is simply authoritative for connection liveness — no second system to reconcile against.

#### Request

```
GET /sse
Authorization: Bearer {device_credential}
Accept: text/event-stream
```

#### Processing

1. Validate credential. Return 401 if missing or invalid.
2. Resolve `device_credential → push_token`.
3. Register the connection in the in-process `Map`, keyed by `device_credential`.
4. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
5. Send heartbeat comment every 30 seconds: `:\n\n`.
6. On `POST /deliver/{uuid}` arriving for a UUID whose `device_credential` matches this connection's, while the SSE connection is open: stream the event immediately (§7.2 step 7).
7. On connection close (app backgrounds, network drop): remove the connection from the `Map`. There is no UUID state transition to perform here — the SSE channel is not itself tied to any single UUID's lifecycle, so there is nothing in Redis for this teardown to update.

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

### 7.9 POST /ohttp/{target_id}

Stateless oblivious-forwarding endpoint. Accepts an opaque HPKE-encapsulated blob from a device and forwards it, unread, to the wallet service or press gateway identified by `target_id`. This is the mechanism `specs/process_specs/oblivious_transport.md` specifies for hiding a device's IP address from wallet services and presses; see that document for the full envelope format, key-configuration discovery, and scope of which calls are routed this way.

**Called by the device.** No `Authorization` header — the relay does not authenticate this call itself; whatever auth the destination's decapsulated handler requires (session token, master-card signature, sub-card signature) travels inside the HPKE ciphertext and is checked by the destination gateway, not the relay.

#### Request

```
POST /ohttp/{target_id}
Content-Type: application/x-card-protocol-ohttp+hpke
Body: <opaque HPKE-encapsulated bytes>
```

`target_id` is an opaque string resolved via the oblivious target registry (`relay/src/utils/oblivious_targets.ts`, loaded from a JSON config file the same way the app registry is — see `relay_data_model.md §6.4`). It is structurally independent of the push-notification `app_id`/`AppConfig`, though it may reuse the same string value for a wallet service that also does push delivery.

#### Processing

1. Resolve `target_id` in the oblivious target registry. Return 404 `NOT_FOUND` if not found — do not forward. (Corrected 2026-07-16, Phase 3 Tier 1 item 11: the deployed code, `relay/src/routes/ohttp.ts`, returns `NOT_FOUND`, not `UNKNOWN_TARGET`.)
2. Forward the request body as-is (no parsing, no interpretation, no decryption) to the resolved `ohttp_gateway_url` via a plain outbound HTTPS POST, preserving `Content-Type`.
3. Return the destination's response body back to the device unmodified.

The relay never sees `path`, `method`, or `body` — those exist only inside the HPKE ciphertext it forwards. It sees only `target_id` and the size of the encrypted blob.

#### Response

Whatever status code and body the destination gateway returns, passed through unmodified. If the destination is unreachable, the relay returns 502.

#### Error responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | `target_id` not found in the oblivious target registry |
| 502 | `GATEWAY_UNREACHABLE` | Destination gateway unreachable or returned a transport-level error on the relay's outbound leg |

#### Implementation

`relay/src/routes/ohttp.ts` (route handler); `relay/src/utils/oblivious_targets.ts` (target registry loader/resolver) — matching this spec's `relay/src/...` file-layout convention (see the v0.9 changelog at the top of this document; the earlier Nitro-style `relay/server/...` convention was explicitly abandoned).

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

**Note on "session close":** the diagram's `active → consumed` transition on session close is synchronous with the WebSocket actually closing in the ordinary case — the same process holds both the Redis client and the connection registry, so there is nothing for the two to disagree about. The only exception is the relay process itself dying before the close handler runs, which the startup reconciliation scan (`relay_data_model.md` §2.5) resolves on the next boot. That fallback is not shown in the diagram to keep it legible; see §7.3's teardown description for the full accounting.

**Latency note (HTTPS delivery to the relay):** The wallet service delivers message blobs to the relay via `POST /deliver/{uuid}` (HTTPS). With a persistent connection pool between wallet service and relay, the per-delivery overhead is the TCP round-trip plus relay processing — typically 5–20 ms when both are colocated (e.g. on the same cloud provider or data center). This is undetectable for human chat (conversations typically have 200–2000 ms natural pacing). The wallet service should maintain a persistent HTTP connection pool to the relay to avoid per-message TCP handshake overhead.

---

## 9. Re-registration on Store Reset

The device registry is a SQLite file on a Docker volume (`relay_data_model.md` §5), separate from Redis so that it survives exactly the kind of restart that clears Redis. "Redis restarts" means the self-hosted Redis container losing its data (persistence is deliberately off — §4). The SQLite device registry is not expected to reset under normal operation, which is the whole reason it lives on its own durable volume rather than in Redis.

**Detection mechanism:** performed once, at process startup, before the relay begins accepting requests (`relay_data_model.md` §2.6). The relay checks whether the Redis UUID store is empty; if so, it checks whether the SQLite device registry has any entries. An empty Redis store with a non-empty device registry means Redis was reset while devices were already known — the relay lists the current SQLite device-registry entries (all within the 90-day retention window, `relay_data_model.md` §5.4) and sends a re-registration push to each:

```json
{ "type": "relay_reregistration_requested", "relay_id": "<RELAY_ID>" }
```

An empty Redis store with an *also*-empty device registry is treated as a first deployment, not a reset — no re-registration push is sent in that case.

The device handles this silent push by calling `POST /register` (replenishment if it has a stored credential, bootstrap if the credential was also lost) for each of its cards and re-registering new UUIDs with wallet services. The wallet service, on receiving new UUIDs, retransmits any messages it retained. The device deduplicates by message ID within the decrypted blob.

**Live WebSocket/SSE connections during a Redis reset:** because Redis and the in-process connection registries are held by the same relay process, a Redis reset (the *data* being cleared, e.g. by recreating the Redis container without its volume) does not by itself sever any open WebSocket or SSE connection — the process and its in-memory connection maps are unaffected by Redis's own state being wiped. A device with an open `GET /ws/{uuid}` or `GET /sse` connection at the moment of a Redis reset keeps that connection open, but any *new* delivery attempt for its UUIDs will fail Redis-side validation (the UUID record is gone) until the device re-registers and the wallet service re-delivers with fresh UUIDs. This is the same "window during which push delivery may fail" the relay has always had for the non-connected case; connected devices are not better protected against it, since delivering to an existing connection still requires resolving `uuid → device_credential` from a Redis record that a reset has just erased.

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
| `NOT_FOUND` | 404 | (§7.9) `target_id` not found in the oblivious target registry. Added 2026-07-16, Phase 3 Tier 1 item 11 — this table had never been updated with the OHTTP endpoint's codes. |
| `GATEWAY_UNREACHABLE` | 502 | (§7.9) Destination gateway unreachable or returned a transport-level error on the relay's outbound leg. Added 2026-07-16, Phase 3 Tier 1 item 11. |

---

## 11. Open Questions

All prior open questions resolved. New items raised by v0.4:

| ID | Question |
|---|---|
| OQ-RLY-5 | Should `POST /ack` be implicit in `GET /pending` (relay schedules deletes immediately on pickup) or explicit (device must call `/ack` separately)? Explicit ack is safer (device confirms it has processed the messages before clearing) but adds a round trip. Implicit is simpler. Currently specced as explicit. |
| OQ-RLY-6 | Device credential revocation for lost/stolen devices: no mechanism currently. Options include a relay-side credential invalidation endpoint (requires device to authenticate somehow) or expiry-only (30-day TTL). Deferred. |
| OQ-RLY-7 | Rate limiting on `POST /register` bootstrap path (unauthenticated). Without rate limiting, an attacker can create unbounded device credentials and UUID records, filling Redis. Deferred to pre-production hardening. |
