# Registry Contract — Implementation Plan

**Date:** 2026-06-19  
**Status:** Draft  
**Strategic plan:** [contract-strategic-plan.md](./contract-strategic-plan.md)  
**Spec:** [specs/object_specs/registry_contract.md](../specs/object_specs/registry_contract.md) v0.3

---

## Decisions recorded from open questions

- **Testing:** Stylus SDK `#[cfg(test)]` unit tests + Foundry fork tests against Arbitrum Sepolia for integration.
- **IPFS replication:** Out of scope for the contract. Press-side concern only.
- **Deployer key:** Hardware wallet. Deployment steps reflect this.
- **Audit:** External audit required before mainnet. Audit phase is Phase 9, between Sepolia validation and mainnet deployment.
- **DeregisterPolicy:** Include a stub in the storage contract and a governance-gated operation in the logic contract. The no-delete storage invariant for `PolicyAuthorizerKeys` is not enforced unconditionally; `DeregisterPolicy` is available but governed by `RootPolicyBody` quorum.

---

## Phase 1: Project Setup and Scaffolding

**Objective:** A working Rust/Stylus workspace that compiles, runs unit tests, and can be deployed to Sepolia — before any real contract logic is written.

---

### Step 1.1 — Initialize the Rust/Stylus workspace

**What:** Create a Cargo workspace with four crates: `storage-contract`, `logic-contract`, `verifier-module`, and `protocol-types` (shared types used across all three). Each contract crate depends on the Stylus SDK (`stylus-sdk`) and targets `wasm32-unknown-unknown`. `protocol-types` is a pure Rust library (no Stylus dependency) that defines shared structs: `CardEntry`, `PressAuthEntry`, `SubCardEntry`, `GovernanceKeyset`, `PendingUpgrade`, `GovernanceBodyId`, and all error codes from §8.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §3 (storage layout, all struct definitions); §8 (error codes). No prior contract code exists; this is greenfield.

**Done when:** `cargo build --target wasm32-unknown-unknown` succeeds for all three contract crates producing `.wasm` files. `cargo test` passes for `protocol-types`. No contract logic is implemented yet — just scaffolding, dependencies, and type definitions.

---

### Step 1.2 — Configure Foundry for Arbitrum Sepolia fork testing

**What:** Initialize a Foundry project (`forge init`) in a `tests/` directory at the workspace root. Configure `foundry.toml` with an `arbitrum_sepolia` fork profile pointing to an Arbitrum Sepolia RPC endpoint. Write a smoke test (`tests/src/smoke.t.sol`) that does nothing except confirm the fork is reachable and the RIP-7212 precompile at `0x0000000000000000000000000000000000000100` returns a non-zero response to a sample secp256r1 verification call.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §1 (RIP-7212 at `0x0000...0100`, ~3,450 gas per call). Arbitrum Sepolia RPC endpoint required (Alchemy or Infura account).

**Done when:** `forge test --fork-url $ARBITRUM_SEPOLIA_RPC` passes the smoke test. RIP-7212 precompile is confirmed reachable on the fork.

---

### Step 1.3 — Set up `cargo stylus` and confirm deployability

**What:** Install `cargo-stylus`. Run `cargo stylus check` on each of the three contract crates to confirm they are valid Stylus WASM contracts (no forbidden host calls, size within limits). Write a deploy script (`scripts/deploy.sh`) that deploys all three contracts in order (verifier first, then storage, then logic) using `cargo stylus deploy --private-key-path` pointing to a hardware wallet. The script should print the deployed addresses of all three contracts.

**Who:** David

**Context needed:** Stylus SDK documentation for `cargo stylus check` and `cargo stylus deploy`. Hardware wallet setup (Ledger/Trezor) with `eth_signTransaction` support.

**Done when:** `cargo stylus check` passes for all three crates. `scripts/deploy.sh` runs to completion on Sepolia with stub contract implementations (empty functions), printing three addresses.

---

### Phase 1 Milestone Review

**Context needed:** Workspace `Cargo.toml`, `protocol-types/src/lib.rs` (all type definitions), `foundry.toml`, `tests/src/smoke.t.sol`, `scripts/deploy.sh`.

**Done when:** All three contract crates compile to WASM. Foundry fork smoke test passes. `cargo stylus check` clears for all three crates. Stub deploy to Sepolia produces three addresses. Protocol type definitions are complete and cover all structs from §3 and all error codes from §8.

**Clarification checkpoint:** If `cargo stylus check` reports a contract exceeds the 24 KB WASM size limit, pause before continuing. This requires a structural decision about splitting the logic contract into sub-modules, which affects all subsequent phases.

---

## Phase 2: Storage Contract

**Objective:** A complete, tested storage contract that holds all protocol state, enforces access control, and enforces unconditional invariants — with no business logic.

---

### Step 2.1 — Implement storage mappings and getter functions

**What:** Implement all six storage mappings from §3, plus `LogicContract` and `PendingLogicUpgrade` (§3.7):

- `CardEntries: mapping(bytes32 → CardEntry)` (§3.1)
- `PolicyAuthorizerKeys: mapping(bytes32 → bytes[64])` (§3.2)
- `PressAuthorizations: mapping(bytes32 → mapping(bytes32 → PressAuthEntry))` (§3.3)
- `SubCardRegistrations: mapping(bytes32 → SubCardEntry)` (§3.4)
- `OpenOfferUseCounts: mapping(bytes32 → uint64)` (§3.5)
- `GovernanceKeysets: mapping(GovernanceBodyId → GovernanceKeyset)` (§3.6)

Implement all read functions from §5: `GetCardEntry`, `GetPressAuthorization`, `GetPolicyAuthorizer`, `GetSubCardEntry`, `GetOpenOfferCount`, `GetGovernanceKeyset`, `IsPressActive`, `CardExists`, `GetLogicContract`, `GetPendingLogicUpgrade`. These are public view functions callable by anyone.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §3 (full storage layout, all field names and types); §5 (read operations, return types). `protocol-types` crate (all struct definitions).

**Done when:** All getters compile. Unit tests (`#[cfg(test)]`) confirm getters return zero/default values on uninitialized storage. No setters yet.

---

### Step 2.2 — Implement setter functions and access control

**What:** Implement one setter per logical storage operation. Each setter must:
1. Revert with `CALLER_NOT_LOGIC_CONTRACT` (E-29) if `msg.sender != self.logic_contract.get()`.
2. Apply the relevant unconditional invariant check (§3.7) before writing.
3. Write the new value.

Setters to implement: `setCardEntry`, `setForwardTo`, `setPressAuthEntry`, `setSubCardEntry`, `setOpenOfferCount`, `setPolicyAuthorizerKey`, `deletePolicyAuthorizerKey` (for `DeregisterPolicy` stub), `setGovernanceKeyset`, `setLogicContract`, `setPendingLogicUpgrade`, `clearPendingLogicUpgrade`.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §3.7 (storage access control, unconditional invariants — the five invariants table); §8 (E-29 error code). Note: `deletePolicyAuthorizerKey` is the one setter *not* protected by an unconditional invariant (per the OQ-E decision); it is access-controlled only.

**Done when:** All setters compile. Unit tests confirm: (a) any call from a non-`LogicContract` address reverts with E-29; (b) a call from the registered `LogicContract` address succeeds and writes correctly.

---

### Step 2.3 — Test unconditional storage invariants

**What:** Write tests for each of the five unconditional storage invariants in §3.7:

1. `CardEntries[addr].exists` is write-once: calling `setCardEntry` with `exists=true` then attempting `setCardEntry` with `exists=false` reverts.
2. `CardEntries[addr].forward_to` is immutable once non-zero: calling `setForwardTo` twice reverts on the second call.
3. `PolicyAuthorizerKeys` has no delete path via normal setters (only `deletePolicyAuthorizerKey` can delete, and it exists only for `DeregisterPolicy`).
4. `PressAuthorizations[p][a].revoked_at` is write-once-non-zero: once set, overwriting or zeroing reverts.
5. `SubCardRegistrations[addr].deregistered_at` is write-once-non-zero: once set, overwriting or zeroing reverts.

Run these tests as Stylus SDK unit tests. Also write a Foundry test (`tests/src/StorageInvariants.t.sol`) that: deploys the storage contract and a test logic contract, wires them together, exercises the invariants via the test logic contract, and confirms all invariants hold after a simulated logic contract replacement.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §3.7 (invariants table). The logic contract replacement test is the key scenario: a new logic contract is registered, and the test confirms the old invariants still hold even though a different contract is now the caller.

**Done when:** All five invariant tests pass in unit tests and in the Foundry fork test. The logic-replacement scenario test passes.

---

### Phase 2 Milestone Review

**Context needed:** `storage-contract/src/lib.rs`, `tests/src/StorageInvariants.t.sol`, `protocol-types/src/lib.rs`.

**Done when:** All getter/setter unit tests pass. All invariant tests pass including the logic-replacement scenario. Storage contract deploys to Sepolia via `cargo stylus deploy` and all read functions return correct zero values on a fresh deployment.

---

## Phase 3: Verifier Module

**Objective:** A Stylus WASM contract that wraps the RIP-7212 precompile for secp256r1 verification, with a documented interface for the future ML-DSA-44 upgrade.

---

### Step 3.1 — Implement the secp256r1 verifier module

**What:** Implement the verifier module as a Stylus WASM contract with a single public function:

```
verify_secp256r1(
    message_hash: [u8; 32],    — keccak256 of the signed payload
    signature: [u8; 64],       — r||s (64 bytes)
    public_key: [u8; 64]       — uncompressed x||y (64 bytes, no 0x04 prefix)
) → bool
```

Internally, this calls the RIP-7212 precompile at `0x0000000000000000000000000000000000000100` with the ABI encoding `(bytes32 hash, bytes32 r, bytes32 s, bytes32 x, bytes32 y)`. Returns `true` on valid signature, `false` on invalid. Does not revert for invalid signatures — callers (the logic contract) are responsible for converting `false` into a revert.

Also define a trait `IVerifier` in `protocol-types` with this function signature, so the logic contract can call either the secp256r1 module or a future ML-DSA-44 module via the same interface.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §1 (RIP-7212 precompile address, ~3,450 gas per call); §6.3 (verifier module description: "Phase 1: thin wrapper delegating to RIP-7212 precompile"). RIP-7212 precompile ABI: `(bytes32 hash, bytes32 r, bytes32 s, bytes32 x, bytes32 y) → (bytes32 result)`, where `result == bytes32(1)` on success.

**Done when:** Verifier module compiles to WASM. `cargo stylus check` passes.

---

### Step 3.2 — Test the verifier module against the real precompile

**What:** Write Foundry fork tests (`tests/src/Verifier.t.sol`) using at least 10 real secp256r1 key pairs and signatures. Tests must: (a) confirm valid signatures return `true`; (b) confirm invalid signatures (wrong key, wrong message, flipped bit in signature) return `false`; (c) measure the gas cost and confirm it is ~3,450 gas per call. Do not use mocked signatures. Generate test vectors in a helper script (`scripts/gen_test_vectors.rs` using the `p256` crate) and commit them as test fixtures.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §1 (RIP-7212 gas cost estimate). `p256` Rust crate for generating test vectors. Arbitrum Sepolia fork RPC.

**Done when:** All Foundry verifier tests pass on the Arbitrum Sepolia fork. Gas cost per call is measured and within 10% of the 3,450 estimate.

---

### Phase 3 Milestone Review

**Context needed:** `verifier-module/src/lib.rs`, `protocol-types/src/lib.rs` (`IVerifier` trait), `tests/src/Verifier.t.sol`, test vector fixtures.

**Done when:** Verifier module deploys to Sepolia. Fork tests pass with real secp256r1 test vectors. Gas cost documented.

---

## Phase 4: Logic Contract — Card Write Operations

**Objective:** All card-facing write operations working correctly against the deployed storage and verifier contracts.

---

### Step 4.1 — Implement the Card Write Gate (§6.1)

**What:** Implement the 6-step write gate as a shared internal function `verify_press_write(policy_address, press_address, press_sig_payload, press_signature) → Result<(), ContractError>`:

1. Confirm `policy_address` exists in `PolicyAuthorizerKeys`.
2. Look up `PressAuthorizations[policy_address][press_address]`.
3. Confirm entry exists.
4. Confirm `active == true`.
5. Call `IVerifier::verify_secp256r1` over `keccak256(press_sig_payload)` against `press_public_key`. Revert with E-06 on failure.
6. Confirm `sequence` in the parsed `press_sig_payload` equals `next_sequence`. Increment on success.

Each step maps to a specific error code from §8 (E-03, E-04, E-05, E-06, E-07). The write gate is called by every card write operation in this phase.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §6.1 (write gate, all 7 steps, error codes); §8 (E-03 through E-08). Note: step 7 (prev_log_cid check) is `UpdateCardHead`-specific and implemented in that function, not in the shared gate.

**Done when:** Unit tests confirm each gate step triggers the correct error code when violated. The function signature is stable and callable from all card write operations.

---

### Step 4.2 — Implement RegisterCard (§4.1) and UpdateCardHead (§4.2)

**What:** Implement both operations, calling `verify_press_write` for authorization, then writing state via the storage contract's setter interface. `UpdateCardHead` additionally checks `prev_log_cid` matches the stored head (E-08) before writing. Both emit their corresponding events (`CardRegistered`, `CardHeadUpdated`).

Implement payload deserialization: `press_sig_payload` is canonical RFC 8785 JSON; parse `op`, `card_address`, `sequence`, etc. from the raw bytes. The contract must verify the `op` field matches the expected operation name to prevent cross-operation payload replay.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.1 (RegisterCard — preconditions, RegisterCardPayload, state changes); §4.2 (UpdateCardHead — preconditions, UpdateCardHeadPayload, state changes, note on revocations); §7 (CardRegistered, CardHeadUpdated events); §8 (E-01, E-02, E-08).

**Done when:** Both operations pass their full spec acceptance criteria. Unit tests cover: new card registration, duplicate registration (E-01), update on existing card, update with stale prev_cid (E-08), sequence mismatch (E-07), press not authorized (E-04/E-05), invalid signature (E-06).

---

### Step 4.3 — Implement ClaimOpenOffer (§4.5)

**What:** Implement `ClaimOpenOffer` as an atomic combination of open offer validation + `RegisterCard`. All preconditions must be checked before any state change. The atomicity requirement means: if the offer is expired or at capacity, the card is not registered; if card registration fails, the offer count is not incremented.

Map document-level `null` values correctly: `max_acceptances == type(uint64).max` for unconstrained; `expires_at == 0` for unconstrained. Emit both `OpenOfferClaimed` and `CardRegistered` events on success.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.5 (ClaimOpenOffer — all preconditions, atomicity note, state changes); §3.5 (OpenOfferUseCounts, lazy initialization on first claim); §7 (OpenOfferClaimed event); §8 (E-12, E-13).

**Done when:** Acceptance criteria tests pass: expired offer (E-12), at-capacity offer (E-13), successful claim increments count and creates card atomically, unconstrained offer (max_acceptances = u64::MAX and expires_at = 0) works correctly.

---

### Step 4.4 — Implement RegisterAddressForward (§4.13)

**What:** Implement `RegisterAddressForward`. This operation is authorized by the press's secp256r1 key (not the card write gate — it uses the press signature directly), so it calls the verifier module directly rather than `verify_press_write`. The key being verified is from `PressAuthorizations` for the old card's last press.

Authorization checks: `old_address` must exist, `new_address` must exist, `forward_to` must be zero (E-27), signature must verify. E-28 is press-side only (not enforced on-chain).

Sets `CardEntries[old_address].forward_to = new_address` and emits `AddressTransition`.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.13 (full function signature, authorization checks 1–5, note on E-28 being press-side only); §7 (AddressTransition event); §8 (E-27, E-28). Note from §3.7: `forward_to` is protected by an unconditional storage invariant once non-zero.

**Done when:** All six acceptance criteria from §4.13 pass.

---

### Step 4.5 — Implement BatchUpdateCardHeads (§4.15)

**What:** Implement `BatchUpdateCardHeads`. Key requirements: (a) all preconditions validated before any state change; (b) `sequence` incremented by exactly 1 regardless of batch size; (c) all items must belong to the same policy; (d) no duplicate `card_address` values in the batch; (e) MAX_BATCH_SIZE = 100. Emits one `CardHeadUpdated` event per item, in order.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.15 (full spec, BatchUpdateCardHeadsPayload, preconditions, gas note); §8 (E-33, E-34). Critical: the spec is explicit that `next_sequence` increments by 1 (not by item count).

**Done when:** All acceptance criteria from §4.15 pass including: empty batch (E-33), oversized batch (E-33), duplicate card_address (E-34), cross-policy card in batch (E-34), stale prev_log_cid on any item reverts entire transaction (E-08), sequence increment is exactly 1.

---

### Phase 4 Milestone Review

**Context needed:** `logic-contract/src/card_ops.rs`, `logic-contract/src/write_gate.rs`, `tests/src/CardOps.t.sol`, `specs/object_specs/registry_contract.md` §4.1, §4.2, §4.5, §4.13, §4.15.

**Done when:** All card write operations pass their spec acceptance criteria in Foundry fork tests. The write gate correctly enforces all 6 steps for each operation. Events are emitted correctly and parseable by a standard EVM event decoder. No partial state changes occur when any precondition fails.

**Clarification checkpoint:** If the RFC 8785 canonical JSON parsing turns out to require a non-trivial amount of code (the spec requires the signed payload to be canonical JSON), pause and confirm the approach — either implement a minimal RFC 8785 serializer in Rust, or change the payload encoding to ABI-encoded bytes (which would be a spec change requiring author sign-off).

---

## Phase 5: Logic Contract — Sub-Card Operations

---

### Step 5.1 — Implement RegisterSubCard (§4.3) and DeregisterSubCard (§4.4)

**What:** Implement both sub-card operations. Key design note: neither operation verifies the ML-DSA-44 master or app signature on-chain — the press verifies these off-chain and retains the signatures in calldata for auditability only. The contract checks only: (a) card existence, (b) press authorization via the write gate, (c) `registration_log_head` matches the current stored head at call time.

`RegisterSubCard` creates the `SubCardEntry`; `DeregisterSubCard` sets `active = false` and `deregistered_at = block.timestamp`. Both emit their corresponding events. Deregistered entries are retained (not deleted) per the audit trail requirement.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.3 (RegisterSubCard — full spec, press-side-only note for master signature and app-chain verification); §4.4 (DeregisterSubCard — press-side-only note for master signature, sub-card key cannot self-deregister); §7 (SubCardRegistered, SubCardDeregistered); §8 (E-10, E-11); §3.4 (SubCardEntry fields, 64-byte CID limit for `sub_card_doc_cid`).

**Done when:** Precondition tests pass: master card not found, sub-card already active (E-11), stale registration_log_head. Sub-card deregistration with retained entry confirmed. Deregistered-at invariant confirmed (§3.7 — write-once-non-zero).

---

### Phase 5 Milestone Review

**Context needed:** `logic-contract/src/subcard_ops.rs`, `tests/src/SubCardOps.t.sol`.

**Done when:** RegisterSubCard and DeregisterSubCard pass all acceptance criteria. The `sub_card_doc_cid` 64-byte limit is enforced. Events are emitted correctly. The storage invariant for `deregistered_at` is confirmed to hold.

---

## Phase 6: Logic Contract — Governance Operations

**Objective:** All governance operations working correctly, including quorum verification, replay prevention, and self-amending key rotation.

---

### Step 6.1 — Implement Governance Quorum Verification (§6.2)

**What:** Implement `verify_governance_quorum(body_id, governance_payload, governance_sigs) → Result<(), ContractError>` as a shared internal function. The four steps:

1. Confirm `governance_version` in payload matches stored version (E-15).
2. Confirm `nonce` has not been seen before. Implement a `UsedNonces: mapping(bytes32 → bool)` in the storage contract for this. (This requires adding one storage mapping and one setter to the storage contract — add them now.)
3. For each signature: identify key in `GovernanceKeysets[body_id].keys`, verify secp256r1, confirm no duplicate signers (E-16, E-17).
4. Confirm distinct valid sig count >= quorum (E-18).

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §6.2 (full quorum verification algorithm, all 4 steps); §8 (E-07G, E-15, E-16, E-17, E-18). Note: the nonce storage must be added to the storage contract (a minor amendment to Phase 2 work).

**Done when:** Unit tests confirm each failure mode triggers the correct error. A valid 2-of-3 quorum with 3 distinct valid signatures passes. Tests cover duplicate signer (E-17), insufficient quorum (E-18), wrong governance version (E-15), reused nonce (E-07G).

---

### Step 6.2 — Implement RegisterPolicy (§4.6) and AuthorizePress (§4.7)

**What:** Implement both operations using `verify_governance_quorum`. `RegisterPolicy` creates a `PolicyAuthorizerKeys` entry. `AuthorizePress` creates or updates a `PressAuthorizations` entry, initializing `next_sequence = 0` and `authorized_at = block.timestamp`. Both emit their events.

Also implement `DeregisterPolicy` stub (per OQ-E decision): a governance-gated operation (`RootPolicyBody` quorum) that calls `deletePolicyAuthorizerKey` on the storage contract. Include the stub but note prominently in code comments that §3.7 does not protect this entry unconditionally, and that calling `DeregisterPolicy` makes all presses and cards under that policy non-writable.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.6 (RegisterPolicy — preconditions, RegisterPolicyPayload, state changes); §4.7 (AuthorizePress — preconditions, AuthorizePressPayload, state changes including key rotation note); §7 (PolicyRegistered, PressAuthorized events); §8 (E-09).

**Done when:** Duplicate policy registration reverts (E-09). Policy not found in AuthorizePress reverts (E-03). Quorum checks apply correctly. AuthorizePress re-issuance (key rotation for an existing press) updates the key and resets `active = true`. DeregisterPolicy stub compiles and is governance-gated.

---

### Step 6.3 — Implement RevokePress (§4.8) and RotateAuthorizerKey (§4.9)

**What:** Implement both operations. `RevokePress` sets `active = false` and `revoked_at = block.timestamp`; the entry is retained. `RotateAuthorizerKey` overwrites `PolicyAuthorizerKeys[policy_address]` with the new key. Both are `PressRegistryBody`- and `RootPolicyBody`-gated respectively.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.8 (RevokePress); §4.9 (RotateAuthorizerKey); §7 (PressRevoked, AuthorizerKeyRotated events); §8 (E-04, E-05); §3.7 (revoked_at is write-once-non-zero invariant — enforced by storage contract setter).

**Done when:** RevokePress reverts if press not found or already revoked. Entry is retained with `active = false`. RotateAuthorizerKey fails if policy not found.

---

### Step 6.4 — Implement RotateGovernanceKeys (§4.10)

**What:** Implement the self-amending governance key rotation. Critical: signatures must be from the *current* keyset, not the proposed new keyset. After validation: replace `keys[]`, set `quorum`, increment `version`. Preconditions:

- `new_quorum > len(new_keys) / 2` (E-19)
- `len(new_keys) >= 3` (E-20)
- Signatures from current keyset (not proposed new keys)
- Governance version matches

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.10 (RotateGovernanceKeys — full spec, preconditions 1–4, state changes); §7 (GovernanceKeysRotated event with version); §8 (E-19, E-20). Bootstrap note from §3.6: the initial 1-of-1 keyset has `len(keys) = 1`; the first rotation to expand to 3+ members must pass E-20 check, which means `new_keys >= 3` — you cannot rotate to a 2-of-2.

**Done when:** All preconditions trigger correct error codes. Self-amendment works: a 2-of-3 quorum can rotate to a 3-of-5 keyset. Version increments after rotation. Governance version is checked correctly in subsequent operations.

---

### Phase 6 Milestone Review

**Context needed:** `logic-contract/src/governance_ops.rs`, `tests/src/GovernanceOps.t.sol`, `specs/object_specs/registry_contract.md` §4.6–4.10, §6.2.

**Done when:** All governance operations pass acceptance criteria. Full governance sequence tested end-to-end: bootstrap 1-of-1 → `RegisterPolicy` → `AuthorizePress` → `RevokePress` → `RotateAuthorizerKey` → `RotateGovernanceKeys` to 3-of-5. Quorum enforcement is confirmed at each step. DeregisterPolicy stub is gated behind `RootPolicyBody` quorum.

---

## Phase 7: Logic Contract — Upgrade and Key Scheme Operations

**Objective:** The logic upgrade lifecycle (7-day timelock) and verifier upgrade (48-hour timelock) work correctly. ML-DSA-44 key scheme rotation stub is in place for Phase 3 readiness.

---

### Step 7.1 — Implement UpgradeLogic: ProposeLogicUpgrade, ConfirmLogicUpgrade, CancelLogicUpgrade (§4.14)

**What:** Implement the three-operation logic upgrade lifecycle. Proposal writes `PendingLogicUpgrade` to storage. Confirmation requires: (a) 7 days elapsed since `proposed_at`; (b) `proposed_logic_address` matches; (c) `governance_version` at confirmation matches version at proposal time (keyset rotation between proposal and confirmation invalidates the proposal — E-15); (d) fresh quorum signatures (different nonce from proposal). On confirmation, the storage contract's `setLogicContract` setter is called, which updates `LogicContract` to the new address — from that point, all storage setter calls from the old logic contract will revert with E-29.

Cancellation: governance-gated, clears `PendingLogicUpgrade`.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.14 (full three-operation spec, all payloads, all preconditions); §7 (LogicUpgradeProposed, LogicUpgradeConfirmed, LogicUpgradeCancelled events); §8 (E-30, E-31, E-32). Critical: after successful `ConfirmLogicUpgrade`, the old logic contract no longer has write access to storage — confirm with a test.

**Done when:** All acceptance criteria from §4.14 pass. Time-based tests use `vm.warp` in Foundry to simulate the 7-day elapsed time. The post-upgrade test confirms: (a) old logic contract calls to storage revert with E-29; (b) new logic contract calls succeed; (c) all storage invariants still hold.

**Clarification checkpoint:** Before implementing `ConfirmLogicUpgrade`, pause and confirm the `UpgradeVerifier` governance operation scope. The spec says the verifier module address is stored in the logic contract (not the storage contract). A `UpgradeVerifier` operation in the current logic contract changes the verifier address in the current logic contract's own storage — a logic upgrade that replaces the logic contract would need to carry the verifier address forward. Confirm the intended behavior before coding.

---

### Step 7.2 — Implement RotateOnChainKeyScheme (§4.11)

**What:** Implement the Phase 2 key scheme upgrade stub. In Phase 1 (current), `contract.key_scheme_phase` is `0`. `RotateOnChainKeyScheme` must revert with E-24 (`SCHEME_UPGRADE_NOT_AVAILABLE`) in Phase 1. Implement the full function signature and all precondition checks, but the `key_scheme_phase == 0` check (E-24) will cause it to always revert in Phase 1. This establishes the correct function interface so a Phase 2 logic upgrade can enable it by setting `key_scheme_phase = 1`.

Store `key_scheme_phase: uint8` in the storage contract (add the mapping now). Its initial value at deploy is `0`.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.11 (RotateOnChainKeyScheme — full spec, all preconditions); §8 (E-23, E-24, E-25, E-26). Note: precondition 3 (`key_scheme_phase >= 1`) will always fail in Phase 1 — the function exists but is always disabled. This is the intended behavior.

**Done when:** `RotateOnChainKeyScheme` reverts with E-24 in Phase 1. The function signature and all error codes compile correctly. A comment in code explains the Phase 2 enable path.

---

### Phase 7 Milestone Review

**Context needed:** `logic-contract/src/upgrade_ops.rs`, `logic-contract/src/key_scheme_ops.rs`, `tests/src/UpgradeOps.t.sol`.

**Done when:** Logic upgrade cycle tests pass including: proposal, 7-day warp, confirmation, old-logic-contract access revocation. `RotateOnChainKeyScheme` reverts E-24 as expected. Storage invariants confirmed to survive a logic upgrade.

---

## Phase 8: Integration Tests

**Objective:** End-to-end tests across all three deployed contracts confirming complete protocol lifecycles work correctly.

---

### Step 8.1 — Deploy all three contracts and wire them together

**What:** Write a Foundry `setUp()` that deploys all three contracts in order (verifier, then storage with `LogicContract = logic_address`, then logic pointing to storage and verifier) and confirms the wiring. This is the integration test base for all scenarios in this phase.

**Who:** David

**Context needed:** `scripts/deploy.sh` (deployment order); `specs/object_specs/registry_contract.md` §6.3 (three-contract model, constructor arguments). The storage contract's constructor takes `logic_address` as an argument; the logic contract's constructor takes both `storage_address` and `verifier_address`.

**Done when:** `setUp()` deploys and wires all three contracts. `GetLogicContract()` returns the logic address. `GetVerifierModule()` returns the verifier address.

---

### Step 8.2 — Full card lifecycle integration test

**What:** End-to-end test covering: bootstrap governance (1-of-1) → `RegisterPolicy` → `AuthorizePress` → `RegisterCard` → `UpdateCardHead` → `RegisterSubCard` → `DeregisterSubCard` → `BatchUpdateCardHeads` (5 cards) → `RegisterAddressForward`. Confirm all events are emitted correctly. Confirm all getter functions return correct values at each step.

**Who:** David

**Context needed:** All Phase 4–5 specs; real secp256r1 test key pairs from Phase 3 fixtures.

**Done when:** Test passes end-to-end. All intermediate state is confirmed via getter calls.

---

### Step 8.3 — Governance lifecycle integration test

**What:** End-to-end test covering governance expansion: 1-of-1 bootstrap → `RotateGovernanceKeys` to 3-of-5 for both bodies → `RegisterPolicy` with 2-of-3 quorum → `AuthorizePress` → `RevokePress` → `RotateAuthorizerKey`. Confirm governance version increments correctly and is enforced in subsequent operations.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §3.6 (governance bootstrap); §4.6–4.10; §6.2.

**Done when:** Governance operates correctly at 3-of-5 quorum. A 1-of-5 signature attempt is rejected. The governance version is tracked and enforced.

---

### Step 8.4 — Logic upgrade integration test

**What:** End-to-end upgrade cycle: deploy initial contracts → write cards → propose logic upgrade → confirm logic is blocked at 6 days → warp 7 days → confirm upgrade → confirm old logic contract can no longer write → deploy a new logic contract with a minor change → confirm storage state is preserved through the upgrade → confirm storage invariants hold for the new logic contract.

**Who:** David

**Context needed:** `specs/object_specs/registry_contract.md` §4.14; §3.7 (storage invariants must survive logic upgrade).

**Done when:** Full 7-day upgrade cycle completes in test. Storage state is preserved. Old logic contract is locked out. Invariants hold.

---

### Phase 8 Milestone Review

**Context needed:** `tests/src/Integration.t.sol`; `plans/contract-strategic-plan.md` §Key Objectives.

**Done when:** All integration tests pass on Arbitrum Sepolia fork. All acceptance criteria from the spec are covered by at least one test. Gas costs for each write operation are measured and recorded in a `tests/gas-report.md` file.

---

## Phase 9: Sepolia Deployment and Validation

**Objective:** Confirm the contracts work on the live Arbitrum Sepolia network with a hardware wallet and real transaction signing.

---

### Step 9.1 — Deploy to Arbitrum Sepolia using hardware wallet

**What:** Run `scripts/deploy.sh` against Arbitrum Sepolia using the hardware wallet. The deployment order is: (1) verifier module, (2) storage contract (passing the (not-yet-deployed) logic contract address is impossible — use a two-step approach: deploy storage with a placeholder, then deploy logic, then call `setLogicContract` via a bootstrap call), or use CREATE2 to predetermine all three addresses. Record all three deployed addresses.

**Who:** David (hardware wallet required)

**Context needed:** `scripts/deploy.sh`. Hardware wallet connected, funded with Sepolia ETH from faucet. Note: the chicken-and-egg problem of storage needing logic's address and logic needing storage's address — resolve via CREATE2 or a deployer contract.

**Done when:** All three contracts are deployed on Sepolia. Addresses are recorded in `deployments/sepolia.json`. `GetLogicContract()` returns the correct logic address on the live network.

**Clarification checkpoint:** Before this step, choose and implement the CREATE2 or deployer contract approach to resolve the circular address dependency. This is a deployment procedure decision — document the choice in `deployments/README.md`.

---

### Step 9.2 — Execute bootstrap sequence on Sepolia

**What:** Using the hardware wallet, execute the full bootstrap sequence on Sepolia:

1. `RegisterPolicy` (1-of-1 governance, hardware wallet signs)
2. `AuthorizePress` (1-of-1 governance, hardware wallet signs)
3. `RegisterCard` (press signs with a secp256r1 test key)
4. `UpdateCardHead` (same press)
5. `RotateGovernanceKeys` to expand to 3-of-5 (requires 3 signers if simulated, or just confirm the call is correct with 1-of-1 before expansion)

**Who:** David

**Context needed:** `deployments/sepolia.json` (deployed addresses); real secp256r1 key pairs for the press test keys.

**Done when:** All 5 operations succeed on Sepolia. Transaction hashes recorded in `deployments/sepolia-bootstrap.md`. Gas costs for each transaction measured against the integration test gas report.

---

### Step 9.3 — Run acceptance criteria against live Sepolia contracts

**What:** Run the Foundry fork tests against the actual Sepolia deployment (not a forked state, but the live contracts) using `--fork-url` with the live RPC and the deployed contract addresses. Confirm all tests pass against the live state.

**Who:** David

**Context needed:** `deployments/sepolia.json`; `tests/src/` (all test files); Arbitrum Sepolia RPC endpoint.

**Done when:** All fork tests pass against live Sepolia contracts. Gas report is finalized.

---

### Phase 9 Milestone Review

**Context needed:** `deployments/sepolia.json`, `deployments/sepolia-bootstrap.md`, `tests/gas-report.md`.

**Done when:** Contracts are live on Sepolia, bootstrap sequence is complete, all acceptance criteria pass against the live deployment, gas costs are within estimated bounds.

---

## Phase 10: Audit

**Objective:** External security audit completed and all findings addressed before mainnet deployment.

---

### Step 10.1 — Prepare audit package

**What:** Assemble the audit scope document: (a) links to all three contract source files at the commit to be audited; (b) the spec (`specs/object_specs/registry_contract.md` v0.3) as the authoritative description of intended behavior; (c) the Sepolia deployment addresses and bootstrap transaction hashes as proof of operational correctness; (d) the integration test suite as the machine-readable acceptance criteria; (e) a written summary of the three highest-risk areas to focus on: the unconditional storage invariants (§3.7), the governance quorum verification (§6.2), and the logic upgrade timelock (§4.14).

Freeze the code at a tagged commit (`v1.0.0-audit`) before sending to the auditor.

**Who:** David

**Context needed:** All contract source files; `deployments/sepolia.json`; `specs/object_specs/registry_contract.md`.

**Done when:** Audit package sent to external firm. Commit tagged `v1.0.0-audit`. Code is frozen — no changes to audited contracts until audit is complete.

---

### Step 10.2 — Address audit findings

**What:** Review all audit findings. For each finding: (a) assess whether it is a spec violation (fix required), a spec gap (discuss with author), or a known accepted risk (document); (b) implement fixes for all Critical and High severity findings; (c) re-run full test suite after each fix; (d) document disposition of each finding in `deployments/audit-findings.md`.

**Who:** David (with author for spec gaps)

**Context needed:** Audit report; `specs/object_specs/registry_contract.md`; `plans/contract-strategic-plan.md` §Goals.

**Done when:** All Critical and High findings are resolved. A second audit review (or at minimum, auditor confirmation) of the fixes is complete. `deployments/audit-findings.md` documents every finding and its disposition.

**Clarification checkpoint:** If any audit finding requires a change to the storage contract's unconditional invariants (§3.7) or the three-contract architecture, pause and get author sign-off before implementing. These are foundational design choices, not implementation details.

---

### Phase 10 Milestone Review

**Context needed:** `deployments/audit-findings.md`; final contract source at `v1.0.0-rc1` tag; full test suite passing on the post-fix codebase.

**Done when:** External auditor has confirmed all Critical/High findings are addressed. Test suite passes on the final release candidate. Code is frozen and ready for mainnet deployment.

---

## Phase 11: Mainnet Deployment

**Objective:** Contracts deployed to Arbitrum One mainnet. Storage contract address published as the permanent protocol identifier.

---

### Step 11.1 — Deploy to Arbitrum One mainnet

**What:** Run the same deployment procedure as Phase 9 Step 9.1, against Arbitrum One mainnet. Use the hardware wallet. Pay real ETH for deployment gas. Record all three contract addresses in `deployments/mainnet.json`.

**Who:** David (hardware wallet required; this is a one-way operation)

**Context needed:** `deployments/README.md` (deployment procedure); `deployments/sepolia.json` (same procedure, different RPC); funded Arbitrum One wallet.

**Done when:** All three contracts are deployed to Arbitrum One mainnet. `deployments/mainnet.json` records addresses. `GetLogicContract()` and `GetVerifierModule()` return correct addresses on mainnet.

---

### Step 11.2 — Execute mainnet bootstrap sequence

**What:** Same bootstrap sequence as Sepolia (Step 9.2) on mainnet. After bootstrap: call `RotateGovernanceKeys` to expand governance beyond 1-of-1. This is the highest-priority action after deployment — the single-deployer key is the initial trust anchor and should be reduced to a quorum as quickly as governance members are available.

**Who:** David (and governance co-signers for the rotation)

**Context needed:** `deployments/mainnet.json`; governance co-signer public keys; hardware wallet.

**Done when:** Mainnet bootstrap complete. `RotateGovernanceKeys` has been called at least once to expand governance to a multi-member quorum. Transaction hashes recorded in `deployments/mainnet-bootstrap.md`. Storage contract address published as the stable protocol identifier.

---

### Phase 11 Milestone Review (Final)

**Context needed:** `deployments/mainnet.json`, `deployments/mainnet-bootstrap.md`, `plans/contract-strategic-plan.md` §Goals.

**Done when:** Every goal from the strategic plan has a corresponding deliverable: three-contract architecture deployed (Goal 1); governance expanded beyond 1-of-1 (Goal 2); all write operations confirmed operational on mainnet (Goal 3); test suite referenced by deployed commit (Goal 4); Sepolia deployment validated (Goal 5).

---

## Clarification Checkpoints Summary

1. **Phase 1 Milestone Review:** If `cargo stylus check` reports any contract exceeds the 24 KB WASM size limit, pause before proceeding.
2. **Phase 4, Step 4.2:** If RFC 8785 canonical JSON parsing requires a non-trivial implementation, pause and confirm encoding approach with author.
3. **Phase 7, Step 7.1:** Before implementing `ConfirmLogicUpgrade`, pause to confirm `UpgradeVerifier` address propagation behavior across logic upgrades.
4. **Phase 9, Step 9.1:** Before deploying to Sepolia, decide and document the CREATE2 vs. deployer contract approach for resolving the circular address dependency.
5. **Phase 10, Step 10.2:** If any audit finding requires changing the storage contract's unconditional invariants or the three-contract architecture, pause for author sign-off.
6. **Any phase:** If a spec ambiguity or contradiction is discovered that affects contract behavior, pause and flag to author before proceeding. Do not make implementation assumptions for spec gaps.
