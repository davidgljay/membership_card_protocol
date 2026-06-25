# PressRegistryBody — Member Profile

**Last reviewed:** 2026-06-25

---

## Overview

This document describes what `PressRegistryBody` looks for in its members. It is written for both prospective members evaluating whether they're a fit, and the body itself when assessing nominations.

`PressRegistryBody` is an operational body. Its members are making ongoing decisions about press authorization, compliance, and enforcement — decisions that directly affect community members who rely on card-issuing presses for identity and access. Members need enough familiarity with how presses operate to evaluate compliance and enough community accountability to make enforcement decisions that are fair to everyone affected.

---

## Seat Composition

The body aims to maintain coverage across three domains. As with `RootPolicyBody`, these are coverage targets for the body as a whole, not one-seat-per-domain quotas. Nominations should be evaluated against what the current body lacks.

### Domain 1: Press Operations and Community Administration

**What this covers:** Direct experience operating a community-facing system that issues credentials, manages member data, or administers access — whether or not that system used this protocol. Experience with the practical realities of running a press: key custody, log integrity, handling member disputes, managing issuance at scale.

**Why it matters:** A body that cannot evaluate press compliance from operational experience will either be too lenient (unable to identify real violations) or too strict (unable to distinguish genuine operational problems from bad faith). Press operators should be governed by people who understand what operating a press actually requires.

**Relevant backgrounds:** Community organization administration, cooperative and mutual aid infrastructure, credentialing systems, membership management, community tech operations, digital security for civil society.

### Domain 2: Trust, Safety, and Publishing Ethics

**What this covers:** Experience with trust and safety in publishing or digital community contexts — understanding how harmful content and coordination emerge, what good enforcement policy looks like, and how to make enforcement decisions that are firm without being coercive. Familiarity with the ethics and accountability norms of publishing and community administration.

**Why it matters:** `PressRegistryBody` is responsible for enforcing `press-rules.md`, investigating violations, and making revocation decisions. These decisions require both substantive judgment (is this a real violation?) and procedural integrity (was the process fair?). Trust and safety expertise informs both.

**Relevant backgrounds:** Content moderation policy and operations, platform trust and safety, investigative journalism ethics, community standards enforcement, digital rights and civil liberties, publishing accountability.

### Domain 3: Community Representation

**What this covers:** Meaningful connection to and trust from communities that are active users of card-issuing presses, with particular weight given to communities that face barriers to traditional governance participation. This domain applies the same principles as in `RootPolicyBody`: structural inclusion of the communities most affected by this body's decisions, not token representation.

**Why it matters:** `PressRegistryBody`'s enforcement decisions — who gets authorized, who gets revoked, what counts as a violation — have real consequences for community members who depend on presses for access to services and resources. The communities most affected by those decisions should have direct representation in making them.

**On avoiding tokenism:** The same research that informs `RootPolicyBody`'s composition applies here. The body should aim to have at least two members with community representation mandates, with different community connections, to prevent any single member from being treated as the spokesperson for an entire population.

---

## Skills Required of All Members

**Familiarity with how presses operate in the protocol.** Members are not required to be technical implementers, but they must develop a working understanding of what presses do, how authorization works, and what log integrity means in practice. The body provides orientation resources for members who join without this background.

**Ability to evaluate press agreement compliance.** Members must be willing to engage with compliance questions — reviewing press documentation, asking questions of press operators, and forming judgments about whether a press's behavior meets the standards in `press-rules.md`. This requires judgment, not just rule-following.

**Availability for deliberation, including time-sensitive enforcement decisions.** Enforcement investigations have defined timelines (72-hour initial response, 30-day investigation, 60-day decision). Members must be reachable and responsive enough to participate within these windows. Expected time commitment is 4–8 hours per month under normal conditions, with more during active enforcement periods.

**Willingness to hold and protect a hardware security key.** Same requirement as `RootPolicyBody`. Every member holds their signing key on a hardware security module.

**Commitment to the body's conflict-of-interest policy.** Members must disclose any relationships with press operators and recuse from decisions where those relationships create a conflict.

---

## Disqualifying Conflicts of Interest

**Currently seeking press authorization.** A member whose organization is currently seeking authorization under any policy cannot participate in the body until that process is resolved. The conflict is direct and cannot be managed by disclosure alone.

**Financial stake in a specific authorization or revocation decision.** A member with material financial stake in whether a specific press is authorized or revoked must recuse from that decision. This includes employment by the press operator, investment in the press operator's organization, or contractual relationships that would be materially affected by the outcome.

**Active dispute with a press operator under review.** A member with an ongoing personal or organizational dispute with a press operator that is subject to an enforcement investigation must recuse from that investigation.

---

## Inclusion Commitments

The same structural commitments that apply to `RootPolicyBody` apply here:

**Stipends.** Members without institutional backing receive a stipend at professional consulting rates, set at launch and reviewed annually.

**Pseudonymous participation.** Members may participate under a pseudonym. On-chain key is the canonical identifier; personal identity is disclosed to other members only with consent, never published.

**Async-first deliberation.** Substantive deliberation happens in writing. Synchronous meetings are supplementary.

**Translation.** Documents translated into members' working languages on request. Interpretation available for synchronous meetings with 72-hour notice.

---

## Coordination with RootPolicyBody

One or more members may simultaneously hold a seat on `RootPolicyBody`. Cross-body members help ensure that `PressRegistryBody`'s operational experience informs `RootPolicyBody`'s infrastructure decisions, and that protocol-level changes are coordinated with press operations before they take effect.

A cross-body member is explicit about which body's interests they represent in any given deliberation. Holding both seats does not give a member double voting power on joint decisions; each body's consensus is determined separately.

---

## Evaluating a Candidate

When the body considers a nomination:

1. What does this candidate bring that the current body lacks?
2. Which domain do they primarily represent, and is that domain currently underrepresented?
3. Do they have any disqualifying conflicts of interest with current or prospective press operators?
4. Are they willing and able to meet the participation commitments — including time-sensitive enforcement timelines?
5. Have their relevant operational experience or community ties been verified through direct conversation?
