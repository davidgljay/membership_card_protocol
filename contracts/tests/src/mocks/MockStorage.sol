// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mock Storage Contract
/// @notice Solidity implementation mirroring the storage-contract behavior for unit testing.
///         Used in Foundry tests where the Stylus WASM contract cannot be directly deployed
///         without a live Arbitrum node. The mock implements the same ABI and invariants.
///
/// @dev Testing approach:
///      - The mock is used for logic-level unit tests (CardOps, GovernanceOps, etc.).
///      - Integration tests (Integration.t.sol) target the actual deployed WASM contracts
///        on an Arbitrum Sepolia fork.
///      - The mock faithfully implements all unconditional invariants from §3.7 to ensure
///        invariant tests are valid even without WASM.
///
/// @dev Unconditional invariants enforced (§3.7):
///      1. CardEntries[addr].exists is write-once-true.
///      2. CardEntries[addr].forward_to is immutable once non-zero.
///      3. PressAuthorizations[p][a].revoked_at is write-once-non-zero.
///      4. SubCardRegistrations[addr].deregistered_at is write-once-non-zero.
///      5. PolicyAuthorizerKeys has no unconditional delete (governed only).
contract MockStorage {
    // ── State ─────────────────────────────────────────────────────────────────

    struct CardEntry {
        bytes log_head_cid;
        bytes32 policy_address;
        bytes32 last_press_address;
        bytes32 forward_to;
        bool exists;
    }

    struct PressAuthEntry {
        bytes press_public_key;
        bytes32 mldsa44_key_hash;
        uint8 key_scheme;
        bool active;
        uint64 next_sequence;
        uint64 authorized_at;
        uint64 revoked_at;
    }

    struct SubCardEntry {
        bytes32 master_card_address;
        bytes registration_log_head;
        bytes sub_card_doc_cid;
        bool active;
        uint64 registered_at;
        uint64 deregistered_at;
    }

    struct GovernanceKeyset {
        bytes keys_flat;
        uint8 key_count;
        uint8 quorum;
        uint32 version;
        uint8 key_scheme;
    }

    struct PendingLogicUpgrade {
        address proposed_address;
        uint64 proposed_at;
        uint32 governance_version;
        bytes32 nonce;
    }

    mapping(bytes32 => CardEntry) public card_entries_map;
    mapping(bytes32 => bytes) public policy_authorizer_keys_map;
    mapping(bytes32 => mapping(bytes32 => PressAuthEntry)) public press_authorizations_map;
    mapping(bytes32 => SubCardEntry) public sub_card_registrations_map;
    mapping(bytes32 => uint64) public open_offer_use_counts_map;
    mapping(uint8 => GovernanceKeyset) public governance_keysets_map;
    mapping(bytes32 => bool) public used_nonces_map;

    address public logic_contract_addr;
    PendingLogicUpgrade public pending_logic_upgrade_state;
    address public pending_verifier_addr;
    uint64 public pending_verifier_at;
    uint32 public pending_verifier_gov_ver;
    bytes32 public pending_verifier_nonce_val;
    uint8 public key_scheme_phase_val;

    // ── Errors ────────────────────────────────────────────────────────────────

    error CallerNotLogicContract();
    error CardAlreadyExists();
    error ForwardAlreadySet();
    error RevokedAtImmutable();
    error DeregisteredAtImmutable();
    error InvalidAddress();
    error InvalidKeyLength();
    error InvalidKeysFlat();
    error CidTooLong();

    uint256 constant MAX_CID_LEN = 64;

    // ── Access control ────────────────────────────────────────────────────────

    modifier onlyLogic() {
        if (msg.sender != logic_contract_addr) revert CallerNotLogicContract();
        _;
    }

    // ── Initialization ────────────────────────────────────────────────────────

    function initialize(
        address initial_logic_address,
        bytes calldata deployer_secp256r1_pubkey
    ) external {
        require(logic_contract_addr == address(0), "Already initialized");
        require(initial_logic_address != address(0));
        require(deployer_secp256r1_pubkey.length == 64, "Pubkey must be 64 bytes");

        logic_contract_addr = initial_logic_address;

        // Bootstrap both governance keysets with 1-of-1.
        for (uint8 i = 0; i <= 1; i++) {
            governance_keysets_map[i] = GovernanceKeyset({
                keys_flat: deployer_secp256r1_pubkey,
                key_count: 1,
                quorum: 1,
                version: 0,
                key_scheme: 0
            });
        }

        key_scheme_phase_val = 0;
    }

    // ── Getters (§5) ─────────────────────────────────────────────────────────

    function get_card_entry(bytes32 card_address)
        external view
        returns (bytes memory, bytes32, bytes32, bytes32, bool)
    {
        CardEntry storage e = card_entries_map[card_address];
        return (e.log_head_cid, e.policy_address, e.last_press_address, e.forward_to, e.exists);
    }

    function card_exists(bytes32 card_address) external view returns (bool) {
        return card_entries_map[card_address].exists;
    }

    function get_policy_authorizer(bytes32 policy_address)
        external view returns (bytes memory)
    {
        return policy_authorizer_keys_map[policy_address];
    }

    function policy_exists(bytes32 policy_address) external view returns (bool) {
        return policy_authorizer_keys_map[policy_address].length == 64;
    }

    function get_press_authorization(bytes32 policy_address, bytes32 press_address)
        external view
        returns (bytes memory, bytes32, uint8, bool, uint64, uint64, uint64)
    {
        PressAuthEntry storage e = press_authorizations_map[policy_address][press_address];
        return (
            e.press_public_key,
            e.mldsa44_key_hash,
            e.key_scheme,
            e.active,
            e.next_sequence,
            e.authorized_at,
            e.revoked_at
        );
    }

    function is_press_active(bytes32 policy_address, bytes32 press_address)
        external view returns (bool)
    {
        PressAuthEntry storage e = press_authorizations_map[policy_address][press_address];
        return e.press_public_key.length == 64 && e.active;
    }

    function get_next_sequence(bytes32 policy_address, bytes32 press_address)
        external view returns (uint64)
    {
        return press_authorizations_map[policy_address][press_address].next_sequence;
    }

    function get_sub_card_entry(bytes32 sub_card_address)
        external view
        returns (bytes32, bytes memory, bytes memory, bool, uint64, uint64)
    {
        SubCardEntry storage e = sub_card_registrations_map[sub_card_address];
        return (
            e.master_card_address,
            e.registration_log_head,
            e.sub_card_doc_cid,
            e.active,
            e.registered_at,
            e.deregistered_at
        );
    }

    function get_open_offer_count(bytes32 offer_id) external view returns (uint64) {
        return open_offer_use_counts_map[offer_id];
    }

    function get_governance_keyset(uint8 body_id)
        external view
        returns (bytes memory, uint8, uint8, uint32, uint8)
    {
        GovernanceKeyset storage k = governance_keysets_map[body_id];
        return (k.keys_flat, k.key_count, k.quorum, k.version, k.key_scheme);
    }

    function is_nonce_used(bytes32 nonce) external view returns (bool) {
        return used_nonces_map[nonce];
    }

    function get_logic_contract() external view returns (address) {
        return logic_contract_addr;
    }

    function get_pending_logic_upgrade()
        external view
        returns (address, uint64, uint32, bytes32)
    {
        return (
            pending_logic_upgrade_state.proposed_address,
            pending_logic_upgrade_state.proposed_at,
            pending_logic_upgrade_state.governance_version,
            pending_logic_upgrade_state.nonce
        );
    }

    function get_pending_verifier_upgrade()
        external view
        returns (address, uint64, uint32, bytes32)
    {
        return (
            pending_verifier_addr,
            pending_verifier_at,
            pending_verifier_gov_ver,
            pending_verifier_nonce_val
        );
    }

    function get_key_scheme_phase() external view returns (uint8) {
        return key_scheme_phase_val;
    }

    // ── Setters (onlyLogic) ───────────────────────────────────────────────────

    function set_card_entry(
        bytes32 card_address,
        bytes calldata log_head_cid,
        bytes32 policy_address,
        bytes32 last_press_address,
        bool new_exists
    ) external onlyLogic {
        // Unconditional invariant: exists is write-once-true.
        if (card_entries_map[card_address].exists && !new_exists) {
            revert CardAlreadyExists();
        }
        if (log_head_cid.length > MAX_CID_LEN) revert CidTooLong();

        CardEntry storage e = card_entries_map[card_address];
        e.log_head_cid = log_head_cid;
        e.policy_address = policy_address;
        e.last_press_address = last_press_address;
        e.exists = new_exists;
    }

    function set_forward_to(bytes32 card_address, bytes32 new_forward_to) external onlyLogic {
        // Unconditional invariant: forward_to is immutable once non-zero.
        if (card_entries_map[card_address].forward_to != bytes32(0)) revert ForwardAlreadySet();
        card_entries_map[card_address].forward_to = new_forward_to;
    }

    function update_card_head(
        bytes32 card_address,
        bytes calldata new_log_cid,
        bytes32 last_press_address
    ) external onlyLogic {
        if (new_log_cid.length > MAX_CID_LEN) revert CidTooLong();
        card_entries_map[card_address].log_head_cid = new_log_cid;
        card_entries_map[card_address].last_press_address = last_press_address;
    }

    function set_press_auth_entry(
        bytes32 policy_address,
        bytes32 press_address,
        bytes calldata press_public_key,
        bytes32 mldsa44_key_hash,
        uint8 key_scheme,
        bool active,
        uint64 next_sequence,
        uint64 authorized_at,
        uint64 revoked_at
    ) external onlyLogic {
        // Unconditional invariant: revoked_at is write-once-non-zero.
        uint64 current_revoked_at = press_authorizations_map[policy_address][press_address].revoked_at;
        if (current_revoked_at != 0 && revoked_at == 0) revert RevokedAtImmutable();

        PressAuthEntry storage e = press_authorizations_map[policy_address][press_address];
        e.press_public_key = press_public_key;
        e.mldsa44_key_hash = mldsa44_key_hash;
        e.key_scheme = key_scheme;
        e.active = active;
        e.next_sequence = next_sequence;
        e.authorized_at = authorized_at;
        e.revoked_at = revoked_at;
    }

    function increment_press_sequence(bytes32 policy_address, bytes32 press_address)
        external onlyLogic
    {
        press_authorizations_map[policy_address][press_address].next_sequence++;
    }

    function set_sub_card_entry(
        bytes32 sub_card_address,
        bytes32 master_card_address,
        bytes calldata registration_log_head,
        bytes calldata sub_card_doc_cid,
        bool active,
        uint64 registered_at,
        uint64 deregistered_at
    ) external onlyLogic {
        // Unconditional invariant: deregistered_at is write-once-non-zero.
        uint64 current_dereg = sub_card_registrations_map[sub_card_address].deregistered_at;
        if (current_dereg != 0 && deregistered_at == 0) revert DeregisteredAtImmutable();
        if (registration_log_head.length > MAX_CID_LEN) revert CidTooLong();
        if (sub_card_doc_cid.length > MAX_CID_LEN) revert CidTooLong();

        SubCardEntry storage e = sub_card_registrations_map[sub_card_address];
        e.master_card_address = master_card_address;
        e.registration_log_head = registration_log_head;
        e.sub_card_doc_cid = sub_card_doc_cid;
        e.active = active;
        e.registered_at = registered_at;
        e.deregistered_at = deregistered_at;
    }

    function set_open_offer_count(bytes32 offer_id, uint64 count) external onlyLogic {
        open_offer_use_counts_map[offer_id] = count;
    }

    function set_policy_authorizer_key(bytes32 policy_address, bytes calldata authorizer_pubkey)
        external onlyLogic
    {
        if (authorizer_pubkey.length != 64) revert InvalidKeyLength();
        policy_authorizer_keys_map[policy_address] = authorizer_pubkey;
    }

    function delete_policy_authorizer_key(bytes32 policy_address) external onlyLogic {
        delete policy_authorizer_keys_map[policy_address];
    }

    function set_governance_keyset(
        uint8 body_id,
        bytes calldata keys_flat,
        uint8 key_count,
        uint8 quorum,
        uint32 version,
        uint8 key_scheme
    ) external onlyLogic {
        if (keys_flat.length != uint256(key_count) * 64) revert InvalidKeysFlat();
        governance_keysets_map[body_id] = GovernanceKeyset({
            keys_flat: keys_flat,
            key_count: key_count,
            quorum: quorum,
            version: version,
            key_scheme: key_scheme
        });
    }

    function mark_nonce_used(bytes32 nonce) external onlyLogic {
        used_nonces_map[nonce] = true;
    }

    function set_logic_contract(address new_logic_address) external onlyLogic {
        if (new_logic_address == address(0)) revert InvalidAddress();
        logic_contract_addr = new_logic_address;
    }

    function set_pending_logic_upgrade(
        address proposed_address,
        uint64 proposed_at,
        uint32 governance_version,
        bytes32 nonce
    ) external onlyLogic {
        pending_logic_upgrade_state = PendingLogicUpgrade({
            proposed_address: proposed_address,
            proposed_at: proposed_at,
            governance_version: governance_version,
            nonce: nonce
        });
    }

    function clear_pending_logic_upgrade() external onlyLogic {
        delete pending_logic_upgrade_state;
    }

    function set_pending_verifier_upgrade(
        address proposed_address,
        uint64 proposed_at,
        uint32 governance_version,
        bytes32 nonce
    ) external onlyLogic {
        pending_verifier_addr = proposed_address;
        pending_verifier_at = proposed_at;
        pending_verifier_gov_ver = governance_version;
        pending_verifier_nonce_val = nonce;
    }

    function clear_pending_verifier_upgrade() external onlyLogic {
        pending_verifier_addr = address(0);
        pending_verifier_at = 0;
        pending_verifier_gov_ver = 0;
        pending_verifier_nonce_val = bytes32(0);
    }

    function set_key_scheme_phase(uint8 phase) external onlyLogic {
        key_scheme_phase_val = phase;
    }
}
