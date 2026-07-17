# Registry Contract — Strategic Plan

**Date:** 2026-06-19  
**Status:** Draft  
**Companion document:** [contract-implementation-plan.md](./contract-implementation-plan.md) (written after open questions resolved)  
**Spec:** [specs/object_specs/registry_contract.md](../specs/object_specs/registry_contract.md) v0.3

---

## Goals

### 1. Implement the three-contract architecture faithfully and completely

The spec defines three contracts with distinct roles and upgradeability properties — storage (immutable address, enforces unconditional invariants), logic (upgradeable, 7-day timelock), and verifier (upgradeable, 48-hour timelock). All three must be implemented in Rust/Stylus and deployed as separate contracts on Arbitrum One. The storage contract's address is the permanent protocol identifier; getting this architecture right is foundational to everything that follows.

### 2. Make the contracts safe to deploy under the bootstrap governance design

The protocol deploys with a 1-of-1 governance keyset (single deployer key) that expands as governance members are added. The contracts must correctly enforce quorum at every size — including 1-of-1 — and correctly handle the transition from bootstrapped to multi-member governance without special-casing. A governance mistake at deployment is hard to recover from.

### 3. Verify that all write operations and authorization checks match the spec exactly

The spec defines 15+ write operations with precise preconditions, state changes, error codes, and events. Each function's behavior must be verifiable against the spec, especially the write gate (§6.1), governance quorum verification (§6.2), sequence/replay prevention, and the unconditional storage invariants (§3.7). Correctness here is not optional — these are the enforcement boundaries for the entire credential system.

### 4. Establish a test suite that can gate deployment

Before mainnet deployment, there must be a test suite covering all acceptance criteria in the spec (§4.x, §4.14), all error codes (§8), and all storage invariants (§3.7). The suite should run against a local Arbitrum fork so that RIP-7212 precompile behavior is tested against the actual precompile, not a mock.

### 5. Deploy to Arbitrum Sepolia and exercise the full governance bootstrap sequence

Sepolia deployment validates that the contracts compile, deploy, and operate correctly in an environment with the actual RIP-7212 precompile and real transaction costs. The bootstrap sequence — deploying with 1-of-1 governance, registering a policy, authorizing a press, and writing a card — must complete successfully before any mainnet deployment proceeds.

---

## Rationale

### Why Rust/Stylus, not Solidity

The primary reason is the upgrade path to ML-DSA-44 on-chain verification (ADR-012). When the protocol transitions to ML-DSA-44, the verifier module must implement a post-quantum signature verification algorithm not available as an EVM precompile. Stylus WASM contracts can implement arbitrary cryptographic primitives with acceptable gas costs; Solidity contracts cannot. Starting in Rust/Stylus for Phase 1 (where the verifier is a thin secp256r1 wrapper) preserves this upgrade path without a language migration later.

The cost: Stylus/Rust has a smaller developer toolchain than Solidity, fewer examples for complex data structures, and less established testing infrastructure. This is the primary source of implementation risk.

### Why three contracts and not one

The storage contract's immutable address is the stable protocol identifier — the address presses write to, verifiers read from, and monitoring infrastructure watches. If the protocol used a proxy pattern (single address, swappable implementation), any logic upgrade could silently change behavior that clients depend on. The three-contract model makes logic upgrades explicit: clients must choose to update their understanding of the logic contract, while the storage address never changes.

The unconditional storage invariants (§3.7) — write-once existence flags, immutable forwards, append-only timestamps — cannot be overridden by any logic upgrade because they are enforced by the storage contract itself. This bounds the blast radius of a compromised or buggy logic upgrade.

### Why the bootstrap risk matters

The 1-of-1 bootstrap keyset is the initial trust anchor for the entire protocol. If the deployer private key is compromised before the governance body is expanded, an attacker can: register arbitrary policies, authorize arbitrary presses, and (after any logic upgrade they propose goes unchallenged for 7 days) redirect all storage writes. The contracts must make it as easy as possible to quickly rotate governance to a multi-member quorum after deployment — this is the highest-priority post-deployment action.

### Why test against a real Arbitrum fork

The RIP-7212 precompile at `0x0000...0100` on Arbitrum One is the sole mechanism for secp256r1 verification. A mock that returns `true` for valid signatures is not the same as the precompile — it won't catch gas cost differences, calldata encoding edge cases, or failure modes specific to the precompile's implementation. The test suite must call the real precompile in a forked environment.

---

## Key Objectives

### Goal 1: Three-contract architecture

- Storage contract deploys independently with correct initial state (governance keyset, `LogicContract` address set to deployed logic contract).
- Logic contract deploys and immediately passes the storage contract's `msg.sender == LogicContract` check on all setter calls.
- Verifier module deploys as a Stylus WASM contract wrapping the RIP-7212 precompile at `0x0000000000000000000000000000000000000100`.
- A storage contract setter call from any address other than `LogicContract` reverts with `CALLER_NOT_LOGIC_CONTRACT` (E-29).

### Goal 2: Safe bootstrap governance

- Contract deploys with a 1-of-1 `RootPolicyBody` and 1-of-1 `PressRegistryBody` keyset; `quorum = 1`, `version = 0`.
- `RotateGovernanceKeys` correctly expands both bodies to multi-member keysets with quorum > len/2 and len >= 3.
- No governance operation can be submitted with a replayed governance version or reused nonce.
- All quorum-gated operations correctly reject when fewer than `quorum` distinct valid signatures are provided.

### Goal 3: Write operations match spec

- All 15 write operations implement their preconditions and state changes exactly as described in §4.
- All error codes in §8 are implemented and triggered by the documented conditions.
- All 5 unconditional storage invariants in §3.7 are enforced by the storage contract and cannot be bypassed by the logic contract.
- Sequence numbers increment on every successful press write and reset to 0 on press key rotation.
- The 7-day timelock for `UpgradeLogic` and 48-hour timelock for `UpgradeVerifier` are correctly enforced.

### Goal 4: Test suite

- Every acceptance criterion listed in the spec (§4.x) has a corresponding test that passes.
- Every error code in §8 has a test that triggers it with the documented condition.
- Every unconditional storage invariant in §3.7 has a test that confirms it survives a logic contract replacement.
- Secp256r1 signature tests use real key pairs and real signatures (not mocked), verified against the RIP-7212 precompile on a forked Arbitrum node.

### Goal 5: Sepolia deployment

- All three contracts deploy to Arbitrum Sepolia with correct constructor arguments.
- The full bootstrap sequence executes successfully on Sepolia: deploy → register policy → authorize press → register card → update card head.
- Gas costs for each write operation are measured and confirmed within the estimates in §6.3 (~$0.05–0.10 per write).
- `UpgradeLogic` propose/confirm cycle exercises correctly with a test logic contract upgrade.

---

## Open Questions

The following questions need answers before the implementation plan can be finalized. They are ranked by how much they affect the shape of implementation work.

**OQ-A (Blocking): Testing infrastructure choice.** Stylus WASM contracts require a different testing approach than standard Solidity contracts. The options are: (1) unit-test in pure Rust using the Stylus SDK's `#[cfg(test)]` support, plus Foundry fork tests against a forked Arbitrum Sepolia node for integration testing; (2) use Foundry alone with a forked node for everything; (3) use the Stylus SDK's built-in `cargo stylus check` and `cargo stylus deploy` for deployment validation, plus a custom Rust harness for integration tests. Which approach do you want to use, or is this a decision to make during setup?

**OQ-B (High): OQ-3 from the spec — IPFS replication before on-chain write.** The spec leaves open whether presses should confirm minimum IPFS replication before submitting `RegisterCard`/`UpdateCardHead`. This is a press-side policy question, not a contract-level enforcement question — the contract has no way to verify CID resolvability. But the implementation plan should note this as a press-side requirement. Do you want to resolve OQ-3 before the contract build starts, or treat it as a press-side concern outside the contract's scope?

**OQ-C (Medium): Deployment key management.** The bootstrap deployer key will be the 1-of-1 governance root. How will this key be managed? (Hardware wallet, YubiKey, multisig service like Safe?) The answer affects the deployment procedure steps in the implementation plan.

**OQ-D (Medium): Security audit.** Will the contracts be audited by an external firm before mainnet deployment? If yes, the implementation plan needs an audit phase between Sepolia validation and mainnet deployment. If no, what is the equivalent gate?

**OQ-E (Low): OQ-20 from the spec — policy deregistration.** The spec notes this is straightforwardly addable via a future logic upgrade. Does the initial implementation include a `DeregisterPolicy` stub, or leave the storage invariant (no delete setter for `PolicyAuthorizerKeys`) in place unconditionally?

---

*Once these questions are answered, the companion implementation plan will be written with phased steps, milestone reviews, and explicit checkpoints.*
