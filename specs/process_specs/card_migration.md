# Card Migration — Process Spec

**Version:** 0.1 (draft)
**Date:** 2026-06-28
**Status:** Draft

---

## Overview

Card migration is the process by which a cardholder moves their card from one wallet service to another. The old wallet service is not required to participate — migration is cardholder-initiated and takes effect as soon as a valid migration announcement reaches the peer network.

A valid migration requires dual authorization: the **new wallet service** (confirming it will hold the card) and the **cardholder** (confirming they consent to the move). This prevents either party from unilaterally claiming a card. The migration announcement is a `card_migration` type `CardBindingAnnouncement` as defined in `process_specs/message_routing.md`, broadcast to all known wallet services.

---

## Prerequisites

Before migration can proceed:

- The cardholder must hold a valid, unrevoked card.
- The cardholder must authenticate to the new wallet service by completing a signed challenge-response that proves possession of the card's private key (or a device sub-card key whose chain resolves to the card's master key).
- The new wallet service must be present in the peer lists of other wallet services.

---

## Protocol Steps

### 1. Cardholder authenticates to the new wallet service

The new wallet service issues a nonce. The cardholder signs it with their card's ML-DSA-44 key (or a device sub-card key), proving key possession without revealing the key. The new wallet service verifies the signature resolves to the presented card hash.

### 2. New wallet service constructs the migration announcement payload

```json
{
  "type":               "card_migration",
  "card_hash":          "<keccak256(card_pubkey) — the card's on-chain registry address>",
  "wallet_service_id":  "<mutable pointer of the new wallet service card>",
  "endpoint":           "<HTTPS URL of the new wallet service>",
  "timestamp":          "<ISO 8601 — time of migration>",
  "nonce":              "<32-byte random value, base64url>"
}
```

### 3. Dual signing

Both parties sign the canonical RFC 8785 JSON of the payload above. The assembled announcement:

```json
{
  "payload": { "...CardBindingAnnouncement payload..." },
  "signatures": [
    {
      "public_key": "<new wallet service card ML-DSA-44 pubkey, base64url>",
      "role":       "wallet_service",
      "signature":  "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    },
    {
      "public_key": "<cardholder card ML-DSA-44 pubkey, base64url>",
      "role":       "cardholder",
      "signature":  "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    }
  ]
}
```

The cardholder may sign with a device sub-card key rather than the master card key, provided the sub-card chain resolves to the card's master key. In that case the `public_key` in the cardholder signature entry is the sub-card key; verifying peers follow the sub-card chain to confirm it resolves to `card_hash` (see MIG-OQ-1 below).

### 4. Broadcast to all peers

The new wallet service broadcasts the signed announcement to all wallet services in its peer list via HTTP POST to each peer's `/bindings/announce` endpoint. Broadcast is best-effort; peers that are offline at broadcast time will receive the announcement on their next startup sync (via `/bindings`).

The old wallet service is among the broadcast recipients if it is in the new wallet service's peer list. It receives no special treatment — it processes the announcement the same way as any other peer.

### 5. Peer verification and routing table update

Each receiving wallet service:

1. Verifies both signatures against the canonical RFC 8785 JSON of the payload. Reject if either is missing or invalid.
2. Verifies the `wallet_service` signer: `keccak256(public_key)` must equal `wallet_service_id` in the payload.
3. Verifies the `cardholder` signer: `keccak256(public_key)` must equal `card_hash` in the payload (or the sub-card chain must resolve to `card_hash`).
4. Checks the `nonce` against the local nonce cache. Reject replays. Nonces are retained for a rolling 24-hour window.
5. Applies conflict resolution as defined in `process_specs/message_routing.md §Binding Conflict Resolution`. A `card_migration` announcement always supersedes a `card_registration` for the same `card_hash`.
6. Updates `routing_table[card_hash]` to the new `wallet_service_id`.

### 6. Old wallet service behavior on receiving the announcement

When the old wallet service processes the migration announcement:

1. It stops accepting new inbound routing envelopes for the migrated card.
2. It forwards any queued, undelivered messages for that card to the new wallet service by re-posting each routing envelope to the new wallet service's endpoint.
3. It removes the card from its local store.

The old wallet service has no veto. Once a valid dual-signed announcement is in circulation and has passed peer verification, routing is redirected regardless of the old wallet service's state.

---

## In-Flight Messages During Migration

Messages sent to the old wallet service while the migration announcement is still propagating are handled via the `410 Gone` mechanism:

- The old wallet service returns `410 Gone`, including the new `wallet_service_id` if it has already processed the announcement, or `410 Gone` with no forwarding hint if it has not.
- The sending wallet service updates its routing table from the hint (if present) and retries. If no hint is available, it queries any known peer for the card's current binding before retrying.

---

## Security Properties

| Property | Mechanism |
|---|---|
| No unilateral wallet service claim | Wallet service signature alone is insufficient; cardholder signature required |
| No unilateral cardholder claim | Cardholder signature alone is insufficient; a wallet service must co-sign and broadcast |
| Old wallet service cannot block migration | Migration does not require old wallet service participation |
| Old wallet service cannot reclaim the card | `card_migration` announcements supersede `card_registration` announcements regardless of timestamp |
| Replay resistance | 24-hour rolling nonce cache |
| Binding authenticity | ML-DSA-44 signatures from both the wallet service card and the cardholder card |

---

## Open Questions

**MIG-OQ-1: Sub-card chain inclusion in the announcement.** The spec allows the cardholder to sign with a device sub-card key rather than the master key. Verifying peers must then walk the sub-card chain to confirm it resolves to `card_hash`. Should the migration announcement include the sub-card chain certificate inline (making verification self-contained), or should peers look it up via the card chain on IPFS?

**MIG-OQ-2: Message queue handoff confidentiality.** When the old wallet service forwards queued messages to the new wallet service, those messages are opaque ciphertext (encrypted to the recipient card's ML-KEM key). The forwarding wallet service cannot read them. However, it does learn the volume and rough timing of queued messages. Is this acceptable, or should the handoff be designed to minimize that signal?

**MIG-OQ-3: Concurrent migration attempts.** If a cardholder simultaneously initiates migration to two different wallet services (error or race condition), both resulting announcements will have valid dual signatures. Conflict resolution falls back to timestamp comparison, which depends on clock accuracy. A migration sequence number per card, anchored to the card's on-chain log, would make ordering unambiguous. Worth specifying, or is timestamp-based resolution sufficient in practice?

---

## Related Specs

- `process_specs/message_routing.md` — `CardBindingAnnouncement` format; conflict resolution rules; `410 Gone` retry; startup sync
- `specs/messaging_protocol.md` — `SignedMessageEnvelope`; message types
- `ARCHITECTURE.md ADR-007` — transport layer; sender-side per-subcard encryption
