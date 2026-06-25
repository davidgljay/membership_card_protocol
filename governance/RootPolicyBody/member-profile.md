# RootPolicyBody — Member Profile

**Last reviewed:** 2026-06-25

---

## Overview

This document describes what `RootPolicyBody` looks for in its members. It is written for two audiences: prospective members evaluating whether they're a fit, and the body itself when assessing nominations.

`RootPolicyBody` holds the highest-trust keys in the protocol. Its members must be capable of reviewing consequential technical proposals, representing community interests in high-stakes deliberations, and safeguarding a hardware security key over the long term. No single member needs all of these capabilities — the body's composition is designed so that the five seats collectively cover them.

---

## Seat Composition

The body aims to maintain coverage across four domains. These are not one-seat-per-domain quotas — they describe the coverage the body needs, and nominations should be evaluated against what the current body lacks.

### Domain 1: Protocol and Infrastructure Security

**What this covers:** Understanding of cryptographic systems, smart contract security, key custody practices, and threat modeling for decentralized systems. At least one member should be capable of reviewing a proposed logic contract upgrade for security vulnerabilities before the body signs.

**Why it matters:** `RootPolicyBody` is responsible for code review of every logic and verifier upgrade it proposes. Without security expertise in the room, the body cannot discharge this responsibility. A body that approves upgrades it cannot evaluate is a security liability regardless of how good its other members are.

**Relevant backgrounds:** Smart contract security auditing, cryptographic engineering, adversarial systems research, infrastructure security at scale, trust and safety engineering.

### Domain 2: Trust and Safety

**What this covers:** Understanding of how harmful content, fraud, abuse, and coordinated manipulation emerge in digital systems — and how governance structures can address them without becoming tools of censorship or coercion. Experience designing or operating trust and safety systems at platforms, protocols, or networks.

**Why it matters:** `RootPolicyBody`'s mandate includes preventing fraud and abuse. Trust and safety expertise informs how policy registration is evaluated, what patterns should trigger a logic upgrade, and how the body responds when governance structures are being tested or gamed.

**Relevant backgrounds:** Platform trust and safety, content moderation policy and operations, fraud and abuse detection, online safety research, digital rights and civil liberties.

### Domain 3: Human Rights and Legal

**What this covers:** Expertise in human rights law, civil liberties, privacy law, or advocacy in contexts where digital infrastructure intersects with political repression, identity coercion, or community harm. Ability to evaluate governance decisions against international human rights frameworks.

**Why it matters:** The Card Protocol is designed for use by communities that face real-world risks from surveillance and identity exposure. Governance decisions — including which policies to register, whether to upgrade logic, and when to exercise `DisablePolicyDeletePermanently` — have human rights implications. This expertise ensures those implications are visible in deliberation.

**Relevant backgrounds:** Human rights law (domestic or international), digital rights advocacy, privacy law, civil liberties litigation, journalism protection, refugee and asylum rights, anti-discrimination law.

### Domain 4: Community Representation

**What this covers:** Meaningful connection to and trust from communities that are active users of the Card Protocol, with particular weight given to communities that lack the social and financial capital to otherwise influence governance.

This is not demographic representation in the abstract. It is representation of specific communities — the ones most reliant on the protocol for identity and privacy, most affected by governance failures, and most excluded from governance processes that assume professional availability, technical fluency, and English literacy.

**Why it matters:** The communities most affected by protocol decisions are systematically underrepresented in governance bodies that select for professional expertise. Structural inclusion of these voices is not charity — it is what makes the body accountable to the communities it claims to protect. Per the CARE principles informing this protocol's governance design, the communities most affected by a system have a right to participate in governing it.

**Relevant considerations:** Community members serving in this capacity hold a responsibility to the communities they represent, not only to the protocol. They are expected to communicate relevant governance decisions back to their communities (within confidentiality constraints) and to surface community concerns proactively in deliberation.

**On avoiding tokenism:** Research on survivor-led and community-led governance boards is consistent: a single community representative on an otherwise unchanged body experiences isolation and becomes an inadvertent spokesperson for an entire population. The body should aim to have at least two members with community representation mandates, with diverse community connections.

---

## Skills Required of All Members

These apply regardless of which domain a member primarily represents.

**Ability to engage with technical proposals in plain language.** Members are not required to be engineers or blockchain developers. But every member must be willing to engage with technical proposals — asking questions, requesting plain-language explanations, reviewing summaries — and must not defer entirely to technically expert members on consequential decisions. Governance that defers to experts on substance is governance that those experts control.

**Availability for async deliberation.** The body's deliberation process is async-first. Members must be reachable and responsive within the minimum notice periods for each decision type (see `research/off-chain-governance-proposal.md`). The expected time commitment is 4–8 hours per month under normal conditions, with more during active upgrade or crisis periods.

**Willingness to hold and protect a hardware security key.** Every member holds their signing key on a hardware security module (hardware wallet, YubiKey, or equivalent). This is not negotiable. Members must be willing to follow key custody practices defined at onboarding, including secure storage, backup procedures, and incident reporting if a key is compromised.

**Commitment to the body's conflict-of-interest policy.** Members must disclose financial interests, organizational affiliations, and relationships that could create conflicts with governance decisions. Undisclosed conflicts are grounds for removal.

---

## Disqualifying Conflicts of Interest

The following create conflicts that disqualify a candidate from serving, or require recusal from specific decisions:

**Operating a press under a policy governed by this body.** A member who operates a press that is authorized under a policy registered by `RootPolicyBody` has a direct financial interest in governance decisions about that policy. This conflict cannot be managed by disclosure alone; it disqualifies from serving.

**Financial interest in specific policy decisions.** A member with material financial stake in whether a specific policy is registered or a specific logic upgrade is approved cannot participate in that decision. This includes employment by an organization that is seeking policy registration or that would be materially affected by a proposed upgrade.

**Organizational employment that would create capture risk.** A member employed full-time by an organization that has a systematic stake in the protocol's governance direction — such as an organization that would benefit from a particular regulatory interpretation being encoded in protocol rules — should be evaluated carefully. The question is not whether the employer has interests (all organizations do) but whether the employment relationship creates structural incentives that would systematically override governance judgment.

---

## Inclusion Commitments

The following are structural commitments of the body, not optional accommodations.

**Stipends.** Members who do not have institutional backing for their governance participation receive a stipend at professional consulting rates. The rate is set at launch and reviewed annually. Governance labor has real costs; the body's commitments to community representation are meaningless if they require community members to absorb those costs.

**Pseudonymous participation.** A member may participate under a pseudonym. Their on-chain key is the canonical identifier. Their personal identity is disclosed to other members only with their consent, and is never published. This is especially important for members who have experienced harm related to identity exposure or who come from communities targeted by surveillance.

**Async-first deliberation.** All substantive deliberation happens in writing. Synchronous meetings are supplementary, not the primary record. Members are not required to attend synchronous calls to be full participants.

**Translation.** Governance documents are translated into members' working languages upon request. Interpretation is available for synchronous meetings with 72-hour notice. These are governance expenses, not accommodation requests.

**Access to technical guidance.** Members without technical background have access to technical advisors who can explain proposals. These advisors do not vote or hold keys; they exist so that non-technical members can fully participate in decisions about technical proposals.

---

## What Members Are Not Required to Be

- Blockchain developers or smart contract engineers
- Lawyers (though legal expertise in a subset of members is desirable)
- Full-time technology workers
- Fluent in English
- Publicly identifiable

The body's technical needs are met by coverage across the five seats — not by requiring every member to have all capabilities individually.

---

## Evaluating a Candidate

When the body considers a nomination, the relevant questions are:

1. What does this candidate bring that the current body lacks?
2. Which domain do they primarily represent, and is that domain currently underrepresented?
3. Do they have any disqualifying conflicts of interest?
4. Are they willing and able to meet the participation commitments (time, hardware key, async deliberation)?
5. Have their relevant community ties or professional expertise been verified through direct conversation, not just a CV?

A strong nomination answers all five questions. A nomination that only describes impressive credentials without addressing what the body currently lacks is not sufficient.
