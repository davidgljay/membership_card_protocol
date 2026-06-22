// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title Card Operations Tests (§4.1, §4.2, §4.5, §4.13, §4.15)
/// @notice Unit tests for all card write operations.
///
/// @dev Uses MockVerifierAlwaysTrue to bypass signature verification for most tests,
///      so we can test business logic without generating real secp256r1 signatures.
///      Tests that specifically verify signature rejection use MockVerifierAlwaysFalse.
contract CardOpsTest is Test {
    MockStorage public storage_;
    MockLogic public logic;
    address public verifierTrue;
    address public verifierFalse;

    bytes32 constant CARD_ADDR = keccak256("card1");
    bytes32 constant CARD_ADDR2 = keccak256("card2");
    bytes32 constant POLICY_ADDR = keccak256("policy1");
    bytes32 constant PRESS_ADDR = keccak256("press1");
    bytes constant PRESS_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
    bytes constant CID1 = hex"1220aabbccdd";
    bytes constant CID2 = hex"1220eeff0011";

    function setUp() public {
        verifierTrue = address(new MockVerifierAlwaysTrue());
        verifierFalse = address(new MockVerifierAlwaysFalse());

        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);

        storage_.initialize(address(logic), DEPLOYER_KEY);

        // Bootstrap: set up policy and press authorization.
        _setupPolicyAndPress();
    }

    function _setupPolicyAndPress() internal {
        // Register policy directly (bypassing governance for simplicity in unit tests).
        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(POLICY_ADDR, PRESS_KEY);

        // Authorize press.
        vm.prank(address(logic));
        storage_.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0
        );
    }

    // ── §4.1 RegisterCard ─────────────────────────────────────────────────────

    function test_register_card_success() public {
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        assertTrue(storage_.card_exists(CARD_ADDR));
        (bytes memory stored_cid, bytes32 policy,,,) = storage_.get_card_entry(CARD_ADDR);
        assertEq(keccak256(stored_cid), keccak256(CID1));
        assertEq(policy, POLICY_ADDR);
    }

    function test_register_card_increments_sequence() public {
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 0);
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), 1);
    }

    function test_register_card_duplicate_reverts() public {
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);

        vm.expectRevert(MockLogic.CardAlreadyExists.selector);
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 1);
    }

    function test_register_card_unrecognized_policy_reverts() public {
        bytes32 bad_policy = keccak256("nonexistent_policy");
        vm.expectRevert(MockLogic.UnrecognizedPolicy.selector);
        logic.register_card(CARD_ADDR, CID1, bad_policy, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    function test_register_card_press_not_authorized_reverts() public {
        bytes32 bad_press = keccak256("unauthorized_press");
        vm.expectRevert(MockLogic.PressNotAuthorized.selector);
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, bad_press, bytes32(0), new bytes(64), 0);
    }

    function test_register_card_press_revoked_reverts() public {
        // Revoke the press.
        vm.prank(address(logic));
        storage_.set_press_auth_entry(
            POLICY_ADDR, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, false, 0, uint64(block.timestamp), 9999
        );

        vm.expectRevert(MockLogic.PressRevoked_.selector);
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    function test_register_card_sequence_mismatch_reverts() public {
        vm.expectRevert(MockLogic.SequenceMismatch.selector);
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 5);
    }

    function test_register_card_invalid_signature_reverts() public {
        // Use a logic instance with the always-false verifier.
        MockLogic falseLogic = new MockLogic(address(storage_), verifierFalse);
        vm.prank(address(logic));
        storage_.set_logic_contract(address(falseLogic));

        vm.expectRevert(MockLogic.InvalidPressSignature.selector);
        falseLogic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    function test_register_card_cid_too_long_reverts() public {
        bytes memory long_cid = new bytes(65);
        vm.expectRevert(MockLogic.LogCidTooLong.selector);
        logic.register_card(CARD_ADDR, long_cid, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    // ── §4.2 UpdateCardHead ───────────────────────────────────────────────────

    function _registerCard() internal {
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    function test_update_card_head_success() public {
        _registerCard();
        logic.update_card_head(CARD_ADDR, CID2, CID1, PRESS_ADDR, bytes32(0), new bytes(64), 1);

        (bytes memory stored_cid,,,,) = storage_.get_card_entry(CARD_ADDR);
        assertEq(keccak256(stored_cid), keccak256(CID2));
    }

    function test_update_card_head_card_not_found() public {
        vm.expectRevert(MockLogic.CardNotFound.selector);
        logic.update_card_head(CARD_ADDR, CID2, CID1, PRESS_ADDR, bytes32(0), new bytes(64), 0);
    }

    function test_update_card_head_stale_prev_cid() public {
        _registerCard();
        bytes memory wrong_prev = hex"deadbeef";
        vm.expectRevert(MockLogic.StalePrevCid.selector);
        logic.update_card_head(CARD_ADDR, CID2, wrong_prev, PRESS_ADDR, bytes32(0), new bytes(64), 1);
    }

    function test_update_card_head_sequence_mismatch_after_register() public {
        _registerCard();
        // After register, next_sequence == 1.
        vm.expectRevert(MockLogic.SequenceMismatch.selector);
        logic.update_card_head(CARD_ADDR, CID2, CID1, PRESS_ADDR, bytes32(0), new bytes(64), 0); // wrong: should be 1
    }

    // ── §4.5 ClaimOpenOffer ───────────────────────────────────────────────────

    bytes32 constant OFFER_ID = keccak256("offer1");

    function test_claim_open_offer_success() public {
        logic.claim_open_offer(
            OFFER_ID, type(uint64).max, 0,
            CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), new bytes(64), 0
        );
        assertTrue(storage_.card_exists(CARD_ADDR));
        assertEq(storage_.get_open_offer_count(OFFER_ID), 1);
    }

    function test_claim_open_offer_expired() public {
        // Warp to a known timestamp so we can set a past expiry
        vm.warp(1000);
        uint64 expires = uint64(block.timestamp) - 1; // already expired
        vm.expectRevert(MockLogic.OfferExpired.selector);
        logic.claim_open_offer(
            OFFER_ID, type(uint64).max, expires,
            CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), new bytes(64), 0
        );
    }

    function test_claim_open_offer_at_capacity() public {
        // Set max_acceptances = 1 and pre-fill the count.
        vm.prank(address(logic));
        storage_.set_open_offer_count(OFFER_ID, 1);

        vm.expectRevert(MockLogic.OfferAtCapacity.selector);
        logic.claim_open_offer(
            OFFER_ID, 1, 0,
            CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), new bytes(64), 0
        );
    }

    function test_claim_open_offer_unconstrained_works() public {
        // max_acceptances = type(uint64).max, expires_at = 0 — both unconstrained.
        for (uint64 i = 0; i < 3; i++) {
            bytes32 card = keccak256(abi.encode("offer_card", i));
            logic.claim_open_offer(
                OFFER_ID, type(uint64).max, 0,
                card, CID1, POLICY_ADDR, PRESS_ADDR,
                bytes32(0), new bytes(64), i
            );
        }
        assertEq(storage_.get_open_offer_count(OFFER_ID), 3);
    }

    function test_claim_open_offer_atomicity() public {
        // Offer at capacity — card should NOT be created.
        vm.prank(address(logic));
        storage_.set_open_offer_count(OFFER_ID, 5);

        vm.expectRevert(MockLogic.OfferAtCapacity.selector);
        logic.claim_open_offer(
            OFFER_ID, 5, 0,
            CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR,
            bytes32(0), new bytes(64), 0
        );
        // Card should NOT have been created.
        assertFalse(storage_.card_exists(CARD_ADDR));
        // Count should NOT have changed.
        assertEq(storage_.get_open_offer_count(OFFER_ID), 5);
    }

    // ── §4.13 RegisterAddressForward ──────────────────────────────────────────

    function test_register_address_forward_success() public {
        // Register both cards.
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        logic.register_card(CARD_ADDR2, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 1);

        logic.register_address_forward(CARD_ADDR, CARD_ADDR2, PRESS_ADDR, bytes32(0), new bytes(64));

        (,,, bytes32 fwd,) = storage_.get_card_entry(CARD_ADDR);
        assertEq(fwd, CARD_ADDR2);
    }

    function test_register_address_forward_old_not_found() public {
        logic.register_card(CARD_ADDR2, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        vm.expectRevert(MockLogic.CardNotFound.selector);
        logic.register_address_forward(CARD_ADDR, CARD_ADDR2, PRESS_ADDR, bytes32(0), new bytes(64));
    }

    function test_register_address_forward_new_not_found() public {
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        vm.expectRevert(MockLogic.CardNotFound.selector);
        logic.register_address_forward(CARD_ADDR, CARD_ADDR2, PRESS_ADDR, bytes32(0), new bytes(64));
    }

    function test_register_address_forward_already_set() public {
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);
        logic.register_card(CARD_ADDR2, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 1);
        bytes32 card3 = keccak256("card3");
        logic.register_card(card3, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 2);

        logic.register_address_forward(CARD_ADDR, CARD_ADDR2, PRESS_ADDR, bytes32(0), new bytes(64));

        // Second forward should fail (invariant protection).
        vm.expectRevert(MockLogic.ForwardAlreadySet.selector);
        logic.register_address_forward(CARD_ADDR, card3, PRESS_ADDR, bytes32(0), new bytes(64));
    }

    // ── §4.15 BatchUpdateCardHeads ────────────────────────────────────────────

    function _registerMultipleCards(uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            bytes32 card = keccak256(abi.encode("batch_card", i));
            logic.register_card(card, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), uint64(i));
        }
    }

    function test_batch_update_success_5_cards() public {
        uint256 n = 5;
        _registerMultipleCards(n);

        bytes32[] memory cards = new bytes32[](n);
        bytes[] memory prevs = new bytes[](n);
        bytes[] memory news = new bytes[](n);

        for (uint256 i = 0; i < n; i++) {
            cards[i] = keccak256(abi.encode("batch_card", i));
            prevs[i] = CID1;
            news[i] = CID2;
        }

        uint64 seq_before = storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR);
        logic.batch_update_card_heads(
            POLICY_ADDR, PRESS_ADDR, cards, prevs, news,
            bytes32(0), new bytes(64), seq_before
        );

        // Sequence should increment by exactly 1.
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), seq_before + 1);

        // All cards should be updated.
        for (uint256 i = 0; i < n; i++) {
            (bytes memory cid,,,,) = storage_.get_card_entry(cards[i]);
            assertEq(keccak256(cid), keccak256(CID2));
        }
    }

    function test_batch_update_empty_batch_reverts() public {
        bytes32[] memory cards = new bytes32[](0);
        bytes[] memory prevs = new bytes[](0);
        bytes[] memory news = new bytes[](0);

        vm.expectRevert(MockLogic.BatchSizeInvalid.selector);
        logic.batch_update_card_heads(POLICY_ADDR, PRESS_ADDR, cards, prevs, news, bytes32(0), new bytes(64), 0);
    }

    function test_batch_update_duplicate_card_reverts() public {
        _registerMultipleCards(2);
        bytes32[] memory cards = new bytes32[](2);
        bytes[] memory prevs = new bytes[](2);
        bytes[] memory news = new bytes[](2);

        cards[0] = keccak256(abi.encode("batch_card", 0));
        cards[1] = cards[0]; // DUPLICATE
        prevs[0] = prevs[1] = CID1;
        news[0] = news[1] = CID2;

        vm.expectRevert(MockLogic.BatchItemInvalid.selector);
        logic.batch_update_card_heads(POLICY_ADDR, PRESS_ADDR, cards, prevs, news, bytes32(0), new bytes(64), 2);
    }

    function test_batch_update_cross_policy_reverts() public {
        // Register a card under policy2 (different policy).
        bytes32 policy2 = keccak256("policy2");
        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(policy2, PRESS_KEY);
        vm.prank(address(logic));
        storage_.set_press_auth_entry(policy2, PRESS_ADDR, PRESS_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0);

        bytes32 card2 = keccak256("policy2_card");
        // Register card under policy2 directly.
        vm.prank(address(logic));
        storage_.set_card_entry(card2, CID1, policy2, PRESS_ADDR, true);

        // Also register card under policy1.
        logic.register_card(CARD_ADDR, CID1, POLICY_ADDR, PRESS_ADDR, bytes32(0), new bytes(64), 0);

        bytes32[] memory cards = new bytes32[](2);
        bytes[] memory prevs = new bytes[](2);
        bytes[] memory news = new bytes[](2);
        cards[0] = CARD_ADDR;
        cards[1] = card2; // belongs to policy2
        prevs[0] = prevs[1] = CID1;
        news[0] = news[1] = CID2;

        vm.expectRevert(MockLogic.BatchItemInvalid.selector);
        logic.batch_update_card_heads(POLICY_ADDR, PRESS_ADDR, cards, prevs, news, bytes32(0), new bytes(64), 1);
    }

    function test_batch_update_stale_prev_cid_reverts() public {
        _registerMultipleCards(2);
        bytes32[] memory cards = new bytes32[](2);
        bytes[] memory prevs = new bytes[](2);
        bytes[] memory news = new bytes[](2);

        cards[0] = keccak256(abi.encode("batch_card", 0));
        cards[1] = keccak256(abi.encode("batch_card", 1));
        prevs[0] = CID1;
        prevs[1] = hex"deadbeef"; // WRONG prev_log_cid
        news[0] = news[1] = CID2;

        vm.expectRevert(MockLogic.StalePrevCid.selector);
        logic.batch_update_card_heads(POLICY_ADDR, PRESS_ADDR, cards, prevs, news, bytes32(0), new bytes(64), 2);

        // Neither card should have been updated (atomicity).
        (bytes memory cid0,,,,) = storage_.get_card_entry(cards[0]);
        assertEq(keccak256(cid0), keccak256(CID1), "First card should NOT have been updated");
    }

    function test_batch_update_sequence_increments_by_1() public {
        uint256 n = 100; // MAX_BATCH_SIZE
        bytes32[] memory cards = new bytes32[](n);
        bytes[] memory prevs = new bytes[](n);
        bytes[] memory news = new bytes[](n);

        for (uint256 i = 0; i < n; i++) {
            bytes32 card = keccak256(abi.encode("max_batch", i));
            cards[i] = card;
            vm.prank(address(logic));
            storage_.set_card_entry(card, CID1, POLICY_ADDR, PRESS_ADDR, true);
            prevs[i] = CID1;
            news[i] = CID2;
        }

        uint64 seq_before = storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR);
        logic.batch_update_card_heads(POLICY_ADDR, PRESS_ADDR, cards, prevs, news, bytes32(0), new bytes(64), seq_before);

        // Must be exactly 1, not n.
        assertEq(storage_.get_next_sequence(POLICY_ADDR, PRESS_ADDR), seq_before + 1);
    }
}
