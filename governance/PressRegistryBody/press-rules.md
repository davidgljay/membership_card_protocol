# Press Rules

**Version:** 0.1 (skeleton)  
**Status:** Draft — to be completed by `PressRegistryBody` once convened  
**Governing body:** `PressRegistryBody`  
**Effective date:** [To be set upon adoption by `PressRegistryBody`]  
**Last amended:** 2026-06-25

---

## About This Document

This document defines the rules that press operators must follow to maintain authorization under the Card Protocol. It is maintained by `PressRegistryBody` and is the body's primary off-chain governance output.

This version is a structural skeleton. Section content marked **[To be defined by `PressRegistryBody`]** requires the body to deliberate and adopt specific rules. The structure and process sections are substantive and apply from the date this document is formally adopted.

Changes to this document follow the off-chain deliberation process in [`research/off-chain-governance-proposal.md`](../research/off-chain-governance-proposal.md) with a minimum 14-day notice period. Changes do not require an on-chain action. All amendments are versioned and communicated to currently authorized press operators before taking effect.

---

## Section 1 — Scope

These rules apply to all presses authorized under any policy registered by `RootPolicyBody`, from the date of their authorization (`AuthorizePress`) until their authorization is revoked (`RevokePress`) or this document is superseded.

A press operator's acceptance of authorization constitutes acceptance of these rules and any amendments made during the period of authorization, provided amendments are communicated in advance of their effective date.

These rules govern press conduct — they do not govern the content of individual membership cards, which is the responsibility of the policy under which those cards are issued.

---

## Section 2 — Press Obligations

### 2.1 Data Handling

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- What data presses may collect from cardholders during issuance.
- Retention limits and deletion obligations.
- Obligations regarding cardholder data in the event the press ceases operations.
- Prohibition on selling or sharing cardholder data with third parties without explicit cardholder consent.

### 2.2 Log Integrity

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- Requirements for maintaining an accurate, append-only press log.
- Obligations to ensure log head CIDs submitted on-chain accurately reflect the press's issuance history.
- Prohibited log manipulations.
- Requirements for log availability and replication.

### 2.3 Open Offer Compliance

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- Requirements for accurate representation of open offer terms to recipients.
- Obligations when an open offer reaches its acceptance limit.
- Prohibited practices in open offer design (e.g., misleading terms, discriminatory access conditions).

### 2.4 Key Custody

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- Minimum key custody standards for press signing keys (hardware security module or equivalent).
- Obligations upon key compromise: reporting timeline to `PressRegistryBody`, steps for key rotation via `AuthorizePress`.
- Prohibited key storage practices.

### 2.5 Incident Reporting

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- What constitutes a reportable incident (key compromise, data breach, log integrity failure, unauthorized card writes).
- Reporting timeline to `PressRegistryBody` after discovery.
- Required content of an incident report.
- Cooperation obligations during `PressRegistryBody` investigation.

### 2.6 Policy Compliance

**[To be defined by `PressRegistryBody`]**

Expected coverage:
- Obligation to issue cards only under policies for which the press is currently authorized.
- Requirements for staying current with policy terms as they evolve.
- Obligations when a policy is amended in ways that affect the press's issuance practices.

---

## Section 3 — Violation Categories

### 3.1 Minor Violations

**[To be defined by `PressRegistryBody`]**

Minor violations are correctable through a remediation process without revocation. Examples of the type of violations that belong in this category: procedural non-compliance that caused no cardholder harm, late incident reporting, minor log inconsistencies that are self-corrected.

The remediation process for minor violations consists of: `PressRegistryBody` notifying the press of the violation, the press submitting a remediation plan within [to be defined] days, and `PressRegistryBody` confirming remediation is complete.

### 3.2 Major Violations

**[To be defined by `PressRegistryBody`]**

Major violations trigger a formal accountability process with community participation. Examples of the type of violations that belong in this category: data misuse that harmed cardholders, systematic log manipulation, repeated minor violations following remediation.

The accountability process for major violations is defined in Section 4.

### 3.3 Immediate Revocation Triggers

**[To be defined by `PressRegistryBody`]**

Conditions under which `PressRegistryBody` may execute `RevokePress` without the standard process timeline. Reserved for situations involving active ongoing harm to cardholders or clear evidence of deliberate bad faith.

Even in emergency revocation cases, `PressRegistryBody` documents its rationale and publishes a public summary within [to be defined] days of revocation.

---

## Section 4 — Enforcement Process

The enforcement process below applies to major violations. Minor violations follow the streamlined remediation process described in Section 3.1.

### 4.1 Receiving Violation Reports

Any person or organization may submit a violation report to `PressRegistryBody` through the reporting channel: **[To be established at launch]**.

A violation report should include: the name or identifier of the press, a description of the alleged violation, any supporting evidence, and the submitter's preferred level of involvement in the investigation (none, providing information only, participating in deliberation).

Reports may be submitted anonymously. Anonymous reports receive the same initial review as identified reports, though the investigation process may be more limited in scope.

### 4.2 Initial Response

`PressRegistryBody` acknowledges receipt of a violation report within **72 hours**. The acknowledgment confirms receipt and states whether the report will be investigated. A decision not to investigate is documented with a brief rationale.

### 4.3 Investigation

`PressRegistryBody` completes its investigation within **30 days** of the report. The investigation includes:
- Notification to the press operator that an investigation is open.
- Opportunity for the press operator to respond to the allegations.
- Solicitation of input from affected community members through the reporting channel.
- Review of relevant on-chain data (authorization history, log head CIDs, event log).

The investigation produces a written finding: what happened, whether it constitutes a violation, and which violation category applies.

### 4.4 Final Decision

`PressRegistryBody` issues a final decision within **60 days** of the original report. The decision includes: the finding, the consequence (remediation plan, formal accountability process, or revocation), and the rationale.

For major violations, the accountability process follows transformative justice principles: the goal is stopping the harm, making a commitment not to repeat it, and offering reparations where applicable. Revocation (`RevokePress`) is a consequence for a press that refuses to engage with the accountability process or continues causing harm after a finding — not the first response.

### 4.5 Record-Keeping

The outcome of each enforcement action is documented in `PressRegistryBody`'s decision record and published as a public summary. The public summary describes what happened and what the consequence was. It does not name or identify affected individual cardholders.

---

## Section 5 — Rule Amendment Process

`PressRegistryBody` may amend these rules at any time following the off-chain deliberation process:

1. A proposed amendment is published to the governance deliberation space with a minimum **14-day notice period** before any decision is called.
2. Currently authorized press operators are notified of the proposed amendment at the time it is published.
3. `PressRegistryBody` reaches consensus on the amendment following its standard deliberation process.
4. The amendment is incorporated into a new version of this document with an updated version number, effective date, and summary of changes.
5. Currently authorized press operators are notified of adopted amendments before the effective date. Amendments do not take effect retroactively.

A press operator who cannot comply with an amended rule should notify `PressRegistryBody` before the effective date. `PressRegistryBody` will work with the press to address the conflict before treating non-compliance as a violation.

---

## Amendment History

| Version | Date | Summary |
|---|---|---|
| 0.1 | 2026-06-25 | Initial skeleton. Structural sections complete; content sections pending `PressRegistryBody` adoption. |
