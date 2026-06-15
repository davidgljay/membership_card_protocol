Message Lifecycle: Creation, Signing, Verification, and Editing

> **⚠ SUPERSEDED in part — Historical reference only for substrate references.**
> The envelope structure, signing flow, and verification stages in this document are substantively correct. However, substrate references are outdated: "Solana address" → **Arbitrum One registry address**; "Ed25519 public key" → **ML-DSA-44 public key**. Canonical decisions are in `specs/ARCHITECTURE.md` and `specs/card_protocol_spec.md` (v0.3, 2026-05-19).

Envelope Structure
Every message in the system shares a common envelope shape:

{
  "payload": {
    "content": "...",
    "recipients": ["<mutable pointer>", "<mutable pointer>"],
    "timestamp": "2026-05-15T...",
    "in_reply_to": "<hash of prior payload>",    // optional
    "edit_of": "<hash of prior payload>",        // optional, mutually exclusive with retracts
    "retracts": "<hash of prior payload>"        // optional, mutually exclusive with edit_of
  },
  "signatures": [
    {
      "signer_card": "<Arbitrum One registry address of sub-Card A>",
      "public_key": "<signer's ML-DSA-44 public key>",
      "signature": "..."
    },
    {
      "signer_card": "<Arbitrum One registry address of sub-Card B>",
      "public_key": "<signer's ML-DSA-44 public key>",
      "signature": "..."
    }
  ]
}

The payload is canonically serialized (canonical JSON, CBOR, or similar deterministic encoding) so that anyone computing the hash arrives at the same value. The hash of the canonically serialized payload is the message ID — there is no separate ID field.

Message Creation and Signing
The sender composes a message in their client. The client assembles the payload:

Content — the message body.
Recipients — the mutable pointers of intended recipients, included in the signed payload so that the signature binds the sender's statement to a specific audience. This prevents the sender from being misquoted as having said something to someone other than the stated recipients.
Timestamp — when the message was composed, so recipients can distinguish fresh statements from replays.
in_reply_to — if this is a reply, the hash of the payload being replied to.
edit_of or retracts — if this is an edit or retraction of a prior message, the hash of the prior payload.

The client then signs the canonically serialized payload using the device's sub-Card private key. Master Card keys remain in the encrypted keyring and are not used for routine message signing — this is the two-tier model that lets the master key stay cold while devices sign day-to-day.

Each entry in the signatures array contains three fields: the signature over the canonical payload, the signer's ML-DSA-44 public key, and the signer's Arbitrum One registry address — the on-chain entry that points to the current head CID of the sub-Card's iteration history. Including the public key inline lets a verifier check the signature immediately without an on-chain lookup; the registry address is retained so the verifier can confirm the key is current (i.e., the sub-Card hasn't been rotated or deregistered) by resolving the on-chain pointer when freshness matters.

For parallel co-signing (a single user signing with multiple Cards representing multiple parts of their reputation, or multiple users co-authoring a statement), each signer produces an independent signature over the same canonical payload. All signatures appear in the signatures array. A consumer verifies each signature independently.

For private messages, the entire signed envelope is then encrypted to each recipient's master public key, resolved from the recipient Card's current metadata via their mutable pointer. The encrypted envelope is routed through Nym to each recipient's gateway, arrives at the recipient's message server, is transformed via UMBRAL proxy re-encryption into ciphertexts encrypted to each of the recipient's active sub-Cards, and is queued for device pickup.

Encryption to the recipient Card's listed public key prevents network-level interception. It does not prevent Card substitution — the attack where you think you're contacting Alice but the pointer you have actually belongs to someone else. That binding between human-meaningful identity and mutable pointer lives outside the cryptographic system and is bootstrapped through out-of-band channels (in-person fingerprint verification, trusted introductions, accumulated annotations).

Verification on Receipt
The recipient's device pulls queued ciphertexts from the message server, decrypts each with the local sub-Card private key, and obtains the signed envelope. Verification proceeds in stages:

Signature validity. For each signature in the envelope, the client takes the public key from the signature entry and verifies the signature against the canonically serialized payload. This check requires no network call. If any signature fails to verify, that signature is marked invalid; the message may still have other valid signatures.

Sub-Card to master link. For each valid signature, the client resolves the sub-Card's mutable pointer and confirms that this sub-Card appears in the active sub-Card list of its claimed master Card's metadata, and that the master Card signed the sub-Card registration. This is the device-delegation link.

Master Card chain walk. From each master Card, the client walks the issuance chain link by link via mutable pointers: fetching each link's current metadata, verifying the issuer's signature, checking the append-only log for revocations, validating that scope at each link does not exceed the issuing Card's scope, and continuing up until reaching either a trusted root (success) or an unrecognized root (chain doesn't reach trusted ground).

Revocation checks. At each link in the chain, the client reads the append-only log via the mutable pointer to check for revocation entries. The freshness window depends on the recipient's policy. A revoked link invalidates the chain from that point downward, though the distinction between policy revocation (forward-only) and key compromise (retroactive) affects how prior signed statements are treated.

Annotation lookup. The client queries EAS/IPFS for third-party annotations referencing each Card in the chain, filters them by whether the annotation signer's own chain validates to a root the recipient trusts, and assembles the relevant annotation context.

Recipient-set check. The client confirms its own Card's mutable pointer appears in the message's recipients list. A message whose recipient list does not include the receiving Card is technically valid but was not addressed to this recipient — the client may surface this differently (e.g., as a forwarded message rather than a direct one).

Replay and freshness check. The client checks the timestamp against the current time and against any previously seen message with the same hash.

The verifier returns a structured result for each signature: signature valid/invalid, chain reaches trusted root or not, scope clean or violation at link X, revocation status (none/policy-revoked/key-compromised) with freshness metadata, annotation context. The recipient's UI decides how to present this — the verification machinery returns the facts and the display layer interprets them.

Edits
An edit is a new signed message whose payload includes an edit_of field pointing to the hash of the prior payload. The edit message has its own hash, timestamp, and signatures. It does not mutate the original — the original remains a valid signed object that may already have been delivered, forwarded, or referenced by replies.

Authorization to edit. The recipient's client confirms that the edit's signers chain to the same master Card(s) as the original's signers. Edits from a different sub-Card of the same master are valid (Alice editing from her phone what she sent from her laptop); edits from an unrelated Card are not. For co-signed messages, an edit signed by the full original signer set is a full edit; an edit signed by only some original signers is a partial amendment and should be displayed differently.

Edit chains. Successive edits reference the immediate predecessor, forming a linked list (A → A' → A''). This preserves the full edit history and lets a recipient reconstruct what changed when. Each edit is independently signed and independently verifiable.

Encrypted message edits. Because each message is encrypted to a specific recipient set, edits are best-effort — a recipient who received the original but not the edit will see the original only. The sender's client encrypts the edit to the same recipient set as the original (or a subset), but delivery is not guaranteed.

Replies to edited messages. A reply's in_reply_to points at a specific message hash. If that message is later edited, the reply still validly references the original — the original still exists and still verifies. The UI should display the reply in context with both the original and edited versions visible.

Retractions
A retraction is a separate primitive from an edit. A signed message with retracts: <hash> says "treat the prior message as withdrawn." Authorization rules are the same as for edits — only signers chaining to the original's master(s) can retract. Unlike an edit, a retraction does not propose new content; it asks recipients to card the original as withdrawn.

Whether a retracted message's content is hidden in the UI or shown with a "retracted" indicator is a display choice. The cryptographic facts are: the original was validly signed at the time, the retraction is validly signed now, and the sender has formally withdrawn the statement.

What Carries Forward Outside This Spec
Several adjacent concerns are noted but deferred:

The structured result format and UX presentation of verification outcomes.
Fetch budget and caching strategy for chain and annotation lookups.
Trust-root configuration UX — how recipients establish which Cards are trusted roots, and how those settings are managed across devices.
Bootstrap UX for first contact, including pointer fingerprint comparison flows.
Edit acknowledgment semantics for cases where guaranteed edit delivery matters.

The cryptographic and envelope-level mechanics are settled; these remaining items are interface and policy layers that ride on top.
