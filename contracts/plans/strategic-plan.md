# Strategic Plan: Sepolia Integration Test Suite & Dev Environment

> Companion document: [implementation-plan.md](./implementation-plan.md)

---

## Context: What the existing tests already cover

The existing Foundry suite in `contracts/tests/src/` (`CardOps.t.sol`, `GovernanceOps.t.sol`, `Integration.t.sol`, etc.) is fully mock-based. `MockVerifierAlwaysTrue` accepts any 64-byte input as a valid signature. `MockStorage` and `MockLogic` are pure Solidity stubs — they have no connection to the deployed Stylus contracts. The `arbitrum_sepolia` Foundry profile exists but is used only by `smoke.t.sol`, which confirms the RIP-7212 precompile is reachable; it does not call any protocol contract.

**What's new in this plan:**
- Fork tests that call the actual deployed Stylus contracts on Sepolia (`0xd50215b0…` logic, `0x9a64b7d9…` storage, `0x21a03a0c…` verifier) with real secp256r1 signatures
- A manual `cast` command guide for one-off function testing
- A dev environment setup suite that configures the Sepolia contract (policy + press) and publishes test cards, enabling end-to-end testing of press scripts and verification scripts

---

## Goals

**1. Prove every specced function is callable and correct against the live Sepolia deployment.**
Fork tests target the actual deployed addresses. They use real secp256r1 signatures verified through the real RIP-7212 precompile via the deployed verifier module. A function that passes only against mocks may still fail on-chain due to ABI encoding differences, gas exhaustion, or precompile behavior — this test suite catches those.

**2. Establish a durable key management pattern for governance key rotation.**
`RotateGovernanceKeys` is the highest-stakes governance operation. Testing it requires generating real keypairs, signing with the *current* keyset, and confirming the new keyset is accepted. The `.keys/` directory is already gitignored; this plan extends that pattern with role-named files (`governance_root_new_0.key`, etc.) and documents the convention.

**3. Produce a gas cost reference for every specced function.**
Gas figures from real Stylus WASM execution on Sepolia are the ground truth. The `deployments/sepolia.json` already records deployment costs; this plan adds a per-function call cost table alongside it.

**4. Provide a `cast`-based manual testing guide.**
A markdown document in `contracts/tests/` with ready-to-paste `cast call` / `cast send` commands for every function. Developers can use this to probe live state, test individual calls, or debug failures without running the full Forge suite.

**5. Create a dev environment setup suite for end-to-end press and verification testing.**
Shell scripts (using `cast`) that configure the Sepolia contract from scratch — register a policy, authorize a press, publish test cards — and save the resulting addresses and CIDs to a local JSON file. Press scripts and verification scripts can read this file as their dev fixture, enabling a complete local-to-Sepolia developer loop.

---

## Rationale

**Goal 1 — live chain parity.** The mock tests prove correctness of control flow. The fork tests prove the contract is callable as deployed. The critical gap closed: the write gate calls the verifier module which calls the RIP-7212 precompile — this full call stack has never been exercised in tests. A payload encoding bug, a key-format mismatch, or an unexpected gas regression would only appear here.

**Goal 2 — key rotation.** The `.keys/` pattern already exists (`test_press.key` is a PEM EC private key). The governance rotation test extends this pattern to generate new keys, writes them to `.keys/governance_root_new_0.key` (and `_1`, `_2` for a 3-key set), and documents that they must never be committed. After rotation, the test confirms the new version is active by submitting a governance action that requires the new keyset.

**Goal 3 — gas reference.** The `sepolia.json` deployment record should grow to include call-level gas costs. The fork test suite records `gasUsed` from each tx receipt and the implementation plan's final step writes these to `contracts/plans/gas-costs.md`.

**Goal 4 — manual guide.** Developers joining the project, or anyone debugging a specific function, need a way to call functions without writing a test. The `cast` guide documents the ABI encoding for every function, including the JSON payload format required by the press write gate and governance quorum.

**Goal 5 — dev setup suite.** Press scripts and verification scripts need a live Sepolia environment with a known state. The setup suite creates that state deterministically and writes a `contracts/.keys/dev-state.json` (gitignored) containing the policy address, press address, authorized press pubkey, and a list of registered card addresses and their current CIDs. Any script that reads this file can interact with the dev environment.

---

## Key Objectives

### Goal 1 — Live function coverage
- Every function in §4 has at least one fork test calling the real deployed logic contract.
- Each test asserts the relevant event was emitted and the relevant storage getter returns the expected updated value.
- Tests that exercise governance (`RegisterPolicy`, `AuthorizePress`, etc.) use real secp256r1 signatures built from the deployer's key (`DEPLOYER_SECP256R1_PUBKEY` in `.env`).
- Tests that exercise the write gate (`RegisterCard`, `UpdateCardHead`, etc.) use real secp256r1 signatures built from `.keys/test_press.key`.

### Goal 2 — Key management
- `RotateGovernanceKeys` test generates 3 new secp256r1 keypairs, writes them to `.keys/governance_root_new_{0,1,2}.key`, and rotates to a 2-of-3 keyset signed by the current bootstrap key.
- Post-rotation: a `RegisterPolicy` call succeeds using 2-of-3 signatures from the new keyset.
- `.keys/` is confirmed gitignored before any keys are written.

### Goal 3 — Gas cost record
- `contracts/plans/gas-costs.md` contains one row per function call: function name, tx hash (or fork gas snapshot), gasUsed, effectiveGasPrice, total ETH cost.
- Produced from Forge's gas reports on fork tests, not estimates.

### Goal 4 — Manual guide
- `contracts/tests/MANUAL_TESTING.md` covers every function with: description, `cast call` (for reads) or `cast send` (for writes), example payload JSON, and expected output.
- Includes a section on generating valid secp256r1 signatures for press and governance payloads using `openssl` or the `gen_test_vectors` Rust script.

### Goal 5 — Dev setup suite
- `contracts/scripts/setup_dev.sh`: idempotent script that reads the current on-chain state and, if not already configured, runs `RegisterPolicy` + `AuthorizePress` against Sepolia. Writes results to `contracts/.keys/dev-state.json`.
- `contracts/scripts/publish_cards.sh`: script that reads `dev-state.json`, then runs `RegisterCard` + `UpdateCardHead` + `RegisterSubCard` for a set of test cards, updating `dev-state.json` with the resulting card addresses and CIDs.
- Both scripts require `DEPLOYER_SECP256R1_PRIVKEY` and `PRESS_SECP256R1_PRIVKEY` in `.env`, and `cast` + `openssl` on `$PATH`.

---

## Assumptions (resolved OQs)

- **Bootstrap governance state:** The deployer used a 1-of-1 secp256r1 keyset (`DEPLOYER_SECP256R1_PUBKEY` in `.env`) at initialization. Current version must be read from chain before building payloads — the implementation plan includes a `cast call get_governance_keyset` step at the start of every governance test.
- **Bootstrap private key:** Stored in `.env` as `PRIVATE_KEY` (Ethereum deployer key) or a separate `DEPLOYER_SECP256R1_PRIVKEY`. The implementation plan flags this as a **Clarification Checkpoint** — confirm the key name in `.env` before the governance signing step.
- **`RotateOnChainKeyScheme`:** Test only the expected E-24 revert (Phase 1, `key_scheme_phase == 0`). No happy-path test since advancing the phase is out of scope.
- **`DisablePolicyDeletePermanently`:** Include in fork tests (fork state is not persisted). Exclude from the dev setup suite (irreversible on live state).
- **Nonce/sequence persistence:** Fork tests run against a pinned state snapshot and don't persist. The dev setup suite submits real transactions — each run uses fresh nonces derived from a counter in `dev-state.json`.
