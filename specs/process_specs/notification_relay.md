# Notification Relay — Process Spec

**Version:** 0.8 (draft)
**Date:** 2026-07-02
**Status:** Draft
**Changes from v0.7:** Process 1 (UUID Registration) step 6 previously registered a subcard's UUID pool with the wallet service via an unauthenticated `{ uuids: [...] }` body — anything that knew a `card_hash`/`subcard_hash` pair could apparently register UUIDs against it without proving control of the corresponding private key. The wallet registration call now requires a signed envelope proving subcard ownership (§Process 1, "Wallet registration"). Registration Privacy is also clarified to name Tor (or another anonymizing transport) as the expected mechanism for wallet registration sessions, rather than an opt-in upgrade for "users with strong privacy requirements" only — and explicitly restates, since it came up during spec review, that this remains a **per-card** session even when a device holds multiple cards: batching multiple cards' registrations into a single session or message was considered and rejected, because it would let a wallet service that happens to service more than one of a device's cards directly infer their co-ownership from the message content — a correlation that anonymizing transport does not prevent, since it hides the sender's network identity, not the payload's contents.
**Changes from v0.6:** Removed UMBRAL proxy re-encryption from the wallet's message delivery path (see `process_specs/message_routing.md` v0.4). The sender now encrypts independently per subcard before the routing envelope reaches the wallet service; the wallet delivers each already-encrypted envelope to its target subcard's UUID pool without any transform step.
**Changes from v0.5:** UUID pool model changed from device_key hash to per-subcard array. Multi-device support is now handled through subcards: each app instance on each device registers a distinct subcard, and the wallet delivers a separately-addressed blob per subcard. The `device_key` concept is removed from wallet-side UUID registration. UUIDs are a single untyped array per subcard (no delivery/websocket split at the wallet layer — the device allocates its UUID pool between delivery and WebSocket use internally). Wallet registration endpoint changes from `POST /cards/{card_hash}/devices/{device_key}/uuids` to `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`.

---

## Overview

Card holders need to receive timely notifications when messages arrive for their cards. This creates a privacy challenge: a wallet service must be able to reach a specific device without knowing which cards that device holds.

This spec defines a relay-based notification architecture with three delivery modes:

- **SSE** — low-latency server-sent event stream when the app is in the foreground but not in an active chat
- **WebSocket** — bidirectional message delivery when the app is in an active chat session
- **Push notifications** — silent wakeup delivered via APNs (iOS) or FCM (Android) when the app is backgrounded

In all modes, the relay service sits between the wallet service and the device. The wallet service knows which relay endpoint to call for a given card, but not which device or user it maps to. The relay service receives and stores encrypted message blobs, but does not know which card they belong to.

---

## Actors

| Actor | Role |
|---|---|
| **Holder** | Card owner whose device receives notifications |
| **Device** | iOS or Android client holding the holder's cards |
| **Wallet service** | Routes encrypted message blobs to the relay; retains messages until relay confirms delivery |
| **Relay service** | Bridges wallet service to device; stores encrypted blobs in Redis until device pickup; sends staggered delete to wallet after delivery |
| **APNs / FCM** | Platform push infrastructure; delivers silent push to the device when backgrounded |

---

## Privacy Properties

The relay architecture separates knowledge across two parties who do not share state:

| Party | Knows | Does not know |
|---|---|---|
| Wallet service | Card hash → subcard_hash → UUID(s) | Device identity, push token, which subcards or UUIDs belong to the same physical device |
| Relay service | UUID → push token; push token → pending message blobs | Card hash, card identity, subcard identity, message content (blobs are E2E encrypted) |

Neither party alone can link a card to a device. Correlation requires collusion between both.

Within the wallet service, UUIDs registered for different cards are unlinkable provided registration sessions are kept separate (see Registration Privacy below).

**Multi-subcard correlation:** When a card has multiple subcards registered, the wallet service delivers to all subcards in a loop. The relay receives these deliveries in rapid succession and can infer that the underlying push tokens co-own related subscriptions via timing. This is a documented, accepted exposure — the relay does not learn card identities or message content, and no artificial delay is introduced. See Multi-Device section below.

---

## UUID Pools and Device Credential

The device maintains a single pool of single-use UUIDs per subcard. UUIDs are untyped — a UUID from the pool may be used for message delivery (via `POST /deliver/{uuid}`) or for a WebSocket session (via `GET /ws/{uuid}`). The device decides how to allocate UUIDs from this pool between the two uses.

UUIDs are generated by the relay service and returned to the device at registration time. Each UUID is valid for exactly one use and is invalidated on use or on connection close.

In addition to the UUID pool, each registration call returns a **device credential** — an opaque token that identifies the device to the relay for the lifetime of the UUID pool. The device uses this credential to authenticate `GET /sse` and `GET /pending` requests. The credential is distinct from the push token and from UUID values.

---

## Multi-Device Support

Multi-device support is handled through subcards. Each app instance on each device holds its own subcard — a distinct key pair registered with the card's wallet service. The wallet service stores a UUID pool per subcard:

```
card_hash → {
  subcard_hash_1: { uuids: [...] },
  subcard_hash_2: { uuids: [...] },
  ...
}
```

where `subcard_hash = keccak256(subcard_pubkey)`. The sender encrypts independently to each registered subcard's public key before the message reaches the wallet service (`process_specs/message_routing.md §Sender-Side Fan-out` — no UMBRAL re-encryption at the wallet, as of v0.4). Each arriving routing envelope already carries one subcard's ciphertext; the wallet calls `POST /deliver/{uuid}` once per arriving envelope, drawing one UUID from that envelope's target subcard's pool. Each device independently receives and decrypts its own blob.

An app instance on two physical devices requires two subcards — one per device. The wallet treats them identically: separate UUID pools, separate delivery. There are no per-subcard re-encryption keys to manage.

A device deregisters its subcard by calling `DELETE /cards/{card_hash}/subcards/{subcard_hash}`. Subcard revocation follows the standard sub-card revocation flow defined in `specs/process_specs/subcard_creation_policy.md`.

---

## Process 1: UUID Registration

This flow runs when the device needs to replenish its UUID supply for a card.

### Steps

**Relay registration:**

1. The device opens a connection to the relay service via an unlinkable session (see Registration Privacy below).
2. The device calls `POST /register` with its current platform push token and a requested UUID count (1–100, default 10).
3. The relay service generates a UUID pool and a **device credential** for this registration. Each UUID is mapped to the push token and wallet WebSocket URL (looked up from the app registry via `app_id`).
4. The relay returns the UUID pool and device credential to the device. The relay stores for each UUID:
   ```
   uuid → { app_id, push_token, wallet_ws_url, device_credential, status: "unused" }
   ```
5. If this registration call's UUID pool is meant to cover more than one of the device's active cards, the device divides the returned UUIDs among them locally — this is a bookkeeping decision inside the device only; it does not change how the UUIDs are registered with wallet services (see step 6). The device stores locally, per card:
   ```
   card_hash → { uuids: [...], device_credential: "..." }
   ```
   The device tracks internally which UUIDs it has allocated to delivery vs. WebSocket use.

**Wallet registration:**

6. For **each card separately** — in its own session, staggered in time from any other card's registration (§Registration Privacy) — the device registers that card's allocated UUIDs with its wallet service. The registration is a signed envelope proving control of the subcard the UUIDs are being registered for, not a bare list:
   ```
   POST /cards/{card_hash}/subcards/{subcard_hash}/uuids
   Body:
   {
     "payload": {
       "card_hash":    "<on-chain registry address of the card>",
       "subcard_hash": "<keccak256(subcard_pubkey) — must match the path parameter>",
       "uuids":        ["<uuid-v4>", "..."],
       "timestamp":    "<ISO 8601>",
       "nonce":        "<32-byte random value, base64url — replay prevention>"
     },
     "signature": "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, signed by the subcard's private key, base64url>"
   }
   ```
   This session is conducted over Tor (or another anonymizing transport) — see §Registration Privacy for why this is the expected mechanism here, not an optional upgrade.

   Even when a single relay registration call (steps 1–5) covered multiple cards, **each card's wallet registration is still its own separate signed envelope in its own separate session** — the division in step 5 is a local allocation, not a batching of the wallet-facing registration call. Sending more than one card's UUIDs to a wallet service in one message or session is not permitted (§Registration Privacy).

7. The wallet service resolves `subcard_hash`'s registered public key (from the subcard's on-chain registration, per `specs/process_specs/subcard_creation_policy.md`), confirms `keccak256(subcard_pubkey) == subcard_hash`, and verifies the signature over the payload. It rejects the registration (and does not store any UUIDs) if the signature is missing, invalid, does not match the claimed `subcard_hash`, or if `payload.card_hash`/`payload.subcard_hash` do not match the request path. On success, the wallet service stores the UUIDs in the subcard's pool for that card.
8. The wallet service has no knowledge of the relay service, the push token, or the device credential.

### Replenishment

The device replenishes UUID pools proactively before they run low, on a randomized schedule. Replenishment is never triggered immediately after a message is received, as that timing pattern would allow the wallet service to correlate old and new UUID batches.

Suggested threshold: replenish when 3 or fewer UUIDs remain in the pool.

---

## Process 2: Message Delivery

This flow runs when a message arrives for a card. The delivery path depends on the device's current connection state at the relay.

### Steps

**Wallet → relay:**

1. A routing envelope arrives at the wallet service, already addressed to a specific `subcard_hash` and already encrypted to that subcard's key by the sender (`process_specs/message_routing.md §Sender-Side Fan-out`).
2. The wallet service delivers it to that subcard:
   a. Select the next UUID from the subcard's pool and remove it from the pool.
   b. Call the relay:
      ```
      POST /deliver/{uuid}
      Body: { blob: "<message blob, base64url, unchanged from the routing envelope>" }
      ```
   c. The relay transitions the UUID to `consumed`, stores the blob in the message store keyed by `device_credential`, and proceeds with delivery (steps 3–6 below).
   For a card with multiple registered subcards, the sender already sent one independently-encrypted envelope per subcard — the wallet does not iterate or transform anything here; each envelope's delivery is independent.
3. The wallet service **retains** the message until it receives `DELETE /messages/{uuid}` from the relay (staggered clearance, Process 5). The wallet's copy is the source of truth for undelivered messages.

**Relay → device:**

4. The relay checks whether an SSE connection is open for the device's `push_token`:
   - **SSE open:** stream `{ "uuid": "<uuid>", "blob": "<base64url>" }` to the device immediately. On acknowledgment (device calls `POST /ack` with the UUID), schedule a staggered delete to the wallet (Process 5) and remove the blob from the message store.
   - **No SSE:** continue to step 5.

5. The relay checks whether a WebSocket session is active for a UUID associated with the same `push_token`:
   - **WebSocket active:** forward the blob through the open WebSocket session. On delivery, schedule staggered delete and remove from store.
   - **No WebSocket:** continue to step 6.

6. The relay dispatches a **silent push notification** to the device via APNs or FCM, including only the UUID in the payload:
   ```json
   { "uuid": "<the delivery uuid>" }
   ```
   The blob remains in the relay message store pending device pickup via `GET /pending`.

### What APNs / FCM Observe

The platform push infrastructure (Apple, Google) delivers the silent push and observes:

- The device push token (identifies the device)
- An opaque UUID (meaningless without the relay's mapping)

No card identity, message content, or wallet service information is visible to the platform.

---

## Process 3: WebSocket Delivery (Active Chat)

This flow runs when the app is in an active chat session for a specific card. The relay's WebSocket connection is **inbound-delivery only** — it delivers blobs arriving from `POST /deliver/{uuid}` to the device. Outbound messages (device sending to wallet) go directly from device to the wallet service HTTPS endpoint.

### Steps

**Session establishment:**

1. When the app opens a chat session for a card, it selects the next unused WebSocket UUID for that card and removes it from its local pool.
2. The app opens a WebSocket connection to the relay service:
   ```
   wss://relay.example/ws/{uuid}
   ```
3. The relay looks up the UUID, confirms `status == "unused"`, then marks it `active` and registers the connection as a delivery channel.
4. No outbound connection to the wallet service is opened. The relay is now ready to deliver inbound blobs for this device via the open WebSocket.

**Inbound message flow (wallet → device):**

5. When a message arrives for this card, the wallet service calls `POST /deliver/{uuid}` with the encrypted blob.
6. The relay detects the active WebSocket connection for this device credential and forwards the blob directly over the open WebSocket:
   ```json
   {"uuid": "<uuid>", "blob": "<base64url>"}
   ```
7. The device acknowledges receipt via `POST /ack`.

**Outbound message flow (device → wallet):**

8. The device sends outbound messages directly to the wallet service HTTPS endpoint (the device tracks its wallet service URL). These messages do not transit the relay.
9. Message content is E2E encrypted and opaque to both the relay and the wallet service routing layer.

**Session teardown:**

10. When the chat session ends or the app backgrounds, the device closes its WebSocket connection.
11. The relay marks the UUID consumed and removes it from the active delivery map.
12. Any blobs that arrived during the session but were not yet acknowledged remain in the relay's pending store; they are delivered via SSE on foreground return or via push if the app backgrounds.

### Latency

The relay adds one network hop for inbound delivery (wallet → relay → device via WebSocket). With HTTP/2 or keep-alive connection pooling between wallet service and relay, `POST /deliver/{uuid}` round-trip is 5–20 ms — undetectable for human chat. There is no relay hop for outbound messages.

---

## Process 4: Device-Level SSE (Foreground, Not in Active Chat)

This flow runs when the app is open but the user is not in an active chat session. A single device-level SSE connection receives delivery events for all cards.

### Steps

**Connection establishment:**

1. When the app enters the foreground, it opens an SSE connection to the relay:
   ```
   GET /sse
   Authorization: Bearer {device_credential}
   Accept: text/event-stream
   ```
2. The relay authenticates the device credential, resolves the associated `push_token`, and registers the connection in an in-memory SSE map.
3. The relay streams a heartbeat comment (`:\n\n`) every 30 seconds to keep the connection alive through proxies.

**Delivery:**

4. When a blob arrives for this device (via `POST /deliver/{uuid}` while SSE is open), the relay streams:
   ```
   data: {"uuid": "<uuid>", "blob": "<base64url>"}
   ```
5. The device receives the event, reverse-maps the UUID to the corresponding card locally, decrypts the blob, and displays the message.
6. The device acknowledges receipt:
   ```
   POST /ack
   Authorization: Bearer {device_credential}
   Body: { "uuids": ["<uuid>", ...] }
   ```
7. The relay schedules a staggered delete to the wallet service for each acknowledged UUID (Process 5) and removes the blobs from the pending store.

**Connection lifecycle:**

8. The SSE connection is closed when the app backgrounds. The relay removes it from the in-memory map.
9. If blobs arrived while the connection was closed, they remain in the message store and are returned by `GET /pending` when the device comes back online.

### Energy Considerations

SSE maintains a persistent TCP connection that keeps the device radio active. It is used **only when the app is in the foreground**. When the app backgrounds, the OS closes the connection, and the relay falls back to silent push. This matches the battery optimization model of APNs and FCM: the OS-managed push connection handles background delivery; the app-managed SSE connection handles foreground delivery.

---

## Process 5: Device Catch-up via GET /pending

This flow runs when the device comes online after being offline, when the app launches, or when a silent push wakes the app.

### Steps

1. The device calls:
   ```
   GET /pending
   Authorization: Bearer {device_credential}
   ```
2. The relay resolves the `push_token` from the device credential, retrieves all stored blobs for that device from the message store, atomically clears the store, and returns:
   ```json
   { "messages": [{ "uuid": "<uuid>", "blob": "<base64url>" }, ...] }
   ```
3. The device reverse-maps each UUID to its card locally, decrypts each blob, and displays messages.
4. The device acknowledges receipt:
   ```
   POST /ack
   Authorization: Bearer {device_credential}
   Body: { "uuids": ["<uuid>", ...] }
   ```
5. The relay schedules a staggered delete to the wallet service for each acknowledged UUID (Process 6).

If no messages are pending, the relay returns `{ "messages": [] }`.

---

## Process 6: Staggered Wallet Clearance

After confirmed device pickup (via SSE ack or GET /pending ack), the relay clears the wallet service's copy of each delivered message.

### Steps

1. On receipt of `POST /ack` with a list of UUIDs, the relay enqueues a delete job for each UUID:
   ```
   scheduled_at = now + random(0, MAX_DELETE_DELAY_SECONDS)
   job = { wallet_url: record.wallet_base_url, uuid }
   ```
   Jobs are stored in a Redis sorted set keyed by scheduled execution time.

2. A background job polls the sorted set every 60 seconds. For each job with `scheduled_at ≤ now`:
   ```
   DELETE {wallet_url}/messages/{uuid}
   ```

3. On success (200 or 404): remove the job from the queue. A 404 means the wallet already cleared the message (e.g., via UUID expiry); this is not an error.

4. On failure (5xx or network error): requeue the job with exponential backoff, capped at 24 hours.

### Properties

- Delete jobs are held in Redis (in-memory). Jobs lost to a relay restart are benign: the wallet retains the message and retransmits it to the new UUID on re-registration. The device will deduplicate the re-delivered message by message ID within the decrypted blob.
- The 0–6 hour random delay decouples delivery timing from clearance timing, preventing the wallet service from inferring exact delivery time from the delete call.
- The relay makes one outbound delete call per delivered message, to the `wallet_ws_url` stored in the UUID record at registration time.

---

## Registration Privacy

The wallet service must never receive UUID registrations for multiple cards in a single session, as this would allow it to infer co-ownership. The following constraints apply:

- Each card's UUID registration is performed in a **separate session** with the wallet service.
- Sessions are **staggered in time** — randomized delays of minutes to hours between registrations for different cards on the same device.
- Replenishment sessions for a given card are **unlinkable** to prior sessions for that card (different network path, timing jitter).

Similarly, relay registrations for different cards should use separate sessions with the relay service, so the relay cannot correlate multiple UUID pools to the same device via IP.

Device credential registration with the relay must also use separate sessions per card, for the same reason.

**Transport:** wallet registration sessions (§Process 1, step 6) are conducted over Tor or another anonymizing transport by default — this is the expected mechanism, not an opt-in reserved for "users with strong privacy requirements." Clients behind NAT or shared IPs, or otherwise unable to route through Tor, should treat session-separation as best-effort in that specific case, but should not treat anonymizing transport itself as optional without a concrete reason.

**Transport anonymity and content-level correlation are different protections, and this section's per-card separation requirement exists because of the second one.** Tor (or any anonymizing transport) hides which network identity sent a registration — it does nothing to stop a wallet service from reading co-ownership directly out of a message's *contents*. A single signed envelope listing multiple `card_hash` values together, even sent over Tor, tells the receiving wallet service those cards are held by the same device just as plainly as an unencrypted one would. This is why batching multiple cards' UUID registrations into one session or message is not permitted regardless of transport (see §Process 1 step 6) — anonymizing transport and per-card session separation address different halves of the correlation problem, and dropping either one reopens the co-ownership inference this section exists to prevent.

---

## Failure Handling

| Scenario | Behavior |
|---|---|
| UUID pool exhausted for a subcard | Wallet retains message; delivers to remaining subcards; message is held until device replenishes that subcard's UUID pool and wallet retransmits |
| Relay unreachable for `POST /deliver/{uuid}` | Wallet retries with exponential backoff using the same UUID; UUID not consumed until relay accepts |
| SSE connection drops during delivery | Blob remains in relay message store; delivered via push or `GET /pending` on next wake |
| WebSocket connection dropped mid-session | Relay closes both sides; UUID consumed; pending blobs in store delivered via SSE or push |
| Relay restart (Redis cleared) | In-flight blobs lost; wallet retains messages; device re-registers UUIDs; wallet retransmits on re-registration; device deduplicates by message ID |
| Staggered delete job lost to relay restart | Wallet retains message; retransmitted to new UUID on device re-registration; device deduplicates |
| Push token rotated by platform | Device re-registers with relay using new token; relay issues new device credential; device issues fresh UUIDs to all wallet services |
| UUID rejected by relay (already used or unknown) | Wallet discards UUID and retries with next UUID in the subcard's UUID pool |
| Wallet returns 404 on staggered delete | Relay discards the job silently; message was already cleared |
| Device receives duplicate message (after relay restart) | Device deduplicates by message ID within the decrypted blob |

---

## Relay Service Trust Model

The relay service is a trusted intermediary for message delivery. It observes:

- Which device push tokens are registered
- Which UUIDs have been used and when
- Encrypted message blobs (E2E encrypted; content is unreadable without device keys)
- Timing of message delivery events per device
- Device co-ownership inference via timing (multiple concurrent `POST /deliver/{uuid}` calls for the same message arriving in rapid succession)

It does not observe card identities, message content (blobs are E2E encrypted), sender identities, or which UUIDs map to which cards.

The relay now holds encrypted message blobs at rest, in addition to routing metadata. This elevates its trust level relative to prior versions: a compromised relay additionally exposes stored ciphertext and message volume per device, though content remains unreadable.

The relay service may be operated by the same party as the wallet service, a third party, or — for users with strong privacy requirements — self-hosted. The architecture does not require the relay and wallet service to be operated by different parties to preserve the primary privacy properties, because UUIDs are opaque to both sides by design. Separate operation provides defense-in-depth against log correlation.

---

## Related Specs

- `specs/process_specs/message_routing.md` — how messages are routed between wallet services and placed in the recipient card's queue; wallet-to-relay delivery and fan-out
- `specs/process_specs/wallet_backup_and_recovery.md` — device registration and key management
- `specs/messaging_protocol.md` — `SignedMessageEnvelope` structure; E2E encryption model
- `specs/object_specs/relay.md` — relay service API spec; endpoint definitions
- `specs/object_specs/relay_data_model.md` — Redis key schema, message store, delete queue, UUID state machine
