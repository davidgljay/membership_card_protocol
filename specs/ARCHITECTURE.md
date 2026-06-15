# Card Protocol — Arcardecture Decision Record

**Version:** 1.1  
**Date:** 2026-06-14  
**Status:** Current  
**Source:** Synthesized from `card_protocol_spec.md` (v0.3) and supporting raw notes. v1.1 adds ADR-012 (secp256r1 for on-chain verification; ML-DSA-44 retained for IPFS content signing) and closes OQ-2.  

---

## Table of Contents

1. [System Overview](#system-overview)
2. [ADR-001: Registry Substrate — Arbitrum One](#adr-001-registry-substrate--arbitrum-one)
3. [ADR-002: Off-Chain Content Storage — IPFS](#adr-002-off-chain-content-storage--ipfs)
4. [ADR-003: Append-Only Log Arcardecture](#adr-003-append-only-log-arcardecture)
5. [ADR-004: Cryptographic Primitives — ML-DSA-44 and ML-KEM](#adr-004-cryptographic-primitives--ml-dsa-44-and-ml-kem)
6. [ADR-005: Press Model and Key Custody](#adr-005-press-model-and-key-custody)
7. [ADR-006: Privacy Model — Client-Side, Private by Default](#adr-006-privacy-model--client-side-private-by-default)
8. [ADR-007: Transport Layer — HTTPS](#adr-007-transport-layer--https)
9. [ADR-008: Annotation Layer — EAS on Arbitrum One](#adr-008-annotation-layer--eas-on-arbitrum-one)
10. [ADR-009: Key Management — Two-Tier with YubiKey Recovery](#adr-009-key-management--two-tier-with-yubikey-recovery)
11. [ADR-010: Canonical Serialization — RFC 8785 vs. CBOR](#adr-010-canonical-serialization--rfc-8785-vs-cbor)
12. [ADR-011: On-Chain Press Authorization and Protocol Governance](#adr-011-on-chain-press-authorization-and-protocol-governance)
13. [Component Map](#component-map)
12. [Key Data Flows](#key-data-flows)
13. [Open Questions](#open-questions)
14. [Risk Register](#risk-register)

---

## System Overview

The Card Protocol is a decentralized, privacy-preserving credential system. Its core primitive — the **card** — is a cryptographically signed credential issued under a policy, held by a user-sovereign keypair, whose current state is tracked on Arbitrum One and whose full content and history live on IPFS.

**Design goals:**

- Credentials are verifiable by anyone with IPFS and Arbitrum One access, without contacting the issuer.
- Privacy is a client-side choice; the registry contract is neutral.
- Revocation is authoritative and trustless via on-chain state.
- Key custody is user-sovereign; no service holds a user's signing key.
- The system is composable: credentials can reference other credentials, policies can constrain sub-policies, and third-party annotations accumulate as reputation context.

**What a card is, structurally:**

A card is a JSON document containing protocol-required fields (issuer, recipient public key, signatures, policy reference) plus policy-defined fields. The document is content-addressed and immutable on IPFS. Its current state is tracked by a **mutable pointer** — an on-chain registry entry pointing to the current head CID of an append-only log. The mutable pointer is the stable identity of the card across all updates.

---

## ADR-001: Registry Substrate — Arbitrum One

**Status:** Accepted  
**Date:** 2026-05-19 (v0.3 spec)

### Context

The protocol requires a shared, authoritative registry that maps each card's mutable pointer to its current log head CID, enforces that only authorized presses can write new entries, and provides trusted timestamps and rollback resistance. The registry must verify press authorization on every write with efficient on-chain signature verification.

### Decision

Deploy a single registry contract on **Arbitrum One**, using the **RIP-7212 secp256r1 precompile** for on-chain write authorization. Press write operations and governance operations are signed with secp256r1 (P-256) keys; ML-DSA-44 is retained for IPFS content signing (see ADR-004, ADR-012). The contract is implemented in **Stylus** to retain the upgrade path to on-chain ML-DSA-44 verification when warranted. One contract manages all cards; entries are separated by their on-chain address.

### Options Considered

| Dimension | Arbitrum One | Solana | Ethereum Mainnet | Polygon |
|---|---|---|---|---|
| Transaction cost (create) | ~$0.05–0.10 | ~$0.00025 | $3–5 | $0.001–0.01 |
| Transaction cost (update) | ~$0.02–0.05 | ~$0.00025 | $1.50–2.50 | <$0.01 |
| secp256r1 precompile (RIP-7212) | Yes — native on Arbitrum | No | No | Partial |
| Historical reliability | High (inherits ETH security) | Outages in 2022; improved | High | Medium |
| EAS availability | Native on Arbitrum | Not available | Native on Mainnet | Available |
| EVM composability | Full | None | Full | Full |
| On-chain sig calldata | 64-byte sig + 64-byte pubkey per write | Minimal | Prohibitive | Low |

**Key trade-off: Solana vs. Arbitrum One.** Solana's per-transaction cost is ~100x cheaper than Arbitrum One. However:

1. **RIP-7212 secp256r1 precompile** is natively deployed on Arbitrum One. This is the core on-chain verification mechanism for the protocol; Solana has no equivalent and would require a custom program.
2. **EAS (Ethereum Attestation Service)** is natively deployed on Arbitrum One. The annotation layer (ADR-008) depends on EAS; replicating this on Solana adds significant implementation scope.
3. **Solana's historical outage risk** is a chain-wide single point of failure. Distributed EVM infrastructure is lower correlated risk.
4. At estimated write volumes, Arbitrum One costs remain under $0.10/write with secp256r1 calldata — acceptable for a credential issuance use case where writes are infrequent relative to reads.

**Why not the hash-commitment shortcut?** Storing only a hash of the press public key and verifying signatures off-chain was explicitly rejected. It degrades the contract from a write gatekeeper to a passive log, enabling spam writes from anyone who knows a valid press public key. Full on-chain signature verification (secp256r1 via RIP-7212) is required on every write.

### Consequences

- secp256r1 signatures (64 bytes) and public keys (64 bytes) are dramatically smaller than the original ML-DSA-44 design (~2,420-byte signatures, ~1,312-byte keys), reducing per-write calldata cost by ~15–20x.
- Arbitrum One blob-era gas pricing should be finalized before contract deployment.
- Press wallets hold ETH (not SOL) to pay for registry writes. A paymaster pattern can sponsor gas for recipient-initiated writes (self-revocations).
- The annotation layer (EAS) runs on the same chain, simplifying verification — chain reads for revocation and annotation lookups both target Arbitrum One.
- **Future upgrade path to ML-DSA-44 on-chain is built in from day one.** See ADR-012.

---

## ADR-002: Off-Chain Content Storage — IPFS

**Status:** Accepted

### Context

Card content, policy documents, and the keyring blob must be stored durably, be content-addressable, and be independently fetchable by any verifier without going through a centralized service.

### Decision

Use **IPFS** for all off-chain content. The on-chain registry stores only CID pointers; content resolution is off-chain.

### Rationale

- **Content-addressing** means the CID is a cryptographic commitment to the content. A verifier who fetches content at a CID can confirm they received exactly what the issuer uploaded.
- **No persistence guarantee from IPFS alone.** Data lives only as long as someone is pinning it. This is addressed by requiring presses to pin all content they upload, with optional Filecoin archival via web3.storage/w3up for long-term persistence.
- **IPNS was evaluated and rejected** for the mutable pointer role. IPNS resolution is slow (seconds to minutes, DHT propagation) and records expire if not republished. The on-chain pointer provides faster and more reliable resolution for the head CID.

### Consequences

- Presses are responsible for pinning all content they upload to IPFS. A card whose content is no longer pinned is unresolvable by verifiers.
- The keyring blob (§ADR-009) lives on IPFS and must be pinned by the primary service until the user recovers.
- Filecoin integration (via pinning services) is the recommended long-term persistence path for high-value card data but is not required in v1.

---

## ADR-003: Append-Only Log Arcardecture

**Status:** Accepted

### Context

Card history — all updates, annotations, and revocations — must be preserved in an immutable, auditable log. The current state (log head) must be resolvable quickly; the full history must be independently verifiable. OrbitDB was evaluated as a candidate for this role.

### Decision

The append-only log is a **linked chain of IPFS CIDs**. Each log entry is a signed JSON object containing the entry content and a `prev_log_root` pointer to the prior entry. The on-chain registry tracks only the current head CID. Verifiers reconstruct history by following prev pointers from the head.

**OrbitDB was rejected** as the primary log mechanism.

### Why OrbitDB Was Rejected

OrbitDB provides CRDT-based append-only logs on IPFS with automatic peer synchronization. However:

1. **No trustless revocation.** A malicious or stale OrbitDB peer could withhold revocation entries. The protocol needs revocation to be authoritative, not dependent on honest replication peers. On-chain anchoring of the log head eliminates this risk — the Arbitrum One registry entry is the canonical, tamper-resistant reference.
2. **OrbitDB is better suited to content/message logs** (high-frequency, eventual-consistency-tolerant) than identity/state operations (low-frequency, correctness-critical).
3. **Simpler verification.** The linked-CID-chain pattern requires no OrbitDB peer infrastructure. Any verifier with IPFS access can walk the log independently.

### Two Distinct Append-Only Logs

The protocol uses two log types with different privacy requirements:

| Log type | Owner | Privacy | Anchored on-chain? |
|---|---|---|---|
| **Card log** | Card holder | Public or private (owner's choice) | Yes — head CID in Arbitrum One registry |
| **Press log** | Press service | Private by default | Yes — head CID in policy card's registry entry |

The press log records each issuance event, encrypted under the current audit epoch's AEK (AES-GCM, per-entry random nonce). The AEK is generated at epoch open and wrapped once per auditor via ML-KEM-768; each auditor receives only their own wrapped copy. The press operator cannot read these entries. See `card_protocol_spec.md §2` Audit Epoch Lifecycle for the full open/close procedure.

### Log Entry Structure (Field Updates and Revocations)

```json
{
  "version": <monotonically increasing integer>,
  "code": <100–999 — semantic update code; 1xx–7xx for field updates, 8xx–9xx for revocations>,
  "entry_type": "field_update" | "revocation",
  "prev_log_root": "<CID of prior log root — base64url>",
  "field_updates": [ { "field": "<name>", "value": <new value> } ],
  "revocation": {
    "effective_date": "<ISO 8601>",
    "note": "<optional>"
  },
  "notify_holder": true,
  "updater_message": "<optional message forwarded to holder>",
  "intent_signature": {
    "signer_card": "<mutable pointer in registry of updater's sub-card — base64url>",
    "public_key": "<ML-DSA-44 public key — base64url>",
    "signature": "<sig over canonical RFC 8785 JSON of UpdateIntentPayload — base64url>"
  },
  "press_signature": {
    "signer_card": "<mutable pointer in registry of press's sub-card — base64url>",
    "public_key": "<ML-DSA-44 public key — base64url>",
    "signature": "<sig over canonical RFC 8785 JSON of complete LogEntry excluding press_signature — base64url>"
  }
}
```

`code` is present on **every** log entry. `field_updates` is populated for 1xx–7xx codes; `revocation` is populated for 8xx–9xx codes. `intent_signature` covers the `UpdateIntentPayload` the updater submitted; `press_signature` covers the assembled `LogEntry` document.

The monotonic version number prevents replay. The `prev_log_root` CID creates a content-addressed chain. On-chain anchoring of the head CID provides a trusted timestamp and rollback resistance.

### Consequences

- Full log verification requires fetching all CIDs in sequence from IPFS (from head to genesis). For long-lived cards, this grows linearly. Chain-walk parallelization using the cached chain array mitigates latency.
- OrbitDB replication nodes (docker-compose reference stack) may still be useful for press infrastructure to distribute IPFS pinning, but are not part of the trust model.

---

## ADR-004: Cryptographic Primitives — Split Signing Model

**Status:** Accepted (revised 2026-06-14 per ADR-012)

### Context

Signature and key encapsulation schemes must be selected for the protocol. The primary concern is post-quantum security for long-lived credentials, balanced against on-chain gas efficiency for write operations.

### Decision

The protocol uses a **split signing model** with two distinct signature schemes serving different roles:

- **IPFS / content signatures:** **ML-DSA-44** (FIPS 204, Module Lattice Digital Signature Algorithm). Used for all content signed to IPFS — card documents, log entries, SCIPs, message envelopes, audit epoch entries, and all other IPFS-stored artifacts. Post-quantum resistance is required here because IPFS content is permanent and cannot be re-signed after publish.
- **On-chain write authorization:** **secp256r1 (P-256)** via the **RIP-7212 precompile** on Arbitrum One. Used for press write operations and governance operations. Keys are rotatable; the upgrade path to ML-DSA-44 on-chain is built in. See ADR-012.
- **Key encapsulation (audit log encryption):** **ML-KEM-768** (FIPS 203, Module Lattice Key Encapsulation Mechanism, parameter set 768). ML-KEM-768 is the normatively pinned parameter set for this protocol.
- **Canonical serialization:** RFC 8785 (JSON Canonicalization Scheme — JCS). Lexicographic key sort, no whitespace, standard JSON escaping, UTF-8 output. See ADR-010.

### Rationale for split model

| Dimension | On-chain writes (secp256r1) | IPFS content (ML-DSA-44) |
|---|---|---|
| Public key size | 64 bytes (uncompressed) | 1,312 bytes |
| Signature size | 64 bytes | 2,420 bytes |
| Post-quantum security | No — but keys are rotatable | Yes (FIPS 204) |
| On-chain gas cost | ~3,450 gas (RIP-7212 precompile) | ~10–30× more (Stylus WASM) |
| Long-term threat model | Key rotation mitigates quantum risk | No rotation possible — PQ required now |

The decisive factor is the asymmetry in the threat model. For IPFS content, a "harvest now, break later" attack is a real risk: an adversary can collect signed content today and forge or undermine signatures once quantum computing matures, since the content and signatures are permanent. ML-DSA-44 is required from day one. For on-chain writes, the signature is consumed at verification time — what persists is the resulting state change, not the signature. A future quantum adversary breaking a historical press write signature cannot undo that write. The threat is key compromise enabling *future* unauthorized writes, which key rotation addresses. secp256r1 with a designed-in upgrade path to ML-DSA-44 is sufficient.

### Press card key structure

Each press card carries two public keys:

1. `secp256r1_pubkey` — registered on-chain (stored as 64 raw bytes in `PressAuthorizations`); used for on-chain write authorization via RIP-7212.
2. `mldsa44_pubkey` — the card's `recipient_pubkey` field in its `CardDocument` on IPFS; used for all content/IPFS signature verification.

Governance keys follow the same pattern: secp256r1 for on-chain governance operations (stored in `GovernanceKeysets`), rotatable.

### Proxy Re-encryption

The message server uses **UMBRAL proxy re-encryption** to transform inbound ciphertexts (encrypted to a master card public key) into per-device sub-card ciphertexts, without ever seeing plaintext. This enables multi-device delivery without the master key being online.

---

## ADR-005: Press Model and Key Custody

**Status:** Accepted  
**Prior open question resolved:** Key custody is user-sovereign (not press-custodial).

### Context

A **card press** is a service that verifies policy compliance and issues cards on behalf of authorized policies. The question of who holds the card holder's signing key determines the trust model users opt into.

### Decision

**Key custody is user-sovereign.** The press never holds a card holder's signing key.

The issuance flow is a **mutual-signing pattern**:

1. The press verifies policy compliance, assembles the proposed card JSON (without the recipient's public key), and signs it as a **signed offer** — attesting that this press verified policy compliance.
2. The recipient independently generates their own ML-DSA-44 keypair, adds their public key, and **countersigns** the completed card.
3. Both signatures are present in every completed card. The press's signature is a statement about policy adherence; the recipient's countersignature is an assertion of identity and acceptance.

The press's signing key is the private key for its **press sub-card** — a sub-card of a specific policy card that authorizes it to issue under that policy. No separate press key type exists.

### Press Authorization Structure

```
Policy card (held by administrator/authorizer)
  └── Press sub-card (held by press operator)
       └── Issued cards (held by recipients)
```

The Arbitrum One registry contract enforces press authorization via two on-chain tables defined in ADR-011: `PolicyAuthorizerKeys` (mapping each policy to its governance-assigned authorizer key) and `PressAuthorizations` (mapping (policyAddress, pressAddress) pairs to the press's active public key). A registry write is accepted only if it is signed by a key that appears in `PressAuthorizations` for the target policy and is marked active. Revoking a press removes its write authority; previously-issued cards are unaffected.

> **Amendment note (ADR-011):** Earlier versions of this document stated that the registry contract enforces authorization by checking whether a press sub-card pointer appears in the IPFS-stored `approved_presses` field of the policy card. That mechanism was under-specified: the Stylus contract cannot fetch or verify IPFS content at write time. ADR-011 replaces it with the on-chain tables described above. The `approved_presses` field in the policy card's IPFS content is retained as an audit surface that tooling should keep in sync with on-chain state; in the event of a discrepancy, on-chain state is authoritative.

### Privacy Properties of the Press

The press is deliberately constrained in what it can observe:

- **The press never sees plaintext CIDs.** The client encrypts the CID before handoff; the press posts ciphertext.
- **The press never knows the address derivation secret.** The client derives the registry address locally and tells the press where to write.
- **The press does record the card CID in its press log**, encrypted to each auditor's public key. This provides the policy authorizer an auditable recovery path if a recipient loses their capability bundle.

### Self-Hosted Presses

A docker-compose reference stack enables self-hosted press deployment. Self-hosted presses give power users and organizations full key custody and full control over policy compliance without third-party dependency.

### Consequences

- Trust in an issued card derives from trust in the policy, the authorizing chain, and the press sub-card authorization — not from trusting the press operator's intentions.
- The press operator can withhold issuance (refuse to sign offers) but cannot forge cards — user-sovereign key custody prevents this.
- Key portability across presses requires the recipient to hold their own keys from inception — which this model guarantees.

---

## ADR-006: Privacy Model — Client-Side, Private by Default

**Status:** Accepted

### Context

The registry contract must support a range of privacy postures, from fully public credentials to credentials that are invisible to anyone without a capability bundle.

### Decision

Privacy is entirely **client-side**. The registry contract is neutral. At creation time, the client chooses from three modes:

| Mode | Registry address derivation | CID on-chain | IPFS content |
|---|---|---|---|
| **Fully public** | `pubkey-derived` | Plaintext | Plaintext |
| **Selectively shared** | `keccak256(sign(private_key, "card-address-v1"))` | Encrypted | Plaintext |
| **Fully private** | `keccak256(sign(private_key, "card-address-v1"))` | Encrypted | Encrypted |

**Two keys per private card:**

- **Address secret** — derives the registry address. Never shared. Controls who can locate the account on-chain.
- **Decryption key** — decrypts the on-chain CID. Shareable independently. Controls who can read the log head.

**Capability bundle:** to share a private card, the owner provides the recipient with an `(address, decryption_key)` pair. The decryption key can be ECDH-wrapped to the recipient's public key, tying it to their identity and preventing trivial forwarding.

**What an observer always sees:** that transactions are happening to the registry contract, when they occurred, and the fee payer (the press wallet). They cannot correlate transactions to identities, content, or each other without the address secret.

### Key Separation for Policy Authorizers

The policy control key and the audit log encryption key are **separate keypairs**. A compromised audit key must not grant policy control, and vice versa.

---

## ADR-007: Transport Layer — HTTPS

**Status:** Accepted

### Context

The protocol needs a reliable communication channel for message delivery between wallet services and from presses to wallet services. Wallet services must be able to route messages to the correct destination using a card's hash as its address, without a centralized lookup at send time.

### Decision

Use **HTTPS** for all wallet-service-to-wallet-service and press-to-wallet-service communication. Each registered wallet service exposes a stable HTTPS endpoint. Messages are delivered as **routing envelopes** — a thin outer layer carrying only the recipient card hash and an E2E-encrypted payload. End-to-end encryption (ML-KEM + ML-DSA-44) ensures wallet services cannot read message content; sender identity is inside the encrypted payload and never visible to the routing layer.

OHTTP (Oblivious HTTP, RFC 9458) and the Nym mixnet are optional transport upgrades selectable per wallet service via `transport_flags` in the wallet service registry. They are not required for protocol conformance but provide stronger metadata privacy at the cost of latency. See `process_specs/message_routing.md §Transport Extensibility`.

### Routing

A card's **on-chain registry address** (its mutable pointer hash) is also its **messaging address**. Wallet services maintain a local routing table — `{ card_hash → wallet_service_id }` — derived from on-chain card registration and migration events. Routing a message requires only a local table lookup followed by a single HTTPS POST; no external directory query is needed at send time.

See `process_specs/message_routing.md` for the full routing flow, routing envelope format, migration handling, and transport capability flags.

### Message Server

A **message server** (wallet service operator's own infrastructure) accepts inbound routing envelopes and queues them for offline devices:

1. Accepts HTTPS POST requests at the wallet service's registered endpoint.
2. Holds **proxy re-encryption keys** (UMBRAL) for each active sub-card, generated at sub-card creation.
3. Transforms inbound ciphertexts (encrypted to master card public key) into per-device sub-card ciphertexts — without seeing plaintext.
4. Queues re-encrypted ciphertexts in a per-sub-card queue for device pickup.
5. Authenticates devices via sub-card signature challenge before delivering queued messages.

The message server observes: the recipient card hash (from the routing header) and the originating wallet service. It does not observe sender card identity or message content. Operators who wish to reduce metadata exposure can enable OHTTP or Nym transport in their wallet service registry entry.

---

## ADR-008: Annotation Layer — EAS on Arbitrum One

**Status:** Accepted

### Context

Third-party annotations — statements by parties outside the issuance chain about a card — are a core reputation mechanism. They must be published publicly, be signed by the annotator's card, and be filterable by trust.

### Decision

Use **Ethereum Attestation Service (EAS)** on Arbitrum One as the on-chain registry for annotation references. Annotation content is stored on IPFS; EAS holds the pointer and the annotator's signature.

### Why EAS

- EAS is natively deployed on Arbitrum One, requiring no separate infrastructure.
- The EAS schema registry enables typed annotations with standardized fields.
- Annotations are filterable by the signing card's chain — "show me only annotations from cards I trust" — using the same chain-walk logic as all other verification.

### Annotation vs. Issuer Updates

Third-party annotations are distinct from issuer updates appended to a card's own log:

| | Card log update | EAS annotation |
|---|---|---|
| Author | Authorized party (per `update_policy`) | Any card holder |
| Location | Card's append-only log on IPFS | EAS registry on Arbitrum One |
| Authoritative? | Yes — part of card's canonical history | No — contextual; trust-weighted |
| Filterable? | No — always visible | Yes — filtered by annotator chain |

---

## ADR-009: Key Management — Two-Tier with YubiKey Recovery

**Status:** Accepted

### Context

A holder's private keys are the root of their identity. Loss means permanent loss of access. Keys that are too easy to recover are vulnerable to theft. The system must support practical recovery independent of any single service.

### Decision

**Two-tier key arcardecture:**

- **Master card key** — high-stakes key for creating sub-cards and key rotations. Stored in an **encrypted keyring blob on IPFS**, encrypted with a key derived from `passkey + service_secret`. Neither the passkey nor the service secret alone can decrypt it.
- **Sub-card keys** — day-to-day signing keys, one per device. Stored in **secure device storage** (Secure Enclave on Apple, TPM on others). All routine signing operations use sub-card keys; the master key is cold.

**The keyring blob** is append-only: new keys are added; old keys are never removed from the blob, preserving recoverability after device loss.

**YubiKey backup and recovery:**

1. The holder registers with a backup service, presenting their YubiKey.
2. The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The service never sees the decryption key in plaintext.
3. On recovery: holder presents YubiKey → backup service issues a 72-hour cancellation window with multi-channel notifications → if no cancellation, releases the wrapped decryption key blob → YubiKey unwraps locally (PIN required) → holder decrypts keyring from IPFS and re-registers.

A stolen YubiKey cannot complete recovery if a valid cancellation is submitted before the 72-hour window closes.

### Consequences

- Recovery is fully independent of the primary service — only the IPFS keyring blob and the YubiKey are required.
- The YubiKey is a second factor and a recovery path, not an authentication factor for routine operations.
- Social recovery (guardian quorum M-of-N) is explicitly deferred to a future version.
- Seed-phrase key management is explicitly not supported as a first-class option.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Arbitrum One                                  │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐ │
│  │   Card Registry Contract    │  │  EAS (Annotation Registry)   │ │
│  │  (Stylus / secp256r1 verify) │  │  (third-party attestations)  │ │
│  │  - card hash → log head CID │  └──────────────────────────────┘ │
│  │  - wallet service registry  │                                    │
│  │  - press authorizations     │                                    │
│  └──────────────┬──────────────┘                                    │
└─────────────────┼───────────────────────────────────────────────────┘
                  │ card hash (mutable pointer) → current log head CID
                  │ card registration events → wallet service routing tables
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                            IPFS                                      │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────────┐ │
│  │ Card logs  │  │ Policy cards  │  │ Keyring blobs / Annotation│ │
│  │ (CID chain) │  │ (content addr) │  │ content                   │ │
│  └─────────────┘  └────────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐  ┌──────────────────────────────┐
│          Card Press             │  │   Wallet Service (message    │
│  - Policy compliance check       │  │   server + routing)          │
│  - Signs offers (press sub-card)│  │  - HTTPS endpoint             │
│  - Posts to IPFS + Arbitrum      │  │  - Local routing table       │
│  - Logs issuance (encrypted)     │  │    { card_hash → wallet_svc }│
│  - Routes SCIP to holder via     │  │  - UMBRAL proxy re-encryption│
│    wallet service routing        │  │  - Per-device message queue  │
└──────────────────────────────────┘  └───────────────┬──────────────┘
                                                       │
                              HTTPS routing envelopes  │
                        { to: card_hash, payload: E2E }│
                          (optional: OHTTP / Nym)      │
                                                       │
┌──────────────────────────────────────────────────────▼──────────────┐
│                          Client (Holder)                              │
│  - Keyring (encrypted, IPFS-backed)                                  │
│  - Sub-card keys in Secure Enclave / TPM                            │
│  - Derives registry address locally (private mode)                   │
│  - Countersigns card offers                                         │
│  - Verifies chain before displaying any offer or message             │
│  - Decrypts inbound routing envelope payloads                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Data Flows

### 1. Card Issuance (First-Time Recipient)

```
Administrator / Requester
  → submits issuance request to press

Press
  → resolves requester + recipient chains, evaluates predicates
  → checks revocation entries on all chain links
  → assembles proposed card JSON (recipient_pubkey empty)
  → signs with press sub-card key → signed offer
  → encodes as card://invite?o=<base64>

Recipient
  → opens invitation link
  → client verifies press sub-card chain before showing offer
  → [keychain setup if first time]
  → reviews offer (issuer identity, field values, policy)
  → generates fresh ML-DSA-44 keypair
  → adds public key to card JSON
  → countersigns canonical serialization

Completed card (both signatures)
  → posted to IPFS → CID returned

Press
  → creates registry entry on Arbitrum One (initial log head CID)
    signed by press sub-card key
  → constructs issuance log entry, encrypted to each auditor via ML-KEM
  → appends to policy card's IPFS log + updates policy card's registry pointer
  → produces Signed Card Inclusion Proof (SCIP)
  → sends SCIP + confirmation to recipient via HTTPS (to wallet service endpoint)
```

### 2. Chain Verification

```
Verifier receives signed message or card pointer
  → verify signature against canonical payload (no network call)
  → resolve signing sub-card's registry address on Arbitrum One
  → confirm sub-card appears in master card's active sub-card list
  → fetch chain CIDs from IPFS (parallelized via cached chain array)
    for each link: verify issuer signature, check scope attenuation
  → resolve all mutable pointers in chain on Arbitrum One (parallelized)
    for each link: read log for revocation entries, apply code semantics:
      7xx — before effective_date: valid; after: new issuances rejected
      8xx — before effective_date: trusted; after: suspect
      9xx — before effective_date: trusted; after: invalid
  → evaluate policy predicates if authentication context
  → (optional) query EAS for third-party annotations, filter by trusted roots

Return per-signature structured result:
  signature_valid / chain_reaches_trusted_root / revocation status /
  was_valid_at_signing_time / is_currently_valid / addressed_to_verifier
```

### 3. Card Update / Revocation

```
Authorized party (holder or press, per field's update_policy)
  → assembles log entry: version, entry_type, prev_log_root, changes
  → signs with sub-card key satisfying the relevant update_policy predicate
  → posts entry to IPFS → new log head CID
  → press (or paymaster) updates Arbitrum One registry entry → new head pointer

Verifiers
  → see new head pointer on-chain
  → fetch new log entry from IPFS
  → verify authorization against policy's field_definitions / revocation_permissions
```

### 4. Card Authentication (Site Requesting a Signed Statement)

```
Requesting site
  → creates authentication request object:
      session_id, purpose, requester_card (mutable pointer),
      payload (content + nonce), required_predicate, callbacks.https,
      optional callbacks.ohttp
  → signs request with requester's card key (request_signature)
  → hosts request object at a single-use HTTPS URL
  → calls CHAPI with the request URL (not the payload)

CHAPI mediator
  → receives request URL (does not see payload content)
  → opens user's registered wallet service credential handler
  → wallet service URL not exposed to requesting site

Wallet service
  → fetches request object via HTTPS from single-use URL
  → verifies request_signature against requester's card public key
  → walks requester's card chain to trusted root, checks revocation (per §7)
  → evaluates required_predicate against user's available cards
  → presents to user: requester's verified chain identity, purpose,
      payload content, required predicate summary
  → [user approves or declines]

On approval:
  → wallet selects qualifying card (or user chooses from chooser)
  → generates signed message envelope (§6) with type "auth_response", content.nonce echoed from request
  → sends authentication response to requester:
      preferred: OHTTP → callbacks.ohttp (IP privacy, lower latency)
      fallback:  HTTPS → callbacks.https (always available)

Requesting site
  → receives authentication response via OHTTP / HTTPS
  → runs full §7 verification: chain walk, revocation, predicate, nonce match
  → on success: generates single-use confirmation_code, returns it in response

Wallet service
  → receives confirmation_code
  → redirects user's browser to redirect_uri?code={confirmation_code}

Requesting site page
  → receives code from URL, looks up associated verified signed statement
  → session is now authenticated
```

---

## Open Questions

These are engineering and design questions from the spec that have not yet been resolved.

| ID | Area | Question | Priority |
|---|---|---|---|
| ~~OQ-1~~ | ~~Engineering~~ | ~~Canonical serialization format~~ — **CLOSED.** RFC 8785 (JCS) canonical JSON. Lexicographic key sort, standard JSON escaping, no whitespace, UTF-8 output. No schema-aware overrides — all field values (binary, timestamps) serialized as plain JSON strings. Normative rules in spec Appendix A; conformance corpus at `specs/serialization-conformance.json`. See ADR-010. | ~~Critical / Blocking~~ |
| ~~OQ-2~~ | ~~Engineering~~ | ~~ML-DSA-44 Stylus gas cost~~ — **CLOSED.** On-chain writes now use secp256r1 via RIP-7212 precompile (~3,450 gas per verification, 64-byte pubkey + 64-byte sig calldata). ML-DSA-44 Stylus verification is deferred to the Phase 2 on-chain upgrade path (ADR-012); Stylus is retained in the contract for that purpose. | ~~Critical / Blocking~~ |
| OQ-3 | Engineering | Minimum IPFS replication count for a policy card's log before the Arbitrum One registry pointer update is considered safe. | High |
| OQ-4 | Engineering | For recipient-initiated registry writes (e.g., self-revocations): always mediated by press, or direct writes from holder via paymaster? | High |
| OQ-5 | Engineering | Field definition changes to a running policy (adding a new field): are previously-issued cards that lack the field non-conforming or still valid? | High |
| OQ-6 | Engineering | How does the client efficiently detect new log entries since its last check — polling Arbitrum One registry pointer, or push notification via HTTPS webhook? | Medium |
| OQ-7 | Engineering | Fetch budget and caching strategy for chain and annotation lookups on mobile clients with limited connectivity. | Medium |
| OQ-8 | Engineering | When the cached chain array's version CIDs differ from a link's current state (because an ancestor was updated post-issuance), how should verifiers resolve the discrepancy? | Medium |
| OQ-9 | Design | Trusted root configuration UX: how are trusted roots configured by the user and synced across devices? Design work should begin in parallel with protocol engineering. | High |
| OQ-10 | Design | Recovery UX when the holder has both a lost primary service and a lost YubiKey. Out of scope for v1? | Medium |
| OQ-11 | Design | What is the UX when a recipient declines an offer? Should a decline notification be sent to the press? | Low |
| OQ-12 | Engineering | Is a transparency log of approved press implementations operated by the protocol foundation needed? Relevant if TEE attestation is added in P2. | Low (P2 dependency) |
| OQ-13 | Design | Should wallet services publish a `/.well-known/card-wallet.json` manifest advertising their supported transports (HTTPS, OHTTP gateway)? If yes, requesting sites can construct the correct `callbacks` block without trial-and-error; if no, sites advertise all transports they support and wallets pick. | Medium |
| OQ-14 | Governance | **Coercion resistance / governance key holder identity.** Should governance body key holders be pseudonymous (organizations or anonymous participants, harder to coerce) or identifiable (named individuals/organizations with public accountability, easier to hold accountable but more coercible)? Deferred pending governance charter design. See also red-team Finding 1.4-B (press legal compulsion). | Medium |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Arbitrum One outage / unavailability** | Low | High | Registry reads are cacheable; short-term unavailability doesn't break existing card verification (cached chain arrays). Write operations (issuance, revocation) are queued and retried. |
| **IPFS content not pinned / unavailable** | Medium | High | Presses are contractually responsible for pinning. Filecoin archival (web3.storage/w3up) provides long-term backup. Clients cache recently-fetched CIDs locally. |
| ~~**ML-DSA-44 Stylus verification too expensive on-chain**~~ | ~~Medium~~ | ~~High~~ | **CLOSED by ADR-012.** On-chain writes use secp256r1 via RIP-7212 precompile instead. ML-DSA-44 on-chain verification is deferred to the upgrade path, with Stylus retained for that purpose. |
| ~~**Canonical serialization incompatibility**~~ | ~~Medium~~ | ~~High~~ | **CLOSED.** RFC 8785 (JCS) adopted per ADR-010. |
| **Press authorization enforcement gap** | ~~High~~ Closed | ~~High~~ | **Closed by ADR-011.** The original design relied on the contract checking the IPFS-stored `approved_presses` field, which is unreachable at write time. ADR-011 replaces this with two on-chain tables (`PolicyAuthorizerKeys`, `PressAuthorizations`) that the Stylus contract can verify directly. |
| **Unauthorized press/policy registration (spam)** | Low | Medium | `RegisterPolicy` and `AuthorizePress` both require governance quorum signatures. No party can unilaterally create root policies or register presses. |
| **Press key compromise** | Low | Medium | Revoking the press entry via `RevokePress` (governance quorum required) removes its write authority. Previously-issued cards are unaffected. The press cannot forge user signatures (user-sovereign key custody). |
| **YubiKey stolen before 72-hour cancellation window** | Low | Medium | Multi-channel notifications give holder 72 hours to cancel. After recovery, old YubiKey should be treated as potentially compromised; holder should rotate backup registration. |
| **OrbitDB legacy references causing confusion** | Medium | Low | Some early raw notes reference OrbitDB. This arcardecture supersedes those notes. OrbitDB is **not** part of the trust model; the linked-CID-chain + on-chain anchoring pattern is authoritative. |
| **Post-quantum transition risk for Ed25519 legacy tooling** | Low | Medium | ML-DSA-44 is FIPS 204 standardized. YubiKey hardware support is emerging. Where necessary, hybrid signatures (Ed25519 + ML-DSA) can be used during transition. |

---

---

## ADR-010: Canonical Serialization — RFC 8785 vs. CBOR

**Status:** Accepted — RFC 8785 adopted  
**Date:** 2026-05-19 (revised 2026-06-14)  
**Closes:** OQ-1

### Decision

**RFC 8785 (JSON Canonicalization Scheme — JCS)** is adopted as the canonical serialization format for all signed and hashed payloads in the Card Protocol.

CBOR was previously adopted (2026-05-19) for its compact binary encoding. That decision was reversed because the protocol's issuance model — one press creating a card, with updates rare — means CBOR's calldata savings are modest while its readability and implementation costs are ongoing. The overhead of an extra encoding/decoding step and the loss of human-readable payloads (critical for debugging signature failures and for independent verifier adoption) were not justified by storage savings on IPFS (cheap and not the bottleneck) or marginal calldata reductions.

### Background

Every signature in the protocol commits to a **canonical serialization** of a payload — deterministic bytes that every implementation (press, client, verifier, Stylus contract) must reproduce identically. A one-byte difference means a failed verification.

Payloads signed in the protocol:

| Payload | Signed by | Verified by |
|---|---|---|
| **Card offer** | Press (sub-card key) | Recipient client, any verifier |
| **Completed card** | Recipient (new keypair) | Any verifier; on-chain registry contract |
| **Log entry** (update, revocation) | Authorized updater | Any verifier |
| **Message envelope payload** | Sender (sub-card key) | Recipient client, any verifier |
| **Auth request / response** | Requester card; then holder | Service server |

### RFC 8785 Rules

- Object keys sorted by Unicode code-point order (JavaScript `Array.prototype.sort()` string sort) at all nesting levels.
- No whitespace between tokens.
- Numbers per ECMAScript `Number.prototype.toString()` (integers as plain integers; `1` not `1.0`).
- Strings per JSON escaping rules (RFC 8259 §7); control chars and `"`, `\` escaped; non-ASCII emitted as-is.
- Output encoded as UTF-8.

All field values — including binary fields (base64url strings) and timestamp fields (ISO 8601 strings) — are serialized as plain JSON strings. No schema-aware type coercion.

### Constraints

- **Integer values** must be within the IEEE 754 safe integer range (−2⁵³+1 to 2⁵³−1); validated at field creation.
- **Binary data** (keys, signatures, CIDs) must use unpadded base64url (RFC 4648 §5). Standard `btoa()` produces padded standard base64 — incorrect.
- **Absent optional fields** must be omitted from the serialized object entirely; `null` produces different bytes than omission.
- **Key ordering applies at all nesting levels.** Implementations that assemble JSON strings manually will get nested objects wrong.

### Action Items

- [x] Update spec Appendix A to describe RFC 8785 rules. Close OQ-1.
- [x] Update conformance test corpus: `specs/serialization-conformance.json` — 22 cases with expected RFC 8785 canonical JSON strings.
- [x] Implement `card-validator/src/serialization.ts`: `canonicalize()` using RFC 8785 JCS (~30 lines, no library dependency).
- [ ] Validate Stylus WASM RFC 8785 implementation against the full conformance test corpus before contract deployment.

---

## ADR-011: On-Chain Press Authorization and Protocol Governance

**Status:** Accepted  
**Date:** 2026-05-22  
**Addresses:** Red-team Finding 1.1-A (approved_presses enforcement gap)  
**Amends:** ADR-001 (registry contract write-gate logic), ADR-005 (press authorization structure)

### Context

Red-team analysis identified that the contract description in earlier versions of this document — "writes are rejected unless signed by a press sub-card key listed in `approved_presses`" — was unimplementable as written. The Stylus contract verifies on-chain state at write time; it cannot fetch or verify the IPFS-stored `approved_presses` array in the policy card's content. This created an unenforced authorization boundary: any party holding a valid ML-DSA-44 keypair could write to the registry against any policy without the contract having a way to reject them.

Separately, the question of who can register a new root policy and who can authorize presses was left implicit. Without access controls on these entry points, the registry is open to spam policy creation and unauthorized press registration.

### Decision

Add two on-chain tables to the Arbitrum One registry contract, with three new write operations governed by two distinct governance bodies.

### On-Chain Tables

**`PolicyAuthorizerKeys`**

Maps each registered root policy address to the secp256r1 public key whose signatures are recognized as authoritative for press management under that policy.

```
PolicyAuthorizerKeys:
  policyAddress (bytes32)  →  authorizerPublicKey (bytes[64], secp256r1 uncompressed x||y)
```

A policy address is the on-chain identifier for the policy — the Arbitrum One address associated with the policy card's registry entry. An entry in `PolicyAuthorizerKeys` is what makes a policy address a recognized root policy in the contract's view. The entry is created by `RegisterPolicy`.

**`PressAuthorizations`**

Maps (policyAddress, pressAddress) pairs to the press's active on-chain signing key and authorization status. The stored key is the press's **secp256r1 key** (used for on-chain write authorization); the press's ML-DSA-44 key (used for IPFS content signing) is on the press `CardDocument` in IPFS and is not stored here.

```
PressAuthorizations:
  (policyAddress (bytes32), pressAddress (bytes32))
    →  pressPublicKey    (bytes[64], secp256r1 uncompressed x||y)
       mldsa44KeyHash    (bytes32, keccak256 of ML-DSA-44 pubkey — for upgrade path)
       active            (bool)
```

The registry contract's write-gate check: for any registry write signed by `pressAddress` under `policyAddress`, look up this table. Accept the write if and only if an entry exists, `active == true`, and the secp256r1 signature verifies against the stored `pressPublicKey` via RIP-7212. The `mldsa44KeyHash` field is registered at `AuthorizePress` time and is used during the Phase 2 on-chain key upgrade (see ADR-012); it is not verified on writes in Phase 1.

### Write Operations

**`RegisterPolicy(policyAddress, authorizerPublicKey)`**

Creates a new entry in `PolicyAuthorizerKeys`. `authorizerPublicKey` is a secp256r1 public key (64 bytes). Callable only with a valid quorum signature from the **Root Policy Governance Body** (see Governance below). Once registered, `policyAddress` is a recognized root in the contract, and its `authorizerPublicKey` is the key that authorizes presses.

**`AuthorizePress(policyAddress, pressAddress, pressPublicKey, mldsa44KeyHash)`**

Creates or updates an entry in `PressAuthorizations`, setting `active = true`, recording the secp256r1 `pressPublicKey` (64 bytes), and recording `mldsa44KeyHash` (keccak256 of the press's ML-DSA-44 public key, used for the upgrade path). Callable only with a valid quorum signature from the **Press Registry Governance Body** (see Governance below). The `policyAddress` must already be registered in `PolicyAuthorizerKeys`; attempts to authorize a press against an unregistered policy are rejected.

**`RevokePress(policyAddress, pressAddress)`**

Sets `active = false` for the given (policyAddress, pressAddress) pair. Callable only with a valid quorum signature from the Press Registry Governance Body. The entry is retained with `active = false` rather than deleted, preserving the on-chain audit trail for prior press authorizations.

### Key Rotation

**Press key rotation.** When a press needs to rotate its secp256r1 on-chain key, the Press Registry Governance Body calls `AuthorizePress` with the same `pressAddress` and the new `pressPublicKey`. This overwrites the stored key and resets `active = true`. The press's prior signatures remain verifiable against the old key (which verifiers may cache); the contract will accept new writes only from the new key. For upgrade to ML-DSA-44 on-chain keys, see ADR-012.

**Authorizer key rotation.** When the authorizer key for a policy needs to change — due to key compromise, governance body change, or periodic rotation — the Root Policy Governance Body calls a `RotateAuthorizerKey(policyAddress, newAuthorizerPublicKey)` operation, signed by the current authorizer key plus governance quorum. The `PolicyAuthorizerKeys` entry is updated in place.

**Governance key rotation.** Each governance body manages its own key rotation through its defined quorum process. The contract encodes the current active governance key set for each body; quorum rotation requires a supermajority of the current key set to sign the rotation.

### Integration with IPFS `approved_presses`

The policy card's IPFS content includes an `approved_presses` array listing the mutable pointers of authorized press sub-cards. This field is retained as an **audit surface**: tooling (press operators, policy administrators, monitoring agents) should keep it in sync with the on-chain `PressAuthorizations` table. However:

- **On-chain state is authoritative** for contract enforcement. A press listed in `approved_presses` but absent from `PressAuthorizations` cannot write to the registry. A press in `PressAuthorizations` with `active = false` cannot write even if it still appears in `approved_presses`.
- **Discrepancies between IPFS and on-chain state are a monitoring signal**, not a protocol error. They indicate that tooling has failed to sync the IPFS content after an on-chain authorization change.
- The press service's reference implementation should update `approved_presses` as part of its `AuthorizePress` and `RevokePress` workflows, immediately after the on-chain transaction confirms.

### Governance

The protocol's governance model separates two functions with different operational cadences and risk profiles into two distinct governing bodies.

**Root Policy Governance Body**

Controls root policy creation via `RegisterPolicy`. This is an infrequent, high-stakes operation: creating a new root policy establishes a new trust anchor for all cards that derive from it. The Root Policy Governance Body's remit is narrow:

- Evaluate whether proposed root policies meet the protocol's published ethics criteria.
- Register approved root policies via `RegisterPolicy`.
- Rotate authorizer keys for registered policies when warranted.

The quorum requirement for this body is set higher than for the Press Registry Governance Body, reflecting the higher impact of its decisions. Specific quorum thresholds are deferred to the governance specification.

**Press Registry Governance Body**

Controls press registration and revocation via `AuthorizePress` and `RevokePress`. Press authorization changes are more frequent than root policy creation — presses are added as new organizations adopt the protocol and revoked when they violate ethics requirements or cease operation. The Press Registry Governance Body's remit is narrow:

- Evaluate whether proposed presses meet the protocol's published ethics criteria.
- Authorize approved presses via `AuthorizePress`.
- Revoke presses that have violated the ethics criteria via `RevokePress`.

The quorum requirement for this body is set to reflect operational cadence while maintaining meaningful accountability. Specific quorum thresholds are deferred to the governance specification.

**Shared principles for both bodies**

Both bodies share a narrow, defined remit: ensuring that root policies and presses operate within the published ethics criteria. Neither body has authority over the content of policies, the terms of issuance, or the behavior of individual cards. Both bodies operate with published membership lists, quorum requirements, and decision logs. Both bodies are self-perpetuating or elected per a governance charter whose design is out of scope for the current protocol specification.

**Scope note.** The protocol's current risk analysis treats the governance bodies themselves as trusted. Attacks targeting the governance bodies — coercion of key holders, quorum subversion, capture of the membership composition process — are out of scope for Phase 1 red-teaming and are deferred to a later analysis phase.

### Open Questions

**OQ-14 (Coercion resistance / governance key holder identity).** Should governance body key holders be pseudonymous (keys held by organizations or anonymous participants) or identifiable (keys tied to named individuals or organizations with public accountability)? Pseudonymous holders are harder to coerce but harder to hold accountable if they misbehave. Identifiable holders provide accountability at the cost of coercibility. This is deferred pending governance charter design. See also the broader question of legal compulsion (press service Finding 1.4-B in the Phase 1 red-team report).

### Consequences

- The registry contract's write-gate is now fully on-chain and verifiable at write time. No IPFS fetch is required to enforce press authorization.
- Press authorization changes (add, revoke) require governance quorum, making unauthorized press registration significantly harder than in the open-registry model.
- Both governance bodies introduce a trusted third party in the authorization path. The protocol's decentralized properties hold for verification (chain walking, revocation checks) but not for policy/press registration, which is intentionally governed. This matches the design philosophy stated in the original spec: "give tools for communities with governance," not a trustless system.
- Key rotation paths (press keys, authorizer keys, governance keys) are defined at the table level but the operational workflows must be specified in the governance charter.
- Specific quorum thresholds, governance body composition rules, and membership processes are out of scope for this ADR and belong in a separate governance specification.

---

---

## ADR-012: On-Chain Signing — secp256r1 Now, ML-DSA-44 Upgrade Path

**Status:** Accepted  
**Date:** 2026-06-14  
**Closes:** OQ-2  
**Amends:** ADR-001 (verification mechanism), ADR-004 (crypto primitives), ADR-011 (on-chain table key types)

### Context

The original design used ML-DSA-44 for all signatures, including on-chain press write authorization. On-chain ML-DSA-44 verification via Stylus WASM is feasible but expensive: 2,420-byte signatures and 1,312-byte public keys add significant calldata, and Stylus WASM execution for a lattice-based signature is more costly than a native precompile. Arbitrum One natively supports **RIP-7212**, a precompile for secp256r1 (P-256) signature verification at ~3,450 gas per call with 64-byte public keys and 64-byte signatures — approximately 15–20× cheaper in calldata and substantially cheaper in compute.

The threat model analysis (see ADR-004) shows an asymmetry: IPFS content signatures require quantum resistance now (permanent, can't be re-signed); on-chain write authorization does not, because keys can be rotated before quantum attacks become viable.

### Decision

Use **secp256r1 / RIP-7212** for all on-chain write authorization (press writes, governance operations) in Phase 1. Build in the upgrade path to ML-DSA-44 on-chain verification from day one, so migration requires no re-registration of existing presses.

### On-Chain Key Scheme Upgrade Path

**What is built now (Phase 1):**

- Press cards carry two public keys: a secp256r1 key registered on-chain for write authorization, and an ML-DSA-44 key (the press `CardDocument`'s `recipient_pubkey`) for IPFS content signing.
- `AuthorizePress` stores both: the secp256r1 public key (64 bytes) and the `keccak256` hash of the ML-DSA-44 public key (32 bytes). The hash costs only 32 bytes of calldata at registration time.
- Governance keys in `GovernanceKeysets` are secp256r1 (64 bytes per key).
- The registry contract is deployed in Stylus with a modular verifier architecture (see `registry_contract.md §6.3`): a separate upgradeable verifier module handles signature verification. The storage contract is immutable; only the verifier can be upgraded.
- Contract emits a `KeyScheme` field per press record (`secp256r1` initially).

**Phase 2 — Dual-accept window** (triggered by governance when quantum threat horizon is credibly 3–5 years out):

1. Governance upgrades the verifier module to accept either secp256r1 or ML-DSA-44 signatures for writes. The `KeyScheme` per press determines which is required.
2. Presses rotate on-chain auth by submitting a `RotateOnChainKeyScheme` transaction, dual-signed by both the current secp256r1 key and the new ML-DSA-44 key (proving possession of both, preventing hijack during migration).

Rotation payload:
```json
{
  "op":                "rotate_on_chain_key_scheme",
  "press_address":     "<bytes32>",
  "new_mldsa44_pubkey": "<base64url — 1312 bytes>",
  "nonce":             "<base64url>",
  "deadline_block":    <uint64>
}
```
Both `secp256r1_sig` (over the payload, from the current secp256r1 key) and `mldsa44_sig` (over the same payload, from the new ML-DSA-44 key) are required. The contract verifies both before updating `KeyScheme` to `mldsa44` and recording the full ML-DSA-44 public key.

The new ML-DSA-44 public key can be the press's existing content-signing key (whose hash is already registered in `PressAuthorizations.mldsa44KeyHash`) or a freshly generated one.

**Phase 3 — secp256r1 sunset:**

Governance sets a block deadline after which the verifier module rejects secp256r1 signatures for card writes. Secp256r1 is still accepted *only* for `RotateOnChainKeyScheme` transactions during a grace period, so any press that has not yet migrated can still rotate rather than being permanently write-locked.

### Governance key upgrade

Governance keys in `GovernanceKeysets` follow the same three-phase path via `RotateGovernanceKeys`. The only difference is that governance key rotation is self-authorized (existing quorum must sign the rotation), so no external coordination is required.

### Consequences

- Per-write gas cost drops from an estimated ~$0.15–0.25 (ML-DSA-44 calldata + Stylus WASM) to ~$0.05–0.10 (secp256r1 calldata + RIP-7212 precompile).
- IPFS content signatures remain ML-DSA-44 throughout — no change to card document structure, log entry structure, or client-side verification.
- The split model introduces two key types per press, which must be tracked in press operator key management tooling.
- Migration in Phase 2 is self-service per press (no re-registration, no new press card issuance) — presses rotate their own on-chain key using the dual-sign flow.

---

*This document synthesizes `card_protocol_spec.md` (v0.3, 2026-05-19) and supporting raw notes. Where the spec and earlier notes conflict (e.g., Solana vs. Arbitrum One as the registry substrate), the spec is authoritative.*
