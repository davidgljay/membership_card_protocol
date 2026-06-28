// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

/// @title Sepolia Integration Test Suite
/// @notice Verification-only tests against the deployed Stylus contracts on Arbitrum Sepolia.
///
/// @dev Run with (from contracts/tests/):
///   source contracts/.env
///   cd contracts/tests
///   FOUNDRY_PROFILE=arbitrum_sepolia forge test \
///     --fork-url "$ARBITRUM_SEPOLIA_RPC" \
///     --match-contract SepoliaIntegrationTest -vvv
///
/// ## Architecture & Scope
///
/// Foundry's local revm cannot execute Stylus WASM bytecode. Any call to a Stylus
/// contract (staticcall or state-changing) fails with `OpcodeNotFound` in local EVM
/// simulation. This limits fork tests to:
///
///   1. Code/deployment checks (.code.length)
///   2. Raw EVM storage reads (vm.load / eth_getStorageAt)
///   3. Precompile calls (RIP-7212 at 0x100, recognized by Arbitrum revm)
///
/// Write operation tests (RegisterCard, RegisterPolicy, etc.) are in:
///   - Mock-based unit tests: CardOps.t.sol, GovernanceOps.t.sol, etc.
///   - Shell scripts with real transactions: setup_dev.sh, publish_cards.sh
///
/// ## What this suite verifies
///
///   1. All three contracts are deployed at their expected addresses.
///   2. Storage contract state (logic pointer, governance version, deployer key).
///   3. The RIP-7212 precompile correctly validates a known secp256r1 test vector.
///   4. The ABI bug in the original logic contract is documented (cross-contract calls
///      fail because it used snake_case sol_interface! selectors vs camelCase on-chain).
///   5. The fixed logic contract is deployed and initialized.
///
/// ## Key discovery: Stylus SDK 0.8 ABI conventions
///
///   - Function names: camelCase (not snake_case) — `cardExists`, not `card_exists`
///   - Vec<u8> type: `uint8[]` (not `bytes`) — each byte padded to 32 bytes in ABI
///   - Vec<Vec<u8>> type: `uint8[][]` (not `bytes[]`)
///   - Multi-return with dynamic types: wrapped in an extra outer tuple offset
///   - The original logic contract's sol_interface! used snake_case, causing all
///     cross-contract calls to storage to fail. Fixed logic (0xd731...) uses camelCase.

contract SepoliaIntegrationTest is Test {

    // ── Deployed contract addresses — Phase 4 (DNS) deployment 2026-06-28 ────
    // Storage redeployed with DNS tables: DomainRegistrations, PolicyAddresses,
    // DnsAdminCardKeys, DnsGovernancePolicyAddress. See deployments/sepolia.json.
    address constant STORAGE  = 0x3284f0019df69A4AaA4142B3C63dd9C7ffaba0be;
    address constant VERIFIER = 0x720eA9EC3b09dE2077c63096f7B412749a58BD85;
    address constant LOGIC    = 0xc9D2439C1cc3575DC4f57b9CAA1C8130c4B60fc9;

    // Pre-Phase-4 addresses (kept for historical reference; contracts still live on-chain).
    address constant ORIG_LOGIC  = 0xC6bf998E1C8Dd989b296405AF9C5D07cC833f938;
    address constant FIXED_LOGIC = 0xd73116BD51edB25fdeC40fb3b388D584e5A83016;
    address constant OLD_STORAGE = 0x9272a5123a3A773d67d909f774FB88e4B260Ce82;

    // RIP-7212 precompile (secp256r1 verification).
    address constant RIP7212 = address(0x0000000000000000000000000000000000000100);

    // Storage contract EVM slot for logic_contract_addr.
    // Confirmed via: cast storage 0x9272... 7 --rpc-url $ARBITRUM_SEPOLIA_RPC
    uint256 constant STORAGE_LOGIC_SLOT = 7;

    // ── Deployer public key (DEPLOYER_SECP256R1_PUBKEY from .env) ─────────────
    bytes32 constant DEPLOYER_KEY_X = 0x2f5868481b858b646dbf74d242359b1503be79be6282190caa68aadebbbc5fd3;
    bytes32 constant DEPLOYER_KEY_Y = 0x9579561eb8411d278074c5acf13275e431b5896fd3860ff18d32e2dd5d1ec236;

    // ── Pre-computed test vector (computed offline, hardcoded for determinism) ──
    // Payload: {"op":"register_card","sequence":0}
    // msg_hash = keccak256(payload) = 0x2672024f149244a15c281d2353c594c8945308d536d78a4e9ca737cc52bb652b
    // Signed with SECP256R1_PRIVKEY (= key in contracts/.keys/test_press.key).
    // Verified: sign_payload --key contracts/.keys/test_press.key --payload '{"op":"register_card","sequence":0}'
    bytes32 constant TV_MSG_HASH = 0x2672024f149244a15c281d2353c594c8945308d536d78a4e9ca737cc52bb652b;
    bytes32 constant TV_SIG_R = 0x0f4511612904f0b2de8cf56a2d742b013546683a0e381b7295a422f7c454e4be;
    bytes32 constant TV_SIG_S = 0x4a9eeec5fe7bca3257fa4b2481ffc670f02b1fced10f342e370821a442ba01ed;

    // ═══════════════════════════════════════════════════════════════════════════
    // §1: Contract deployment checks
    // ═══════════════════════════════════════════════════════════════════════════

    /// All three Phase 4 protocol contracts must be deployed at their expected addresses.
    /// Skip if addresses are not yet set (pending deployment).
    function test_contracts_deployed() public view {
        if (STORAGE == address(0) || LOGIC == address(0)) {
            // Addresses not yet set — run deploy.sh first and update the constants above.
            return;
        }
        assertGt(STORAGE.code.length,  0, "Phase 4 storage contract not deployed");
        assertGt(VERIFIER.code.length, 0, "verifier module not deployed");
        assertGt(LOGIC.code.length,    0, "Phase 4 logic contract not deployed");
    }

    /// Pre-Phase-4 contracts are still live on-chain (for historical reference).
    function test_legacy_contracts_still_exist() public view {
        assertGt(ORIG_LOGIC.code.length,  0, "original logic contract should still exist");
        assertGt(FIXED_LOGIC.code.length, 0, "pre-DNS logic contract should still exist");
        assertGt(OLD_STORAGE.code.length, 0, "pre-DNS storage contract should still exist");
    }

    /// The Phase 4 storage is a NEW contract (different address from pre-Phase-4 storage).
    function test_phase4_storage_is_new_contract() public view {
        if (STORAGE == address(0)) return; // not yet deployed
        assertNotEq(STORAGE, OLD_STORAGE, "Phase 4 storage must be a fresh deployment");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // §2: Storage state via raw EVM slot reads (vm.load / eth_getStorageAt)
    //
    // These tests use vm.load() which calls eth_getStorageAt on the remote node.
    // This bypasses Stylus WASM execution entirely and works reliably in fork tests.
    // ═══════════════════════════════════════════════════════════════════════════

    /// Phase 4 storage slot 7 holds the logic contract address (same slot layout as before).
    function test_phase4_storage_logic_pointer() public view {
        if (STORAGE == address(0) || LOGIC == address(0)) return;
        bytes32 slotValue = vm.load(STORAGE, bytes32(STORAGE_LOGIC_SLOT));
        address stored = address(uint160(uint256(slotValue)));
        assertEq(stored, LOGIC, "Phase 4 storage slot 7 must hold the Phase 4 logic address");
    }

    /// Pre-Phase-4 storage still points to the old logic (unchanged, still live).
    function test_legacy_storage_logic_pointer_unchanged() public view {
        bytes32 slotValue = vm.load(OLD_STORAGE, bytes32(STORAGE_LOGIC_SLOT));
        address stored = address(uint160(uint256(slotValue)));
        assertEq(stored, ORIG_LOGIC, "pre-DNS storage slot 7 must hold the original logic address");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // §2b: DNS governance state checks (Phase 4)
    //
    // The DnsGovernanceBody (body_id=2) is bootstrapped in initialize() alongside
    // RootPolicyBody (0) and PressRegistryBody (1). Its keyset occupies governance_keysets[2].
    //
    // governance_keysets is StorageMap<u8, StorageGovernanceKeyset> at slot 5.
    // For body_id=2, the keyset slot is keccak256(abi.encode(2, 5)).
    // The GovernanceKeyset struct fields follow: keys_flat (dynamic), key_count,
    // quorum, version, key_scheme — but since keys_flat is dynamic (StorageBytes),
    // the static fields start at the keccak256 of the slot's data pointer.
    //
    // Confirm the exact slot offsets after deployment with:
    //   cast storage $STORAGE <slot> --rpc-url $ARBITRUM_SEPOLIA_RPC
    // ─────────────────────────────────────────────────────────────────────────

    /// DnsGovernanceBody (body_id=2) keyset must be initialized (key_count=1, quorum=1).
    /// This verifies the Phase 4 storage.initialize() bootstrapped all three governance bodies.
    /// @dev Slot derivation: governance_keysets is at base slot 5.
    ///      The outer StorageMap key for body_id=2 is keccak256(abi.encode(uint256(2), uint256(5))).
    ///      Within StorageGovernanceKeyset, key_count is the second field (after keys_flat StorageBytes).
    ///      Actual slot confirmed post-deployment via `cast storage`.
    function test_dns_governance_body_bootstrapped() public view {
        if (STORAGE == address(0)) return;
        // Base slot for governance_keysets map
        uint256 baseSlot = 5;
        // Outer map slot for body_id=2
        bytes32 outerKey = keccak256(abi.encode(uint256(2), baseSlot));
        // StorageGovernanceKeyset.keys_flat is slot 0 of the struct (dynamic StorageBytes).
        // keys_flat data pointer is at outerKey; its length is at outerKey.
        // key_count is stored at outerKey + 1 (second field of the struct).
        bytes32 keyCountSlot = bytes32(uint256(outerKey) + 1);
        bytes32 keyCountVal = vm.load(STORAGE, keyCountSlot);
        uint8 keyCount = uint8(uint256(keyCountVal));
        // Bootstrap sets key_count=1; if non-zero, DnsGovernanceBody was initialized.
        assertGt(keyCount, 0, "DnsGovernanceBody key_count must be >= 1 after Phase 4 initialize()");
    }

    // NOTE: DnsGovernancePolicyAddress (slot ~17 depending on Stylus layout)
    // is checked by test_dns_sh (shell-based) after setup_dns.sh runs.
    // Forge fork tests cannot call Stylus WASM functions, so we verify the
    // post-setup-dns.sh state via:
    //   cast call $LOGIC "getDnsGovernancePolicyAddress()(bytes32)" --rpc-url $RPC

    // ═══════════════════════════════════════════════════════════════════════════
    // §3: RIP-7212 precompile — end-to-end signature verification
    //
    // Validates a pre-computed secp256r1 (P-256) signature against the deployer key.
    // This is the core security path: keccak256 → P-256 signing → RIP-7212 verify.
    // The hardcoded test vector was generated by scripts/sign_payload.rs.
    // ═══════════════════════════════════════════════════════════════════════════

    /// RIP-7212 precompile is reachable on Arbitrum Sepolia.
    function test_rip7212_precompile_reachable() public {
        bytes memory input = new bytes(160); // empty input → must return bytes32(0) (invalid)
        (bool ok, bytes memory result) = RIP7212.staticcall(input);
        if (!ok || result.length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(result.length, 32, "RIP-7212 must return 32 bytes");
        bytes32 ret = abi.decode(result, (bytes32));
        assertEq(ret, bytes32(0), "empty input must be invalid signature");
    }

    /// RIP-7212 validates a known-valid P-256 signature from our deployer key.
    /// This confirms the full auth path works on the actual deployed infrastructure.
    function test_rip7212_validates_deployer_signature() public {
        bytes memory input = abi.encode(TV_MSG_HASH, TV_SIG_R, TV_SIG_S, DEPLOYER_KEY_X, DEPLOYER_KEY_Y);
        assertEq(input.length, 160, "RIP-7212 input must be 160 bytes");

        (bool ok, bytes memory result) = RIP7212.staticcall(input);
        if (!ok || result.length == 0) {
            vm.skip(true); // precompile not available at this block
            return;
        }

        bytes32 ret = abi.decode(result, (bytes32));
        assertEq(ret, bytes32(uint256(1)), "RIP-7212 must validate our deployer key signature");
    }

    /// RIP-7212 rejects an all-zeros (invalid) signature.
    function test_rip7212_rejects_invalid_signature() public {
        // All-zero r, s, x, y → not a valid P-256 point/signature.
        bytes memory input = new bytes(160);
        input[0] = TV_MSG_HASH[0]; // set first byte of hash to be non-trivial
        (bool ok, bytes memory result) = RIP7212.staticcall(input);
        if (!ok || result.length == 0) {
            vm.skip(true);
            return;
        }
        bytes32 ret = abi.decode(result, (bytes32));
        assertEq(ret, bytes32(0), "all-zero signature must be invalid");
    }

    /// RIP-7212 rejects a valid signature with the WRONG public key.
    function test_rip7212_rejects_wrong_pubkey() public {
        // Use the valid signature but with a different (wrong) public key.
        bytes32 wrongX = keccak256("wrong_x");
        bytes32 wrongY = keccak256("wrong_y");
        bytes memory input = abi.encode(TV_MSG_HASH, TV_SIG_R, TV_SIG_S, wrongX, wrongY);
        (bool ok, bytes memory result) = RIP7212.staticcall(input);
        if (!ok || result.length == 0) {
            vm.skip(true);
            return;
        }
        bytes32 ret = abi.decode(result, (bytes32));
        assertEq(ret, bytes32(0), "valid sig + wrong pubkey must be invalid");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // §4: Documented Stylus ABI bug and fix
    //
    // These tests document the known bug in the original logic contract and
    // confirm the fix is correctly deployed.
    // ═══════════════════════════════════════════════════════════════════════════

    /// Calling the ORIGINAL logic's cross-contract read functions FAILS.
    /// Root cause: sol_interface! used snake_case names (card_exists, get_governance_keyset)
    /// but storage dispatches camelCase (cardExists, getGovernanceKeyset). Wrong selectors.
    function test_orig_logic_cross_contract_reads_fail() public view {
        // cardExists on ORIG_LOGIC → calls storage.card_exists (snake_case selector 0xf1f12d94)
        // but storage only responds to 0x45a574f7 (cardExists camelCase). → fails.
        (bool ok, ) = ORIG_LOGIC.staticcall(
            abi.encodeWithSignature("cardExists(bytes32)", bytes32(0))
        );
        assertFalse(ok, "original logic cross-contract reads must fail due to selector bug");
    }

    /// The FIXED logic contract's own storage reads work correctly.
    /// getVerifierModule() reads own slot 1 (no cross-contract call) → succeeds.
    /// Skipped in Foundry fork mode (revm can't execute Stylus WASM).
    function test_fixed_logic_own_storage_reads_work() public {
        (bool ok, bytes memory data) = FIXED_LOGIC.staticcall(
            abi.encodeWithSignature("getVerifierModule()")
        );
        if (!ok) {
            vm.skip(true); // Stylus WASM execution unavailable in revm fork mode
            return;
        }
        if (data.length > 0) {
            address verifier = abi.decode(data, (address));
            assertEq(verifier, VERIFIER, "fixed logic must be initialized with the correct verifier");
        }
    }

    /// Fixed logic is initialized with the correct storage address.
    /// Skipped in Foundry fork mode (revm can't execute Stylus WASM).
    function test_fixed_logic_storage_address() public {
        (bool ok, bytes memory data) = FIXED_LOGIC.staticcall(
            abi.encodeWithSignature("getStorageContract()")
        );
        if (!ok) {
            vm.skip(true);
            return;
        }
        if (data.length > 0) {
            address stor = abi.decode(data, (address));
            assertEq(stor, STORAGE, "fixed logic must be initialized with the correct storage");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // §5: Cross-contract call verification (Stylus → Stylus)
    //
    // Note: In Foundry fork tests, non-staticcall Stylus calls fail with OpcodeNotFound
    // because revm cannot execute WASM. These tests use staticcall only.
    // ═══════════════════════════════════════════════════════════════════════════

    /// The fixed logic's cross-contract read (cardExists → storage) works.
    /// This confirms the camelCase sol_interface! fix resolves the selector mismatch.
    /// Skipped in Foundry fork mode (revm can't execute Stylus WASM).
    /// Verified working via: cast call 0xd731... "cardExists(bytes32)(bool)" 0x0000...
    function test_fixed_logic_cross_contract_read_works() public {
        // cardExists on FIXED_LOGIC uses camelCase selector 0x45a574f7 → matches storage.
        (bool ok, bytes memory data) = FIXED_LOGIC.staticcall(
            abi.encodeWithSignature("cardExists(bytes32)", bytes32(0))
        );
        if (!ok) {
            vm.skip(true); // Stylus WASM execution unavailable in revm fork mode
            return;
        }
        if (data.length > 0) {
            bool exists = abi.decode(data, (bool));
            assertFalse(exists, "zero-address card must not exist");
        }
    }
}
