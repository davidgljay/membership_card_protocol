# Membership Card Protocol

*A secure tool for building trust and exchanging resources in community.*

---

## Overview

The Membership Card Protocol lets communities issue digital membership cards — a little like a library card, a union card, or a student ID. These cards prove that someone is a trusted member of a community. They can be used to access that community’s resources, send and receive messages, and facilitate trust between people and organizations.

Cards are private by default. Holding a card doesn't reveal anything about a person unless they choose to show it. Two cards that a person holds can’t be linked: A student could have a card proving that they’re a student at their high school and a card proving that they’re part of the local LGBT center, and no one would know that the two cards belong to the same person unless they were shown together. When a person does share a card, it provides cryptographically strong proof that it was issued by a given community and that the member is in good standing.

The protocol is fully decentralized. Cards are stored on IPFS and registered on a smart contract on Arbitrum One. Anyone can create services which manage cards (called wallet services) or create new ones (called presses). Users are free to choose the card management infrastructure that best suits their needs. No central company owns or controls the membership card ecosystem, though a governance board is responsible for updating the protocol and addressing violations of its rules, such as attempts to conduct fraud.

---

## About the Protocol

The Membership Card Protocol is designed to help people who build community share resources and build trust. Say that the organizer of a local running club decided to hand out cards to its members. She goes on the group’s WhatsApp, posts a link, and anyone in the club can get a card. 

The cards can then be presented anywhere on the internet to prove affiliation or access the club’s resources. The club usually runs on Thursdays, but one member decides to create a “Joinable Runs” calendar. Anyone with a running club membership card can add a time and place where they plan to go running to the calendar, and anyone else with a card can say that they want to join. Another, more competitive member creates a leaderboard of run times for popular routes. Another decides to create a club recipe book that any club member can add to. This makes it easy to create a variety of services for the club across the internet without needing to tie them to a central membership database or single sign on (SSO).

Cards can also be used to build trust. If the club’s founder wants to reach out to the city to ask for resources, she can attach her club founder card and cryptographically verified data about the strength of her club to prove that she is worthy of attention and resources.

---

## Core Flows

### Card Issuance

A community leader creates a **card policy** that defines what a card attests (e.g. that someone is a member of a congregation), who is allowed to issue it (e.g. a pastor), and what the card can be used for. When they want to issue a card to someone, they select the policy and send an offer to the recipient's wallet address.

The recipient's wallet prompts them to accept the offer using biometric authentication. Accepting the offer generates a new keypair which lives on the recipients device and is encrypted and backed up with the wallet service. The wallet returns the new public key, signed with the recipient's key, back to the issuer.

The issuer's wallet packages the signed offer and sends it to a **press** — a trusted third-party service that verifies the offer meets the policy's requirements, posts the card data to IPFS, and registers the resulting content address on the smart contract. Once the press confirms registration, the card is live and the recipient can use it.

### Verification

To use a card, a card holder sends a signed message signed with their card's public key alongside the key itself. The recipient of that message derives a smart contract address from the key and fetches the card's content from IPFS. This yields a verified statement (what the card attests), a link to the policy that created it, and a messaging endpoint, and the full chain of attestations tracing back to a trusted root. 

A **verifier** package walks this chain, checking that every card in the lineage is valid, unrevoked, and was issued by someone authorized to issue it. If everything checks out, the card appears with a green status indicator. Verifiers are lightweight, open-source packages that anyone can embed in a web app, mobile app, or server.

### Backup and Recovery

When a user accepts a new card, their wallet initiates a backup process. The card's private key is encrypted using a key derived from the user's biometric and account credentials (Apple or Google), then uploaded to a **wallet service**. Users can layer in additional recovery factors — a YubiKey, a paper password, or other standard credential — to require multiple factors before a backup can be restored.

If a user loses their device, they authenticate on a new device to retrieve and decrypt their backed-up keys, restoring full access to their cards. The backup scheme is designed so that the wallet service itself cannot read the keys it stores; only the user, with the right combination of credentials, can reconstruct them.

### Messaging

Each card has an associated messaging endpoint managed by the user's wallet service. This allows any party who holds a card to receive messages addressed to it without revealing a personal identifier like an email address. Messages are encrypted to the card's public key, so only the cardholder can read them.

Cards can receive card offers, signed statements, update notifications, and general messages through this endpoint. This is also the channel through which presses notify cardholders when a registration or update is complete.

---

## Protocol Components

### Press

A press is a trusted service that validates and publishes cards. When a card offer is ready, the press:

1. Verifies that the offer meets the constraints of the card creation policy
2. Confirms that the issuer holds a valid badge authorizing them to issue under this policy
3. Posts the card data, encrypted to the recipient's public key, to IPFS
4. Registers the resulting content address on the smart contract, associating it with a mutable pointer derived from the card's public key
5. Handles subsequent updates — appending notes, changing status, or revoking the card — by posting new versions to IPFS and updating the mutable pointer

Anyone can apply to run a press, though they must be authorized to do so and can have that authorization taken away if they act in bad faith. Presses must pay a minimal fee to create cards (roughly $0.005) and can choose to charge for this service. Presses run verified open-source code that is regularly audited by third parties.

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
3. Walks the full chain of attestations — the card's issuer, the issuer's policy, the policy granter's card, and so on — up to a trusted root registered with the Protocol Governance Board
4. Checks that no card in the chain has been revoked, and that each issuer was authorized at the time of issuance
5. Returns a structured result with validity status, the card's attested statements, and any notes or updates on record


### Wallet Service

A wallet service manages the infrastructure that makes cards usable day to day. It:

- Receives and stores encrypted key backups, allowing users to recover their cards across devices
- Hosts messaging endpoints for each card, receiving and routing encrypted messages to the right device
- Notifies users of incoming card offers, updates, and revocations
- Hosts a website and mobile app that can be used to manage cards, receive messages on a user’s device, and navigate services available to cardholders.

Wallet services must be approved by the Protocol Governance Board to be listed as options in open card offers. Because wallet services directly manage a user’s cards, they must prove that no one other than a user is able to access data about that user’s cards without consent. Wallet developers build on a shared open-source package maintained by the Governance Board, ensuring a consistent security baseline across implementations.

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

See `/specs` for the current specification documents.
