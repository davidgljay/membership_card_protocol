# Red-Team Summary — Mark Protocol v0.3
## Synthesis Across All Three Phases

**Date:** 2026-05-22  
**Covers:** Phase 1 (zero-click infrastructure), Phase 2 (key compromise), Phase 3 (social engineering)  
**Reports synthesized:** `red_teaming/phase_1_report.md`, `red_teaming/phase_2_report.md`, `red_teaming/phase_3_report.md`

---

## 1. Overall Risk Posture

The Mark Protocol v0.3 is a thoughtfully-designed system with genuine cryptographic strengths: the dual-signature model prevents credential forgery, the append-only log creates a tamper-evident audit trail, ML-DSA-44 provides quantum-resistant signing, and the epoch-based audit encryption model delivers epoch-scoped forward secrecy. For many use cases — community membership credentials, employee identity in low-threat environments, professional certification networks where the issuer community is not under active state-level threat — the protocol's security properties significantly exceed the alternatives it would replace.

The protocol is **not yet ready for deployment to high-risk populations** — activists, journalists, abuse survivors, and communities operating under active state-actor surveillance — **without addressing two unresolved design gaps**: the governance body as a centralized compulsion target, and the absence of a trusted root literacy mechanism for users who cannot independently evaluate credential chains. These are not implementation bugs; they are architectural properties of the current design that require deliberate design decisions to address.

### Full Findings Count

| Phase | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Phase 1 (infrastructure) | 1 (conditional) | 8 | 6 | 1 | 16 |
| Phase 2 (key compromise) | 0 | 6 | 5 | 2 | 13 |
| Phase 3 (social engineering) | 2 | 8 | 7 | 1 | 18 |
| **All phases** | **2 (+ 1 resolved)** | **22** | **18** | **4** | **47** |

> **Note on Finding 1.1-A:** The conditional Critical from Phase 1 (`approved_presses` on-chain enforcement gap) was resolved by ADR-011 between Phase 1 and Phase 2. The finding is counted as resolved and is not included in the remaining Critical count. ADR-011 simultaneously introduced the governance body compulsion path, which Phase 2 and Phase 3 elevate to Critical.

### Risk Tier Assessment

**Critical risk (present in current spec, directly exploitable by well-resourced adversaries):**
- Governance body capture enabling protocol-wide write authority and fake credential hierarchies
- Backdated silent 9xx revocation with no required technical counter

**High risk (practical, requires protocol-level decisions to address):**
- Press key compromise enabling credential revocation as targeted harm
- Auditor key compromise exposing community membership records
- Trusted root literacy gap enabling fraud and state-sponsored credential forgery
- Nym gateway correlation enabling physical de-anonymization

**Moderate structural risk (addressed by documented mitigations; requires implementation choices):**
- IPFS de-pinning as soft revocation without formal log entry
- Full keyring compromise + notification suppression bypassing the 72-hour window
- Third-party annotator compromise inverting the safety layer

**Lower risk (well-bounded, mitigable with wallet-level choices):**
- Chain analysis revealing press activity patterns
- Individual abuser physical device access scenarios
- Gas griefing via calldata manipulation

---

## 2. Top 5 Most Critical Findings Across All Phases

### #1 — Governance Body as Centralized Compulsion Target
**Findings:** 2.X-A (Phase 2), 3.1-D (Phase 3) | **Severity:** Critical

ADR-011 correctly resolved the `approved_presses` enforcement gap. However, by creating the Press Registry Governance Body and Root Policy Governance Body as the sole path to press authorization and policy registration, ADR-011 simultaneously created the highest-severity new attack surface in the protocol: a single governance structure whose coercion enables protocol-wide write authority.

A state actor that can legally compel, infiltrate, or threaten enough governance key holders to reach quorum can `AuthorizePress` with an attacker-controlled key for any policy in the protocol — enabling mass credential revocation, fraudulent credential issuance, and community infiltration with no cryptographic defense. The on-chain authorization then operates exactly as intended; the protocol's security model collapses not because it was broken but because its trust anchor was captured.

This is the highest-severity finding because it degrades to a governance-layer problem before any cryptography is engaged. Jurisdictional diversification, pseudonymous key holder participation, and a published governance charter are the required mitigations — and none exist in the current spec or design documents.

**What must be resolved:** A governance charter specifying quorum composition across a minimum of N distinct legal jurisdictions; a pseudonymity option for governance key holders; and transparent monitoring of all `AuthorizePress` and `RevokePress` transactions with community-level alerts.

---

### #2 — Fake Credential Hierarchy Under Captured Trust Root Is Undetectable
**Finding:** 3.1-E (Phase 3) | **Severity:** Critical

Once a state actor controls the trust root (through governance body capture or direct policy authorizer key compromise), they can issue credentials to informants or agents that pass all eight stages of §7 verification — including `chain_reaches_trusted_root: true`. The protocol has no mechanism to signal that the trust root itself has been compromised. The verification result is technically correct: the chain does reach the trusted root. The problem is that the root's integrity is not verifiable at the protocol layer.

Combined with the trusted root literacy gap (Finding #5 below), this creates an environment where a state actor with trust root control can freely infiltrate communities with protocol-verified credentials, accumulate community membership maps, and surveil private communications — while every technical verification check returns clean results.

This finding also depends on the unresolved OQ-9 (trusted root configuration UX), which is currently High priority in open questions. For high-risk deployments, it should be treated as a deployment blocker.

**What must be resolved:** A trusted root verification ceremony establishing out-of-band trust anchors; monitoring for unexpected changes to trusted root policies; OQ-9 addressed before any deployment serving communities with state-actor exposure.

---

### #3 — Backdated Silent 9xx Revocation Has No Required Technical Counter
**Findings:** 1.4-A (Phase 1), 2.2-A (Phase 2), 3.1-B, 3.1-F, 3.3-B (Phase 3) | **Severity:** High (recurring across all three phases and all adversary types)

This is the most versatile attack vector in the protocol and the one finding that spans all three phases without resolution. A press with a valid sub-mark key can post a `LogEntry` with `code: 911`, `revocation.effective_date` set to any past date, and `notify_holder: false` against any mark in its scope. The spec explicitly supports both backdated effective dates and silent revocation as intentional features. There is no technical counter in the current protocol.

The consequences are severe: the holder does not receive a notification; their mark appears revoked with an `effective_date` potentially months before the attack; verifiers checking historical signing validity treat the holder's prior statements as made by a revoked member; and the holder learns of the revocation only when they next attempt to authenticate. Under the Phase 2 clarification checkpoint, this was confirmed as a spec-intentional behavior with no current protocol-level remedy.

The finding recurs under every adversary type: state actor (targeted de-platforming with manufactured history), criminal organization (removing competitors or members threatening to expose the operation), and individual abuser (credential revocation as harassment via residual press authority).

**What must be resolved:** Two-party authorization required for silent 9xx entries in policy `revocation_permissions` defaults (at minimum for communities serving high-risk populations); holder-initiated log polling as a required wallet client behavior; governance charter SLA for emergency `RevokePress` response.

---

### #4 — Notification Channel Control Bypasses the 72-Hour Recovery Window
**Findings:** 2.3-B (Phase 2), 2.5-B (Phase 2) | **Severity:** High

The 72-hour recovery window is the primary safeguard against full keyring takeover. It fails completely when the adversary also controls the holder's notification channels — which is practical for state actors with telecom legal authority (SIM swap via compulsion), sophisticated criminal organizations (SIM swap fraud, phishing), and individual abusers with cohabitant access or known credentials.

For a state actor with physical custody of a holder (detained at a border crossing or arrested), the attack is entirely practical: seizure of the YubiKey, compulsion of the backup service to bypass the notification window, and coercion of the PIN yields the holder's complete keyring. The holder's master keys, all sub-chitts, and the ability to sign messages attributed to their identity are fully compromised — with no evidence visible in the credential logs.

**What must be resolved:** Configurable recovery window (72 hours should be the minimum, not the default, for high-risk deployments; 7+ days recommended); independent backup notification channel not controlled by the device's primary accounts; multi-factor cancellation requiring a pre-registered secondary contact.

---

### #5 — Trusted Root Literacy Gap Enables Systematic Fraud and State-Sponsored Forgery
**Finding:** 3.2-D (Phase 3), 3.1-E (indirect) | **Severity:** High (cross-cutting)

The protocol's trust model requires end users to independently evaluate which roots they trust. This is architecturally correct — the protocol should not mandate a single authority. However, it creates a systematic harm vector: most users do not have the literacy to evaluate unfamiliar credential chains, and a credential that passes formal verification (`chain_reaches_trusted_root: true`) is indistinguishable to a non-expert from one that is fraudulent at the root level.

Both criminal organizations (constructing plausible-seeming fraudulent credential chains for consumer fraud) and state actors (issuing informant credentials under captured trust roots) exploit this same gap. Neither attack requires cryptographic compromise; both exploit the distance between "formally verified" and "meaningfully trustworthy."

OQ-9 (trusted root configuration UX) is the relevant unresolved open question. Until it is addressed, the protocol's verification machinery can truthfully report `chain_reaches_trusted_root: true` to users who cannot evaluate whether the root's identity corresponds to the authority it claims.

**What must be resolved:** Default trusted root list infrastructure analogous to browser CA bundles; human-readable credential provenance display in wallet UIs that describes the full trust chain in user-understandable terms; OQ-9 treated as a P0 design decision before high-risk deployment.

---

## 3. Recommended Remediation Priority Order

### P0 — Pre-Deployment Blockers for Any High-Risk Population

These findings represent conditions under which the protocol actively harms its intended beneficiaries. They must be resolved before the protocol is deployed to activists, journalists, abuse survivors, or any community operating under state-level adversary surveillance.

**P0.1 — Publish the governance charter.**
The governance bodies introduced by ADR-011 have no published charter. Without it, governance operates by informal norms — which are exactly what coercive actors exploit. The charter must specify: quorum thresholds; minimum jurisdictional distribution (recommended: at least 5 distinct legal jurisdictions); pseudonymous participation provisions for governance key holders; emergency press revocation SLA; and amendment procedures. This is not a technical change; it is a design document that must precede any meaningful deployment.

**P0.2 — Resolve OQ-9 (trusted root configuration UX) as a design decision.**
OQ-9 is currently marked High priority in open questions. The trusted root literacy gap (Finding #5) and fake credential hierarchy finding (#2) both depend on this being unresolved. A specific design decision is required: either adopt a default-trusted root list infrastructure (with transparent governance for additions and removals), or specify the wallet UX that enables non-expert users to make meaningful trust decisions. The choice determines the entire trust model above the cryptographic layer.

**P0.3 — Establish the multi-party authorization recommendation for silent 9xx as a protocol default.**
The backdated silent 9xx revocation (Finding #3) requires a protocol-level default that communities serving high-risk populations are expected to implement. The `revocation_permissions` field supports compound predicates — the spec should establish that the default `revocation_permissions` for 9xx entries requires co-sign from a second authorized party, with explicit opt-out for communities that have determined this is not appropriate for their use case. The current spec leaves this as an implicit option; it should be an explicit default.

---

### P1 — High-Priority Protocol Additions Before v1 Release

**P1.1 — Holder-initiated log polling as a required wallet client behavior.**
A wallet that does not periodically compare the on-chain log-head CID to its cached version cannot give the holder reliable information about their credential state. This is the primary individual-abuser mitigation (Finding #3 / 3.3-B) and a meaningful safeguard against the silent revocation path. The spec should define polling frequency requirements (recommended: minimum daily for active marks) and require that any change to the log head triggers notification to the holder regardless of `notify_holder`.

**P1.2 — Configurable recovery window with extended defaults for high-risk deployments.**
The 72-hour recovery window should have a longer configurable default for deployments tagged as high-risk. The spec mentions this as a P1 feature; it should be elevated to a first-class configuration option with explicit documentation of the threat model that motivates it.

**P1.3 — Successor mark chain reconstruction procedure documented as the standard recovery path.**
Communities that experience a mass 9xx attack (Finding 2.1-A) or governance body compromise (Findings 3.1-D, 3.1-F) need a documented playbook for reconstruction. The successor mark mechanism exists in the spec; the recovery procedure using it is not described. This procedure should be a named, documented operation in the spec — not something communities have to derive on their own under crisis conditions.

**P1.4 — Governance-level monitoring alerts for AuthorizePress and RevokePress transactions.**
All communities that have registered policies under ADR-011 governance should receive immediate alerts when any `AuthorizePress` or `RevokePress` transaction occurs on a policy they are associated with. This does not prevent governance body capture but enables rapid community response — publication of attack documentation, migration planning, and mobilization of the successor governance structure.

**P1.5 — Shorter epoch defaults for high-risk community policies.**
The epoch-based audit encryption model provides forward secrecy for closed epochs, but the default annual epoch means a compromised current-epoch AEK exposes up to one year of issuance records. For communities serving journalists or activists, quarterly epochs reduce this window to three months. The spec should recommend quarter-epoch defaults for policies where the policy chitt metadata indicates a high-risk issuer context.

---

### P2 — Recommended Improvements Before Wide Adoption

**P2.1 — Annotator emergency disclosure channel ("warrant canary" equivalent).**
Safety annotators that are compelled to publish false annotations (Finding 3.4-B) may not be able to disclose the compulsion directly. A pre-published, out-of-band emergency disclosure channel — updated on a known schedule, silence indicating duress — provides communities a signal before false annotations propagate.

**P2.2 — Wallet-side annotation lookup independent of service configuration.**
Finding 3.4-C documents that fraudulent communities can exclude safety signals by not configuring annotator roots. A wallet that performs its own annotation lookup at authentication time — before presenting the holder's credential — can warn the holder that a service's operators have been flagged, even if the service doesn't check annotations. This should be a recommended wallet behavior.

**P2.3 — `policy_creation` constraints recommended as root policy defaults.**
Finding 3.2-A documents that root policies without `policy_creation` constraints leave the sub-policy derivation chain open for exploitation. The governance body should check for `policy_creation` constraints as part of root policy registration evaluation. The spec should establish a default recommended `policy_creation` field for root policies operating in consumer-facing contexts.

**P2.4 — Per-context marks and Nym gateway rotation as wallet UX defaults.**
Both the authentication metadata tracking finding (3.3-A) and the pseudonymous identity exposure finding (3.3-D) are substantially mitigated by context-separated marks and per-mark Nym gateway addresses. These are already noted as security practices in the spec but are presented as optional. Wallet implementations for safety-sensitive deployments should surface context separation as a default recommendation, not an advanced option.

**P2.5 — Resolve OQ-14 (governance key holder identity policy).**
OQ-14 — whether governance key holders should be pseudonymous or identifiable — is deferred in ADR-011. This is not a minor implementation detail; it determines whether legal compulsion of the governance body is practical for a state actor. A named, identifiable governance body with members in one or two jurisdictions is directly coercible. OQ-14 should be resolved as part of the governance charter (P0.1 above) and should include provisions for pseudonymous participation.

---

## 4. Go/No-Go Recommendation

### Recommendation: Conditional — Deploy with Documented Threat-Model Tiers

The Mark Protocol v0.3 is ready for **limited deployment to lower-risk use cases** and **not yet ready for deployment to high-risk populations** without resolving the P0 items above.

**Lower-risk use cases where the protocol is deployable today:**

These use cases do not involve state-level adversaries, don't require the governance body to resist legal compulsion across multiple jurisdictions, and can tolerate the trusted root literacy gap because the communities and credential issuers are small, known, and directly evaluated by participants.

- Community membership credentials where the community operates its own press and verifier infrastructure.
- Internal employee identity systems where the issuing organization is the community's own employer.
- Professional certification networks where the issuing body's identity is independently verifiable through existing channels.
- Experimental and developer deployments building tooling for eventual high-risk use.

For these deployments: the cryptographic properties are sound, the dual-signature model is a genuine protection, and the risk of governance body compulsion is low (small, known communities are not high-value governance coercion targets).

**High-risk use cases that require P0 completion before deployment:**

These use cases involve the protocol's stated beneficiaries — activists, journalists, abuse survivors, and communities operating under state-level adversarial pressure — and are the use cases where protocol failure causes the most harm.

- Activist community credentials in countries with authoritarian governance.
- Journalist identity systems where the press holds information of state interest.
- Abuse survivor community platforms where credential exposure has safety implications.
- Any deployment where the protocol is positioned as protection against a well-resourced state actor.

For these deployments: the governance compulsion path (Finding #1) means that a state actor with jurisdiction over governance key holders can effectively seize the protocol's authorization infrastructure. The trusted root literacy gap (Finding #5) means that a compromised trust hierarchy is undetectable to users. The backdated silent 9xx revocation (Finding #3) means that credential harassment has no required technical counter. Together, these conditions mean that the protocol could be used against the populations it is designed to protect.

**The precise gap between "ready for low-risk" and "ready for high-risk":**

The P0 items — governance charter with jurisdictional distribution requirements, OQ-9 resolution, and multi-party authorization defaults for silent 9xx — are design and governance decisions, not additional implementation work. They require author decisions and documentation, not new cryptographic primitives. This is a smaller gap than it might appear from the findings count. The protocol's architecture is sound; the unresolved items are at the governance and policy layer above the cryptography.

**Recommended path to high-risk readiness:**

1. Draft and publish the governance charter (P0.1) — establish jurisdictional distribution requirements, pseudonymous participation, and emergency revocation SLA. Timeline: before any public release.
2. Make a binding design decision on OQ-9 (P0.2) — default trusted root list infrastructure or wallet-level trust configuration UX. Timeline: before any public release.
3. Establish multi-party authorization as the `revocation_permissions` default for 9xx (P0.3) — one paragraph of spec change, one change to recommended policy templates. Timeline: before any public release.
4. Implement holder log polling in the reference wallet client (P1.1) — required for any deployment, low implementation cost. Timeline: v1.0.
5. Validate the governance charter with affected communities — before deploying to high-risk populations, the communities who would use the protocol should review the governance structure that protects them.

### Final Assessment

The protocol demonstrates strong technical fundamentals. Its core design choices — dual-signature issuance, append-only logs, post-quantum cryptography, composable verifiability — are well-suited to the problems it is solving. The risk posture at the infrastructure and cryptographic layers is substantially mitigated relative to where Phase 1 began, partly through spec updates made during this red-team process.

The remaining Critical risks are at the governance and trust model layers — which are higher-order design decisions that no amount of cryptographic sophistication can substitute for. The protocol's safety for its most vulnerable intended users depends on getting those layers right before deployment, not patching them afterward.

**Conditional go.** Not go for high-risk populations without P0 resolution. Go for lower-risk use cases with documented threat-model limitations.

---

## Appendix: Cross-Phase Finding Reference

| Finding ID | Summary | Severity | Phase |
|---|---|---|---|
| 1.1-A | `approved_presses` on-chain enforcement under-specified | Critical (Resolved by ADR-011) | 1 |
| 1.2-A | De-pinning as soft revocation — verification denial | High | 1 |
| 1.2-B | Policy chitt unavailability cascades to all issued marks | High | 1 |
| 1.2-C | Selective revocation record suppression via split-view IPFS | Medium | 1 |
| 1.3-A | DoS flooding forces privacy-degrading transport fallback | High | 1 |
| 1.3-B | State-actor traffic correlation: IP → mark identity → site | High | 1 |
| 1.3-C | Criminal org targeted de-anonymization via relying-party control | High | 1 |
| 1.3-D | Gateway endpoint as stable activity oracle | High | 1 |
| 1.3-E | De-anonymization consequence: full authentication context exposure | High | 1 |
| 1.4-A | Press key compromise enables backdated silent 9xx revocation | High | 1 |
| 1.4-B | Legal compulsion produces rich metadata stream despite encrypted audit log | High | 1 |
| 1.4-C | Press as single point of failure blocks 810 self-revocations | Medium | 1 |
| 1.4-D | Selective censorship of update intents undetectable without multi-press | Medium | 1 |
| 1.1-B | Gas griefing via valid-signature / invalid-calldata transactions | Medium | 1 |
| 1.1-C | Serialization BINARY_FIELDS gaps in mark-validator | Medium | 1 |
| 1.1-D | ML-DSA-44 Stylus conformance not yet validated | Low | 1 |
| 2.1-A | Authorizer key enables mass 9xx revocation; recovery via successor chain is costly | High | 2 |
| 2.1-B | ADR-011 governance gate limits on-chain blast radius of authorizer compromise | Medium | 2 |
| 2.1-C | Detection requires active log monitoring; attacker operates freely until first check | Medium | 2 |
| 2.2-A | Compromised press key enables backdated silent 9xx revocation against any mark in scope | High | 2 |
| 2.2-B | Governance-controlled press revocation adds response latency in fast-moving incident | High | 2 |
| 2.2-C | Press can issue fake marks with attacker-controlled holder keys | Medium | 2 |
| 2.3-A | Sub-mark key compromise: recovery via master key; gap is press availability | Medium | 2 |
| 2.3-B | Full keyring compromise + notification channel control bypasses 72-hour window | High | 2 |
| 2.3-C | Physical device access allows keyring blob exfiltration; Secure Enclave limits sub-chitt key extraction | Medium | 2 |
| 2.4-A | Auditor key compromise exposes historical issuance record; epoch model bounds damage | High | 2 |
| 2.4-B | Auditor key rotation does not protect past entries; epoch commitment enables post-hoc detection | High | 2 |
| 2.5-A | Backup service breach alone insufficient; attacker needs YubiKey + PIN | Low | 2 |
| 2.5-B | State compulsion + YubiKey seizure can complete recovery without holder knowledge | Low | 2 |
| 3.1-A | Chain analysis identifies press–community associations and issuance timing | Medium | 3 |
| 3.1-B | Press coercion enables targeted metadata surveillance and silent revocation | High | 3 |
| 3.1-C | Credential-based infiltration allows community mapping via authentication aggregation | Medium | 3 |
| 3.1-D | Governance body capture grants state actor protocol-wide write authority | **Critical** | 3 |
| 3.1-E | Fake credential hierarchy under captured root is undetectable | **Critical** | 3 |
| 3.1-F | Retroactive de-platforming via governance-authorized adversary press | High | 3 |
| 3.1-G | Surveillance via forged authentication flows aggregates community activity map | High | 3 |
| 3.2-A | Governance registration enables legitimately-appearing fraudulent root | Medium | 3 |
| 3.2-B | Open offer with null constraints enables unlimited credential issuance | Medium | 3 |
| 3.2-C | Predicate gaming chains weak-predicate marks into higher-value credential contexts | Medium | 3 |
| 3.2-D | Trusted root literacy gap creates systematic fraud enablement | High | 3 |
| 3.3-A | Authentication metadata surveillance uses mark pointer as stable tracking identifier | Medium | 3 |
| 3.3-B | Residual press authority enables credential revocation as harassment | High | 3 |
| 3.3-C | Physical device access: Secure Enclave limits exfiltration but not in-session misuse | Medium | 3 |
| 3.3-D | Pseudonymous identity exposure via Nym gateway correlation from single interaction | High | 3 |
| 3.4-A | False annotation via deceived trusted co-signer is the realistic forgery path | Medium | 3 |
| 3.4-B | Annotator compromise enables false accusations against activists via trusted channel | High | 3 |
| 3.4-C | Annotation suppression enables fraudulent communities to exclude safety signals | Medium | 3 |
| 3.4-D | Discoverable annotator identities expose safety monitors as targeting surface | Low | 3 |
