//! build_governance_payload — Build canonical JSON payloads for governance operations.
//!
//! Produces RFC 8785-ordered JSON (lexicographic field order) that is parseable by
//! `protocol_types::payload_parser::extract_governance_version` and `extract_nonce_bytes`.
//!
//! # Usage
//!
//! Register policy:
//!   cargo run --bin build_governance_payload -- \
//!     --op register_policy --version 0 --nonce abc123
//!
//! Rotate governance keys (3 new keys, quorum 2):
//!   cargo run --bin build_governance_payload -- \
//!     --op rotate_governance_keys --body 0 --version 0 --nonce abc123 \
//!     --new-key-count 3 --new-quorum 2 \
//!     --new-keys-hex 0x<64bytes_key0>0x<64bytes_key1>0x<64bytes_key2>
//!
//! Propose logic upgrade:
//!   cargo run --bin build_governance_payload -- \
//!     --op propose_logic_upgrade --version 0 --nonce abc123 \
//!     --address 0xdeadbeef...
//!
//! # Output
//!
//! Prints the canonical JSON payload string to stdout (no trailing newline).
//! Pipe to sign_payload to produce a signature:
//!   PAYLOAD=$(cargo run --bin build_governance_payload -- --op register_policy --version 0)
//!   SIG=$(cargo run --bin sign_payload -- --key .keys/test_press.key --payload "$PAYLOAD")
//!
//! # Field order (RFC 8785 — lexicographic)
//!
//! The `payload_parser` uses substring matching, so order does not affect parsing.
//! However RFC 8785 canonical order is used here for determinism and auditability:
//!   governance_version < nonce < op < (op-specific fields)

use rand_core::{OsRng, RngCore};
use std::env;

fn random_nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

struct Args {
    op: String,
    body: u8,
    version: u32,
    nonce: Option<String>,
    // rotate_governance_keys
    new_key_count: Option<u8>,
    new_quorum: Option<u8>,
    new_keys_hex: Option<String>,
    // propose_logic_upgrade / propose_verifier_upgrade
    address: Option<String>,
    // Extra: authorize_press fields
    policy: Option<String>,
    press: Option<String>,
    press_pubkey: Option<String>,
}

fn parse_args() -> Args {
    let raw: Vec<String> = env::args().collect();
    let mut op = String::new();
    let mut body: u8 = 0;
    let mut version: u32 = 0;
    let mut nonce: Option<String> = None;
    let mut new_key_count: Option<u8> = None;
    let mut new_quorum: Option<u8> = None;
    let mut new_keys_hex: Option<String> = None;
    let mut address: Option<String> = None;
    let mut policy: Option<String> = None;
    let mut press: Option<String> = None;
    let mut press_pubkey: Option<String> = None;

    let mut i = 1usize;
    while i < raw.len() {
        match raw[i].as_str() {
            "--op" => { i += 1; op = raw[i].clone(); }
            "--body" => { i += 1; body = raw[i].parse().expect("--body must be 0 or 1"); }
            "--version" => { i += 1; version = raw[i].parse().expect("--version must be u32"); }
            "--nonce" => { i += 1; nonce = Some(raw[i].clone()); }
            "--new-key-count" => { i += 1; new_key_count = Some(raw[i].parse().expect("u8")); }
            "--new-quorum" => { i += 1; new_quorum = Some(raw[i].parse().expect("u8")); }
            "--new-keys-hex" => { i += 1; new_keys_hex = Some(raw[i].clone()); }
            "--address" => { i += 1; address = Some(raw[i].clone()); }
            "--policy" => { i += 1; policy = Some(raw[i].clone()); }
            "--press" => { i += 1; press = Some(raw[i].clone()); }
            "--press-pubkey" => { i += 1; press_pubkey = Some(raw[i].clone()); }
            _ => {}
        }
        i += 1;
    }

    assert!(!op.is_empty(), "--op <operation_name> is required");

    Args { op, body, version, nonce, new_key_count, new_quorum, new_keys_hex, address, policy, press, press_pubkey }
}

fn main() {
    let args = parse_args();
    let nonce = args.nonce.unwrap_or_else(random_nonce);

    // Build RFC 8785-ordered JSON (fields in lexicographic order).
    // governance_version < nonce < op < (op-specific)
    let payload = match args.op.as_str() {
        "register_policy" | "deregister_policy" | "disable_policy_delete_permanently" => {
            format!(
                r#"{{"governance_version":{},"nonce":"{}","op":"{}"}}"#,
                args.version, nonce, args.op
            )
        }

        "authorize_press" => {
            // Fields: governance_version, nonce, op, policy, press, press_pubkey
            // Lexicographic: governance_version < nonce < op < policy < press < press_pubkey
            let policy = args.policy.unwrap_or_else(|| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string());
            let press = args.press.unwrap_or_else(|| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string());
            let press_pubkey = args.press_pubkey.unwrap_or_else(|| "0x".to_string() + &"00".repeat(64));
            format!(
                r#"{{"governance_version":{},"nonce":"{}","op":"authorize_press","policy":"{}","press":"{}","press_pubkey":"{}"}}"#,
                args.version, nonce, policy, press, press_pubkey
            )
        }

        "revoke_press" => {
            let policy = args.policy.unwrap_or_else(|| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string());
            let press = args.press.unwrap_or_else(|| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string());
            format!(
                r#"{{"governance_version":{},"nonce":"{}","op":"revoke_press","policy":"{}","press":"{}"}}"#,
                args.version, nonce, policy, press
            )
        }

        "rotate_authorizer_key" => {
            let policy = args.policy.unwrap_or_else(|| "0x0000000000000000000000000000000000000000000000000000000000000000".to_string());
            let new_key = args.press_pubkey.unwrap_or_else(|| "0x".to_string() + &"00".repeat(64));
            // Fields: governance_version < nonce < new_key < op < policy
            format!(
                r#"{{"governance_version":{},"new_key":"{}","nonce":"{}","op":"rotate_authorizer_key","policy":"{}"}}"#,
                args.version, new_key, nonce, policy
            )
        }

        "rotate_governance_keys" => {
            let key_count = args.new_key_count.unwrap_or(3);
            let quorum = args.new_quorum.unwrap_or(2);
            let keys = args.new_keys_hex.unwrap_or_else(|| "0x".to_string() + &"00".repeat(64 * key_count as usize));
            // Fields: body < governance_version < key_count < keys < nonce < op < quorum
            format!(
                r#"{{"body":{},"governance_version":{},"key_count":{},"keys":"{}","nonce":"{}","op":"rotate_governance_keys","quorum":{}}}"#,
                args.body, args.version, key_count, keys, nonce, quorum
            )
        }

        "propose_logic_upgrade" | "cancel_logic_upgrade" => {
            let addr = args.address.unwrap_or_else(|| "0x0000000000000000000000000000000000000000".to_string());
            // Fields: address < governance_version < nonce < op
            format!(
                r#"{{"address":"{}","governance_version":{},"nonce":"{}","op":"{}"}}"#,
                addr, args.version, nonce, args.op
            )
        }

        "propose_verifier_upgrade" | "cancel_verifier_upgrade" => {
            let addr = args.address.unwrap_or_else(|| "0x0000000000000000000000000000000000000000".to_string());
            format!(
                r#"{{"address":"{}","governance_version":{},"nonce":"{}","op":"{}"}}"#,
                addr, args.version, nonce, args.op
            )
        }

        other => {
            // Generic fallback: just governance_version, nonce, op
            format!(
                r#"{{"governance_version":{},"nonce":"{}","op":"{}"}}"#,
                args.version, nonce, other
            )
        }
    };

    // No trailing newline for vm.ffi compatibility.
    print!("{}", payload);
}
