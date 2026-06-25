# PressRegistryBody — Mandate

**On-chain identifier:** `GovernanceBodyId::PressRegistryBody`  
**Quorum:** 4-of-5  
**Status:** Active  
**Last reviewed:** 2026-06-25

---

## Purpose

`PressRegistryBody` is the operational governance body for press operators. Its mandate is to ensure that presses operate within their agreements, maintain and enforce rules for press conduct, and advocate for press-related improvements to the protocol.

Where `RootPolicyBody` governs the protocol's infrastructure and rules, `PressRegistryBody` governs the operators who use those rules to issue cards. The two bodies have distinct mandates and distinct on-chain powers; neither directs the other's operational decisions.

---

## On-Chain Powers

Every action listed here requires a valid quorum signature from 4 of 5 `PressRegistryBody` key holders, verified on-chain via the RIP-7212 secp256r1 precompile against the active `GovernanceKeyset`.

### AuthorizePress — `§4.7`

Authorizes a press to write membership cards under a specific policy. A press is not permitted to write any card until it has been authorized under the relevant policy by `PressRegistryBody`.

Authorization records the press's secp256r1 public key on-chain. All subsequent card writes from that press are verified against this key. A press that needs to rotate its signing key does so via a new `AuthorizePress` call with the same press address and new public key — the key is overwritten, prior cards remain verifiable.

**What authorization represents.** By authorizing a press, `PressRegistryBody` is affirming that the press operator has met the requirements for operating under the relevant policy, that the press software and key custody practices meet the standards defined in `press-rules.md`, and that the body is prepared to monitor and enforce the press's ongoing compliance.

Authorization is not a one-time check. It is an ongoing relationship. A press that was correctly authorized and subsequently begins violating `press-rules.md` is subject to the enforcement process below.

**Re-authorization after revocation.** A previously-revoked press may be re-authorized via `AuthorizePress`. Prior revocation history is preserved permanently in the on-chain event log; re-authorization does not erase it. The body should document the basis for re-authorization when it occurs.

### RevokePress — `§4.8`

Revokes a press's authorization to write cards under a policy. A revoked press's key is rejected on all subsequent card write attempts.

Revocation is a serious action. It immediately interrupts the press's ability to issue cards and may affect cardholders who depend on that press. The enforcement process in `press-rules.md` defines when revocation is appropriate and what process precedes it. Revocation without process — except in cases of immediate harm — is not consistent with this body's mandate.

**Revocation is not permanent by default.** A revoked press may be re-authorized. The on-chain event log preserves the full history. What revocation does is remove the press's active authorization; whether and when re-authorization is appropriate depends on the circumstances and the enforcement process outcome.

### RotateGovernanceKeys — `§4.10` (self-amending, dual-authorization required)

Amends the `PressRegistryBody` keyset: adds or removes member keys, updates the quorum threshold, or rotates to ML-DSA-44 keys in Phase 2.

**Dual-authorization requirement.** Unlike `RootPolicyBody` key rotation (which is self-authorized), `PressRegistryBody` key rotation requires quorum signatures from *both* `PressRegistryBody` (4-of-5) *and* `RootPolicyBody` (4-of-5). Both signature sets must be present for the on-chain transaction to succeed.

**Why this asymmetry exists.** `RootPolicyBody` holds supervisory authority over the protocol's governance infrastructure. Requiring its co-authorization for `PressRegistryBody` membership changes is a structural check — not a veto on operational decisions, but a safeguard against unilateral membership changes that could compromise the governance structure. `PressRegistryBody` retains full authority over its operational decisions (`AuthorizePress`, `RevokePress`, rule changes); `RootPolicyBody` is involved only in membership changes.

**Coordination process.** When `PressRegistryBody` has reached consensus on a membership change, the facilitator coordinates with `RootPolicyBody` to obtain the co-authorization signature. `RootPolicyBody` commits to responding to a co-authorization request within 14 days. If `RootPolicyBody` has a substantive concern about the membership change, it raises it through the cross-body coordination channel rather than simply withholding signature.

---

## What PressRegistryBody Cannot Do

These constraints define the boundary between this body's operational role and `RootPolicyBody`'s infrastructure role.

- **Cannot register or modify policies.** Policy registration (`RegisterPolicy`) belongs to `RootPolicyBody`. `PressRegistryBody` operates within registered policies; it does not create them.
- **Cannot upgrade the logic or verifier contracts.** Protocol-level upgrades are `RootPolicyBody`'s domain. `PressRegistryBody` may request changes via the cross-body coordination channel, but cannot execute them.
- **Cannot write to card entries.** Card writes are press operations. This body governs press operators, not card content.
- **Cannot rotate `RootPolicyBody` keys.** `RootPolicyBody` key rotation is self-authorized. `PressRegistryBody` has no role in it.

---

## Rule-Making Authority

`PressRegistryBody` publishes and maintains [`press-rules.md`](./press-rules.md) — the rules that press operators must follow to maintain authorization. Changes to `press-rules.md` follow the off-chain deliberation process (14-day minimum notice period) but do not require an on-chain action. The rules document is the body's primary off-chain governance output.

The body is also responsible for:
- Publishing amendments to `press-rules.md` with versioning and effective dates.
- Communicating rule changes to all currently authorized press operators before they take effect.
- Maintaining a record of how rule changes were deliberated and what community input informed them.

---

## Enforcement Process

`PressRegistryBody` is responsible for receiving violation reports, investigating, and acting. The process below operationalizes the transformative justice principles informing this body's design: accountability that stops harm, addresses root conditions, and is proportionate to the violation.

**Violation tiers** are defined in `press-rules.md`. In brief:
- **Minor violations** are correctable through a remediation process without revocation.
- **Major violations** require a formal accountability process with community participation.
- **Immediate revocation triggers** are conditions under which the body may revoke without the standard process timeline (active ongoing harm, clear evidence of deliberate bad faith).

**Process timeline:**
- Violation report received → initial response within 72 hours (acknowledgment, not resolution)
- Investigation completed → within 30 days of report
- Final decision → within 60 days of report

**Community participation.** Affected communities have a formal channel to submit information to a violation investigation. The channel is defined in `press-rules.md`. The body is responsible for actively soliciting community input on major violation investigations, not only passively receiving it.

**Record-keeping.** The outcome of each enforcement action is documented and published as a public summary. The summary describes what happened and what the consequence was. It does not name or identify affected individuals.

---

## Off-Chain Governance Process

All substantive decisions follow the off-chain process defined in [`research/off-chain-governance-proposal.md`](../research/off-chain-governance-proposal.md).

Key commitments:
- **Minimum deliberation periods:** 14 days for press authorization/revocation decisions (7 days for emergency revocation), 14 days for rule changes, 21 days for membership changes.
- **Blocking objections** must be addressed before consensus is called.
- **Decision records** are produced for every governance action and maintained permanently.
- **Public summaries** are published after on-chain execution and after enforcement decisions.

The body designates a facilitator from among its members (6-month term, renewable).

---

## Cross-Body Coordination

`PressRegistryBody` regularly encounters issues that require `RootPolicyBody` action: a deficiency in the on-chain authorization model, a needed logic change to govern press behavior more effectively, or a pattern of violations that suggests a structural fix is needed at the protocol level.

**Formal cross-body request format.** A request from `PressRegistryBody` to `RootPolicyBody` must include:
1. A description of the issue.
2. What action is being requested of `RootPolicyBody`.
3. Relevant data or community input supporting the request.
4. The `PressRegistryBody` quorum decision that produced the request (the body must have deliberated and agreed before sending).

**Response commitment.** `RootPolicyBody` commits to acknowledging a cross-body request within 7 days and providing a substantive response within 30 days.

This channel is expected to be used regularly. It is the mechanism by which operational experience with press governance feeds into protocol evolution. A `PressRegistryBody` that never surfaces issues to `RootPolicyBody` is either not finding any, or is not doing its job.

---

## Membership

**Composition:** 5 members, 4-of-5 quorum required for all on-chain actions.

**Cross-body coordination:** One or more members may simultaneously hold a seat on `RootPolicyBody`. This is recommended for coordination, not required.

**Key custody:** Each member holds their secp256r1 signing key on a hardware security module. Software keys are not permitted.

**Compensation:** Members who do not have institutional backing receive a stipend. See `member-profile.md` for details.

**Key rotation:** Requires quorum from both `PressRegistryBody` and `RootPolicyBody`. See `RotateGovernanceKeys` above.
