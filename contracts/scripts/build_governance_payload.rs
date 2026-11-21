//! build_governance_payload — build the canonical JSON governance payload for one
//! quorum-gated operation (`registry_contract.md §4`, §6.2).
//!
//! Since notary step 6.4b the contract checks `op` and every action field of the
//! payload against the calldata (§6.2 step 0, E-49). This builder therefore:
//! - requires every action field of the operation, and has no defaults;
//! - writes bytes (bytes32, EVM addresses, keys) as unpadded base64url, converting
//!   from the `0x…` hex the shell scripts hold;
//! - writes integers as JSON numbers and strings without escapes (a string that
//!   would need one is refused, as the contract would refuse it);
//! - sorts keys (RFC 8785 order; every value here is canonical as written).
//!
//! # Usage
//!
//!   build_governance_payload --op <op> --version <governance_version> [--nonce <s>] \
//!     [--b64 name=0x<hex>]... [--num name=<n>]... [--str name=<text>]... \
//!     [--keys name=0x<flat hex>:<count>] [--strs name=<a>,<b>,...]
//!
//! Examples:
//!   build_governance_payload --op register_policy --version 0 \
//!     --b64 policy_address=0x<32 bytes> --b64 authorizer_pubkey=0x<64 bytes>
//!   build_governance_payload --op rotate_governance_keys --version 0 \
//!     --num body_id=0 --keys new_keys=0x<3×64 bytes>:3 --num new_quorum=2
//!
//! Prints the payload with no trailing newline (for `vm.ffi` and `$(...)`).
use rand_core::{OsRng, RngCore};
use serde_json::{Map, Value};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

/// Action fields per operation (§4). The builder refuses a missing or extra one.
const OPS: &[(&str, &[&str])] = &[
    ("register_policy", &["policy_address", "authorizer_pubkey"]),
    ("deregister_policy", &["policy_address"]),
    ("authorize_press", &["policy_address", "press_address", "press_pubkey", "mldsa44_key_hash"]),
    ("revoke_press", &["policy_address", "press_address"]),
    ("rotate_authorizer_key", &["policy_address", "new_authorizer_key"]),
    ("rotate_governance_keys", &["body_id", "new_keys", "new_quorum"]),
    ("set_protocol_version", &["new_version"]),
    ("disable_policy_delete_permanently", &[]),
    ("propose_logic_upgrade", &["new_logic_address"]),
    ("confirm_logic_upgrade", &["proposed_logic_address"]),
    ("cancel_logic_upgrade", &["proposed_logic_address"]),
    ("propose_verifier_upgrade", &["new_verifier_address"]),
    ("confirm_verifier_upgrade", &["proposed_verifier_address"]),
    ("cancel_verifier_upgrade", &["proposed_verifier_address"]),
    ("register_domain", &["domain", "admin_card_address", "admin_secp256r1_key"]),
    ("deregister_domain", &["domain"]),
    ("governance_remove_policy_address", &["domain", "path"]),
    ("clear_domain_entries", &["domain", "paths"]),
    ("flag_domain_fraud_risk", &["domain", "fraud_risk", "suspension_expires_at"]),
    ("governance_set_policy_address", &["domain", "path", "policy_card_address"]),
    ("set_dns_governance_policy_address", &["new_policy_address"]),
];

fn die(msg: &str) -> ! {
    eprintln!("build_governance_payload: {msg}");
    std::process::exit(2);
}

fn b64url(raw: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

fn hex_bytes(s: &str, what: &str) -> Vec<u8> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(h).unwrap_or_else(|_| die(&format!("{what}: not hex: {s}")))
}

/// A string the contract compares byte for byte must need no JSON escape.
fn plain(s: &str, what: &str) -> String {
    if s.bytes().any(|b| b == b'"' || b == b'\\' || b < 0x20) {
        die(&format!("{what}: contains a character JSON escapes (\", \\ or a control character)"));
    }
    s.to_string()
}

fn split_kv(s: &str) -> (&str, &str) {
    s.split_once('=').unwrap_or_else(|| die(&format!("expected name=value, got {s}")))
}

fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (sec, min, hour) = (secs % 60, (secs / 60) % 60, (secs / 3600) % 24);
    let mut days = secs / 86400;
    let mut year = 1970u64;
    let leap = |y: u64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    loop {
        let n = if leap(year) { 366 } else { 365 };
        if days < n {
            break;
        }
        days -= n;
        year += 1;
    }
    let md = [31, if leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for m in md {
        if days < m {
            break;
        }
        days -= m;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{hour:02}:{min:02}:{sec:02}Z", days + 1)
}

fn main() {
    let raw: Vec<String> = env::args().skip(1).collect();
    let mut op = String::new();
    let mut version: Option<u64> = None;
    let mut nonce: Option<String> = None;
    let mut fields = Map::new();
    let mut it = raw.iter();
    while let Some(flag) = it.next() {
        let val = it.next().unwrap_or_else(|| die(&format!("{flag} needs a value")));
        match flag.as_str() {
            "--op" => op = val.clone(),
            "--version" => version = Some(val.parse().unwrap_or_else(|_| die("--version must be a number"))),
            "--nonce" => nonce = Some(plain(val, "--nonce")),
            "--b64" => {
                let (k, v) = split_kv(val);
                fields.insert(k.into(), Value::String(b64url(&hex_bytes(v, k))));
            }
            "--num" => {
                let (k, v) = split_kv(val);
                let n: u64 = v.parse().unwrap_or_else(|_| die(&format!("{k}: not a number: {v}")));
                fields.insert(k.into(), Value::from(n));
            }
            "--str" => {
                let (k, v) = split_kv(val);
                fields.insert(k.into(), Value::String(plain(v, k)));
            }
            "--strs" => {
                let (k, v) = split_kv(val);
                let items: Vec<Value> = if v.is_empty() { vec![] } else { v.split(',').map(|s| Value::String(plain(s, k))).collect() };
                fields.insert(k.into(), Value::Array(items));
            }
            "--keys" => {
                let (k, v) = split_kv(val);
                let (flat, count) = v.rsplit_once(':').unwrap_or_else(|| die("--keys needs 0x<flat>:<count>"));
                let flat = hex_bytes(flat, k);
                let count: usize = count.parse().unwrap_or_else(|_| die("--keys count must be a number"));
                if count == 0 || flat.len() % count != 0 {
                    die(&format!("{k}: {} bytes don't split into {count} keys", flat.len()));
                }
                let size = flat.len() / count;
                fields.insert(k.into(), Value::Array(flat.chunks(size).map(|c| Value::String(b64url(c))).collect()));
            }
            other => die(&format!("unknown flag {other}")),
        }
    }
    let required = OPS
        .iter()
        .find(|(name, _)| *name == op)
        .map(|(_, f)| *f)
        .unwrap_or_else(|| die(&format!("unknown --op {op:?}")));
    for f in required {
        if !fields.contains_key(*f) {
            die(&format!("{op} needs {f}"));
        }
    }
    for k in fields.keys() {
        if !required.contains(&k.as_str()) {
            die(&format!("{op} has no field {k}"));
        }
    }
    let version = version.unwrap_or_else(|| die("--version is required"));
    let nonce = nonce.unwrap_or_else(|| {
        let mut b = [0u8; 32];
        OsRng.fill_bytes(&mut b);
        b64url(&b)
    });
    fields.insert("op".into(), Value::String(op));
    fields.insert("governance_version".into(), Value::from(version));
    fields.insert("nonce".into(), Value::String(nonce));
    fields.insert("timestamp".into(), Value::String(timestamp()));
    // serde_json's Map is a BTreeMap here (no preserve_order), so keys come out sorted.
    print!("{}", serde_json::to_string(&Value::Object(fields)).unwrap());
}
