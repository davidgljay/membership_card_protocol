> **⚠ SUPERSEDED — Historical reference only.**
> This document was written when the registry substrate was Solana. The canonical decisions are now in `specs/ARCHITECTURE.md` (v1.0, 2026-05-19). Key changes:
> - Registry: **Arbitrum One** (not Solana). Contract uses Stylus for on-chain ML-DSA-44 verification.
> - Signatures: **ML-DSA-44** (not Ed25519). Public keys are 1,312 bytes; signatures are 2,420 bytes.
> - "PDA" → **registry address**. "SOL" → **ETH**. "Solana program" → **Arbitrum One registry contract**.
> - Annotation layer: **EAS on Arbitrum One** (not referenced here).
> - OrbitDB: **not used**. Append-only log is a linked-CID-chain anchored on Arbitrum One.

Card Protocol Arcardecture
Core Primitive: The Card
A Card is a cryptographic keypair plus a metadata document, identified by a mutable pointer. The mutable pointer — not the content hash — is the Card's stable identity. It is what gets passed around, embedded in messages, and used as an account identifier. The pointer resolves to the Card's current append-only log, which records the full history of updates, annotations, and revocations.

The metadata document lives on IPFS and contains:

The Card's public key
The mutable pointer back to this Card (self-reference, for log resolution)
The issuer's Card pointer and signature (chain link)
The Card's scope and attenuation rules
The Nym gateway address for inbound messages
The list of active sub-Card public keys with their re-encryption keys
A schema reference if the Card was issued by a template
An optional image CID pointing to a visual representation of the Card stored on IPFS, intended for display in a hexagonal frame

The metadata document is itself signed by the issuer, creating a verifiable chain from any Card back to a root of trust.

Component 1: Card Registry (IPFS + On-Chain Pointer Registry)
What it is: Two layers working together. IPFS provides content-addressed storage for Card metadata documents (version CIDs). ~~A Solana program maps each Card's mutable pointer~~ **An Arbitrum One registry contract maps each Card's mutable pointer** to the current version CID and maintains the append-only update log. ~~Each Card is a Program Derived Account (PDA) under a single deployed program~~ **Each Card has a registry address under a single deployed contract** — one contract manages all Cards.
Core functions:

Store Card metadata documents on IPFS, returning a version CID
Resolve a mutable pointer to the current version CID (~400ms slot time, trivially cacheable)
Maintain the append-only log of all versions, with each log root anchored on-chain for rollback resistance and trusted timestamps
Store third-party annotation documents on IPFS, indexed via EAS

Key properties: The mutable pointer is stable across all updates. The version CID is what signatures commit to — it changes with every update, which is fine, because historical signatures reference the version CID they were made against. ~~Updates cost ~$0.00025 per operation on Solana. One deployed program handles all Cards; account rent (~0.002 SOL) is paid once per Card at creation.~~ **Updates cost an estimated <$0.25 per operation on Arbitrum One (including ML-DSA-44 calldata). One deployed contract handles all Cards.**

Component 2: Keyring and Device Keys
What it is: Two-tier key management. The holder's master Card private key lives in an encrypted keyring stored on IPFS. Sub-Card keys for day-to-day operations live in secure device storage.
Core functions:
Keyring (encrypted IPFS blob):

Hold the master Card private key, encrypted with a key derived from passkey + service secret
Remain decryptable via a YubiKey-wrapped decryption key for recovery purposes
Be append-only: new keys are added; old keys are not deleted from the blob, preserving recoverability

Local device:

Hold sub-Card private keys in secure device storage (Secure Enclave, TPM)
Sign statements and messages day-to-day without decrypting the keyring
Authenticate to the message server to pull queued messages
Decrypt incoming messages using the device sub-Card private key

Key property: The master private key is accessed only when creating new sub-Cards or performing high-stakes operations. All routine operations use sub-Card keys. Recovery does not require the original service — only the keyring blob (on IPFS) and the YubiKey.

Component 3: Inbound Message Transport (Nym)
What it is: A mixnet providing sender anonymity on the inbound leg. Senders route messages through Nym so that the message server receives messages without being able to observe who sent them or when.
Core functions:

Provide metadata-private routing from sender to the Card's Nym gateway
Obscure sender identity, timing, and traffic patterns through mix batching and shuffling
Deliver encrypted payloads to the Card's Nym gateway endpoint

Key property: Nym does one job — hiding sender metadata on the inbound leg. It is not used for storage, for device delivery, or for any other purpose. The payload it carries is already encrypted to the master Card public key; Nym cannot read it.
What it doesn't do: Durable storage, multi-device delivery, device-to-server communication. Those are handled by the message server.

Component 4: Message Server (Your Infrastructure)
What it is: A persistent server that acts as the Card's Nym gateway endpoint, proxy re-encryption service, and per-device message queue. This is the always-online component that bridges inbound Nym messages to offline devices.
Core functions:
Nym gateway:

Maintain a persistent Nym client connection to receive inbound messages
Accept encrypted payloads arriving from the Nym mixnet

Proxy re-encryption:

Hold re-encryption keys for each active sub-Card (generated at sub-Card creation, stored server-side)
Transform incoming ciphertexts encrypted to the master Card key into separate ciphertexts encrypted to each active sub-Card key using UMBRAL proxy re-encryption
Never sees plaintext — transformation is purely cryptographic

Per-device queue:

Store re-encrypted ciphertexts in a per-sub-Card queue
Apply configurable retention policies (delete after fetch, delete after N days, keep indefinitely)
Authenticate device connections via sub-Card signature challenge
Deliver queued ciphertexts to authenticated devices on request

Key property: The server sees that messages arrived and approximately when, but cannot read content (ciphertexts only) and cannot identify senders (Nym hides this on the inbound leg). Card holders who don't trust even this metadata visibility can run their own message server — the Nym gateway address is just a field in the Card metadata.
Upgrade path: If device check-in metadata becomes a concern, devices can connect via Nym rather than plain HTTP. The queue becomes a Nym-addressed endpoint rather than an HTTP endpoint. Arcardecture otherwise unchanged.

Component 5: Card Press (Gated Enclave Issuance)
What it is: A gated enclave service — running attested, audited code in a hardware-isolated environment — that produces new Cards according to an approved policy. Card Presses are operated as a service and can accept arbitrary approved policies.
Core functions:

Accept a signed policy approved by an authorizing Card
Verify the authorizing chain on every issuance request
Accept additional inputs (co-signed statements, HTTPS attestations via Reclaim, manual approval, etc.)
Produce a new Card JSON — without the recipient's public key, which the recipient adds — signed by the enclave's keypair
Log each issuance in an append-only issuance log, encrypted with the policy authorizer's audit key

Privacy properties of the press:

The press never holds plaintext CIDs. The client encrypts the CID before handoff; the press posts ciphertext and never has the decryption key.
The press never knows the Card's address derivation secret. The client derives the registry address locally and tells the press where to write. The press signs and submits the transaction without knowing why that address was chosen.
The press does record the CID in its issuance log — it necessarily knows the CID since it performed the IPFS upload and chain write. This record is encrypted with the policy authorizer's audit key, making the log readable only to the authorizer. This provides a recovery path: if a recipient loses their capability bundle, the authorizer can retrieve the CID from the press log and reissue the bundle.

Examples:

School enrollment press: accepts administrator Card + enrollment record → issues student Card
Reclaim press: accepts verified HTTPS response pattern → issues attestation Card
Expertise press: accepts journalism organization Card → issues journalist Card
Survey aggregator press: accepts encrypted survey inputs + ZK proof of aggregation → issues community health Card

Key property: Trust in an issued Card derives from trust in the policy, the authorizing Card, and the attested enclave code — not from trusting the enclave operator's intentions. The enclave operator cannot forge Cards; they can only run or refuse to run the attested code.

Component 6: Chain Verification
What it is: The logic that walks a Card's trust lineage from a given Card back to a root of trust, checking every link. This is the core cryptographic primitive that makes the whole system meaningful.
Core functions:

Resolve the mutable pointer to the current version CID
Fetch the Card metadata document from IPFS
Verify the issuer's signature on the metadata document
Check the Card's append-only log for revocation entries
Walk up to the issuer's Card (the template Card, then the authorizer's Card) and repeat
Validate scope attenuation at each link (derived Card cannot exceed issuer Card's scope)
Return: valid chain to trusted root / revoked / invalid signature / scope violation

Key property: Stateless and verifiable by anyone. No trusted oracle needed — a verifier resolves the pointer, fetches from IPFS, and does the cryptography locally. Chain walks can be parallelized using the cached chain array embedded in each Card's metadata.

Component 7: Annotation Layer (IPFS + EAS)
What it is: A public, signed, append-only stream of third-party statements about Cards. This is distinct from issuer annotations (which are entries in the Card's own append-only log). Third-party annotations are published by parties outside the issuance chain and are governed by annotation policies.
Core functions:

Publish a signed third-party annotation referencing a Card's mutable pointer
Resolve all third-party annotations for a given Card
Filter annotations by the signer's Card chain (show me only annotations from Cards I trust)
Surface annotation context alongside Card verification results
Enforce annotation policies where present (e.g. only certain Card types may append metadata; only corroborated annotations surface as warnings)

Substrate: Ethereum Attestation Service (EAS) as the on-chain registry for annotation references, with annotation content stored on IPFS.
Key property: The annotation layer is the reputation accumulation surface. A Card is not just binary valid/revoked — it has a history of what others have said about it, weighted by the trust you place in the signers of those annotations.

Component 8: Matrix Room Integration (Separate Feature)
What it is: A distinct feature from private messaging. Matrix rooms are shared, persistent, multi-party spaces. Card integration here means using Cards as access credentials to enter rooms and as signing identities within them.
Core functions:

Gate room entry: challenge entrants to prove they hold a Card satisfying specified requirements (chain, scope, claims)
Sign in-room messages with a sub-Card key so other members can verify the sender's Card chain (via the sub-Card-to-master link)
Surface Card metadata and annotation context alongside messages in the room UI
Support room-level policies: "only Cards from this issuance chain can post," "only Cards with fewer than N statements today can post" (spam control)

Key property: All signing in Matrix rooms uses sub-Card keys, consistent with the rest of the protocol. The master Card key is never used for routine operations. The room bot verifies the sub-Card-to-master link as part of entry verification.

Privacy Model

Two append-only logs exist in the system with different privacy requirements:

1. Card logs — the sequence of CID updates representing a Card's history. The owner chooses whether this is public or private.
2. Press logs — each press maintains a log of Cards pressed under a given policy. Private by default, encrypted with the policy authorizer's audit key.

Card addresses and content are private by default. Privacy is a client-side choice; the contract is neutral. A Card can be made public simply by using a pubkey-derived address and storing the CID in plaintext — discoverable by anyone who knows the owner's public key. The privacy spectrum is:

Public: pubkey-derived registry address, plaintext CID on-chain. Discoverable and readable by anyone.
Selectively shared: secret-derived registry address, encrypted CID on-chain. Owner hands capability bundles to specific recipients.
Fully private: secret-derived address, encrypted CID, encrypted IPFS content. Content unreadable even to someone who obtains the CID.

Secret-derived addresses: rather than using a public key as the registry address seed, the client derives it from keccak256(sign(private_key, "card-address-v1")). The resulting account address is opaque — not linkable to any identity without the private key. ~~The Ed25519 signature is deterministic~~ **The ML-DSA-44 signature is deterministic**, so the address is always recoverable from the same key.

Two keys per private Card:
- Address secret — derives the registry address. Controls who can find the account. Never shared.
- Decryption key — decrypts the on-chain CID. Grants read access. Can be shared independently.

Capability bundle: to share a private Card, the owner provides the recipient with an (address, decryption_key) pair. The key can be encrypted via ECDH to the recipient's public key, tying it to their identity and preventing trivial forwarding.

What an observer always sees: that transactions are happening to the program, when, and the fee payer (the press wallet). They cannot correlate transactions to identities, content, or each other without the address secret.

Key separation for policy authorizers: the policy control key and the audit log encryption key should be separate keypairs. A compromised audit key must not grant policy control, and vice versa.

How the components connect
Card created via invitation link
  → recipient receives signed Card JSON (without public key)
  → recipient creates keyring, generates keypair
  → recipient adds public key and countersignature to Card JSON
  → completed Card posted to IPFS
  → mutable pointer registered on-chain
  → sub-Card created: re-encryption key generated,
    stored on message server, sub-Card key stored on device

Someone sends a private message
  → resolves recipient's mutable pointer to current metadata
  → encrypts to master public key
  → routes through Nym mixnet
  → arrives at message server (sender hidden)
  → proxy re-encryption transforms to sub-Card ciphertexts
  → stored in per-device queue

Device comes online
  → authenticates to message server with sub-Card signature
  → downloads ciphertext queue
  → decrypts with local device key
  → resolves sender's mutable pointer, fetches metadata from IPFS
  → verifies sender chain and signature

Someone verifies a Card
  → resolves mutable pointer to current version CID
  → fetches metadata from IPFS
  → walks append-only log for revocation entries
  → walks chain (policy → template Card → authorizer Card)
  → fetches third-party annotations from EAS/IPFS
  → filters annotations by trusted annotator Cards
  → returns: chain validity + revocation status + annotation context

Someone enters a Matrix room
  → room bot issues challenge nonce
  → entrant signs with sub-Card key
  → bot verifies sub-Card-to-master link
  → bot resolves master Card's mutable pointer, walks chain
  → access granted or denied

What the npm package exports
javascript// Card lifecycle
CardProtocol.createCard(options)
CardProtocol.resolveCard(mutablePointer)
CardProtocol.verifyCard(mutablePointer, trustedRoots)
CardProtocol.revokeCard(mutablePointer, masterKey)

// Sub-Card / device management
CardProtocol.createSubCard(masterCardPointer, devicePublicKey)
CardProtocol.revokeSubCard(subCardPointer)

// Card Press / issuance
CardProtocol.deployPress(policy, enclaveEndpoint)
CardProtocol.issueViaPress(pressId, requesterCard, additionalInputs)

// Private messaging (Nym inbound, server queue, device pull)
CardProtocol.sendMessage(recipientPointer, content, senderCard?)
CardProtocol.fetchMessages(subCardPointer, deviceKey)

// Annotations (third-party)
CardProtocol.annotate(targetPointer, content, signingCard)
CardProtocol.getAnnotations(pointer, trustedAnnotatorRoots?)

// Matrix integration
CardProtocol.createGatedRoom(requirements)
CardProtocol.verifyRoomEntry(challenge, subCardProof)
CardProtocol.signRoomMessage(content, subCardPointer, deviceKey)

What you're not building
Worth being explicit. The npm package does not include:

The Nym network itself (existing infrastructure)
IPFS (existing infrastructure)
EAS contracts (existing infrastructure)
The Matrix homeserver (existing infrastructure, operator brings their own)
The UMBRAL re-encryption library (existing library, you wrap it)
The on-chain pointer registry contract (deployed once, shared infrastructure)

What you're building is the opinionated glue layer — the Card format, the chain verification logic, the Card Press interface, the message server, and the integrations that make these components work together as a coherent trust primitive. That's a meaningful and tractable scope.
