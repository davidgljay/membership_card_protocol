// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./mocks/MockStorage.sol";
import "./mocks/MockLogic.sol";
import "./mocks/MockVerifier.sol";

/// @title DNS Operations Tests (§4.17–4.24)
/// @notice Tests for RegisterDomain, DeregisterDomain, SetPolicyAddress,
///         RemovePolicyAddress, ClearDomainEntries, FlagDomainFraudRisk,
///         GovernanceSetPolicyAddress, SetDnsGovernancePolicyAddress,
///         and DnsGovernanceBody quorum enforcement.
///
/// @dev MockVerifierAlwaysTrue is used for tests that don't exercise signature
///      rejection paths. MockVerifierAlwaysFalse is used for signature failure tests.
///
/// @dev Governance payload_hash is bytes32(0) throughout (MockVerifier ignores content).
///      Nonce keys are distinct keccak256 hashes to prevent nonce reuse.
contract DnsOpsTest is Test {
    MockStorage public storage_;
    MockLogic   public logic;
    address     public verifierTrue;

    // ── Fixed test keys ────────────────────────────────────────────────────────

    bytes constant DEPLOYER_KEY = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40";
    bytes constant ADMIN_SECP_KEY = hex"4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80";
    bytes constant PRESS_KEY = hex"8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0";

    // ── Fixed test addresses ───────────────────────────────────────────────────

    bytes32 constant DNS_POLICY   = keccak256("dns_governance_policy");
    bytes32 constant ADMIN_CARD   = keccak256("admin_card");
    bytes32 constant PRESS_ADDR   = keccak256("press");
    bytes32 constant POLICY_CARD  = keccak256("policy_card");
    bytes32 constant SUB_CARD     = keccak256("sub_card");

    bytes   constant CID1 = hex"1220aabbccdd";

    // ── Test domains / paths ───────────────────────────────────────────────────

    bytes constant DOMAIN = bytes("example.com");
    bytes constant PATH   = bytes("staff/reporter");
    bytes constant PATH2  = bytes("volunteers/lead");

    // ── Governance helpers ─────────────────────────────────────────────────────

    bytes[] govSigsTrue;

    function _dnsGovVersion() internal view returns (uint32 v) {
        (,,,v,) = storage_.get_governance_keyset(2); // DnsGovernanceBody = 2
    }

    function _rootGovVersion() internal view returns (uint32 v) {
        (,,,v,) = storage_.get_governance_keyset(0);
    }

    function _pressGovVersion() internal view returns (uint32 v) {
        (,,,v,) = storage_.get_governance_keyset(1);
    }

    // ── Setup ──────────────────────────────────────────────────────────────────

    function setUp() public {
        verifierTrue = address(new MockVerifierAlwaysTrue());
        storage_ = new MockStorage();
        logic = new MockLogic(address(storage_), verifierTrue);
        storage_.initialize(address(logic), DEPLOYER_KEY);

        govSigsTrue = new bytes[](1);
        govSigsTrue[0] = new bytes(64);

        // Register DNS governance policy via RootPolicyBody.
        logic.register_policy(
            DNS_POLICY, DEPLOYER_KEY,
            bytes32(0), keccak256("setup_dns_policy"), _rootGovVersion(), govSigsTrue
        );

        // Set DnsGovernancePolicyAddress (§4.24 path but direct storage write for setup).
        vm.prank(address(logic));
        storage_.set_dns_governance_policy_address(DNS_POLICY);

        // Register press under DNS governance policy via PressRegistryBody.
        logic.authorize_press(
            DNS_POLICY, PRESS_ADDR, DEPLOYER_KEY, bytes32(0),
            bytes32(0), keccak256("setup_press"), _pressGovVersion(), govSigsTrue
        );

        // Register admin card under DNS governance policy.
        vm.prank(address(logic));
        storage_.set_card_entry(ADMIN_CARD, CID1, DNS_POLICY, PRESS_ADDR, true);

        // Register a policy card (the card pointed to by SetPolicyAddress).
        vm.prank(address(logic));
        storage_.set_card_entry(POLICY_CARD, CID1, DNS_POLICY, PRESS_ADDR, true);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.17 RegisterDomain
    // ══════════════════════════════════════════════════════════════════════════

    function test_register_domain_success() public {
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n1"), _dnsGovVersion(), govSigsTrue
        );

        (bytes32 admin,,,, bool exists) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(admin, ADMIN_CARD);
        assertTrue(exists);
    }

    function test_register_domain_stores_admin_secp_key() public {
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n2"), _dnsGovVersion(), govSigsTrue
        );

        bytes memory stored_key = storage_.get_dns_admin_card_key(ADMIN_CARD);
        assertEq(keccak256(stored_key), keccak256(ADMIN_SECP_KEY));
    }

    function test_register_domain_emits_event() public {
        vm.expectEmit(false, true, false, true);
        emit MockLogic.DomainRegistered(DOMAIN, ADMIN_CARD, uint64(block.timestamp));
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n3"), _dnsGovVersion(), govSigsTrue
        );
    }

    function test_register_domain_resets_fraud_risk() public {
        // Pre-set a domain entry with fraud_risk=1 (simulate re-registration after deregister).
        vm.prank(address(logic));
        storage_.set_domain_entry(keccak256(DOMAIN), bytes32(0), 0, 1, 0, true);

        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n4"), _dnsGovVersion(), govSigsTrue
        );

        (, , uint8 fr, ,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(fr, 0, "RegisterDomain must reset fraud_risk to 0");
    }

    function test_register_domain_already_registered_reverts() public {
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n5"), _dnsGovVersion(), govSigsTrue
        );

        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.DomainAlreadyRegistered.selector);
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_n6"), v, govSigsTrue
        );
    }

    function test_register_domain_card_wrong_policy_reverts() public {
        // Register a card under a different policy.
        bytes32 OTHER_POLICY = keccak256("other_policy");
        bytes32 BAD_CARD = keccak256("bad_card");

        logic.register_policy(OTHER_POLICY, DEPLOYER_KEY, bytes32(0), keccak256("op_n"), _rootGovVersion(), govSigsTrue);
        vm.prank(address(logic));
        storage_.set_card_entry(BAD_CARD, CID1, OTHER_POLICY, PRESS_ADDR, true);

        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.CardNotDnsGovernancePolicy.selector);
        logic.register_domain(DOMAIN, BAD_CARD, ADMIN_SECP_KEY, bytes32(0), keccak256("reg_n7"), v, govSigsTrue);
    }

    function test_register_domain_empty_domain_reverts() public {
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.register_domain(bytes(""), ADMIN_CARD, ADMIN_SECP_KEY, bytes32(0), keccak256("reg_n8"), v, govSigsTrue);
    }

    function test_register_domain_bad_key_length_reverts() public {
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.register_domain(DOMAIN, ADMIN_CARD, new bytes(32), bytes32(0), keccak256("reg_n9"), v, govSigsTrue);
    }

    function test_register_domain_insufficient_quorum_reverts() public {
        bytes[] memory empty_sigs = new bytes[](0);
        uint32 v = _dnsGovVersion(); // evaluate before expectRevert
        vm.expectRevert(MockLogic.InsufficientQuorum.selector);
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("reg_nQ"), v, empty_sigs
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.18 DeregisterDomain
    // ══════════════════════════════════════════════════════════════════════════

    function _registerDomain() internal {
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("setup_reg"), _dnsGovVersion(), govSigsTrue
        );
    }

    function test_deregister_domain_success() public {
        _registerDomain();

        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_n1"), _dnsGovVersion(), govSigsTrue);

        (bytes32 admin,,,, bool exists) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(admin, bytes32(0), "admin_card_address should be cleared");
        assertTrue(exists, "exists should remain true");
    }

    function test_deregister_domain_clears_secp_key() public {
        _registerDomain();
        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_n2"), _dnsGovVersion(), govSigsTrue);

        bytes memory key = storage_.get_dns_admin_card_key(ADMIN_CARD);
        assertEq(key.length, 0, "DnsAdminCardKeys should be cleared on deregistration");
    }

    function test_deregister_domain_allows_reregistration() public {
        _registerDomain();
        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_n3"), _dnsGovVersion(), govSigsTrue);

        // Re-register with same or different admin.
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("rereg_n1"), _dnsGovVersion(), govSigsTrue
        );
        (bytes32 admin,,,,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(admin, ADMIN_CARD);
    }

    function test_deregister_domain_not_found_reverts() public {
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.DomainNotFound.selector);
        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_nX"), v, govSigsTrue);
    }

    function test_deregister_domain_preserves_fraud_risk() public {
        _registerDomain();
        // Set fraud_risk to 1.
        uint64 future = uint64(block.timestamp) + 365 days;
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, future,
            bytes32(0), keccak256("flag_n1"), _dnsGovVersion(), govSigsTrue
        );

        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_n4"), _dnsGovVersion(), govSigsTrue);

        (,, uint8 fr, uint64 sus,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(fr, 2, "fraud_risk must survive deregistration");
        assertGt(sus, 0, "suspension_expires_at must survive deregistration");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.19 SetPolicyAddress
    // ══════════════════════════════════════════════════════════════════════════

    function test_set_policy_address_success() public {
        _registerDomain();

        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );

        bytes32 stored = storage_.get_policy_address(
            keccak256(abi.encodePacked(DOMAIN, bytes1(0x00), PATH))
        );
        assertEq(stored, POLICY_CARD);
    }

    function test_set_policy_address_emits_event() public {
        _registerDomain();

        vm.expectEmit(false, true, false, false);
        emit MockLogic.PolicyAddressSet(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0), PRESS_ADDR, uint64(block.timestamp)
        );
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_admin_mismatch_reverts() public {
        _registerDomain();

        bytes32 WRONG_ADMIN = keccak256("wrong_admin");
        vm.expectRevert(MockLogic.AdminCardMismatch.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, WRONG_ADMIN, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_domain_not_found_reverts() public {
        vm.expectRevert(MockLogic.DomainNotFound.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_suspended_domain_reverts() public {
        _registerDomain();
        uint64 future = uint64(block.timestamp) + 365 days;
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, future,
            bytes32(0), keccak256("flag_sus"), _dnsGovVersion(), govSigsTrue
        );

        vm.expectRevert(MockLogic.DomainSuspended.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 1
        );
    }

    function test_set_policy_address_expired_suspension_succeeds() public {
        _registerDomain();
        // Set suspension that expires in the near future.
        uint64 past_exp = uint64(block.timestamp) + 1;
        uint32 fv = _dnsGovVersion();
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, past_exp,
            bytes32(0), keccak256("flag_exp"), fv, govSigsTrue
        );

        // Advance time past expiry — suspension is now lapsed.
        vm.warp(block.timestamp + 2);

        // Read actual press sequence to avoid hard-coding an assumption.
        uint64 seq = storage_.get_next_sequence(DNS_POLICY, PRESS_ADDR);

        // Should succeed — suspension has lapsed.
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), seq
        );
        bytes32 stored = storage_.get_policy_address(
            keccak256(abi.encodePacked(DOMAIN, bytes1(0x00), PATH))
        );
        assertEq(stored, POLICY_CARD);
    }

    function test_set_policy_address_unauthorized_press_reverts() public {
        _registerDomain();

        // Use a press address that has no authorization entry under DNS_POLICY.
        bytes32 FAKE_PRESS = keccak256("unauthorized_press");

        vm.expectRevert(MockLogic.PressNotAuthorized.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            FAKE_PRESS, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_policy_card_not_found_reverts() public {
        _registerDomain();
        bytes32 BAD_POLICY_CARD = keccak256("nonexistent_policy_card");

        vm.expectRevert(MockLogic.PolicyCardNotFound.selector);
        logic.set_policy_address(
            DOMAIN, PATH, BAD_POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_with_valid_sub_card() public {
        _registerDomain();

        // Register sub-card of ADMIN_CARD (no DNS admin key → empty admin secp sig OK).
        vm.prank(address(logic));
        storage_.set_sub_card_entry(SUB_CARD, ADMIN_CARD, CID1, CID1, true, uint64(block.timestamp), 0);

        // SetPolicyAddress using sub_card_address.
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, SUB_CARD,
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );

        bytes32 stored = storage_.get_policy_address(
            keccak256(abi.encodePacked(DOMAIN, bytes1(0x00), PATH))
        );
        assertEq(stored, POLICY_CARD);
    }

    function test_set_policy_address_sub_card_wrong_master_reverts() public {
        _registerDomain();
        bytes32 OTHER_MASTER = keccak256("other_master");

        vm.prank(address(logic));
        storage_.set_sub_card_entry(SUB_CARD, OTHER_MASTER, CID1, CID1, true, uint64(block.timestamp), 0);

        vm.expectRevert(MockLogic.SubCardNotDomainAdminSubcard.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, SUB_CARD,
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_set_policy_address_inactive_sub_card_reverts() public {
        _registerDomain();

        vm.prank(address(logic));
        // Deregistered sub-card (deregistered_at non-zero).
        storage_.set_sub_card_entry(SUB_CARD, ADMIN_CARD, CID1, CID1, false, uint64(block.timestamp), uint64(block.timestamp));

        vm.expectRevert(MockLogic.SubCardNotDomainAdminSubcard.selector);
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, SUB_CARD,
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_lookup_policy_address_before_and_after() public {
        _registerDomain();
        bytes32 key = keccak256(abi.encodePacked(DOMAIN, bytes1(0x00), PATH));

        // Before: zero.
        assertEq(storage_.get_policy_address(key), bytes32(0));

        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );

        // After: POLICY_CARD.
        assertEq(logic.lookup_policy_address(DOMAIN, PATH), POLICY_CARD);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.20 RemovePolicyAddress
    // ══════════════════════════════════════════════════════════════════════════

    function _setPA() internal {
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
    }

    function test_remove_policy_address_press_path() public {
        _registerDomain();
        _setPA();

        // Press path: card_address non-zero, governance_sigs empty.
        logic.remove_policy_address(
            DOMAIN, PATH,
            ADMIN_CARD,    // card_address
            PRESS_ADDR,    // press
            bytes32(0), new bytes(64), 1, // press sig at sequence 1
            bytes32(0), bytes32(0), 0, new bytes[](0) // governance (unused)
        );

        assertEq(logic.lookup_policy_address(DOMAIN, PATH), bytes32(0));
    }

    function test_remove_policy_address_governance_path() public {
        _registerDomain();
        _setPA();

        bytes[] memory sigs = new bytes[](1);
        sigs[0] = new bytes(64);

        // Governance path: card_address zero.
        logic.remove_policy_address(
            DOMAIN, PATH,
            bytes32(0), bytes32(0), bytes32(0), new bytes(0), 0, // press (unused)
            bytes32(0), keccak256("rem_gov_n1"), _dnsGovVersion(), sigs
        );

        assertEq(logic.lookup_policy_address(DOMAIN, PATH), bytes32(0));
    }

    function test_remove_policy_address_not_found_reverts() public {
        _registerDomain();

        bytes[] memory sigs = new bytes[](1);
        sigs[0] = new bytes(64);
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.DomainPathEntryNotFound.selector);
        logic.remove_policy_address(
            DOMAIN, PATH,
            bytes32(0), bytes32(0), bytes32(0), new bytes(0), 0,
            bytes32(0), keccak256("rem_nf"), v, sigs
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.21 ClearDomainEntries
    // ══════════════════════════════════════════════════════════════════════════

    function test_clear_domain_entries_success() public {
        _registerDomain();

        // Set two paths.
        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );
        logic.set_policy_address(
            DOMAIN, PATH2, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 1
        );

        bytes[] memory paths = new bytes[](2);
        paths[0] = PATH;
        paths[1] = PATH2;

        logic.clear_domain_entries(
            DOMAIN, paths,
            bytes32(0), keccak256("clear_n1"), _dnsGovVersion(), govSigsTrue
        );

        assertEq(logic.lookup_policy_address(DOMAIN, PATH), bytes32(0));
        assertEq(logic.lookup_policy_address(DOMAIN, PATH2), bytes32(0));
    }

    function test_clear_domain_entries_emits_correct_count() public {
        _registerDomain();

        logic.set_policy_address(
            DOMAIN, PATH, POLICY_CARD, ADMIN_CARD, bytes32(0),
            PRESS_ADDR, bytes32(0), new bytes(64), 0
        );

        bytes[] memory paths = new bytes[](2);
        paths[0] = PATH;
        paths[1] = PATH2; // PATH2 is not set, should be skipped.

        vm.expectEmit(false, false, false, true);
        emit MockLogic.DomainEntriesCleared(DOMAIN, 1, uint64(block.timestamp));
        logic.clear_domain_entries(
            DOMAIN, paths,
            bytes32(0), keccak256("clear_n2"), _dnsGovVersion(), govSigsTrue
        );
    }

    function test_clear_domain_entries_empty_paths_reverts() public {
        _registerDomain();

        bytes[] memory paths = new bytes[](0);
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.BatchSizeInvalid.selector);
        logic.clear_domain_entries(
            DOMAIN, paths,
            bytes32(0), keccak256("clear_n3"), v, govSigsTrue
        );
    }

    function test_clear_domain_entries_domain_not_found_reverts() public {
        bytes[] memory paths = new bytes[](1);
        paths[0] = PATH;
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.DomainNotFound.selector);
        logic.clear_domain_entries(
            DOMAIN, paths,
            bytes32(0), keccak256("clear_n4"), v, govSigsTrue
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.22 FlagDomainFraudRisk
    // ══════════════════════════════════════════════════════════════════════════

    function test_flag_domain_fraud_risk_monitored() public {
        _registerDomain();
        logic.flag_domain_fraud_risk(
            DOMAIN, 1, 0,
            bytes32(0), keccak256("flag_m1"), _dnsGovVersion(), govSigsTrue
        );
        (,, uint8 fr, uint64 sus,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(fr, 1);
        assertEq(sus, 0);
    }

    function test_flag_domain_fraud_risk_suspended() public {
        _registerDomain();
        uint64 exp = uint64(block.timestamp) + 365 days;
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, exp,
            bytes32(0), keccak256("flag_s1"), _dnsGovVersion(), govSigsTrue
        );
        (,, uint8 fr, uint64 sus,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(fr, 2);
        assertEq(sus, exp);
    }

    function test_flag_domain_fraud_risk_restore_normal() public {
        _registerDomain();
        uint64 exp = uint64(block.timestamp) + 365 days;
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, exp,
            bytes32(0), keccak256("flag_r1"), _dnsGovVersion(), govSigsTrue
        );
        logic.flag_domain_fraud_risk(
            DOMAIN, 0, 0,
            bytes32(0), keccak256("flag_r2"), _dnsGovVersion(), govSigsTrue
        );
        (,, uint8 fr, uint64 sus,) = storage_.get_domain_entry(keccak256(DOMAIN));
        assertEq(fr, 0);
        assertEq(sus, 0);
    }

    function test_flag_domain_fraud_risk_invalid_value_reverts() public {
        _registerDomain();
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.flag_domain_fraud_risk(DOMAIN, 3, 0, bytes32(0), keccak256("flag_inv"), v, govSigsTrue);
    }

    function test_flag_domain_fraud_risk_suspended_zero_expiry_reverts() public {
        _registerDomain();
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.flag_domain_fraud_risk(DOMAIN, 2, 0, bytes32(0), keccak256("flag_inv2"), v, govSigsTrue);
    }

    function test_flag_domain_not_found_reverts() public {
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.DomainNotFound.selector);
        logic.flag_domain_fraud_risk(DOMAIN, 1, 0, bytes32(0), keccak256("flag_nf"), v, govSigsTrue);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.23 GovernanceSetPolicyAddress
    // ══════════════════════════════════════════════════════════════════════════

    function test_governance_set_policy_address_sets_value() public {
        _registerDomain();
        logic.governance_set_policy_address(
            DOMAIN, PATH, POLICY_CARD,
            bytes32(0), keccak256("gsp_n1"), _dnsGovVersion(), govSigsTrue
        );
        assertEq(logic.lookup_policy_address(DOMAIN, PATH), POLICY_CARD);
    }

    function test_governance_set_policy_address_clears_entry() public {
        _registerDomain();
        _setPA();
        assertEq(logic.lookup_policy_address(DOMAIN, PATH), POLICY_CARD);

        logic.governance_set_policy_address(
            DOMAIN, PATH, bytes32(0),
            bytes32(0), keccak256("gsp_n2"), _dnsGovVersion(), govSigsTrue
        );
        assertEq(logic.lookup_policy_address(DOMAIN, PATH), bytes32(0));
    }

    function test_governance_set_policy_address_works_on_suspended_domain() public {
        _registerDomain();
        _setPA();

        // Suspend the domain.
        uint64 future = uint64(block.timestamp) + 365 days;
        logic.flag_domain_fraud_risk(
            DOMAIN, 2, future,
            bytes32(0), keccak256("sus_n1"), _dnsGovVersion(), govSigsTrue
        );

        // GovernanceSetPolicyAddress should succeed even on suspended domains.
        logic.governance_set_policy_address(
            DOMAIN, PATH, bytes32(0),
            bytes32(0), keccak256("gsp_n3"), _dnsGovVersion(), govSigsTrue
        );
        assertEq(logic.lookup_policy_address(DOMAIN, PATH), bytes32(0));
    }

    function test_governance_set_policy_address_emits_old_value() public {
        _registerDomain();
        _setPA();

        vm.expectEmit(false, false, false, true);
        emit MockLogic.PolicyAddressGovernanceSet(DOMAIN, PATH, bytes32(0), POLICY_CARD, uint64(block.timestamp));
        logic.governance_set_policy_address(
            DOMAIN, PATH, bytes32(0),
            bytes32(0), keccak256("gsp_n4"), _dnsGovVersion(), govSigsTrue
        );
    }

    function test_governance_set_policy_address_nonexistent_card_reverts() public {
        _registerDomain();
        bytes32 BAD = keccak256("nonexistent");
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.PolicyCardNotFound.selector);
        logic.governance_set_policy_address(DOMAIN, PATH, BAD, bytes32(0), keccak256("gsp_nf"), v, govSigsTrue);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §4.24 SetDnsGovernancePolicyAddress
    // ══════════════════════════════════════════════════════════════════════════

    function test_set_dns_governance_policy_address_success() public {
        // Register a new policy to rotate to.
        bytes32 NEW_POLICY = keccak256("new_dns_policy");
        logic.register_policy(NEW_POLICY, DEPLOYER_KEY, bytes32(0), keccak256("ndp_n1"), _rootGovVersion(), govSigsTrue);

        logic.set_dns_governance_policy_address(
            NEW_POLICY,
            bytes32(0), keccak256("sdgpa_n1"), _dnsGovVersion(), govSigsTrue
        );

        assertEq(storage_.get_dns_governance_policy_address(), NEW_POLICY);
    }

    function test_set_dns_governance_policy_address_zero_reverts() public {
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.set_dns_governance_policy_address(bytes32(0), bytes32(0), keccak256("sdgpa_nz"), v, govSigsTrue);
    }

    function test_set_dns_governance_policy_address_unregistered_reverts() public {
        bytes32 UNREG = keccak256("unregistered_policy");
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.UnrecognizedPolicy.selector);
        logic.set_dns_governance_policy_address(UNREG, bytes32(0), keccak256("sdgpa_nu"), v, govSigsTrue);
    }

    function test_set_dns_governance_policy_address_noop_reverts() public {
        // Trying to set the same address as current → no-op guard.
        uint32 v = _dnsGovVersion();
        vm.expectRevert(MockLogic.InvalidDnsParameter.selector);
        logic.set_dns_governance_policy_address(DNS_POLICY, bytes32(0), keccak256("sdgpa_noop"), v, govSigsTrue);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DnsGovernanceBody quorum enforcement
    // ══════════════════════════════════════════════════════════════════════════

    function test_dns_governance_body_insufficient_quorum_reverts() public {
        bytes[] memory empty_sigs = new bytes[](0);
        uint32 v = _dnsGovVersion(); // evaluate before expectRevert
        vm.expectRevert(MockLogic.InsufficientQuorum.selector);
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("iq_n1"), v, empty_sigs
        );
    }

    function test_dns_governance_body_wrong_body_rejects() public {
        // Simplest check: use wrong version number to trigger GovernanceVersionMismatch.
        uint32 wrong_version = _dnsGovVersion() + 1;
        vm.expectRevert(MockLogic.GovernanceVersionMismatch.selector);
        // wrong_version is already computed above, no _dnsGovVersion() in arg list.
        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), keccak256("wv_n1"), wrong_version, govSigsTrue
        );
    }

    function test_dns_governance_body_nonce_reuse_reverts() public {
        bytes32 reused_nonce = keccak256("reused_dns_nonce");

        logic.register_domain(
            DOMAIN, ADMIN_CARD, ADMIN_SECP_KEY,
            bytes32(0), reused_nonce, _dnsGovVersion(), govSigsTrue
        );

        // Deregister so domain is writable again.
        logic.deregister_domain(DOMAIN, bytes32(0), keccak256("dereg_nr"), _dnsGovVersion(), govSigsTrue);

        bytes32 NEW_ADMIN = keccak256("new_admin_card");
        vm.prank(address(logic));
        storage_.set_card_entry(NEW_ADMIN, CID1, DNS_POLICY, PRESS_ADDR, true);

        uint32 vv = _dnsGovVersion(); // evaluate before expectRevert
        vm.expectRevert(MockLogic.NonceReused.selector);
        logic.register_domain(DOMAIN, NEW_ADMIN, ADMIN_SECP_KEY, bytes32(0), reused_nonce, vv, govSigsTrue);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // §3.11 DnsAdminCardKeys — RegisterSubCard secp256r1 check
    // ══════════════════════════════════════════════════════════════════════════

    function test_register_sub_card_dns_admin_requires_secp_sig() public {
        _registerDomain();
        // ADMIN_CARD now has a secp256r1 key in DnsAdminCardKeys (set by register_domain).

        bytes32 SUB = keccak256("sub_of_dns_admin");
        bytes memory SUB_DOC = hex"12203344";

        // Without admin secp sig → should revert.
        vm.expectRevert(MockLogic.InvalidAdminCardSignature.selector);
        logic.register_sub_card(
            SUB, ADMIN_CARD, CID1, SUB_DOC,
            PRESS_ADDR, bytes32(0), new bytes(64), 0,
            new bytes(0),   // empty admin_secp_payload_hash → invalid
            new bytes(0)    // empty admin_secp_signature
        );
    }

    function test_register_sub_card_dns_admin_valid_secp_sig_succeeds() public {
        _registerDomain();

        bytes32 SUB = keccak256("sub_of_dns_admin2");
        bytes memory SUB_DOC = hex"12203344";

        // With valid secp sig (MockVerifierAlwaysTrue accepts anything with length 64).
        bytes memory admin_sig_hash = new bytes(32); // bytes32 as bytes
        logic.register_sub_card(
            SUB, ADMIN_CARD, CID1, SUB_DOC,
            PRESS_ADDR, bytes32(0), new bytes(64), 0,
            admin_sig_hash,    // 32-byte payload hash
            new bytes(64)      // 64-byte signature (accepted by MockVerifierAlwaysTrue)
        );

        (bytes32 master,,, bool active,,) = storage_.get_sub_card_entry(SUB);
        assertEq(master, ADMIN_CARD);
        assertTrue(active);
    }

    function test_register_sub_card_non_dns_admin_no_secp_sig_succeeds() public {
        // Non-DNS-admin master (no entry in DnsAdminCardKeys).
        bytes32 REGULAR_MASTER = keccak256("regular_master");
        bytes32 REGULAR_POLICY = keccak256("regular_policy");

        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(REGULAR_POLICY, DEPLOYER_KEY);
        vm.prank(address(logic));
        // Use a fresh press auth entry with sequence=0 for the new policy.
        storage_.set_press_auth_entry(REGULAR_POLICY, PRESS_ADDR, DEPLOYER_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0);
        vm.prank(address(logic));
        storage_.set_card_entry(REGULAR_MASTER, CID1, REGULAR_POLICY, PRESS_ADDR, true);

        bytes32 SUB = keccak256("sub_of_regular");
        bytes memory SUB_DOC = hex"12205566";

        // Sequence for REGULAR_POLICY/PRESS_ADDR is 0 (freshly set above).
        // No admin secp sig (empty) — should succeed for non-DNS-admin master.
        logic.register_sub_card(
            SUB, REGULAR_MASTER, CID1, SUB_DOC,
            PRESS_ADDR, bytes32(0), new bytes(64), 0,
            new bytes(0), new bytes(0)
        );

        (bytes32 master,,, bool active,,) = storage_.get_sub_card_entry(SUB);
        assertEq(master, REGULAR_MASTER);
        assertTrue(active);
    }

    function test_register_sub_card_non_dns_admin_spurious_secp_sig_reverts() public {
        bytes32 REGULAR_MASTER = keccak256("regular_master2");
        bytes32 REGULAR_POLICY = keccak256("regular_policy2");

        vm.prank(address(logic));
        storage_.set_policy_authorizer_key(REGULAR_POLICY, DEPLOYER_KEY);
        vm.prank(address(logic));
        storage_.set_press_auth_entry(REGULAR_POLICY, PRESS_ADDR, DEPLOYER_KEY, bytes32(0), 0, true, 0, uint64(block.timestamp), 0);
        vm.prank(address(logic));
        storage_.set_card_entry(REGULAR_MASTER, CID1, REGULAR_POLICY, PRESS_ADDR, true);

        bytes32 SUB = keccak256("sub_of_regular2");
        bytes memory SUB_DOC = hex"12207788";

        // Non-zero admin secp sig when master is NOT a DNS admin card → E-47.
        // The E-47 check fires before the press write gate, so sequence doesn't matter.
        vm.expectRevert(MockLogic.InvalidAdminCardSignature.selector);
        logic.register_sub_card(
            SUB, REGULAR_MASTER, CID1, SUB_DOC,
            PRESS_ADDR, bytes32(0), new bytes(64), 0,
            new bytes(32), // non-empty payload hash
            new bytes(64)  // non-empty sig
        );
    }
}
