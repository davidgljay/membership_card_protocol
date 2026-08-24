# Membership Card Protocol

*A secure tool for building trust and exchanging resources in community.*

---

## Overview

The Membership Card Protocol lets communities issue digital membership cards — a little like a library card, a union card, or a student ID. These cards prove that someone is a trusted member of a community. They can be used to access that community’s resources, send and receive messages, and facilitate trust between people and organizations.

Cards are private by default. Holding a card doesn't reveal anything about a person unless they choose to show it. Two cards that a person holds can’t be linked: A student could have a card proving that they’re a student at their high school and a card proving that they’re part of the local LGBT center, and no one would know that the two cards belong to the same person unless they were shown together. When a person does share a card, it provides cryptographically strong proof that it was issued by a given community and that the member is in good standing. See [https://membershipcard.io/assurances](https://membershipcard.io/assurances) for more info.

The protocol is fully decentralized. Cards are stored on IPFS and registered on a smart contract on Arbitrum One. Anyone can create services which manage cards (called wallet services), create new ones (called presses), or help obfuscate end user data from wallet services and presses (called relays). Users are free to choose the card management infrastructure that best suits their needs. No central company owns or controls the membership card ecosystem, though a governance board is responsible for updating the protocol and addressing violations of its rules, such as attempts to conduct fraud.

---

## About the Protocol

The Membership Card Protocol is designed to help people who build community share resources and build trust. Say that the organizer of a local running club decided to hand out cards to its members. She goes on the group’s WhatsApp, posts a link, and anyone in the club can get a card. 

The cards can then be presented anywhere on the internet to prove affiliation or access the club’s resources. The club usually runs on Thursdays, but one member decides to create a “Joinable Runs” calendar. Anyone with a running club membership card can add a time and place where they plan to go running to the calendar, and anyone else with a card can say that they want to join. Another, more competitive member creates a leaderboard of run times for popular routes. Another decides to create a club recipe book that any club member can add to. This makes it easy to create a variety of services for the club across the internet without needing to tie them to a central membership database or single sign on (SSO).

Cards can also be used to build trust between communities. If the club’s founder wants to reach out to the city to ask for resources, she can attach her club founder card and cryptographically verified data about the strength of her club to prove that she is worthy of attention and resources.

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

### Card Documents

The content that makes up a card is encrypted and stored on the decentralized filestore IPFS. A card consists of:

1. A card title (e.g. "Church Choir Member")
2. A link to an image to be displayed with the card
3. A link to the policy under which the card was created. This shows who authorized the creation of the card, who is allowed to issue it, etc.
4. A link to the person who issued the card.
5. Links to a chain of attestation going back to a trusted root. It says "this choir card was issued by the choir lead, whose card was issued by the priest, whose card is directly linked to the chuch's website, which was verified by a verifier script that is widely known and trusted."
6. A public key associated with the card. The private key is held by the cardholder.
7. A cryptographic signature from both the cardholder and the card issuer.

The card can be shared by signing a statement and attaching the card's public key. The public key can be used to locate the card document on IPFS and decrypt it. Why decrypt with a public key? So that a malicious third party can't easily scan every card on the protocol and read its contents. A card cannot be read until it has been shared.

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

### Relay

The relay is a message buffer that lets a wallet service deliver encrypted messages — card offers, notifications, and general messages — to a holder’s device without the wallet service learning the end user's identity. This prevents a wallet service from associating a set of cards with a particular IP address or device ID. A relay:

- Provides end-users with single-use UUIDs that can deliver a notification or other connection to a device.
- Provides infrastructure for connecting end users, wallet services, and presses via OHTTP.
- Hosts endpoints to receive a message along with a single-use UUID and pass it on to a device via an open connection or push notification.

When an end user sets up a card on their phone, their device will automatically reach out to one or more relays to register itself and collect a set of UUIDs. It will then contact its preferred wallet service through one or more relays via OHTTP to register those UUIDs with its cards. It will stagger this registration over time, so that the wallet service can't associate the cards with a single user.

If a message comes in, the wallet service will make a POST request to the appropriate relay with a single-use UUID. The relay will look up the user's device info and notify them that a message has been received. To retrieve the message the end user will connect to the wallet service via OHTTP, download the message, and decrypt it locally.

### Matrix Server

Communities can host card-gated group chat rooms on a Matrix homeserver. A policy module governs who may join and post in a room using the same predicate system that governs card issuance, so access follows a community’s existing policies rather than a separate membership list. This gives cardholders a group messaging surface alongside the protocol’s direct card-to-card messaging, without requiring the homeserver operator to see which cards are talking to each other.

---

## Specification

The full protocol specification covers:

- Card data structure and IPFS encoding
- Card creation policy format and constraint language
- Press verification and registration procedures
- Smart contract interface and governance
- Verifier logic and chain-walking algorithm
- Wallet service requirements and backup encryption scheme
- Card update and revocation status codes (200-range endorsements, 800-range silent revocations, 900-range loud revocations)
- Open offer format for distributing cards via QR code or link
- Notary service patterns for anonymization

See `/specs` for the current specification documents.

---

## Instructions for Running Card Infrastructure

*Coming soon!*
