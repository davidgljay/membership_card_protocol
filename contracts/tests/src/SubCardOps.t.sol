// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Sub-Card Operations Tests (§4.3, §4.4)
///
/// @dev These tests cover RegisterSubCard and DeregisterSubCard for non-DNS-admin
///      master cards. The new `admin_secp_payload` and `admin_secp_signature` parameters
///      are passed as empty (new bytes(0)) since none of the master cards in this suite
///      have DnsAdminCardKeys entries.
///
///      Tests for the admin secp256r1 check (§4.3 precondition 5) — which fires when the
///      master card IS a registered DNS admin card — live in DnsOps.t.sol:
///        test_register_sub_card_dns_admin_requires_secp_sig
///        test_register_sub_card_dns_admin_valid_secp_sig_succeeds
///        test_register_sub_card_non_dns_admin_no_secp_sig_succeeds
///        test_register_sub_card_non_dns_admin_spurious_secp_sig_reverts
contract SubCardOpsTest is Test {
    MockStorage public storage_;
    MockLogic public logic;
    address public verifierTrue;

    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";

    bytes32 constant MASTER_CARD = keccak256("master");
    bytes32 constant SUB_CARD = keccak256("sub");
    bytes32 constant POLICY = keccak256("policy");
    bytes32 constant PRESS = keccak256("press");
    bytes constant CID1 = hex"1220aabbccdd";
    bytes constant SUB_DOC_CID = hex"1220001122";

    function setUp() public {
        verifierTrue = address(new MockVerifierAlwaysTrue());
        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);
        storage_.initialize(address(logic), DEPLOYER_KEY);

        // Set up policy and press.
        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(POLICY, DEPLOYER_KEY);
        vm.prank(address(logic));
        storage_.set_press_auth_entry(POLICY, PRESS, DEPLOYER_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0);

        // Register master card.
        vm.prank(address(logic));
        storage_.set_card_entry(MASTER_CARD, CID1, POLICY, PRESS, true);
    }

    // ── §4.3 RegisterSubCard ──────────────────────────────────────────────────

    function test_register_sub_card_success() public {
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );

        (bytes32 master,,,bool active,,) = storage_.get_sub_card_entry(SUB_CARD);
        assertEq(master, MASTER_CARD);
        assertTrue(active);
    }

    function test_register_sub_card_master_not_found() public {
        bytes32 bad_master = keccak256("nonexistent_master");
        vm.expectRevert(MockLogic.CardNotFound.selector);
        logic.register_sub_card(
            SUB_CARD, bad_master, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );
    }

    function test_register_sub_card_stale_log_head_reverts() public {
        bytes memory wrong_head = hex"deadbeef";
        vm.expectRevert(MockLogic.StaleRegistrationLogHead.selector);
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, wrong_head, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );
    }

    function test_register_sub_card_already_active_reverts() public {
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );

        vm.expectRevert(MockLogic.SubCardAlreadyActive.selector);
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 1,
            new bytes(0), new bytes(0)
        );
    }

    function test_register_sub_card_doc_cid_too_long_reverts() public {
        bytes memory long_cid = new bytes(65); // > MAX_CID_LEN
        vm.expectRevert(MockLogic.LogCidTooLong.selector);
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, long_cid,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );
    }

    function test_register_sub_card_increments_sequence() public {
        assertEq(storage_.get_next_sequence(POLICY, PRESS), 0);
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );
        assertEq(storage_.get_next_sequence(POLICY, PRESS), 1);
    }

    // ── §4.4 DeregisterSubCard ────────────────────────────────────────────────

    function _registerSubCard() internal {
        logic.register_sub_card(
            SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID,
            PRESS, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );
    }

    function test_deregister_sub_card_success() public {
        _registerSubCard();
        logic.deregister_sub_card(SUB_CARD, PRESS, bytes32(0), new bytes(64), 1);

        (,,,bool active,, uint64 dereg_at) = storage_.get_sub_card_entry(SUB_CARD);
        assertFalse(active);
        assertGt(dereg_at, 0, "deregistered_at should be set");
    }

    function test_deregister_sub_card_entry_retained() public {
        _registerSubCard();
        logic.deregister_sub_card(SUB_CARD, PRESS, bytes32(0), new bytes(64), 1);

        // Entry is retained with master_card_address still set.
        (bytes32 master,,,,, ) = storage_.get_sub_card_entry(SUB_CARD);
        assertEq(master, MASTER_CARD, "Master card address should be retained");
    }

    function test_deregister_sub_card_not_found_reverts() public {
        bytes32 unknown = keccak256("unknown_sub");
        vm.expectRevert(MockLogic.SubCardNotFound.selector);
        logic.deregister_sub_card(unknown, PRESS, bytes32(0), new bytes(64), 0);
    }

    function test_deregister_already_deregistered_reverts() public {
        _registerSubCard();
        logic.deregister_sub_card(SUB_CARD, PRESS, bytes32(0), new bytes(64), 1);

        vm.expectRevert(MockLogic.SubCardNotFound.selector);
        logic.deregister_sub_card(SUB_CARD, PRESS, bytes32(0), new bytes(64), 2);
    }

    function test_deregistered_at_invariant_holds() public {
        _registerSubCard();
        logic.deregister_sub_card(SUB_CARD, PRESS, bytes32(0), new bytes(64), 1);

        (,,,, uint64 reg_at, uint64 dereg_at) = storage_.get_sub_card_entry(SUB_CARD);
        uint64 original_dereg = dereg_at;

        // Try to zero out deregistered_at — should fail (storage invariant).
        vm.prank(address(logic));
        vm.expectRevert(MockStorage.DeregisteredAtImmutable.selector);
        storage_.set_sub_card_entry(SUB_CARD, MASTER_CARD, CID1, SUB_DOC_CID, true, reg_at, 0);
    }
}
