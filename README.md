# Membership Card Protocol

*A secure tool for building trust and exchanging resources in community.*

---

## Overview

The Membership Card Protocol lets communities issue digital membership cards — the kind of card you'd carry in your wallet. Like a library card, a union card, or a guild membership, these cards prove that someone is trusted by a community. They can be used to access exclusive resources, send and receive messages, and build chains of trust between people and organizations.

Cards are private by default. Holding a card doesn't reveal anything about a person unless they choose to show it. Showing a card in one context can't be linked to showing a different card in another context. When a person does share a card, it provides cryptographically strong proof of who issued it, what it attests, and whether it's still in good standing.

The protocol is fully decentralized. Cards are stored on IPFS and registered on a smart contract on Arbitrum One. No single company owns or controls the system. Users can choose between competing wallet apps, and card issuers can choose between competing press services — the infrastructure they rely on is governed by an open protocol rather than a platform.

---

## Core Flows

### Card Issuance

A community leader creates a **card creation policy** that defines what a card attests, who is allowed to issue it, and what constraints govern it. When they want to issue a card to someone, they select the policy and send an offer to the recipient's wallet address.

The recipient's wallet prompts them to accept the offer using biometric authentication. Accepting the offer generates a new keypair in the device's secure enclave — the private key never leaves the device. The wallet returns the new public key, signed with the recipient's key, back to the issuer.

The issuer's wallet packages the signed offer and sends it to a **press** — a trusted third-party service that verifies the offer meets the policy's requirements, posts the card data to IPFS, and registers the resulting content address on the smart contract. Once the press confirms registration, the card is live and the recipient can use it.

### Verification

To verify a card, a recipient receives a signed message and the card's public key. They derive a smart contract address from the key and fetch the associated content from IPFS. This yields a verified statement (what the card attests), a link to the policy that created it, the identity of the person who issued it, a messaging endpoint, and the full chain of attestations tracing back to a trusted root.

A **verifier** package walks this chain, checking that every badge in the lineage is valid, unrevoked, and was issued by someone authorized to issue it. If everything checks out, the card appears with a green status indicator. Verifiers are lightweight, open-source packages that anyone can embed in a web app, mobile app, or server.

### Backup and Recovery

When a user accepts a new card, their wallet initiates a backup process. The card's private key is encrypted using a key derived from the user's biometric and account credentials (Apple or Google), then uploaded to a **wallet service**. Users can layer in additional recovery factors — a YubiKey, a paper password, or other standard credential — to require multiple factors before a backup can be restored.

If a user loses their device, they authenticate on a new device to retrieve and decrypt their backed-up keys, restoring full access to their cards. The backup scheme is designed so that the wallet service itself cannot read the keys it stores; only the user, with the right combination of credentials, can reconstruct them.

### Messaging

Each card has an associated messaging endpoint managed by the user's wallet service. This allows any party who holds a card to receive messages addressed to it without revealing a personal identifier like an email address. Messages are encrypted to the card's public key, so only the cardholder can read them.

Cards can receive badge offers, signed statements, update notifications, and general messages through this endpoint. This is also the channel through which presses notify cardholders when a registration or update is complete.

---

## Protocol Components

### Press

A press is a trusted service that validates and publishes cards. When a card offer is ready, the press:

1. Verifies that the offer meets the constraints of the card creation policy
2. Confirms that the issuer holds a valid badge authorizing them to issue under this policy
3. Posts the card data, encrypted to the recipient's public key, to IPFS
4. Registers the resulting content address on the smart contract, associating it with a mutable pointer derived from the card's public key
5. Handles subsequent updates — appending notes, changing status, or revoking the card — by posting new versions to IPFS and updating the mutable pointer

Presses run verified open-source code that is regularly audited by third parties. They are registered on the smart contract and can only update cards they are authorized to manage. Card creation policies specify which presses are approved to act on them. Multiple approved presses per policy provide redundancy.

### Smart Contract

The smart contract, hosted on Arbitrum One, is the protocol's source of truth for card registration and press authorization. It maintains:

- A registry mapping card public keys to their current IPFS content addresses (mutable pointers)
- A list of approved presses and the policies they are authorized to serve
- Access controls governing who can approve new presses and wallet services

The smart contract is governed by a set of updatable smart wallets controlled by the Protocol Governance Board. Because it only stores pointers and access rules — not card content — it is lightweight and inexpensive to use. Gas costs for registration and updates are on the order of fractions of a cent, passed through by presses as part of their fee.

### Verifier

The verifier is an open-source package (available as an NPM module and Python library) that any application can embed to validate cards. Given a public key and a signed message, the verifier:

1. Derives the smart contract address from the public key and fetches the current content address
2. Fetches the card data from IPFS and decrypts it with the card's public key
3. Walks the full chain of attestations — the card's issuer, the issuer's policy, the policy grantor's card, and so on — up to a trusted root registered with the Protocol Governance Board
4. Checks that no card in the chain has been revoked, and that each issuer was authorized at the time of issuance
5. Returns a structured result with validity status, the card's attested statements, and any notes or updates on record

The verifier also handles the `dnp://` URL scheme, which allows services to request card presentation from a user's wallet without knowing anything about who the user is.

### Wallet Service

A wallet service manages the infrastructure that makes cards usable day to day. It:

- Receives and stores encrypted key backups, allowing users to recover their cards across devices
- Hosts messaging endpoints for each card, receiving and routing encrypted messages to the right device
- Notifies users of incoming card offers, updates, and revocations
- Handles the `dnp://` deep-link scheme, prompting users to present a card when a service requests verification

Wallet services must be approved by the Protocol Governance Board to be listed as options in open card offers. If a card is found to be receiving messages via an unregistered wallet service, the verifier package notifies the Governance Board automatically. Wallet developers build on a shared open-source package maintained by the Governance Board, ensuring a consistent security baseline across implementations.

---

## Specification

The full protocol specification covers:

- Card data structure and IPFS encoding
- Card creation policy format and constraint language
- Press verification and registration procedures
- Smart contract interface and governance
- Verifier logic and chain-walking algorithm
- Wallet service requirements and backup encryption scheme
- Update and revocation status codes (200-range endorsements, 800-range silent revocations, 900-range loud revocations)
- Open offer format for distributing cards via QR code or link
- Notary service patterns for anonymization

See `/specs` for the current specification documents and `/plans` for roadmap and implementation plans.
