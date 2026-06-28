// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockStorage.sol";
import "./MockVerifier.sol";

/// @title Mock Logic Contract
/// @notice Solidity implementation of the logic contract for Foundry unit testing.
///         Implements all write operations from §4 of the spec, authorization checks
///         from §6.1–6.2, and event emission from §7.
///
/// @dev Testing strategy:
///      - Use MockLogic + MockStorage + MockVerifier for unit tests (no WASM required).
///      - Use Integration.t.sol + deployed Stylus contracts on Arbitrum Sepolia fork
///        for integration tests.
///
/// @dev JSON payload parsing:
///      Solidity doesn't have a built-in JSON parser. The mock uses a simplified
///      approach: callers pass the structured fields directly rather than as raw JSON.
///      In production (Stylus WASM), the payload is JSON; in tests, we pass fields
///      and construct what the JSON would look like for signature verification.

contract MockLogic {
    MockStorage public storageContract;
    address public verifierModule;

    uint256 constant MAX_CID_LEN = 64;
    uint256 constant MAX_BATCH_SIZE = 100;

    // Governance body IDs.
    uint8 constant ROOT_POLICY_BODY = 0;
    uint8 constant PRESS_REGISTRY_BODY = 1;
    uint8 constant DNS_GOVERNANCE_BODY = 2;

    // Timelocks.
    uint256 constant LOGIC_UPGRADE_TIMELOCK = 7 days;
    uint256 constant VERIFIER_UPGRADE_TIMELOCK = 48 hours;

    // ── Verifier upgrade state (stored in logic contract, not storage) ────────
    address public pendingVerifierAddress;
    uint64 public pendingVerifierAt;
    uint32 public pendingVerifierGovVersion;
    bytes32 public pendingVerifierNonce;

    // ── Events (§7) ───────────────────────────────────────────────────────────

    event CardRegistered(
        bytes32 indexed card_address,
        bytes32 indexed policy_address,
        bytes32 press_address,
        bytes initial_log_cid,
        uint64 timestamp
    );

    event CardHeadUpdated(
        bytes32 indexed card_address,
        bytes prev_log_cid,
        bytes new_log_cid,
        bytes32 press_address,
        uint64 timestamp
    );

    event SubCardRegistered(
        bytes32 indexed sub_card_address,
        bytes32 indexed master_address,
        bytes sub_card_doc_cid,
        uint64 timestamp
    );

    event SubCardDeregistered(
        bytes32 indexed sub_card_address,
        bytes32 master_address,
        uint64 timestamp
    );

    event OpenOfferClaimed(
        bytes32 indexed offer_id,
        bytes32 indexed card_address,
        uint64 use_count,
        uint64 timestamp
    );

    event PolicyRegistered(bytes32 indexed policy_address, uint64 timestamp);
    event PressAuthorized(bytes32 indexed policy_address, bytes32 indexed press_address, uint64 timestamp);
    event PressRevoked(bytes32 indexed policy_address, bytes32 indexed press_address, uint64 timestamp);
    event AuthorizerKeyRotated(bytes32 indexed policy_address, uint64 timestamp);
    event GovernanceKeysRotated(uint8 body_id, uint8 new_quorum, uint8 key_count, uint32 version, uint64 timestamp);
    event AddressTransition(bytes32 indexed old_address, bytes32 indexed new_address, uint64 timestamp);
    event LogicUpgradeProposed(address indexed proposed_address, uint64 proposed_at, uint64 timelock_expires);
    event LogicUpgradeConfirmed(address indexed new_logic_address, uint64 confirmed_at);
    event LogicUpgradeCancelled(address indexed cancelled_address, uint64 cancelled_at);
    event VerifierUpgradeProposed(address indexed proposed_address, uint64 proposed_at, uint64 timelock_expires);
    event VerifierUpgradeConfirmed(address indexed new_verifier_address, uint64 confirmed_at);
    event VerifierUpgradeCancelled(address indexed cancelled_address, uint64 cancelled_at);

    // ── Errors ────────────────────────────────────────────────────────────────

    error CardAlreadyExists();
    error CardNotFound();
    error UnrecognizedPolicy();
    error PressNotAuthorized();
    error PressRevoked_();
    error InvalidPressSignature();
    error SequenceMismatch();
    error NonceReused();
    error StalePrevCid();
    error PolicyAlreadyRegistered();
    error SubCardNotFound();
    error SubCardAlreadyActive();
    error OfferExpired();
    error OfferAtCapacity();
    error GovernanceVersionMismatch();
    error InvalidGovernanceSignature();
    error DuplicateSigner();
    error InsufficientQuorum();
    error QuorumTooLow();
    error KeysetTooSmall();
    error LogCidTooLong();
    error ForwardAlreadySet();
    error UpgradeAlreadyPending();
    error UpgradeTimelockNotElapsed();
    error UpgradeAddressMismatch();
    error BatchSizeInvalid();
    error BatchItemInvalid();
    error InvalidPayload();
    error NoUpgradePending();
    error StaleRegistrationLogHead();

    // DNS errors (E-37–E-47)
    error DomainNotFound();
    error DomainAlreadyRegistered();
    error DomainSuspended();
    error CardNotDnsGovernancePolicy();
    error PolicyCardNotFound();
    error DomainPathEntryNotFound();
    error InvalidDnsParameter();
    error SubCardNotDomainAdminSubcard();
    error AdminCardMismatch();
    error InvalidAdminCardSignature();

    constructor(address _storage, address _verifier) {
        storageContract = MockStorage(_storage);
        verifierModule = _verifier;
    }

    // ── Internal: Write gate (§6.1) ───────────────────────────────────────────

    /// @dev Runs the card write gate and increments next_sequence.
    function _runWriteGate(
        bytes32 policy_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) internal {
        // Step 1: Policy exists.
        if (!storageContract.policy_exists(policy_address)) revert UnrecognizedPolicy();

        // Steps 2 & 3: Press auth.
        (bytes memory key_bytes,,,bool active, uint64 next_seq,,) =
            storageContract.get_press_authorization(policy_address, press_address);
        if (key_bytes.length != 64) revert PressNotAuthorized();
        if (!active) revert PressRevoked_();

        // Step 4: Signature verification.
        bool sig_valid = MockVerifier(verifierModule).verify_secp256r1(
            payload_hash,
            press_signature,
            key_bytes
        );
        if (!sig_valid) revert InvalidPressSignature();

        // Step 6: Sequence check.
        if (expected_sequence != next_seq) revert SequenceMismatch();

        // Increment sequence.
        storageContract.increment_press_sequence(policy_address, press_address);
    }

    /// @dev Governance quorum verification (§6.2).
    function _verifyGovernanceQuorum(
        uint8 body_id,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) internal {
        // Step 1: Version check.
        (bytes memory keys_flat,, uint8 quorum, uint32 stored_version,) =
            storageContract.get_governance_keyset(body_id);
        if (payload_version != stored_version) revert GovernanceVersionMismatch();

        // Step 2: Nonce check.
        if (storageContract.is_nonce_used(nonce_key)) revert NonceReused();

        // Steps 3 & 4: Signature verification.
        uint256 key_count = keys_flat.length / 64;
        bool[50] memory used_indices;
        uint256 valid_count = 0;

        for (uint256 i = 0; i < governance_sigs.length; i++) {
            if (governance_sigs[i].length != 64) revert InvalidGovernanceSignature();

            bool found = false;
            for (uint256 j = 0; j < key_count; j++) {
                bytes memory pub_key = new bytes(64);
                for (uint256 k = 0; k < 64; k++) {
                    pub_key[k] = keys_flat[j * 64 + k];
                }

                bool valid = MockVerifier(verifierModule).verify_secp256r1(
                    payload_hash,
                    governance_sigs[i],
                    pub_key
                );

                if (valid) {
                    if (used_indices[j]) revert DuplicateSigner();
                    used_indices[j] = true;
                    valid_count++;
                    found = true;
                    break;
                }
            }
            if (!found) revert InvalidGovernanceSignature();
        }

        if (valid_count < quorum) revert InsufficientQuorum();

        // Mark nonce used.
        storageContract.mark_nonce_used(nonce_key);
    }

    // ── §4.1 RegisterCard ─────────────────────────────────────────────────────

    function register_card(
        bytes32 card_address,
        bytes calldata initial_log_cid,
        bytes32 policy_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        if (storageContract.card_exists(card_address)) revert CardAlreadyExists();
        if (initial_log_cid.length > MAX_CID_LEN) revert LogCidTooLong();

        _runWriteGate(policy_address, press_address, payload_hash, press_signature, expected_sequence);

        storageContract.set_card_entry(card_address, initial_log_cid, policy_address, press_address, true);

        emit CardRegistered(card_address, policy_address, press_address, initial_log_cid, uint64(block.timestamp));
    }

    // ── §4.2 UpdateCardHead ───────────────────────────────────────────────────

    function update_card_head(
        bytes32 card_address,
        bytes calldata new_log_cid,
        bytes calldata prev_log_cid,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        (bytes memory stored_cid, bytes32 policy_address,,, bool exists) =
            storageContract.get_card_entry(card_address);
        if (!exists) revert CardNotFound();
        if (new_log_cid.length > MAX_CID_LEN) revert LogCidTooLong();

        _runWriteGate(policy_address, press_address, payload_hash, press_signature, expected_sequence);

        if (keccak256(stored_cid) != keccak256(prev_log_cid)) revert StalePrevCid();

        storageContract.update_card_head(card_address, new_log_cid, press_address);

        emit CardHeadUpdated(card_address, prev_log_cid, new_log_cid, press_address, uint64(block.timestamp));
    }

    // ── §4.5 ClaimOpenOffer ───────────────────────────────────────────────────

    function claim_open_offer(
        bytes32 offer_id,
        uint64 max_acceptances,
        uint64 expires_at,
        bytes32 card_address,
        bytes calldata initial_log_cid,
        bytes32 policy_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        if (expires_at != 0 && block.timestamp >= expires_at) revert OfferExpired();

        uint64 current_count = storageContract.get_open_offer_count(offer_id);
        if (max_acceptances != type(uint64).max && current_count >= max_acceptances) revert OfferAtCapacity();

        if (storageContract.card_exists(card_address)) revert CardAlreadyExists();
        if (initial_log_cid.length > MAX_CID_LEN) revert LogCidTooLong();

        _runWriteGate(policy_address, press_address, payload_hash, press_signature, expected_sequence);

        storageContract.set_open_offer_count(offer_id, current_count + 1);
        storageContract.set_card_entry(card_address, initial_log_cid, policy_address, press_address, true);

        emit OpenOfferClaimed(offer_id, card_address, current_count + 1, uint64(block.timestamp));
        emit CardRegistered(card_address, policy_address, press_address, initial_log_cid, uint64(block.timestamp));
    }

    // ── §4.13 RegisterAddressForward ──────────────────────────────────────────

    function register_address_forward(
        bytes32 old_address,
        bytes32 new_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata secp256r1_sig
    ) external {
        (,bytes32 policy,,,bool old_exists) = storageContract.get_card_entry(old_address);
        if (!old_exists) revert CardNotFound();
        (,,,,bool new_exists) = storageContract.get_card_entry(new_address);
        if (!new_exists) revert CardNotFound();

        // Check forward not already set (also enforced by storage invariant).
        (,,,bytes32 fwd,) = storageContract.get_card_entry(old_address);
        if (fwd != bytes32(0)) revert ForwardAlreadySet();

        // Verify signature against press key.
        (bytes memory key_bytes,,,bool active,,, ) =
            storageContract.get_press_authorization(policy, press_address);
        if (key_bytes.length != 64) revert PressNotAuthorized();
        if (!active) revert PressRevoked_();

        bool valid = MockVerifier(verifierModule).verify_secp256r1(payload_hash, secp256r1_sig, key_bytes);
        if (!valid) revert InvalidPressSignature();

        storageContract.set_forward_to(old_address, new_address);
        emit AddressTransition(old_address, new_address, uint64(block.timestamp));
    }

    // ── §4.15 BatchUpdateCardHeads ────────────────────────────────────────────

    function batch_update_card_heads(
        bytes32 policy_address,
        bytes32 press_address,
        bytes32[] calldata card_addresses,
        bytes[] calldata prev_log_cids,
        bytes[] calldata new_log_cids,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        uint256 n = card_addresses.length;
        if (n == 0 || n > MAX_BATCH_SIZE) revert BatchSizeInvalid();
        if (prev_log_cids.length != n || new_log_cids.length != n) revert BatchSizeInvalid();

        // Validate write gate WITHOUT incrementing sequence yet.
        if (!storageContract.policy_exists(policy_address)) revert UnrecognizedPolicy();
        (bytes memory key_bytes,,,bool active, uint64 next_seq,,) =
            storageContract.get_press_authorization(policy_address, press_address);
        if (key_bytes.length != 64) revert PressNotAuthorized();
        if (!active) revert PressRevoked_();
        bool sig_valid = MockVerifier(verifierModule).verify_secp256r1(payload_hash, press_signature, key_bytes);
        if (!sig_valid) revert InvalidPressSignature();
        if (expected_sequence != next_seq) revert SequenceMismatch();

        // Validate all items before any state change.
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (card_addresses[i] == card_addresses[j]) revert BatchItemInvalid();
            }
            if (new_log_cids[i].length > MAX_CID_LEN) revert LogCidTooLong();

            (bytes memory stored_cid, bytes32 card_policy,,, bool exists) =
                storageContract.get_card_entry(card_addresses[i]);
            if (!exists) revert CardNotFound();
            if (card_policy != policy_address) revert BatchItemInvalid();
            if (keccak256(stored_cid) != keccak256(prev_log_cids[i])) revert StalePrevCid();
        }

        // Increment sequence exactly once.
        storageContract.increment_press_sequence(policy_address, press_address);

        // Apply state changes.
        uint64 ts = uint64(block.timestamp);
        for (uint256 i = 0; i < n; i++) {
            storageContract.update_card_head(card_addresses[i], new_log_cids[i], press_address);
            emit CardHeadUpdated(card_addresses[i], prev_log_cids[i], new_log_cids[i], press_address, ts);
        }
    }

    // ── §4.3 RegisterSubCard ──────────────────────────────────────────────────

    function register_sub_card(
        bytes32 sub_card_address,
        bytes32 master_card_address,
        bytes calldata registration_log_head,
        bytes calldata sub_card_doc_cid,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence,
        bytes calldata admin_secp_payload_hash_bytes, // keccak256 of AdminAuthorizeSubCardPayload; zero = not a DNS admin
        bytes calldata admin_secp_signature           // 64-byte secp256r1 sig; empty = not a DNS admin
    ) external {
        (bytes memory master_cid, bytes32 master_policy,,, bool master_exists) =
            storageContract.get_card_entry(master_card_address);
        if (!master_exists) revert CardNotFound();

        (,,, bool sub_active,,) = storageContract.get_sub_card_entry(sub_card_address);
        if (sub_active) revert SubCardAlreadyActive();

        if (keccak256(master_cid) != keccak256(registration_log_head)) revert StaleRegistrationLogHead();
        if (registration_log_head.length > MAX_CID_LEN) revert LogCidTooLong();
        if (sub_card_doc_cid.length > MAX_CID_LEN) revert LogCidTooLong();

        // Admin secp256r1 check (§4.3 precondition 5).
        bytes memory dns_admin_key = storageContract.get_dns_admin_card_key(master_card_address);
        bool is_dns_admin_master = dns_admin_key.length == 64;

        if (is_dns_admin_master) {
            if (admin_secp_signature.length != 64 || admin_secp_payload_hash_bytes.length != 32)
                revert InvalidAdminCardSignature();
            bytes32 admin_msg_hash = bytes32(admin_secp_payload_hash_bytes);
            bool admin_sig_valid = MockVerifier(verifierModule).verify_secp256r1(
                admin_msg_hash, admin_secp_signature, dns_admin_key
            );
            if (!admin_sig_valid) revert InvalidAdminCardSignature();
        } else {
            if (admin_secp_signature.length != 0) revert InvalidAdminCardSignature();
        }

        _runWriteGate(master_policy, press_address, payload_hash, press_signature, expected_sequence);

        storageContract.set_sub_card_entry(
            sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid,
            true, uint64(block.timestamp), 0
        );

        emit SubCardRegistered(sub_card_address, master_card_address, sub_card_doc_cid, uint64(block.timestamp));
    }

    // ── §4.4 DeregisterSubCard ────────────────────────────────────────────────

    function deregister_sub_card(
        bytes32 sub_card_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        (bytes32 master_card, bytes memory reg_head, bytes memory doc_cid, bool sub_active, uint64 reg_at,) =
            storageContract.get_sub_card_entry(sub_card_address);
        if (master_card == bytes32(0) || !sub_active) revert SubCardNotFound();

        (,bytes32 master_policy,,,bool master_exists) = storageContract.get_card_entry(master_card);
        if (!master_exists) revert CardNotFound();

        _runWriteGate(master_policy, press_address, payload_hash, press_signature, expected_sequence);

        uint64 ts = uint64(block.timestamp);
        storageContract.set_sub_card_entry(sub_card_address, master_card, reg_head, doc_cid, false, reg_at, ts);

        emit SubCardDeregistered(sub_card_address, master_card, ts);
    }

    // ── §4.6 RegisterPolicy ───────────────────────────────────────────────────

    function register_policy(
        bytes32 policy_address,
        bytes calldata authorizer_pubkey,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (storageContract.policy_exists(policy_address)) revert PolicyAlreadyRegistered();
        if (authorizer_pubkey.length != 64) revert InvalidPayload();

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_policy_authorizer_key(policy_address, authorizer_pubkey);
        emit PolicyRegistered(policy_address, uint64(block.timestamp));
    }

    // ── §4.7 AuthorizePress ───────────────────────────────────────────────────

    function authorize_press(
        bytes32 policy_address,
        bytes32 press_address,
        bytes calldata press_pubkey,
        bytes32 mldsa44_key_hash,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (!storageContract.policy_exists(policy_address)) revert UnrecognizedPolicy();
        if (press_pubkey.length != 64) revert InvalidPayload();

        _verifyGovernanceQuorum(PRESS_REGISTRY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_press_auth_entry(
            policy_address, press_address, press_pubkey, mldsa44_key_hash,
            0, true, 0, uint64(block.timestamp), 0
        );
        emit PressAuthorized(policy_address, press_address, uint64(block.timestamp));
    }

    // ── §4.8 RevokePress ─────────────────────────────────────────────────────

    function revoke_press(
        bytes32 policy_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        (bytes memory key_bytes, bytes32 mldsa_hash, uint8 scheme, bool active, uint64 seq, uint64 auth_at,) =
            storageContract.get_press_authorization(policy_address, press_address);
        if (key_bytes.length != 64) revert PressNotAuthorized();
        if (!active) revert PressRevoked_();

        _verifyGovernanceQuorum(PRESS_REGISTRY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_press_auth_entry(
            policy_address, press_address, key_bytes, mldsa_hash, scheme,
            false, seq, auth_at, uint64(block.timestamp)
        );
        emit PressRevoked(policy_address, press_address, uint64(block.timestamp));
    }

    // ── §4.9 RotateAuthorizerKey ──────────────────────────────────────────────

    function rotate_authorizer_key(
        bytes32 policy_address,
        bytes calldata new_authorizer_key,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (!storageContract.policy_exists(policy_address)) revert UnrecognizedPolicy();
        if (new_authorizer_key.length != 64) revert InvalidPayload();

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_policy_authorizer_key(policy_address, new_authorizer_key);
        emit AuthorizerKeyRotated(policy_address, uint64(block.timestamp));
    }

    // ── §4.10 RotateGovernanceKeys ────────────────────────────────────────────

    function rotate_governance_keys(
        uint8 body_id,
        bytes calldata new_keys_flat,
        uint8 new_key_count,
        uint8 new_quorum,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (new_key_count < 3) revert KeysetTooSmall();
        if (new_quorum <= new_key_count / 2) revert QuorumTooLow();
        if (new_keys_flat.length != uint256(new_key_count) * 64) revert InvalidPayload();

        _verifyGovernanceQuorum(body_id, payload_hash, nonce_key, payload_version, governance_sigs);

        (,,,uint32 current_version,) = storageContract.get_governance_keyset(body_id);
        uint32 new_version = current_version + 1;

        storageContract.set_governance_keyset(body_id, new_keys_flat, new_key_count, new_quorum, new_version, 0);
        emit GovernanceKeysRotated(body_id, new_quorum, new_key_count, new_version, uint64(block.timestamp));
    }

    // ── §4.14 ProposeLogicUpgrade ─────────────────────────────────────────────

    function propose_logic_upgrade(
        address new_logic_address,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        (address pending_addr,,,) = storageContract.get_pending_logic_upgrade();
        if (pending_addr != address(0)) revert UpgradeAlreadyPending();
        if (new_logic_address == address(0)) revert InvalidPayload();
        if (new_logic_address == storageContract.get_logic_contract()) revert InvalidPayload();

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        (,,,uint32 gov_version,) = storageContract.get_governance_keyset(ROOT_POLICY_BODY);
        uint64 ts = uint64(block.timestamp);
        storageContract.set_pending_logic_upgrade(new_logic_address, ts, gov_version, nonce_key);

        emit LogicUpgradeProposed(new_logic_address, ts, ts + uint64(LOGIC_UPGRADE_TIMELOCK));
    }

    // ── §4.14 ConfirmLogicUpgrade ─────────────────────────────────────────────

    function confirm_logic_upgrade(
        address proposed_logic_address,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        (address pending_addr, uint64 pending_at, uint32 pending_gov_ver,) =
            storageContract.get_pending_logic_upgrade();
        if (pending_addr == address(0)) revert NoUpgradePending();
        if (proposed_logic_address != pending_addr) revert UpgradeAddressMismatch();
        if (block.timestamp < pending_at + LOGIC_UPGRADE_TIMELOCK) revert UpgradeTimelockNotElapsed();

        (,,,uint32 current_gov_ver,) = storageContract.get_governance_keyset(ROOT_POLICY_BODY);
        if (current_gov_ver != pending_gov_ver) revert GovernanceVersionMismatch();

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.clear_pending_logic_upgrade();
        storageContract.set_logic_contract(proposed_logic_address);

        emit LogicUpgradeConfirmed(proposed_logic_address, uint64(block.timestamp));
    }

    // ── §4.14 CancelLogicUpgrade ──────────────────────────────────────────────

    function cancel_logic_upgrade(
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        (address pending_addr,,,) = storageContract.get_pending_logic_upgrade();
        if (pending_addr == address(0)) revert NoUpgradePending();

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.clear_pending_logic_upgrade();
        emit LogicUpgradeCancelled(pending_addr, uint64(block.timestamp));
    }

    // ════════════════════════════════════════════════════════════════════════
    // DNS resolution operations (§4.17–4.24)
    // ════════════════════════════════════════════════════════════════════════

    // DNS events
    event DomainRegistered(bytes domain, bytes32 indexed admin_card_address, uint64 timestamp);
    event DomainDeregistered(bytes domain, uint64 timestamp);
    event PolicyAddressSet(bytes domain, bytes path, bytes32 indexed policy_card_address, bytes32 admin_card_address, bytes32 sub_card_address, bytes32 press_address, uint64 timestamp);
    event PolicyAddressRemoved(bytes domain, bytes path, uint64 timestamp);
    event DomainEntriesCleared(bytes domain, uint32 paths_cleared, uint64 timestamp);
    event DomainFraudRiskUpdated(bytes domain, uint8 fraud_risk, uint64 suspension_expires_at, uint64 timestamp);
    event PolicyAddressGovernanceSet(bytes domain, bytes path, bytes32 policy_card_address, bytes32 old_policy_card_address, uint64 timestamp);
    event DnsGovernancePolicyAddressUpdated(bytes32 indexed old_address, bytes32 indexed new_address, uint64 timestamp);

    // Internal: compute domain hash (keccak256 of domain bytes).
    function _domainHash(bytes memory domain) internal pure returns (bytes32) {
        return keccak256(domain);
    }

    // Internal: compute policy address key keccak256(domain || 0x00 || path).
    function _policyAddressKey(bytes memory domain, bytes memory path) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(domain, bytes1(0x00), path));
    }

    // Internal: governance quorum check for DnsGovernanceBody.
    function _dnsGovQuorum(
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) internal {
        _verifyGovernanceQuorum(DNS_GOVERNANCE_BODY, payload_hash, nonce_key, payload_version, governance_sigs);
    }

    // ── §4.17 RegisterDomain ─────────────────────────────────────────────────

    function register_domain(
        bytes memory domain,
        bytes32 admin_card_address,
        bytes calldata admin_secp256r1_key,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (domain.length == 0 || domain.length > 255) revert InvalidDnsParameter();
        if (admin_secp256r1_key.length != 64) revert InvalidDnsParameter();

        bytes32 dns_policy = storageContract.get_dns_governance_policy_address();
        if (dns_policy == bytes32(0)) revert CardNotDnsGovernancePolicy();

        (,bytes32 card_policy,,,bool card_exists) = storageContract.get_card_entry(admin_card_address);
        if (!card_exists) revert CardNotFound();
        if (card_policy != dns_policy) revert CardNotDnsGovernancePolicy();

        bytes32 d_hash = _domainHash(domain);
        (bytes32 existing_admin,,,,bool already_exists) = storageContract.get_domain_entry(d_hash);
        if (already_exists && existing_admin != bytes32(0)) revert DomainAlreadyRegistered();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        uint64 ts = uint64(block.timestamp);
        storageContract.set_domain_entry(d_hash, admin_card_address, ts, 0, 0, true);
        storageContract.set_dns_admin_card_key(admin_card_address, admin_secp256r1_key);

        emit DomainRegistered(domain, admin_card_address, ts);
    }

    // ── §4.18 DeregisterDomain ───────────────────────────────────────────────

    function deregister_domain(
        bytes memory domain,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (domain.length == 0 || domain.length > 255) revert InvalidDnsParameter();

        bytes32 d_hash = _domainHash(domain);
        (bytes32 old_admin, uint64 reg_at, uint8 fr, uint64 sus,bool exists) =
            storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_domain_entry(d_hash, bytes32(0), reg_at, fr, sus, true);
        if (old_admin != bytes32(0)) {
            storageContract.set_dns_admin_card_key(old_admin, new bytes(0));
        }

        emit DomainDeregistered(domain, uint64(block.timestamp));
    }

    // ── §4.19 SetPolicyAddress ───────────────────────────────────────────────

    function set_policy_address(
        bytes memory domain,
        bytes memory path,
        bytes32 policy_card_address,
        bytes32 admin_card_address,
        bytes32 sub_card_address,
        bytes32 press_address,
        bytes32 payload_hash,
        bytes calldata press_signature,
        uint64 expected_sequence
    ) external {
        if (domain.length == 0 || domain.length > 255) revert InvalidDnsParameter();

        bytes32 dns_policy = storageContract.get_dns_governance_policy_address();
        if (dns_policy == bytes32(0)) revert CardNotDnsGovernancePolicy();

        bytes32 d_hash = _domainHash(domain);
        (bytes32 registered_admin,, uint8 fr, uint64 sus, bool exists) =
            storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        if (fr == 2 && block.timestamp < sus) revert DomainSuspended();
        if (admin_card_address != registered_admin) revert AdminCardMismatch();

        if (sub_card_address != bytes32(0)) {
            (bytes32 sc_master,,, bool sc_active,,) = storageContract.get_sub_card_entry(sub_card_address);
            if (!sc_active || sc_master != admin_card_address) revert SubCardNotDomainAdminSubcard();
        }

        _runWriteGate(dns_policy, press_address, payload_hash, press_signature, expected_sequence);

        if (!storageContract.card_exists(policy_card_address)) revert PolicyCardNotFound();

        bytes32 key = _policyAddressKey(domain, path);
        storageContract.set_policy_address(key, policy_card_address);

        emit PolicyAddressSet(domain, path, policy_card_address, admin_card_address, sub_card_address, press_address, uint64(block.timestamp));
    }

    // ── §4.20 RemovePolicyAddress ────────────────────────────────────────────

    function remove_policy_address(
        bytes memory domain,
        bytes memory path,
        bytes32 card_address,       // non-zero = press path; zero = governance path
        bytes32 press_address,
        bytes32 press_payload_hash,
        bytes calldata press_signature,
        uint64 press_sequence,
        bytes32 gov_payload_hash,
        bytes32 gov_nonce_key,
        uint32 gov_version,
        bytes[] calldata governance_sigs
    ) external {
        bytes32 d_hash = _domainHash(domain);
        (,,,,bool exists) = storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        bytes32 key = _policyAddressKey(domain, path);
        if (storageContract.get_policy_address(key) == bytes32(0)) revert DomainPathEntryNotFound();

        if (card_address != bytes32(0)) {
            // Path A: press.
            bytes32 dns_policy = storageContract.get_dns_governance_policy_address();
            if (dns_policy == bytes32(0)) revert CardNotDnsGovernancePolicy();
            (,bytes32 card_policy,,,bool ce) = storageContract.get_card_entry(card_address);
            if (!ce) revert CardNotFound();
            if (card_policy != dns_policy) revert CardNotDnsGovernancePolicy();
            _runWriteGate(dns_policy, press_address, press_payload_hash, press_signature, press_sequence);
        } else {
            // Path B: governance.
            _dnsGovQuorum(gov_payload_hash, gov_nonce_key, gov_version, governance_sigs);
        }

        storageContract.set_policy_address(key, bytes32(0));
        emit PolicyAddressRemoved(domain, path, uint64(block.timestamp));
    }

    // ── §4.21 ClearDomainEntries ─────────────────────────────────────────────

    function clear_domain_entries(
        bytes memory domain,
        bytes[] calldata paths,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (paths.length == 0 || paths.length > 500) revert BatchSizeInvalid();

        bytes32 d_hash = _domainHash(domain);
        (,,,,bool exists) = storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        uint32 cleared = 0;
        for (uint256 i = 0; i < paths.length; i++) {
            bytes32 key = _policyAddressKey(domain, paths[i]);
            if (storageContract.get_policy_address(key) != bytes32(0)) {
                storageContract.set_policy_address(key, bytes32(0));
                cleared++;
            }
        }

        emit DomainEntriesCleared(domain, cleared, uint64(block.timestamp));
    }

    // ── §4.22 FlagDomainFraudRisk ────────────────────────────────────────────

    function flag_domain_fraud_risk(
        bytes memory domain,
        uint8 fraud_risk,
        uint64 suspension_expires_at,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (fraud_risk > 2) revert InvalidDnsParameter();
        if (fraud_risk == 2 && (suspension_expires_at == 0 || suspension_expires_at <= block.timestamp))
            revert InvalidDnsParameter();
        if (fraud_risk != 2 && suspension_expires_at != 0) revert InvalidDnsParameter();

        bytes32 d_hash = _domainHash(domain);
        (bytes32 admin, uint64 reg_at,,,bool exists) = storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        storageContract.set_domain_entry(d_hash, admin, reg_at, fraud_risk, suspension_expires_at, true);
        emit DomainFraudRiskUpdated(domain, fraud_risk, suspension_expires_at, uint64(block.timestamp));
    }

    // ── §4.23 GovernanceSetPolicyAddress ────────────────────────────────────

    function governance_set_policy_address(
        bytes memory domain,
        bytes memory path,
        bytes32 policy_card_address,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        bytes32 d_hash = _domainHash(domain);
        (,,,,bool exists) = storageContract.get_domain_entry(d_hash);
        if (!exists) revert DomainNotFound();

        if (policy_card_address != bytes32(0) && !storageContract.card_exists(policy_card_address))
            revert PolicyCardNotFound();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        bytes32 key = _policyAddressKey(domain, path);
        bytes32 old_value = storageContract.get_policy_address(key);
        storageContract.set_policy_address(key, policy_card_address);

        emit PolicyAddressGovernanceSet(domain, path, policy_card_address, old_value, uint64(block.timestamp));
    }

    // ── §4.24 SetDnsGovernancePolicyAddress ──────────────────────────────────

    function set_dns_governance_policy_address(
        bytes32 new_policy_address,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (new_policy_address == bytes32(0)) revert InvalidDnsParameter();
        if (!storageContract.policy_exists(new_policy_address)) revert UnrecognizedPolicy();
        if (new_policy_address == storageContract.get_dns_governance_policy_address())
            revert InvalidDnsParameter();

        _dnsGovQuorum(payload_hash, nonce_key, payload_version, governance_sigs);

        bytes32 old = storageContract.get_dns_governance_policy_address();
        storageContract.set_dns_governance_policy_address(new_policy_address);
        emit DnsGovernancePolicyAddressUpdated(old, new_policy_address, uint64(block.timestamp));
    }

    // DNS pass-through reads
    function lookup_policy_address(bytes memory domain, bytes memory path) external view returns (bytes32) {
        return storageContract.get_policy_address(_policyAddressKey(domain, path));
    }

    function get_domain_registration(bytes memory domain)
        external view
        returns (bytes32, uint64, uint8, uint64, bool)
    {
        return storageContract.get_domain_entry(_domainHash(domain));
    }

    // ── §4.17 SetProtocolVersion / GetProtocolVersion ─────────────────────────

    event ProtocolVersionUpdated(string old_version, string new_version, uint64 timestamp);

    string internal _protocolVersion;

    /// Returns the current protocol version string, defaulting to "0.1" when not
    /// explicitly set (matches logic contract behaviour for pre-§4.17 deployments).
    function get_protocol_version() external view returns (string memory) {
        bytes memory b = bytes(_protocolVersion);
        if (b.length == 0) return "0.1";
        return _protocolVersion;
    }

    /// §4.17 SetProtocolVersion (RootPolicyBody quorum required).
    function set_protocol_version(
        string calldata new_version,
        bytes32 payload_hash,
        bytes32 nonce_key,
        uint32 payload_version,
        bytes[] calldata governance_sigs
    ) external {
        if (bytes(new_version).length == 0) revert InvalidPayload();

        string memory old_version = bytes(_protocolVersion).length == 0 ? "0.1" : _protocolVersion;

        _verifyGovernanceQuorum(ROOT_POLICY_BODY, payload_hash, nonce_key, payload_version, governance_sigs);

        _protocolVersion = new_version;

        emit ProtocolVersionUpdated(old_version, new_version, uint64(block.timestamp));
    }
}
