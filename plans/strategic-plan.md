# Red-Team Strategic Plan — Card Protocol v0.3

**Date:** 2026-05-21  
**Status:** Draft  
**Companion document:** [implementation-plan.md](./implementation-plan.md)

---

## Goals

### 1. Surface zero-click infrastructure vulnerabilities before deployment

The protocol relies on a small set of infrastructure components — the Arbitrum One registry contract, IPFS pinning, the Nym mixnet gateway, and the press service — each of which is reachable without user interaction. Exploits at this layer can affect all cards across all policies, not just individual holders. We need to identify what an attacker can do by targeting these surfaces before any human approves or countersigns anything.

### 2. Map the blast radius of key compromise at each tier

The protocol has a trust hierarchy: policy authorizer → press sub-card → issued card. Key compromise at different points in this hierarchy has wildly different consequences. We need to model each compromise scenario, determine exactly what an attacker gains, and evaluate whether the protocol's revocation and recovery machinery is sufficient to contain the damage.

### 3. Stress-test social and procedural controls against realistic adversaries

The protocol is explicitly aware that some of its enforcement is "a social protocol, not a cryptographic one" (e.g., 9xx propagation). This is honest, but it means we need to evaluate whether adversaries — specifically a state actor, an organized criminal operation, and a technically sophisticated individual abuser — can exploit those social gaps in ways the cryptographic layer cannot detect or prevent.

### 4. Identify whether the protocol can be weaponized against its intended beneficiaries

The protocol is designed to serve activists, journalists, mutual aid communities, and vulnerable individuals. The most serious failure mode is not that the protocol fails to work — it's that it works exactly as designed, but in the hands of an adversary who has learned to operate within its rules. We need to ask whether the protocol inadvertently creates new attack surfaces for the populations it is meant to protect.

### 5. Produce actionable findings with severity ratings and mitigation recommendations

The output of this red-team is not a pass/fail verdict. It is a ranked list of findings — each with a clear description of the attack, the conditions required to mount it, the harm it causes, and the mitigation options available within the current spec. Findings should be specific enough to inform concrete design decisions before v1 deployment.

---

## Rationale

### Why this matters now

The protocol is at v0.3 draft, before the Arbitrum One contract is deployed and before the npm package API is locked. This is the cheapest moment to find problems. A vulnerability in the on-chain registry contract is a breaking change after deployment; a design flaw in how revocation propagates is a social harm to real users after launch.

The three attack categories and three adversary personas are not hypothetical — they represent realistic threat actors who have targeted analogous systems. The Tor Project, Signal, and the Let's Encrypt CT log have all faced attacks modeled on at least one of these personas. The Card Protocol's novel combination of decentralized issuance, privacy-preserving transport (Nym), and community-governed credentials creates new possibilities for both the protocol's intended uses and for its abuse.

### The protocol's meaningful attack surface

After reading the full spec, the most interesting attack surfaces are:

**Infrastructure layer.** The Arbitrum One Stylus contract verifies ML-DSA-44 signatures on every write. The IPFS pinning model has no enforcement — presses are contractually required to pin, but the protocol has no mechanism to verify they are doing so or to prevent targeted de-pinning of specific card histories. The Nym gateway is a real-time network endpoint with no authentication at the transport layer.

**Key hierarchy.** The press key is the bottleneck for all issuance writes to the chain. Compromising the press sub-card key allows an attacker to register arbitrary cards under any policy the press serves, forge update log entries (including backdated revocations and 9xx loud revocations against victims), and brick an entire policy's issuance pipeline. Press key compromise is explicitly noted in the risk register with "Low" likelihood — this assessment should be stress-tested.

**Social engineering surface.** `requester_predicate` and `recipient_predicate` are powerful but their evaluation depends on the honesty of the chain they're walking. A sufficiently sophisticated attacker who can obtain real credentials (or whose community contact has real credentials) can satisfy predicates legitimately and then use the resulting card for purposes the policy intended to prevent. The open card offer mechanism (`allow_open_offers: true`) is particularly interesting here — it decouples issuance from individual review.

**Holder notification suppression.** The spec explicitly notes that `notify_holder: false` exists for "adversarial scenarios — such as a 9xx revocation where tipping off the holder would be harmful." This feature cuts both ways. A malicious issuer can revoke a target's card with a 9xx code and `notify_holder: false`, silently destroying the target's standing across communities, with the target having no way to know until they try to authenticate somewhere.

**Erasure.** The `erasable: true` policy flag allows revocation entries to redact prior log history. This is a powerful capability for harm survivors who need to remove records. It is also a powerful capability for anyone who controls a policy and wants to destroy evidence.

### Why these three adversaries

**Autocratic government.** State actors have the resources to compromise infrastructure, compel press operators (legal process, coercion), and run long-duration intelligence operations to build dossiers on card chains. They may control portions of the Nym mixnet or be able to perform traffic correlation. The protocol's privacy model explicitly addresses "selectively shared" and "fully private" modes — but these require the user to have chosen them correctly and to hold their capability bundles securely under active surveillance.

**Sophisticated criminal organization.** Criminal organizations need fraud-proof-enough credentials to extract money. They are unlikely to attack infrastructure (high cost, high exposure) but are highly motivated to find policy-social-engineering paths that produce legitimate-looking cards. They will probe the open offer mechanism, the `allow_open_offers` flag, and any press whose compliance checks can be gamed at scale.

**Technical abuser.** An individual with software engineering skills and motivation to surveil, control, and harm a specific person is the highest-precision attacker. They are not trying to affect many people — they are trying to affect one person. This means they can invest disproportionate effort per target. Their key questions are: can they obtain a card that gives them visibility into their target's activity? Can they silently modify or revoke their target's credentials? Can they use the protocol's notification and authentication flows as a tracking mechanism?

---

## Key Objectives

### Goal 1: Surface zero-click infrastructure vulnerabilities

- Identify at least one concrete attack path (or confirm absence) for each infrastructure component: registry contract, IPFS layer, Nym gateway, press service endpoint.
- Evaluate whether the Stylus ML-DSA-44 verification is susceptible to known implementation attacks (key substitution, fault injection at the calldata level, gas griefing).
- Determine whether targeted IPFS de-pinning of a specific card's history is achievable and what the protocol-level consequences are.
- Assess the Nym gateway endpoint's exposure to denial-of-service and traffic-correlation attacks.

### Goal 2: Map key compromise blast radius

- For each key tier (policy authorizer, press sub-card, holder master, holder sub-card, auditor, backup service), document: what an attacker gains on compromise, what the revocation response is, and what the residual damage is after revocation.
- Evaluate the 72-hour YubiKey recovery cancellation window against an adversary with simultaneous access to the YubiKey and the target's notification channels.
- Assess whether a compromised press can forge backdated log entries that survive post-hoc verification.

### Goal 3: Stress-test social controls against realistic adversaries

- Identify at least two realistic social-engineering paths to obtaining a card under false pretenses for each of the three adversary types.
- Evaluate whether the protocol's existing tooling (9xx revocation, safety annotator layer, loud revocation propagation) is sufficient to remediate each scenario after discovery.
- Assess how long an attacker can operate with a fraudulently-obtained card before detection is likely.

### Goal 4: Identify weaponization against intended beneficiaries

- Document the protocol behaviors that could be used against activists, journalists, or abuse survivors — specifically: silent 9xx revocation with `notify_holder: false`, the erasure capability, and the authentication flow's card-pointer metadata.
- Evaluate whether the privacy modes ("selectively shared," "fully private") are meaningfully protective against a state-level adversary with access to the Nym gateway infrastructure or Arbitrum One chain analysis capabilities.
- Determine whether the authentication flow leaks correlatable metadata that could de-anonymize users.

### Goal 5: Produce actionable findings

- Every finding receives a severity rating (Critical / High / Medium / Low) and a feasibility rating (Practical / Theoretical).
- Every Critical or High finding includes at least one concrete mitigation option, with an assessment of whether it can be addressed within the current spec or requires a protocol change.
- Findings are organized by attack category, not by adversary, to support prioritization across the full threat landscape.

---

## Resolved Design Questions

The following questions were clarified by the protocol author and should inform findings throughout the red-team work.

**1. Trust root control — split state-actor scenario into two tracks.**

The state-actor scenario should be analyzed separately depending on whether the adversary controls the community's trust root or not. These are qualitatively different threat profiles:

- **Without trust root control:** The adversary cannot issue policy cards that appear legitimate to verifiers using the community's configured root. Their attack surface is limited to infrastructure coercion, chain analysis, and insider operations.
- **With trust root control:** The adversary can issue legitimately-verifiable policy cards and press sub-cards, making the entire credential hierarchy they issue cryptographically indistinguishable from genuine issuance. This is a fundamentally more powerful position. The implementation plan should evaluate each sub-scenario under both conditions.

**2. The press does not hold audit log decryption keys — but legal compulsion is still a real threat.**

The press encrypts each issuance log entry to auditor public keys using ML-KEM, but never holds the corresponding decryption keys. A compelled press therefore cannot hand over audit log contents. However, legal compulsion can require the press to operate normally while under surveillance — logging which update intents arrive, from which Nym addresses or IPs, and when. The press observes: the timing and frequency of issuance requests, which card pointers are submitting update intents, and (for HTTPS submissions) IP address metadata. This is meaningful intelligence even without decrypting audit content. Separately: the press cannot issue cards that appear valid because it cannot forge holder countersignatures. A compelled press can refuse to process legitimate requests or selectively forward valid intents — it cannot forge credentials.

**3. `notify_holder: false` is an intentional design feature, confirmed weaponizable.**

The feature exists to allow issuers to act against bad actors without alerting them. This is a considered design choice. However, the same mechanism allows a malicious issuer to silently revoke a legitimate holder's credentials — posting a 9xx entry with `notify_holder: false` and a backdated `effective_date` — with the target having no way to know until they attempt to authenticate and are rejected. This is not an oversight; it is an accepted tradeoff. Red-team findings in this area should be rated as High and should include mitigation options (e.g., holder-initiated log polling, verifier-side "last checked" freshness indicators, or requiring two-party authorization for silent 9xx entries).

**4. Safety annotators post to a separate contract with distinct discovery semantics.**

Safety annotators publish annotations to a separate on-chain contract (not the main card registry). Each annotator's mutable pointer points to their annotation records, not directly to the cards they are annotating. Evidence is required for annotations: valid evidence includes a signed statement using the card being annotated, or a signed statement from a card holder who is themselves trusted. This requirement changes the attack surface: a false annotation campaign requires fabricating or obtaining signed evidence, not merely asserting harm. The key failure mode is annotator compromise (attacker gains control of a trusted annotator card) rather than trivial false claims.

**5. Nym de-anonymization — adversary capability tiering is an explicit research question.**

Not all adversaries can de-anonymize Nym. The implementation plan should specifically investigate which adversary categories have realistic de-anonymization capability and what that capability enables. A state actor with significant Nym node infrastructure or global passive surveillance capability is a different threat than an individual abuser. The question to answer: if an adversary can de-anonymize a Nym message to learn the sender's IP, what does that give them? (It links a card identity to a physical network location — potentially identifying a device, its owner, or their geographic position.)
