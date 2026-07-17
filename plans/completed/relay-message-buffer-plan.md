# Relay Message Buffer — Change Plan

**Date:** 2026-06-29
**Status:** Draft

Captures all spec and code changes required to implement the relay-as-message-buffer architecture, multi-device support, and device-level SSE. Changes are ordered: specs first, then code.

---

## Background

The current relay is a pure delivery trigger: the wallet calls `POST /notify/{uuid}`, the relay sends a silent push, the device wakes and fetches from the wallet. This plan changes the relay into a message buffer:

- The wallet sends the encrypted message blob to the relay instead of just a trigger.
- The relay delivers via SSE (foreground) or WebSocket (active chat), and falls back to silent push when the device is backgrounded.
- The relay stores undelivered blobs in Redis; the device retrieves them via `GET /pending` on wake.
- After confirmed device pickup, the relay sends a staggered delete to the wallet service (0–6 hours, randomized) so the wallet can clear its copy.
- Multi-device support: each device registers its own UUID pool under a per-device-per-card key (`hash(device_id + card_hash)`); the wallet fans out one delivery per device on each message.

---

## Spec Changes

### 1. `specs/process_specs/notification_relay.md`

**Process 2: Push Notification Delivery** — rewrite substantially.
- Wallet now calls `POST /deliver/{uuid}` with an encrypted blob body, not the bodyless `POST /notify/{uuid}`.
- Relay stores the blob in Redis (`messages:{push_token}` list) and transitions UUID to `consumed` on receipt.
- Relay checks for an open SSE or WebSocket connection for the device:
  - SSE open → stream `{ uuid, blob }` immediately; schedule staggered delete to wallet.
  - WebSocket open → forward via WebSocket; schedule staggered delete.
  - Neither → dispatch silent push containing only the UUID (unchanged from current); blob remains in store.
- Remove the sentence "No card identity, message content, or sender information is included" from the wallet→relay call description — the wallet now sends the blob.

**New Process: Device-Level SSE**
- Device opens `GET /sse` when app enters foreground (not in active chat).
- Relay authenticates via device credential (issued at registration; see registration changes below).
- Relay streams any events for that device as they arrive.
- SSE connection is closed when app backgrounds; relay does not attempt to maintain it.
- One SSE connection per device, not per card.

**Updated Process: GET /pending (catch-up on wake)**
- Device calls `GET /pending` (authenticated by device credential) when coming online or after receiving a silent push.
- Relay returns all blobs currently stored for that device.
- On device acknowledgment, relay schedules staggered delete to wallet for each message (0–6 hour random delay per message).
- Relay removes blobs from the pending store after scheduling deletes.

**New Process: Staggered Wallet Clearance**
- After confirmed device pickup, relay queues a `DELETE /messages/{uuid}` call to the wallet service for each delivered message.
- Delay is uniformly random in [0, 6 hours], chosen independently per message.
- Pending delete jobs are held in Redis. Jobs lost to a relay restart are benign: the wallet retains the message and retransmits to the new UUID on re-registration.
- Device may receive a duplicate message after a relay restart; deduplication is required on the device (by message ID within the encrypted blob).

**UUID Pools section** — add device credential:
- In addition to UUID pools, registration now returns a **device credential** (an opaque token) the device uses to authenticate `GET /sse` and `GET /pending`. The credential is distinct from the push token and from UUID values.

**Multi-Device section** — new:
- Each device derives a per-device-per-card key: `device_key = hash(device_id || card_hash)` where `device_id` is a random identifier generated at first install and stored in device secure storage.
- When registering UUIDs with the wallet service, the device sends `device_key` as the bucket identifier alongside its UUID pool.
- The wallet stores `card_hash → { device_key_1: [uuids...], device_key_2: [uuids...] }`.
- On message arrival, the wallet calls `POST /deliver/{uuid}` once per device_key, drawing one UUID from each bucket.
- Known limitation: the relay can correlate concurrent deliveries to the same physical device through timing. This is a documented, accepted exposure; device_key is opaque to the relay and no mitigation delay is applied.

**Registration Privacy section** — add:
- Device credential registration must be in a separate, unlinkable session from UUID registration (same constraints as UUID registration with the wallet service).

**Trust Model section** — update:
- Relay now holds encrypted message blobs at rest. It still cannot read content (E2E encrypted). Compromise of the relay additionally exposes stored ciphertext and message volume per device.
- Relay now makes outbound calls to wallet service endpoints (staggered deletes). This is not new capability — it already connects outbound for WebSocket bridging — but should be noted.

**Failure Handling table** — update:
- Add row: "Relay restart while blobs in store → blobs lost; wallet retains messages; device re-registers UUIDs; wallet retransmits; device deduplicates."
- Add row: "Staggered delete job lost to relay restart → wallet retains message; retransmitted on UUID re-registration; device deduplicates."
- Update "UUID pool exhausted at wallet service" row — wallet now retains messages until relay delete call; behavior unchanged but mechanism differs.

---

### 2. `specs/object_specs/relay_data_model.md`

**Section 2 (Redis — UUID Store)** — update UUID record fields:
- Add `device_credential` as a field on the UUID record (the same credential issued to all UUIDs registered in a single registration session, allowing `GET /pending` and `GET /sse` to retrieve all pending messages for the device).

**New Section: Redis — Message Store**
- Key schema: `messages:{push_token}` — Redis list (RPUSH / LRANGE / DEL).
- Each list entry is a JSON object: `{ blob: string, wallet_url: string, delivery_uuid: string, received_at: string }`.
- TTL: 30 days (matching UUID TTL). Set on first push; reset on each subsequent push to the list.
- On relay restart, blobs in this store are orphaned (device_credential → push_token mapping is gone with UUID state). Wallet retransmits; duplicates handled device-side.

**New Section: Redis — Pending Delete Queue**
- Key schema: `pending_deletes` — Redis sorted set. Score = Unix timestamp of scheduled execution. Member = JSON: `{ wallet_url, uuid }`.
- A background job polls this set every 60 seconds, executes all members with score ≤ now, calls `DELETE /messages/{uuid}` on the wallet service, removes from set on success, requeues with exponential backoff on failure.
- Lost on restart; non-fatal (see failure handling above).

**Section 5 (UUID State Machine)** — no new states required:
- UUID transitions to `consumed` when the relay accepts and stores the message (not when the device picks it up).
- Message lifecycle is tracked separately in the message store, not via UUID status.
- Add note clarifying this separation.

**Section 6 (Environment Variables)** — add:
- `MAX_DELETE_DELAY_SECONDS` — upper bound of staggered delete delay (default: 21600 = 6 hours).
- `DELETE_JOB_POLL_INTERVAL_MS` — how often the delete background job runs (default: 60000).

---

### 3. `specs/object_specs/relay.md`

- Add endpoint: `POST /deliver/{uuid}` — replaces `POST /notify/{uuid}` as the wallet-facing delivery endpoint. Accepts encrypted blob. Returns 200 on storage + dispatch attempt.
- Add endpoint: `GET /sse` — device-level SSE stream, authenticated by device credential.
- Add endpoint: `GET /pending` — returns stored blobs for the authenticated device. Accepts device credential.
- Add endpoint: `POST /ack` — device signals successful receipt of pending messages; relay schedules staggered deletes and clears blobs. (Alternatively, ack can be implicit in the `GET /pending` response — to be decided during implementation.)
- Deprecate `POST /notify/{uuid}` — keep documented for one version with a note that it is superseded.
- Update error code table for new endpoints.

---

### 4. `specs/process_specs/message_routing.md`

- Update the wallet-to-relay delivery step: wallet now calls `POST /deliver/{uuid}` with blob, not `POST /notify/{uuid}` with empty body.
- Add the multi-device fan-out step: on message arrival, wallet iterates all device_key buckets for the card and fires one delivery per bucket.
- Add the wallet message retention rule: wallet retains messages until it receives `DELETE /messages/{uuid}` from the relay. This is the wallet's source of truth for undelivered messages.
- Add UUID re-registration trigger: when the wallet receives new UUIDs for a card (re-registration after relay restart), it checks for pending messages and retransmits to the new UUID.

---

## Code Changes

### Modified files

**`src/routes/notify.ts` → rename to `src/routes/deliver.ts`**
- Change route from `POST /notify/{uuid}` to `POST /deliver/{uuid}`.
- Parse encrypted blob from request body.
- After UUID lookup and `unused → consumed` transition (no `in_flight` step needed — blob storage is synchronous), store blob in message list via new `storeMessage()` Redis function.
- Check for open SSE connection for the device's push_token; if found, stream immediately and schedule delete.
- Check for open WebSocket session; if found, forward and schedule delete.
- If neither, dispatch silent push (reuse existing `dispatchPush` — payload unchanged: just the UUID).
- On push failure, do not roll back the UUID (it is already consumed); blob remains stored for `GET /pending` pickup.

**`src/utils/storage/redis.ts`**
- Add `storeMessage(pushToken, entry)` — RPUSH to `messages:{push_token}`, set TTL.
- Add `getMessages(pushToken)` — LRANGE then DEL (atomic via Lua or pipeline).
- Add `enqueuePendingDelete(walletUrl, uuid, executeAt)` — ZADD to `pending_deletes`.
- Add `dequeuePendingDeletes(now)` — ZRANGEBYSCORE then ZREM for executed members.

**`src/router.ts`**
- Register `POST /deliver/:uuid` → `handleDeliver`.
- Register `GET /sse` → `handleSSE`.
- Register `GET /pending` → `handlePending`.
- Keep `POST /notify/:uuid` wired to a deprecation handler that returns 410 with a message.

### New files

**`src/routes/deliver.ts`**
- Implements `POST /deliver/{uuid}` as described above.

**`src/routes/sse.ts`**
- Implements device-level SSE stream (`GET /sse`).
- Authenticates via device credential (looked up from UUID record — any UUID registered in the same session carries the same device credential, so any valid credential is sufficient to identify the push_token).
- Registers the open connection in an in-memory map: `push_token → SSE response object`.
- On connection close, removes from map.
- Sends a heartbeat comment (`:\n\n`) every 30 seconds to keep the connection alive through proxies.

**`src/routes/pending.ts`**
- Implements `GET /pending`.
- Authenticates device credential, resolves push_token.
- Calls `getMessages(pushToken)` (which atomically reads and clears the list).
- For each message, calls `enqueuePendingDelete(...)` with a random delay in [0, MAX_DELETE_DELAY_SECONDS].
- Returns `{ messages: [{ uuid, blob }, ...] }`.

**`src/utils/wallet_clearance.ts`**
- Background job that runs on `DELETE_JOB_POLL_INTERVAL_MS` interval.
- Calls `dequeuePendingDeletes(now)`, fires `DELETE /messages/{uuid}` to each wallet_url.
- On 404 or 410 from wallet (message already cleared): discard silently.
- On 5xx or network error: requeue with exponential backoff (cap at 24 hours).
- On relay shutdown (`SIGTERM`), flushes the pending delete queue synchronously before exit (best-effort, 5 second timeout).

**`src/utils/sse_connections.ts`** (or inline in `sse.ts`)
- In-memory map: `push_token → SSEConnection`.
- `registerSSE(pushToken, res)`, `getSSE(pushToken)`, `removeSSE(pushToken)`.
- Not persisted; lost on restart (fine — SSE connections don't survive restarts anyway).
