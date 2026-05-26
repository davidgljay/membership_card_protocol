# Phase 3 Red-Team Report — Mark Protocol v0.3
## Social Engineering and Adversary-Specific Scenarios

**Date:** 2026-05-22
**Scope:** Steps 3.1–3.4 per `plans/implementation-plan.md`
**Sources reviewed:** `specs/ARCHITECTURE.md` (including ADR-011), `specs/chitt_protocol_spec.md`, `specs/protocol-objects.md`, `raw_notes/Third party attestations when chit holders cause harm.md`, `red_teaming/phase_1_report.md`, `red_teaming/phase_2_report.md`, `plans/strategic-plan.md`

---

## Executive Summary

Phase 3 assessed four social and adversary-specific attack scenarios: a state actor targeting activists and journalists, a criminal organization perpetuating fraud, a technically sophisticated individual abuser, and the third-party safety annotator layer as an attack surface. Eighteen distinct findings emerged across the four steps.

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 8 |
| Medium | 7 |
| Low | 1 |

**The two Critical findings** arise from the same underlying problem: the protocol's trust model has a root that can be captured, and it does not provide users with a reliable mechanism to detect root capture. Under Condition B of Step 3.1 (government controls the trust root), a state actor can issue credentials to informants that are cryptographically indistinguishable from legitimate community credentials, and can simultaneously revoke all activist marks at scale using the machinery analyzed in Phase 2. Both capabilities depend on governance body capture — which Phase 2 identified as the highest-severity new finding introduced by ADR-011. Finding 3.1-D (governance compulsion as structural Critical) is a direct Phase 3 expansion of Phase 2's Finding 2.X-A.

The protocol's most important Phase 3 strength is its composable verifiability: every credential, annotation, and authentication response is independently verifiable by anyone with IPFS and Arbitrum One access, without trusting any intermediary. This transparency is meaningful against criminal fraud (fraudulent credentials leave auditable trails) and individual abuse (revocations and annotations are signed and attributed). The protocol is substantially stronger than username/password systems for the use cases it addresses.

However, the protocol is not ready for deployment to high-risk populations — activists, journalists, and abuse survivors facing state-level or well-resourced criminal adversaries — without design changes to address the governance compulsion path, the trusted root literacy gap, and the press revocation-as-harassment vector with no technical counter.

---

## Findings Table

| Step | ID | Finding | Severity | State Actor | Criminal Org | Individual Abuser |
|---|---|---|---|---|---|---|
| 3.1 | 3.1-A | Chain analysis identifies press–community associations and issuance timing | Medium | High | Low | Low |
| 3.1 | 3.1-B | Press coercion enables targeted metadata surveillance and silent revocation | **High** | High | Low | Low |
| 3.1 | 3.1-C | Credential-based infiltration allows community mapping via authentication aggregation | Medium | Medium | Low | Low |
| 3.1 | 3.1-D | Governance body capture grants state actor protocol-wide write authority | **Critical** | Critical | Low | Low |
| 3.1 | 3.1-E | Fake credential hierarchy under captured root is undetectable to holders and verifiers | **Critical** | Critical | Low | Low |
| 3.1 | 3.1-F | Retroactive de-platforming via governance-authorized adversary press | **High** | High | Low | Low |
| 3.1 | 3.1-G | Surveillance via forged authentication flows aggregates community activity mapping | **High** | High | Low | Low |
| 3.2 | 3.2-A | Policy creation via governance approval enables legitimately-appearing fraudulent root | Medium | Low | High | Low |
| 3.2 | 3.2-B | Open offer with null constraints enables unlimited credential issuance | Medium | Low | High | Low |
| 3.2 | 3.2-C | Predicate gaming chains weak-predicate marks into higher-value credential contexts | Medium | Low | High | Low |
| 3.2 | 3.2-D | Trusted root literacy gap: users cannot reliably evaluate unfamiliar root policies | **High** | Low | High | Low |
| 3.3 | 3.3-A | Authentication metadata surveillance uses mark pointer as stable tracking identifier | Medium | Low | Medium | **High** |
| 3.3 | 3.3-B | Residual press authority or annotator rights enable credential harassment | **High** | Medium | Low | **High** |
| 3.3 | 3.3-C | Physical device access: Secure Enclave limits key exfiltration but not in-session misuse | Medium | Low | Low | **High** |
| 3.3 | 3.3-D | Pseudonymous identity exposure via Nym gateway correlation from single interaction | **High** | High | Medium | High |
| 3.4 | 3.4-A | False annotation via deceived trusted co-signer is the realistic forgery path | Medium | Low | Medium | Low |
| 3.4 | 3.4-B | Annotator compromise enables false accusations against activists via trusted channel | **High** | High | Low | Low |
| 3.4 | 3.4-C | Annotation suppression allows fraudulent communities to exclude safety signals | Medium | Low | High | Low |
| 3.4 | 3.4-D | Discoverable annotator identities expose safety monitors as targeting surface | Low | Medium | Low | Medium |

---

## Step 3.1 — Scenario: Autocratic Government Targeting Activists and Journalists

### Context

This scenario is evaluated under two conditions producing qualitatively different threat profiles. **Condition A** assumes the government does not control the community's trust root — their attack surface is limited to infrastructure-layer operations. **Condition B** assumes the government controls or has captured the trust root — enabling operations indistinguishable from legitimate community issuance.

The distinction matters: Condition A attacks are painful and require significant resources but leave detectable traces and have partial mitigations. Condition B attacks are largely undetectable and represent a fundamental collapse of the protocol's trust model for that community. Cross-referencing the Phase 2 findings: Finding 2.X-A (governance body as compulsion target) and Finding 2.2-A (backdated silent 9xx revocation) are the primary mechanisms enabling Condition B attacks.

---

### Condition A: Government Does NOT Control the Community's Trust Root

### Finding 3.1-A — Chain Analysis Identifies Press–Community Associations and Issuance Timing

**Severity:** Medium
**Feasibility:** Practical
**Adversary relevance:** State actor (High)

On-chain transactions to the Arbitrum One registry contract are publicly visible regardless of the mark's privacy mode. For "fully private" marks, the registry address is secret-derived and the CID on-chain is encrypted — but the *act of writing to the registry* is always visible: the transaction hash, the press wallet address paying gas, and the timestamp.

**What chain analysis reveals:**

1. **Press wallet fingerprinting**: Every registry write from a given press is paid from the same wallet address. A government intelligence analyst can enumerate all transactions to the registry contract and cluster them by fee payer, producing a map of which press wallets are active, how frequently each writes, and when bursts of activity occur. If any press wallet is publicly associated with a known community, all activity from that wallet is attributable.

2. **Issuance timing correlation**: Bursts of new mark registrations (the press registering new ChittDocuments) correlate with recruitment events, onboarding periods, or organizational milestones. A government watching chain activity can detect that "Press X registered 12 new marks in a 3-day window" around the time of a known organizing event.

3. **Revocation timing**: A revocation entry (8xx or 9xx) is a registry write; its timing is visible. A pattern of revocations shortly after specific events (protests, arrests, public statements) can reveal that the community uses credential revocation as a disciplinary response, and may identify the triggering event.

**What chain analysis does NOT reveal for private marks:**
- The identity of any specific holder (the registry address is secret-derived).
- The content of any mark (encrypted CID on-chain; encrypted IPFS content).
- Which marks belong to the same holder (different marks use different address derivation secrets).

**Cross-reference:** Combined with Finding 1.3-B (Nym de-anonymization), chain analysis timing can be correlated with Nym traffic patterns to narrow down which IP address received which issuance notification — adding identity to the timing data.

**Mitigation:** Presses serving high-risk communities should batch registry writes across time periods (§2's P1 "batched registry writes" feature) to break the issuance-event correlation. Multiple community presses using separate wallets adds noise to wallet-level clustering.

---

### Finding 3.1-B — Press Coercion Enables Targeted Metadata Surveillance and Silent Revocation

**Severity:** High
**Feasibility:** Practical for state actors with jurisdictional reach over press operators
**Adversary relevance:** State actor (High)

This finding combines and extends Phase 1 Findings 1.4-A and 1.4-B and Phase 2 Finding 2.2-A into the state-actor scenario. Under Condition A, press coercion is the most potent tool available to a government that cannot control the trust root directly.

**What legal compulsion of a press enables:**

*Metadata stream (passive surveillance):*
- IP addresses of all HTTPS-submitted update intents (directly identifying non-Nym submitters)
- Nym gateway addresses from Nym-submitted intents (enabling gateway-level traffic analysis per Finding 1.3-D)
- Timing and frequency of all issuance requests (community activity patterns)
- Which mark pointers submitted 810 self-revocation intents (indicating awareness of key compromise, itself intelligence)

*Active operations (targeted harm):*
- Post 9xx revocations with `notify_holder: false` and backdated `effective_date` against specific targets (Finding 2.2-A mechanics)
- Suppress 810 self-revocation intents from specific holders — blocking key compromise recovery
- Selectively delay or refuse issuance requests for specific recipients — invisible denial of community membership

**Multi-press protection analysis:**

If a community lists multiple approved presses in `approved_presses`, a holder who finds one press unresponsive can submit to another. However:
- If all listed presses are within the same state's jurisdiction, legal compulsion applies to all simultaneously.
- A government that compels all presses simultaneously can coordinate the metadata stream and suppress recovery flows across the entire community at once.
- For small communities: listing multiple independent presses is operationally burdensome. The spec's recommendation to use multiple presses is correct but not sufficient as a safeguard against well-resourced state actors.

**Self-hosted presses in other jurisdictions:**

A community-operated press hosted outside the government's reach is a meaningful safeguard — specifically, a self-hosted press in a jurisdiction the government cannot legally compel. This requires:
- Technical capacity to operate a press (docker-compose reference stack lowers the bar but does not eliminate it)
- A jurisdiction with a different legal regime
- The press's `pressAddress` and `pressPublicKey` registered via the Press Registry Governance Body (ADR-011) — which requires governance cooperation

The governance registration requirement (ADR-011) is a friction point for fast-moving communities trying to establish a safe press in response to an acute threat. Governance quorum processes take time; a community under active surveillance may not have that time.

**Mitigation options:**
1. Establish cross-jurisdictional press networks in advance for high-risk communities, rather than waiting for acute threats to trigger the governance registration process.
2. Resolve OQ-4 (holder-direct writes via paymaster for self-revocations) to remove the press dependency from the most critical recovery operation.
3. The spec should provide explicit guidance for communities operating under active state surveillance — "threat model tiers" that map adversary capability to recommended protocol configuration.

---

### Finding 3.1-C — Credential-Based Infiltration Allows Community Mapping via Authentication Aggregation

**Severity:** Medium
**Feasibility:** Practical (if an informant can satisfy the policy's `recipient_predicate`)
**Adversary relevance:** State actor (Medium), Criminal org (Medium)

If a government informant genuinely satisfies a policy's `recipient_predicate`, they receive a valid mark through legitimate channels. This mark is cryptographically indistinguishable from any legitimate community member's credential.

**What a valid mark enables for intelligence gathering:**

1. **Authentication request interception**: The informant operates or infiltrates a community service that requests authentication. Every community member who authenticates to that service presents their `chitt_pointer` in the authentication response. The informant accumulates a list of mark pointers — stable identities for active community members.

2. **Open offer issuance**: If the informant is in a position to create or distribute an open offer (`allow_open_offers: true`), they can distribute claim links and observe every recipient's `chitt_pointer` when they accept. The informant receives a notification (§2) when each acceptance completes.

3. **Signed message interception**: If the informant is in the `recipients` array of community messages, they receive signed envelopes addressed to them. The `signer_chitt` field in each signature identifies the author's mark pointer — mapping community members who communicate with the informant.

**What this does NOT reveal:**
- The holder's real-world identity (the mark contains no identity-linking fields unless the policy explicitly includes them).
- Other community members' marks or activities that don't involve the informant directly.

**The mapping becomes dangerous over time:** Each authentication to an informant-controlled service adds one mark pointer to the surveillance list. Over weeks or months, a significant fraction of active community members' mark pointers are identified — enabling correlation with subsequent de-anonymization attacks via Nym (Finding 1.3-B).

**Mitigation:** The authentication flow's unlinkability property (one mark per service context, as noted in §8) limits the utility of any single authentication event. However, repeated use of an informant-controlled service builds the same map more slowly. Communities should be educated about the authentication metadata exposure model and the importance of evaluating the trustworthiness of services before authenticating.

---

### Condition B: Government Controls or Has Captured the Community's Trust Root

### Finding 3.1-D — Governance Body Capture Grants State Actor Protocol-Wide Write Authority ⚠ Critical

**Severity:** Critical
**Feasibility:** Practical for state actors with jurisdiction over governance body members
**Adversary relevance:** State actor (Critical)

This finding expands Phase 2 Finding 2.X-A into the state-actor social engineering scenario. With ADR-011, the Press Registry Governance Body controls press authorization for all policies across the entire protocol. A state actor who can compel, infiltrate, or capture this governance body gains the ability to:

1. **Authorize a state-controlled press for any policy** via `AuthorizePress(policyAddress, stateControlledPressAddress, stateKey)` — using quorum signatures obtained through legal compulsion, insider compromise, or social engineering of governance body members.

2. **Revoke all legitimate presses for target communities** via `RevokePress` — blocking all issuance and update operations for the community until new presses can be registered (requiring further governance action).

3. **Create new root policies** via `RegisterPolicy` (if the Root Policy Governance Body is also captured) — establishing entirely fraudulent trust hierarchies that appear legitimate on-chain.

**What makes governance compulsion the highest-severity state-actor path:**

Under Condition A (no trust root control), a state actor must compromise or coerce individual presses — each of which may be in a different jurisdiction, operated by different organizations, with different legal exposure. Under governance body capture, a single successful coercion action applies to all policies and all presses simultaneously.

**Governance key holder identity as the critical variable (OQ-14):**

ADR-011 defers the question of whether governance key holders should be pseudonymous or identifiable. This is not a neutral design choice: identifiable key holders are coercible by states with jurisdiction over them; pseudonymous key holders are harder to coerce but harder to hold accountable. For the state-actor threat model, governance key holders who are publicly identifiable individuals or named organizations are a direct targeting list for legal compulsion.

A government that wants to authorize its own press under a specific policy needs to compel enough governance key holders to reach quorum. If key holders are named, they are findable. If key holders span only one or two jurisdictions, a government with reach in those jurisdictions reaches quorum without difficulty.

**No technical defense exists under the current spec:** Once the governance body's quorum is compromised (whether through legal process, infiltration, or threat), the protocol's on-chain authorization model operates exactly as intended — except the intentions belong to the adversary, not the community.

**Mitigation directions:**
1. **Mandatory multi-jurisdiction quorum**: Governance charters must require that quorum spans at least N distinct legal jurisdictions (minimum recommended: 5), making coordinated legal compulsion across all jurisdictions simultaneously impractical.
2. **Pseudonymous governance participation**: At minimum for the Press Registry Governance Body, allow pseudonymous key holders (organizations or anonymous individuals) so that legal compulsion cannot identify all key holders.
3. **Transparency log with monitoring alerts**: All `AuthorizePress` and `RevokePress` transactions should be monitored by affected communities, who should receive immediate notification of any change to their policy's press authorization. Detection does not prevent the attack but enables rapid response.
4. **Publish the governance charter before v1 deployment**: Deploying v1 without a published governance charter means governance operates by informal norms — and informal structures are exactly what coercive actors exploit. The charter should specify quorum thresholds, jurisdiction distribution requirements, and emergency response procedures before any real community adopts the protocol.

---

### Finding 3.1-E — Fake Credential Hierarchy Under Captured Root Is Undetectable to Holders and Verifiers

**Severity:** Critical
**Feasibility:** Practical once trust root is controlled
**Adversary relevance:** State actor (Critical)

With a captured trust root (either through the policy creation chain or via governance body compulsion), a state actor can create a policy chitt and issue marks to informants that satisfy `required_predicate` checks in community authentication flows.

**The attack mechanics:**

1. The state creates or captures a policy whose trust chain reaches a root that the community has configured as trusted (OQ-9 — trusted root configuration UX is currently unresolved).
2. The state issues marks to informants under this policy. The marks are valid: they carry a legitimate press signature and a holder countersignature.
3. When an informant uses their mark to authenticate to a community service, the service's wallet verifies the chain — all the way to the trusted root — and returns `chain_reaches_trusted_root: true`.
4. The community service admits the informant.

**Why this is undetectable at the protocol level:**

The protocol's chain verification (§7) confirms that each link in the chain carries a valid signature and that the chain reaches a trusted root. It does not and cannot verify that the root's identity corresponds to a legitimate community authority rather than a state actor who has acquired or fabricated that authority. The verification result is correct: the chain does reach the trusted root. The problem is that the trusted root is compromised.

**The trusted root configuration gap (OQ-9):**

How do users know which roots to trust? This is an unresolved open question. If trusted roots are configured by the wallet application developer (analogous to browser root CA bundles), then capturing the wallet developer or the update mechanism enables inserting a fraudulent root. If trusted roots are self-configured by users, most users do not have the literacy to evaluate unfamiliar roots — and a government can create a root that appears legitimate.

The protocol currently has no mechanism for:
- Verifying that a root claiming to represent "Organization X" actually represents that organization.
- Detecting that a previously-trusted root has been captured or compromised.
- Providing users with any signal that a credential chain passes formal verification but comes from a captured trust hierarchy.

**What the fake credential hierarchy enables:**

An informant with a fake-but-verifying credential can:
- Access community platforms that use `required_predicate` with the informant's policy as the required chain.
- Participate in authentication flows and accumulate mark pointers of other community members (see Finding 3.1-C mechanics, now applied to a valid mark).
- Sign messages that appear to come from a legitimate community member.
- If the informant's mark is also used to satisfy predicates for receiving other community marks, the informant gains deeper access over time.

**Mitigation directions:**
1. **Trusted root verification ceremony**: Communities should establish out-of-band verification of root identity before trusting a new root — for example, the root policy authorizer signs a statement at a known in-person event or verifiable public channel. This does not prevent compromise after verification but creates a known-good baseline.
2. **Root policy change monitoring**: Changes to trusted root policies should trigger immediate alerts to all communities relying on them. An unexpected change to a root's field definitions, press list, or authorizer key is a compromise signal.
3. **Resolve OQ-9 as P0 before high-risk deployment**: The trusted root configuration UX is currently listed as High priority in the open questions but should be treated as a deployment blocker for communities facing state-level adversaries.

---

### Finding 3.1-F — Retroactive De-Platforming via Governance-Authorized Adversary Press

**Severity:** High
**Feasibility:** Practical once governance body is captured
**Adversary relevance:** State actor (High)

Under Condition B, with the governance body captured (Finding 3.1-D), the state actor authorizes their own press for the target community's policy. Using that press and the mechanics of Finding 2.2-A:

**The attack sequence:**

1. State press is authorized via `AuthorizePress` (governance body quorum, now controlled or compelled).
2. State press posts 9xx revocations against all activist marks in the policy's scope:
   - `code: 911` ("bad actor or harmful conduct")
   - `notify_holder: false` (no Nym notification to victims)
   - `revocation.effective_date`: set to a date before any specific event the state wants to contextualize (e.g., before a protest, before a news publication, before a legal filing)
3. All affected marks now show as revoked in the on-chain registry.
4. Verifiers who check any of these marks return `is_currently_valid: false` with a 9xx code.
5. Every community platform that performs full verification rejects the affected holders.

**Blast radius:** All marks under the controlled policy, simultaneously, from a single authorized press.

**The backdated narrative harm:** A 911 revocation with an `effective_date` months before the attack creates permanent false evidence in the append-only log. Verifiers checking historical signing validity will evaluate signatures made by the holder on or after that date as `was_valid_at_signing_time: false`. The holder's prior statements, votes, and authentications become retroactively suspect. This is a manufactured history rewrite.

**Recovery:** The community can issue successor marks under a new, clean policy (if one can be established with an uncompromised governance registration), with `supersedes` pointers to the revoked marks and documentation of the attack. This requires:
- A clean governance registration for the new policy (requires governance body cooperation — potentially the same body that was just compelled).
- Community communication to all affected holders.
- Tooling for fast successor mark issuance.

Recovery from a governance-body-mediated attack is structurally harder than recovery from a single compromised press, because the governance body is the only path to re-establishing legitimate press authorization.

**Mitigation:** The primary mitigation is preventing governance body capture (Finding 3.1-D mitigations). Once capture has occurred, the response is social and operational rather than cryptographic: maintain out-of-band communication channels, publish attack documentation publicly, establish a successor governance structure, and migrate to new infrastructure.

---

### Finding 3.1-G — Surveillance via Forged Authentication Flows Aggregates Community Activity Map

**Severity:** High
**Feasibility:** Practical once a legitimate-appearing mark is established
**Adversary relevance:** State actor (High)

Under Condition B, a state actor with a legitimate-appearing mark (from Finding 3.1-E) operates a community service that requests authentication. Every community member who authenticates to this service presents:

- Their `chitt_pointer` (stable mark identity)
- A signed authentication response tied to their mark
- The timestamp of authentication
- (For HTTPS fallback) their wallet service's IP address

**What aggregate collection enables:**

Over time, the state service accumulates the `chitt_pointer` for every active community member who has authenticated to it. Combined with chain analysis (Finding 3.1-A) and Nym correlation (Finding 1.3-B), this creates a community membership roster linked to:
- Stable mark identities (which can be correlated with Nym gateway addresses)
- Authentication timing (activity patterns)
- Any `requester_predicate` the service specifies (can narrow the membership list to specific subgroups)

**The predicate specification as an intelligence tool:** The authentication request can include a `required_predicate` — "this service requires that you hold a mark issued under Policy X." A state actor who knows the policy CID used by a specific activist cell can construct a predicate that authenticates only members of that cell, filtering the captured mark pointers by group membership.

**Cross-reference:** This finding is the adversarial application of the §8 authentication flow. The authentication flow's privacy properties (CHAPI hides wallet service identity; Nym hides wallet IP from requester) protect the wallet service but not the community member's mark identity, which is the authentication payload by design. The security model assumes the requesting service is trustworthy.

**Mitigation:** The spec's §8 discussion of unlinkability (use a different mark per service context) is the primary defense. Communities should be educated to use context-specific marks for high-sensitivity services and to be suspicious of services that aggregate authentications across many community sub-groups.

---

## Step 3.2 — Scenario: Criminal Organization Perpetuating Fraud

### Context

A criminal organization's primary objective is credential fraud — establishing credentials that appear legitimate to victims who cannot evaluate the trust chain, then using those credentials to defraud. The protocol's governance model (ADR-011) raises the bar for establishing fraudulent root policies but does not eliminate the fraud vector, because the governance body evaluates compliance at registration time and cannot predict future fraudulent use.

### Finding 3.2-A — Governance Registration Enables Legitimately-Appearing Fraudulent Root

**Severity:** Medium
**Feasibility:** Practical with sufficient resources and patience
**Adversary relevance:** Criminal org (High)

With ADR-011, creating a root policy requires Root Policy Governance Body quorum via `RegisterPolicy`. This is a meaningful barrier against trivially fraudulent policies. However:

**The governance gate evaluates registrations at a point in time.** A criminal organization that presents a convincing legitimate use case at registration time — "Certified Financial Advisors Network" with credentialed-appearing founders and a plausible policy structure — may pass governance review. The organization then operates the policy fraudulently, issuing credentials to confederates and victims.

**The governance body is not omniscient.** Governance review covers policy structure compliance with published ethics criteria. It cannot verify:
- That the registering organization will remain legitimate over time.
- That the organization's field definitions accurately represent what credentials they will issue.
- That the `recipient_predicate` will be applied honestly.

**Sub-policy proliferation:** Once a root policy is registered and marked are issued under it, holders of those marks can create sub-policies (subject to `policy_creation` constraints). A criminal organization that obtains a few marks from a legitimate policy, using whatever predicate that policy requires, can create sub-policies under those marks — inheriting the legitimate root's trust lineage.

**The `policy_creation` constraint gap:** The spec states: "Without [the `policy_creation` field], holders are unconstrained in what policies they create." If a legitimate root policy does not include `policy_creation` constraints, any holder of a mark under that policy can create sub-policies with arbitrary fields and predicates, inheriting the legitimate chain but issuing fraudulent credentials.

**Mitigation:** Root policy operators should uniformly include `policy_creation` constraints that prohibit sub-policies from using professional or consumer-trust-implying language (e.g., "certified," "licensed," "accredited") without explicit permission. The governance body should check for `policy_creation` constraints as part of the registration evaluation.

---

### Finding 3.2-B — Open Offer with Null Constraints Enables Unlimited Credential Issuance

**Severity:** Medium
**Feasibility:** Practical
**Adversary relevance:** Criminal org (High)

The `allow_open_offers: true` flag enables mass issuance. The open offer document supports `max_acceptances: null` and `expires_at: null` — explicitly allowed, with the spec noting: "An open chitt offer with no constraints whatsoever requires explicit acknowledgment from the issuer at creation time."

**The on-chain enforcement reality:** The smart contract skips the `max_acceptances` check when the value is null and the `expires_at` check when null. A null-constrained open offer can issue marks to an unlimited number of claimants with no expiry. The issuer's signature commits to the null values — confirming they are intentional — but does not limit the rate or total volume of issuance.

**The fraud application:** A criminal organization operating a fraudulent "Certified Financial Advisor" policy creates an open offer with null constraints and distributes the claim link widely (email campaigns, social media, phishing sites). Any victim who follows the link and accepts receives a validly-signed credential that verifies correctly to a legitimate-appearing chain. The credential appears to certify the holder as a "Certified Financial Advisor" — and any verifier who doesn't independently evaluate the policy root will accept it.

**The rate control gap:** The only practical controls on open offer mass issuance are social (the issuer's reputation) and legal (fraud statutes). There is no protocol mechanism to limit issuance velocity for a null-constrained open offer.

**Mitigation:** The spec should recommend that verifiers implement velocity checks: a policy that issues more than N credentials in a short time window should be flagged for human review before the credentials are accepted in high-stakes contexts. This is a verifier-side heuristic, not a protocol-level control.

---

### Finding 3.2-C — Predicate Gaming Chains Weak-Predicate Marks into Higher-Value Credential Contexts

**Severity:** Medium
**Feasibility:** Practical with systematic effort
**Adversary relevance:** Criminal org (High)

Many deployed policies will specify `required_predicate` checks that require the presenter to hold a mark under a specific upstream policy. A criminal organization can systematically target the weakest links in predicate chains:

**The credential laundering path:**

1. Identify a policy with no `recipient_predicate` (open issuance) or a weak predicate that can be satisfied through social engineering.
2. Obtain marks under that policy — either legitimately (satisfying the predicate honestly) or through a purchased or fabricated predicate chain.
3. Use those marks to satisfy the `required_predicate` for a moderately valuable policy (e.g., "must hold a community member mark" → receive a "verified trader" mark).
4. Use the "verified trader" mark to satisfy the predicate for a high-value policy (e.g., "must hold a verified trader mark" → receive a "licensed financial professional" mark).

**The chain depth defense:** The `chain_depth_at_most` predicate limits how deep a chain can be at the point of authentication. A policy that specifies `{ "chain_depth_at_most": 2 }` will not accept credentials with long chains — but many policies will not use this predicate, and a criminal organization targeting policies without it can build arbitrarily deep chains.

**The detection gap:** Each step in the predicate chain is individually valid — the criminal organization satisfied the predicate at each level. The fraud is at the root level (the initial weak policy was exploited), but by the time a verifier checks the chain, they see a sequence of valid credentials, each properly signed by authorized presses, each reaching a trusted root.

**Mitigation:** High-value policies should use `chain_depth_at_most` constraints and should explicitly specify trusted root policies by CID rather than accepting any chain that verifies. A "must hold a mark under this specific root policy" check is harder to launder than a "must hold any mark from any chain that reaches any trusted root" check.

---

### Finding 3.2-D — Trusted Root Literacy Gap Creates Systematic Fraud Enablement

**Severity:** High
**Feasibility:** Practical — this is the default state for most users
**Adversary relevance:** Criminal org (High)

The protocol's trust model requires users to independently evaluate which roots they trust. This is correct as a cryptographic design: the protocol should not mandate a single authority over trustworthy roots. However, it creates a systematic harm vector that the protocol's design must acknowledge:

**Most users do not have the literacy to evaluate unfamiliar policy roots.** A credential that verifies correctly — chain reaches a trusted root, all signatures valid, press is authorized — appears identical to a fraudulent credential that passes the same checks under a carefully-constructed fraudulent root. The verification result (`chain_reaches_trusted_root: true`) does not tell the user whether the root itself is legitimate.

**The browser CA analogy:** The spec correctly identifies this as analogous to the browser CA problem. The practical resolution in browsers has been: default-trusted CA lists curated by browser vendors, with mechanisms for revocation and distrust. The protocol currently has no equivalent default-trusted list infrastructure; OQ-9 leaves trusted root configuration as an unresolved design question.

**The fraud consequence in practice:** A victim who receives a "Certified Financial Advisor" credential from a criminal organization — and presents it to a service that verifies it — has a credential that:
- Has both required signatures (press + holder).
- Reaches a root that the service trusts (if the criminal organization has successfully registered or faked a trusted root).
- Passes all §7 verification stages.

The service's verification machinery returns `chain_reaches_trusted_root: true`. The fraud is invisible to the protocol.

**Mitigation:** This is partially an application-layer problem — wallet and service developers must help users make informed trust decisions. However, the protocol specification should explicitly acknowledge the trusted root literacy gap as a known limitation and provide guidance on:
1. Default-trusted root list infrastructure (analogous to browser CA bundles).
2. Human-readable credential provenance display in wallet UIs that shows the full trust chain in user-understandable terms.
3. Governance requirements for root policies that serve consumer-facing contexts (e.g., mandatory disclosure of the registering organization's real-world identity).

---

## Step 3.3 — Scenario: Technical Abuser Surveilling and Harassing a Target

### Context

A technically sophisticated individual abuser — a former partner, a stalker with some technical capability, or an adversary within a shared community — attempts to use the protocol to track, control, expose, or harm a specific target. This scenario is the most directly personal of the three adversary types and is the one most likely to affect the protocol's user populations of abuse survivors and community members with personal safety concerns.

### Finding 3.3-A — Authentication Metadata Surveillance Uses Mark Pointer as Stable Tracking Identifier

**Severity:** Medium
**Feasibility:** Practical
**Adversary relevance:** Individual abuser (High), Criminal org (Medium)

The authentication flow (§8) requires the holder to include their `chitt_pointer` in the authentication response. This is required for the requesting site to verify the credential. As a consequence, every site a holder authenticates to receives their stable mark identity.

**The tracking mechanism:**

1. Abuser operates or infiltrates a service that the target regularly authenticates to.
2. Target's `chitt_pointer` appears in every authentication response.
3. Abuser stores the pointer with timestamps, building a log of "target was active at [times]."
4. If the target uses the same mark across multiple of the abuser's services (or the abuser controls multiple services), the abuser aggregates a cross-service activity timeline.
5. Abuser can poll the on-chain Arbitrum One registry for the target's mark pointer: any new log entries (updates, revocations) are observable, revealing when the mark was last modified.

**The spec's unlinkability recommendation:** §8 notes that using a different mark per service context limits cross-service correlation. However:
- Many users will use one mark across multiple services — especially in small communities where a single "community member" mark is the credential.
- Using per-service marks requires managing multiple keychains, which most users will not do.
- If the abuser is within the target's community, they may know which mark the target uses for community authentication.

**On-chain monitoring:** Once the abuser has the target's mark pointer, they can subscribe to on-chain events for that registry address. Any update to the mark's log head (a new 8xx/9xx entry, a field update, even a 300-neutral-update) is visible as a transaction. The abuser knows when the target's credential was last active, which is itself surveillance data.

**Mitigation:** Wallet clients should make it easy to use per-context marks and should automatically suggest context separation when the same mark has been used across many unrelated services. The spec's §8 unlinkability note should be promoted from optional guidance to a recommended practice in the wallet UX specification.

---

### Finding 3.3-B — Residual Press Authority Enables Credential Revocation as Harassment

**Severity:** High
**Feasibility:** Practical where abuser has had any authorized role
**Adversary relevance:** Individual abuser (High), State actor (Medium)

If the abuser was once a press operator for a community that the target is a member of, they may retain the ability to post entries against the target's mark — even after the abuser's relationship with the community has ended.

**The residual authority scenarios:**

1. **Former press operator, press not yet revoked**: If the abuser's press has not been explicitly revoked via `RevokePress` (governance quorum required under ADR-011), the press key remains active in `PressAuthorizations`. The abuser can continue posting entries against marks in the policy's scope. This includes:
   - 9xx revocations with `notify_holder: false` and backdated `effective_date`.
   - 6xx negative annotations (concern entries that reduce the target's visible standing without formal revocation).
   - Suppressing 810 self-revocation intents the target submits.

2. **Former press operator, press revoked**: Once `RevokePress` is executed, the press key loses write authority. Past entries the press posted (including any 9xx entries) remain in the append-only log permanently — they cannot be removed. The target can obtain a successor mark with a `supersession_note` documenting the situation, but the original entries remain visible.

3. **Annotator with residual signing authority**: If the abuser holds an annotator mark (under the third-party annotation system), they can post annotations against the target. The evidence requirement (a statement signed by the mark in question, or by a trusted mark holder) applies — but the abuser may have prior signed statements from the target, or may be able to socially engineer a trusted co-signer (see Finding 3.4-A).

**The `notify_holder: false` harassment path:** The most damaging scenario is a 9xx entry with `notify_holder: false`. The target does not receive a notification. They discover the revocation only when they attempt to authenticate somewhere and are rejected. The backdated `effective_date` means verifiers see the target as having been a "bad actor" before recent events — a reputational attack that is particularly harmful if the target has just publicly reported abuse and community members are evaluating their credibility.

**The time-to-discovery gap:** Between the posting of the silent revocation and the target's discovery, the target is unknowingly presenting themselves as a verified community member in contexts where they are now revoked. This includes submitting signed statements attributed to their community identity, which may be flagged retroactively as made by a revoked member.

**Mitigation:**
1. **Holder log polling as a required client behavior** (also flagged in Phase 2): Wallet clients should check the on-chain head CID at regular intervals (at minimum daily) and notify the holder of any new log entries, regardless of `notify_holder`. This is the single most important individual-abuser mitigation.
2. **Press deregistration as part of community relationship exit**: Communities should have a documented process for revoking a press operator's authorization when they leave a community role, rather than leaving it as an optional governance action.
3. **6xx annotation right of reply**: The spec's P2 note on "update dispute" (holder can publish a 4xx counter-statement to a contested annotation) should be elevated to a standard workflow described in the spec, specifically for cases of community-internal harassment via annotations.

---

### Finding 3.3-C — Physical Device Access: Secure Enclave Limits Key Exfiltration but Not In-Session Misuse

**Severity:** Medium
**Feasibility:** Practical with physical device access
**Adversary relevance:** Individual abuser (High)

This finding cross-references Phase 2 Finding 2.3-C and applies it specifically to the intimate partner abuse scenario.

**What Secure Enclave/TPM prevents:**
- Raw sub-chitt private key exfiltration from the device. The hardware boundary means that even an attacker with OS-level access cannot read the key material from storage. The key can only be used by operations that pass through the Secure Enclave API.

**What Secure Enclave does NOT prevent in the individual abuser context:**
1. **In-session signing**: While the device is unlocked (screen on, biometrics or PIN recently used), the wallet app can sign operations without an additional authentication prompt — depending on wallet implementation. An abuser with brief access to an unlocked device can initiate authentication flows and message signings.
2. **Passkey observation**: An abuser who lives with or regularly observes the target can observe PIN entry, shoulder-surf biometric setup, or note the device's unlock pattern. The passkey protecting the keyring is as strong as the target's ability to keep it secret.
3. **Monitoring software installation**: An abuser with unlocked device access and sufficient technical skill can install a monitoring application that captures biometrics, PIN entry, application screens, and network traffic — effectively converting the phone into a surveillance device. Sub-chitt keys in Secure Enclave cannot be extracted, but a monitoring app can capture signed payloads before they leave the app.
4. **Keyring blob address**: If the wallet stores the IPFS keyring blob address in local app storage (likely for offline access), the abuser can note this address and fetch the encrypted blob. The blob requires `passkey + service_secret` to decrypt — but if the passkey is observed and the service secret is locally cached, decryption may be feasible.

**Recovery for a discovered intimate-partner compromise:**
1. Reset the device (not just the app) to eliminate any installed monitoring software.
2. Generate a new passkey and re-encrypt the keyring under it.
3. Register with a new primary service to obtain a new `service_secret`.
4. Submit 810 intents for any sub-chitts that may have been used by the abuser.
5. Consider whether the YubiKey backup registration should also be updated if the abuser may have observed the PIN.

**Mitigation:** The wallet spec should require biometric confirmation for every individual signing event (not just app unlock), making brief physical access insufficient for misuse. This should be documented as a required wallet behavior for safety-sensitive deployments, not a performance optimization choice.

---

### Finding 3.3-D — Pseudonymous Identity Exposure via Nym Gateway Correlation from Single Interaction

**Severity:** High
**Feasibility:** Practical for a motivated individual abuser with some technical capability
**Adversary relevance:** Individual abuser (High), State actor (High), Criminal org (Medium)

This finding applies Phase 1 Finding 1.3-D to the individual abuser scenario. The protocol exposes the target's Nym gateway address in their mark metadata — for public marks, this is plaintext.

**The exposure chain:**

1. The abuser obtains the target's `chitt_pointer` from a single authentication interaction (see Finding 3.3-A).
2. For a fully public mark: the abuser fetches the mark metadata from IPFS, which includes the Nym gateway address in plaintext.
3. The abuser now knows the stable Nym endpoint that receives all of the target's mark-related messages.
4. Traffic analysis: even without reading message content (Nym encrypts content), the gateway's message arrival timestamps reveal:
   - When the target receives issuance confirmations (someone new issued them a mark).
   - When the target receives update notifications.
   - When the target receives authentication responses (they authenticated somewhere).
5. A technically capable abuser who also operates Nym nodes can attempt partial de-anonymization via timing correlation — correlating outbound authentication response traffic with the gateway's inbound message timing.

**The cross-mark correlation problem (Finding 1.3-D):** If the target uses the same Nym gateway address for multiple marks across different communities, the abuser who knows one of the target's marks can infer that other marks sharing the gateway address belong to the same holder — linking otherwise pseudonymous identities.

**The consequence for abuse survivors:** A target who has left an abusive situation, established a new community identity under a pseudonymous mark, and is building a new life may still be findable via their Nym gateway address if the abuser knew their old mark. Gateway address persistence creates a tracking vector that survives context separation.

**Individual abuser vs. state actor capability:**
- *Individual abuser*: Can observe gateway activity patterns (message arrival timing) without Nym node operation. The gateway address is the primary finding; timing data is secondary. For most individual abusers, this stops at "I know when they receive messages" — which is still surveillance but short of full de-anonymization.
- *State actor*: Can use Nym node infrastructure for full traffic correlation (Finding 1.3-B) — linking the target's Nym gateway to a physical IP.

**Mitigation:** Wallet clients should recommend periodic Nym gateway address rotation — using the append-only log update mechanism — for users with public marks or users who have recently authenticated to untrusted services. Different marks should use different gateway addresses by default to prevent cross-mark correlation. The spec's existing note on gateway address rotation (Finding 1.3-D mitigations) should be elevated from a suggestion to a wallet UX requirement for safety-sensitive deployments.

---

## Step 3.4 — Cross-Cutting: The Third-Party Safety Annotator Layer as an Attack Surface

### Context

The safety annotator system (described in `raw_notes/Third party attestations when chit holders cause harm.md`) operates on top of the EAS annotation layer (ADR-008). Annotators post to a separate EAS contract on Arbitrum One; their mutable pointers point to annotation records rather than to the annotated marks. Valid annotations require signed evidence: a statement signed by the mark in question, or by a trusted mark holder. Annotators are filtered by trust roots configured independently from normal mark roots.

Three properties shape the safety layer's attack surface: (1) evidence requirements are mandatory but not cryptographically foolproof against social engineering; (2) annotators have "easily discoverable mutable pointers" by design; and (3) annotations on EAS are immutable — once posted, they cannot be deleted, only superseded.

### Finding 3.4-A — False Annotation Via Deceived Trusted Co-Signer Is the Realistic Forgery Path

**Severity:** Medium
**Feasibility:** Practical with social engineering; Impractical without it
**Adversary relevance:** Criminal org (Medium), State actor (Low direct, but see 3.4-B)

The annotation evidence requirement has two branches:
1. A statement signed by the mark in question — requires the target's private key. Practically infeasible to forge.
2. A statement signed by a trusted mark holder who vouches for the annotation's accuracy — requires social engineering a trusted member of the community or annotator ecosystem.

**The realistic forgery path — option 2:**

A criminal organization targeting a specific community member who is exposing their fraud scheme can attempt to deceive a trusted mark holder into signing a statement that appears to describe the target's conduct. The key challenge for the attacker: the trusted co-signer must believe they are signing an accurate statement. Social engineering scenarios:
- Present manipulated or selectively edited evidence to a trusted community member.
- Create a fake context in which the trusted member believes they observed the harmful conduct directly.
- Use an informant who is a legitimate community member and a trusted co-signer (a variant of Finding 3.1-C infiltration).

**Practical constraints on the attack:**
- The annotator must still publish the annotation under their key, accepting reputational accountability.
- The annotation is public and can be contested via counter-annotation (right of reply).
- Communities can require N independent corroborating annotations before acting — the spec describes this as a recommended verification policy.
- A bad-faith annotator can itself be annotated by other annotators.

**Why this is Medium rather than High:** The evidence requirement, even imperfectly enforced, raises the cost of false annotations substantially compared to a bare statement system. A determined criminal organization can mount this attack, but it requires sustained social engineering effort against multiple parties. The harm is bounded by the annotator's trust scope — an annotator not trusted by many communities has limited blast radius.

**Mitigation:** The right of reply mechanism (holder can publish a signed counter-annotation) is essential and should be prominently surfaced in wallet UIs. The spec's requirement for published methodology from annotators means that annotators who publish false statements are accountable — their track record is part of their reputation.

---

### Finding 3.4-B — Annotator Compromise Enables False Accusations Against Activists via Trusted Channel

**Severity:** High
**Feasibility:** Practical for state actors; Medium for well-resourced criminal orgs
**Adversary relevance:** State actor (High), Criminal org (Medium)

A widely-trusted safety annotator — a digital rights organization, a journalist safety network, a professional licensing body — that is compromised or compelled becomes a mechanism for publishing false accusations against activists with the full weight of the annotator's credibility.

**The blast radius of annotator key compromise:**

1. All prior annotations from the annotator's key become suspect retroactively. Communities relying on those annotations cannot distinguish the legitimate historical annotations from any future false ones without re-evaluating each.
2. EAS annotations are immutable on-chain — a false annotation posted under the compromised key cannot be deleted, only superseded by a counter-annotation from the same key (which the attacker controls) or from another trusted annotator.
3. The annotator's mutable pointer can be updated to revoke the compromised annotator identity going forward — but this leaves the historical annotation record in an ambiguous state.

**The state actor compulsion path:**

A government that compels a safety annotator to publish false annotations against activists achieves:
- A false accusation appearing to come from a trusted, neutral third party
- The annotation citing a published methodology and purporting to have evidence in custody
- Community members who trust the annotator will act on the annotation — excluding the activist from community spaces, treating their credentials with suspicion
- The annotation is signed and publicly visible — it becomes the evidence record that the state can cite in legal proceedings or public communications as "an independent safety organization flagged this person"

This is a particularly insidious attack because the safety layer is specifically designed to protect vulnerable people. Turning it against those people — using the safety annotator's accumulated trust as a weapon — is the most dangerous misuse of the annotation architecture.

**The discovery problem:** How does a community detect that their trusted annotator has been compromised? The annotator's methodology and evidence standards are published — but a compelled annotator may post a plausible-seeming annotation with fabricated evidence. Detection requires:
- The annotated target publishing a credible counter-annotation via right of reply.
- Another trusted annotator contesting the finding.
- The annotating organization publicly disclosing the compulsion (which may itself create legal risk for the organization).

**Mitigation:**
1. **Diverse annotator trust**: Communities should configure safety annotator trust across multiple independent organizations in different jurisdictions. A single compelled annotator can be contested by others if the trust set is diverse.
2. **Annotation evidence transparency**: Requiring annotators to publish sufficient evidence to enable community review (with appropriate privacy protections for sensitive evidence categories) limits the ability to post fabricated annotations without challenge.
3. **Corroboration thresholds**: Verifier policies that require N independent annotators to concur before acting on a specific annotation category are specifically effective against single-annotator compulsion. The spec mentions this as a recommended verification policy — it should be documented as the recommended default for communities facing state-level adversaries.
4. **Annotator emergency disclosure channel**: Organizations that operate as safety annotators should publish a verified, out-of-band channel for disclosing compulsion — analogous to a "warrant canary" — so that communities can know when an annotator is operating under duress.

---

### Finding 3.4-C — Annotation Suppression Enables Fraudulent Communities to Exclude Safety Signals

**Severity:** Medium
**Feasibility:** Practical (configuration, not attack)
**Adversary relevance:** Criminal org (High), Individual abuser (Medium)

Because annotation lookup is optional (§7, stage 6: "optional — query EAS for third-party annotations") and filtered by trusted roots, any community platform can configure its verification pipeline to skip annotation lookups entirely or to exclude specific annotator roots.

**The fraud application:**

A criminal organization operating a fraudulent community platform simply does not configure any trusted annotator roots. Victims who authenticate to the platform, receive credentials, and interact with it never see safety warnings from annotators who have flagged the platform or its operators. The community is an insular trust bubble that excludes outside accountability by design.

**The design tension:** This is not a protocol flaw — it is a deliberate design choice that communities should control their own trust configuration. A community of security researchers might legitimately exclude general-purpose safety annotators. The problem arises when the exclusion is designed to prevent victims from seeing warnings about the community itself.

**The spec's position:** The spec acknowledges that annotation lookup is optional and filtered. This is the correct default — mandatory annotation lookup from any annotator would create a censorship vector in the other direction (annotators blocking community participation for political reasons). The design correctly places annotation trust configuration at the community level.

**What the protocol cannot prevent:** A community that actively chooses to suppress safety signals cannot be compelled by the protocol to include them. This is analogous to a website that does not display safety warnings from third parties — the warning exists somewhere, but the community controls whether it is surfaced to its members.

**Partial mitigations:**
1. Wallet services (rather than community platforms) could implement their own annotation lookup as a client-side check, independent of the requesting service's configuration. A wallet that checks annotations at authentication time — before presenting the holder's credential — can warn the holder that they are authenticating to a service whose operators have been flagged, even if the service doesn't check annotations.
2. The spec should document the annotation suppression pattern as a known risk in the annotator architecture section, so communities deploying the protocol understand why it matters.

---

### Finding 3.4-D — Discoverable Annotator Identities Expose Safety Monitors as Targeting Surface

**Severity:** Low
**Feasibility:** Practical (enumeration is trivial once the on-chain tables exist)
**Adversary relevance:** State actor (Medium), Individual abuser (Medium)

The spec notes that safety annotators should have "easily discoverable mutable pointers" — by design, the annotator layer is meant to be publicly enumerable so communities can find and configure trusted annotators.

This discoverability creates a side effect: anyone can enumerate the list of parties operating as safety annotators. For state actors and criminal organizations who are actively being monitored by safety annotators, this creates targeting intelligence:
- "Organization X is a safety annotator and has published a methodology covering fraud schemes of type Y" → organization X is monitoring this organization's fraudulent credentials.
- Individual annotators (who may themselves be activists, journalists, or abuse survivors) are identifiable via their mutable pointers.

**Why this is Low rather than High:**

The spec describes annotators as organizations with "reputational stakes and accountability structures" — they are expected to be publicly known. A digital rights organization, professional licensing body, or journalist safety network is not typically operating covertly; their public role as an annotator is part of their credibility. The targeting risk is lower for organizations than for individual annotators.

The individual annotator case is higher risk: abuse survivors who annotate their abusers' credentials, or community members who monitor specific bad actors, are not expected to be publicly identifiable. The spec should distinguish between organizational annotators (expected to be public) and individual annotators (may have safety reasons to be pseudonymous) and provide guidance for the latter.

**Mitigation:** The annotator discovery mechanism should support pseudonymous annotators who are known only by their mutable pointer chain — not by real-world identity. The discoverability requirement is about finding relevant annotators, not identifying their operators.

---

## Phase 3 Milestone Assessment

### Cross-Adversary Patterns

Three protocol weaknesses appear across multiple adversary types, marking them as systemic rather than scenario-specific:

1. **The trusted root literacy gap** (Findings 3.1-E, 3.2-D): Both state actors (Condition B) and criminal organizations exploit the same structural weakness — the protocol cannot signal to a user that a root they are trusting has been compromised or is fraudulent. The state actor uses this for credential forgery; the criminal org uses it for fraud. Neither attack exploits a cryptographic weakness; both exploit the gap between formal verification and trust evaluation.

2. **The governance body as compulsion target** (Findings 3.1-D, 3.1-F; Phase 2 Finding 2.X-A): The centralized governance infrastructure introduced by ADR-011 appears in both Phase 2 and Phase 3 state-actor analysis. It is the highest-severity single change in the protocol's attack surface between Phase 1 and the current spec.

3. **The backdated silent 9xx revocation** (Findings 1.4-A, 2.2-A, 3.1-B, 3.1-F, 3.3-B): This finding recurs across all three phases. In Phase 1 it was a press key attack. In Phase 2 it was a key compromise scenario. In Phase 3 it appears in the state actor scenario (both conditions), the individual abuser scenario, and as a component of governance-authorized attack paths. It is the most versatile attack vector in the protocol.

### Cross-Phase Notes for Synthesis

The following Phase 3 findings are the most important inputs to the summary synthesis:
- **3.1-D and 3.1-E** (governance compulsion and fake credential hierarchy): The two Critical findings that determine the go/no-go recommendation for high-risk deployments.
- **3.2-D** (trusted root literacy gap): A High finding that is partially a product design problem but has specific protocol-level mitigations that should be recommended.
- **3.3-B** (credential revocation as harassment): The individual abuser's most available attack path, directly linked to the Phase 2 clarification checkpoint finding.
- **3.4-B** (annotator compromise against activists): Represents the worst-case inversion of the safety layer — using the protection mechanism as a weapon.

### Phase 3 Milestone Determination

Phase 3 confirms that the protocol's social and adversarial risks are concentrated at two levels: the governance layer (where centralization creates compulsion targets) and the application layer (where trusted root literacy determines whether cryptographic guarantees translate into user safety). Technical mitigations at the cryptographic layer are insufficient without design work at these higher layers.

No new clarification checkpoint conditions were triggered in Phase 3 beyond those already flagged. All Phase 3 findings use confirmed spec behaviors; none require author clarification to assess severity. The synthesis report should proceed.
