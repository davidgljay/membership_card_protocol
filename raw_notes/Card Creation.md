Card Template Lifecycle: Technical Summary

> **⚠ SUPERSEDED — Historical reference only.**
> This document was written when the registry substrate was Solana. The canonical decisions are in `specs/ARCHITECTURE.md` (v1.0, 2026-05-19). Key changes: registry is **Arbitrum One** (not Solana); signatures are **ML-DSA-44** (not Ed25519); "PDA" → **registry address**. Inline strikethroughs below indicate superseded text.

## Card Address Model
A Card's stable address is ~~a Solana Program Derived Account (PDA) managed by a single deployed Card program~~ **an entry in the Arbitrum One registry contract**. That account is a mutable pointer — it always points to the current head CID of an append-only log stored on IPFS. The log itself is immutable and content-addressed; only the Solana pointer moves as new entries are appended or the Card is updated. This means a Card can be updated or revoked trustlessly (Solana provides authoritative, verifiable state) while its full history remains permanently retrievable from IPFS by walking the log from the head.

### Privacy model for Card addresses

Card addresses and content are private by default. The privacy posture is determined entirely by client-side choices; the on-chain contract is neutral.

**Address derivation:** By default, the registry address is derived from keccak256(sign(private_key, "card-address-v1")) rather than from a public key. The resulting address is opaque — not discoverable or linkable to any identity without the private key. Because ~~Ed25519~~ **ML-DSA-44** signatures are deterministic, the address is always re-derivable from the same key. An owner who wants a fully public Card simply uses their public key as the address seed instead.

**Two keys per private Card:**
- *Address secret* — derives the registry address. Controls who can find the account. Never shared.
- *Decryption key* — decrypts the on-chain CID. Grants read access. Shareable independently.

**On-chain CID storage:** For private Cards, the CID stored in the ~~Arbitrum One registry entry~~ **Arbitrum One registry entry** is encrypted with the owner's decryption key. The press posts ciphertext and never holds the decryption key.

**Capability bundle:** To share a private Card, the owner provides a recipient with an (address, decryption_key) pair — the "capability bundle." This can be encrypted via ECDH to the recipient's public key to tie it to their identity. Anyone holding the bundle can verify the Card but cannot update or revoke it.

**What an observer sees:** Transactions to the program (timing and fee payer) are always visible. Without the address secret, an observer cannot correlate transactions to identities or follow the pointer to content.

**Privacy spectrum:**
- *Public:* pubkey-derived address, plaintext CID — discoverable by anyone who knows the owner
- *Selectively shared:* secret-derived address, encrypted CID — capability bundle shared with specific recipients
- *Fully private:* secret-derived address, encrypted CID, encrypted IPFS content

1. Contents of a Card Template Policy
A Card template policy is a structured JSON document, signed by the authorizing Card, that fully specifies how a Card Press will operate. It contains:

Identity and authority:

A stable policy ID (CID of the signed policy blob)
Mutable pointer of the authorizing Card (e.g., the superintendent's Card)
Mutable pointers of any audit-authority Cards (often but not necessarily the same as the authorizer)
valid_until timestamp bounding the template's authorized lifetime

Output Card specification:

Schema for the Cards this template will produce (field names, types, required vs. optional)
A schema reference that issued Cards will embed, allowing verifiers to confirm conformance
Recipient mode: targeted (issuer specifies recipient), open (anyone presenting valid inputs), or requested (recipient initiates)
An optional image CID field: a content-addressed IPFS link to an image representing the Card visually, intended for display in a hexagonal frame. If the policy includes this field, the issuer may supply a specific image CID at issuance time; if left unspecified, no image is included in the issued Card

Authorization rules (who can invoke):

A predicate over the requester's Card chain (e.g., "Card must chain to superintendent Card X via the school-administrator template")
Optional rate limits per requester (per day/week/month)

Verification rules (what additional evidence the request must include):

Required co-signed statements from specified Card types
Required external attestations if any (e.g., Reclaim-style HTTPS verification)

Metadata fields:

Typed, constrained open fields the issuer can populate at issuance time (e.g., school name from an approved list, enrollment year as integer)
Whether each field is required or optional, and any per-field validation rules

Operational rules:

Log mode: exclusivity (one update per Card for verifiable counting), timing-cover (constant-rate updates to hide issuance timing), or minimal
Log entry granularity (per-Card or batched-with-public-count)
Revocation freshness window (max staleness for revocation status checks during issuance)
Notification destinations for issuance summaries (typically the authorizer's Card)

Annotation policy (optional):

A reference to a signed annotation policy governing who may publish issuer annotations to Cards produced by this template, and what kinds of entries they may add
If absent, only the original issuer may annotate

Revocation semantics:

Whether revocation of the template Card cascades to Cards it issued, and under what reason codes (policy revocation: forward-only; key compromise: retroactive)

2. Creating and Approving the Policy
The drafting and approval flow:

The drafter (e.g., the school administrator) assembles the policy JSON.
The drafter submits the policy to the authorizing party (superintendent) out of band, along with explanation of intent.
The authorizer reviews the policy. If approved, she signs the policy blob with her Card's private key.
The signed policy is now a content-addressed object — its CID becomes the stable policy ID.
The signed policy is published to IPFS so that any future verifier, hoster, or migration target can fetch it by CID.

The policy ID is the durable identifier that survives across Card Press deployments. Press instances come and go (with hoster changes, code upgrades, key rotations); the policy ID remains stable, and Cards issued by successive deployments of the same policy form a coherent set.

3. Shopping for and Approving an Execution Environment
The administrator selects a Card Press hosting service. Card Presses are operated as a service and can accept arbitrary approved policies. The protocol's trust model means the hoster cannot forge Cards — they can only run or refuse to run the attested code — so the choice is about reliability, jurisdiction, attestation transparency, and price rather than about extending trust to the hoster's intentions.

The deployment and approval flow:

The administrator sends the signed policy blob to the hoster's deployment endpoint.
The hoster spins up an enclave (e.g., Nitro Enclave on a parent EC2 instance) running the standard, audited, open-source Card Press code. In multi-tenant configurations, an existing shared enclave may add the new policy to its loaded set rather than spinning up dedicated infrastructure.
On policy load, the enclave generates a fresh keypair internally. The private key never leaves the enclave.
The enclave produces an attestation document containing the PCR values (hashes of the running code), the new keypair's public key, and a hash of the loaded policy. The document is signed by the hardware attestation root.
The hoster returns the attestation document and the enclave's public key to the administrator.
A local script on the administrator's machine verifies:

The attestation document is signed by the genuine hardware attestation CA.
The PCR values match the current approved binary hash from the protocol's published transparency log of approved code versions.
The policy hash in the attestation matches the policy the administrator submitted.
The enclave's public key in the attestation matches what the hoster returned.


If all checks pass, the administrator forwards the attestation bundle to the superintendent.
The superintendent signs a template Card binding her authority to:

The enclave's public key
The attestation document
The approved code version hash
The policy ID and policy hash
The hoster identifier


The signed template Card is published to IPFS and its mutable Arbitrum One registry pointer is registered, pointing to the head of the template's IPFS log.

The template Card is now the runtime trust anchor: any Card issued by the enclave chains to this template Card, which chains to the superintendent. Verifiers walking the chain can confirm not just "the superintendent authorized this template" but "the superintendent authorized this specific policy running on this specific attested code in this specific enclave."

4. Publishing the Template
Publication makes the relevant pointers and CIDs discoverable to the right audience:

The template Card's mutable pointer is distributed to the parties authorized to invoke it — typically via Nym to their recipient Cards.
The policy CID and template Card pointer can also be listed in a public template directory if discovery beyond the authorized group is desired.
The hoster exposes an invocation endpoint included in the template Card's metadata.
The hoster begins serving the enclave's first log entry (empty log, signed by the enclave key) at the deterministic IPFS location committed to in the template Card. The log's head CID is anchored in the template's Arbitrum One registry entry.

5. First-Card Issuance via Invitation Link
For new participants who do not yet hold any Card, issuance happens via an invitation link. The Card ecosystem is invite-only at this stage.

The invitation flow:

The administrator (or the enclave on the administrator's behalf) assembles a proposed Card JSON per the policy schema, with all issuer-populated metadata fields filled in. This includes the image CID field if the policy specifies one — the issuer supplies the IPFS CID of the image at this stage, before the enclave signs the offer. The recipient's public key field is left empty — it will be supplied by the recipient.
The enclave signs this proposed Card JSON (including the empty public key field) with its keypair, producing a signed offer.
The offer is encoded into an invitation link (e.g., as a base64 payload in a URL) and delivered to the recipient out of band — via email, SMS, or any other channel.
The recipient opens the invitation link. Their client presents a setup flow: create a new keyring, generate a fresh keypair for this Card, and store the private key in the keyring.
The recipient adds their public key to the proposed Card JSON and signs the completed document with their new private key.
The recipient (or their client) posts the completed Card blob — containing the enclave's signature on the offer and the recipient's public key plus countersignature — to IPFS. Any party can perform this posting step; it requires no further involvement from the enclave, because the cryptographic content was already finalized when the recipient added their key and signature.
The Card Press registers a mutable Arbitrum One registry entry for this Card, with its pointer set to the head CID of the Card's new IPFS log.
The completed Card's Arbitrum One registry address is now the recipient's stable Card identity.

This flow requires no prior Card to receive an invitation. It is the entry point for new participants.

6. Subsequent Issuance to Existing Participants
Once a participant holds a Card, subsequent Cards can be offered directly via Nym. The enclave sends the signed offer (with empty public key field) to the recipient's existing Card's Nym gateway. The recipient evaluates the offer in their client, generates a fresh keypair if accepting (or reuses their master key — an implementation choice), adds their public key and countersignature, and posts the completed Card to IPFS.

The mutual-signing pattern: the enclave commits to the Card's content (including all issuer-defined fields) by signing the offer. The recipient accepts scope by adding their public key and countersigning. Neither party can unilaterally alter the completed Card.

7. Logging, Posting, and Notification
After the recipient posts the completed Card to IPFS:

The recipient (or their client) notifies the enclave's endpoint with the CID of the posted Card.
The enclave verifies that the CID matches a valid completion of an offer it previously signed, and that the recipient's countersignature is valid against the public key embedded in the posted document. This verification is a consistency check — anyone can perform it, since the cryptographic commitments are fully visible in the posted blob.
The enclave updates its issuance log:

It constructs a log entry per the policy's log mode. The entry includes the Card's CID (which the press necessarily knows, having performed the IPFS upload and chain write), encrypted with the policy authorizer's audit key. Only the authorizer can read the log; no one else — including the press operator — can reconstruct which CIDs were issued under the policy.
It produces a new log root incorporating the new entry, signs it, and publishes both the entry and the new root to IPFS.
The Arbitrum One registry entry for this Card is updated to point to the new log head CID.

Note on key separation: the policy authorizer holds two distinct keys — a policy control key (governs what the press may do) and an audit key (encrypts the issuance log). These must be separate keypairs. A compromised audit key must not grant policy control.


The enclave produces a Signed Card Inclusion Proof (SCIP): a small signed object binding the Card's CID to its log entry index and the log root at time of inclusion.
The enclave sends notifications via Nym:

To the recipient: the SCIP and a confirmation.
To the issuer (administrator): the Card's CID, the SCIP, and an audit record, encrypted to the administrator's Card.


The enclave writes a periodic summary entry destined for the authorizer (superintendent), encrypted such that only the audit-authority Card can decrypt.

The Card is now live. The recipient holds the private key for the Card's keypair in their keyring. The Card's full provenance is verifiable by anyone: resolving the Arbitrum One registry address, a verifier reads the current log head CID, walks the append-only IPFS log, fetches the current version, finds the recipient's countersignature, the enclave's signature, the template Card (with attestation and policy hash), the superintendent's authorization, and on up to the chain's root of trust.

Note on enclave involvement in posting: The most sensitive operation is the enclave signing the proposed Card JSON. The subsequent steps — recipient adding their key, posting to IPFS, and the enclave logging the inclusion — are comparatively straightforward and do not require the enclave to be uniquely involved. The cryptographic commitments are already established; the posting and logging steps are administrative, and their correctness is verifiable by anyone reading the posted blob.
