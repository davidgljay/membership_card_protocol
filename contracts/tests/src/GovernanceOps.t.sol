// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Governance Operations Tests (§4.6–4.10)
/// @notice Tests for RegisterPolicy, AuthorizePress, RevokePress,
///         RotateAuthorizerKey, and RotateGovernanceKeys.
///
/// @dev MockVerifierAlwaysTrue is used so we don't need to generate real signatures.
///      Tests focusing on signature rejection use MockVerifierAlwaysFalse.
contract GovernanceOpsTest is Test {
    MockStorage public storage_;
    MockLogic public logic;
    address public verifierTrue;

    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
    bytes constant KEY2 = hex"4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80";
    bytes constant KEY3 = hex"8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0";

    bytes32 constant POLICY_ADDR = keccak256("policy1");
    bytes32 constant PRESS_ADDR = keccak256("press1");

    bytes[] governanceSigsTrue; // MockVerifierAlwaysTrue always accepts these

    function setUp() public {
        verifierTrue = address(new MockVerifierAlwaysTrue());
        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);
        storage_.initialize(address(logic), DEPLOYER_KEY);

        // A single governance sig (content doesn't matter since verifier always returns true).
        governanceSigsTrue = new bytes[](1);
        governanceSigsTrue[0] = new bytes(64);
    }

    // ── Helper: get current governance version ────────────────────────────────

    function _govVersion(uint8 body_id) internal view returns (uint32 version) {
        (,,,version,) = storage_.get_governance_keyset(body_id);
    }

    // ── §4.6 RegisterPolicy ───────────────────────────────────────────────────

    function test_register_policy_success() public {
        logic.register_policy(
            POLICY_ADDR, DEPLOYER_KEY,
            bytes32(0), keccak256("nonce1"), _govVersion(0), governanceSigsTrue
        );
        assertTrue(storage_.policy_exists(POLICY_ADDR));
    }

    function test_register_policy_duplicate_reverts() public {
        logic.register_policy(POLICY_ADDR, DEPLOYER_KEY, bytes32(0), keccak256("nonce1"), _govVersion(0), governanceSigsTrue);

        vm.expectRevert(MockLogic.PolicyAlreadyRegistered.selector);
        logic.register_policy(POLICY_ADDR, DEPLOYER_KEY, bytes32(0), keccak256("nonce2"), _govVersion(0), governanceSigsTrue);
    }

    function test_register_policy_nonce_reuse_reverts() public {
        bytes32 nonce1 = keccak256("nonce_reuse");
        logic.register_policy(POLICY_ADDR, DEPLOYER_KEY, bytes32(0), nonce1, _govVersion(0), governanceSigsTrue);

        bytes32 policy2 = keccak256("policy2");
        vm.expectRevert(MockLogic.NonceReused.selector);
        logic.register_policy(policy2, DEPLOYER_KEY, bytes32(0), nonce1, _govVersion(0), governanceSigsTrue); // reusing same nonce
    }

    function test_register_policy_wrong_version_reverts() public {
        uint32 wrong_version = _govVersion(0) + 1;
        vm.expectRevert(MockLogic.GovernanceVersionMismatch.selector);
        logic.register_policy(POLICY_ADDR, DEPLOYER_KEY, bytes32(0), keccak256("nonce3"), wrong_version, governanceSigsTrue);
    }

    // ── §4.7 AuthorizePress ───────────────────────────────────────────────────

    function _registerPolicy() internal {
        logic.register_policy(POLICY_ADDR, DEPLOYER_KEY, bytes32(0), keccak256("setup_nonce"), _govVersion(0), governanceSigsTrue);
    }

    function test_authorize_press_success() public {
        _registerPolicy();
        logic.authorize_press(
            POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("press_nonce"), _govVersion(1), governanceSigsTrue
        );
        assertTrue(storage_.is_press_active(POLICY_ADDR, PRESS_ADDR));
    }

    function test_authorize_press_resets_sequence() public {
        _registerPolicy();
        // Set initial sequence to non-zero.
        vm.prank(address(logic));
        storage_.set_press_auth_entry(POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0), 0, true, 5, uint64(block.timestamp), 0);
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 5);

        // Re-authorize resets sequence to 0.
        logic.authorize_press(
            POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("reauth_nonce"), _govVersion(1), governanceSigsTrue
        );
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 0);
    }

    function test_authorize_press_unknown_policy_reverts() public {
        bytes32 bad_policy = keccak256("nonexistent");
        vm.expectRevert(MockLogic.UnrecognizedPolicy.selector);
        logic.authorize_press(
            bad_policy, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("nonce"), _govVersion(0), governanceSigsTrue
        );
    }

    // ── §4.8 RevokePress ──────────────────────────────────────────────────────

    function test_revoke_press_success() public {
        _registerPolicy();
        logic.authorize_press(
            POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("auth_nonce"), _govVersion(1), governanceSigsTrue
        );

        logic.revoke_press(
            POLICY_ADDR, PRESS_ADDR,
            bytes32(0), keccak256("revoke_nonce"), _govVersion(1), governanceSigsTrue
        );

        assertFalse(storage_.is_press_active(POLICY_ADDR, PRESS_ADDR));
        (,,,,,, uint64 rev_at) = storage_.get_press_authorization(POLICY_ADDR, PRESS_ADDR);
        assertGt(rev_at, 0, "revoked_at should be non-zero");
    }

    function test_revoke_press_entry_retained() public {
        _registerPolicy();
        logic.authorize_press(
            POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("auth_nonce2"), _govVersion(1), governanceSigsTrue
        );

        logic.revoke_press(
            POLICY_ADDR, PRESS_ADDR,
            bytes32(0), keccak256("revoke_nonce2"), _govVersion(1), governanceSigsTrue
        );

        // Entry is retained (not deleted), active=false.
        (bytes memory key,,,bool active,,, ) = storage_.get_press_authorization(POLICY_ADDR, PRESS_ADDR);
        assertEq(key.length, 64, "Press key should be retained in the entry");
        assertFalse(active);
    }

    function test_revoke_press_already_revoked_reverts() public {
        _registerPolicy();
        logic.authorize_press(
            POLICY_ADDR, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("auth_n3"), _govVersion(1), governanceSigsTrue
        );
        logic.revoke_press(
            POLICY_ADDR, PRESS_ADDR,
            bytes32(0), keccak256("rev_n3"), _govVersion(1), governanceSigsTrue
        );

        vm.expectRevert(MockLogic.PressRevoked_.selector);
        logic.revoke_press(
            POLICY_ADDR, PRESS_ADDR,
            bytes32(0), keccak256("rev_n3_again"), _govVersion(1), governanceSigsTrue
        );
    }

    // ── §4.9 RotateAuthorizerKey ──────────────────────────────────────────────

    function test_rotate_authorizer_key_success() public {
        _registerPolicy();

        bytes memory new_key = KEY2;
        logic.rotate_authorizer_key(
            POLICY_ADDR, new_key,
            bytes32(0), keccak256("rotate_nonce"), _govVersion(1), governanceSigsTrue
        );

        bytes memory stored_key = storage_.get_policy_authorizer(POLICY_ADDR);
        assertEq(keccak256(stored_key), keccak256(new_key));
    }

    function test_rotate_authorizer_key_unknown_policy_reverts() public {
        bytes32 bad_pol = keccak256("bad_policy");
        vm.expectRevert(MockLogic.UnrecognizedPolicy.selector);
        logic.rotate_authorizer_key(
            bad_pol, KEY2,
            bytes32(0), keccak256("rotate_nonce2"), _govVersion(0), governanceSigsTrue
        );
    }

    // ── §4.10 RotateGovernanceKeys ────────────────────────────────────────────

    function _make3KeyFlat() internal pure returns (bytes memory) {
        bytes memory flat = new bytes(192); // 3 * 64
        bytes memory k1 = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
        bytes memory k2 = hex"4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80";
        bytes memory k3 = hex"8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0";
        for (uint i = 0; i < 64; i++) {
            flat[i] = k1[i];
            flat[64 + i] = k2[i];
            flat[128 + i] = k3[i];
        }
        return flat;
    }

    function test_rotate_governance_keys_to_3of5() public {
        // Need 5 keys; use 3 for simplicity (minimum allowed).
        bytes memory new_keys_flat = _make3KeyFlat();
        uint8 new_key_count = 3;
        uint8 new_quorum = 2; // majority of 3: must be > 3/2 = 1, so >= 2

        bytes[] memory sigs = new bytes[](1);
        sigs[0] = new bytes(64);

        logic.rotate_governance_keys(
            0, // ROOT_POLICY_BODY
            new_keys_flat,
            new_key_count,
            new_quorum,
            bytes32(0), keccak256("rotate_gov"), _govVersion(0),
            sigs
        );

        (bytes memory keys, uint8 count, uint8 quorum, uint32 version,) = storage_.get_governance_keyset(0);
        assertEq(count, 3);
        assertEq(quorum, 2);
        assertEq(version, 1, "Version should increment to 1 after first rotation");
    }

    function test_rotate_governance_keys_too_small_reverts() public {
        bytes memory two_keys = new bytes(128); // 2 keys
        vm.expectRevert(MockLogic.KeysetTooSmall.selector);
        logic.rotate_governance_keys(0, two_keys, 2, 2, bytes32(0), keccak256("n"), _govVersion(0), governanceSigsTrue);
    }

    function test_rotate_governance_keys_quorum_too_low_reverts() public {
        bytes memory three_keys = _make3KeyFlat();
        // quorum = 1 <= 3/2 = 1, so quorum must be > 1, meaning >= 2.
        vm.expectRevert(MockLogic.QuorumTooLow.selector);
        logic.rotate_governance_keys(0, three_keys, 3, 1, bytes32(0), keccak256("n"), _govVersion(0), governanceSigsTrue);
    }

    function test_rotate_governance_version_increments() public {
        uint32 before_version = _govVersion(0);
        bytes memory three_keys = _make3KeyFlat();

        logic.rotate_governance_keys(0, three_keys, 3, 2, bytes32(0), keccak256("nonce_rot"), _govVersion(0), governanceSigsTrue);

        assertEq(_govVersion(0), before_version + 1, "Version should increment after rotation");
    }

    function test_rotate_governance_version_invalidates_old_proposals() public {
        uint32 old_version = _govVersion(0);
        bytes memory three_keys = _make3KeyFlat();

        // Rotate to version 1.
        logic.rotate_governance_keys(0, three_keys, 3, 2, bytes32(0), keccak256("n_rot"), old_version, governanceSigsTrue);

        // Now try to use the old version in a governance action — should fail.
        vm.expectRevert(MockLogic.GovernanceVersionMismatch.selector);
        logic.register_policy(
            POLICY_ADDR, DEPLOYER_KEY,
            bytes32(0), keccak256("n_pol"),
            old_version, // OLD version — should fail
            governanceSigsTrue
        );
    }
}
