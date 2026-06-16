# Card Protocol — Architecture Decision Record

**Version:** 1.1  
**Date:** 2026-06-14  
**Status:** Current  
**Source:** Synthesized from `card_protocol_spec.md` (v0.3) and supporting raw notes. v1.1 adds ADR-012 (secp256r1 for on-chain verification; ML-DSA-44 retained for IPFS content signing) and closes OQ-2.  

---

## Table of Contents

1. [System Overview](#system-overview)
2. [ADR-001: Registry Substrate — Arbitrum One](#adr-001-registry-substrate--arbitrum-one)
3. [ADR-002: Off-Chain Content Storage — IPFS](#adr-002-off-chain-content-storage--ipfs)
4. [ADR-003: Append-Only Log Architecture](#adr-003-append-only-log-architecture)
5. [ADR-004: Cryptographic Primitives — ML-DSA-44 and ML-KEM](#adr-004-cryptographic-primitives--ml-dsa-44-and-ml-kem)
6. [ADR-005: Press Model and Key Custody](#adr-005-press-model-and-key-custody)
7. [ADR-006: Address Model — Single Public Derivation](#adr-006-address-model--single-public-derivation)
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

## ADR-003: Append-Only Log Architecture

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
    "public_key": "<ML-DSA-44 public key — base64url>",
    "signature": "<sig over canonical RFC 8785 JSON of UpdateIntentPayload — base64url>"
  },
  "press_signature": {
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

**Key custody is user-sovereign.** The press holds neither the holder's nor the offerer's signing key.

The issuance flow is a **three-party signing pattern**, signed in a fixed order:

1. The **offerer** (issuer) constructs the offer (the proposed card JSON without the recipient's public key) and signs it with the **offerer's own card key** → `issuer_signature`.
2. The **recipient** independently generates their own ML-DSA-44 keypair, adds their public key, and **countersigns** → `holder_signature`. The offerer validates the countersigned result.
3. The **press** validates policy compliance and signs the completed, countersigned card with its **press sub-card key** → `press_signature`, then registers it on-chain. The press signature is applied last.

All three signatures are present in every completed targeted card: `issuer_signature` attests the offerer authored the offer, `holder_signature` is the recipient's assertion of identity and acceptance, and `press_signature` is the press's statement of policy adherence. The press's content-signing key is the ML-DSA-44 key of its **press sub-card**; the offerer's key is a separate key the press never holds.

### Press Authorization Structure

```
Policy card (held by administrator/authorizer)
  └── Press sub-card (held by press operator)
       └── Issued cards (held by recipients)
```

The Arbitrum One registry contract enforces press authorization via two on-chain tables defined in ADR-011: `PolicyAuthorizerKeys` (mapping each policy to its governance-assigned authorizer key) and `PressAuthorizations` (mapping (policyAddress, pressAddress) pairs to the press's active public key). A registry write is accepted only if it is signed by a key that appears in `PressAuthorizations` for the target policy and is marked active. Revoking a press removes its write authority; previously-issued cards are unaffected.

> **Amendment note (ADR-011):** Earlier versions of this document stated that the registry contract enforces authorization by checking whether a press sub-card pointer appears in the IPFS-stored `approved_presses` field of the policy card. That mechanism was under-specified: the Stylus contract cannot fetch or verify IPFS content at write time. ADR-011 replaces it with the on-chain tables described above. The `approved_presses` field in the policy card's IPFS content is retained as an audit surface that tooling should keep in sync with on-chain state; in the event of a discrepancy, on-chain state is authoritative.

### Privacy Properties of the Press

The press's observable role is constrained by the audit-encryption model and by card-content encryption (ADR-006):

- **The press records each issuance in its press log**, encrypted under the audit epoch AEK (ADR-003) so only auditors — not the press operator — can read the issuance history.
- **On-chain CIDs are public; card content is encrypted.** The press posts the plaintext CID to the registry, but the IPFS content at that CID is encrypted with AES-256-GCM under a content key derived from the card's public key (ADR-006). Anyone holding the card's public key can derive the content key and decrypt the document; the content is opaque ciphertext to anyone without it.

### Self-Hosted Presses

A docker-compose reference stack enables self-hosted press deployment. Self-hosted presses give power users and organizations full key custody and full control over policy compliance without third-party dependency.

### Consequences

- Trust in an issued card derives from trust in the policy, the authorizing chain, and the press sub-card authorization — not from trusting the press operator's intentions.
- The press operator can withhold issuance (refuse to sign offers) but cannot forge cards — user-sovereign key custody prevents this.
- Key portability across presses requires the recipient to hold their own keys from inception — which this model guarantees.

---

## ADR-006: Address Model — Single Public Derivation

**Status:** Accepted (revised 2026-06-15 — private/selectively-shared card postures removed)

### Context

Earlier versions supported three privacy postures (fully public, selectively shared, fully private) with a secret-derived registry address, encrypted on-chain CIDs, a per-card content-decryption key, and capability bundles. This added significant complexity (two keys per card, capability-grant delivery and revocation, address-secret custody) for a confidentiality property that the protocol does not require: a credential is meant to be presentable and verifiable, and message-level confidentiality is already provided by end-to-end message encryption (ADR-007).

### Decision

A card's registry address is **always** derived from its public key:

```
address = keccak256(recipient_pubkey)
```

The on-chain CID is stored in **plaintext**. IPFS card content is **encrypted** — but only for the **registered** card document that the press posts after the recipient countersigns. The content-encryption scheme requires a `recipient_pubkey`, which exists only once the holder has countersigned and the card is complete.

**Content encryption scheme (registered card only):**

```
content_key  = HKDF-SHA3-256(ikm=recipient_pubkey, info="card-content-v1")
ipfs_payload = { "nonce": <96-bit random, base64url>,
                 "ciphertext": AES-256-GCM.Encrypt(content_key, card_document_bytes, nonce) }
```

A fresh nonce is generated for each IPFS write (each new log entry). The nonce is stored alongside the ciphertext in the IPFS payload object; the content key itself is never stored. There is no address secret, no separate capability bundle, and no per-card decryption key distinct from the public key.

**Offer-phase exemption.** An offer-phase `CardDocument` (the proposed card before the recipient has countersigned, without `recipient_pubkey`, `holder_signature`, or `press_signature`) has no `recipient_pubkey` yet, so the ADR-006 content key is undefined for it. Offer-phase documents are **not** content-encrypted under this scheme. They are conveyed to the prospective recipient either in the clear within the delivery payload (e.g. the `mcard://invite` URL for open offers) or protected only by the **transport / E2E message encryption** used to deliver the `card_offer` message (ML-KEM per ADR-007). ADR-006 content encryption begins only when the press posts the completed, registered card — the document that now has `recipient_pubkey`, `holder_signature`, and `press_signature` all present.

| Mode | Registry address derivation | CID on-chain | IPFS content |
|---|---|---|---|
| **Single mode (registered card)** | `keccak256(recipient_pubkey)` | Plaintext | AES-256-GCM, key = `HKDF-SHA3-256(recipient_pubkey)` |
| **Offer phase** | N/A — card not yet registered | N/A | Not content-encrypted; delivered in clear or via E2E transport (ADR-007) |

**What an observer sees without the public key:** registry transactions, when they occurred, the fee payer (the press wallet), and the on-chain address (a one-way hash of the public key). Registered card content on IPFS is opaque ciphertext. **With the public key:** the address is derivable, the content key is derivable, and the full registered card document is readable. Confidentiality between parties (messaging) is provided at the transport layer (ML-KEM, ADR-007) independently of this model.

### Ancestor Key Hint — `ancestry_pubkeys`

Because card content is encrypted under a key derived from the card's own public key, and because ancestors are referenced only by their on-chain address (`keccak256(recipient_pubkey)` — a one-way hash), a third-party verifier walking the chain cannot independently derive any ancestor's public key from the address alone. To preserve the "verifiable by anyone" property, every card document carries an **`ancestry_pubkeys`** field: an ordered array of ML-DSA-44 public keys (1,312 bytes each, base64url), one per ancestor the verifier must traverse to reach a trusted root, ordered from immediate parent up toward the root.

**How a chain walker uses `ancestry_pubkeys`:** After decrypting the leaf card (using the signer's inline `public_key`), the verifier reads `ancestry_pubkeys` and, for each entry, (1) derives the expected on-chain address as `keccak256(entry_pubkey)` and confirms it matches the address being resolved; (2) derives the content key as `HKDF-SHA3-256(entry_pubkey, info="card-content-v1")` and decrypts the ancestor document; (3) verifies the ancestor's issuer signature using `entry_pubkey`. If the address check fails or decryption fails, the entry is rejected immediately — the array cannot be used to substitute a forged ancestor.

**Security property:** `ancestry_pubkeys` is an **untrusted hint**. A verifier MUST confirm `keccak256(entry_pubkey)` equals the on-chain address it is resolving (the pointer it walks to) before trusting the key. A wrong or forged pubkey either yields an address mismatch (caught by the binding check) or produces an AES-GCM authentication failure on the encrypted ciphertext (caught by decryption). Either failure is a hard rejection. Per-link on-chain addresses remain the authoritative source of truth; `ancestry_pubkeys` is a performance optimization that enables parallel fetching and decryption without additional round-trips.

**Signing coverage:** `ancestry_pubkeys` is a protocol-required immutable field set at issuance. It is present in the offer when the offerer signs (`issuer_signature`), present when the holder countersigns (`holder_signature`), and present when the press signs (`press_signature`). All three signatures commit to its contents.

**Policy cards:** Policy cards carry `ancestry_pubkeys` under the same convention (ordered from the immediate parent up toward root). A verifier walking the policy creation chain uses the same array and the same binding check. **Root base case and walk termination:** a self-rooted trusted-root policy card — one whose own on-chain address is registered in `PolicyAuthorizerKeys` — carries `ancestry_pubkeys: []`. The empty array `[]` is a legal, signed value; it is distinct from omission (the field is always present). The chain walk terminates successfully when the next address to resolve is registered in the on-chain `PolicyAuthorizerKeys` table; at that point `chain_reaches_trusted_root` is set to `true`. If `ancestry_pubkeys` is exhausted (or `[]`) and the terminal card's address is **not** in `PolicyAuthorizerKeys`, the chain does not reach a trusted root.

**Sub-card boundary — `holder_primary_card_pubkey` and `app_card_pubkey`:** Because almost all signed statements are produced by a **sub-card** (not a master card), verification enters at a sub-card whose parents are referenced only by their on-chain addresses (one-way keccak256 hashes). To unlock those parent cards and then continue via their `ancestry_pubkeys`, every `SubCardDocument` (see `protocol-objects.md §16`) carries two additional protocol-required fields: `holder_primary_card_pubkey` (ML-DSA-44 public key of the card referenced by `holder_primary_card`) and `app_card_pubkey` (ML-DSA-44 public key of the card referenced by `app_card`). These fields apply the same design as `ancestry_pubkeys` one level down — they are untrusted hints bound by a keccak256 check: the verifier MUST confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address (and likewise for `app_card_pubkey` / `app_card`) before deriving a content key or verifying a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Once the master and app cards are decrypted, their own `ancestry_pubkeys` fields carry the walk the rest of the way to the trusted root. Both fields are set at sub-card issuance and are covered by both `app_signature` and `holder_signature`.

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

Two distinct mappings are involved in the routing model; they must not be conflated:

1. **`card_hash → current log-head CID`** — resolving a card's mutable pointer to its current card document on IPFS. This mapping **is on-chain**: the registry contract stores `CardEntries[card_address].log_head_cid`, updated by the press on every `RegisterCard` or `UpdateCardHead` write. Any reader can resolve it with a single contract call; no wallet service is involved.

2. **`card_hash → wallet_service_id`** — identifying which wallet service currently holds a card, so a sender knows where to deliver an E2E-encrypted message. This mapping is **off-chain**: it is maintained in the Wallet Service Registry (off-chain) and replicated across wallet services via binding announcements. There is no `wallet_service_id` field in `RegisterCard` calldata and no on-chain migration event; routing state is populated and kept current entirely off-chain. The full design of the Wallet Service Registry and its binding-announcement protocol is deferred to the wallet service spec (per the INC-35 decision).

A card's **on-chain registry address** (its mutable pointer hash) is therefore also its stable **messaging address** — the same value used in both mappings. Routing a message requires only a local routing-table lookup followed by a single HTTPS POST; no external directory query is needed at send time.

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

**Two-tier key architecture:**

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
                  │ (on-chain only; wallet-service routing tables are off-chain)
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
│  - Derives registry address as keccak256(public_key)                 │
│  - Countersigns card offers                                         │
│  - Verifies chain before displaying any offer or message             │
│  - Decrypts inbound routing envelope payloads                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Data Flows

### 1. Card Issuance (First-Time Recipient)

```
Offerer (issuer) / their wallet service
  → assembles proposed card JSON (issuer_card, press_card; recipient_pubkey empty)
  → signs with offerer's own card key → issuer_signature (signed offer)
  → encodes as mcard://invite?o=<base64>

Recipient
  → opens invitation link
  → client verifies issuer_signature + offerer chain before showing offer
  → [keychain setup if first time]
  → reviews offer (offerer identity, field values, policy)
  → generates fresh ML-DSA-44 keypair
  → adds public key to card JSON
  → countersigns canonical serialization → holder_signature
  → returns countersigned card to offerer

Offerer
  → validates holder_signature → forwards to press

Press
  → validates predicates, revocation, schema, issuer_signature + holder_signature
  → signs completed card with press sub-card key → press_signature
  → posts to IPFS → CID returned
  → creates registry entry on Arbitrum One (initial log head CID)
    authorized by press secp256r1 key in PressAuthorizations
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
  → decrypt leaf sub-card using signer's public_key from SignatureEntry
      content_key = HKDF-SHA3-256(public_key, info="card-content-v1")
  → read holder_primary_card_pubkey and app_card_pubkey from decrypted SubCardDocument
      (sub-card boundary: these are untrusted hints for the immediate parent cards)
      confirm keccak256(holder_primary_card_pubkey) == holder_primary_card address
         (binding check — mismatch → hard reject)
      confirm keccak256(app_card_pubkey) == app_card address
         (binding check — mismatch → hard reject)
      derive content_key = HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")
         and decrypt master card (AES-GCM auth failure → hard reject)
      confirm sub-card appears in master card's active sub-card list
      verify master card holder's ML-DSA-44 signature on sub-card registration
      derive content_key = HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")
         and decrypt app card (AES-GCM auth failure → hard reject)
      walk app card's ancestry_pubkeys to confirm chain reaches governance root
  → read ancestry_pubkeys from decrypted master card (ordered, immediate parent first)
  → fetch chain CIDs from IPFS (parallelized via cached chain array + ancestry_pubkeys)
    for each ancestor link:
      1. confirm keccak256(ancestry_pubkeys[i]) == on-chain address being resolved
         (binding check — mismatch → reject immediately)
      2. derive content_key = HKDF-SHA3-256(ancestry_pubkeys[i], info="card-content-v1")
         and decrypt ancestor document (AES-GCM auth failure → reject)
      3. verify issuer ML-DSA-44 signature, check scope attenuation
      per-link on-chain addresses remain authoritative; ancestry_pubkeys is an untrusted hint
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
      requester_pubkey (ML-DSA-44 public key of the card referenced by requester_card),
      payload (content + nonce), required_predicate, callbacks.https,
      optional callbacks.ohttp
  → signs request with requester's card key (request_signature covers all fields
      including requester_pubkey)
  → hosts request object at a single-use HTTPS URL
  → calls CHAPI with the request URL (not the payload)

CHAPI mediator
  → receives request URL (does not see payload content)
  → opens user's registered wallet service credential handler
  → wallet service URL not exposed to requesting site

Wallet service
  → fetches request object via HTTPS from single-use URL
  → binding check: confirms keccak256(requester_pubkey) == requester_card address;
      a mismatch is a hard rejection before display
  → verifies request_signature against requester_pubkey
  → derives requester card content key: HKDF-SHA3-256(requester_pubkey, info="card-content-v1"),
      decrypts requester card; AES-GCM failure is a hard rejection before display
  → walks requester's card chain to trusted root via ancestry_pubkeys, checks revocation (per §7)
  → evaluates required_predicate against user's available cards
  → presents to user: requester's verified chain identity, purpose,
      payload content, required predicate summary
  → [user approves or declines]

On approval:
  → wallet selects qualifying card (or user chooses from chooser)
  → generates signed message envelope (§6) with type "auth_response",
      content: { statement, context: { session_id, ... }, nonce }
      (statement + nonce from request payload; session_id echoed from request into content.context)
  → sends authentication response to requester:
      preferred: OHTTP → callbacks.ohttp (IP privacy, lower latency)
      fallback:  HTTPS → callbacks.https (always available)

Requesting site
  → receives authentication response via OHTTP / HTTPS
  → runs full §7 verification: chain walk, revocation, predicate,
      content.context.session_id match, content.nonce match
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
| OQ-15 | Governance | **Chain amendment authority for harmful content.** A malicious press could attach a link to harmful content (e.g., NCII) to a widely-held badge, then let their reputation absorb the cost while leaving the badge holder exposed. Mitigation: allow a co-signed amendment to the CID chain — mark holder + governance body both sign — that re-routes the linked-CID-chain to skip the offending entry and updates the on-chain head. Normal protocol traversal would see a clean history; the amendment itself (not the removed content) is visible in Arbitrum One transaction history. The on-chain record would effectively read "SEALED at this point" — transparent about the redaction without preserving the harm. Note: this does not apply to EAS annotations, which are on-chain state and cannot be amended this way. Requires defining amendment authority, quorum, and appeal process. Defer to post-v1 governance design. | Medium |

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
| **OrbitDB legacy references causing confusion** | Medium | Low | Some early raw notes reference OrbitDB. This architecture supersedes those notes. OrbitDB is **not** part of the trust model; the linked-CID-chain + on-chain anchoring pattern is authoritative. |
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

- **On-chain state is authoritative** for contract enforcement and for **verification**. A press listed in `approved_presses` but absent from `PressAuthorizations` cannot write to the registry. A press in `PressAuthorizations` with `active = false` cannot write even if it still appears in `approved_presses`.
- **Verifiers consult on-chain `PressAuthorizations`**, not the IPFS `approved_presses` audit surface, to confirm a press's authorization when validating a card (see `card_validation.md` Stage 5 step 24 and `open_offer_acceptance_*.md` Phase 1). The `approved_presses` array is a non-authoritative snapshot that may lag on-chain state; where the two diverge, on-chain `PressAuthorizations` governs.
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
