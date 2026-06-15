Third-Party Attestations and Resolutions When Card Holders Cause Harm

The Problem
The issuer annotation layer assumes annotations come from parties with context — issuers and parties authorized under the annotation policy in the Card's issuance chain. This works for credentialing and reputation but fails in two specific cases: when a Card holder causes harm and the issuer refuses to act, and when the issuer itself is the source of harm (issuing Cards under false pretenses, sheltering bad actors). Both cases need annotators who sit outside the chain of trust they are commenting on. This is the role of third-party safety annotators, which operate through the third-party annotation system — distinct from issuer annotations in the Card's own append-only log.

Third-Party Safety Annotators
A specialized class of third-party annotator built on the existing annotation infrastructure. Cryptographically identical to other third-party annotations — same signed statements on IPFS/EAS, same chain verification — but distinguished by role and default visibility:

Not shown by default during verification. Queried separately, typically via a safety_annotator_roots list configured independently from the user's normal trust roots.
Authority comes from being a watchdog, not from being in the annotated Card's issuance context. Credible operators are existing trust-and-safety organizations, regional digital-rights groups, professional licensing bodies, journalist verification groups — entities with reputational stakes and accountability structures outside the protocol.
Required published methodology describing what they investigate, evidence standards, what claims they will and won't publish, their accountability mechanisms, and their full annotation history including retractions.
Annotatable themselves — bad-faith annotators can be flagged by other annotators through the same machinery.

Practical bootstrapping mirrors the browser CA model: keyring apps ship with default-recommended annotator lists that users can edit, communities publish their own recommended lists, and the protocol remains permissionless for new annotators to join.

The Evidence Problem
For categories like CSAM, non-consensual intimate imagery, and similar harms, the cryptographic evidence cannot be casually republished. The general pattern: the annotator holds evidence in custody and publishes a verifiable commitment to it rather than the evidence itself.

A safety annotation contains the Card's mutable pointer being annotated, the harm category (from a published taxonomy), severity and confidence, a hash commitment to the underlying evidence with a description of its form, custody information (where evidence is held, under what legal regime, who can request access), an on-chain anchored timestamp, and the annotator's signature.

Category-specific custody patterns compose with existing infrastructure: CSAM coordinates with NCMEC and PhotoDNA-style perceptual hashes; NCII coordinates with StopNCII; fraud cases are typically not custody-sensitive and can include full documentary records. The verifier doesn't need to see evidence — they need to trust the annotator's methodology and track record.

Cascading Concerns Through the Chain
The fake-doctor case requires controlled downward propagation. A safety annotation on a higher chain link can flag itself as either:

Applies to Cards issued by this entity (cascading) — concerns the institution and its derivatives. Used for fraudulent credentialing patterns.
Applies only to this specific Card (non-cascading) — concerns an individual, not the institution. Used when one school employee misbehaves but the school itself is sound.

Cascading annotations carry an applies_to_cards_issued_during window to handle remediation — an institution that has cleaned house shouldn't poison new Cards indefinitely. Without an explicit inheritance marker, verifiers don't know which interpretation to apply, and the annotator is accountable for choosing correctly.

Restorative Process Annotations
A meaningful expansion beyond the adjudicative frame. Rather than binary published/retracted lifecycles, annotations can track the state of harm-and-response over time:

Initial concern raised, evidence in custody
Responsible party acknowledged
Restorative process initiated with a facilitator
Periodic status attestations
Process completion with documented outcomes
Transition to historical record

This adds a new trusted role: restorative justice facilitators, themselves Cards with published methodology (training, tradition of practice, types of harm taken on, accountability structure, capacity, conflict-of-interest policies). Credible facilitators come from existing communities of practice — Restorative Justice Council practitioners, Indigenous justice traditions, community mediation centers, transformative justice collectives.

Process annotations are multi-party signed objects: the original annotator, the responsible party, the facilitator, and optionally the harmed party each sign their own statements. No single signer can unilaterally declare a process is going well — the facilitator's attestation coexists with the harmed party's, and contradictions between them remain visible.

The verification surface gains a richer display: "This Card was flagged for [category] in February. The responsible party entered a restorative process with [facilitator] in March; the most recent status attestation (May 1) indicates the process is active and on schedule." That's actionable in a way binary accusation/denial isn't.

Protections Against False Claims and Bad-Faith Use
Layered defenses, none sufficient alone:

Annotator chain validity is checked. Revoked or invalid-chain annotators are discarded.
Annotators can be annotated. Bad-faith annotators get flagged by other annotators.
Right of reply. Annotated parties can publish signed counter-annotations; verifiers see both.
Evidence standards are mandatory and enforceable. Annotations missing evidence-form metadata are filtered by default.
Thresholds and corroboration. Verifier policies can require N independent annotators concur before acting on category-X warnings.
Annotation expiry and renewal. Annotations expire and require active renewal; stale concerns don't accumulate indefinitely.

Failure modes specific to restorative annotations:

Restorative-theater (hollow processes used to dilute concerns) — defended by facilitator accountability among practitioners.
Coerced participation by harmed parties — defended by never requiring harmed-party attestations; their option to attest, decline, or attest with concerns is always preserved.
Process used to bury concerns — severity and process state are independent dimensions; a high-severity concern doesn't soften just because a process is underway.
Premature completion — closing attestations don't preclude later annotations contesting closure.

Funding Considerations
Both safety annotators and facilitators require sustainable funding to operate credibly. Trust-and-safety work and restorative justice work are labor-intensive and most existing practitioners are underfunded. Possible models: foundation grants to seed initial capacity, sliding-scale per-process fees, institutional sponsorship by employers and professional associations, protocol-level fees on Card issuance routed to a facilitator fund. These are ecosystem questions rather than protocol questions, but the protocol should be friendly to all of them — supporting payment metadata, sponsor relationships, and fee-structure transparency.

Open Questions to Carry Forward

The harm taxonomy. Needs a standardized published set of category codes, ideally modeled on existing T&S frameworks (TSPA, GIFCT) rather than invented from scratch.
Redress beyond counter-annotation. When an annotator refuses to retract a false claim, the protocol-level redress is meta-annotation by other annotators — slow and unsatisfying for someone actively harmed by a false claim.
Coordination with existing T&S organizations. Making it easy for NCMEC, IWF, and similar bodies to participate as annotators — probably through sponsored facilitator/annotator Cards underwritten by foundations or industry consortia.
Interaction with formal revocation. Whether sufficiently corroborated safety annotations from sufficiently trusted annotators should trigger protocol-level warnings approaching the strength of issuer-driven revocation. Conservative answer: no, preserve issuer authority and let verifier-side consumption policies do the work.
Standardized harm category and revocation reason codes. Aligned with existing T&S taxonomies, defined as part of the broader annotation specification.

What This Changes About the System's Character
In a pure adjudicative frame, the safety layer answers "should I trust this Card?" — a present-tense judgment. With restorative process annotations, the safety layer also answers "what is the trajectory of trust around this Card?" — a temporal question about whether the parties involved are doing the work of being trustworthy over time. Communities that function well in practice don't just sort members into trusted and untrusted bins; they acknowledge harm, support repair, and welcome people back from broken trust without erasing the history. Building that capacity in from the start — rather than retrofitting it after an adjudicative frame has hardened — is the kind of design decision whose value isn't visible until much later.
