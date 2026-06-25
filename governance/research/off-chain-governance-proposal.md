# Off-Chain Governance Proposal

**Date:** 2026-06-25  
**Status:** Draft — awaiting David's review before Phase 2 begins  
**Research basis:** [off-chain-governance-research.md](./off-chain-governance-research.md)

---

## Overview

This document proposes a concrete off-chain governance process for the Card Protocol's two governance bodies: `RootPolicyBody` and `PressRegistryBody`. It draws directly from the precedent research and makes specific recommendations — not a menu of options.

The governance process here governs *human deliberation*. The on-chain mechanics (quorum keys, timelocks, dual-authorization for key rotation) are defined in `registry_contract.md`. This document defines what happens before anyone signs anything.

**Core principle, drawn from IETF and TJ practice:** A quorum signature ratifies a decision already made through deliberation. The signature is not the decision — it is the execution of a decision whose legitimacy comes from the process that produced it.

---

## 1. How Decisions Are Surfaced

**Who can raise an issue.** Any current member of either body may raise a governance issue. For `PressRegistryBody`, any press operator or community member may submit a violation report or a rule change request through the process defined in `PressRegistryBody/press-rules.md`. Community members may also submit requests for `RootPolicyBody` consideration through a defined public channel (to be established at launch).

**Format.** A governance issue is a written document containing: (1) a clear description of the issue or proposal; (2) the relevant background and context; (3) the specific action being requested (on-chain operation, rule change, membership change, etc.); and (4) any known concerns or objections. Issues may be submitted in any language; the body is responsible for providing translation.

**Minimum notice period.** Every issue must be open for deliberation for a minimum period before any decision is called:

| Issue type | Minimum notice period |
|---|---|
| `UpgradeLogic` (logic contract upgrade) | 30 days |
| `UpgradeVerifier` (verifier module upgrade) | 14 days |
| `RegisterPolicy` (new root policy) | 21 days |
| `DisablePolicyDeletePermanently` | 30 days |
| `AuthorizePress` / `RevokePress` | 14 days (7 days for emergency revocation) |
| Membership addition or removal | 21 days |
| Press rule changes | 14 days |
| `RotateGovernanceKeys` | 21 days |

*Rationale: notice periods are drawn from the EIP staged-inclusion model and the W3C Advisory Committee Review precedent. Longer periods for high-stakes irreversible decisions (DisablePolicyDeletePermanently, logic upgrades) reflect the IETF principle that consequential decisions warrant more deliberation time.*

---

## 2. Deliberation Structure

**Async-first.** All deliberation happens in writing, in a shared space accessible to all body members (a private repository, shared document space, or equivalent — chosen at launch). Written deliberation is the primary record; synchronous meetings are supplementary.

*Rationale: async-first participation is drawn from the harm reduction and survivor-led governance research. Members who are parenting, working irregular hours, in different time zones, or managing safety concerns cannot reliably attend synchronous meetings. Async-first ensures participation is not gated on schedule flexibility.*

**Synchronous meetings.** Each body meets synchronously at most once per month for general business. For time-sensitive decisions, an emergency synchronous meeting may be called with 72-hour notice. Meeting notes are written and shared with all members within 48 hours.

**Facilitation.** Each body designates a facilitator from among its members for a defined term (recommended: 6 months, renewable). The facilitator's role, drawn from the IETF chair model, is to:
- Summarize the state of deliberation at defined intervals.
- Distinguish substantive objections from preference disagreements.
- Call consensus when it is present, and name it when it is not.
- Invite all members explicitly to raise concerns before a decision is called.

The facilitator does not have extra votes or veto power. Their role is to read and articulate the state of deliberation, not to drive it toward a predetermined outcome.

**Plain-language summaries.** Any technical proposal (logic contract upgrade, verifier change, new policy registration) must include a plain-language summary written for a reader without technical background. Members are not required to have technical expertise; proposals that cannot be summarized plainly have not been explained well enough for legitimate governance.

*Rationale: the ICANN resource-asymmetry lesson and the survivor-led governance research both point to the same failure mode — when only technically expert members can engage with a proposal, governance defaults to expert capture regardless of how representative the membership nominally is.*

---

## 3. How Dissent Is Formally Recorded

Dissent is a first-class artifact. The Card Protocol's governance process adopts the W3C Formal Objection model, adapted for a small body.

**Blocking objection.** A member may register a blocking objection to any proposal. A blocking objection is a written statement that: (1) names the specific concern; (2) explains why the proposal should not proceed as written; and (3) states what change would address the concern. A blocking objection cannot be overridden by a quorum vote. It must be addressed — meaning the concern is responded to substantively — before the proposal can proceed.

*Distinction from the IETF model, adapted for this context: the IETF allows chairs to determine that an objection is a "hold-out" rather than a substantive concern and proceed. This body is small enough (4-of-5) and consequential enough that we propose a stronger standard: a blocking objection requires a response, and if the objector finds the response inadequate, the facilitator may request a mediated session before calling consensus. Only in cases where the facilitator determines the objection has been addressed and the objector refuses to acknowledge this may the body proceed.*

**Non-blocking objection.** A member may register a non-blocking objection: a concern they want recorded but that does not rise to the level of blocking consensus. Non-blocking objections are noted in the decision record and in the public summary.

**Decision record.** Every governance decision produces a written decision record containing: the proposal, the decision reached, any objections raised and how they were addressed, any non-blocking objections recorded, and the date. Decision records are maintained permanently and are available to members of both bodies.

**Public summaries.** A public-facing summary of each decision is published after execution. Public summaries include: what was decided, when, and what the practical effect is. They do not include deliberation details, member positions, or any information that could identify members who participate pseudonymously.

---

## 4. Structural Supports for Underrepresented Members

The failure mode the Card Protocol is explicitly designed to avoid: governance bodies that are nominally diverse but functionally controlled by whoever has the most time, technical fluency, and financial stability. The following structural supports are commitments, not aspirations.

**Stipends.** Every governance member who does not have institutional backing (i.e., is not being paid by an organization to do governance work) receives a stipend for their governance participation. The stipend rate is set by the governing bodies together at launch and reviewed annually. The baseline recommendation is a rate commensurate with professional consulting rates in the relevant member's region, paid per governance action (decision deliberation, meeting participation, rule review).

*Rationale: Protocol Guild's survey data shows that core contributors leave governance roles when financial pressure becomes unsustainable. The National Harm Reduction Coalition and Survivor Alliance both specify that peer workers and survivor leaders should be compensated at professional consulting rates. Unpaid governance is governance that excludes everyone who cannot afford it.*

**Translation and interpretation.** Governance documents are translated into the languages of active member communities upon request. Interpretation is provided for synchronous meetings upon request with 72-hour notice. Translation costs are a governance expense, not an accommodation request.

**Pseudonymous participation.** A member may participate in governance under a pseudonym. Their on-chain key is the canonical identifier. Their legal name or personal identity is disclosed only to other members (not publicly) and only with their consent. This is especially important for members who have experienced harm related to identity exposure or who come from communities targeted by surveillance.

*Rationale: survivor-led governance research is explicit that confidentiality protections must be built in structurally. A member who must be publicly identified to serve on a governance body excludes anyone for whom public identification is unsafe.*

**Bounded time commitment.** The expected governance time commitment for a member is bounded at launch and published in the mandate documents. Members should not be expected to spend more than [to be defined at launch, suggest 4–8 hours per month under normal conditions]. If governance load regularly exceeds this, the bodies must adjust their processes, not expect members to absorb the excess.

**Access to technical guidance.** Members without technical background have access to technical advisors who can explain proposals in plain language. These advisors do not vote or hold keys; they are a resource for members who need to understand what they are being asked to ratify.

---

## 5. Member Nomination and Approval

**Nomination.** Any current member of either body may nominate a candidate. Community members may submit candidate recommendations through the public channel. Self-nomination is permitted. Nominations must include: a description of the candidate's relevant background, what need or gap they address in the body's composition, and confirmation that the candidate has agreed to the governance participation commitments.

**Review period.** Nominations are open for deliberation for the minimum notice period for membership changes (21 days). During this period, current members may raise questions or concerns about the candidate.

**Approval.** A candidate is approved when the current body reaches consensus in favor of the nomination. Consensus is determined by the facilitator using the process described in §2. A blocking objection to a nomination follows the same process as any other blocking objection.

**On-chain key rotation.** After off-chain approval, the new member generates their signing key (secp256r1, held on a hardware security module). The body then executes `RotateGovernanceKeys` (§4.10 of `registry_contract.md`) to add the new key. For `PressRegistryBody`, this rotation additionally requires co-authorization from `RootPolicyBody` (dual-authorization requirement). The `PressRegistryBody` facilitator coordinates with `RootPolicyBody` to obtain the co-authorization signature.

**Hardware key requirement.** All governance members hold their signing key on a hardware security module (hardware wallet, YubiKey, or equivalent). Software keys are not permitted for governance signing. This requirement is stated explicitly in the mandate documents and confirmed at onboarding.

---

## 6. Member Removal

**Voluntary departure.** A member who wishes to leave the body provides written notice. The body then executes `RotateGovernanceKeys` to remove their key. The same dual-authorization requirement applies for `PressRegistryBody` departures.

**Removal for cause.** A member may be removed for: (1) sustained non-participation (defined as missing three consecutive decision deliberations without notice); (2) a documented conflict of interest that was not disclosed; (3) conduct that harms other members or the communities the body serves. Removal for cause requires the same consensus process as any other governance decision. The member being removed may participate in deliberation about their removal but may not block consensus on their own removal.

**Transition period.** To avoid governance continuity risk, no more than two members may be rotated (added or removed) within any 90-day period except in cases of emergency (active security threat, discovered key compromise). If more than two members need to change within 90 days, the facilitator escalates to the other body for coordination.

---

## 7. Cross-Body Coordination

**The coordination channel.** `PressRegistryBody` regularly encounters issues that require `RootPolicyBody` action: a press operator discovers a deficiency in the on-chain authorization model; the press software needs a logic contract change; a pattern of violations suggests a structural fix rather than individual enforcement. The mechanism for raising these is a formal cross-body request.

**Format.** A cross-body request from `PressRegistryBody` to `RootPolicyBody` is a written document containing: the issue, what `PressRegistryBody` is asking `RootPolicyBody` to consider, any relevant data or community input, and the `PressRegistryBody` quorum decision that produced the request (meaning: `PressRegistryBody` must have deliberated and agreed on the request before sending it).

**RootPolicyBody response commitment.** `RootPolicyBody` commits to acknowledging a cross-body request within 7 days and providing a substantive response (including a decision to deliberate, a decision to decline, or a request for more information) within 30 days.

**Cross-body membership.** One or more members may hold seats on both bodies simultaneously. This is recommended for coordination, not required. A cross-body member should be explicit about which body's interests they are representing in any given deliberation.

**Joint decisions.** Some decisions require joint deliberation — for example, a rule change that would affect both press operations and on-chain logic. Joint deliberations are held with both bodies' members present. Each body reaches its own consensus; the joint meeting surfaces shared concerns and prevents avoidable conflicts.

---

## Governance Cycle

Both bodies follow an annual governance cycle, run asynchronously over 4 weeks at the end of each calendar year:

1. **Membership review** (Week 1): each member confirms their continued participation. Any anticipated departures or nominations are raised.
2. **Process review** (Week 2): the facilitator leads a review of the previous year's governance decisions. What worked? What caused delays? What objections were raised? What should change?
3. **Rule review** (Week 3, `PressRegistryBody` only): annual review of `press-rules.md` in light of the year's violations and enforcement actions.
4. **Mandate alignment** (Week 4): both bodies jointly review their mandates against the current state of the protocol and flag any needed updates.

Outputs of the annual cycle are published publicly within 30 days of completion.
