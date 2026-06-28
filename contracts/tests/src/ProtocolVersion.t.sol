// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Protocol Version Tests (§4.17 GetProtocolVersion / SetProtocolVersion)
/// @notice Tests for the getter default, successful update, governance gating,
///         and event emission for the protocol version field.
contract ProtocolVersionTest is Test {
    MockStorage public storage_;
    MockLogic public logic;
    address public verifierTrue;
    address public verifierFalse;

    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

    bytes[] governanceSigsTrue;

    function setUp() public {
        verifierTrue  = address(new MockVerifierAlwaysTrue());
        verifierFalse = address(new MockVerifierAlwaysFalse());
        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);
        storage_.initialize(address(logic), DEPLOYER_KEY);

        // One dummy governance sig — MockVerifierAlwaysTrue accepts anything.
        governanceSigsTrue = new bytes[](1);
        governanceSigsTrue[0] = new bytes(64);
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    function _govVersion(uint8 body_id) internal view returns (uint32 v) {
        (,,,v,) = storage_.get_governance_keyset(body_id);
    }

    // ── get_protocol_version (getter) ─────────────────────────────────────────

    function test_get_protocol_version_default_is_0_1() public view {
        assertEq(logic.get_protocol_version(), "0.1");
    }

    // ── set_protocol_version (setter) ─────────────────────────────────────────

    function test_set_protocol_version_updates_value() public {
        logic.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_pv1"), _govVersion(0), governanceSigsTrue
        );
        assertEq(logic.get_protocol_version(), "0.2");
    }

    function test_set_protocol_version_can_be_called_multiple_times() public {
        logic.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_pv2a"), _govVersion(0), governanceSigsTrue
        );
        logic.set_protocol_version(
            "1.0",
            bytes32(0), keccak256("nonce_pv2b"), _govVersion(0), governanceSigsTrue
        );
        assertEq(logic.get_protocol_version(), "1.0");
    }

    function test_set_protocol_version_empty_string_reverts() public {
        uint32 gov = _govVersion(0); // evaluate before expectRevert — avoids flagging the staticcall
        vm.expectRevert(MockLogic.InvalidPayload.selector);
        logic.set_protocol_version(
            "",
            bytes32(0), keccak256("nonce_pv3"), gov, governanceSigsTrue
        );
    }

    function test_set_protocol_version_wrong_governance_version_reverts() public {
        uint32 wrong_version = _govVersion(0) + 1;
        vm.expectRevert(MockLogic.GovernanceVersionMismatch.selector);
        logic.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_pv4"), wrong_version, governanceSigsTrue
        );
    }

    function test_set_protocol_version_nonce_reuse_reverts() public {
        bytes32 nonce = keccak256("nonce_reuse_pv");
        logic.set_protocol_version(
            "0.2",
            bytes32(0), nonce, _govVersion(0), governanceSigsTrue
        );
        uint32 gov = _govVersion(0); // evaluate before expectRevert
        vm.expectRevert(MockLogic.NonceReused.selector);
        logic.set_protocol_version(
            "0.3",
            bytes32(0), nonce, gov, governanceSigsTrue
        );
    }

    function test_set_protocol_version_bad_signature_reverts() public {
        MockLogic logicFalse = new MockLogic(address(storage_), verifierFalse);
        // Storage isn't initialized for logicFalse — the quorum check fires first
        // (verifier returns false → InvalidGovernanceSignature before storage access).
        vm.expectRevert(MockLogic.InvalidGovernanceSignature.selector);
        logicFalse.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_pv5"), 0, governanceSigsTrue
        );
    }

    // ── Event emission ────────────────────────────────────────────────────────

    function test_set_protocol_version_emits_event_from_default() public {
        vm.expectEmit(false, false, false, true);
        emit MockLogic.ProtocolVersionUpdated("0.1", "0.2", uint64(block.timestamp));

        logic.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_ev1"), _govVersion(0), governanceSigsTrue
        );
    }

    function test_set_protocol_version_emits_event_from_prior_set_value() public {
        logic.set_protocol_version(
            "0.2",
            bytes32(0), keccak256("nonce_ev2a"), _govVersion(0), governanceSigsTrue
        );

        vm.expectEmit(false, false, false, true);
        emit MockLogic.ProtocolVersionUpdated("0.2", "1.0", uint64(block.timestamp));

        logic.set_protocol_version(
            "1.0",
            bytes32(0), keccak256("nonce_ev2b"), _govVersion(0), governanceSigsTrue
        );
    }
}
