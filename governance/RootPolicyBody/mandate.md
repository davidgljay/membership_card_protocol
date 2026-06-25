# RootPolicyBody — Mandate

**On-chain identifier:** `GovernanceBodyId::RootPolicyBody`  
**Quorum:** 4-of-5  
**Status:** Active  
**Last reviewed:** 2026-06-25

---

## Purpose

`RootPolicyBody` is the core governance body of the Card Protocol. Its mandate is to evolve the long-term health of the protocol: preventing fraud and abuse, promoting accessibility, and upholding human rights for the communities the protocol serves.

This body holds the highest-trust on-chain powers. It is the only body that can modify the protocol's logic, register root policies, and trigger irreversible protocol commitments. With that authority comes a corresponding responsibility to govern in the interest of the communities most affected by the protocol — not only the communities most capable of influencing it.

---

## On-Chain Powers

Every action listed here requires a valid quorum signature from 4 of 5 `RootPolicyBody` key holders, verified on-chain via the RIP-7212 secp256r1 precompile against the active `GovernanceKeyset`.

### RegisterPolicy — `§4.6`

Creates a new root policy card on-chain. A policy card defines the rules under which membership cards can be issued by authorized presses. Registering a policy is the entry point for any new issuance program operating under the protocol.

**What this means in practice:** Before any community can issue membership cards under the Card Protocol, `RootPolicyBody` must register the policy that authorizes issuance. This is a significant gate — it is how the body shapes who can issue cards and under what terms.

### UpgradeLogic — `§4.14` (7-day timelock, two-step)

Proposes and confirms an upgrade to the logic contract — the contract that implements all protocol write operations and authorization rules. This is the most consequential power the body holds.

**Two-step process:**
1. **ProposeLogicUpgrade** — records the proposed new logic contract address on-chain and starts a mandatory 7-day timelock. Both steps require a quorum signature. A proposal cannot be submitted while another is pending.
2. **ConfirmLogicUpgrade** — executed after the 7-day window has elapsed. Updates the active logic contract.

**Why the 7-day window exists:** The timelock gives press operators, card holders, monitoring agents, and community observers time to detect a malicious or erroneous proposal and take action — including emergency governance rotation or public alerting — before the upgrade takes effect. The 7 days is a security commitment to the protocol's users, not an internal scheduling convenience. A `RootPolicyBody` that routinely rushes upgrades through the minimum window undermines this commitment.

**Responsibility before signing:** Governance members must review the proposed new logic contract bytecode before signing either step. The storage contract does not verify bytecode; that is the body's responsibility. No upgrade should be proposed without code review by at least one member with relevant security expertise. See the off-chain governance process for the minimum deliberation period (30 days) required before ProposeLogicUpgrade is submitted.

### UpgradeVerifier — `§6.3` (48-hour timelock)

Proposes and confirms an upgrade to the verifier module — the contract that implements on-chain signature verification. In Phase 1, the verifier delegates to the RIP-7212 secp256r1 precompile. The verifier upgrade path exists specifically to enable migration to ML-DSA-44 post-quantum verification when that upgrade is warranted.

**Timelock:** 48 hours. Shorter than the logic upgrade timelock because verifier changes are more constrained in scope, but the same review responsibility applies.

### RotateAuthorizerKey — `§4.9`

Rotates the secp256r1 public key associated with a registered policy address. Used when a policy authorizer key is compromised or reaches end of life.

**Note:** There is no delete operation for registered policies. Once registered, a policy address remains in the table permanently. Key rotation is the only mechanism for replacing a compromised authorizer key.

### RotateGovernanceKeys — `§4.10` (self-amending)

Amends the `RootPolicyBody` keyset: adds or removes member keys, updates the quorum threshold, or rotates to ML-DSA-44 keys in Phase 2. This operation is self-amending — the current 4-of-5 quorum must approve changes to its own membership.

**Bootstrap note:** The contract is deployed with a 1-of-1 keyset (single deployer key). As members are onboarded, the deployer calls `RotateGovernanceKeys` to expand the keyset and raise the quorum. Once the quorum reaches 4-of-5, all further membership changes require a 4-of-5 quorum.

**Key rotation for `RootPolicyBody` is self-authorized** — unlike `PressRegistryBody` key rotation, which requires co-authorization from `RootPolicyBody`. This asymmetry is intentional: `RootPolicyBody` is the protocol's root of trust. It cannot be in a position of requiring a subordinate body's permission to update its own membership.

### RotateOnChainKeyScheme — `§4.11`

Triggers the migration of press on-chain signing from secp256r1 (Phase 1) to ML-DSA-44 (Phase 2), when the quantum threat horizon makes this necessary. This operation opens the dual-accept window (both key schemes accepted) before sunsetting secp256r1.

**This is a protocol-wide commitment** requiring advance coordination with all press operators. It should not be triggered without a public advance notice period and a confirmed migration timeline communicated to press operators. See `§4.11` of the contract spec for the full migration sequence.

### DisablePolicyDeletePermanently — `§4.16` (irreversible)

Permanently and irrevocably disables the `DeregisterPolicy` operation at the storage contract level. Once confirmed, no future logic contract — regardless of upgrade history — can ever delete a policy authorizer key.

**This operation has no inverse.** It is a one-way protocol commitment.

**When to use it:** This operation resolves a deliberate design question: should the protocol eventually guarantee that registered policies can never be removed? The answer depends on the protocol's maturity and the trust model it has established with issuers and cardholders. Early in the protocol's life, retaining the delete capability may be necessary for responding to serious fraud or abuse. Once the protocol reaches sufficient maturity — and once the ability to delete a policy creates more risk (governance capture, coercive removal of community-protective policies) than the inability to delete — this operation makes the commitment permanent.

**Precondition for use:** Before calling `DisablePolicyDeletePermanently`, `RootPolicyBody` should have deliberated on and documented: (a) why the protocol has reached sufficient maturity, (b) what mechanisms exist to handle policy-level fraud or abuse without deletion, and (c) the community input that informed the decision. This deliberation record should be published alongside the on-chain transaction.

---

## What RootPolicyBody Cannot Do

These are not gaps — they are intentional constraints that define the boundary between `RootPolicyBody`'s infrastructure role and `PressRegistryBody`'s operational role.

- **Cannot directly authorize or revoke individual presses.** That power belongs exclusively to `PressRegistryBody` (`AuthorizePress`, `RevokePress` — `§4.7`, `§4.8`).
- **Cannot write to individual card entries.** Card writes (`RegisterCard`, `UpdateCardHead`) are press operations, not governance operations. The body has no mechanism to modify a specific card's content or head CID.
- **Cannot read or access private card content.** Private card content is encrypted at the application layer and stored on IPFS. The registry contract holds only plaintext CID pointers; governance has no special access to encrypted content.
- **Cannot unilaterally rotate `PressRegistryBody` keys.** `PressRegistryBody` key rotation is a self-amending operation that requires `PressRegistryBody` quorum. `RootPolicyBody` must co-authorize but cannot initiate or complete the rotation alone.

---

## Off-Chain Governance Process

The body's on-chain quorum signatures ratify decisions made through deliberation — they are not the decision themselves. All substantive decisions follow the off-chain process defined in [`research/off-chain-governance-proposal.md`](../research/off-chain-governance-proposal.md).

Key commitments:
- **Minimum deliberation periods** must be observed before any on-chain action is proposed (30 days for logic upgrades, 21 days for policy registration and membership changes, 14 days for other operations).
- **Blocking objections** must be addressed, not outvoted, before consensus is called.
- **Decision records** are produced for every governance action and maintained permanently.
- **Public summaries** are published after on-chain execution.

The body designates a facilitator from among its members (6-month term, renewable) who is responsible for managing the deliberation process, summarizing the state of discussion, and calling consensus.

---

## Membership

**Composition:** 5 members, 4-of-5 quorum required for all on-chain actions.

**Seat design:** The body's membership should collectively provide coverage across the expertise and community representation domains described in [`member-profile.md`](./member-profile.md). No seat is reserved for a single individual or organization — composition is reviewed annually.

**Cross-body coordination:** One or more members may simultaneously hold a seat on `PressRegistryBody` for coordination purposes. A cross-body member is explicit about which body's interests they represent in any given deliberation.

**Key custody:** Each member holds their secp256r1 signing key on a hardware security module (hardware wallet, YubiKey, or equivalent). Software keys are not permitted.

**Compensation:** Members who do not have institutional backing for governance participation receive a stipend. The stipend rate is set at launch and reviewed annually. See `member-profile.md` for details.

---

## Relationship to PressRegistryBody

`RootPolicyBody` and `PressRegistryBody` have distinct mandates and distinct on-chain powers. The relationship between them is supervisory at the infrastructure level but not directive at the operational level.

`RootPolicyBody` is involved in `PressRegistryBody` operations in exactly two ways:
1. **Co-authorization of `PressRegistryBody` key rotation:** Any change to `PressRegistryBody`'s membership (on-chain) requires a quorum signature from both `PressRegistryBody` and `RootPolicyBody`. This is a check on membership stability, not a veto on operational decisions.
2. **Responding to cross-body requests:** `PressRegistryBody` may formally request that `RootPolicyBody` consider a protocol change (new policy, logic upgrade, rule change). `RootPolicyBody` commits to acknowledging such requests within 7 days and responding substantively within 30 days. See `PressRegistryBody/mandate.md §Cross-body coordination` for the format.

`RootPolicyBody` does not direct `PressRegistryBody` on day-to-day press authorization decisions. Those are `PressRegistryBody`'s domain.
