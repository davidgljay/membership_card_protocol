# Message Routing — Process Spec

**Version:** 0.2 (draft)
**Date:** 2026-06-29
**Status:** Draft
**Changes from v0.1:** Wallet-to-relay delivery updated — wallet now calls `POST /deliver/{uuid}` with the encrypted blob body rather than a bodyless `POST /notify/{uuid}`. Multi-device fan-out added: wallet stores UUID pools per device_key and delivers once per device on each message. Wallet message retention rule added: wallet retains messages until `DELETE /messages/{uuid}` is received from the relay. UUID re-registration retransmit trigger added.

---

## Overview

Message routing describes how a wallet service determines which other wallet service holds a recipient card and delivers an encrypted message payload to it. The card's on-chain registry address — the same hash used as its mutable pointer — serves as its stable messaging address. No separate addressing scheme exists. Wallet services maintain local routing tables derived from off-chain binding announcements (via the Wallet Service Registry), enabling single-hop delivery with no external lookup at send time.

---

## The Card Hash as Address

A card's **registry address** (its entry in the Arbitrum One card registry contract) is its stable identity. This address is the same value used as:

- The card's **mutable pointer** (the on-chain key whose value is the current log head CID)
- The card's **messaging address** (the `to` field in the routing header, and the values in `recipients` / `senders` inside the signed message envelope)

The address is always derived from the card's public key:

```
registry_address = keccak256(recipient_pubkey)
```

The address is a fixed-length hash that any party who holds the card's public key can use to address a message without knowing which wallet service holds the card. The hash alone is sufficient; no additional directory is needed at send time once the routing table is warm.

---

## Wallet Service Registry

Each wallet service is identified by its **wallet service card** — a card registered in the on-chain card registry like any other card, but held by the wallet service operator. The mutable pointer of the wallet service card is its stable `wallet_service_id`.

### Peer List

Because the total number of wallet services in the network is small, each wallet service maintains a **peer list** — a static operator configuration listing all known wallet services:

| Field | Description |
|---|---|
| `wallet_service_id` | Mutable pointer of the wallet service card |
| `endpoint` | Base HTTPS URL for inbound routing envelopes and binding announcements |
| `transport_flags` | Bitmask of supported transports (see Transport Extensibility below) |
| `pubkey_hash` | `keccak256` of the wallet service card's ML-DSA-44 public key (for announcement verification) |

Adding or removing a wallet service from the network requires updating peer lists out-of-band across all operators.

### Binding Announcements

When a wallet service acquires a card — through new card registration or migration — it broadcasts a **`CardBindingAnnouncement`** to all peers via HTTP POST to each peer's `/bindings/announce` endpoint.

**`CardBindingAnnouncement` payload (the object both parties sign):**

```json
{
  "type":               "card_registration" | "card_migration",
  "card_hash":          "<keccak256(card_pubkey) — on-chain registry address>",
  "wallet_service_id":  "<mutable pointer of the announcing wallet service card>",
  "endpoint":           "<HTTPS URL of the announcing wallet service>",
  "timestamp":          "<ISO 8601>",
  "nonce":              "<32-byte random value, base64url — replay prevention>"
}
```

**Announcement envelope:**

```json
{
  "payload":    { "...CardBindingAnnouncement payload..." },
  "signatures": [
    {
      "public_key": "<ML-DSA-44 public key of signing card, base64url>",
      "role":       "wallet_service" | "cardholder",
      "signature":  "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    }
  ]
}
```

`card_registration` announcements carry a single `wallet_service` signature. `card_migration` announcements require dual signatures — `wallet_service` and `cardholder` — before peers will accept them. See `process_specs/card_migration.md` for the migration protocol.

Receiving wallet services verify all signatures before updating their routing table. The `wallet_service` signer is verified by checking that `keccak256(public_key)` resolves to the `wallet_service_id` in the payload. The `cardholder` signer is verified by checking that `keccak256(public_key)` matches the `card_hash` in the payload.

### Binding Conflict Resolution

A wallet service may receive conflicting announcements for the same `card_hash` (e.g., a stale `card_registration` and a later `card_migration`). Conflicts are resolved in order:

1. A `card_migration` announcement (cardholder-signed) **always supersedes** a `card_registration` announcement for the same `card_hash`, regardless of timestamps.
2. Between two `card_migration` announcements, prefer the one with the **later `timestamp`**.
3. Between two `card_registration` announcements, prefer the one with the **later `timestamp`**.
4. Announcements carrying a nonce already present in the local nonce cache are **rejected**. Nonces are retained for a rolling 24-hour window.

### Startup Sync

A wallet service coming online after downtime, or joining the network for the first time, fetches current binding state from all known peers before accepting traffic. Each wallet service exposes a `/bindings` endpoint that returns its full routing table as a list of signed `CardBindingAnnouncement` objects. A new or recovering wallet service fetches from all peers, merges the results applying the conflict resolution rules above, and builds its initial routing table.

---

## Local Routing Tables

Each wallet service maintains a local index:

```
routing_table: card_hash → wallet_service_id
```

This table is populated and kept current off-chain:

1. **Card registration binding** — when a press registers a new card, the wallet service that holds the card's keys announces the card-to-wallet-service binding through the off-chain Wallet Service Registry mechanism (design deferred to the wallet service spec). Other wallet services receive this binding and update their routing tables.

2. **Card migration binding** — when a card migrates from one wallet service to another, the new wallet service announces the updated binding through the same off-chain mechanism, updating `routing_table[card_hash]` for all observers.

3. **Startup sync** — a wallet service that has been offline or is starting fresh fetches the current routing state from the off-chain Wallet Service Registry to rebuild its routing table.

Because the routing table is maintained off-chain and replicated across wallet services via the Wallet Service Registry, it is eventually consistent. A stale routing table entry (card migrated but binding not yet processed) results in delivery to the old wallet service, which returns a `410 Gone` response with the new wallet service's `wallet_service_id`; the sender retries against the correct destination.

---

## Message Delivery

### Routing Envelope

Messages between wallet services are wrapped in a **routing envelope** — a thin, partially-visible outer layer that carries only the information needed to deliver the payload. The inner payload is E2E encrypted and opaque to the routing layer.

```json
{
  "to":      "<card hash — on-chain registry address of recipient card>",
  "payload": "<ML-KEM-encrypted SignedMessageEnvelope, base64url>"
}
```

`to` is visible to all wallet services that handle the envelope. `payload` is encrypted to the recipient card's ML-KEM public key (derived from the card's `recipient_pubkey` via HKDF) and is opaque to everyone except the recipient.

### Delivery Flow

```
Sender's wallet service (A)
  → look up routing_table[recipient_hash] → wallet_service_id B
  → construct routing envelope: { to: recipient_hash, payload: E2E_encrypted }
  → POST to wallet service B's endpoint

Wallet service B
  → receive routing envelope
  → confirm recipient_hash matches a card it holds
  → place encrypted payload in the recipient card's inbound queue
  → re-encrypt payload for each of the recipient's registered sub-card devices
    (UMBRAL proxy re-encryption, as in ADR-007)
  → return 202 Accepted to wallet service A
```

If wallet service B does not hold `recipient_hash`, it returns `410 Gone` with the current `wallet_service_id` for that hash (if known). Wallet service A updates its local routing table and retries.

### Relay Delivery and Multi-Device Fan-out

After placing the message in the recipient card's inbound queue, wallet service B delivers the encrypted payload to the relay for device notification. The wallet service maintains a UUID pool per registered device, keyed by `device_key = hash(device_id || card_hash)` (opaque to the wallet; derived by the device):

```
card_hash → {
  device_key_1: { delivery_uuids: [...], websocket_uuids: [...] },
  device_key_2: { delivery_uuids: [...], websocket_uuids: [...] },
  ...
}
```

For each registered `device_key` bucket:

1. Select the next delivery UUID from the bucket and remove it from the pool.
2. Call the relay:
   ```
   POST /deliver/{uuid}
   Body: { "blob": "<E2E encrypted payload, base64url>" }
   ```
3. On 200: UUID consumed; relay has accepted responsibility for delivery.
4. On 404 or 410 (UUID unknown or already consumed): advance to the next UUID in the bucket and retry.
5. On 5xx or network error: retry with exponential backoff using the same UUID.

Fan-out is performed independently per device_key; failure for one device does not block delivery to others.

### Wallet Message Retention

Wallet service B retains each message in its inbound queue until it receives a clearance call from the relay:

```
DELETE /messages/{uuid}
```

The relay sends this call after confirmed device pickup, with a random delay of 0–6 hours (staggered wallet clearance). The wallet service maps the UUID to the card and removes the corresponding message from the queue.

On receiving `DELETE /messages/{uuid}`:
- 200: message cleared.
- 404: UUID unknown (message already cleared or UUID never registered); discard silently.

**Wallet services must not clear messages based solely on relay delivery** (i.e., the 200 response to `POST /deliver/{uuid}`). The relay may be restarted between delivery and pickup; retaining the message until the explicit `DELETE` ensures no message loss.

### UUID Re-registration and Retransmission

When the relay's Redis store is cleared (restart), devices re-register new UUID pools with the wallet service. When wallet service B receives a new UUID registration for a card (`POST /cards/{card_hash}/devices/{device_key}/uuids`), it checks whether any messages in the inbound queue remain uncleared for that card. If so, it immediately delivers those messages to the new UUIDs using the relay delivery flow above.

This retransmission may cause the device to receive a duplicate of a message it already processed before the relay restart. Devices must deduplicate by message ID within the decrypted blob.

### Encryption Model

The `payload` field is encrypted using the recipient card's ML-KEM public key. The encryption wraps the full `SignedMessageEnvelope` — including sender identity, message type, and content. Wallet service B never sees any of this; it handles only ciphertext.

The sender's card identity, their signing sub-card, and the message content are all inside the encrypted payload. They are revealed only when the recipient's client decrypts the envelope.

---

## What Wallet Services Observe

A wallet service handling a routed message observes the following:

| Observable | Receiving wallet service (B) sees |
|---|---|
| Recipient card hash | **Yes** — present in the routing header `to` field |
| Originating wallet service | **Yes** — implicit from the TLS connection / IP of the sending wallet service |
| Sender card hash | **No** — inside the E2E encrypted payload |
| Message type | **No** — inside the E2E encrypted payload |
| Message content | **No** — inside the E2E encrypted payload |

The originating wallet service being visible narrows the anonymity set for the sender: the recipient wallet service knows the message came from some card held by wallet service A. This is the residual metadata visible at this transport tier. Future transport upgrades (see below) can eliminate it.

---

## Card Migration

Card migration is specified in full in `process_specs/card_migration.md`. Key properties relevant to routing:

- Migration does not require the participation of the old wallet service.
- Both the new wallet service and the cardholder must sign the migration announcement.
- The announcement is a `card_migration` type `CardBindingAnnouncement`, broadcast to all peers.
- A valid dual-signed `card_migration` announcement always supersedes any `card_registration` entry in the routing table (see Binding Conflict Resolution above).
- Messages in flight addressed to the old wallet service during the migration window are handled via the `410 Gone` retry mechanism.

No on-chain event is posted for card migration; routing state is entirely off-chain.

---

## Multi-Recipient Messages

When a `SignedMessageEnvelope` has multiple entries in its `recipients` array, the sender's wallet service sends a separate routing envelope per recipient. Each envelope carries the same encrypted payload (encrypted separately per recipient's ML-KEM public key) with the appropriate `to` field. Wallet services handle each delivery independently; there is no fan-out primitive at the routing layer.

---

## Transport Extensibility

The routing layer is transport-agnostic. `transport_flags` in the wallet service registry indicates which transports a wallet service supports:

| Flag | Description |
|---|---|
| `0x01` | Direct HTTPS (always required) |
| `0x02` | OHTTP relay (RFC 9458) — hides sender IP from recipient wallet service |
| `0x04` | Nym mixnet — onion-routed delivery; hides sender wallet service identity and provides timing obfuscation |

When sending, wallet service A checks the `transport_flags` of wallet service B and uses the highest-privacy transport that both support. This allows the network to upgrade incrementally: a wallet service advertising Nym support will receive Nym-routed messages from wallet services that also support Nym, while still receiving direct HTTPS from those that do not.

Upgrading from direct HTTPS to Nym changes only the transport layer. The routing table, routing envelope format, and E2E encryption model are identical across all transports.

---

## Sender Anonymity Constraint

At the direct-HTTPS transport tier, the receiving wallet service observes the originating wallet service. This means the recipient wallet service can infer that the sender is one of the cards held by the sending wallet service — a potentially small anonymity set in a network with few wallet services.

The sender's card identity remains hidden from the routing layer regardless of transport tier; it is always inside the E2E encrypted payload.

Full sender anonymity at the wallet-service level requires Nym transport (`0x04`), which routes the envelope through a mixnet path so the receiving wallet service cannot identify the sender's wallet service.

---

## Related Specs

- `ARCHITECTURE.md ADR-007` — transport layer decisions; UMBRAL re-encryption; OHTTP
- `specs/messaging_protocol.md` — `SignedMessageEnvelope` structure; message types; `recipients` and `senders` fields
- `specs/object_specs/registry_contract.md` — on-chain card registry (note: routing state and the Wallet Service Registry are off-chain; see INC-35)
- `specs/process_specs/card_offering_and_acceptance.md` — uses routing delivery (step 22: SCIP delivery to recipient wallet service)
- `specs/process_specs/card_migration.md` — full card migration protocol; dual-signature requirement; old wallet service behavior
