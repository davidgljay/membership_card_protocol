# Card-Based Matrix System Architecture

## Overview

A federated Matrix-based multiparty chat system where:
- **Identity:** Each participant is a cryptographic card (not a Matrix user)
- **Messages:** Posted via existing P2P transit layer (wallet services)
- **Rooms:** Gated by card policies; membership enforced via card validation
- **Encryption:** End-to-end encrypted (hybrid model); server operators cannot read message content
- **Federation:** Card network participants (verified, in-good-standing card holders) can run Matrix servers
- **Moderation:** Client-enforced (server operators have no visibility into content)

---

## System Architecture

### Layer Stack

```
[Client with Card(s)]
         ↓
[Wallet Service] (client's local P2P endpoint)
         ↓
[P2P Network] (DHT, gossip, message routing)
         ↓
[Room Address Handler] (routes to Matrix server operator)
         ↓
[Matrix Server] (Synapse instance)
         ↓
[Other Card Network Servers]
```

### Data Flow: Posting a Message

```
Alice (Card A) composes message for Room X
         ↓
Alice's wallet service:
  - Validates card signature
  - Resolves room address: "room:!xyz:server" → matrix.example.com
  - Constructs P2P message envelope
  - Routes via P2P network
  - Caches locally
         ↓
P2P Network:
  - Routes message to destination server's wallet service
         ↓
Destination server's wallet service:
  - Receives message from P2P
  - Validates card signature
  - Evaluates room policy: does Card A satisfy m.card.policy?
  - If invalid: drops, notifies sender
  - If valid: posts to Synapse, caches locally, notifies connected clients
         ↓
Bob (Card B, joined to Room X) syncs:
  - Wallet service: fetch cached messages for rooms Bob is in since token
  - Merge with Synapse fallback for historical/missed events
  - Filter by room access (only rooms Bob's card can access)
  - Return decrypted events
```

---

## Core Components

### 1. Membership Card Protocol

**What it is:** A cryptographic credential system for community membership and affiliation.

**Key properties:**
- Each card is a unique identity with cryptographic signing capability
- Cards can be issued by policies or inherit from other cards
- Cards are verified across the network (not stored on any single server)
- A person may hold multiple cards simultaneously

**For Matrix rooms:**
- Rooms are gated by card policy predicates (e.g., "issued by org X" OR "inherits from policy Y")
- Room membership enforced via card validation before join
- All messages must be signed by a card that satisfies the room's policy

### 2. Wallet Services

**What they are:** Local P2P endpoints that act as:
- Message routers (send/receive via P2P)
- Message validators (card signature verification)
- Cache layer (store recent messages, room metadata)
- Sync endpoint (provide clients with messages for joined rooms)

**Infrastructure:**
- One wallet service per node (could be client-side, server-side, or shared)
- Maintains message cache (recent events, TTL-based expiry)
- Maintains room registry (room metadata, policies, members)
- Maintains card cache (validity, revocation status, TTL-based expiry)

**Key functions:**
- `POST /send_message` — post to a room (via P2P routing)
- `GET /card-sync` — fetch messages for joined rooms (from cache + Synapse fallback)
- `POST /create_room` — create a new room (set policy, publish to Synapse)
- P2P message handler — route incoming messages, validate, post to Synapse, cache

### 3. Matrix Server (Synapse)

**What it does:** Stores and serves room state; **not client-facing**.

**Not exposed to:** Clients talk to wallet services, not directly to Synapse.

**Responsibilities:**
- Store room state events (m.card.policy, metadata)
- Store encrypted messages (ciphertext only)
- Serve as authoritative archive (for sync fallback, historical recovery)
- Maintain room membership (derived from card validation)
- Support federation between card network servers

**What it cannot see:**
- Message content (encrypted)
- Card IDs in message body (embedded in ciphertext)
- Room policies beyond m.card.policy state event

### 4. P2P Network

**What it does:** Routes messages between wallet services.

**Existing infrastructure:** Leverage existing peer-to-peer transit layer with:
- Room address resolution (room:!xyz:server → wallet service address)
- Message routing and gossip
- Peer discovery and bootstrap

**New concept:** Rooms as P2P addresses
- `room:!xyz:matrix.example.com` is a routable address
- Wallet services subscribe to topics for rooms they host
- Messages addressed to a room are routed to that room's server

---

## Room State and Policy

### Card Policy State Event

Stored as `m.card.policy` in room state:

```json
{
  "type": "m.card.policy",
  "state_key": "",
  "content": {
    "policy_id": "policy:community-members",
    "rules": {
      "type": "any_of",
      "predicates": [
        { "type": "issued_by", "issuer": "issuer:org" },
        { "type": "inherits_from", "policy": "policy:founder" },
        { "type": "card_set", "cards": ["card:xyz"] }
      ]
    },
    "visibility": "card_only"
  }
}
```

**Policy evaluation:** `can_join(card, policy) := evaluate(card, policy.rules) AND policy.visibility == "card_only"`

### Room Visibility

- **Discoverable only by:** Cardholders who satisfy the room's policy
- **Not listed in:** Standard Matrix public room directory
- **Discovery mechanism:** Custom index (built from room metadata, queried by card)
  - Stored in P2P network or local wallet service
  - Synced when rooms are created or policy changes

---

## Message Structure and Encryption

### Encryption Model: Hybrid E2EE

**Messages are encrypted at rest on the Matrix server.**

#### Room Setup
- Room creator generates symmetric room key (AES-256)
- Distributes room key to members via P2P (1-on-1 encrypted channels, outside the room)
- New members receive room key from an existing member (via P2P)
- Key rotation on member leave: create new room or distribute new key

#### Message Structure

```json
{
  "type": "m.room.message",
  "event_id": "$event_id",
  "room_id": "!xyz:matrix.example.com",
  "content": {
    "algorithm": "aes-256-cbc",
    "encrypted": "base64_encrypted_body"
  },
  "unsigned": {
    "card_signatures": [
      {
        "card_id": "card:alice123",
        "signature": "sig_over_ciphertext",
        "issued_by": "issuer:org",
        "inherits_from": ["policy:x"]
      }
    ]
  }
}
```

#### Plaintext Message Structure (Before Encryption)

```json
{
  "body": "hello",
  "signature": "sig_over_plaintext",
  "co_signers": [
    {
      "card_id": "card:alice_co_signed_by_bob",
      "signature": "sig_over_plaintext"
    }
  ]
}
```

#### Encryption/Decryption Flow

**Posting:**
1. Wallet service receives plaintext message + card
2. Card signature is computed over plaintext
3. Plaintext is encrypted with room key → `encrypted_body`
4. Server signature is computed over `encrypted_body`
5. Event posted to Synapse with ciphertext and signatures

**Receiving:**
1. Client fetches encrypted event from wallet service cache or Synapse
2. Wallet service verifies server signature on ciphertext (detects tampering)
3. Client decrypts with room key → plaintext
4. Client verifies plaintext signatures (non-repudiation)
5. Client verifies co-signer signatures (if present)
6. Message displayed

#### Signature Semantics

- **Server signature** (on ciphertext): Authenticates the event to the server; server can verify without decryption; detects server-side tampering
- **Plaintext signature** (on decrypted message): Non-repudiation; proves the cardholder signed this specific message content
- **Co-signer signatures** (from co-signed cards): Additional cards that endorse/co-sign the message
  - Co-signer card is a card that Alice holds, issued by Bob, tied to a unique key controlled by Alice
  - Alice uses the co-signer card's key to sign the message
  - Bob does not need to see the plaintext (co-signing happens via the card's cryptographic protocol)

### What the Server Operator Can See

With hybrid E2EE:
- ✓ Card IDs (from unsigned signatures)
- ✓ Room ID and timestamp
- ✓ Room policies (m.card.policy state)
- ✓ Who joined/left the room
- ✗ Message content (encrypted)
- ✗ Co-signer relationships beyond card IDs
- ✗ Message order relative to plaintext content (only encrypted form)

### What Wallet Services Can See

- ✓ Card IDs
- ✓ Room IDs and routing metadata
- ✓ Timestamps
- ✗ Message content (encrypted in transit and at rest)

---

## Federation

### Server Requirements

To participate in the card network, a Matrix server operator must:
1. Be verified (have a card that satisfies network participation policy)
2. Be in good standing (card not revoked, network trust maintained)
3. Run a Synapse instance + wallet service
4. Expose federation endpoints (custom card federation, not standard Matrix federation)

### Federation Protocol

**Discovery:**
- Card servers are registered in P2P DHT or hardcoded registry
- New servers announce themselves via P2P gossip

**Trust:**
- Server-to-server authentication via card credentials (not Matrix server keys)
- Each server authenticates as a card holder to other servers

**Room Replication:**
- Rooms can exist on multiple servers (replicated via P2P)
- Room state and encrypted messages are synced between servers
- Members on Server A and Server B can see the same room
- Events are routed through P2P, cached by wallet services, stored in Synapse

**Key Distribution for Federated Rooms:**
- When a room is created on Server A, the room key is generated
- Members on Server A receive the room key via P2P (1-on-1)
- Members joining from Server B request the room key from an existing member (via P2P)
- Each server maintains a local encrypted copy of the room key (distributed to members on join)

---

## Message Caching and Sync

### Wallet Service Cache

Each wallet service maintains:

```
message_cache:
  room:!xyz:server:
    events: []  # Chronological list of events
    last_sync_token: "t123"
    expiry: TTL (e.g., 7 days)

room_registry:
  !xyz:server: { created_at, policy, members, ... }
  !abc:server: { ... }

card_cache:
  card:alice123: { valid: true, revoked: false, expiry: ... }
```

### Sync Flow

**Client calls wallet service (not Matrix directly):**

```
GET /card-sync?since=token
  Headers: { "X-Card": card_id, "X-Card-Signature": sig }
```

**Wallet service logic:**
1. Validate card auth
2. Fetch rooms card is a member of (from Synapse or cache)
3. For each room:
   a. Get cached encrypted events since token
   b. If cache is stale (> TTL or gap detected): query Synapse and merge
4. Filter rooms by card access (only rooms policy predicate is satisfied for)
5. Return encrypted events to client

**Result:**
```json
{
  "rooms": {
    "joined": {
      "!xyz:server": {
        "timeline": {
          "events": [ ... encrypted events ... ],
          "limited": false,
          "last_sync_token": "t456"
        }
      }
    }
  }
}
```

### Fallback for Missed Events

If wallet service cache expires or message was posted while client offline:
1. Wallet service queries Synapse: `GET /_matrix/client/v3/sync?since=token`
2. Merges results with local cache
3. Deduplicates and orders by timestamp
4. Returns merged event stream

---

## Client Experience

### Standard Workflows

**Creating a Room:**
```
Client: POST /create_room
  card: Card A
  policy: { rules: { ... } }
  ↓
Wallet service:
  - Validate Card A
  - Create room in Synapse
  - Set m.card.policy state event
  - Generate and cache room key
  - Distribute room key to Card A via local storage
  ↓
Return room_id to client
```

**Posting a Message:**
```
Client: POST /send_message
  to: room:!xyz:server
  body: "hello"
  card: Card A
  co_signers: [Card A_cosigned_by_B]
  ↓
Wallet service:
  - Validate card and co-signer signatures (on plaintext)
  - Encrypt plaintext with room key
  - Sign ciphertext with card
  - Route via P2P to matrix.example.com
  - Cache locally
  ↓
Destination wallet service:
  - Receive from P2P
  - Validate signature on ciphertext
  - Post to Synapse
  - Cache locally
  - Notify connected clients
```

**Syncing Messages:**
```
Client: GET /card-sync?since=token
  card: Card A
  ↓
Wallet service:
  - Validate card
  - Fetch encrypted events from cache/Synapse
  - Return encrypted events
  ↓
Client:
  - Verify ciphertext signature (server auth check)
  - Decrypt with room key
  - Verify plaintext signatures
  - Display
```

---

## Deployment

### Container Setup

```yaml
version: '3'
services:
  synapse:
    image: matrixdotorg/synapse:latest
    volumes:
      - ./synapse:/data
    networks:
      - card-net
    # NOT exposed publicly; only wallet-service talks to it

  wallet-service:
    build: ./wallet-service
    ports:
      - "9000:9000"  # P2P endpoint
      - "9001:9001"  # Client API
    environment:
      SYNAPSE_URL: http://synapse:8008
      P2P_BOOTSTRAP_PEERS: [...]
    depends_on:
      - synapse
    networks:
      - card-net
    volumes:
      - ./wallet-db:/app/data  # Message cache, room registry, card cache

  # Optional: Matrix compatibility proxy
  matrix-compat-proxy:
    build: ./matrix-proxy
    ports:
      - "8008:8008"  # Standard Matrix client API (for compatibility)
    environment:
      WALLET_SERVICE_URL: http://wallet-service:9001
    depends_on:
      - wallet-service
    networks:
      - card-net
```

### Network Components

- **Synapse:** Persistence and state (not client-facing)
- **Wallet Service:** P2P router, validator, cache, sync endpoint
- **P2P Network:** Message delivery between wallet services
- **Card Network:** Card issuance, verification, revocation (existing infrastructure)

---

## Security Model

### Trust Assumptions

1. **Wallet service operator:** Trusted to not tamper with messages in transit (relies on P2P network security and card signatures)
2. **Matrix server operator:** Trusted to store encrypted data securely (cannot read content); verified via card network participation
3. **P2P network:** Assumed to route messages correctly (can observe metadata but not content)
4. **Card network:** Assumed to be the source of truth for card validity and revocation

### Threat Mitigations

- **Server compromise:** Message content remains encrypted; ciphertext may be leaked but plaintext remains private
- **Card revocation:** Revoked cards cannot join new rooms; membership in existing rooms remains until owner removes them
- **Message tampering:** Server signature on ciphertext detects tampering; plaintext signatures on decryption verify sender intent
- **Policy bypass:** Wallet service validates card policy before posting and joining; server has no ability to bypass
- **Historical access:** Only room members can access message content; non-members cannot join retroactively (key not distributed)

---

## Open Questions & Future Work

1. **Room key distribution at scale:** Current model requires out-of-band P2P distribution. At scale, need robust mechanism for new members to request keys from existing members.

2. **Co-signing protocol:** Details of how co-signed cards work (card issuance, key management, proof of co-signing).

3. **Policy predicate language:** Formal specification of room policy rules (syntax, semantics, evaluation algorithm).

4. **Card revocation detection:** How wallet services learn of card revocations (polling, push notifications, gossip).

5. **Room discovery index:** Full specification of room discovery mechanism (P2P DHT, centralized index, hybrid).

6. **Bandwidth optimization:** Whether to batch P2P messages, implement compression, or use alternative encodings.

7. **Client libraries:** SDK for client-side encryption/decryption, room key management, card handling.

8. **Moderation tools:** Despite server-side blindness, what tools do operators have for abuse detection/prevention (e.g., rate limiting, membership management)?

9. **Key rotation:** Mechanism for rotating room keys when members leave (currently out of scope; deferred to future spec).

10. **Offline message recovery:** Mechanism for clients to recover missed messages (not yet specified; likely requires P2P direct message to existing member).
