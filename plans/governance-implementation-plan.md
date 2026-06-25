# Governance Documentation — Implementation Plan

**Date:** 2026-06-25  
**Status:** Draft  
**Strategic plan:** [governance-strategic-plan.md](./governance-strategic-plan.md)

---

## Decisions recorded

- Scope: `RootPolicyBody` and `PressRegistryBody` only (active bodies)
- Quorum: 4-of-5 for both bodies at launch
- Key rotation: dual-authorization (rotating body + `RootPolicyBody`)
- Press rules: Markdown file in `/governance`
- Naming: contract enum names throughout

---

## Phase 1: Research — Off-Chain Governance Models

**Objective:** Produce a synthesized research brief that surveys precedent governance models across three domains and extracts concrete proposals for the Card Protocol's off-chain governance process.

---

### Step 1.1 — Research internet protocol governance bodies

**What:** Survey IETF, ICANN, W3C, and Wikimedia Foundation governance processes. For each, document: decision-making mechanism (consensus, voting, rough consensus), how dissent is recorded, conflict-of-interest policies, and participation structures (open vs. member-gated). Extract the 2–3 most transferable patterns for a small protocol body (4-of-5, not a large consortium).

**Who:** Claude

**Context needed:** `governance-strategic-plan.md §Research area 1`. No existing Card Protocol docs are relevant to this step — it is outward-facing research.

**Done when:** A section of `governance/research/off-chain-governance-research.md` exists covering all four bodies, with a "most transferable patterns" summary at the end of the section. Each body description is ≤300 words with a clear "what we can borrow" callout.

---

### Step 1.2 — Research community-accountable governance models

**What:** Survey survivor-led governance models (domestic violence, harm reduction sectors), participatory governance mechanisms (participatory budgeting, community benefit agreements), Indigenous data sovereignty frameworks (CARE principles), and transformative justice governance structures. For each, document: how impacted community members are included structurally (not just consulted), how governance labor is compensated, and how participation is made accessible to people without professional schedules or technical backgrounds.

**Who:** Claude

**Context needed:** `governance-strategic-plan.md §Research area 2`. This step is outward-facing research with no dependency on Card Protocol specs.

**Done when:** A section of `governance/research/off-chain-governance-research.md` exists covering at least four models, with a "structural mechanisms worth adopting" summary. Particular attention to: pseudonymous participation options, stipend/compensation precedents, and async-first deliberation patterns.

---

### Step 1.3 — Research protocol-specific and Web3 governance precedents

**What:** Survey EIP/All Core Devs process, Metagov and Governance Research Institute findings on DAO governance failures, and Protocol Guild's contributor funding model. Focus on: what makes on-chain governance alone insufficient for legitimacy, how protocol upgrade proposals are deliberated before execution, and how contributor continuity is maintained.

**Who:** Claude

**Context needed:** `governance-strategic-plan.md §Research area 3`. `registry_contract.md §4.14` (UpgradeLogic, 7-day timelock) for context on what on-chain upgrade governance looks like in this protocol.

**Done when:** A section of `governance/research/off-chain-governance-research.md` exists covering EIP process, Metagov findings, and Protocol Guild. Includes a "failure modes to avoid" callout specifically relevant to small, technically asymmetric bodies.

---

### Step 1.4 — Synthesize research into a governance process proposal

**What:** Based on Steps 1.1–1.3, write a proposed off-chain governance process covering:
- How decisions are surfaced (who can raise an issue, what format, minimum notice period)
- Deliberation structure (async-first, meeting cadence, quorum for deliberation vs. quorum for signing)
- How dissent is formally recorded (not overridden)
- Structural supports for underrepresented members (stipends, translation, async participation, pseudonymous option)
- Member nomination and approval process (nomination by any current member, approval by current-body supermajority, then dual-authorization on-chain key rotation)
- Member removal process (same dual-authorization requirement applies)
- Cross-body coordination channel: how `PressRegistryBody` formally surfaces requests to `RootPolicyBody`

Write the proposal as `governance/research/off-chain-governance-proposal.md`. It should be opinionated — a concrete recommendation, not a menu of options — while noting where the recommendation draws from a specific precedent.

**Who:** Claude (with David review before Phase 2 begins)

**Context needed:** `governance/research/off-chain-governance-research.md` (all three sections from Steps 1.1–1.3), `governance-strategic-plan.md §Goals 3 and 5`, `registry_contract.md §4.10` (RotateGovernanceKeys), `registry_contract.md §4.16` (DisablePolicyDeletePermanently).

**Done when:** `governance/research/off-chain-governance-proposal.md` exists and covers all seven items listed above. Each recommendation traces back to a named precedent from the research.

---

### Phase 1 Milestone Review

**Context needed:** `governance/research/off-chain-governance-research.md`, `governance/research/off-chain-governance-proposal.md`, `governance-strategic-plan.md §Goal 3 objectives`.

**Done when:** Research covers all three domains. Proposal makes concrete recommendations on all seven process elements. Recommendations are consistent with the dual-authorization key rotation requirement. David has reviewed and approved the proposal before Phase 2 begins.

**Clarification checkpoint:** Do not begin Phase 2 until David has reviewed `off-chain-governance-proposal.md` and confirmed the proposed off-chain process. The mandate documents in Phase 2 will reference this proposal directly, so changes after Phase 2 would require rewriting them.

---

## Phase 2: Body Mandate Documents

**Objective:** Write the core governance documents for each body — mandate, on-chain powers, member profiles — informed by the approved off-chain governance proposal.

---

### Step 2.1 — Create `/governance` folder structure

**What:** Create the following directory structure:

```
governance/
  README.md                          — Index and overview of the folder
  RootPolicyBody/
    mandate.md                       — Purpose, powers, quorum, off-chain process
    member-profile.md                — Ideal backgrounds, skills, representation criteria
  PressRegistryBody/
    mandate.md
    member-profile.md
    press-rules.md                   — Rules for presses; violations and consequences
  research/
    off-chain-governance-research.md — Phase 1 output
    off-chain-governance-proposal.md — Phase 1 output
```

**Who:** Claude

**Context needed:** none beyond this plan

**Done when:** All directories and empty placeholder files exist. `README.md` contains a one-paragraph overview of the governance structure and links to each body's mandate.

---

### Step 2.2 — Write `RootPolicyBody/mandate.md`

**What:** Write the mandate document for `RootPolicyBody`. Cover:

- **Purpose:** Core protocol governance body. Responsible for protocol health, fraud and abuse prevention, accessibility, and human rights protection.
- **On-chain powers** (with contract spec references for each):
  - `RegisterPolicy` (§4.6) — creates root nodes / policy cards
  - `UpgradeLogic` (§4.14) — updates the logic contract (7-day timelock)
  - `UpgradeVerifier` (§6.3) — updates the verifier module (48-hour timelock)
  - `RotateAuthorizerKey` (§4.9) — rotates policy authorizer keys
  - `RotateGovernanceKeys` (§4.10) — amends own keyset (4-of-5 quorum + dual-auth)
  - `DisablePolicyDeletePermanently` (§4.16) — permanently removes own ability to delete policies
  - `RotateOnChainKeyScheme` (§4.11) — triggers secp256r1 → ML-DSA-44 migration
  - Co-authorization of `PressRegistryBody` key rotation (§4.10, dual-auth requirement)
- **What RootPolicyBody cannot do:** Cannot write to individual card entries; cannot directly authorize or revoke presses; cannot read or access private card content.
- **Quorum:** 4-of-5 for all on-chain actions.
- **Off-chain process:** Reference `governance/research/off-chain-governance-proposal.md` for the full deliberation process. Summarize key points inline.
- **Key rotation:** Self-amending + dual-auth not required for self-rotation (only `PressRegistryBody` rotation requires `RootPolicyBody` co-sign). Clarify this asymmetry explicitly.
- **`DisablePolicyDeletePermanently` explanation:** What the operation does, when it would be used (e.g., after the protocol reaches sufficient maturity and the ability to delete is more dangerous than the ability to leave bad policies in place), why irreversibility is intentional (prevents governance capture that reinstates the delete power), and that this decision requires the full 4-of-5 quorum.

**Who:** Claude

**Context needed:** `registry_contract.md §3.6, §4.6, §4.9, §4.10, §4.11, §4.14, §4.16, §6.2, §6.3`, `governance/research/off-chain-governance-proposal.md`, `governance-strategic-plan.md §Goals 2 and 4`.

**Done when:** `governance/RootPolicyBody/mandate.md` covers all items above. Every on-chain power has a contract spec citation. The `DisablePolicyDeletePermanently` section explains the design intent, not just the mechanics.

---

### Step 2.3 — Write `RootPolicyBody/member-profile.md`

**What:** Write the member profile document for `RootPolicyBody`. Cover:

- **Seat composition:** The body should include members across these domains — not all seats need to be filled by one domain each, but the body as a whole should have coverage across: (1) cybersecurity / protocol security, (2) trust and safety, (3) human rights law or advocacy, (4) representatives of communities that are especially active users of the protocol, with particular weight given to underrepresented populations lacking social/financial capital to otherwise influence governance.
- **Cross-body coordination seat:** One or more `RootPolicyBody` members may also hold a seat on `PressRegistryBody` for coordination purposes. Document this as an option, not a requirement.
- **Skills required of all members:** Ability to review technical proposals (not necessarily write code), availability for async deliberation on a defined cadence, willingness to hold and protect a hardware-secured signing key.
- **What members are not required to be:** Protocol engineers or blockchain developers. Technical expertise is welcome but not a prerequisite for all seats.
- **Inclusion commitments:** Stipend availability, async-first participation, pseudonymous participation option (with tradeoffs noted), translation/interpretation support.
- **Disqualifying conflicts of interest:** Operating a press under a policy governed by this body; financial interest in specific policy decisions; employment by an organization with material stake in protocol upgrade decisions.

**Who:** Claude

**Context needed:** `governance/research/off-chain-governance-proposal.md §structural supports`, `governance-strategic-plan.md §Goal 1 objectives`, user's original member profile criteria.

**Done when:** `governance/RootPolicyBody/member-profile.md` covers seat composition, universal skills, inclusion commitments, and conflicts of interest. Written as a document a prospective member could read to determine whether they're a good fit.

---

### Step 2.4 — Write `PressRegistryBody/mandate.md`

**What:** Write the mandate document for `PressRegistryBody`. Cover:

- **Purpose:** Operational governance of press operators. Ensures presses operate within their agreements, maintains rules for protocol compliance, and advocates for press-related improvements to the protocol.
- **On-chain powers** (with contract spec references):
  - `AuthorizePress` (§4.7) — authorizes a press to write under a policy
  - `RevokePress` (§4.8) — revokes press authorization
  - `RotateGovernanceKeys` (§4.10) — amends own keyset (4-of-5 quorum, **requires co-authorization from `RootPolicyBody`**)
- **What PressRegistryBody cannot do:** Cannot modify the logic contract; cannot register or delete policies; cannot rotate `RootPolicyBody` keys.
- **Quorum:** 4-of-5 for on-chain actions. Key rotation additionally requires `RootPolicyBody` co-authorization.
- **Off-chain process:** Reference `governance/research/off-chain-governance-proposal.md`. Note that rule publication (press-rules.md) is a `PressRegistryBody` output, not an on-chain operation.
- **Rule-making authority:** `PressRegistryBody` publishes and updates `PressRegistryBody/press-rules.md`. Changes to this document follow the off-chain deliberation process but do not require on-chain action.
- **Lobbying channel:** Document the formal process by which `PressRegistryBody` surfaces requests for on-chain logic changes to `RootPolicyBody`.
- **Dual-authorization explanation:** Why `PressRegistryBody` key rotation requires `RootPolicyBody` co-sign — this is a supervisory check, not a veto on operational decisions.

**Who:** Claude

**Context needed:** `registry_contract.md §4.7, §4.8, §4.10, §6.2`, `governance/research/off-chain-governance-proposal.md`, `governance-strategic-plan.md §Goal 5`.

**Done when:** `governance/PressRegistryBody/mandate.md` covers all items above. Dual-authorization requirement and lobbying channel are both explicitly documented.

---

### Step 2.5 — Write `PressRegistryBody/member-profile.md`

**What:** Write the member profile for `PressRegistryBody`. Cover:

- **Seat composition:** The body should include members with expertise in: press operations and community administration, trust and safety in digital publishing contexts, and representation of communities served by presses (with the same emphasis on underrepresented populations as `RootPolicyBody`).
- **Coordination with `RootPolicyBody`:** Document the cross-body seat option (members may hold seats on both bodies for coordination).
- **Skills required of all members:** Familiarity with how presses operate in the protocol (not necessarily technical implementers), ability to review press agreement compliance, availability for deliberation.
- **Inclusion commitments:** Same as `RootPolicyBody` (stipend, async, pseudonymous option, translation).
- **Disqualifying conflicts of interest:** Operating a press currently seeking authorization or currently under review; financial stake in a specific press authorization decision.

**Who:** Claude

**Context needed:** `governance/research/off-chain-governance-proposal.md §structural supports`, `governance-strategic-plan.md §Goal 1 objectives`.

**Done when:** `governance/PressRegistryBody/member-profile.md` covers seat composition, skills, inclusion, and conflicts. Consistent in structure and tone with `RootPolicyBody/member-profile.md`.

---

### Step 2.6 — Write `PressRegistryBody/press-rules.md` (initial skeleton)

**What:** Create an initial skeleton for the press rules document. This is not the final rules — it establishes the document structure and populates the sections that can be written without a full `PressRegistryBody` having been convened. Include:

- **Header:** Version, date, status (draft / active), governing body.
- **Section 1 — Scope:** Which presses are subject to these rules (all presses authorized under any policy via `AuthorizePress`).
- **Section 2 — Press obligations:** Stub sections for: data handling, log integrity, open offer compliance, incident reporting. Mark each as "[To be defined by PressRegistryBody]."
- **Section 3 — Violation categories:** Stub sections for: minor violations (correctable), major violations (grounds for `RevokePress`), and immediate revocation triggers. Mark as "[To be defined]."
- **Section 4 — Enforcement process:** Reference the off-chain governance proposal for how violation reports are received, deliberated, and acted upon.
- **Section 5 — Rule amendment process:** Describe how rules are updated (off-chain deliberation, `PressRegistryBody` approval, no on-chain action required for rule changes).

**Who:** Claude

**Context needed:** `registry_contract.md §4.7, §4.8` (AuthorizePress, RevokePress), `governance/research/off-chain-governance-proposal.md`.

**Done when:** `governance/PressRegistryBody/press-rules.md` exists with all five sections, clearly marking stubs as requiring future `PressRegistryBody` input. The document is useful as a starting point for the body's first working session, not as a finished ruleset.

---

### Step 2.7 — Write `governance/README.md`

**What:** Write the index document for the `/governance` folder. Cover:

- One-paragraph overview of the governance structure and its relationship to the contract.
- Table listing both bodies, their on-chain enum name, their primary mandate in one sentence, and a link to their mandate doc.
- Note on the dual-authorization requirement for key rotation.
- Note on the research documents and their status.
- Note on the press rules document status (skeleton; to be completed by `PressRegistryBody` once convened).

**Who:** Claude

**Context needed:** All documents produced in Steps 2.1–2.6.

**Done when:** `governance/README.md` serves as a functional index — a reader can understand the overall structure and navigate to any document from it.

---

### Phase 2 Milestone Review

**Context needed:** All files in `governance/` produced by Steps 2.1–2.7, `registry_contract.md §3.6, §6.2`, `governance-strategic-plan.md §Objectives`.

**Done when:** Every on-chain power listed in `§6.2` is covered in at least one mandate document. Both mandate documents reference the off-chain governance proposal consistently. Both member-profile documents are written at the same level of specificity. The press-rules skeleton is clearly marked as a stub. `README.md` accurately reflects all documents in the folder. David has reviewed and approved before treating the folder as publication-ready.

**Clarification checkpoint:** Before marking Phase 2 complete, surface any cases where the mandate documents make claims that conflict with `registry_contract.md`. These must be resolved in the docs (not the contract) before the governance folder is shared with prospective members.

---

## Clarification Checkpoints Summary

| Checkpoint | Condition |
|---|---|
| End of Phase 1 | David reviews and approves `off-chain-governance-proposal.md` before any Phase 2 doc is written |
| End of Phase 2 | David reviews all mandate and profile docs before treating the folder as publication-ready |
| Any conflict with contract spec | Surface to David immediately; do not resolve silently |
| Any claim about member compensation or stipends | Flag for David — these are commitments, not documentation |
