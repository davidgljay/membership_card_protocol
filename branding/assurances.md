# The Assurances

*Phase 2.1 deliverable. Draft 1, 2026-08-16. **Not yet approved — every assurance requires David's individual sign-off before it appears anywhere.***

---

## Method

These are **design guarantees**: what the Membership Card Protocol is built to promise. They are stated plainly, in public, so that they can be tested against the implementation and audited by people who know how to break things.

This is deliberate. A protocol that asks communities to trust it owes them claims specific enough to be proven wrong. Vague promises can't be audited, and unauditable promises aren't worth much.

**What this list is:** what the protocol is designed to guarantee and is being audited against.
**What it is not:** a claim that each guarantee has been independently verified today.

The methodology is only honest if the testing actually happens and the results are published, including the unflattering ones. That obligation is part of the assurance.

**Structure.** Each assurance has a plain rendering and a technical rendering. They are the *same claim* — not a simplification and an unrelated footnote. Where a guarantee has limits, the limits are stated in the assurance rather than buried.

---

## A0 — A card helps you prove that you are trustworthy and lets you access shared resources

**Plain.** A card lets you prove a statement about yourself and lets online services act on it. Show your card and a claim comes with it — *this person is a member of the running club*, *this person is a licensed pediatrician* — along with proof it was really issued to you and not copied from someone else. Any service can check a card before letting someone in, so a community can put a calendar, a chat space, a lending library, or anything else behind its own card without building accounts, passwords, or a membership database.

Two uses, one mechanism:

- **Verify a statement.** Attach your card to a message so the person reading it knows why it’s worth trusting.
- **Gain access.** Present your card to a service, which checks it and lets you in.

**Technical.** Proof is a signature which points to a document on IPFS, a decentralized filestore.

To present a card, the holder signs a statement with the private key attached to that card and sends three things: the statement, the signature, and the public key. The verifier then:

1. Checks the signature against the supplied public key.
2. Derives the on-chain registry address, `keccak256(pubkey)`, and reads the registry entry to get the current log head.
3. Fetches the referenced document from IPFS and decrypts it with a content key derived from the same public key. This ensures that cards need to be shared to be read.
4. Reads the result: the verified statement, a pointer to the policy that created it, and the ancestry needed to trace a verifiable path to a trusted root.
5. Walks the chain to a trusted root (A1) and applies the log's revocation and update semantics (A2).

Verification is a library, not a service — an open-source package embedded in a web app, mobile app, or server. It needs no permission from anyone, no API key, and no call home.

**This does not mean** verification is free of dependencies. A verifier needs to read the Arbitrum One registry and fetch content from IPFS, so it needs network access to both, though it does not rely on any centralized service.

**Basis.** `ARCHITECTURE.md` §7 Verification, ADR-006; `specs/object_specs/card_verifier.md`.

---

## A1 — You can see why a card was given, and by whom

**Plain.** Every card carries a chain of verification. When someone shows you a card, you can see who issued it, why it was issued, and why the issuer is who they say they are — following the chain back to a root you already trust. You aren't taking anyone's word for it.

**Technical.** Each card document references an issuer as well as an issuing policy and its ancestry. A verifier walks the chain from the presented card to a trusted root, checking at each link that the signature is valid, the issuer was authorized under the governing policy, and the issuing card was unrevoked at the time of issuance. 

**This does not mean** the chain tells you a person is trustworthy. It tells you who vouched for what, and lets you decide whether you trust *them*.

**Basis.** `ARCHITECTURE.md` §7, ADR-006; `specs/subcards.md`.

---

## A2 — A card reflects current standing, not past standing

**Plain.** Cards can be updated and revoked. If someone's standing changes, the person who issued the card (or someone else authorized to) can update or revoke it. A card you're shown tells you where things stand now — not where they stood when it was issued.

**Technical.** Cards include an append-only log of updates. Some of these are benign (key rotation), others are revocations. Updates are marked with codes to determine type, eg card revocations are codes (800–999). To allow for updates and manage updating permissions cards are registered on a smart contract on Arbitrum One. 

When a card is created or updated a service called a press posts the latest version to IPFS and then updates the smart contract to point to it. These presses handle the technical details of updating, abstract away details like gas for smart contracts, and provide an easy endpoint to nontechnical card issuers. There can be many presses. An invalid card is caught the first time it is verified — the check runs against the policy and the chain, not against the press's word — at which point the governing body is notified and the press that posted it faces deregistration. A misbehaving press can therefore only post cards that are never shared, and a card that is never shared does nothing.

**This does not mean** revocation propagates instantly everywhere. It means revocation is authoritative and cannot be hidden from a verifier who checks.

**Basis.** `ARCHITECTURE.md` ADR-003, §Log Entry Structure; `specs/object_specs/press.md`.

---

## A3 — A card says why you're trustworthy and nothing else

**Plain.** A card proves one thing — that you're a member of a community, a licensed practitioner, a student at a school — without revealing anything else about you. They allow you to be both anonymous and verified. A card issuer can optionally include additional identifying information, and card recipients can choose whether or not they will accept it.

**Technical.** A card asserts the statement defined by its issuing policy. Personally identifying fields appear only where the policy specifies them, and the holder must countersign at issuance for the card to be valid. Cards do not link back to any central account or other concept of identity. 

**This does not mean** a card is contentless. Presenting a card reveals the card's statement and its issuance chain.

**Basis.** `ARCHITECTURE.md` ADR-006; `specs/card_protocol_spec.md`.

---

## A4 — Your cards are separate from each other

**Plain.** The cards you hold are not connected. You can show a professional credential in one place and a fan club card in another, and there's no way to tell that they belong to the same person unless you choose to present them together.

**Technical.** Each card has its own keypair, its own registry address derived one-way from its public key, and its own content key. There is no shared identifier across a holder's cards, and no directory that enumerates them. This is true even in the federated services that maintain the card infrastructure. A card is undiscoverable without its public key; presentation is the only disclosure mechanism.

**This does not mean** that behavioural correlation is impossible — two parties comparing timing, context, or activity may still draw inferences. It means the protocol itself provides no linkage.

**Basis.** `ARCHITECTURE.md` ADR-006, §Privacy posture; `specs/subcards.md`.

---

## A5 — Losing your phone doesn't mean losing your cards

**Plain.** Your cards live on your device, and you can get them back if that device is lost, stolen, or replaced. Recovery doesn't depend on the company that gave you the card, or on any single service staying in business. You choose how strong to make it: a hardware key, a paper password, or another credential can be layered in so that no single lost thing is enough for someone else to take your cards.

**Technical.** Keys are two-tier:

- **Sub-card keys** — used for day-to-day signing — are generated and held in the device's Secure Enclave or TPM. They never leave it.
- **The master card key** — used for creating sub-cards and rotating keys — lives in an **encrypted keyring blob**, encrypted under a key derived from `passkey + service_secret`. Neither factor alone can decrypt it. The blob is append-only: keys are added and never removed, so recoverability survives every rotation.

**How a wallet service holds your backup without seeing it.** The wallet service stores the encrypted blob and nothing else. The decryption key is derived from factors the service does not hold — your passkey plus a separate service secret — so possession of the blob is not possession of the keys. Per ADR-009-AMEND, the blob is replicated across the wallet service federation using ordinary deletable storage rather than IPFS, precisely so it can be *changed and deleted*: it's rewritten on every card acceptance and rotation, and it has no third-party verification requirement because only its owner ever decrypts it.

**Recovery via hardware key.** The holder registers a YubiKey with a backup service, which stores the keyring decryption key wrapped under a YubiKey-derived key — never seeing it in plaintext. To recover: present the YubiKey, and the service opens a **72-hour cancellation window** with multi-channel notifications. If no cancellation arrives, it releases the wrapped key, the YubiKey unwraps it locally behind a PIN, and the holder pulls the keyring blob from any wallet service in the federation. A stolen YubiKey cannot complete recovery if the real owner cancels inside the window.

**This does not mean** every recovery path is equally strong, or that recovery is automatic. It's a deliberate trade: keys that are trivially recoverable are also trivially stealable. Social recovery via a guardian quorum is deferred to a future version.

**Basis.** `ARCHITECTURE.md` ADR-009, ADR-009-AMEND.

---

## A6 — Every card is a secure inbox

**Plain.** People can reach you through a card without ever learning your email address or phone number. This lets you join communities or verify with services without sharing a phone number or email that can be used to track you, spammed, sold, or leaked in a breach. You can filter messages both by which cards they come to and which cards they come from. This makes it easy to focus in on messages that relate to one part of your life, or quickly filter inbound messages for ones worth your time.

**Technical.** Every card has an associated messaging endpoint operated by the holder's wallet service. Messages are end-to-end encrypted to the card's ML-KEM public key (A10), so the wallet service routes without reading: the outer envelope carries only the recipient card hash, while sender identity, message type, and content sit inside the encrypted payload. Communication between the wallet service and end users happens through a series of relay services, so wallet service operators cannot use metadata to infer which cards belong to the same person. 

This is also the protocol's own control channel: card offers, signed statements, update notices, and press registration confirmations all arrive through these inboxes.

**This does not mean** an inbox is unsolicited-message-proof. It means the messages carry verified provenance — you can see what card is writing to you and why it's trustworthy — and that reaching you requires holding a card, not knowing a personal identifier.

**Basis.** `ARCHITECTURE.md` ADR-007; `specs/messaging_protocol.md`; `process_specs/message_routing.md`.

---

## A7 — Cards carry accountability as well as trust

**Plain.** If someone uses a card to gain access and then behaves badly, the community that issued it can be told — even if that person is anonymous to the people they harmed. The report carries proof, not a screenshot. The issuer can then act: a warning, or revoking the card entirely. Anonymity isn't impunity.

**Technical.** There is a clearly defined process for identifying and messaging card granters when a card holder violates community norms. The report includes proof of the cardholder's actions: the relevant content, signed by their card. If card granters fail to act, third-party trust and safety services focused on defined harm categories — CSAM prevention, for example — can flag the card.

**This does not mean** the issuer learns who the person is. It means the issuer can act on the card they granted, which is usually the party best positioned to intervene.

**Basis.** `ARCHITECTURE.md` ADR-008.

---

## A8 — The infrastructure can't watch you

**Plain.** The services that make cards work — the ones that register cards, route messages, and back up your keys — are built so that **no single one of them can see what cards you hold or what you do with them.** The knowledge is deliberately split apart, so that no operator, including us, holds enough of it to watch you.

**Technical.** Stated per component, because a single global claim isn't verifiable:

- **Wallet services** route messages using only the recipient card hash from an outer envelope. Sender identity, message type, and content sit inside the end-to-end encrypted payload. Since the UMBRAL re-encryption design was removed, wallet services hold no key material capable of acting on ciphertext at all. Wallets also back up encrypted keyrings delivered via OHTTP. The backup process does not reveal the cards being backed up or where they are being backed up from.
- **Presses** are constrained by card-content encryption and by the audit-encryption model. They verify that cards are valid before posting them and handle details like gas for Arbitrum One so that card issuers don’t have to. If a press posts an invalid card, that card will be flagged the first time it is shared and the press’s credentials will be revoked.
- **Relays** implement OHTTP and route message notifications to devices. A cardholder's device automatically collects one-time message codes from relays and then registers them with their wallet service via OHTTP. When a message comes in the wallet service routes it to the appropriate relay with the one-time message code, and the relay then looks up which device to notify about the message. Data linking cards and messages lives on wallet services; data linking messages and devices lives across a network of relays. Neither half is sufficient on its own — reconstructing who received what requires a wallet service and multiple independent relay operators to actively conspire against a specific person, and each additional relay in the path raises the number of parties who would have to agree to it. The split is the guarantee: the system is arranged so that the knowledge needed to watch someone never sits in one place.
- **The registry** stores one-way address hashes and CID pointers. An observer without a card's public key sees that a transaction occurred, when, and which press paid for it. They can see which CIDs are being created, but not read the content of cards or see which organizations issued them.

**This does not mean** nothing is observable. On-chain writes are public events with timestamps and a visible fee payer. Traffic-analysis and timing correlation are outside what encryption addresses.

**Basis.** `ARCHITECTURE.md` ADR-006, ADR-007; `process_specs/message_routing.md`; `specs/object_specs/relay.md`.

---

## A9 — You can choose from many infrastructure providers or start your own

**Plain.** The Membership Card Protocol is federated. Anyone trusted can run the infrastructure — the services that issue cards, relay messages, and hold backups. No company sits in the middle, and no one can buy their way into that position. It's open source, and a community that doesn't like how a service is run can move to another or run their own.

There is some need for governance. This will be performed by a board chosen by active participants in the protocol. The governing body is in charge of:

1. Updating the rules of the smart contract to better meet the community’s needs.
2. Responding if a press posts an invalidated card.
3. Responding if a relay or wallet service colludes to reveal private information.

The board does not run infrastructure, hold anyone's data, or decide who may operate a service — anyone meeting the protocol's requirements can. Its mandate is deliberately narrow: the less the board is able to do, the less it matters who sits on it.

**Technical.** Presses, relays, wallet services, and notaries are independently operated roles, authorized by cards rather than by a central administrator. Card state is anchored on a public chain and content is stored on IPFS, so no single operator holds the authoritative copy. A governance board maintains the protocol and adjudicates rule violations; it does not own the infrastructure or the data.

**This does not mean** there's no trust involved. Federation moves trust from a company to an operator — protection comes from the trustworthiness of whoever runs a given piece of infrastructure, not from infrastructure that's impossible to tamper with. Operators are identified by card, so you can see why they’re deserving of trust.

**Basis.** `ARCHITECTURE.md` ADR-001, ADR-002; `governance/`.

---

## A10 — Cards are built for the long term

**Plain.** Cards use encryption designed to hold up against future attacks, including attacks by quantum computers that don't exist yet. Messages sent between cards are end-to-end encrypted, and sharing a card establishes a channel that can't be intercepted in the middle.

**Technical.** 
Cards either rest on post-quantum cryptography by default or have a clear migration path:

| Job | Primitive | Post-quantum |
|---|---|---|
| Signing content stored on IPFS | **ML-DSA-44** (FIPS 204) | Yes |
| Encrypting messages between cards | **ML-KEM-768** (FIPS 203) | Yes |
| Authorizing on-chain registry writes | **secp256r1** via RIP-7212 | No — by design, with a built-in migration path |

Content signatures are post-quantum from day one because IPFS content is permanent and cannot be re-signed. On-chain write authorization uses classical secp256r1 because the signature is consumed at verification time — what persists is the state change, not the signature — and keys are rotatable.

**Basis.** `ARCHITECTURE.md` ADR-004, ADR-007, ADR-012; `specs/messaging_protocol.md`.

---

# What we do not promise

- **Cards cannot build a community for you.** They give an existing community capabilities it didn't have. They don't create trust, convene people, or resolve conflict — that's organizing, and it needs to be done by skilled organizers. Our hope is that cards can help these organizers achieve their goals and demonstrate their value.
- **Federation means trusting operators, not trusting no one.** The protocol makes it visible who you're trusting. It doesn't remove the need to trust. Building and maintaining trust requires organizing, which the protocol can’t do on its own and can’t operate without.
- **We are not claiming these guarantees are verified today.** They are the design targets, published so that we can be tested and held accountable. We have a plan to live by these assurances, but the system requires further scrutiny and testing. The protocol is in development, and actively seeking feedback from cybersecurity experts and community organizers with relevant experience.

