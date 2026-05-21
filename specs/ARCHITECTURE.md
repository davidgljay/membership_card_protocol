# Chitt Protocol — Architecture Decision Record

**Version:** 1.0  
**Date:** 2026-05-19  
**Status:** Current  
**Source:** Synthesized from `chitt_protocol_spec.md` (v0.3) and supporting raw notes  

---

## Table of Contents

1. [System Overview](#system-overview)
2. [ADR-001: Registry Substrate — Arbitrum One](#adr-001-registry-substrate--arbitrum-one)
3. [ADR-002: Off-Chain Content Storage — IPFS](#adr-002-off-chain-content-storage--ipfs)
4. [ADR-003: Append-Only Log Architecture](#adr-003-append-only-log-architecture)
5. [ADR-004: Cryptographic Primitives — ML-DSA-44 and ML-KEM](#adr-004-cryptographic-primitives--ml-dsa-44-and-ml-kem)
6. [ADR-005: Press Model and Key Custody](#adr-005-press-model-and-key-custody)
7. [ADR-006: Privacy Model — Client-Side, Private by Default](#adr-006-privacy-model--client-side-private-by-default)
8. [ADR-007: Transport Layer — Nym Mixnet](#adr-007-transport-layer--nym-mixnet)
9. [ADR-008: Annotation Layer — EAS on Arbitrum One](#adr-008-annotation-layer--eas-on-arbitrum-one)
10. [ADR-009: Key Management — Two-Tier with YubiKey Recovery](#adr-009-key-management--two-tier-with-yubikey-recovery)
10. [ADR-010: Canonical Serialization — RFC 8785 vs. CBOR](#adr-010-canonical-serialization--rfc-8785-vs-cbor)
11. [Component Map](#component-map)
12. [Key Data Flows](#key-data-flows)
13. [Open Questions](#open-questions)
14. [Risk Register](#risk-register)

---

## System Overview

The Chitt Protocol is a decentralized, privacy-preserving credential system. Its core primitive — the **chitt** — is a cryptographically signed credential issued under a policy, held by a user-sovereign keypair, whose current state is tracked on Arbitrum One and whose full content and history live on IPFS.

**Design goals:**

- Credentials are verifiable by anyone with IPFS and Arbitrum One access, without contacting the issuer.
- Privacy is a client-side choice; the registry contract is neutral.
- Revocation is authoritative and trustless via on-chain state.
- Key custody is user-sovereign; no service holds a user's signing key.
- The system is composable: credentials can reference other credentials, policies can constrain sub-policies, and third-party annotations accumulate as reputation context.

**What a chitt is, structurally:**

A chitt is a JSON document containing protocol-required fields (issuer, recipient public key, signatures, policy reference) plus policy-defined fields. The document is content-addressed and immutable on IPFS. Its current state is tracked by a **mutable pointer** — an on-chain registry entry pointing to the current head CID of an append-only log. The mutable pointer is the stable identity of the chitt across all updates.

---

## ADR-001: Registry Substrate — Arbitrum One

**Status:** Accepted  
**Date:** 2026-05-19 (v0.3 spec)

### Context

The protocol requires a shared, authoritative registry that maps each chitt's mutable pointer to its current log head CID, enforces that only authorized presses can write new entries, and provides trusted timestamps and rollback resistance. The registry must support on-chain verification of ML-DSA-44 signatures (post-quantum, ~2,420-byte public keys and signatures).

### Decision

Deploy a single registry contract on **Arbitrum One**, using **Stylus** to implement full on-chain ML-DSA-44 signature verification. One contract manages all chitts; entries are separated by their on-chain address.

### Options Considered

| Dimension | Arbitrum One | Solana | Ethereum Mainnet | Polygon |
|---|---|---|---|---|
| Transaction cost (create) | ~$0.05–0.15 | ~$0.00025 | $3–5 | $0.001–0.01 |
| Transaction cost (update) | ~$0.02–0.08 | ~$0.00025 | $1.50–2.50 | <$0.01 |
| Post-quantum sig support | Stylus (EVM + WASM) | Requires custom program | Limited | Limited |
| Historical reliability | High (inherits ETH security) | Outages in 2022; improved | High | Medium |
| EAS availability | Native on Arbitrum | Not available | Native on Mainnet | Available |
| EVM composability | Full | None | Full | Full |
| ML-DSA calldata overhead | ~3–8x vs Ed25519; est. <$0.25/write | Minimal | Prohibitive | Low |

**Key trade-off: Solana vs. Arbitrum One.** Solana's per-transaction cost is ~100x cheaper than Arbitrum One, which matters if the protocol generates high write volumes. However:

1. **ML-DSA-44 on Solana** requires a custom program with no existing Stylus-equivalent. Arbitrum's Stylus enables WASM-compiled Rust for efficient on-chain cryptographic computation.
2. **EAS (Ethereum Attestation Service)** is natively deployed on Arbitrum One. The annotation layer (ADR-008) depends on EAS; replicating this on Solana adds significant implementation scope.
3. **Solana's historical outage risk** is a chain-wide single point of failure. Distributed EVM infrastructure is lower correlated risk.
4. At estimated write volumes, Arbitrum One costs remain under $0.25/write — acceptable for a credential issuance use case where writes are infrequent relative to reads.

**Why not the hash-commitment shortcut?** Storing only a hash of the press public key and verifying signatures off-chain was explicitly rejected. It degrades the contract from a write gatekeeper to a passive log, enabling spam writes from anyone who knows a valid press public key. Full on-chain ML-DSA-44 verification is required before deployment.

### Consequences

- ML-DSA-44 signature calldata (~2,420 bytes vs. 64 bytes for Ed25519) increases per-write cost by an estimated 3–8x over a hypothetical Ed25519 design, remaining under $0.25/write at expected volumes.
- Arbitrum One blob-era gas pricing should be finalized before contract deployment.
- Press wallets hold ETH (not SOL) to pay for registry writes. A paymaster pattern can sponsor gas for recipient-initiated writes (self-revocations).
- The annotation layer (EAS) runs on the same chain, simplifying verification — chain reads for revocation and annotation lookups both target Arbitrum One.

---

## ADR-002: Off-Chain Content Storage — IPFS

**Status:** Accepted

### Context

Chitt content, policy documents, and the keyring blob must be stored durably, be content-addressable, and be independently fetchable by any verifier without going through a centralized service.

### Decision

Use **IPFS** for all off-chain content. The on-chain registry stores only CID pointers; content resolution is off-chain.

### Rationale

- **Content-addressing** means the CID is a cryptographic commitment to the content. A verifier who fetches content at a CID can confirm they received exactly what the issuer uploaded.
- **No persistence guarantee from IPFS alone.** Data lives only as long as someone is pinning it. This is addressed by requiring presses to pin all content they upload, with optional Filecoin archival via web3.storage/w3up for long-term persistence.
- **IPNS was evaluated and rejected** for the mutable pointer role. IPNS resolution is slow (seconds to minutes, DHT propagation) and records expire if not republished. The on-chain pointer provides faster and more reliable resolution for the head CID.

### Consequences

- Presses are responsible for pinning all content they upload to IPFS. A chitt whose content is no longer pinned is unresolvable by verifiers.
- The keyring blob (§ADR-009) lives on IPFS and must be pinned by the primary service until the user recovers.
- Filecoin integration (via pinning services) is the recommended long-term persistence path for high-value chitt data but is not required in v1.

---

## ADR-003: Append-Only Log Architecture

**Status:** Accepted

### Context

Chitt history — all updates, annotations, and revocations — must be preserved in an immutable, auditable log. The current state (log head) must be resolvable quickly; the full history must be independently verifiable. OrbitDB was evaluated as a candidate for this role.

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
| **Chitt log** | Chitt holder | Public or private (owner's choice) | Yes — head CID in Arbitrum One registry |
| **Press log** | Press service | Private by default | Yes — head CID in policy chitt's registry entry |

The press log records each issuance event, encrypted to each auditor chitt's public key via ML-KEM (FIPS 203). The press operator cannot read these entries.

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
    "signer_chitt": "<mutable pointer in registry of updater's sub-chitt — base64url>",
    "public_key": "<ML-DSA-44 public key — base64url>",
    "signature": "<sig over canonical CBOR of UpdateIntentPayload — base64url>"
  },
  "press_signature": {
    "signer_chitt": "<mutable pointer in registry of press's sub-chitt — base64url>",
    "public_key": "<ML-DSA-44 public key — base64url>",
    "signature": "<sig over canonical CBOR of complete LogEntry — base64url>"
  }
}
```

`code` is present on **every** log entry. `field_updates` is populated for 1xx–7xx codes; `revocation` is populated for 8xx–9xx codes. `intent_signature` covers the `UpdateIntentPayload` the updater submitted; `press_signature` covers the assembled `LogEntry` document.

The monotonic version number prevents replay. The `prev_log_root` CID creates a content-addressed chain. On-chain anchoring of the head CID provides a trusted timestamp and rollback resistance.

### Consequences

- Full log verification requires fetching all CIDs in sequence from IPFS (from head to genesis). For long-lived chitts, this grows linearly. Chain-walk parallelization using the cached chain array mitigates latency.
- OrbitDB replication nodes (docker-compose reference stack) may still be useful for press infrastructure to distribute IPFS pinning, but are not part of the trust model.

---

## ADR-004: Cryptographic Primitives — ML-DSA-44 and ML-KEM

**Status:** Accepted

### Context

Signature and key encapsulation schemes must be selected for the protocol. The primary concern is post-quantum security given the expected long credential lifetimes.

### Decision

- **Signatures:** ML-DSA-44 (FIPS 204, Module Lattice Digital Signature Algorithm), replacing Ed25519.
- **Key encapsulation (for audit log encryption):** ML-KEM (FIPS 203, Module Lattice Key Encapsulation Mechanism), replacing ECDH-based schemes.
- **Canonical serialization:** RFC 8785 canonical JSON (open question — CBOR remains under consideration, see §Open Questions).

### Trade-offs vs. Ed25519

| Dimension | Ed25519 | ML-DSA-44 |
|---|---|---|
| Public key size | 32 bytes | 1,312 bytes |
| Signature size | 64 bytes | 2,420 bytes |
| Post-quantum security | No (vulnerable to Shor's algorithm) | Yes (FIPS 204) |
| On-chain calldata overhead | Baseline | ~3–8x per registry write |
| Hardware support | Widespread | Emerging (YubiKey firmware) |

For credentials with multi-year lifetimes, the post-quantum security of ML-DSA-44 is the decisive factor. The calldata overhead is acceptable at projected write volumes.

### Proxy Re-encryption

The message server uses **UMBRAL proxy re-encryption** to transform inbound ciphertexts (encrypted to a master chitt public key) into per-device sub-chitt ciphertexts, without ever seeing plaintext. This enables multi-device delivery without the master key being online.

---

## ADR-005: Press Model and Key Custody

**Status:** Accepted  
**Prior open question resolved:** Key custody is user-sovereign (not press-custodial).

### Context

A **chitt press** is a service that verifies policy compliance and issues chitts on behalf of authorized policies. The question of who holds the chitt holder's signing key determines the trust model users opt into.

### Decision

**Key custody is user-sovereign.** The press never holds a chitt holder's signing key.

The issuance flow is a **mutual-signing pattern**:

1. The press verifies policy compliance, assembles the proposed chitt JSON (without the recipient's public key), and signs it as a **signed offer** — attesting that this press verified policy compliance.
2. The recipient independently generates their own ML-DSA-44 keypair, adds their public key, and **countersigns** the completed chitt.
3. Both signatures are present in every completed chitt. The press's signature is a statement about policy adherence; the recipient's countersignature is an assertion of identity and acceptance.

The press's signing key is the private key for its **press sub-chitt** — a sub-chitt of a specific policy chitt that authorizes it to issue under that policy. No separate press key type exists.

### Press Authorization Structure

```
Policy chitt (held by administrator/authorizer)
  └── Press sub-chitt (held by press operator)
       └── Issued chitts (held by recipients)
```

The press sub-chitt's mutable pointer must appear in the policy chitt's `approved_presses` field. The Arbitrum One registry contract enforces this: writes are rejected unless signed by an active, non-revoked press sub-chitt key listed in `approved_presses`. Revoking a press sub-chitt removes the press's write authority; previously-issued chitts are unaffected (they pre-date revocation).

### Privacy Properties of the Press

The press is deliberately constrained in what it can observe:

- **The press never sees plaintext CIDs.** The client encrypts the CID before handoff; the press posts ciphertext.
- **The press never knows the address derivation secret.** The client derives the registry address locally and tells the press where to write.
- **The press does record the chitt CID in its press log**, encrypted to each auditor's public key. This provides the policy authorizer an auditable recovery path if a recipient loses their capability bundle.

### Self-Hosted Presses

A docker-compose reference stack enables self-hosted press deployment. Self-hosted presses give power users and organizations full key custody and full control over policy compliance without third-party dependency.

### Consequences

- Trust in an issued chitt derives from trust in the policy, the authorizing chain, and the press sub-chitt authorization — not from trusting the press operator's intentions.
- The press operator can withhold issuance (refuse to sign offers) but cannot forge chitts — user-sovereign key custody prevents this.
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
| **Selectively shared** | `hash(sign(private_key, "chitt-log-v1"))` | Encrypted | Plaintext |
| **Fully private** | `hash(sign(private_key, "chitt-log-v1"))` | Encrypted | Encrypted |

**Two keys per private chitt:**

- **Address secret** — derives the registry address. Never shared. Controls who can locate the account on-chain.
- **Decryption key** — decrypts the on-chain CID. Shareable independently. Controls who can read the log head.

**Capability bundle:** to share a private chitt, the owner provides the recipient with an `(address, decryption_key)` pair. The decryption key can be ECDH-wrapped to the recipient's public key, tying it to their identity and preventing trivial forwarding.

**What an observer always sees:** that transactions are happening to the registry contract, when they occurred, and the fee payer (the press wallet). They cannot correlate transactions to identities, content, or each other without the address secret.

### Key Separation for Policy Authorizers

The policy control key and the audit log encryption key are **separate keypairs**. A compromised audit key must not grant policy control, and vice versa.

---

## ADR-007: Transport Layer — Nym Mixnet

**Status:** Accepted

### Context

The protocol needs a metadata-private communication channel for inbound message delivery (offers, SCIPs, server-to-user notifications). Standard HTTPS leaks sender identity and timing.

### Decision

Use the **Nym mixnet** for inbound message delivery. Each chitt has a Nym gateway address as a field in its metadata. Senders route encrypted payloads through Nym so the message server cannot observe who sent a message or when.

**Nym does two jobs:** hiding sender metadata on the inbound leg for chitt delivery, and providing an anonymous response channel for the authentication flow (§8). In the authentication flow, the wallet sends the signed response to the Nym gateway address carried in the requester's chitt metadata — the requester's chitt is therefore a prerequisite for any site that wants to request chitt-based authentication. Nym does not handle storage, multi-device delivery, or outbound communication beyond these two roles.

### Message Server

A **message server** (operator's own infrastructure) bridges inbound Nym messages to offline devices:

1. Maintains a persistent Nym client connection to receive inbound messages.
2. Holds **proxy re-encryption keys** (UMBRAL) for each active sub-chitt, generated at sub-chitt creation.
3. Transforms inbound ciphertexts (encrypted to master chitt public key) into per-device sub-chitt ciphertexts — without seeing plaintext.
4. Queues re-encrypted ciphertexts in a per-sub-chitt queue for device pickup.
5. Authenticates devices via sub-chitt signature challenge before delivering queued messages.

The message server observes that messages arrived and approximately when, but not their content (ciphertexts only) or senders (Nym hides this). Operators who distrust even this metadata can self-host a message server — the Nym gateway address is just a field in chitt metadata.

**Upgrade path:** If device check-in metadata becomes a concern, devices can connect via Nym rather than plain HTTP. Architecture otherwise unchanged.

---

## ADR-008: Annotation Layer — EAS on Arbitrum One

**Status:** Accepted

### Context

Third-party annotations — statements by parties outside the issuance chain about a chitt — are a core reputation mechanism. They must be published publicly, be signed by the annotator's chitt, and be filterable by trust.

### Decision

Use **Ethereum Attestation Service (EAS)** on Arbitrum One as the on-chain registry for annotation references. Annotation content is stored on IPFS; EAS holds the pointer and the annotator's signature.

### Why EAS

- EAS is natively deployed on Arbitrum One, requiring no separate infrastructure.
- The EAS schema registry enables typed annotations with standardized fields.
- Annotations are filterable by the signing chitt's chain — "show me only annotations from chitts I trust" — using the same chain-walk logic as all other verification.

### Annotation vs. Issuer Updates

Third-party annotations are distinct from issuer updates appended to a chitt's own log:

| | Chitt log update | EAS annotation |
|---|---|---|
| Author | Authorized party (per `update_policy`) | Any chitt holder |
| Location | Chitt's append-only log on IPFS | EAS registry on Arbitrum One |
| Authoritative? | Yes — part of chitt's canonical history | No — contextual; trust-weighted |
| Filterable? | No — always visible | Yes — filtered by annotator chain |

---

## ADR-009: Key Management — Two-Tier with YubiKey Recovery

**Status:** Accepted

### Context

A holder's private keys are the root of their identity. Loss means permanent loss of access. Keys that are too easy to recover are vulnerable to theft. The system must support practical recovery independent of any single service.

### Decision

**Two-tier key architecture:**

- **Master chitt key** — high-stakes key for creating sub-chitts and key rotations. Stored in an **encrypted keyring blob on IPFS**, encrypted with a key derived from `passkey + service_secret`. Neither the passkey nor the service secret alone can decrypt it.
- **Sub-chitt keys** — day-to-day signing keys, one per device. Stored in **secure device storage** (Secure Enclave on Apple, TPM on others). All routine signing operations use sub-chitt keys; the master key is cold.

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
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │   Chitt Registry Contract   │  │  EAS (Annotation Registry)   │  │
│  │  (Stylus / ML-DSA-44 verify)│  │  (third-party attestations)  │  │
│  └──────────────┬──────────────┘  └──────────────────────────────┘  │
└─────────────────┼───────────────────────────────────────────────────┘
                  │ mutable pointer → current log head CID
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                            IPFS                                      │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────────────┐ │
│  │ Chitt logs  │  │ Policy chitts  │  │ Keyring blobs / Annotation│ │
│  │ (CID chain) │  │ (content addr) │  │ content                   │ │
│  └─────────────┘  └────────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐  ┌──────────────────────────────┐
│          Chitt Press             │  │         Message Server        │
│  - Policy compliance check       │  │  - Nym gateway endpoint       │
│  - Signs offers (press sub-chitt)│  │  - UMBRAL proxy re-encryption │
│  - Posts to IPFS + Arbitrum      │  │  - Per-device message queue   │
│  - Logs issuance (encrypted)     │  └───────────────┬──────────────┘
└──────────────────────────────────┘                  │
                                         Nym mixnet (inbound only)
                                                      │
┌──────────────────────────────────────────────────── ▼ ──────────────┐
│                          Client (Holder)                              │
│  - Keyring (encrypted, IPFS-backed)                                  │
│  - Sub-chitt keys in Secure Enclave / TPM                            │
│  - Derives registry address locally (private mode)                   │
│  - Countersigns chitt offers                                         │
│  - Verifies chain before displaying any offer or message             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Data Flows

### 1. Chitt Issuance (First-Time Recipient)

```
Administrator / Requester
  → submits issuance request to press

Press
  → resolves requester + recipient chains, evaluates predicates
  → checks revocation entries on all chain links
  → assembles proposed chitt JSON (recipient_pubkey empty)
  → signs with press sub-chitt key → signed offer
  → encodes as chitt://invite?o=<base64>

Recipient
  → opens invitation link
  → client verifies press sub-chitt chain before showing offer
  → [keychain setup if first time]
  → reviews offer (issuer identity, field values, policy)
  → generates fresh ML-DSA-44 keypair
  → adds public key to chitt JSON
  → countersigns canonical serialization

Completed chitt (both signatures)
  → posted to IPFS → CID returned

Press
  → creates registry entry on Arbitrum One (initial log head CID)
    signed by press sub-chitt key
  → constructs issuance log entry, encrypted to each auditor via ML-KEM
  → appends to policy chitt's IPFS log + updates policy chitt's registry pointer
  → produces Signed Chitt Inclusion Proof (SCIP)
  → sends SCIP + confirmation to recipient via Nym
```

### 2. Chain Verification

```
Verifier receives signed message or chitt pointer
  → verify signature against canonical payload (no network call)
  → resolve signing sub-chitt's registry address on Arbitrum One
  → confirm sub-chitt appears in master chitt's active sub-chitt list
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

### 3. Chitt Update / Revocation

```
Authorized party (holder or press, per field's update_policy)
  → assembles log entry: version, entry_type, prev_log_root, changes
  → signs with sub-chitt key satisfying the relevant update_policy predicate
  → posts entry to IPFS → new log head CID
  → press (or paymaster) updates Arbitrum One registry entry → new head pointer

Verifiers
  → see new head pointer on-chain
  → fetch new log entry from IPFS
  → verify authorization against policy's field_definitions / revocation_permissions
```

### 4. Chitt Authentication (Site Requesting a Signed Statement)

```
Requesting site (must hold a chitt with a Nym gateway)
  → creates authentication request object:
      session_id, purpose, requester_chitt (mutable pointer),
      payload (content + nonce), required_predicate, callbacks.https,
      optional callbacks.ohttp
  → signs request with requester's chitt key (request_signature)
  → hosts request object at a single-use HTTPS URL
  → calls CHAPI with the request URL (not the payload)

CHAPI mediator
  → receives request URL (does not see payload content)
  → opens user's registered wallet service credential handler
  → wallet service URL not exposed to requesting site

Wallet service
  → fetches request object via HTTPS from single-use URL
  → verifies request_signature against requester's chitt public key
  → walks requester's chitt chain to trusted root, checks revocation (per §7)
  → evaluates required_predicate against user's available chitts
  → presents to user: requester's verified chain identity, purpose,
      payload content, required predicate summary
  → [user approves or declines]

On approval:
  → wallet selects qualifying chitt (or user chooses from chooser)
  → generates signed message envelope (§6) over canonical payload + nonce
  → sends authentication response to requester:
      preferred: Nym → requester's chitt Nym gateway (full sender anonymity)
      fallback:  OHTTP → callbacks.ohttp (IP privacy, lower latency)
      fallback:  HTTPS → callbacks.https (no anonymity, always available)

Requesting site
  → receives authentication response via Nym / OHTTP / HTTPS
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
| ~~OQ-1~~ | ~~Engineering~~ | ~~Canonical serialization format~~ — **CLOSED.** Canonical CBOR per RFC 8949 §4.2, JSON input surface per RFC 8949 §6.1, protocol overrides for binary fields and timestamps per ADR-010. Normative type mapping in spec Appendix A; conformance corpus at `specs/serialization-conformance.json`. | ~~Critical / Blocking~~ |
| OQ-2 | Engineering | ML-DSA-44 on-chain verification cost via Stylus: finalize gas estimates against current Arbitrum One blob-era pricing before contract deployment. | **Critical / Blocking** |
| OQ-3 | Engineering | Minimum IPFS replication count for a policy chitt's log before the Arbitrum One registry pointer update is considered safe. | High |
| OQ-4 | Engineering | For recipient-initiated registry writes (e.g., self-revocations): always mediated by press, or direct writes from holder via paymaster? | High |
| OQ-5 | Engineering | Field definition changes to a running policy (adding a new field): are previously-issued chitts that lack the field non-conforming or still valid? | High |
| OQ-6 | Engineering | How does the client efficiently detect new log entries since its last check — polling Arbitrum One registry pointer, or subscribing via Nym? | Medium |
| OQ-7 | Engineering | Fetch budget and caching strategy for chain and annotation lookups on mobile clients with limited connectivity. | Medium |
| OQ-8 | Engineering | When the cached chain array's version CIDs differ from a link's current state (because an ancestor was updated post-issuance), how should verifiers resolve the discrepancy? | Medium |
| OQ-9 | Design | Trusted root configuration UX: how are trusted roots configured by the user and synced across devices? Design work should begin in parallel with protocol engineering. | High |
| OQ-10 | Design | Recovery UX when the holder has both a lost primary service and a lost YubiKey. Out of scope for v1? | Medium |
| OQ-11 | Design | What is the UX when a recipient declines an offer? Should a decline notification be sent to the press? | Low |
| OQ-12 | Engineering | Is a transparency log of approved press implementations operated by the protocol foundation needed? Relevant if TEE attestation is added in P2. | Low (P2 dependency) |
| OQ-13 | Design | Should wallet services publish a `/.well-known/chitt-wallet.json` manifest advertising their supported transports (HTTPS, OHTTP gateway, Nym availability)? If yes, requesting sites can construct the correct `callbacks` block without trial-and-error; if no, sites advertise all transports they support and wallets pick. | Medium |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Arbitrum One outage / unavailability** | Low | High | Registry reads are cacheable; short-term unavailability doesn't break existing chitt verification (cached chain arrays). Write operations (issuance, revocation) are queued and retried. |
| **IPFS content not pinned / unavailable** | Medium | High | Presses are contractually responsible for pinning. Filecoin archival (web3.storage/w3up) provides long-term backup. Clients cache recently-fetched CIDs locally. |
| **ML-DSA-44 Stylus verification too expensive on-chain** | Medium | High | **Blocking risk before contract deployment.** Gas estimates must be finalized. Batched registry writes (multiple log updates per Arbitrum transaction) reduce per-chitt cost during high-volume periods. |
| **Canonical serialization incompatibility** | Medium | High | **Blocking risk before npm package API lock.** RFC 8785 vs. CBOR must be decided. All signature interoperability depends on this. |
| **Press key compromise** | Low | Medium | Revoking the press sub-chitt removes its write authority. Previously-issued chitts are unaffected. The press cannot forge user signatures (user-sovereign key custody). |
| **YubiKey stolen before 72-hour cancellation window** | Low | Medium | Multi-channel notifications give holder 72 hours to cancel. After recovery, old YubiKey should be treated as potentially compromised; holder should rotate backup registration. |
| **OrbitDB legacy references causing confusion** | Medium | Low | Some early raw notes reference OrbitDB. This architecture supersedes those notes. OrbitDB is **not** part of the trust model; the linked-CID-chain + on-chain anchoring pattern is authoritative. |
| **Post-quantum transition risk for Ed25519 legacy tooling** | Low | Medium | ML-DSA-44 is FIPS 204 standardized. YubiKey hardware support is emerging. Where necessary, hybrid signatures (Ed25519 + ML-DSA) can be used during transition. |

---

---

## ADR-010: Canonical Serialization — RFC 8785 vs. CBOR

**Status:** Open — decision required before npm package API lock  
**Date:** 2026-05-19  
**Blocking:** All signature interoperability; npm package API; on-chain verification logic

### Why This Decision Is Load-Bearing

Every signature in the protocol commits to a **canonical serialization** of a payload. "Canonical" means deterministic: given the same logical data, every implementation — the press, the recipient's client, the verifier's server, the Stylus contract — must arrive at exactly the same byte sequence before signing or verifying. A one-byte difference means a failed signature. This is not an implementation detail; it is the cryptographic bedrock of the entire trust model.

The decision must be made and locked before:

1. The `ChittAuth` npm package API is finalized (signature and verification helpers hardcode the encoding).
2. The Arbitrum One registry contract is deployed (the Stylus verifier must agree with off-chain signers on what bytes were signed).
3. Any two independent implementations exchange signed objects.

### What Is Being Serialized

Three distinct payload types are signed in the protocol:

| Payload | Signed by | Verified by |
|---|---|---|
| **Chitt offer** | Press (sub-chitt key) | Recipient client, then any verifier |
| **Completed chitt** | Recipient (new keypair) | Any verifier; on-chain registry contract |
| **Log entry** (update, revocation) | Authorized updater | Any verifier |
| **Message envelope payload** | Sender (sub-chitt key) | Recipient client, any verifier |
| **Auth request / response** | Requester chitt; then holder | Service server |

All of these must use the **same canonical serialization scheme**. A mixed-scheme protocol (JSON for some, CBOR for others) would require two independently-maintained serialization stacks and create correctness risk at every boundary.

### Option A: RFC 8785 — JSON Canonicalization Scheme (JCS)

RFC 8785 defines a deterministic serialization of JSON: keys sorted lexicographically, whitespace removed, Unicode normalized, numbers in a specific format. The output is a valid UTF-8 JSON string.

**Pros:**

- **Human-readable.** The canonical form is plain JSON. A developer can read a signed payload without tooling, diff it against another, and paste it into a REST client. This is a meaningful ergonomic advantage for protocol debugging and adoption.
- **Widely implemented.** Libraries exist for JavaScript, Python, Go, Rust, Java, and most other languages. The Rust implementation is straightforward to compile to WASM for Stylus.
- **Matches the existing spec language.** The spec (§6, Signing) already specifies "RFC 8785 canonical JSON" as the serialization format, so this is the current leading candidate.
- **Easy to adopt in the npm package.** `JSON.canonicalize()` (or equivalent) is a thin wrapper and requires no schema registry.
- **No binary dependency in developer tooling.** Debugging a signature failure is: print the canonical JSON, inspect it, find the discrepancy. With CBOR you need a decoder step.

**Cons:**

- **Number representation edge cases.** RFC 8785 specifies IEEE 754 double-precision float formatting. Protocol field types like `integer` and `number` must be defined precisely to avoid cross-language differences (e.g., `1.0` vs `1` vs `1e0`). The spec's type system restricts numeric fields to `integer` and `number` with explicit range constraints, which mitigates but does not eliminate this risk.
- **Unicode normalization requirement.** All string values must be in Unicode NFC normalization. This is handled transparently in most environments but must be explicitly tested in implementations that accept user-provided text field values (e.g., chitt field content from a `text` type field).
- **Slightly larger payloads than CBOR.** JSON is text; CBOR is binary. For ML-DSA-44 keys (1,312 bytes) and signatures (2,420 bytes) embedded as base64 strings in JSON, the overhead is approximately 33% vs. raw binary. This affects calldata size on Arbitrum One — a meaningful but secondary concern compared to the ML-DSA-44 calldata cost already accepted.

### Option B: CBOR (RFC 8949) with Deterministic Encoding

CBOR is a binary data format designed for compactness. RFC 8949 §4.2 specifies "deterministically encoded CBOR" rules: shortest-form integers, sorted map keys (length-prefixed byte comparison), no indefinite-length items.

**Pros:**

- **Compact binary encoding.** Eliminates base64 overhead for embedded keys and signatures; reduces calldata size on Arbitrum One. For a chitt offer with two ML-DSA-44 keys and two signatures, CBOR saves roughly 1,200–2,000 bytes per object vs. JSON — meaningful at scale but under $0.02 at current blob pricing.
- **Native binary type.** Cryptographic material (keys, signatures, hashes) is encoded as binary byte strings rather than base64 text, reducing encoding/decoding steps and eliminating base64 ambiguity (standard vs URL-safe, padding variants).
- **Well-suited for constrained environments.** If Chitt clients eventually run on embedded or hardware devices (e.g., hardware wallet integrations), CBOR's compactness matters more.
- **Growing ecosystem.** CBOR is used in COSE (CBOR Object Signing and Encryption), FIDO2/WebAuthn credentials, and various IETF identity standards. Cross-ecosystem compatibility is a potential benefit for future integrations.

**Cons:**

- **Not human-readable.** A signed payload is a binary blob. Debugging a signature failure requires a CBOR decoder before you can inspect the payload. This significantly increases the friction for third-party verifier implementations and protocol debugging.
- **Schema coupling.** Deterministic CBOR requires precise agreement on map key ordering and type encoding. Adding a new optional field to a payload schema requires verifying that all implementations sort keys identically. JSON's lexicographic string sort is simpler and universally consistent.
- **Library maturity varies.** JavaScript and Rust have solid CBOR libraries, but the ecosystem is thinner than JSON's. The Stylus/WASM CBOR implementation would need careful testing for determinism edge cases.
- **Conceptual mismatch with the type system.** The spec's type system (`text`, `integer`, `number`, `boolean`, `date`, `timestamp`, `cid`, `chitt-pointer`, ...) maps naturally to JSON types. CBOR's richer type system (tagged types, bignum, etc.) introduces mapping choices — e.g., should a `timestamp` be a CBOR tagged integer (tag 1) or a text string? These choices must be specified and maintained.
- **Higher adoption friction for third-party developers.** The protocol's value depends on independent verifiers building against it. A binary format with schema coupling will slow external adoption compared to JSON.

### Recommendation: CBOR with JSON input surface in the npm package

The adoption-friction argument for RFC 8785 rests on an assumption worth questioning: that verifiers will frequently implement canonical serialization themselves. In practice, verifiers fall into three categories:

1. **Services using the `ChittAuth` npm package** — never touch serialization; it's internal to the package.
2. **Mobile/client SDKs** — same; the SDK owns the encoding.
3. **Independent implementations from scratch** — a small minority even at wide adoption, and sophisticated enough to handle CBOR.

If the npm package handles JSON→CBOR conversion internally — accepting JSON-shaped objects as developer input, converting to deterministic CBOR before signing or verifying — then the ergonomic cost of CBOR is almost entirely absorbed. Developers write JSON-like structures; they never see CBOR bytes unless they deliberately go looking. The rough verification experience argument applies only to category 3.

Meanwhile, the calldata savings are not second-order — they are recurring costs on every registry write, and they compound. ML-DSA-44 keys and signatures are already large; base64url encoding in JSON adds ~33% on top of that. Per-issuance CBOR savings are roughly 2,400–2,500 bytes (two keys + two signatures, raw vs. base64url). At current Arbitrum One blob-era pricing that is a small per-write saving, but it applies to every issuance, every log update, and every revocation — forever. Batched writes reduce the per-chitt amortized cost but do not change the per-byte calldata cost. CBOR makes every byte cheaper; batching does not.

The revised recommendation is **CBOR (RFC 8949 deterministic encoding)** with a JSON-friendly input surface on the npm package.

### The JSON↔CBOR Conversion Standard: RFC 8949 §6.1/§6.2

The base conversion standard is **RFC 8949 §§6.1–6.2** ("Converting from JSON to CBOR" / "Converting from CBOR to JSON"), combined with **RFC 8949 §4.2** deterministic encoding requirements. This is the published IETF standard for CBOR↔JSON interop and is what the major CBOR libraries (Rust's `ciborium`, JavaScript's `cbor2`, Python's `cbor2`) implement.

Generic RFC 8949 §6.1 handles most of the protocol's types correctly without special casing:

| JSON input type | CBOR encoding (RFC 8949 §6.1) |
|---|---|
| `false` / `true` / `null` | Simple values 0xf4 / 0xf5 / 0xf6 |
| Integer (no fractional part) | Major type 0 (unsigned) or 1 (negative), shortest form |
| Number (fractional) | Major type 7 float, shortest form that round-trips |
| String | Major type 3 text string, UTF-8 as-is (no NFC normalization required) |
| Array | Major type 4 |
| Object | Major type 5 map, keys as text strings, **sorted per §4.2.1** |

Deterministic encoding (RFC 8949 §4.2) requires: shortest integer encoding, shortest float encoding that round-trips, and map keys sorted by the length of their CBOR-encoded key first, then lexicographically by the key bytes.

### Protocol-Specific Overrides (Schema-Aware)

Two protocol field types cannot be handled by generic JSON→CBOR conversion because they require schema knowledge to encode correctly. These are protocol-level rules applied by the npm package before invoking RFC 8949 §6.1:

**Binary fields — `text` fields carrying cryptographic material.**  
Keys, signatures, CIDs, and hashes are accepted as **base64url strings** (no padding, RFC 4648 §5) in the JSON input surface. The npm package converts them to **CBOR byte strings (major type 2)** before encoding. The affected fields are:

| Field | Accepted JSON form | CBOR encoding |
|---|---|---|
| `recipient_pubkey`, `public_key` (in any signature entry) | base64url string | Major type 2 byte string |
| `offer_signature`, `holder_signature`, `signature` (in any signature entry) | base64url string | Major type 2 byte string |
| `policy_id`, `press_chitt`, `prev_log_root`, and any `cid` type field | base64url string | Major type 2 byte string |

This is the primary source of calldata savings — binary fields appear in CBOR at their raw byte length rather than ~33% larger as base64url text.

**Timestamp fields — `timestamp` type.**  
`timestamp` fields are accepted as ISO 8601 strings in the JSON input surface and encoded as **CBOR Tag 1 (Epoch-Based Date/Time, RFC 8949 §3.4.2)** wrapping an unsigned integer (Unix epoch seconds, UTC). Fractional seconds are not used; sub-second precision is not required by the protocol.

| Field | Accepted JSON form | CBOR encoding |
|---|---|---|
| `issued_at`, `effective_date`, `expires`, timestamp fields generally | ISO 8601 string (e.g., `"2026-05-19T14:30:00Z"`) | Tag 1 + uint (e.g., `0xc1 0x1a ...`) |

`date` type fields (e.g., `enrollment_date`) are **not** Tag 1 — they remain CBOR text strings in `YYYY-MM-DD` format, since they represent calendar dates without a time component.

**Optional fields.**  
Absent optional fields must be omitted from the CBOR map entirely. The npm package must strip `null` or `undefined` values from the input object before encoding; encoding them as CBOR null would produce different bytes.

### What the npm Package Exposes and What It Hides

The npm package's signing and verification helpers accept plain JavaScript objects (JSON-shaped). CBOR encoding is internal. The developer contract must be stated clearly in the package documentation:

> *The bytes that are signed are canonical CBOR (RFC 8949 deterministic encoding with protocol-specific overrides for binary fields and timestamps). If you need to verify a signature outside this package, encode your payload using the same rules. A reference test corpus is provided.*

This must not be a hidden implementation detail — auditors and independent verifier authors need to know what they're verifying against.

### What Changes Relative to Current Spec

The spec (§6, Signing) currently says "RFC 8785 canonical JSON." Adopting CBOR requires:

- Updating the serialization section of the spec to: "Canonical CBOR per RFC 8949 §4.2, with JSON input surface conversion per RFC 8949 §6.1 and the protocol-specific overrides for binary fields and timestamps defined in ADR-010."
- Publishing the JSON→CBOR type mapping table above as a normative appendix.
- Producing the conformance test corpus (see Action Items below).
- The npm package's signing and verification helpers are the canonical reference implementation; the test corpus is what third-party implementations validate against.

### Constraints the Decision Imposes

Regardless of which format is chosen, these constraints must be enforced:

- **Integer types must round-trip exactly.** The `integer` field type must be constrained to the range representable without floating-point ambiguity in the chosen format. For JCS, this means values must be within the safe integer range (−2⁵³ + 1 to 2⁵³ − 1) and explicitly validated at field creation time.
- **Binary data (keys, signatures, CIDs) must have a single canonical encoding.** For JCS: unpadded base64url (RFC 4648 §5, no padding characters). This must be documented and tested; standard `btoa()` in browsers uses standard base64 with padding, which is incorrect.
- **Optional fields must have a canonical absence representation.** Omitted optional fields must be absent from the serialized object entirely — not present with a `null` value. Both representations are valid JSON/CBOR but produce different bytes when signed.
- **Object key ordering applies only to the top-level map in JCS.** Nested objects are also sorted. Implementations that manually assemble JSON strings rather than using a JCS library will get this wrong; the npm package must expose only the canonical serialization helper, not raw JSON construction.

### Action Items

- [x] Update spec §6 serialization reference to: "Canonical CBOR per RFC 8949 §4.2, JSON input surface per RFC 8949 §6.1, with protocol-specific overrides per ADR-010." Close OQ-1.
- [x] Add ADR-010 type mapping table as a normative appendix to the spec (Appendix A).
- [x] Produce a serialization conformance test corpus: `specs/serialization-conformance.json` — 22 cases with verified CBOR hex, covering binary fields, Tag 1 timestamps, `date` text fields, integer boundary values (23/24/256), optional field omission, nested map key ordering, Unicode, arrays, booleans, and two full representative payloads.
- [ ] Implement the npm package JSON input surface: all signing and verification helpers accept JSON-shaped objects; RFC 8949 §6.1 conversion + protocol overrides are internal. State in documentation that CBOR bytes are what is signed.
- [ ] Validate Stylus WASM CBOR implementation against the full conformance test corpus before contract deployment.

---

*This document synthesizes `chitt_protocol_spec.md` (v0.3, 2026-05-19) and supporting raw notes. Where the spec and earlier notes conflict (e.g., Solana vs. Arbitrum One as the registry substrate), the spec is authoritative.*
