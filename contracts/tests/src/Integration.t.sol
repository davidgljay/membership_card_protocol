// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Integration Tests (Phase 8)
/// @notice End-to-end tests for the three-contract registry system.
///
/// @dev Testing approach:
///      - Unit tests (CardOps.t.sol, GovernanceOps.t.sol, etc.) test individual
///        operations using Solidity mocks and MockVerifierAlwaysTrue.
///      - These integration tests test complete protocol lifecycles with realistic
///        data flows and verify all intermediate state.
///      - Fork integration tests (marked with @dev Requires ARBITRUM_SEPOLIA_RPC)
///        test against the real deployed Stylus contracts.
///
/// @dev Three integration scenarios per Phase 8 plan:
///      1. Full card lifecycle
///      2. Governance expansion (1-of-1 → 3-of-5)
///      3. Logic upgrade cycle (7-day timelock)

contract IntegrationTest is Test {
    MockStorage public storageContract;
    MockLogic public logicContract;
    MockLogic public newLogicContract;
    address public verifierModule;

    // Deployer / governance key (all 64 bytes set to differentiated test values).
    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
    bytes constant PRESS_KEY = hex"4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80";

    bytes32 constant POLICY_ADDR = keccak256("integration_policy");
    bytes32 constant PRESS_ADDR = keccak256("integration_press");
    bytes constant CID_GENESIS = hex"122029d35a747e2168e43278f3fe4e8bf4c89fe34e88f45a8cc8cb5ac9ba8eb2";
    bytes constant CID_V2 = hex"12206c7e8956ce065a3efbe0c8c5855f3ac0fc47b2e9f44f96deebd76aa0bff3";

    bytes[] governanceSigs;

    function setUp() public {
        // MockVerifierByKeyIndex: returns true when sig[0] == key[0].
        // This lets multi-sig quorum tests use distinct sigs for distinct keys
        // without triggering DuplicateSigner. DEPLOYER_KEY starts with 0x01.
        verifierModule = address(new MockVerifierByKeyIndex());
        storageContract = new MockStorage();
        logicContract = new MockLogic(address(storageContract), verifierModule);
        newLogicContract = new MockLogic(address(storageContract), verifierModule);

        // Initialize: storage points to logic.
        storageContract.initialize(address(logicContract), DEPLOYER_KEY);

        // Single governance sig — first byte 0x01 matches DEPLOYER_KEY[0].
        governanceSigs = new bytes[](1);
        governanceSigs[0] = new bytes(64);
        governanceSigs[0][0] = 0x01;
    }

    function _govVersion(uint8 body_id) internal view returns (uint32 v) {
        (,,,v,) = storageContract.get_governance_keyset(body_id);
    }

    /// @dev Press signature for MockVerifierByKeyIndex: first byte must match PRESS_KEY[0] = 0x41.
    function _pressSig() internal pure returns (bytes memory sig) {
        sig = new bytes(64);
        sig[0] = 0x41;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Scenario 1: Full Card Lifecycle (Phase 8 Step 8.2)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice End-to-end card lifecycle:
    ///   Bootstrap → RegisterPolicy → AuthorizePress → RegisterCard →
    ///   UpdateCardHead → RegisterSubCard → DeregisterSubCard →
    ///   BatchUpdateCardHeads (5 cards) → RegisterAddressForward
    function test_scenario1_full_card_lifecycle() public {
        // ── Step 1: RegisterPolicy ────────────────────────────────────────────
        logicContract.register_policy(
            POLICY_ADDR, DEPLOYER_KEY,
            bytes32(0), keccak256("s1_nonce_pol"), _govVersion(0),
            governanceSigs
        );
        assertTrue(storageContract.policy_exists(POLICY_ADDR), "Policy should be registered");

        // ── Step 2: AuthorizePress ────────────────────────────────────────────
        logicContract.authorize_press(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0),
            bytes32(0), keccak256("s1_nonce_press"), _govVersion(1),
            governanceSigs
        );
        assertTrue(storageContract.is_press_active(POLICY_ADDR, PRESS_ADDR), "Press should be active");

        // ── Step 3: RegisterCard ──────────────────────────────────────────────
        bytes32 card1 = keccak256("s1_card1");
        logicContract.register_card(
            card1, CID_GENESIS, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), _pressSig(), 0
        );
        assertTrue(storageContract.card_exists(card1), "Card 1 should exist");
        assertEq(storageContract.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 1);

        // Verify card entry.
        (bytes memory stored_cid, bytes32 pol, bytes32 press, bytes32 fwd, bool exists)
            = storageContract.get_card_entry(card1);
        assertEq(keccak256(stored_cid), keccak256(CID_GENESIS));
        assertEq(pol, POLICY_ADDR);
        assertEq(press, PRESS_ADDR);
        assertEq(fwd, bytes32(0));
        assertTrue(exists);

        // ── Step 4: UpdateCardHead ─────────────────────────────────────────────
        logicContract.update_card_head(
            card1, CID_V2, CID_GENESIS, PRESS_ADDR,
            bytes32(0), _pressSig(), 1
        );
        (bytes memory updated_cid,,,,) = storageContract.get_card_entry(card1);
        assertEq(keccak256(updated_cid), keccak256(CID_V2), "CID should be updated");
        assertEq(storageContract.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 2);

        // ── Step 5: RegisterSubCard ─────────────────────────────────────────────
        bytes32 sub_card = keccak256("s1_sub1");
        bytes memory sub_doc = hex"1220deadbeef";
        logicContract.register_sub_card(
            sub_card, card1, CID_V2, sub_doc,
            PRESS_ADDR, bytes32(0), _pressSig(), 2,
            new bytes(0), new bytes(0)
        );
        (bytes32 master,,,bool sub_active,,) = storageContract.get_sub_card_entry(sub_card);
        assertEq(master, card1, "Sub-card master should be card1");
        assertTrue(sub_active, "Sub-card should be active");
        assertEq(storageContract.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 3);

        // ── Step 6: DeregisterSubCard ──────────────────────────────────────────
        logicContract.deregister_sub_card(sub_card, PRESS_ADDR, bytes32(0), _pressSig(), 3);
        (,,,bool still_active,, uint64 dereg_at) = storageContract.get_sub_card_entry(sub_card);
        assertFalse(still_active, "Sub-card should be deregistered");
        assertGt(dereg_at, 0, "deregistered_at should be set");

        // ── Step 7: BatchUpdateCardHeads (5 cards) ────────────────────────────
        uint256 n = 5;
        bytes32[] memory batch_cards = new bytes32[](n);
        bytes[] memory prev_cids = new bytes[](n);
        bytes[] memory new_cids = new bytes[](n);

        // Register 5 cards first.
        for (uint256 i = 0; i < n; i++) {
            batch_cards[i] = keccak256(abi.encode("batch_s1", i));
            vm.prank(address(logicContract));
            storageContract.set_card_entry(batch_cards[i], CID_GENESIS, POLICY_ADDR, PRESS_ADDR, true);
            prev_cids[i] = CID_GENESIS;
            new_cids[i] = CID_V2;
        }

        uint64 seq_before_batch = storageContract.get_next_sequence(POLICY_ADDR, PRESS_ADDR);
        logicContract.batch_update_card_heads(
            POLICY_ADDR, PRESS_ADDR,
            batch_cards, prev_cids, new_cids,
            bytes32(0), _pressSig(), seq_before_batch
        );

        // Sequence should increment by exactly 1.
        assertEq(storageContract.get_next_sequence(POLICY_ADDR, PRESS_ADDR), seq_before_batch + 1);

        // All 5 cards updated.
        for (uint256 i = 0; i < n; i++) {
            (bytes memory cid,,,,) = storageContract.get_card_entry(batch_cards[i]);
            assertEq(keccak256(cid), keccak256(CID_V2), "Batch card should be updated");
        }

        // ── Step 8: RegisterAddressForward ────────────────────────────────────
        bytes32 new_card = keccak256("s1_new_card");
        vm.prank(address(logicContract));
        storageContract.set_card_entry(new_card, CID_GENESIS, POLICY_ADDR, PRESS_ADDR, true);

        logicContract.register_address_forward(card1, new_card, PRESS_ADDR, bytes32(0), _pressSig());

        (,,, bytes32 fwd_set,) = storageContract.get_card_entry(card1);
        assertEq(fwd_set, new_card, "forward_to should point to new_card");

        console.log("[Scenario 1] Full card lifecycle passed.");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Scenario 2: Governance Expansion (Phase 8 Step 8.3)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Governance expansion:
    ///   1-of-1 bootstrap → RotateGovernanceKeys to 2-of-3 → test 1-of-3 rejected →
    ///   test 2-of-3 accepted → RegisterPolicy → AuthorizePress → RevokePress → RotateAuthorizerKey
    function test_scenario2_governance_expansion() public {
        // ── Step 1: Rotate to 2-of-3 governance ──────────────────────────────
        bytes memory three_keys_flat = new bytes(192); // 3 * 64 bytes
        // Fill with differentiated key material.
        for (uint i = 0; i < 64; i++) {
            three_keys_flat[i] = bytes1(uint8(0x01 + i));
            three_keys_flat[64 + i] = bytes1(uint8(0x41 + i));
            three_keys_flat[128 + i] = bytes1(uint8(0x81 + i));
        }

        logicContract.rotate_governance_keys(
            0, // ROOT_POLICY_BODY
            three_keys_flat, 3, 2,
            bytes32(0), keccak256("s2_rotate_root"), _govVersion(0),
            governanceSigs
        );

        // Verify version incremented.
        (,, uint8 quorum, uint32 version,) = storageContract.get_governance_keyset(0);
        assertEq(quorum, 2, "Quorum should be 2");
        assertEq(version, 1, "Version should be 1");

        // Rotate PressRegistryBody too.
        logicContract.rotate_governance_keys(
            1, // PRESS_REGISTRY_BODY
            three_keys_flat, 3, 2,
            bytes32(0), keccak256("s2_rotate_press"), _govVersion(1),
            governanceSigs
        );

        // ── Step 2: Test that 1-of-3 quorum is rejected ──────────────────────
        // three_keys_flat: key[0][0]=0x01, key[1][0]=0x41, key[2][0]=0x81.
        // single_sig[0]=0x01 matches key[0] → valid_count=1 < quorum=2 → InsufficientQuorum.
        bytes[] memory single_sig = new bytes[](1);
        single_sig[0] = new bytes(64);
        single_sig[0][0] = 0x01; // matches key[0]

        uint32 govVer1 = _govVersion(1);
        vm.expectRevert(MockLogic.InsufficientQuorum.selector);
        logicContract.register_policy(
            keccak256("policy_1of3"),
            DEPLOYER_KEY,
            bytes32(0), keccak256("s2_insuff_nonce"), govVer1,
            single_sig
        );

        // ── Step 3: Test that 2-of-3 quorum is accepted ──────────────────────
        // two_sigs[0]=0x01 matches key[0]; two_sigs[1]=0x41 matches key[1].
        bytes[] memory two_sigs = new bytes[](2);
        two_sigs[0] = new bytes(64);
        two_sigs[0][0] = 0x01; // matches key[0]
        two_sigs[1] = new bytes(64);
        two_sigs[1][0] = 0x41; // matches key[1]

        logicContract.register_policy(
            POLICY_ADDR,
            DEPLOYER_KEY,
            bytes32(0), keccak256("s2_pol_nonce"), _govVersion(1),
            two_sigs
        );
        assertTrue(storageContract.policy_exists(POLICY_ADDR), "Policy should be registered with 2-of-3");

        // ── Step 4: AuthorizePress, RevokePress, RotateAuthorizerKey ──────────
        logicContract.authorize_press(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0),
            bytes32(0), keccak256("s2_auth_press"), _govVersion(1),
            two_sigs
        );
        assertTrue(storageContract.is_press_active(POLICY_ADDR, PRESS_ADDR));

        logicContract.revoke_press(
            POLICY_ADDR, PRESS_ADDR,
            bytes32(0), keccak256("s2_revoke"), _govVersion(1),
            two_sigs
        );
        assertFalse(storageContract.is_press_active(POLICY_ADDR, PRESS_ADDR));

        logicContract.rotate_authorizer_key(
            POLICY_ADDR, PRESS_KEY,
            bytes32(0), keccak256("s2_rotate_auth"), _govVersion(1),
            two_sigs
        );

        console.log("[Scenario 2] Governance expansion passed.");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Scenario 3: Logic Upgrade Cycle (Phase 8 Step 8.4)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Logic upgrade lifecycle:
    ///   Deploy → write cards → ProposeLogicUpgrade → reject at 6 days →
    ///   confirm at 7 days → old logic locked out → new logic works →
    ///   storage state preserved → storage invariants hold
    function test_scenario3_logic_upgrade_cycle() public {
        // ── Step 1: Set up initial state ─────────────────────────────────────
        vm.prank(address(logicContract));
        storageContract.set_policy_authorizer_key(POLICY_ADDR, PRESS_KEY);
        vm.prank(address(logicContract));
        storageContract.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0
        );

        // Register a card.
        bytes32 card1 = keccak256("s3_card1");
        logicContract.register_card(
            card1, CID_GENESIS, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), _pressSig(), 0
        );
        assertTrue(storageContract.card_exists(card1), "Card should exist before upgrade");

        // ── Step 2: Propose logic upgrade ────────────────────────────────────
        logicContract.propose_logic_upgrade(
            address(newLogicContract),
            bytes32(0), keccak256("s3_propose"), _govVersion(0),
            governanceSigs
        );

        (address pending_addr,,,) = storageContract.get_pending_logic_upgrade();
        assertEq(pending_addr, address(newLogicContract), "Pending upgrade should be set");

        // ── Step 3: Attempt confirm at 6 days — should fail ──────────────────
        vm.warp(block.timestamp + 6 days);
        uint32 govVer0 = _govVersion(0);
        vm.expectRevert(MockLogic.UpgradeTimelockNotElapsed.selector);
        logicContract.confirm_logic_upgrade(
            address(newLogicContract),
            bytes32(0), keccak256("s3_confirm_early"), govVer0,
            governanceSigs
        );

        // ── Step 4: Confirm at exactly 7 days ────────────────────────────────
        vm.warp(block.timestamp + 1 days); // total = 7 days
        logicContract.confirm_logic_upgrade(
            address(newLogicContract),
            bytes32(0), keccak256("s3_confirm"), _govVersion(0),
            governanceSigs
        );

        // Storage should now point to new logic.
        assertEq(storageContract.get_logic_contract(), address(newLogicContract));

        // ── Step 5: Old logic should be locked out (E-29) ────────────────────
        vm.prank(address(logicContract)); // OLD logic
        vm.expectRevert(MockStorage.CallerNotLogicContract.selector);
        storageContract.set_card_entry(keccak256("post_upgrade"), CID_GENESIS, POLICY_ADDR, PRESS_ADDR, true);

        // ── Step 6: Storage state is preserved ───────────────────────────────
        assertTrue(storageContract.card_exists(card1), "Card should survive the upgrade");
        assertTrue(storageContract.policy_exists(POLICY_ADDR), "Policy should survive the upgrade");
        assertTrue(storageContract.is_press_active(POLICY_ADDR, PRESS_ADDR), "Press should survive the upgrade");

        // ── Step 7: New logic can write ───────────────────────────────────────
        vm.prank(address(newLogicContract));
        storageContract.set_card_entry(keccak256("new_logic_card"), CID_GENESIS, POLICY_ADDR, PRESS_ADDR, true);
        assertTrue(storageContract.card_exists(keccak256("new_logic_card")));

        // ── Step 8: Storage invariants hold for new logic ─────────────────────
        // Cannot unset exists.
        vm.prank(address(newLogicContract));
        vm.expectRevert(MockStorage.CardAlreadyExists.selector);
        storageContract.set_card_entry(card1, CID_GENESIS, POLICY_ADDR, PRESS_ADDR, false);

        console.log("[Scenario 3] Logic upgrade cycle passed.");
    }
}
