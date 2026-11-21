//! Notary step 6.4b: §6.2 step 0 binds every governance payload to its call,
//! §4.5 W4 binds the open-offer limits, and §4.19 W6 limits path characters.
//!
//! For each operation: the spec payload is accepted; a wrong `op`, each action
//! field changed, each action field missing, and a duplicated field are refused.
use protocol_types::calldata_binding as cb;
use protocol_types::dns_path_chars_ok;

fn b64(raw: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::new();
    for c in raw.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    s
}
fn q(s: &str) -> String {
    format!("\"{s}\"")
}
fn qb(raw: &[u8]) -> String {
    q(&b64(raw))
}

/// A payload as ordered (key, JSON value) pairs plus the governance trailer.
fn payload(op: &str, fields: &[(&str, String)]) -> Vec<u8> {
    let mut all: Vec<(String, String)> = vec![("op".into(), q(op))];
    all.extend(fields.iter().map(|(k, v)| (k.to_string(), v.clone())));
    all.push(("governance_version".into(), "3".into()));
    all.push(("nonce".into(), q("bm9uY2U")));
    all.push(("timestamp".into(), q("2026-11-20T00:00:00Z")));
    let body: Vec<String> = all.iter().map(|(k, v)| format!("{}:{}", q(k), v)).collect();
    format!("{{{}}}", body.join(",")).into_bytes()
}

struct Case<'a> {
    name: &'a str,
    op: &'a str,
    /// (field, correct value, a wrong value)
    fields: Vec<(&'a str, String, String)>,
    check: Box<dyn Fn(&[u8]) -> bool + 'a>,
}

fn run(c: &Case) {
    let good: Vec<(&str, String)> = c.fields.iter().map(|(k, v, _)| (*k, v.clone())).collect();
    assert!((c.check)(&payload(c.op, &good)), "{}: spec payload accepted", c.name);
    assert!(!(c.check)(&payload("register_policy_x", &good)), "{}: wrong op", c.name);
    let other_op = if c.op == "deregister_policy" { "register_policy" } else { "deregister_policy" };
    assert!(!(c.check)(&payload(other_op, &good)), "{}: another operation's op", c.name);
    for (i, (k, _, wrong)) in c.fields.iter().enumerate() {
        let mut changed = good.clone();
        changed[i].1 = wrong.clone();
        assert!(!(c.check)(&payload(c.op, &changed)), "{}: changed {k}", c.name);
        let mut missing = good.clone();
        missing.remove(i);
        assert!(!(c.check)(&payload(c.op, &missing)), "{}: missing {k}", c.name);
        let mut dup = good.clone();
        dup.push((k, good[i].1.clone()));
        assert!(!(c.check)(&payload(c.op, &dup)), "{}: duplicate {k}", c.name);
    }
}

const POLICY: [u8; 32] = [0x31; 32];
const PRESS: [u8; 32] = [0x32; 32];
const OTHER32: [u8; 32] = [0x39; 32];
const KEY64: [u8; 64] = [0x41; 64];
const OTHER64: [u8; 64] = [0x49; 64];
const ADDR20: [u8; 20] = [0x51; 20];
const OTHER20: [u8; 20] = [0x59; 20];

#[test]
fn every_governance_operation_binds_op_and_every_action_field() {
    let keys: Vec<u8> = (0..3u8).flat_map(|i| [0x60 + i; 64]).collect();
    let paths: Vec<&[u8]> = vec![b"/a", b"/b/c"];
    let cases = vec![
        Case { name: "RegisterPolicy", op: "register_policy",
            fields: vec![("policy_address", qb(&POLICY), qb(&OTHER32)), ("authorizer_pubkey", qb(&KEY64), qb(&OTHER64))],
            check: Box::new(|p| cb::gov_register_policy(p, &POLICY, &KEY64)) },
        Case { name: "DeregisterPolicy", op: "deregister_policy",
            fields: vec![("policy_address", qb(&POLICY), qb(&OTHER32))],
            check: Box::new(|p| cb::gov_deregister_policy(p, &POLICY)) },
        Case { name: "AuthorizePress", op: "authorize_press",
            fields: vec![
                ("policy_address", qb(&POLICY), qb(&OTHER32)),
                ("press_address", qb(&PRESS), qb(&OTHER32)),
                ("press_pubkey", qb(&KEY64), qb(&OTHER64)),
                ("mldsa44_key_hash", qb(&OTHER32), qb(&PRESS)),
            ],
            check: Box::new(|p| cb::gov_authorize_press(p, &POLICY, &PRESS, &KEY64, &OTHER32)) },
        Case { name: "RevokePress", op: "revoke_press",
            fields: vec![("policy_address", qb(&POLICY), qb(&OTHER32)), ("press_address", qb(&PRESS), qb(&OTHER32))],
            check: Box::new(|p| cb::gov_revoke_press(p, &POLICY, &PRESS)) },
        Case { name: "RotateAuthorizerKey", op: "rotate_authorizer_key",
            fields: vec![("policy_address", qb(&POLICY), qb(&OTHER32)), ("new_authorizer_key", qb(&KEY64), qb(&OTHER64))],
            check: Box::new(|p| cb::gov_rotate_authorizer_key(p, &POLICY, &KEY64)) },
        Case { name: "RotateGovernanceKeys", op: "rotate_governance_keys",
            fields: vec![
                ("body_id", "1".into(), "0".into()),
                ("new_keys", format!("[{},{},{}]", qb(&keys[..64]), qb(&keys[64..128]), qb(&keys[128..])),
                    // same keys, reordered
                    format!("[{},{},{}]", qb(&keys[64..128]), qb(&keys[..64]), qb(&keys[128..]))),
                ("new_quorum", "2".into(), "3".into()),
            ],
            check: Box::new(|p| cb::gov_rotate_governance_keys(p, 1, &keys, 3, 2)) },
        Case { name: "SetProtocolVersion", op: "set_protocol_version",
            fields: vec![("new_version", q("0.2"), q("0.3"))],
            check: Box::new(|p| cb::gov_set_protocol_version(p, b"0.2")) },
        Case { name: "ProposeLogicUpgrade", op: "propose_logic_upgrade",
            fields: vec![("new_logic_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_propose_logic_upgrade(p, &ADDR20)) },
        Case { name: "ConfirmLogicUpgrade", op: "confirm_logic_upgrade",
            fields: vec![("proposed_logic_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_confirm_logic_upgrade(p, &ADDR20)) },
        Case { name: "CancelLogicUpgrade", op: "cancel_logic_upgrade",
            fields: vec![("proposed_logic_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_cancel_logic_upgrade(p, &ADDR20)) },
        Case { name: "ProposeVerifierUpgrade", op: "propose_verifier_upgrade",
            fields: vec![("new_verifier_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_propose_verifier_upgrade(p, &ADDR20)) },
        Case { name: "ConfirmVerifierUpgrade", op: "confirm_verifier_upgrade",
            fields: vec![("proposed_verifier_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_confirm_verifier_upgrade(p, &ADDR20)) },
        Case { name: "CancelVerifierUpgrade", op: "cancel_verifier_upgrade",
            fields: vec![("proposed_verifier_address", qb(&ADDR20), qb(&OTHER20))],
            check: Box::new(|p| cb::gov_cancel_verifier_upgrade(p, &ADDR20)) },
        Case { name: "RegisterDomain", op: "register_domain",
            fields: vec![
                ("domain", q("example.org"), q("example.com")),
                ("admin_card_address", qb(&POLICY), qb(&OTHER32)),
                ("admin_secp256r1_key", qb(&KEY64), qb(&OTHER64)),
            ],
            check: Box::new(|p| cb::gov_register_domain(p, b"example.org", &POLICY, &KEY64)) },
        Case { name: "DeregisterDomain", op: "deregister_domain",
            fields: vec![("domain", q("example.org"), q("example.com"))],
            check: Box::new(|p| cb::gov_deregister_domain(p, b"example.org")) },
        Case { name: "RemovePolicyAddress (path B)", op: "governance_remove_policy_address",
            fields: vec![("domain", q("example.org"), q("example.com")), ("path", q("/a"), q("/b"))],
            check: Box::new(|p| cb::gov_remove_policy_address(p, b"example.org", b"/a")) },
        Case { name: "ClearDomainEntries", op: "clear_domain_entries",
            fields: vec![
                ("domain", q("example.org"), q("example.com")),
                ("paths", format!("[{},{}]", q("/a"), q("/b/c")), format!("[{}]", q("/a"))),
            ],
            check: Box::new(|p| cb::gov_clear_domain_entries(p, b"example.org", &paths)) },
        Case { name: "FlagDomainFraudRisk", op: "flag_domain_fraud_risk",
            fields: vec![
                ("domain", q("example.org"), q("example.com")),
                ("fraud_risk", "2".into(), "1".into()),
                ("suspension_expires_at", "1800000000".into(), "1800000001".into()),
            ],
            check: Box::new(|p| cb::gov_flag_domain_fraud_risk(p, b"example.org", 2, 1_800_000_000)) },
        Case { name: "GovernanceSetPolicyAddress", op: "governance_set_policy_address",
            fields: vec![
                ("domain", q("example.org"), q("example.com")),
                ("path", q("/a"), q("/b")),
                ("policy_card_address", qb(&POLICY), qb(&OTHER32)),
            ],
            check: Box::new(|p| cb::gov_set_policy_address(p, b"example.org", b"/a", &POLICY)) },
        Case { name: "SetDnsGovernancePolicyAddress", op: "set_dns_governance_policy_address",
            fields: vec![("new_policy_address", qb(&POLICY), qb(&OTHER32))],
            check: Box::new(|p| cb::gov_set_dns_governance_policy_address(p, &POLICY)) },
    ];
    for c in &cases {
        run(c);
    }
    // DisablePolicyDeletePermanently has no action fields: op is the binding.
    assert!(cb::gov_disable_policy_delete_permanently(&payload("disable_policy_delete_permanently", &[])));
    assert!(!cb::gov_disable_policy_delete_permanently(&payload("deregister_policy", &[])));
    assert_eq!(cases.len() + 1, 21, "21 operations here; path A of RemovePolicyAddress is 6.4a's");
}

#[test]
fn path_a_and_path_b_removal_payloads_never_satisfy_each_other() {
    let a = payload("remove_policy_address", &[("domain", q("example.org")), ("path", q("/a"))]);
    assert!(!cb::gov_remove_policy_address(&a, b"example.org", b"/a"));
    let b = payload("governance_remove_policy_address", &[("domain", q("example.org")), ("path", q("/a")), ("card_address", qb(&POLICY)), ("press_address", qb(&PRESS))]);
    // Path A's op is checked by the write gate (verify_op), not by the field binding: a path B
    // payload, even carrying path A's fields, fails it.
    assert!(!protocol_types::payload_parser::verify_op(&b, b"remove_policy_address"));
}

#[test]
fn rotate_governance_keys_refuses_a_count_that_does_not_split_the_keys() {
    let keys = [0x61u8; 192];
    let p = payload("rotate_governance_keys", &[("body_id", "0".into()), ("new_keys", format!("[{},{},{}]", qb(&keys[..64]), qb(&keys[64..128]), qb(&keys[128..]))), ("new_quorum", "2".into())]);
    assert!(cb::gov_rotate_governance_keys(&p, 0, &keys, 3, 2));
    assert!(!cb::gov_rotate_governance_keys(&p, 0, &keys, 0, 2));
    assert!(!cb::gov_rotate_governance_keys(&p, 0, &keys[..191], 3, 2));
    assert!(!cb::gov_rotate_governance_keys(&p, 0, &keys, 2, 2), "two keys of 96 bytes are not these three");
    // fewer keys in the payload than the calldata
    let short = payload("rotate_governance_keys", &[("body_id", "0".into()), ("new_keys", format!("[{},{}]", qb(&keys[..64]), qb(&keys[64..128]))), ("new_quorum", "2".into())]);
    assert!(!cb::gov_rotate_governance_keys(&short, 0, &keys, 3, 2));
    // a body_id written as a string is not the number
    let s = payload("rotate_governance_keys", &[("body_id", q("0")), ("new_keys", format!("[{},{},{}]", qb(&keys[..64]), qb(&keys[64..128]), qb(&keys[128..]))), ("new_quorum", "2".into())]);
    assert!(!cb::gov_rotate_governance_keys(&s, 0, &keys, 3, 2));
}

#[test]
fn clear_domain_entries_compares_every_path() {
    let paths: Vec<&[u8]> = vec![b"/a", b"/b/c"];
    let p = |list: &str| payload("clear_domain_entries", &[("domain", q("example.org")), ("paths", list.to_string())]);
    assert!(cb::gov_clear_domain_entries(&p(r#"["/a","/b/c"]"#), b"example.org", &paths));
    assert!(!cb::gov_clear_domain_entries(&p(r#"["/a","/b/x"]"#), b"example.org", &paths), "a changed element");
    assert!(!cb::gov_clear_domain_entries(&p(r#"["/b/c","/a"]"#), b"example.org", &paths), "reordered");
    assert!(!cb::gov_clear_domain_entries(&p(r#"["/a","/b/c","/d"]"#), b"example.org", &paths), "longer");
    assert!(!cb::gov_clear_domain_entries(&p(r#"["/a","\/b/c"]"#), b"example.org", &paths), "escaped");
    let none: Vec<&[u8]> = vec![];
    assert!(cb::gov_clear_domain_entries(&p("[]"), b"example.org", &none));
}

#[test]
fn numbers_have_exactly_one_accepted_form() {
    for v in [0u64, 7, 10, 1_800_000_000, u64::MAX] {
        assert!(cb::is_decimal_of(v.to_string().as_bytes(), v), "{v}");
    }
    assert!(!cb::is_decimal_of(b"07", 7));
    assert!(!cb::is_decimal_of(b"7.0", 7));
    assert!(!cb::is_decimal_of(b"7e0", 7));
    assert!(!cb::is_decimal_of(b"-0", 0));
    assert!(!cb::is_decimal_of(b"", 0));
}

#[test]
fn open_offer_limits_bind_null_to_the_sentinel_and_numbers_to_themselves() {
    let offer = [0x71u8; 32];
    let card = [0x72u8; 32];
    let cid = b"bafy-genesis";
    let claim = |max: &str, exp: &str| {
        format!(
            r#"{{"card_address":{},"expires_at":{exp},"initial_log_cid":{},"max_acceptances":{max},"offer_id":{},"op":"claim_open_offer","policy_address":{},"press_address":{},"sequence":4,"timestamp":"2026-11-20T00:00:00Z"}}"#,
            qb(&card), qb(cid), qb(&offer), qb(&POLICY), qb(&PRESS)
        )
        .into_bytes()
    };
    let ok = |p: &[u8], max: u64, exp: u64| cb::claim_open_offer_with_limits(p, &offer, max, exp, &card, cid, &POLICY, &PRESS);

    // unconstrained: null, null with the sentinels
    assert!(ok(&claim("null", "null"), u64::MAX, 0));
    // limited: numbers equal to the calldata
    assert!(ok(&claim("5", "1800000000"), 5, 1_800_000_000));
    // the attack W4 closes: a limited offer submitted as unconstrained
    assert!(!ok(&claim("5", "1800000000"), u64::MAX, 0));
    assert!(!ok(&claim("5", "1800000000"), 6, 1_800_000_000));
    assert!(!ok(&claim("5", "1800000000"), 5, 1_900_000_000));
    // null only stands for the sentinel
    assert!(!ok(&claim("null", "null"), 5, 0));
    assert!(!ok(&claim("null", "null"), u64::MAX, 1_800_000_000));
    // a number never stands for the sentinel
    assert!(!ok(&claim("18446744073709551615", "null"), u64::MAX, 0));
    assert!(!ok(&claim("null", "0"), u64::MAX, 0));
    // numbers above 2^53 - 1 can't be signed exactly by a JavaScript press
    let big = cb::JS_SAFE_MAX + 1;
    assert!(ok(&claim(&cb::JS_SAFE_MAX.to_string(), "null"), cb::JS_SAFE_MAX, 0));
    assert!(!ok(&claim(&big.to_string(), "null"), big, 0));
    // missing limits (the pre-6.4b press payload) are refused
    let old = format!(
        r#"{{"card_address":{},"initial_log_cid":{},"offer_id":{},"op":"claim_open_offer","policy_address":{},"press_address":{},"sequence":4}}"#,
        qb(&card), qb(cid), qb(&offer), qb(&POLICY), qb(&PRESS)
    );
    assert!(!ok(old.as_bytes(), u64::MAX, 0));
    // a quoted number is not a number
    assert!(!ok(&claim("\"5\"", "null"), 5, 0));
}

#[test]
fn dns_path_rule_refuses_exactly_the_characters_json_escapes() {
    assert!(dns_path_chars_ok(b""));
    assert!(dns_path_chars_ok(b"/members/2026"));
    assert!(dns_path_chars_ok("/caf\u{e9}".as_bytes()), "non-ASCII UTF-8 is fine");
    assert!(dns_path_chars_ok(b"/a b~!'"));
    for bad in [&b"/a\"b"[..], b"/a\\b", b"/a\nb", b"/a\x00", b"\x1f", b"\t"] {
        assert!(!dns_path_chars_ok(bad), "{bad:?}");
    }
    assert!(dns_path_chars_ok(b"\x20\x7f"));
}
