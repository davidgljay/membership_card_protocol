# Implementation Plan: Sepolia Integration Test Suite & Dev Environment

> Linked to: [strategic-plan.md](./strategic-plan.md)

---

## Overview

Three parallel deliverables:
- **A** — Forge fork tests (`contracts/tests/src/SepoliaIntegration.t.sol`)
- **B** — Manual `cast` guide (`contracts/tests/MANUAL_TESTING.md`)
- **C** — Dev environment setup suite (`contracts/scripts/setup_dev.sh`, `publish_cards.sh`)

Phases 1–2 are shared setup. Phases 3–5 build A, B, and C respectively. Phase 6 is the gas cost record and final review.

---

## ⚠️ Clarification Checkpoints

Before any governance-signing step, pause and confirm:

1. **`DEPLOYER_SECP256R1_PRIVKEY` location.** The `.env` contains `DEPLOYER_SECP256R1_PUBKEY`. Confirm the corresponding private key name in `.env` (likely `DEPLOYER_SECP256R1_PRIVKEY` or `PRIVATE_KEY_SECP256R1`) before proceeding to any step that requires signing a governance payload.

2. **Current on-chain governance state.** Run the `cast call get_governance_keyset` command in Phase 1 and confirm the output matches expected bootstrap state (version=0 or 1, quorum=1, key_count=1) before building any governance payload. If the state has already been modified (version > 0, multi-key), the payload construction steps will need to adjust the version and signature count.

3. **Before submitting any `cast send` transaction in Phase 5 (dev setup suite):** Show the unsigned payload and computed signature to the user for confirmation. Do not submit governance transactions without explicit approval.

4. **`DisablePolicyDeletePermanently` (§4.16):** This operation is irreversible even on Sepolia. Include it in fork tests only (no real tx). Confirm with user before writing the fork test that exercises it.

---

## Phase 1: Environment Verification

**Goal:** Confirm all prerequisites are in place before writing any test code.

### Step 1.1 — Read current on-chain governance state
**What:** Call `get_governance_keyset(0)` (RootPolicyBody) and `get_governance_keyset(1)` (PressRegistryBody) on the deployed logic contract to read current `version`, `quorum`, `key_count`.
**Who:** Claude
**Context needed:** `deployments/sepolia.json` (logic contract address), `ARBITRUM_SEPOLIA_RPC` from `.env`
**Command:**
```bash
source contracts/.env
cast call 0xd50215b035b5fa20269a5974bc94dffac8e23001 \
  "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```
**Done when:** Both body IDs return values and the version/quorum/key_count are recorded in a comment at the top of `SepoliaIntegration.t.sol`.

### Step 1.2 — Verify deployer key is accessible
**What:** Confirm that the deployer secp256r1 private key variable name in `.env` and that the key matches `DEPLOYER_SECP256R1_PUBKEY`.
**Who:** User (Clarification Checkpoint #1 above)
**Context needed:** `contracts/.env`
**Done when:** Key name is confirmed and the key round-trips: `openssl ec -in <privkey-file> -pubout -outform DER | tail -c 64 | xxd -p -c 128` matches `DEPLOYER_SECP256R1_PUBKEY`.

### Step 1.3 — Verify `cast` and `openssl` are available
**What:** Run `cast --version` and `openssl version`. Confirm `forge` is available with `forge --version`.
**Who:** Claude
**Context needed:** none
**Done when:** All three tools are confirmed available.

### Phase 1 Milestone Review
**Context needed:** Output of Steps 1.1–1.3
**Done when:** On-chain governance state is recorded, deployer key is confirmed accessible, and toolchain is verified. Any discrepancy (e.g., governance version is not 0 or 1) is flagged and resolved before Phase 2 begins. No test code is written until this review passes.

---

## Phase 2: Signature Infrastructure

**Goal:** Build the off-chain signing helpers needed by all three deliverables. A test or script that can't construct a valid secp256r1 signature can't test anything real.

### Step 2.1 — Verify `gen_test_vectors.rs` produces real signatures
**What:** Run `cargo run --manifest-path contracts/scripts/Cargo.toml --bin gen_test_vectors` and confirm `scripts/test_vectors.json` is produced with 7 vectors.
**Who:** Claude
**Context needed:** `contracts/scripts/gen_test_vectors.rs`, `contracts/scripts/Cargo.toml`
**Done when:** `test_vectors.json` exists and contains at least one vector with `valid: true`.

### Step 2.2 — Write a `sign_payload.rs` helper binary
**What:** Add a new binary to `contracts/scripts/` that:
  - Accepts `--key <pem-file>` and `--payload <json-string>` arguments
  - Computes `keccak256(payload_bytes)` (using the `tiny-keccak` or `alloy-primitives` crate)
  - Signs the hash with the key using secp256r1 (RFC 6979)
  - Prints the 64-byte signature as `0x<hex>` to stdout

This binary is the signing primitive for both the fork tests (via `vm.ffi`) and the `cast` guide (via shell invocation).
**Who:** Claude
**Context needed:** `contracts/scripts/Cargo.toml`, `contracts/scripts/gen_test_vectors.rs` (for crate patterns), `contracts/Cargo.lock`
**Done when:** Running `cargo run --bin sign_payload -- --key contracts/.keys/test_press.key --payload '{"op":"register_card","sequence":0}'` prints a 64-byte hex signature.

### Step 2.3 — Write a `build_governance_payload.rs` helper binary
**What:** Add a binary that:
  - Accepts `--op <op_name>`, `--body <0|1>`, `--version <u32>`, `--nonce <hex_or_random>`, and op-specific fields
  - Outputs canonical JSON in the format expected by `verify_governance_quorum` (RFC 8785 field order: `governance_version`, `nonce`, `op`, then op-specific fields)
  
This is needed because the governance quorum verifier parses specific JSON fields. Getting the field order wrong produces a parseable-looking payload that the contract rejects with `INVALID_PAYLOAD`.
**Who:** Claude
**Context needed:** `contracts/protocol-types/src/lib.rs` §`payload_parser`, `contracts/logic-contract/src/write_gate.rs` §`verify_governance_quorum`
**Done when:** Output JSON is parseable by `payload_parser::extract_governance_version` and `extract_nonce_bytes` in a local Rust unit test.

### Phase 2 Milestone Review
**Context needed:** `scripts/sign_payload.rs`, `scripts/build_governance_payload.rs`, output of Step 2.1
**Done when:** Both signing helpers produce output that, when passed to the existing mock-based governance tests via a Rust unit test harness, would be accepted (or rejected for expected reasons). No contract calls yet — this review validates the helpers before they're used.

---

## Phase 3: Forge Fork Tests (Deliverable A)

**Goal:** Write `contracts/tests/src/SepoliaIntegration.t.sol` covering every specced function.

### Step 3.1 — Fork test scaffolding and helpers
**What:** Create `SepoliaIntegration.t.sol` with:
  - Contract addresses from `deployments/sepolia.json` as constants
  - A `setUp()` that calls `vm.createFork(ARBITRUM_SEPOLIA_RPC)` and `vm.selectFork()`
  - A `_signPressPayload(string memory json, string memory keyPath)` helper using `vm.ffi` to call `sign_payload` binary
  - A `_signGovernancePayload(string memory json, string memory keyPath)` helper (same pattern)
  - A `_buildPressPayload(string memory op, uint64 seq)` helper that produces the canonical JSON
  - A `_buildGovernancePayload(string memory op, uint8 body, uint32 version, string memory nonce)` helper
**Who:** Claude
**Context needed:** `contracts/tests/foundry.toml` (arbitrum_sepolia profile), `deployments/sepolia.json`, `contracts/tests/src/smoke.t.sol` (for fork setup pattern)
**Done when:** `forge test --profile arbitrum_sepolia --match-contract SepoliaIntegrationTest --match-test test_scaffolding_noop` passes (a no-op test that just reads `get_logic_contract()` and asserts it matches the known address).

### Step 3.2 — Governance function tests (§4.6–4.10)

Write one test per function in this order (each depends on the previous):

**`test_fork_register_policy`**
- Build governance payload: `{"governance_version":<v>,"nonce":"<fresh_hex>","op":"register_policy","policy_address":"<hex>","authorizer_pubkey":"<deployer_pubkey_hex>"}`
- Sign with deployer key via `vm.ffi`
- Call `register_policy(policy_address, authorizer_pubkey, governance_payload_bytes, [sig_bytes])`
- Assert: `policy_exists(policy_address)` returns true, `PolicyRegistered` event emitted

**`test_fork_authorize_press`**
- Depends on: `register_policy` having succeeded (uses same policy address)
- Build governance payload for `authorize_press`, sign with deployer key
- Call `authorize_press(policy_address, press_address, press_pubkey, mldsa44_key_hash, payload, [sig])`
  - `press_pubkey`: x||y from `.keys/test_press.key`
  - `mldsa44_key_hash`: `bytes32(0)` (no ML-DSA key in Phase 1)
- Assert: `is_press_active(policy_address, press_address)` returns true, `PressAuthorized` emitted

**`test_fork_rotate_authorizer_key`**
- Build governance payload for `rotate_authorizer_key`, sign with deployer key
- Call with a fresh 64-byte public key (generate a new key for this test)
- Assert: `get_policy_authorizer(policy_address)` returns new key, `AuthorizerKeyRotated` emitted

**`test_fork_rotate_governance_keys`**
- Generate 3 new secp256r1 keypairs, write to `.keys/governance_root_new_0.key`, `_1.key`, `_2.key`
- Build governance payload for `rotate_governance_keys` with body_id=0, new_key_count=3, new_quorum=2
  - `new_keys_flat`: concatenated 64-byte pubkeys of the 3 new keys
- Sign with current deployer key (1-of-1 quorum)
- Call `rotate_governance_keys(0, new_keys_flat, 3, 2, payload, [sig])`
- Assert: `get_governance_keyset(0)` returns key_count=3, quorum=2, version=original+1
- Then: submit a `register_policy` with a new nonce signed by 2 of the 3 new keys to prove rotation is live

**`test_fork_revoke_press`**
- Depends on: press authorized in `test_fork_authorize_press`
- Build governance payload for `revoke_press`, sign with deployer key
- Assert: `is_press_active` returns false, `revoked_at` > 0, `PressRevoked` emitted

**Who:** Claude
**Context needed:** `strategic-plan.md §Key Objectives`, `contracts/logic-contract/src/governance_ops.rs`, `contracts/protocol-types/src/lib.rs §payload_parser`, Phase 2 helpers
**Done when:** All 5 governance tests pass with `forge test --profile arbitrum_sepolia --match-test test_fork_`.

### Step 3.3 — Card operation tests (§4.1, §4.2, §4.5, §4.13, §4.15)

**`test_fork_register_card`**
- Build press payload: `{"op":"register_card","sequence":0,"policy":"<hex>","press":"<hex>","cid":"<hex>"}`
- Sign with `.keys/test_press.key`
- Call `register_card(card_address, initial_log_cid, policy_address, press_address, payload, sig)`
- Assert: `card_exists(card_address)`, `CardRegistered` emitted, `get_next_sequence` == 1

**`test_fork_update_card_head`**
- Depends on: card registered above (card_address, current CID known)
- Build press payload with op=`update_card_head`, sequence=1
- Call `update_card_head(card_address, new_cid, prev_cid, press_address, payload, sig)`
- Assert: `get_card_entry` returns new_cid, `CardHeadUpdated` emitted, sequence == 2

**`test_fork_claim_open_offer`**
- Build press payload with op=`claim_open_offer`, sequence=2
- Call with offer_id, max_acceptances=5, expires_at=0 (unconstrained), new card_address
- Assert: `card_exists` for new card, `OpenOfferClaimed` + `CardRegistered` emitted

**`test_fork_batch_update_card_heads`**
- Register 3 cards (via direct `register_card` calls, each consuming a sequence number)
- Build press payload with op=`batch_update_card_heads` and next sequence
- Call `batch_update_card_heads` with 3 cards
- Assert: all 3 card heads updated, sequence incremented by exactly 1, 3 `CardHeadUpdated` events

**`test_fork_register_address_forward`**
- Register a second card (new_card) as the forward target
- Build holder sig payload with op=`register_address_forward` (press signs over keccak256 of this)
- Call `register_address_forward(old_address, new_address, press_address, holder_payload, holder_sig, secp256r1_sig)`
- Assert: `get_card_entry(old_address).forward_to == new_address`, `AddressTransition` emitted

**Who:** Claude
**Context needed:** `contracts/logic-contract/src/card_ops.rs`, `contracts/protocol-types/src/lib.rs §payload_parser`, press key from Phase 2
**Done when:** All card op tests pass.

### Step 3.4 — Sub-card tests (§4.3, §4.4)

**`test_fork_register_sub_card`**
- Get current master card head CID from `get_card_entry`
- Build press payload with op=`register_sub_card`, sequence=current
- Call `register_sub_card(sub_address, master_address, registration_log_head, sub_doc_cid, press_address, payload, sig, b"", b"")`
  - `master_signature` and `master_sig_payload` can be empty bytes (not verified on-chain)
- Assert: `get_sub_card_entry(sub_address).active == true`, `SubCardRegistered` emitted

**`test_fork_deregister_sub_card`**
- Depends on sub-card registered above
- Build press payload with op=`deregister_sub_card`, next sequence
- Call `deregister_sub_card(sub_address, press_address, payload, sig, b"", b"")`
- Assert: `active == false`, `deregistered_at > 0`, `SubCardDeregistered` emitted

**Who:** Claude
**Context needed:** `contracts/logic-contract/src/subcard_ops.rs`
**Done when:** Both sub-card tests pass.

### Step 3.5 — Remaining function tests

**`test_fork_rotate_on_chain_key_scheme_reverts_e24`**
- Call `rotate_on_chain_key_scheme(...)` with any valid-looking arguments
- Assert: reverts with `SchemeUpgradeNotAvailable` (E-24, Phase 1)
- No signing needed — it reverts before signature verification

**`test_fork_disable_policy_delete_permanently`** (fork-only, not persisted)
- Build governance payload for `disable_policy_delete_permanently`, sign with deployer key
- Call the function
- Assert: `get_policy_delete_disabled()` returns true (via storage contract read), event emitted
- **Note:** Only run this test in the fork environment. Do not add to dev setup suite.

**`test_fork_propose_and_cancel_logic_upgrade`**
- Build governance payload for `propose_logic_upgrade`, sign with deployer key
- Call `propose_logic_upgrade(address(0xdead...), payload, [sig])`
- Assert: `get_pending_logic_upgrade()` shows the proposal, `LogicUpgradeProposed` emitted
- Then: immediately cancel with `cancel_logic_upgrade` (fresh nonce + sig)
- Assert: pending upgrade is cleared, `LogicUpgradeCancelled` emitted

**`test_fork_propose_and_cancel_verifier_upgrade`**
- Same pattern as logic upgrade but for verifier (48h timelock)
- Propose, assert pending, cancel, assert cleared

**Who:** Claude
**Context needed:** `contracts/logic-contract/src/upgrade_ops.rs`, `contracts/logic-contract/src/key_scheme_ops.rs`
**Done when:** All tests pass.

### Phase 3 Milestone Review
**Context needed:** All `SepoliaIntegration.t.sol` test output, `contracts/plans/strategic-plan.md §Key Objectives`
**Done when:**
- `forge test --profile arbitrum_sepolia --match-contract SepoliaIntegrationTest -vvv` shows all tests passing
- Every §4 function has at least one passing test
- No test relies on mock contracts — all calls go to the deployed Sepolia addresses
- Gas snapshots are captured (via `forge snapshot --profile arbitrum_sepolia`) for use in Phase 6

---

## Phase 4: Manual `cast` Guide (Deliverable B)

**Goal:** Write `contracts/tests/MANUAL_TESTING.md` — a self-contained guide for manually testing any function against the live Sepolia deployment.

### Step 4.1 — Guide structure and prerequisites section
**What:** Create the file with:
  - Contract addresses (from `sepolia.json`)
  - Required tools: `cast` (Foundry), `openssl`, `cargo` (for sign helpers)
  - Key locations: `.keys/test_press.key`, `.env` for governance key
  - How to source `.env`: `source contracts/.env`
  - ABI note: all `bytes32` arguments are 0x-prefixed 32-byte hex; all `bytes` are 0x-prefixed variable-length hex
**Who:** Claude
**Context needed:** `deployments/sepolia.json`
**Done when:** Section is written.

### Step 4.2 — Read-only functions section
**What:** Document every read function with a ready-to-paste `cast call`:
  - `get_governance_keyset(uint8)`
  - `get_card_entry(bytes32)`
  - `card_exists(bytes32)`
  - `get_press_authorization(bytes32,bytes32)`
  - `is_press_active(bytes32,bytes32)`
  - `get_next_sequence(bytes32,bytes32)`
  - `get_sub_card_entry(bytes32)`
  - `get_pending_logic_upgrade()`
  - `get_logic_contract()`
  - `get_verifier_module()`
  - `get_key_scheme_phase()`
  - `get_policy_delete_disabled()`

For each: function signature, example with placeholder arguments, description of return fields.
**Who:** Claude
**Context needed:** `contracts/logic-contract/src/lib.rs` §read operations, `deployments/sepolia.json`
**Done when:** All read functions documented with working `cast call` examples.

### Step 4.3 — Governance write functions section
**What:** For each governance write function, document:
  1. How to build the JSON payload (field order, field types)
  2. How to sign it: `cargo run --bin sign_payload -- --key .env --payload '<json>'`
  3. How to ABI-encode the governance sigs array for `cast send`
  4. The full `cast send` command

Functions: `register_policy`, `authorize_press`, `revoke_press`, `rotate_authorizer_key`, `rotate_governance_keys`, `propose_logic_upgrade`, `cancel_logic_upgrade`, `propose_verifier_upgrade`, `cancel_verifier_upgrade`, `disable_policy_delete_permanently`
**Who:** Claude
**Context needed:** `contracts/logic-contract/src/governance_ops.rs`, `write_gate.rs §verify_governance_quorum`, Phase 2 helper docs
**Done when:** All governance write functions documented. One `cast send` example for `register_policy` is end-to-end tested manually before the guide is finalized.

### Step 4.4 — Card write functions section
**What:** For each card write function, document:
  1. How to build the press payload JSON (field order: `"op"`, `"sequence"`, op-specific fields)
  2. How to sign: `cargo run --bin sign_payload -- --key .keys/test_press.key --payload '<json>'`
  3. Full `cast send` with all arguments spelled out

Functions: `register_card`, `update_card_head`, `claim_open_offer`, `register_address_forward`, `batch_update_card_heads`, `register_sub_card`, `deregister_sub_card`
**Who:** Claude
**Context needed:** `contracts/logic-contract/src/card_ops.rs`, `write_gate.rs §run_write_gate`, `contracts/protocol-types/src/lib.rs §payload_parser`
**Done when:** All card write functions documented.

### Step 4.5 — Troubleshooting section
**What:** Document the most common failure modes:
  - `InvalidPressSignature`: payload JSON field order wrong, or `"op"` value doesn't match function
  - `SequenceMismatch`: how to read current sequence with `cast call get_next_sequence`
  - `GovernanceVersionMismatch`: how to read current version and embed it in payload
  - `NonceReused`: nonce must be globally unique — use `xxd -p -l 32 /dev/urandom`
  - `StalePrevCid`: how to read current head with `cast call get_card_entry`
  - ABI encoding failures: the `bytes[]` type for governance sigs requires careful `cast` encoding
**Who:** Claude
**Done when:** Section written.

### Phase 4 Milestone Review
**Context needed:** `contracts/tests/MANUAL_TESTING.md`, one manual test of a governance write and one card write command
**Done when:** A developer can follow the guide from scratch and successfully call `register_card` on Sepolia using only the commands in the document.

---

## Phase 5: Dev Environment Setup Suite (Deliverable C)

**Goal:** Scripts that configure the Sepolia contract and publish test cards, enabling end-to-end press and verification testing.

### Step 5.1 — `setup_dev.sh`: idempotent contract configuration
**What:** Write `contracts/scripts/setup_dev.sh` that:
  1. Sources `contracts/.env`
  2. Reads `get_governance_keyset(0)` to get current version
  3. Reads `policy_exists(<dev_policy_address>)` — if already true, skips to step 4
  4. Builds `register_policy` governance payload with version and a fresh nonce, signs with deployer key, submits `cast send`
  5. Reads `is_press_active(<dev_policy_address>, <dev_press_address>)` — if already true, skips
  6. Builds `authorize_press` governance payload, signs, submits `cast send`
  7. Writes `contracts/.keys/dev-state.json`:
     ```json
     {
       "network": "arbitrum-sepolia",
       "logic_contract": "0x...",
       "policy_address": "0x...",
       "press_address": "0x...",
       "press_pubkey": "0x...",
       "governance_version": <n>,
       "cards": []
     }
     ```

**⚠️ Clarification Checkpoint:** Before submitting any `cast send` in this script, print the payload and signature to stdout and prompt `"Submit this transaction? (y/N)"`. Do not auto-submit governance transactions.
**Who:** Claude
**Context needed:** `contracts/scripts/build_governance_payload.rs`, `contracts/scripts/sign_payload.rs`, `contracts/.env`, `deployments/sepolia.json`
**Done when:** Running `setup_dev.sh` on a fresh Sepolia state creates `dev-state.json` and leaves `policy_exists` + `is_press_active` returning true on-chain.

### Step 5.2 — `publish_cards.sh`: publish a set of test cards
**What:** Write `contracts/scripts/publish_cards.sh` that:
  1. Sources `contracts/.env`, reads `contracts/.keys/dev-state.json`
  2. Reads `get_next_sequence(policy, press)` from chain
  3. For each card in `CARDS_TO_PUBLISH` (configurable via env var, default 3):
     - Generates a card address: `keccak256("dev_card_" || i)` as a `bytes32` hex
     - Builds a minimal CID placeholder: `0x1220` + sha256 of `"dev_card_content_" || i`
     - Builds press payload for `register_card`, signs with `.keys/test_press.key`, submits
     - Appends to `dev-state.json`: `{"card_address": "0x...", "cid": "0x...", "sequence": n}`
  4. For card 0: also runs `update_card_head` with an updated CID (to test that path)
  5. For card 0: also runs `register_sub_card` with a sub-card address
  6. Final `dev-state.json` contains enough addresses and CIDs for press and verification scripts to run against

**⚠️ Clarification Checkpoint:** Before submitting the first `cast send`, display the transaction count and estimated gas, and prompt for confirmation. If the user's Sepolia wallet has insufficient ETH, surface the error and exit cleanly.
**Who:** Claude
**Context needed:** `contracts/scripts/setup_dev.sh` (for pattern), `contracts/logic-contract/src/card_ops.rs`, `contracts/protocol-types/src/lib.rs §payload_parser`
**Done when:** Running `publish_cards.sh` after `setup_dev.sh` produces 3 registered cards on Sepolia and a `dev-state.json` with card addresses, CIDs, and the sub-card address.

### Step 5.3 — `read_dev_state.sh`: query current dev state
**What:** Write a short `contracts/scripts/read_dev_state.sh` that reads `dev-state.json` and queries the current on-chain state for each entity, printing a human-readable status table:
```
Policy:    0x... → EXISTS
Press:     0x... → ACTIVE (seq=7)
Card 0:    0x... → CID=0x1220...  fwd=none
Sub-card:  0x... → ACTIVE
```
This is the "health check" that press and verification scripts can run before starting.
**Who:** Claude
**Context needed:** `contracts/.keys/dev-state.json` format from Step 5.2
**Done when:** Script runs and prints correct state after `publish_cards.sh` completes.

### Phase 5 Milestone Review
**Context needed:** `contracts/scripts/setup_dev.sh`, `contracts/scripts/publish_cards.sh`, `contracts/scripts/read_dev_state.sh`, `contracts/.keys/dev-state.json` (after a test run)
**Done when:**
- `setup_dev.sh` is idempotent (safe to run twice)
- `publish_cards.sh` produces valid on-chain state verifiable by `cast call`
- `dev-state.json` is gitignored (confirm `.gitignore` covers `contracts/.keys/`)
- `read_dev_state.sh` shows all entities as expected

---

## Phase 6: Gas Cost Record and Final Verification

### Step 6.1 — Collect gas costs from fork tests
**What:** Run `forge test --profile arbitrum_sepolia --gas-report --match-contract SepoliaIntegrationTest` and extract the gas table. Also record gas from the Phase 5 `cast send` receipts (each tx prints `gasUsed` on success).
**Who:** Claude
**Context needed:** Phase 3 test output, Phase 5 tx receipts
**Done when:** Gas figures collected for every specced function.

### Step 6.2 — Write `gas-costs.md`
**What:** Create `contracts/plans/gas-costs.md` with:

| Function | §Spec | gasUsed | effectiveGasPrice (gwei) | Cost (ETH) | Notes |
|---|---|---|---|---|---|
| `register_policy` | §4.6 | — | — | — | governance quorum; 1 sig |
| `authorize_press` | §4.7 | — | — | — | governance quorum; 1 sig |
| `revoke_press` | §4.8 | — | — | — | |
| `rotate_authorizer_key` | §4.9 | — | — | — | |
| `rotate_governance_keys` | §4.10 | — | — | — | 1→3 key rotation |
| `register_card` | §4.1 | — | — | — | includes write gate |
| `update_card_head` | §4.2 | — | — | — | |
| `claim_open_offer` | §4.5 | — | — | — | |
| `register_address_forward` | §4.13 | — | — | — | |
| `batch_update_card_heads` | §4.15 | — | — | — | 3 cards |
| `register_sub_card` | §4.3 | — | — | — | |
| `deregister_sub_card` | §4.4 | — | — | — | |
| `rotate_on_chain_key_scheme` | §4.11 | — | — | — | E-24 revert; Phase 1 |
| `disable_policy_delete_permanently` | §4.16 | — | — | — | fork-only |
| `propose_logic_upgrade` | §4.14 | — | — | — | |
| `cancel_logic_upgrade` | §4.14 | — | — | — | |
| `propose_verifier_upgrade` | §6.3 | — | — | — | |
| `cancel_verifier_upgrade` | §6.3 | — | — | — | |

Populate the table from Step 6.1 output.
**Who:** Claude
**Context needed:** Step 6.1 output
**Done when:** Every function row has a real `gasUsed` value (not an estimate).

### Step 6.3 — Final verification
**What:** Run a complete end-to-end check:
  1. `forge test --profile arbitrum_sepolia --match-contract SepoliaIntegrationTest` — all pass
  2. `./contracts/scripts/setup_dev.sh` — idempotent, no errors
  3. `./contracts/scripts/publish_cards.sh` — 3 cards registered
  4. `./contracts/scripts/read_dev_state.sh` — all entities show expected on-chain state
  5. `git status` — confirm only intended files are staged (nothing in `.keys/`, nothing from `.env`)
**Who:** Claude
**Context needed:** All deliverables from Phases 3–6
**Done when:** All 5 checks pass with no errors. This is the sign-off step.

### Phase 6 Milestone Review
**Context needed:** `contracts/plans/gas-costs.md`, test run output, `read_dev_state.sh` output
**Done when:** Gas table is complete with real figures, all tests pass, all scripts work, and `git status` is clean.

---

## File manifest

| File | Deliverable | New or edit |
|---|---|---|
| `contracts/tests/src/SepoliaIntegration.t.sol` | A | New |
| `contracts/tests/MANUAL_TESTING.md` | B | New |
| `contracts/scripts/sign_payload.rs` | A, B, C | New |
| `contracts/scripts/build_governance_payload.rs` | A, B, C | New |
| `contracts/scripts/Cargo.toml` | A, B, C | Edit (add new bins) |
| `contracts/scripts/setup_dev.sh` | C | New |
| `contracts/scripts/publish_cards.sh` | C | New |
| `contracts/scripts/read_dev_state.sh` | C | New |
| `contracts/plans/gas-costs.md` | Phase 6 | New |
| `contracts/.keys/dev-state.json` | C | New (gitignored) |
| `contracts/.keys/governance_root_new_*.key` | A | New (gitignored) |
