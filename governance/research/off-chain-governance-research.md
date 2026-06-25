# Off-Chain Governance Research

**Date:** 2026-06-25  
**Status:** Complete — feeds into [off-chain-governance-proposal.md](./off-chain-governance-proposal.md)

---

## Overview

This document surveys three domains of governance precedent relevant to the Card Protocol: internet protocol governance bodies, community-accountable governance structures designed to center impacted populations, and Web3/protocol-specific governance. Each section closes with a summary of what is most transferable to a small (4-of-5), technically-asymmetric governance body with an explicit mandate around human rights and community protection.

---

## Part 1: Internet Protocol Governance Bodies

### IETF — Rough Consensus and Running Code

The Internet Engineering Task Force is the closest analogue to a small protocol body that has successfully governed shared infrastructure for decades without a voting mechanism. Its key insight, articulated in RFC 7282, is that consensus is not the same as unanimity — and that majority voting is actively harmful to technical decision-making.

**How decisions are made.** IETF decisions are made by Working Group chairs who assess "the sense of the group." The canonical practice is *humming*: at in-person or hybrid meetings, participants hum (not clap or vote) to signal support or opposition to a proposal. The chair calls the sense of the room. This is deliberately non-countable — the goal is to identify whether serious objections exist, not to measure support numerically.

**How dissent is recorded.** Objections must be addressed, not outvoted. An unresolved objection from a single participant with a substantive technical argument can legitimately block consensus. The chair's job is to distinguish a "blocking objection" (a genuine unaddressed concern) from a "hold-out" (disagreement with the direction that has been deliberated and addressed). Dissents are captured in Working Group minutes and Last Call mailing list archives.

**Conflict of interest.** IETF relies on disclosure rather than exclusion. Participants are expected to disclose affiliations and financial interests. The community norms police capture, but there is no formal recusal mechanism.

**Participation structure.** Open to anyone. No membership fee for Working Group participation. Decisions are made by those who show up and engage substantively — not by credential or appointment.

**What we can borrow:**
- The distinction between "addressing" and "accommodating" an objection: you must engage with every substantive concern, but you are not required to change course to satisfy every objector.
- Documented dissent as a first-class artifact: governance decisions should produce a record of what objections were raised, how they were addressed, and whether any remain unresolved.
- The chair/facilitator role as sense-reader rather than vote-counter: the facilitator's job is to characterize the state of deliberation, not to count hands.

---

### ICANN — Multi-Stakeholder Model: Strengths and Cautionary Tale

ICANN governs the internet's domain name system through a multi-stakeholder model that explicitly carves out seats for different constituency types: registries, registrars, civil society, governments, and individual users. It is one of the most ambitious attempts to institutionalize community representation in internet governance — and its problems are as instructive as its successes.

**How representation is structured.** ICANN's community is organized into Supporting Organizations (SOs) and Advisory Committees (ACs). Policy recommendations require coordination across these bodies. Each SO represents a distinct stakeholder type; no single group can unilaterally set policy.

**What works.** Constituency diversity has produced better policy than a purely technical expert body would have. Civil society groups have successfully blocked proposals that would have been harmful to end users. The multi-stakeholder model survived a major challenge — the IANA transition — that required the community to demonstrably self-govern without U.S. government oversight.

**What doesn't work.** ICANN has accumulated workstreams that stretch volunteer capacity to the breaking point. Achieving consensus across many constituencies causes severe delays. Well-resourced stakeholders (large registries, registrars) have systematically more capacity to participate than individual users or small civil society groups, leading to documented capture over time. The "silo mentality" between Supporting Organizations has created coordination failures.

**What we can borrow:**
- Explicit constituency seat design: rather than leaving seat composition to chance, name the types of expertise and community representation you want and design for them deliberately.
- The lesson on resource asymmetry: multi-stakeholder models fail when some stakeholders have professional staff for governance participation and others are volunteers. The Card Protocol must address this structurally (stipends, async-first, reduced meeting load) rather than assuming goodwill will compensate for it.
- Do not build a governance body that requires unlimited volunteer time — it will be captured by whoever is most available.

---

### W3C — Formal Objection and Council Process

The W3C governs web standards through a member-driven model with an Advisory Committee review process. Its most relevant feature for the Card Protocol is its *Formal Objection* mechanism and the W3C Council that adjudicates unresolved objections.

**How decisions are made.** Working Groups develop standards through consensus. Before a specification advances, it goes through Advisory Committee Review, where each member organization (one AC rep per organization) can review and formally object. The W3C Director (and now the W3C Board) makes the final call on disputed decisions.

**How dissent is recorded.** A Formal Objection is a first-class governance artifact. When the W3C proceeds over a Formal Objection, the objection and the response are published with the specification. The W3C Council (composed of representatives from multiple governance bodies) can review overridden objections.

**Royalty-free IP commitment.** W3C requires that Working Group participants commit to making their patents available royalty-free for any standard produced by the group. This prevents the governance process from being used to inject encumbered IP.

**What we can borrow:**
- The Formal Objection as a named, documented artifact: governance bodies should have a defined process for recording and publishing dissents, separate from simply noting disagreement in minutes.
- The Council model: having a defined body that reviews contested decisions provides a check on the primary decision-making body without requiring a full appeals court.
- The IP commitment analogue: governance members should commit to not using their position to benefit organizations they have financial ties to, documented at the time of joining.

---

### Wikimedia Foundation — Elected Community + Appointed Seats

The Wikimedia Foundation Board of Trustees mixes community-elected seats with appointed seats selected for specific expertise. It is one of the most successful models of a global open-knowledge community governing a shared technical infrastructure.

**How the board is composed.** The Board has community-elected trustees chosen by the broader Wikimedia community, along with appointed trustees selected by the Board itself for professional expertise (legal, financial, technical). Community trustees are accountable to the editing community; appointed trustees are accountable to the Board.

**What works.** The mixed model means that community legitimacy and professional governance capacity coexist. Neither dominates entirely.

**What doesn't work.** Tension between community-elected trustees (who reflect community priorities) and appointed trustees (who may reflect foundation staff priorities) has been a recurring source of conflict. Several high-profile governance crises have stemmed from the Board acting against strong community objection.

**What we can borrow:**
- The mixed composition model: some seats should require specific expertise (security, human rights law), others should require community representation. Name which is which.
- The accountability pairing: expertise seats are not accountable to the community in the same way elected seats are. For the Card Protocol, where there is no elected constituency yet, all seats require explicit human rights and community-representation criteria alongside expertise.

---

## Part 2: Community-Accountable Governance for Impacted Populations

### Survivor-Led Organizations — Lived Experience in Governance

A growing body of practice (and research) in the nonprofit sector addresses how to integrate people with lived experience of harm into governance — not as token representation but as a structural requirement. The Survivor Alliance's "Survivors LEAD" framework and related models from anti-trafficking and domestic violence organizations are most directly relevant.

**What the research shows.** A board with lived-experience members makes better decisions for the populations it serves. But a single lived-experience member placed on an otherwise unchanged board produces isolation and tokenism. The individual becomes the designated spokesperson for an entire community, which is both unfair and epistemically bad governance.

**Structural requirements for non-tokenistic inclusion:**
- Multiple seats, not one: a minimum of two or three members with relevant lived experience prevents the isolation problem.
- Changed board culture, not just changed composition: agenda structure, decision-making pace, assumed vocabulary, and meeting format all need to accommodate members who may not have professional board experience.
- Explicit compensation: governance participation is labor. Stipends, travel reimbursement, and time compensation are standard in well-functioning survivor-led organizations. The U.S. Department of State's Emerging Survivor Leaders program and the National Harm Reduction Coalition both emphasize that peer workers and survivor leaders must be compensated at rates commensurate with professional consultants.
- Confidentiality protections: members with lived experience of harm may not be able to participate publicly. Pseudonymous or confidential participation options must be built in from the start, not added as an accommodation.

**From harm reduction — peer worker principles.** The National Harm Reduction Coalition's organizational principles state: "We uphold the rights of people who use drugs to participate in the programs and policies designed to serve them." This principle — that the people most affected by a system have a right to govern it — is directly applicable to the Card Protocol's governance design.

**What we can borrow:**
- Minimum two seats with relevant lived experience of the harms the protocol is designed to address (surveillance, identity coercion, data exploitation, community marginalization).
- Explicit stipend commitment for all members who lack institutional backing — not a nice-to-have but a structural commitment that goes in the mandate document.
- Pseudonymous participation option: a member may hold a governance seat under a pseudonym known to other members but not published publicly. The on-chain key is the canonical identifier; the human behind it can be disclosed on their own terms.
- Board culture checklist: written plain-language summaries of all technical proposals; async deliberation with a defined minimum notice period; explicit invitation for all members to raise concerns before a decision is called.

---

### CARE Principles — Indigenous Data Sovereignty

The CARE Principles for Indigenous Data Governance (Collective Benefit, Authority to Control, Responsibility, Ethics) were developed in 2019 in direct response to the FAIR principles of the open data movement. FAIR (Findable, Accessible, Interoperable, Reusable) promotes open data sharing but ignores power differentials and the historical extraction of Indigenous knowledge without consent or benefit.

**Collective Benefit.** Data ecosystems should be designed so that the communities whose data is collected derive tangible benefit — not just the researchers or operators who collect it. Governance structures should reflect this: communities affected by protocol decisions should have binding, not merely advisory, input.

**Authority to Control.** Indigenous communities should determine how their data is represented, who can access it, and under what terms. Translated to the Card Protocol: the communities most reliant on the protocol for identity and privacy should have governance seats with real decision-making authority, not just a right to comment.

**Responsibility.** Those who work with data have an obligation to share how it is being used and to nurture reciprocal relationships with source communities. For the Card Protocol: governance members representing specific communities hold an obligation to those communities, not just to the protocol.

**Ethics.** Data practices should respect community values and minimize harm, especially for vulnerable populations. The protocol's governance bodies must have authority to refuse or reverse decisions that harm the communities they represent, even when those decisions are technically correct.

**What we can borrow:**
- The shift from consultation to binding authority: community representatives on governance bodies are not advisors. They hold keys. Their quorum signatures are required for consequential protocol changes. This is already built into the contract; the governance docs must make clear that this is intentional, not incidental.
- The "collective benefit" framing for recruitment: governance members from underrepresented communities should be recruited with an explicit mandate to represent collective interests of those communities, not to represent themselves as individuals who happen to have a certain background.
- Responsibility to community: governance members should have an explicit expectation that they communicate relevant governance decisions back to the communities they represent, within confidentiality constraints.

---

### Transformative Justice — Accountability Without Punishment

Transformative justice (TJ) frameworks, developed by organizations like INCITE!, generationFIVE, and practitioners like Mia Mingus, offer a model of community accountability that does not depend on punitive or carceral systems. This is directly relevant to how `PressRegistryBody` handles press violations.

**Core framework.** TJ defines accountability as: stopping the immediate harm, making a commitment not to repeat it, offering reparations for past harm, and addressing the root conditions that made the harm possible. It explicitly rejects the idea that excluding or punishing a bad actor is sufficient — the community conditions that enabled harm must also change.

**For press violations.** A press that posts violating data should face: immediate investigation with the press's participation; a finding that addresses what happened and why; a remediation plan (not just a revocation order); and a public record of the outcome that protects affected communities without publishing identifying information. Revocation (`RevokePress`) is a last resort — a consequence for a press that refuses engagement with the accountability process, not the first response to a violation.

**The accountability process requires community accountability too.** TJ practice emphasizes that the body holding someone accountable must itself be accountable to the community it claims to represent. `PressRegistryBody` should have a public-facing process for receiving violation reports, a defined response timeline, and a mechanism for affected communities to participate in the outcome deliberation.

**What we can borrow:**
- A tiered violation response: minor violations trigger a remediation process; major violations trigger a formal accountability process with community participation; immediate revocation is reserved for presses that are actively harming people or that refuse to engage with accountability.
- Defined response timelines: from violation report receipt to initial response (72 hours), to investigation completion (30 days), to final decision (60 days). Timelines make the process legible to affected communities.
- Community participation in accountability: affected communities should have a formal channel to submit information to a violation investigation, not just to report the violation.
- Record-keeping without re-traumatization: the public record of a violation decision should describe what happened and what the consequence was, without naming or identifying affected individuals.

---

### Participatory Governance — Binding Community Authority

Participatory budgeting (PB), developed in Porto Alegre, Brazil in 1989 and now practiced globally, is the most tested model of transferring binding decision-making authority from institutions to communities. Unlike public comment processes, PB produces binding decisions: what communities vote for gets funded.

**Key characteristics.** PB is a continuous, cyclical process — not a one-off ballot. It includes structured community deliberation before any vote. It is explicitly designed to involve groups excluded from traditional governance: low-income communities, non-citizens, youth.

**The equity imperative.** Research from the Harvard Kennedy School and Nonprofit Quarterly consistently shows that PB outcomes are better for equity when explicit design choices are made: setting aside portions of the budget specifically for under-resourced neighborhoods, providing translation and childcare at deliberation meetings, compensating community facilitators, and conducting outreach beyond traditional civic participation channels.

**What we can borrow:**
- The cyclical model: governance is not a one-time setup but a recurring process with defined review periods. Both governance bodies should have an annual cycle: review of current mandates, membership assessment, rule review (for `PressRegistryBody`), and a deliberation period open to community input before any major decisions.
- Explicit outreach, not passive openness: a process that is technically open but only advertised to insiders is not participatory. The Card Protocol's recruitment and community input processes should include active outreach to underrepresented communities, in their languages and through their channels.
- Compensation for community facilitators: the people who help underrepresented communities understand and engage with governance decisions are doing governance labor and should be compensated.

---

## Part 3: Web3 and Protocol-Specific Governance

### Ethereum EIP Process and All Core Devs

The Ethereum governance process for protocol upgrades is the most directly analogous precedent for how the Card Protocol's `UpgradeLogic` deliberation should work off-chain.

**How EIPs work.** Anyone can write an Ethereum Improvement Proposal. For Core EIPs (those requiring hard forks), the proposal must go through review on the `ethereum/EIPs` GitHub repository, public discussion on Ethereum Magicians, and deliberation on All Core Devs (ACD) calls — bi-weekly video calls where client team representatives negotiate which EIPs are included in the next network upgrade.

**The ACD structure.** As of 2025, there are three separate ACD call series: execution layer (ACDE), consensus layer (ACDC), and testing (ACDT). An EIP moves through explicit stages: Proposed for Inclusion → Considered for Inclusion → Scheduled for Inclusion (or Declined). This staged process means the community knows where a proposal stands at all times.

**How consensus is determined.** There is no vote. Consensus emerges when client teams collectively agree that an EIP is ready. An EIP that several major clients refuse to implement will not be included regardless of community support. This is a de facto veto — which creates accountability (clients must publicly explain refusals) but also risk (a small number of actors can block progress).

**The 3074 lesson.** A widely-cited 2024 governance episode involved EIP-3074, which was accepted for inclusion, then reversed after post-inclusion objections were raised. The episode revealed that the staged process had not adequately front-loaded substantive deliberation — objections surfaced after scheduling rather than before. The lesson: earlier structured deliberation reduces costly reversals.

**What we can borrow:**
- Staged proposal status: any proposal to change the logic contract should have explicit stages (Proposed → Under Deliberation → Accepted for Upgrade → Scheduled) with defined transition criteria. Status should be public at all times.
- Mandatory minimum deliberation period before scheduling: no upgrade should be scheduled for on-chain execution without a minimum public deliberation period (suggest: 14 days for minor changes, 30 days for major changes).
- Documented client/member positions: before calling consensus, the facilitator should solicit and record each member's position and any unresolved concerns. This prevents post-hoc objections.

---

### DAO Governance Failures — What to Avoid

Research from 2023–2026 on DAO governance provides a detailed map of failure modes. The Card Protocol's governance design avoids most of these by construction (the bodies are not token-weighted), but the lessons are still relevant.

**Plutocracy.** In token-weighted DAOs, less than 2% of token holders vote in most proposals, and a handful of large holders control outcomes. The Card Protocol's quorum-key model (4-of-5, one key per person) structurally prevents this — but plutocracy can re-emerge informally if some members have dramatically more time, resources, or social capital than others.

**Rational apathy.** When governance participation has high costs (time, expertise, gas fees) and low perceived individual impact, most eligible participants disengage. The Card Protocol bodies are small enough that each member's participation is material — but member burnout is a real risk if governance load is not bounded.

**The metagovernance trilemma.** A 2026 Frontiers in Blockchain paper identifies a tension between decentralization, efficiency, and security in DAO governance — you can optimize for two but not all three. The Card Protocol's 4-of-5 model trades some decentralization for security and efficiency. This is the right tradeoff for a small body with high-stakes keys, but should be documented explicitly.

**Hybrid models as the emergent consensus.** By 2026, the dominant direction in serious protocol governance is hybrid: on-chain execution (like the Card Protocol's quorum-key mechanism) combined with structured off-chain deliberation, expert committees, and explicit conflict-of-interest rules. Pure on-chain governance produces plutocracy; pure off-chain governance produces capture. The combination is more resilient.

**What we can borrow (or avoid):**
- Do not rely on on-chain quorum as a proxy for legitimate deliberation. The signature is the execution step, not the decision step. The decision should happen off-chain with full deliberation; the signature ratifies a decision already made.
- Bound governance load. Define the maximum expected time commitment for members. Governance that consumes unlimited volunteer time will exhaust members and be captured by whoever has the most available time.
- Document the metagovernance trilemma tradeoff: the Card Protocol is optimizing for security (quorum keys, timelocks) and legitimacy (community representation) over raw decentralization. This is a choice, and it should be named.

---

### Protocol Guild — Funding and Contributor Continuity

Protocol Guild is a collective fund that provides supplementary income to Ethereum Layer 1 core protocol contributors through long-term on-chain token vesting. It is the most developed model for sustaining governance participation in an open protocol over time.

**Key features.** Protocol Guild is self-curated: existing members collectively vote (one person, one vote) on adding or removing members. Membership is based on active contribution, not token holdings. Funds are distributed directly to individuals, not to teams or organizations — reducing concentrated influence.

**Credible neutrality.** Protocol Guild explicitly avoids evaluating proposals or directing work. It funds people for sustained participation; it does not pay for specific outcomes. This keeps compensation from becoming leverage over governance decisions.

**Sustainability.** Survey data from 2025 shows that core Ethereum contributors earn substantially below market rates, and a majority report that Protocol Guild support is important to their ability to continue contributing. Without a compensation mechanism, governance bodies lose members to better-paid opportunities — which is a governance security risk (members with financial pressure are more susceptible to capture).

**What we can borrow:**
- The one-person-one-vote principle for membership decisions: adding or removing a governance member should require the same quorum as other decisions, not a supermajority or special threshold.
- Compensation as a governance security measure: stipends for governance members who lack institutional backing are not charity — they reduce the risk of capture by financial pressure and ensure the body doesn't drift toward only including people who can afford to do governance labor for free.
- Self-curation with public transparency: membership decisions and their rationale should be documented publicly, so that the community can see who is governing and how the body is evolving.
