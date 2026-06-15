# Message Routing — Process Spec

**Version:** 0.1 (draft)
**Date:** 2026-06-14
**Status:** Draft

---

## Overview

Message routing describes how a wallet service determines which other wallet service holds a recipient card and delivers an encrypted message payload to it. The card's on-chain registry address — the same hash used as its mutable pointer — serves as its stable messaging address. No separate addressing scheme exists. Wallet services maintain local routing tables derived from on-chain registration events, enabling single-hop delivery with no external lookup at send time.

---

## The Card Hash as Address

A card's **registry address** (its entry in the Arbitrum One card registry contract) is its stable identity. This address is the same value used as:

- The card's **mutable pointer** (the on-chain key whose value is the current log head CID)
- The card's **messaging address** (the `to` field in the routing header, and the values in `recipients` / `senders` inside the signed message envelope)

For private and selectively-shared cards the address is derived as:

```
registry_address = keccak256(sign(private_key, "card-address-v1"))
```

For fully public cards it is derived from the card's public key. In both cases the address is a fixed-length hash that any party can use to address a message without knowing which wallet service holds the card. The hash alone is sufficient; no additional directory is needed at send time once the routing table is warm.

---

## Wallet Service Registry

Wallet services are registered on-chain in a dedicated **Wallet Service Registry** table in the card registry contract. A registered wallet service has:

| Field | Description |
|---|---|
| `wallet_service_id` | Stable on-chain identifier (bytes32) |
| `endpoint` | Base HTTPS URL accepting inbound routing envelopes |
| `transport_flags` | Bitmask of supported transports (see Transport Extensibility below) |
| `active` | Boolean — revoked wallet services cannot receive routed messages |

Registration and revocation follow the same governance pattern as press authorization (ADR-011): a governance quorum signs each `RegisterWalletService` / `RevokeWalletService` call.

Wallet services announce which cards they hold by emitting on-chain events when a card is registered to or migrated from them. All wallet services subscribe to these events to maintain their local routing tables.

---

## Local Routing Tables

Each wallet service maintains a local index:

```
routing_table: card_hash → wallet_service_id
```

This table is populated and kept current by:

1. **Card registration events** — when the press registers a new card on Arbitrum One, the registration calldata includes the `wallet_service_id` of the wallet service holding it. All wallet services receive this event and update their routing tables.

2. **Card migration events** — when a card migrates from one wallet service to another, the new wallet service posts a migration event on-chain, updating `routing_table[card_hash]` for all observers.

3. **Startup sync** — a wallet service that has been offline or is starting fresh replays all card registration and migration events from the registry contract to rebuild its routing table from chain state.

Because the routing table is derived entirely from on-chain events, it is eventually consistent across all wallet services. A stale routing table entry (card migrated but event not yet processed) results in delivery to the old wallet service, which returns a `410 Gone` response with the new wallet service's `wallet_service_id`; the sender retries against the correct destination.

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

When a card holder moves their card from one wallet service to another, the routing table must update. The migration process:

1. The holder authenticates to the new wallet service and initiates migration.
2. The new wallet service posts a `MigrateCard` event on-chain: `{ card_hash, from_wallet_service_id, to_wallet_service_id }`, signed by the holder's card key.
3. All wallet services receive the event and update `routing_table[card_hash]`.
4. The old wallet service forwards any queued messages to the new wallet service and then drops the card from its store.
5. Messages in flight addressed to the old wallet service during the migration window are handled via the `410 Gone` retry mechanism.

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
- `specs/object_specs/registry_contract.md` — card registration events; wallet service registry tables
- `specs/process_specs/card_offering_and_acceptance.md` — uses routing delivery (step 22: SCIP delivery to recipient wallet service)
