# Red-Team Implementation Plan — Mark Protocol v0.3

**Date:** 2026-05-21  
**Status:** Draft  
**Strategic plan:** [strategic-plan.md](./strategic-plan.md)

This plan is organized into three phases corresponding to the three attack categories. Each phase produces findings that feed into a final synthesis report. Phases can be executed in parallel by separate reviewers; each phase's milestone review should be completed before findings are merged into the synthesis.

---

## Phase 1: Zero-Click Infrastructure Attacks

**Objective:** Identify attacks that require no user interaction — attacks on the Arbitrum One contract, the IPFS layer, the Nym gateway, and the press service itself.

---

### Step 1.1 — Audit the Arbitrum One Stylus contract's write-gate logic

**What:** Review the registry contract's enforcement of ML-DSA-44 signature verification. Specifically: (a) confirm that the contract correctly rejects writes from press sub-mark keys that do not appear in the policy mark's `approved_presses` field; (b) evaluate whether the on-chain ML-DSA-44 verification is susceptible to key-substitution or malleability attacks; (c) assess whether an attacker can gas-grief the contract by submitting transactions with valid signatures but malformed calldata that causes expensive reversion.

**Who:** Reviewer (smart contract focus)

**Context needed:** `specs/ARCHITECTURE.md` §ADR-001, §ADR-004; `specs/chitt_protocol_spec.md` §2 (press authorization flow); `specs/protocol-objects.md` §12 (RegistryEntry). Key fact: the contract rejects writes unless the signer's press sub-mark pointer appears in `approved_presses` — this is the primary write gate. ML-DSA-44 public keys are 1,312 bytes; signatures are 2,420 bytes.

**Done when:** A written finding describes: (1) whether any identified attack path allows unauthorized writes to the registry, (2) whether gas-griefing is feasible and what its impact would be, (3) whether the ML-DSA-44 Stylus verification is susceptible to known implementation vulnerabilities. Finding includes severity and feasibility ratings.

---

### Step 1.2 — Assess targeted IPFS content availability attacks

**What:** Evaluate what happens when an adversary causes specific IPFS content to become unavailable. Three sub-scenarios: (a) **de-pinning attack** — an adversary who controls the press (or has compromised it) stops pinning specific marks, making their history unresolvable by verifiers; (b) **policy mark availability** — what happens to all marks issued under a policy if the policy mark's IPFS content becomes unavailable (the on-chain pointer survives but the content does not); (c) **revocation record suppression** — is it possible to make a 9xx revocation entry unresolvable while leaving the mark's active state intact, such that verifiers see the mark as valid?

**Who:** Reviewer

**Context needed:** `specs/ARCHITECTURE.md` §ADR-002, §ADR-003; `specs/chitt_protocol_spec.md` §5 (updating marks, log architecture); `specs/ARCHITECTURE.md` Risk Register (IPFS content not pinned). Key fact: the on-chain registry holds only the head CID pointer; the content lives on IPFS and persists only as long as someone pins it. Presses are "contractually responsible for pinning" — there is no on-chain enforcement.

**Done when:** A finding describes which content availability failures are exploitable by a determined adversary vs. which are mitigated by the on-chain anchor, whether selective de-pinning of revocation records is a viable attack, and what the user-visible consequence of each scenario is.

---

### Step 1.3 — Assess the Nym gateway as an attack surface

**What:** Evaluate four attack vectors against the Nym transport, with explicit adversary-capability tiering for each:

**(a) Denial-of-service.** Can an attacker flood a mark's Nym gateway to prevent delivery of offers, SCIPs, and authentication responses? What is the user-visible consequence — does the protocol degrade gracefully (fall back to HTTPS) or fail closed? Evaluate whether the HTTPS fallback itself leaks IP metadata that Nym was meant to hide.

**(b) Traffic correlation — adversary capability tiering.** Not all adversaries can de-anonymize Nym. Evaluate each adversary category separately:
- *State actor with significant Nym node infrastructure or global passive surveillance:* Can correlate entry and exit timing across the mixnet with sufficient node coverage. Evaluate the minimum node fraction needed to de-anonymize a given message, and what de-anonymization reveals — specifically, it links a mark identity to a physical network address (IP), which may in turn identify a device, its owner, or their geographic position.
- *Criminal organization without state-level infrastructure:* Can operate Nym nodes to attempt partial de-anonymization, but lacks global coverage. Evaluate feasibility of targeted de-anonymization if the adversary can predict when a specific mark holder will authenticate (e.g., they control the relying party site).
- *Individual abuser:* Realistically cannot de-anonymize Nym without access to node infrastructure. Their threat model against the transport layer is limited to the gateway endpoint and HTTPS fallback.

**(c) Gateway endpoint exposure.** The Nym gateway address is stored in mark metadata. For "fully private" marks this metadata is encrypted, but for "fully public" marks it is plaintext and directly linkable to the mark identity. Evaluate: does a public gateway address allow an adversary to observe when a holder is receiving messages (even without reading content)? Can the press's observable knowledge of a holder's Nym gateway address (from HTTPS submissions or prior interactions) be used to track activity?

**(d) What de-anonymization enables.** If an adversary succeeds in linking a Nym message to an IP address, what does that give them beyond the IP? Cross-reference with the authentication flow (§8): an authentication response sent via Nym contains the holder's mark pointer, signed statement, and session ID. A de-anonymized authentication response links: a physical IP → a mark identity → the site being authenticated to → the timing of the authentication. For a journalist or activist authenticating to a community platform, this is a significant intelligence gain.

**Who:** Reviewer

**Context needed:** `specs/ARCHITECTURE.md` §ADR-007 (Nym mixnet, message server design); `specs/chitt_protocol_spec.md` §8 (authentication flow, Nym/OHTTP/HTTPS fallback chain); `specs/ARCHITECTURE.md` §ADR-006 (privacy modes, gateway address in metadata). Key facts: the spec acknowledges the message server "observes that messages arrived and approximately when, but not their content"; the Nym gateway address is "a field in mark metadata"; the authentication flow sends responses via Nym preferred → OHTTP → HTTPS.

**Done when:** A finding rates the feasibility of each attack path explicitly by adversary category (not a single aggregate rating), specifies what de-anonymization enables beyond an IP address, and identifies whether any protocol changes (e.g., rotating Nym gateway addresses, mandatory OHTTP for all authentication responses) would meaningfully reduce exposure.

---

### Step 1.4 — Evaluate press service attack surface

**What:** The press is a networked service that holds a funded Arbitrum One wallet, accepts HTTPS and Nym submissions, and has write authority to the registry contract. Evaluate four attack paths:

**(a) Press key exfiltration.** What does an attacker with the press's private key gain? The press cannot forge holder countersignatures — user-sovereign key custody means a completed mark requires the holder's own keypair, so the press cannot mint arbitrary valid credentials. But with the press key it can: post backdated log entries (including 9xx revocations with any `effective_date` and `notify_holder: false`), register new registry entries for attacker-controlled keypairs, and suppress or delay legitimate update intents. Evaluate the practical harm of each.

**(b) Legal compulsion to operate under surveillance.** A state actor can compel a press to continue operating normally while the press logs all submission metadata. Critically, the press cannot hand over audit log contents — it encrypts each issuance log entry to auditor public keys using ML-KEM and never holds the corresponding decryption keys. But the press does observe: timing and frequency of all issuance requests, which mark pointers submit update intents, IP addresses of HTTPS submissions, and Nym gateway addresses from Nym-routed submissions. Evaluate what this metadata stream enables for a state-level adversary and whether Nym-only submission to presses would materially reduce the exposure.

**(c) Press as single point of failure.** What happens if the only approved press for a community's policy is taken down — by legal seizure, infrastructure failure, or targeted attack? Evaluate whether the "list multiple presses in `approved_presses`" recommendation is realistic for small community deployments and whether the spec should treat it as a requirement rather than a suggestion.

**(d) Selective censorship by a malicious press operator.** A press operator can silently drop specific valid intents without key compromise — selectively refusing 810 self-revocation requests (preventing a compromised holder from invalidating their key), suppressing legitimate positive updates, or refusing issuance requests from specific requesters. This is censorship within the press's legitimate operational authority, not forgery. Evaluate how detectable this behavior is and what the holder's recourse is.

**Who:** Reviewer

**Context needed:** `specs/ARCHITECTURE.md` §ADR-005, §ADR-007; `specs/chitt_protocol_spec.md` §2 (issuance flow), §5 (update flow, 810 self-revocation); `specs/ARCHITECTURE.md` Risk Register (Press key compromise). Key facts: the press encrypts audit entries to auditor public keys and never holds decryption material; the spec recommends (but does not require) multiple presses in `approved_presses`.

**Done when:** A finding clearly separates what a press can do (registry writes, log entry posting, metadata observation) from what it cannot (forge holder countersignatures, decrypt audit logs), rates each of the four attack paths separately, and addresses whether the "list multiple presses" mitigation is sufficient in practice.

---

### Phase 1 Milestone Review

**Context needed:** Findings from Steps 1.1–1.4; `specs/ARCHITECTURE.md` Risk Register; `plans/strategic-plan.md` §Goals 1 and 5.

**Done when:** All Phase 1 findings reviewed for consistency (no contradictions in severity ratings, no duplicate coverage); any findings from one step that are relevant to another step cross-referenced; a one-paragraph Phase 1 summary written to `plans/milestones/phase-1-summary.md` naming the top 1–2 infrastructure findings by severity; and the reviewer has confirmed no infrastructure finding was missed that would materially affect Phase 2 or Phase 3 work.

**Clarification checkpoint:** If any Phase 1 step surfaces a Critical finding — an attack that appears to allow arbitrary writes to the registry, mass revocation of marks, or complete suppression of revocation records — **pause and notify the author before continuing**. A Critical infrastructure finding may require spec changes that affect the Phase 2 and Phase 3 analyses.

---

## Phase 2: Key Compromise Scenarios

**Objective:** For each key tier in the trust hierarchy, model the attacker's capabilities after compromise and evaluate whether the protocol's revocation and recovery machinery contains the damage.

---

### Step 2.1 — Model policy authorizer key compromise

**What:** The policy authorizer holds the key that signs policy marks and authorizes press sub-marks. This is the root of trust for all marks issued under their policies. Model: (a) what an attacker with the authorizer's key can do — modify existing policy fields (if `update_policy` allows it), issue new press sub-marks to attacker-controlled presses, revoke existing press sub-marks; (b) whether the attacker can modify field definitions retroactively and whether this would invalidate existing marks; (c) how the legitimate authorizer detects the compromise and what the recovery path is (the append-only log means the compromise is visible, but the attacker can post entries before revocation).

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §1 (policy creation, `approved_presses`, `revocation_permissions`), §5 (update flow, predicate system); `specs/ARCHITECTURE.md` §ADR-005. Key facts: the policy mark's `update_policy` fields control what each key can change. The authorizer key signs the initial policy but may delegate update authority granularly. Revoking a press sub-mark "removes the press's write authority; previously-issued marks are unaffected."

**Done when:** A finding maps the complete capability set of an attacker with the policy authorizer key, describes the minimum time-to-detection under realistic conditions, and rates the severity with justification.

---

### Step 2.2 — Model press sub-mark key compromise

**What:** The press sub-mark key has write authority to the Arbitrum One registry for all marks governed by its policy. Model three capabilities:

**(a) Credential forgery scope.** The press cannot forge a mark that appears valid to a careful verifier, because the holder countersignature requires the holder's private key. However, the press can register a new mark entry using a keypair it controls — producing a mark with a press signature but a holder signature from an attacker-controlled key. Evaluate whether verifiers in practice would detect this (does the verification flow require the holder's public key to be verified against some prior registration, or only against the mark document itself?). This is the precise boundary of "cannot forge marks that appear valid."

**(b) Backdated 9xx revocation as a weaponized attack.** The press key can post a 9xx log entry with any `effective_date` in the past, paired with `notify_holder: false`. This is a confirmed design feature — intentional for issuer-side action against bad actors — but it means a compromised or compelled press can silently revoke any mark in its scope, with the revocation backdated to appear as though the holder was a bad actor before any specific authentication event. The victim learns of the revocation only when they attempt to authenticate and are rejected. Evaluate the minimum time-to-detection and the victim's recourse (successor mark + supersession note, but this requires the issuer's cooperation or the original press).

**(c) Adversary-type mapping.** Apply all of the above to each adversary type: state actor who has compelled the press via legal process (the press continues operating; the state directs which intents to process and can instruct specific 9xx entries); criminal organization that has infiltrated or set up a press operation; individual abuser who operates a small community press.

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §2 (press signing authority, completed mark structure), §5 (update flow, code semantics, `notify_holder`); `specs/protocol-objects.md` §1 (ChittDocument — both `offer_signature` and `holder_signature` required), §3 (LogEntry, `effective_date`); `specs/ARCHITECTURE.md` §ADR-005. Key facts: a valid ChittDocument requires both the press's `offer_signature` and the holder's `holder_signature`; backdated effective dates are explicitly supported by the spec; `notify_holder: false` is a confirmed design feature, not an oversight.

**Done when:** A finding precisely states the boundary of what a compromised press key can and cannot forge, rates the backdated-silent-9xx scenario as High severity with justification, and describes the victim's recourse for each adversary type.

---

### Step 2.3 — Model holder master key and sub-mark key compromise

**What:** Evaluate the consequence to a holder whose keys are compromised. Three sub-scenarios: (a) **sub-mark key only** — attacker has the device sub-mark key but not the master key. What can they sign, and how does the holder revoke? (Note: 810 self-revocation requires the holder's key, which may be the compromised key.); (b) **master key only** — attacker has the master key. What can they do that they couldn't with a sub-mark key? (c) **full keyring compromise** — attacker obtains the keyring blob and the decryption key (passkey + service secret). What is the complete scope of the breach, and what is the recovery path via YubiKey? Evaluate the 72-hour cancellation window: what if the attacker also has the holder's notification channels (email, phone) — can they suppress all cancellation signals?

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §3 (keychain setup, YubiKey recovery flow); `specs/ARCHITECTURE.md` §ADR-009; `specs/chitt_protocol_spec.md` §5 (810 self-revocation code). Key facts: "All routine signing operations use sub-mark keys; the master key is cold." The 72-hour window sends notifications "to all configured channels (Nym gateway, email, SMS, secondary contacts)." Recovery is via YubiKey + PIN.

**Done when:** A finding maps the full capability set at each compromise level, rates the feasibility of the 72-hour bypass attack for each adversary type, and evaluates whether the recovery flow is sufficient given realistic attacker capabilities.

---

### Step 2.4 — Model auditor key compromise

**What:** Auditor marks receive ML-KEM-encrypted copies of every issuance log entry. Evaluate: (a) **what an attacker gains** from a compromised auditor key — specifically, they gain the issuance log for every mark issued under that policy, which may include requester identity, recipient public key, and timing metadata; (b) **forward secrecy** — if the auditor key is compromised today, does the attacker gain access to historical issuance records, or are past entries protected by separate per-entry key encapsulation? (c) **correlation attack** — even if individual entries are encrypted, can a compromised auditor key be used to correlate issuance timing across multiple marks belonging to the same holder?

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §2 (audit log encryption via ML-KEM); `specs/ARCHITECTURE.md` §ADR-004, §ADR-006; `specs/protocol-objects.md` §11 (PressIssuanceRecord content). Key fact: "Each auditor mark's current public key (resolved via mutable pointer) is used by the press to encrypt a copy of each issuance log entry via ML-KEM (FIPS 203)." Policy key and audit key are explicitly kept separate.

**Done when:** A finding describes the scope of an auditor key breach, rates the forward-secrecy properties of the current design, and identifies whether auditor compromise is a high-value target for any of the three adversary types.

---

### Step 2.5 — Model backup service and YubiKey-specific attacks

**What:** The backup service holds the wrapped keyring decryption key. Evaluate: (a) **backup service compromise** — if an attacker gains access to the backup service's storage (database breach, insider threat), can they recover the keyring decryption key? (b) **YubiKey theft + notification suppression** — model a sophisticated attacker who steals the YubiKey and simultaneously controls the holder's notification channels (via SIM swap, email account takeover, or physical access). Can they complete recovery within the 72-hour window before the holder can cancel? (c) **backup service coercion** — a state actor with legal authority can compel the backup service to release data. What does a compelled release give them?

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §3 (recovery flow); `specs/ARCHITECTURE.md` §ADR-009. Key fact: "The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The service never sees the decryption key in plaintext." The wrapped blob requires YubiKey PIN to unwrap locally.

**Done when:** A finding rates whether the backup service's design is sound against realistic adversarial conditions and whether the 72-hour window is appropriate given the notification suppression attack.

---

### Phase 2 Milestone Review

**Context needed:** Findings from Steps 2.1–2.5; `plans/milestones/phase-1-summary.md`; `plans/strategic-plan.md` §Goal 2.

**Done when:** Phase 2 findings reviewed for consistency; the blast-radius hierarchy is confirmed (which key tier breach has the widest consequences); a one-paragraph Phase 2 summary written to `plans/milestones/phase-2-summary.md`; any Phase 1 findings that are relevant to key compromise cross-referenced.

**Clarification checkpoint:** If Step 2.2 finds that a compromised press key can issue a backdated 9xx revocation with `notify_holder: false` against any mark in its scope — and the spec does not provide a technical counter to this — **pause and flag this finding explicitly to the author**. This is the most direct path to weaponizing the protocol against its intended beneficiaries and warrants design discussion before proceeding.

---

## Phase 3: Social Engineering and Adversary-Specific Scenarios

**Objective:** Model how each of the three adversary types exploits social and procedural gaps to obtain marks under false pretenses, surveil targets, or perpetuate harm through the protocol.

---

### Step 3.1 — Scenario: Autocratic government repressing activists and journalists

**What:** Model how an autocratic government uses the Mark Protocol to surveil, expose, or silence activists and journalists. This scenario must be evaluated under **two distinct conditions** that produce qualitatively different threat profiles.

**Condition A: Government does NOT control the community's trust root.**

The government cannot issue policy marks or marks that verifiers in the community will accept as legitimate. Their attack surface is limited to infrastructure-layer operations:

**(A1) Chain analysis via Arbitrum One.** Even "fully private" marks have registry writes visible on-chain. Evaluate whether ledger analysis can identify which presses serve which communities, correlate issuance timing to known activist events, or link multiple marks to the same holder via timing or press-wallet patterns. Cross-reference with Nym de-anonymization findings from Step 1.3.

**(A2) Press coercion.** The government can compel a press operator via legal process to: operate normally while logging submission metadata (Step 1.4 covers what this metadata reveals), selectively suppress update intents from specific targets, or post 9xx revocations with `notify_holder: false` against specific targets. Evaluate whether a community that lists multiple presses in `approved_presses` is protected if the government can reach all press operators within its jurisdiction, and whether self-hosted presses in other jurisdictions are a realistic safeguard.

**(A3) Credential-based infiltration.** If an informant genuinely satisfies a policy's `recipient_predicate`, they receive a mark through legitimate channels. Evaluate what a valid mark reveals to its holder about other community members — does participation in shared authentication flows, community platforms, or mark-pointer-based messaging expose the identity or activity of other holders?

**Condition B: Government controls or has captured the community's trust root.**

This is a fundamentally more powerful position. The government can issue policy marks and press sub-marks that are cryptographically indistinguishable from genuine community issuance. Evaluate:

**(B1) Fake credential hierarchy.** The government creates a policy mark under a captured root and issues marks to informants. These marks satisfy `required_predicate` checks in community authentication flows. Community members who verify the chain reach a trusted root — but the root is compromised. Evaluate whether there is any way for a holder or verifier to detect that the root they trust has been captured.

**(B2) Retroactive de-platforming.** With control over the trust root, the government can add an adversary-controlled press to `approved_presses`, then use that press to post 9xx revocations against activist marks — silently, with backdated effective dates. Evaluate the blast radius: how many marks can be simultaneously revoked, and how quickly can the community respond with successor marks under a new, clean root?

**(B3) Surveillance via forged authentication flows.** With a legitimate-appearing mark, the government can operate community services that request authentication, collecting mark pointers, signing timestamps, and authentication payload content from anyone who authenticates. Evaluate what this enables in aggregate.

**Who:** Reviewer, with particular attention to the trust root configuration gap (OQ-9 in ARCHITECTURE.md is unresolved)

**Context needed:** `specs/ARCHITECTURE.md` §ADR-006 (privacy model), §ADR-007 (Nym); `specs/chitt_protocol_spec.md` §1 (policy creation, `approved_presses`), §2 (press compulsion model), §5 (`notify_holder: false`, backdated revocation), §8 (authentication flow metadata); Step 1.3 findings (Nym de-anonymization by adversary tier); Step 1.4 findings (press metadata surveillance).

**Done when:** A finding for each sub-scenario under each condition describes feasibility, what protocol features provide resistance, and where resistance fails. The Condition A vs. Condition B distinction must be explicit in the findings — they are different attacks requiring different mitigations.

---

### Step 3.2 — Scenario: Criminal organization perpetuating fraud

**What:** Model how an organized criminal operation uses the Mark Protocol to establish fraudulent credentials and use them to defraud victims. Three attack paths:

**(a) Policy capture — establishing a fraudulent policy tree.** The protocol allows anyone to create a policy mark and become a "root" for a credential hierarchy. Evaluate: what stops a criminal organization from creating a convincing policy (e.g., "Certified Financial Advisor" or "Licensed Medical Professional"), issuing policy marks to themselves, and presenting these credentials to victims who don't know how to verify the root? This is the "fake CA" problem — the protocol's trust model requires users to independently evaluate the root, which requires a level of literacy that most users will not have.

**(b) Open offer exploitation — mass-issuing fraudulent credentials.** The `allow_open_offers: true` policy flag enables mass issuance without per-recipient review. Evaluate whether a criminal organization can use this to issue large numbers of fraudulent marks rapidly, and whether the on-chain counter enforcement (`max_acceptances`) is actually a meaningful control or merely a rate limiter that slows rather than stops the attack.

**(c) Predicate gaming — obtaining legitimate-looking credentials to satisfy downstream predicates.** Many sophisticated deployments will use `required_predicate` in authentication flows. Evaluate whether a criminal organization can systematically find and exploit policies with weak predicates, use obtained marks as the basis for satisfying predicates in more valuable contexts, and chain their way up the trust hierarchy to high-value credentials.

**Who:** Reviewer

**Context needed:** `specs/chitt_protocol_spec.md` §1 (policy creation flow, `policy_creation` constraints), §2 (open offer flow, on-chain enforcement), §7 (verification, policy compliance check, open questions around trusted roots). Note: the `policy_creation` field constrains what policies *holders* can create, but does not prevent anyone from creating a root-level policy with any content they choose.

**Done when:** A finding for each sub-scenario describes the attack's feasibility, the minimum resources required to mount it, and whether any protocol mechanism constrains it. Finding addresses whether the "trusted root" problem is in scope for the protocol or is explicitly deferred to the application layer.

---

### Step 3.3 — Scenario: Technical abuser surveilling and harassing a target

**What:** Model how a technically sophisticated individual abuser uses the Mark Protocol to track, control, expose, or harm a specific target. Four attack paths:

**(a) Surveillance via authentication metadata.** The authentication flow (§8) requires the holder to present their mark pointer to the requesting site. Evaluate: whether a site controlled by the abuser can request authentication in a way that reveals the target's mark pointer; whether the mark pointer can then be used to monitor the target's Arbitrum One registry activity (is the target issuing sub-marks, receiving updates?); and whether repeated authentication requests to the same site leak timing metadata about the target's activity patterns.

**(b) Credential revocation as harassment.** If the abuser has ever been in a trust relationship with the target (e.g., both participated in a shared community, the abuser was a press operator, or the abuser is in the target's mark issuance chain), evaluate what residual authority the abuser may have retained — specifically, whether they can issue update intents, 6xx negative annotations, or (if authorized) revocation entries against the target's mark. Focus on the `notify_holder: false` path and whether the target can detect a silent 9xx revocation before it causes harm.

**(c) Keyring compromise through intimate partner access.** The keyring is encrypted with `passkey + service_secret`. Evaluate the attack surface for an abuser with physical access to the target's device — specifically, whether device access at an unlocked moment allows them to extract the keyring blob, exfiltrate a sub-mark key from the Secure Enclave (probably not, but confirm), or plant a monitoring mechanism in the wallet app. Evaluate the recovery path for a target who discovers their keyring may be compromised.

**(d) Using the protocol to expose a pseudonymous identity.** The spec's "fully private" mode hides the mark's content from chain observers. But the Nym gateway address is metadata that, once observed in an authentication flow, links the mark to a real-time network endpoint. Evaluate whether an adversary can use a single authentication interaction to correlate a pseudonymous mark identity to a Nym gateway address, and from there use traffic analysis to link the identity to a physical device.

**Who:** Reviewer, with particular attention to §8 (authentication flow) and §ADR-007 (Nym)

**Context needed:** `specs/chitt_protocol_spec.md` §5 (`notify_holder: false`, 6xx/9xx codes), §6 (message signing), §7 (verification), §8 (authentication flow, CHAPI, single-use URL pattern); `specs/ARCHITECTURE.md` §ADR-006, §ADR-007; `raw_notes/Third party attestations when chit holders cause harm.md` (annotator accountability). Key question: can the `right of reply` (counter-annotation) mechanism protect a target against a false annotation campaign?

**Done when:** A finding for each sub-scenario describes the feasibility of the attack against a target who is using the protocol with reasonable care, the protocol features that provide resistance, and whether those features are sufficient or require additional design work.

---

### Step 3.4 — Cross-cutting: Evaluate the third-party safety annotator layer as an attack surface

**What:** The safety annotator layer is designed to allow trusted outside parties to flag bad actors. The architecture has specific properties that shape its attack surface: annotators post to a *separate* on-chain contract (not the main registry); each annotator's mutable pointer points to their annotation records, not directly to the marks being annotated; and valid annotations require signed evidence — either a statement signed by the mark in question, or a statement signed by a mark holder who is themselves trusted. Evaluate three attack paths with this architecture in mind:

**(a) False annotation campaigns.** The evidence requirement is the primary defense against trivial false claims. Evaluate the minimum evidence needed to publish an annotation: can an adversary fabricate a signed statement using a mark in question (requires access to the mark holder's key — unlikely), or can they obtain a statement from a trusted mark holder who is deceived into signing it (social engineering — more realistic)? Assess which of the three adversary types has the resources and motivation to satisfy the evidence bar, and what the false annotation's practical consequence is (annotations are filtered by trusted roots, so impact is bounded by how many communities trust that annotator).

**(b) Annotator compromise or capture.** If an adversary gains control of a widely-trusted annotator's mutable pointer and signing key, they inherit all the credibility that annotator has accumulated. Evaluate: the blast radius of a compromised annotator (all annotations from that annotator become suspect; previously published annotations cannot be retracted from the separate contract without a new entry); whether the annotator's own mutable pointer can be quickly revoked once compromise is detected; and whether the discovery model (annotators have "easily discoverable mutable pointers") makes high-value annotators easy to identify as targets. Specifically consider the state-actor scenario: a government that compels a credible safety annotator to publish false annotations against activists.

**(c) Annotation suppression as a censorship vector.** Because annotation lookup is optional and filtered by trusted roots, an issuer, press, or community operator can configure their systems to exclude specific annotator roots — effectively hiding safety signals from their users. Evaluate whether this is a legitimate design choice (communities should control their own trust configuration) or a censorship vector (bad actors create insular communities that systematically exclude outside accountability). Consider the criminal fraud scenario: a fraudulent community that suppresses annotator roots to hide fraud warnings from victims.

**(d) Discovery-based targeting.** The "easily discoverable mutable pointers" for annotators create a publicly enumerable list of annotator identities. Evaluate whether this enumeration makes safety annotators — who may themselves be activists, journalists, or abuse survivors — into targets for the same adversaries they monitor.

**Who:** Reviewer

**Context needed:** `raw_notes/Third party attestations when chit holders cause harm.md` (annotator architecture, evidence requirements, restorative annotation model); `specs/chitt_protocol_spec.md` §7 (annotation lookup, step 6 — "optional," filtered by trusted roots); `specs/ARCHITECTURE.md` §ADR-008 (EAS as the separate annotation contract). Key architectural facts: annotators post to a separate contract; mutable pointers point to annotation records, not to the marks annotated; evidence (signed statement from the mark in question or from a trusted mark holder) is required.

**Done when:** A finding for each sub-scenario assesses feasibility by adversary type, accounts for the evidence requirement as a meaningful (though not absolute) barrier to false claims, and evaluates whether annotator compromise is a High or Critical risk given the annotator layer's design.

---

### Phase 3 Milestone Review

**Context needed:** Findings from Steps 3.1–3.4; `plans/milestones/phase-1-summary.md`; `plans/milestones/phase-2-summary.md`; `plans/strategic-plan.md` §Goals 3, 4, and 5.

**Done when:** Phase 3 findings reviewed for consistency; cross-adversary patterns identified (which protocol weaknesses appear across multiple adversary types?); a one-paragraph Phase 3 summary written to `plans/milestones/phase-3-summary.md`.

---

## Phase 4: Synthesis and Report

**Objective:** Consolidate findings from all three phases into a single, prioritized report that can inform design decisions.

---

### Step 4.1 — Consolidate and deduplicate findings

**What:** Review all Phase 1–3 findings. Identify findings that describe the same underlying vulnerability from different angles; merge these into single finding entries with multiple adversary-specific impact descriptions. Confirm no finding in Phase 1–3 is missing a severity rating, feasibility rating, or mitigation section.

**Who:** Reviewer

**Context needed:** All Phase 1–3 findings; `plans/milestones/phase-1-summary.md`, `phase-2-summary.md`, `phase-3-summary.md`.

**Done when:** A consolidated findings list exists with no duplicates, each finding has consistent severity/feasibility/mitigation fields, and findings are sorted by severity (Critical → High → Medium → Low).

---

### Step 4.2 — Answer the open questions from the strategic plan

**What:** For each of the five open questions in `plans/strategic-plan.md`, write a brief (1–3 paragraph) answer based on what the red-team discovered. If the question was not answered by the red-team work (e.g., trusted root configuration is a product design question, not a security finding), note what would be needed to answer it and flag it for the author.

**Who:** Reviewer

**Context needed:** `plans/strategic-plan.md` §Open Questions; all Phase findings.

**Done when:** All five open questions have written responses attached to the findings report.

---

### Step 4.3 — Write the red-team report

**What:** Produce the final report at `plans/red-team-report.md`. Structure:

1. Executive summary (half page): the three highest-severity findings and their mitigations.
2. Findings by category (zero-click / key compromise / social engineering), each with: description, adversary applicability, conditions required, harm caused, mitigation options.
3. Protocol strengths (what the red-team found that works well — these are real and should be documented alongside the vulnerabilities).
4. Open questions and deferred issues.
5. Recommended priority order for addressing findings before v1 deployment.

**Who:** Reviewer

**Context needed:** All Phase findings; `plans/strategic-plan.md` §Goals; consolidated findings from Step 4.1; open question answers from Step 4.2.

**Done when:** The report exists, is internally consistent, and each Critical or High finding has a concrete mitigation option stated.

---

### Phase 4 Milestone Review (Final Verification)

**Context needed:** `plans/red-team-report.md`; `plans/strategic-plan.md`.

**Done when:** Every goal from the strategic plan has at least one corresponding finding or confirmed absence in the report. Every Critical finding either has an assigned mitigation or has been explicitly flagged as requiring author input. The report is ready to share with the protocol author.

---

## Clarification Checkpoints Summary

The following are the explicit pause points in this plan where work should stop pending human input:

1. **After Phase 1 Milestone Review:** If any Critical infrastructure finding is identified (arbitrary registry writes, mass revocation, revocation suppression), pause and notify the author before proceeding.

2. **After Step 2.2:** If a compromised press key can issue a backdated 9xx revocation with `notify_holder: false` without a technical counter in the spec, pause and flag explicitly.

3. **Before writing the red-team report (Step 4.3):** Present the consolidated findings list and open question answers to the author. Get confirmation that the severity ratings reflect the author's intent for the protocol's threat model before finalizing the report.

4. **At any point:** If any finding suggests the protocol creates a qualitatively new and serious risk for the populations it intends to protect (activists, journalists, abuse survivors) that was not already acknowledged in the spec's risk register, pause and flag immediately rather than waiting for the report.

---

## Severity Ratings Reference

| Rating | Meaning |
|---|---|
| **Critical** | Attack achievable with modest resources; causes widespread or irreversible harm (e.g., arbitrary registry writes, mass silent revocation of community credentials) |
| **High** | Attack achievable with significant but realistic resources; causes serious harm to specific individuals or communities |
| **Medium** | Attack requires substantial resources or favorable conditions; causes meaningful but recoverable harm |
| **Low** | Attack is theoretical or requires unrealistic conditions; harm is limited or detectable before it escalates |

## Feasibility Ratings Reference

| Rating | Meaning |
|---|---|
| **Practical** | An attacker with the described resources and motivation could execute this today |
| **Theoretical** | The attack is logically sound but requires capabilities or conditions that are unlikely in practice |
