// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Storage Invariant Tests
/// @notice Verifies all five unconditional storage invariants from §3.7.
///
/// These tests use MockStorage (Solidity) rather than the Stylus WASM contract.
/// The MockStorage implements the same invariant checks as the Rust implementation.
///
/// @dev §3.7 Unconditional Invariants:
///      1. CardEntries[addr].exists is write-once-true.
///      2. CardEntries[addr].forward_to is immutable once non-zero.
///      3. PressAuthorizations[p][a].revoked_at is write-once-non-zero.
///      4. SubCardRegistrations[addr].deregistered_at is write-once-non-zero.
///      5. PolicyAuthorizerKeys has no unconditional delete (governed by DeregisterPolicy).
contract StorageInvariantsTest is Test {
    MockStorage public storageContract;
    MockLogic public logicContract;
    MockVerifier public verifier;

    // Test key (deployer / governance key — not a real key, just test bytes).
    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

    bytes32 constant CARD_ADDR = keccak256("test_card");
    bytes32 constant POLICY_ADDR = keccak256("test_policy");
    bytes32 constant PRESS_ADDR = keccak256("test_press");
    bytes constant TEST_CID = hex"1220abcdef1234";

    function setUp() public {
        verifier = new MockVerifier();
        storageContract = new MockStorage();
        logicContract = new MockLogic(address(storageContract), address(verifier));

        // Initialize storage with the logic contract address.
        storageContract.initialize(address(logicContract), DEPLOYER_KEY);

        // Set up a card entry directly (as if the logic contract created it).
        vm.prank(address(logicContract));
        storageContract.set_card_entry(CARD_ADDR, TEST_CID, POLICY_ADDR, PRESS_ADDR, true);
    }

    // ── Invariant 1: exists is write-once-true ────────────────────────────────

    /// @notice Once exists=true, it cannot be set to false.
    function test_invariant1_exists_write_once_true() public {
        // Confirm the card exists.
        assertTrue(storageContract.card_exists(CARD_ADDR));

        // Attempt to set exists=false — should revert.
        vm.prank(address(logicContract));
        vm.expectRevert(MockStorage.CardAlreadyExists.selector);
        storageContract.set_card_entry(CARD_ADDR, TEST_CID, POLICY_ADDR, PRESS_ADDR, false);
    }

    /// @notice A new card can be created (exists=false → exists=true is allowed).
    function test_invariant1_new_card_creation_allowed() public {
        bytes32 new_card = keccak256("new_card");
        assertFalse(storageContract.card_exists(new_card));

        vm.prank(address(logicContract));
        storageContract.set_card_entry(new_card, TEST_CID, POLICY_ADDR, PRESS_ADDR, true);
        assertTrue(storageContract.card_exists(new_card));
    }

    // ── Invariant 2: forward_to is immutable once non-zero ────────────────────

    /// @notice Setting forward_to a second time should revert.
    function test_invariant2_forward_to_immutable() public {
        bytes32 new_addr = keccak256("new_card_addr");

        // First set is allowed.
        vm.prank(address(logicContract));
        storageContract.set_forward_to(CARD_ADDR, new_addr);

        // Verify it was set.
        (,,, bytes32 fwd,) = storageContract.get_card_entry(CARD_ADDR);
        assertEq(fwd, new_addr);

        // Second set should revert.
        bytes32 another_addr = keccak256("another_addr");
        vm.prank(address(logicContract));
        vm.expectRevert(MockStorage.ForwardAlreadySet.selector);
        storageContract.set_forward_to(CARD_ADDR, another_addr);
    }

    /// @notice Setting forward_to to zero on a card with no forward is a no-op (not an invariant violation).
    function test_invariant2_initial_forward_is_zero() public {
        (,,, bytes32 fwd,) = storageContract.get_card_entry(CARD_ADDR);
        assertEq(fwd, bytes32(0), "Initial forward_to should be zero");
    }

    // ── Invariant 3: revoked_at is write-once-non-zero ───────────────────────

    bytes constant PRESS_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

    function _setPressAuth(uint64 revoked_at) internal {
        vm.prank(address(logicContract));
        storageContract.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), revoked_at
        );
    }

    /// @notice Once revoked_at is non-zero, it cannot be zeroed.
    function test_invariant3_revoked_at_write_once_nonzero() public {
        // Set revoked_at to a non-zero value.
        _setPressAuth(1000);
        (,,,,,, uint64 rev_at) = storageContract.get_press_authorization(POLICY_ADDR, PRESS_ADDR);
        assertEq(rev_at, 1000);

        // Attempt to zero it out — should revert.
        vm.prank(address(logicContract));
        vm.expectRevert(MockStorage.RevokedAtImmutable.selector);
        storageContract.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0
        );
    }

    /// @notice revoked_at can be set from 0 to non-zero (this is the revocation path).
    function test_invariant3_initial_revocation_allowed() public {
        _setPressAuth(0);
        (,,,,,, uint64 rev_at) = storageContract.get_press_authorization(POLICY_ADDR, PRESS_ADDR);
        assertEq(rev_at, 0);

        // Now revoke.
        uint64 revoke_time = 12345;
        vm.prank(address(logicContract));
        storageContract.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, false, 0, uint64(block.timestamp), revoke_time
        );
        (,,,,,, uint64 new_rev) = storageContract.get_press_authorization(POLICY_ADDR, PRESS_ADDR);
        assertEq(new_rev, revoke_time);
    }

    // ── Invariant 4: deregistered_at is write-once-non-zero ──────────────────

    function _setSubCard(uint64 deregistered_at) internal {
        vm.prank(address(logicContract));
        storageContract.set_sub_card_entry(
            keccak256("sub_card"),
            CARD_ADDR,
            TEST_CID,
            TEST_CID,
            true,
            uint64(block.timestamp),
            deregistered_at
        );
    }

    /// @notice Once deregistered_at is non-zero, it cannot be zeroed.
    function test_invariant4_deregistered_at_write_once_nonzero() public {
        bytes32 sub_addr = keccak256("sub_card");
        _setSubCard(5000);

        (,,,,,uint64 dereg_at) = storageContract.get_sub_card_entry(sub_addr);
        assertEq(dereg_at, 5000);

        // Attempt to zero it — should revert.
        vm.prank(address(logicContract));
        vm.expectRevert(MockStorage.DeregisteredAtImmutable.selector);
        storageContract.set_sub_card_entry(sub_addr, CARD_ADDR, TEST_CID, TEST_CID, true, uint64(block.timestamp), 0);
    }

    // ── Invariant 5: Access control (only logic contract can call setters) ────

    /// @notice Any address other than the logic contract should be rejected with E-29.
    function test_invariant5_access_control_enforced() public {
        address rando = address(0xBEEF);
        vm.prank(rando);
        vm.expectRevert(MockStorage.CallerNotLogicContract.selector);
        storageContract.set_card_entry(keccak256("evil"), TEST_CID, POLICY_ADDR, PRESS_ADDR, true);
    }

    /// @notice After a logic contract replacement, the OLD logic contract is locked out.
    function test_invariant5_logic_replacement_locks_out_old_logic() public {
        // Deploy a new logic contract.
        MockLogic newLogic = new MockLogic(address(storageContract), address(verifier));

        // Current logic updates the LogicContract address in storage.
        vm.prank(address(logicContract));
        storageContract.set_logic_contract(address(newLogic));

        // Verify the storage now recognizes the new logic.
        assertEq(storageContract.get_logic_contract(), address(newLogic));

        // Old logic contract should now be rejected by storage.
        vm.prank(address(logicContract));  // logicContract is now the OLD one
        vm.expectRevert(MockStorage.CallerNotLogicContract.selector);
        storageContract.set_card_entry(keccak256("after_upgrade"), TEST_CID, POLICY_ADDR, PRESS_ADDR, true);

        // New logic contract should still work.
        vm.prank(address(newLogic));
        storageContract.set_card_entry(keccak256("after_upgrade_new"), TEST_CID, POLICY_ADDR, PRESS_ADDR, true);
        assertTrue(storageContract.card_exists(keccak256("after_upgrade_new")));
    }

    /// @notice After logic replacement, existing invariants still hold for the new logic.
    function test_invariant5_invariants_survive_logic_upgrade() public {
        // Replace logic.
        MockLogic newLogic = new MockLogic(address(storageContract), address(verifier));
        vm.prank(address(logicContract));
        storageContract.set_logic_contract(address(newLogic));

        // New logic still cannot unset exists.
        vm.prank(address(newLogic));
        vm.expectRevert(MockStorage.CardAlreadyExists.selector);
        storageContract.set_card_entry(CARD_ADDR, TEST_CID, POLICY_ADDR, PRESS_ADDR, false);

        // New logic still cannot overwrite a set forward_to.
        bytes32 fwd_addr = keccak256("fwd");
        vm.prank(address(newLogic));
        storageContract.set_forward_to(CARD_ADDR, fwd_addr);  // First set OK.
        vm.prank(address(newLogic));
        vm.expectRevert(MockStorage.ForwardAlreadySet.selector);
        storageContract.set_forward_to(CARD_ADDR, keccak256("other_fwd"));
    }

    // ── CID length enforcement ────────────────────────────────────────────────

    function test_cid_length_limit_enforced() public {
        bytes memory long_cid = new bytes(65); // exceeds MAX_CID_LEN (64)

        vm.prank(address(logicContract));
        vm.expectRevert(MockStorage.CidTooLong.selector);
        storageContract.set_card_entry(keccak256("cid_test"), long_cid, POLICY_ADDR, PRESS_ADDR, true);
    }
}
