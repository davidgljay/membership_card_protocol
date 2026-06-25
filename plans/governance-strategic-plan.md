# Governance Documentation — Strategic Plan

**Date:** 2026-06-25  
**Status:** Active — open questions resolved, implementation plan in progress

---

## Decisions recorded from open questions

- **Scope:** Document only currently active bodies (`RootPolicyBody`, `PressRegistryBody`). No placeholders for future bodies.
- **Quorum:** 4-of-5 for both bodies at launch.
- **Key rotation:** Rotating any body's keyset requires quorum signatures from *both* the body being rotated *and* `RootPolicyBody`. This dual-authorization requirement applies to `PressRegistryBody` rotation and any future body.
- **Press rules publication:** Published as a Markdown file in the `/governance` folder for now. Web publication is a future concern.
- **Naming:** Use contract enum names throughout — `RootPolicyBody` and `PressRegistryBody` — with human-readable descriptors where needed for clarity.

---

## Goals

1. **Document governance bodies with enough clarity that recruitment can begin.** The `/governance` folder should give prospective members a concrete picture of what each body does, who belongs on it, and what they'd be expected to sign.

2. **Map governance bodies to their on-chain capabilities.** Each body's mandate must be grounded in the specific contract operations it can authorize — so governance docs and the contract spec stay in sync as both evolve.

3. **Establish a well-researched off-chain governance strategy.** On-chain quorum mechanics are defined in the contract; what's missing is the human process that precedes a signature. This should draw on established models from both internet protocol governance and community-accountable governance structures, including models developed by and for communities most impacted by harm.

4. **Create a durable reference for governance decisions.** As the protocol matures, the reasoning behind governance structure will need to be revisited. The docs should capture *why* bodies are structured as they are, not just what they do.

5. **Establish clear separation of concerns between the two bodies.** `RootPolicyBody` governs the protocol's rules and infrastructure. `PressRegistryBody` governs press operators. Conflating them creates accountability gaps; the docs must make the boundary explicit.

---

## Rationale

**Goal 1 — Recruitment-ready docs.** Governance is a blocking dependency for contract deployment: `GovernanceKeysets` must be initialized with real keys (4-of-5 per body) before the protocol can go live. Member profiles and recruitment criteria need to exist before anyone can be approached.

**Goal 2 — On-chain grounding.** The contract (`registry_contract.md §3.6`) defines `RootPolicyBody` and `PressRegistryBody`. Operations gated on each body are specified in `§6.2`. A mismatch between what docs say a body can do and what the contract enforces is a trust failure. The docs must reflect the contract, not summarize it loosely.

**Goal 3 — Off-chain governance strategy.** The contract handles *enforcement* of quorum decisions, but the legitimacy of those decisions depends entirely on the quality of the human governance process that produced them. Protocol governance without an explicit off-chain process tends to default to whoever is most available or most vocal — which systematically excludes the communities this protocol is meant to serve. The research section below addresses this directly.

**Goal 4 — Durable reference.** The `RootPolicyBody` holds a significant and deliberately constrained power: it can delete policies, but it can *permanently and irrevocably remove that ability from itself* (`DisablePolicyDeletePermanently`, §4.16). The reasoning behind this design — and under what conditions the body might exercise or waive the power — needs to be documented for future members who weren't present at the start.

**Goal 5 — Separation of concerns.** Key rotation of `PressRegistryBody` requires dual authorization from both `PressRegistryBody` itself and `RootPolicyBody`. This is a deliberate structural asymmetry: `RootPolicyBody` has a supervisory role over the protocol's governance infrastructure, while `PressRegistryBody` has operational authority over press admission. Keeping these distinct limits blast radius from key compromise and allows different member composition and rotation cadences appropriate to each role.

---

## Key Objectives

### Goal 1 — Recruitment-ready docs

- Each body has a written mandate document covering: purpose, on-chain powers, quorum configuration (4-of-5), member composition, and expected time commitment.
- Each body has a member profile document specifying ideal backgrounds, skills, and community representation criteria, with enough specificity to evaluate a named candidate.

### Goal 2 — On-chain grounding

- Every on-chain operation requiring a governance quorum is listed in the relevant body's mandate, with a reference to the contract spec section that defines it.
- The docs explicitly list what each body *cannot* authorize (as important for trust as what it can).
- The dual-authorization requirement for key rotation is documented and explained.

### Goal 3 — Off-chain governance strategy

- A research document surveys at least three precedent governance models: one from internet protocol governance (e.g., IETF, ICANN, W3C processes), one from community-accountable governance designed around impacted populations, and one hybrid or emerging model.
- The research produces a concrete proposal for: how decisions are surfaced and deliberated, what constitutes a valid vote, how dissent is recorded, and how underrepresented members are structurally supported (stipends, translation, async participation).
- The proposal addresses member rotation: nomination process, current-body approval, and the dual-signature requirement for on-chain key rotation.

### Goal 4 — Durable reference

- The `RootPolicyBody` mandate explicitly explains `DisablePolicyDeletePermanently`: what it does, when it would be used, and why irreversibility is intentional.
- The docs capture the rationale for the 7-day upgrade timelock (`UpgradeLogic`) and 48-hour verifier timelock (`UpgradeVerifier`).

### Goal 5 — Separation of concerns

- The docs make the operational boundary between the two bodies explicit: `RootPolicyBody` governs protocol rules and infrastructure; `PressRegistryBody` governs press operators under those rules.
- Cross-body coordination — including `PressRegistryBody` lobbying `RootPolicyBody` for on-chain changes — is documented as a legitimate and expected channel, with a described process.

---

## Research: Off-Chain Governance Strategy

This section scopes the research required before an off-chain governance process can be proposed. The goal is to avoid reinventing governance from scratch when many of the relevant problems have been worked on — in internet protocol bodies, in community organizations, and in governance structures built specifically to center people most affected by harm.

### Research area 1: Internet protocol governance models

These bodies govern shared infrastructure with diverse international stakeholders, no central authority, and the need to make binding technical decisions despite disagreement.

Relevant models to examine:
- **IETF (Internet Engineering Task Force):** Rough consensus and running code. Decision-making is open to participation, skeptical of formal voting, and relies on documented dissent ("humming"). Examine how working groups are formed and how objections are handled.
- **ICANN (Internet Corporation for Assigned Names and Numbers):** Multi-stakeholder model with explicit representation for different constituency types (registries, registrars, civil society, governments, users). ICANN is also a cautionary tale about capture by well-resourced stakeholders.
- **W3C (World Wide Web Consortium):** Member-driven, with a formal Advisory Committee. Relevant for how it handles IP policy (royalty-free commitments) and community group processes.
- **Wikimedia Foundation governance:** Board composition that mixes elected community members with appointed seats; relevant for the tension between technical expertise and community representation.

Questions to answer from this research: How are decisions formally recorded? How is dissent preserved? What is the quorum equivalent for non-binding deliberation vs. binding decisions? How are conflicts of interest managed?

### Research area 2: Community-accountable governance representing impacted populations

Standard governance models systematically under-represent people who have been harmed by systems — whether surveillance, data exploitation, content moderation failures, or identity coercion. Several fields have developed governance structures explicitly designed to address this.

Relevant models to examine:
- **Survivor-led governance in harm-reduction and domestic violence organizations:** Organizations like the National Domestic Violence Hotline and survivor-centered advocacy orgs have developed board composition models that require a minimum percentage of members with lived experience of the harm being addressed. Examine how "lived experience" is defined, verified (or not), and protected (pseudonymous participation, confidentiality policies).
- **Community benefit agreements and participatory budgeting:** Models from urban planning and housing policy where affected communities have formal, binding input into decisions. Relevant for structural mechanisms — not just consultation — that prevent token inclusion.
- **Indigenous data sovereignty frameworks (CARE principles):** Collective authority, authority to govern, responsibility, ethics. Developed specifically to counter extractive data governance. Relevant for how the Card Protocol thinks about community members as governors of the protocol that affects their data.
- **Transformative justice governance:** Movement organizations that have had to develop accountability processes without access to punitive systems. Relevant for how `PressRegistryBody` handles violations — processes that are both firm and non-punitive.

Questions to answer from this research: How are underrepresented members compensated for governance labor? How is participation structured to not require professional availability (async, multilingual, stipended)? How is power balanced when some members have more technical knowledge than others?

### Research area 3: Protocol-specific and Web3 governance precedents

- **Ethereum Improvement Proposals (EIPs) and All Core Devs:** Technically expert, but community-driven. Useful for how protocol upgrades are proposed and deliberated before they reach the equivalent of `UpgradeLogic`.
- **Gitcoin / Protocol Guild:** Mechanisms for funding contributors to open protocols and ensuring continuity of governance participation.
- **Metagov and the Governance Research Institute:** Academic-adjacent research on DAO and protocol governance failures and successes. Particularly relevant for understanding why on-chain governance alone tends to produce plutocratic outcomes.

---

## Open Questions

The following questions were resolved before implementation planning began and are recorded here for reference:

| Question | Resolution |
|---|---|
| Scope of bodies to document | Active bodies only: `RootPolicyBody` and `PressRegistryBody` |
| Quorum configuration | 4-of-5 for both bodies at launch |
| Key rotation authorization | Dual-authorization: rotating body quorum + `RootPolicyBody` quorum required |
| Press rules publication format | Markdown file in `/governance` folder |
| Naming convention | Contract enum names throughout (`RootPolicyBody`, `PressRegistryBody`) |

One question remains open for the implementation phase:

**Member rotation process (off-chain):** The off-chain nomination, deliberation, and approval process for adding or removing members will be proposed by the off-chain governance research (Goal 3) rather than pre-specified here. This is an output of the implementation plan, not an input to it.
