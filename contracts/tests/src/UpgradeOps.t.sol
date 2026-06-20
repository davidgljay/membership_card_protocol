// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Upgrade Operations Tests (§4.14)
/// @notice Tests for the 7-day logic upgrade lifecycle:
///         ProposeLogicUpgrade, ConfirmLogicUpgrade, CancelLogicUpgrade.
contract UpgradeOpsTest is Test {
    MockStorage public storage_;
    MockLogic public logic;
    MockLogic public newLogic;
    address public verifierTrue;

    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

    uint256 constant SEVEN_DAYS = 7 days;

    bytes[] governanceSigs;

    function setUp() public {
        verifierTrue = address(new MockVerifierAlwaysTrue());
        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);
        storage_.initialize(address(logic), DEPLOYER_KEY);

        // Deploy the "new" logic contract that will be the upgrade target.
        newLogic = new MockLogic(address(storage_), verifierTrue);

        governanceSigs = new bytes[](1);
        governanceSigs[0] = new bytes(64);
    }

    function _govVersion() internal view returns (uint32 version) {
        (,,,version,) = storage_.get_governance_keyset(0);
    }

    // ── ProposeLogicUpgrade ───────────────────────────────────────────────────

    function test_propose_logic_upgrade_success() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("propose_nonce"), _govVersion(),
            governanceSigs
        );

        (address pending_addr, uint64 pending_at,,) = storage_.get_pending_logic_upgrade();
        assertEq(pending_addr, address(newLogic));
        assertGt(pending_at, 0);
    }

    function test_propose_logic_upgrade_emits_event() public {
        vm.expectEmit(true, false, false, false);
        emit MockLogic.LogicUpgradeProposed(address(newLogic), uint64(block.timestamp), uint64(block.timestamp + SEVEN_DAYS));

        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("propose_ev"), _govVersion(),
            governanceSigs
        );
    }

    function test_propose_logic_upgrade_already_pending_reverts() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("nonce1"), _govVersion(),
            governanceSigs
        );

        MockLogic anotherLogic = new MockLogic(address(storage_), verifierTrue);
        vm.expectRevert(MockLogic.UpgradeAlreadyPending.selector);
        logic.propose_logic_upgrade(
            address(anotherLogic),
            bytes32(0), keccak256("nonce2"), _govVersion(),
            governanceSigs
        );
    }

    // ── ConfirmLogicUpgrade ───────────────────────────────────────────────────

    function test_confirm_logic_upgrade_before_timelock_reverts() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_n"), _govVersion(),
            governanceSigs
        );

        // Only 6 days have elapsed.
        vm.warp(block.timestamp + 6 days);

        vm.expectRevert(MockLogic.UpgradeTimelockNotElapsed.selector);
        logic.confirm_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("conf_n"), _govVersion(),
            governanceSigs
        );
    }

    function test_confirm_logic_upgrade_success_after_7_days() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_n2"), _govVersion(),
            governanceSigs
        );

        // Warp exactly 7 days.
        vm.warp(block.timestamp + SEVEN_DAYS);

        logic.confirm_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("conf_n2"), _govVersion(),
            governanceSigs
        );

        // Storage should now point to the new logic.
        assertEq(storage_.get_logic_contract(), address(newLogic));
    }

    function test_confirm_logic_upgrade_clears_pending() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_n3"), _govVersion(),
            governanceSigs
        );

        vm.warp(block.timestamp + SEVEN_DAYS);
        logic.confirm_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("conf_n3"), _govVersion(),
            governanceSigs
        );

        (address pending_addr,,,) = storage_.get_pending_logic_upgrade();
        assertEq(pending_addr, address(0), "Pending upgrade should be cleared");
    }

    function test_confirm_logic_upgrade_address_mismatch_reverts() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_n4"), _govVersion(),
            governanceSigs
        );

        vm.warp(block.timestamp + SEVEN_DAYS);

        address wrong_addr = address(0xDEAD);
        vm.expectRevert(MockLogic.UpgradeAddressMismatch.selector);
        logic.confirm_logic_upgrade(
            wrong_addr,
            bytes32(0), keccak256("conf_n4"), _govVersion(),
            governanceSigs
        );
    }

    function test_confirm_logic_upgrade_old_logic_locked_out() public {
        // Register a card before the upgrade.
        bytes32 POLICY = keccak256("policy_pre");
        bytes32 CARD = keccak256("card_pre");
        bytes constant KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(POLICY, KEY);
        vm.prank(address(logic));
        storage_.set_press_auth_entry(POLICY, keccak256("press"), KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0);

        // Propose and confirm upgrade.
        logic.propose_logic_upgrade(address(newLogic), bytes32(0), keccak256("prop_n5"), _govVersion(), governanceSigs);
        vm.warp(block.timestamp + SEVEN_DAYS);
        logic.confirm_logic_upgrade(address(newLogic), bytes32(0), keccak256("conf_n5"), _govVersion(), governanceSigs);

        // Old logic contract should be locked out (E-29).
        vm.prank(address(logic)); // OLD logic contract calling storage
        vm.expectRevert(MockStorage.CallerNotLogicContract.selector);
        storage_.set_card_entry(CARD, hex"1234", POLICY, keccak256("press"), true);

        // New logic contract should still work.
        vm.prank(address(newLogic));
        storage_.set_card_entry(CARD, hex"1234", POLICY, keccak256("press"), true);
        assertTrue(storage_.card_exists(CARD));
    }

    function test_storage_state_preserved_after_upgrade() public {
        // Write some state before the upgrade.
        bytes32 POLICY = keccak256("policy_upgrade");
        bytes constant KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
        bytes32 PRESS = keccak256("press_upg");

        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(POLICY, KEY);

        // Upgrade.
        logic.propose_logic_upgrade(address(newLogic), bytes32(0), keccak256("p_n6"), _govVersion(), governanceSigs);
        vm.warp(block.timestamp + SEVEN_DAYS);
        logic.confirm_logic_upgrade(address(newLogic), bytes32(0), keccak256("c_n6"), _govVersion(), governanceSigs);

        // State should be preserved.
        assertTrue(storage_.policy_exists(POLICY), "Policy should survive the upgrade");
    }

    function test_storage_invariants_survive_upgrade() public {
        // Write a card before the upgrade.
        bytes32 CARD = keccak256("inv_card");
        bytes32 POLICY = keccak256("inv_policy");
        bytes constant KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

        vm.prank(address(logic));
        storage_.set_card_entry(CARD, hex"1234", POLICY, keccak256("press"), true);

        // Upgrade.
        logic.propose_logic_upgrade(address(newLogic), bytes32(0), keccak256("p_n7"), _govVersion(), governanceSigs);
        vm.warp(block.timestamp + SEVEN_DAYS);
        logic.confirm_logic_upgrade(address(newLogic), bytes32(0), keccak256("c_n7"), _govVersion(), governanceSigs);

        // Unconditional invariant: new logic cannot unset exists.
        vm.prank(address(newLogic));
        vm.expectRevert(MockStorage.CardAlreadyExists.selector);
        storage_.set_card_entry(CARD, hex"1234", POLICY, keccak256("press"), false);
    }

    // ── CancelLogicUpgrade ────────────────────────────────────────────────────

    function test_cancel_logic_upgrade_success() public {
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_cancel"), _govVersion(),
            governanceSigs
        );

        logic.cancel_logic_upgrade(
            bytes32(0), keccak256("cancel_nonce"), _govVersion(),
            governanceSigs
        );

        (address pending_addr,,,) = storage_.get_pending_logic_upgrade();
        assertEq(pending_addr, address(0), "Pending upgrade should be cleared after cancel");
    }

    function test_cancel_logic_upgrade_no_pending_reverts() public {
        vm.expectRevert(MockLogic.NoUpgradePending.selector);
        logic.cancel_logic_upgrade(bytes32(0), keccak256("cancel_no_pending"), _govVersion(), governanceSigs);
    }

    function test_governance_version_mismatch_invalidates_proposal() public {
        // Propose.
        logic.propose_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("prop_ver"), _govVersion(),
            governanceSigs
        );
        // Note the governance version at proposal time.
        uint32 ver_at_proposal = _govVersion();

        // Rotate governance keys (bumps version).
        bytes memory three_keys = new bytes(192);
        bytes[] memory rotateSigs = new bytes[](1);
        rotateSigs[0] = new bytes(64);
        logic.rotate_governance_keys(
            0, three_keys, 3, 2,
            bytes32(0), keccak256("rot_nonce"), _govVersion(),
            rotateSigs
        );

        // Now governance version has changed. ConfirmLogicUpgrade should fail.
        vm.warp(block.timestamp + SEVEN_DAYS);
        vm.expectRevert(MockLogic.GovernanceVersionMismatch.selector);
        logic.confirm_logic_upgrade(
            address(newLogic),
            bytes32(0), keccak256("conf_ver"), _govVersion(),
            governanceSigs
        );
    }
}
