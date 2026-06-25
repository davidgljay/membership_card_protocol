# Card Protocol Governance

**Last reviewed:** 2026-06-25

---

## Overview

The Card Protocol is governed by two bodies with distinct mandates. Both bodies hold on-chain quorum keys — their signatures are required to authorize consequential protocol operations. The governance structure is defined in and enforced by the registry contract (`specs/object_specs/registry_contract.md §3.6, §6.2`).

This folder documents each body's purpose, on-chain powers, member profiles, and the off-chain deliberation process that precedes any on-chain action.

---

## Governance Bodies

| Body | On-chain identifier | Primary mandate | Quorum |
|---|---|---|---|
| [RootPolicyBody](./RootPolicyBody/mandate.md) | `GovernanceBodyId::RootPolicyBody` | Protocol infrastructure: policy registration, logic upgrades, protocol-level commitments | 4-of-5 |
| [PressRegistryBody](./PressRegistryBody/mandate.md) | `GovernanceBodyId::PressRegistryBody` | Press operations: authorization, revocation, compliance rules | 4-of-5 |

**Separation of concerns.** `RootPolicyBody` governs the protocol's rules and infrastructure. `PressRegistryBody` governs the press operators who use those rules to issue cards. Neither body directs the other's operational decisions.

---

## Key Structural Features

**Dual-authorization for `PressRegistryBody` key rotation.** Any change to `PressRegistryBody`'s membership (on-chain key rotation via `RotateGovernanceKeys`) requires quorum signatures from both `PressRegistryBody` (4-of-5) *and* `RootPolicyBody` (4-of-5). This is a supervisory check on membership stability, not a veto on operational decisions. `RootPolicyBody` key rotation is self-authorized.

**Decisions precede signatures.** On-chain quorum signatures ratify decisions made through deliberation — they are not the decision themselves. All substantive decisions follow the off-chain process defined in [`research/off-chain-governance-proposal.md`](./research/off-chain-governance-proposal.md), including minimum notice periods, structured deliberation, and documented dissent.

**Stipends and pseudonymous participation.** Both bodies provide stipends to members without institutional backing, and support pseudonymous participation. These are structural commitments, not optional accommodations.

---

## Documents

### RootPolicyBody
- [`RootPolicyBody/mandate.md`](./RootPolicyBody/mandate.md) — Purpose, on-chain powers, off-chain process, membership structure
- [`RootPolicyBody/member-profile.md`](./RootPolicyBody/member-profile.md) — Seat composition, required skills, inclusion commitments, conflict-of-interest policy

### PressRegistryBody
- [`PressRegistryBody/mandate.md`](./PressRegistryBody/mandate.md) — Purpose, on-chain powers, enforcement process, cross-body coordination
- [`PressRegistryBody/member-profile.md`](./PressRegistryBody/member-profile.md) — Seat composition, required skills, inclusion commitments, conflict-of-interest policy
- [`PressRegistryBody/press-rules.md`](./PressRegistryBody/press-rules.md) — Rules for press operators; violation categories and enforcement process *(v0.1 skeleton — content sections require adoption by `PressRegistryBody` once convened)*

### Research
- [`research/off-chain-governance-research.md`](./research/off-chain-governance-research.md) — Survey of governance precedents: internet protocol bodies (IETF, ICANN, W3C, Wikimedia), community-accountable governance (survivor-led orgs, CARE principles, transformative justice, participatory budgeting), and Web3 governance (EIP process, DAO failure modes, Protocol Guild)
- [`research/off-chain-governance-proposal.md`](./research/off-chain-governance-proposal.md) — Concrete off-chain governance process proposal derived from research: decision surfacing, deliberation structure, dissent recording, structural supports for underrepresented members, member nomination/removal, cross-body coordination, and annual governance cycle

---

## Contract Reference

The on-chain governance mechanics are fully specified in `specs/object_specs/registry_contract.md`. Key sections:

| Topic | Section |
|---|---|
| `GovernanceKeysets` storage layout | §3.6 |
| `RegisterPolicy` | §4.6 |
| `AuthorizePress` / `RevokePress` | §4.7–4.8 |
| `RotateGovernanceKeys` | §4.10 |
| `UpgradeLogic` (7-day timelock) | §4.14 |
| `DisablePolicyDeletePermanently` | §4.16 |
| Governance quorum verification | §6.2 |
| `UpgradeVerifier` (48-hour timelock) | §6.3 |
