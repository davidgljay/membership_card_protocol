Annotation, Update, and Revocation System

Two Distinct Annotation Systems
The Card protocol has two separate annotation mechanisms that should not be confused:

Issuer annotations — entries added by the issuer to the Card's own append-only log. These are part of the Card's authoritative record and are read during standard chain verification. They are governed by the same policy that created the Card, or by a separate annotation policy if one is specified.

Third-party annotations — signed statements published by parties outside the issuance chain, stored on IPFS and indexed via EAS. These are not part of the Card's log. They are queried separately and filtered at verification time based on the verifier's trusted annotator roots. See the third-party attestations document for full details.

This document covers issuer annotations, the append-only log, and revocation.

Core Mechanism
Cards are identified by mutable pointers (issuer-controlled entries in an on-chain registry contract). The pointer is stable across all updates; what changes is the append-only log it points to. To annotate, update, or revoke a Card, the issuer publishes a new entry to that log. Every entry is signed, carries a monotonic version number, and its log root is anchored on-chain for rollback resistance and trusted timestamps.

The Card's structure:

Mutable pointer: the stable on-chain identifier. This is what gets passed around, embedded in messages, and used as the account ID in authentication.
Current state: determined by reading the full append-only log and applying entries in order. The log encodes the Card's metadata, any issuer-appended addenda, and the current status (active / revoked-with-history / revoked-opaque / revoked-erased).
Per-version CIDs: each entry in the log references a CID for that version of the Card document on IPFS. Signatures and references to the Card specify which version CID they refer to.

The Three (Plus One) Revocation Modes
The issuer publishes a revocation entry to the log. Depending on the mode:

Revoked, history public — the new log entry contains prior content plus a signed revocation statement. Verifiers see what existed and that it is now withdrawn.
Revoked, history private — the new log entry contains only the revocation statement, but prior version hashes remain in the log. Cached copies held by others can still be authenticated against the log; fresh verifiers see only the tombstone.
Revoked, history erased — the new log entry contains only the revocation statement, and prior log entries are redacted. Cached copies become unauthenticatable. This is the nuclear option and requires explicit opt-in at issuance time (erasable: true). Cards without this flag can be revoked but never erased.
Issuer annotation (not revocation) — the new log entry contains prior content plus an addendum. Status remains active. This is how issuers append information to Cards they issued, subject to the Card's annotation policy.

The opt-in for erasability is the line between "the issuer controls the Card's future" (normal credential behavior) and "the issuer controls the Card's past" (unusual; could break verifiability of historical messages signed by the Card). The first is always allowed; the second must be deliberately enabled.

A parallel distinction governs how a revocation is interpreted:

Policy revocation — forward-only. The Card was valid at the time of past signatures; historical claims remain verifiable; new authentications are rejected.
Key compromise revocation — retroactive, with a compromise window. Signatures within the window are suspect; signatures before it remain trustworthy.

Standard revocation reason codes will be defined as part of the broader annotation specification.

Annotation Policies
A Card type may specify an annotation policy — a signed document (analogous to the issuance policy) that governs who is permitted to publish issuer annotations to this Card's log, and what kinds of entries they may add. For example:

An annotation policy might allow certain Card types to append metadata fields but not to issue revocations.
An annotation policy might require that revocation entries be co-signed by multiple authorized parties.
A Card with no annotation policy defaults to issuer-only annotation (only the original issuer may add entries).

Annotation policies enable delegation of update authority without giving full revocation authority, which is useful for things like: allowing a school administrator to update enrollment metadata without being able to revoke a student's Card on their own.

What Signatures Commit To
Every signed message includes, alongside the signature itself, a snapshot of the signer's Card state at signing time:

pointer — the Card's mutable pointer (stable identifier)
version_cid — the specific version CID the signer was working from
log_root — the append-only log root the signer committed to at signing time

This is carried at the sub-Card level rather than per-message: each sub-Card is implicitly a snapshot ("I am sub-Card X, registered under master pointer Y at version V, log root R"), and messages signed by that sub-Card inherit the master commitment.

A separately signed timestamp lets verifiers position the signature against the on-chain anchor time of the log root, which is what makes retroactive key-compromise revocation meaningful.

What Verifiers Actually Do
A verifier can answer four independent questions about any signature:

Is the signature cryptographically valid? (signature check against the committed version CID)
Was the Card in this state at the claimed time? (log root check against on-chain anchor)
Was the Card valid at that time? (chain walk using committed version CIDs — historical validity)
Is the Card valid now? (fresh pointer resolution — current log state)

Question 3 governs whether historical claims are verifiable. Question 4 governs whether the Card can be used for new actions. They are separate concerns, answered with different fetches.

Substrate Choice
The mutable pointer is an entry in an on-chain registry contract on Base or Optimism — the same substrate where Card update logs are anchored. Content (the version documents themselves) lives on IPFS, content-addressed by CID, optionally durably pinned via Filecoin.

On-chain registry resolution runs ~50–200ms per RPC call, is trivially cacheable, and costs $0.01–$0.05 per update on L2. One registry contract handles all Cards; deployment is a one-time cost amortized across the system. The on-chain timestamps come for free and serve as the trusted clock for all signature timestamps.

Parallelizing Chain Walks via Cached Chain Arrays
To prevent chain walks from being inherently sequential (each link discoverable only after fetching its predecessor), each Card's signed metadata includes an array of snapshots for every Card above it in the chain:

chain: [
  {
    pointer: "0x...",              // mutable pointer (stable identifier)
    version_cid: "bafy...",        // version CID at the time this Card was issued
    log_root: "0x...",             // log root the issuer committed to then
    relationship: "issuer"         // or "issuer-of-issuer", etc.
  },
  ...
]

Because the array is part of the Card's signed metadata, the issuer is committing to "this is the chain as I saw it when I issued you" — preventing later claims of a different chain structure.

Verifier behavior with the array:

Historical verification: fetch all version CIDs from IPFS in parallel. Verify each link's signature against the next. Confirm scope attenuation at each link.
Current revocation check: resolve all mutable pointers' current on-chain state in parallel. Confirm no link's log contains a revocation entry.

Both passes parallelize, so a 5-link chain takes roughly the same wall-clock time as a 1-link chain. The array adds maybe 500–750 bytes to Card metadata — a trivial cost relative to the latency it saves.

Important constraints on the array:

It is a hint and convenience, not a substitute for the per-link issuer references in each Card's own metadata. Each Card still independently names its direct issuer's mutable pointer. The cryptographic chain lives in those per-link references; the array just lets verifiers parallelize fetching.
It commits to chain state as of issuance time. Updates to Cards higher in the chain after this Card was issued are not reflected in the array — they show up in the fresh pointer-resolution pass, not the historical-snapshot pass.
If the array and the per-link references disagree, the per-link references win. The array is metadata for efficient verification; the per-link references are the unambiguous statement of chain structure.

A second-order benefit: the array also functions as a self-contained credential bundle. If Cards higher in the chain become unfetchable from IPFS (nobody's pinning them anymore), the array still names the version CIDs the verifier needs. As long as any pin exists somewhere, the verifier can find it.
