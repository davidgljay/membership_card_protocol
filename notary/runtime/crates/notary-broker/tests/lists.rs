//! Algorithm L in the broker (runtime §12; lifecycle A.5; §34), and the shared vectors `notary/vectors/lists/cases.json`
//! that the TypeScript `verifyListApproval` must judge identically (vectors-tools `test/lists.test.ts`).
//! Regenerate: `NOTARY_WRITE_VECTORS=1 cargo test -p notary-broker --test lists`.
use notary_broker::lists::*;
use notary_crypto::{ChainKey, MlDsaKey};
use notary_types::{b64u, jcs};
use serde_json::{json, Value};

enum Signer {
    Ecdsa(ChainKey),
    MlDsa(MlDsaKey),
}

impl Signer {
    fn public(&self) -> Vec<u8> {
        match self {
            Self::Ecdsa(k) => k.public_key_xy(),
            Self::MlDsa(k) => k.public_key().to_vec(),
        }
    }
    fn sign(&self, d: &[u8; 32]) -> Vec<u8> {
        match self {
            Self::Ecdsa(k) => k.sign_digest(d).unwrap(),
            Self::MlDsa(k) => k.sign(d),
        }
    }
}

struct Members {
    signers: Vec<Signer>,
    keyset: Keyset,
}

fn members(scheme: u8, version: u32) -> Members {
    let signers: Vec<Signer> = (0..5).map(|_| if scheme == 0 { Signer::Ecdsa(ChainKey::generate()) } else { Signer::MlDsa(MlDsaKey::generate()) }).collect();
    let keyset = Keyset { keys: signers.iter().map(Signer::public).collect(), quorum: 4, version, key_scheme: scheme };
    Members { signers, keyset }
}

const RT_CARD: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

fn runtime(pcr: u8, retired: Option<(&str, &str)>) -> Value {
    let mut e = json!({ "accepted_from": "2026-01-01T00:00:00Z", "build_recipe_cid": "bafkreib", "close_compat": "c1",
        "pcr0": b64u::encode(&[pcr; 48]), "platform": "simulator", "source_commit": "abc", "version": "1" });
    if let Some((at, why)) = retired {
        e["retired_at"] = json!(at);
        e["retire_reason"] = json!(why);
    }
    e
}

#[allow(clippy::too_many_arguments)]
fn approval(m: &Members, value: &Value, version: u64, prev: Option<&Value>, kind: &str, gov: u32, signer_idx: &[usize], list: &str) -> String {
    let mut a = json!({ "governance_version": gov, "kind": kind, "list": list, "list_card": RT_CARD,
        "list_hash": jcs::h(value).unwrap(), "list_version": version, "signatures": [], "type": "notary_list_approval" });
    if let Some(p) = prev {
        a["prev_list_hash"] = json!(jcs::h(p).unwrap());
    }
    let d = approval_digest(&a).unwrap();
    a["signatures"] = Value::Array(signer_idx.iter().map(|i| json!({ "key_index": i, "signature": b64u::encode(&m.signers[*i].sign(&d)) })).collect());
    String::from_utf8(jcs::canonical(&a).unwrap()).unwrap()
}

fn ver(value: Value, approval: Option<String>) -> ListVersion {
    ListVersion { value, approval_text: approval }
}

fn cases() -> Vec<(&'static str, Keyset, Vec<ListVersion>, Result<u64, &'static str>)> {
    let e = members(0, 8);
    let m = members(1, 3);
    let l = "accepted_runtimes";
    let v1 = json!([runtime(1, None), runtime(2, None)]);
    let v2 = json!([runtime(1, None), runtime(2, None), runtime(3, None)]);
    let v2_retired = json!([runtime(1, Some(("2026-06-01T00:00:00Z", "vulnerable"))), runtime(2, None), runtime(3, None)]);
    let v2_added = json!([runtime(1, Some(("2026-06-01T00:00:00Z", "vulnerable"))), runtime(2, None), runtime(3, None), runtime(4, None)]);
    let v1_late = json!([runtime(1, Some(("2026-03-01T00:00:00Z", "superseded"))), runtime(2, None)]);
    let v1_later = json!([runtime(1, Some(("2026-09-01T00:00:00Z", "vulnerable"))), runtime(2, None)]);
    let all = [0, 1, 2, 3];
    let mut out = vec![];
    out.push(("standard_v1_ecdsa_ok", e.keyset.clone(), vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &all, l)))], Ok(1)));
    out.push((
        "standard_v2_mldsa_ok",
        m.keyset.clone(),
        vec![ver(v1.clone(), Some(approval(&m, &v1, 1, None, "standard", 3, &all, l))), ver(v2.clone(), Some(approval(&m, &v2, 2, Some(&v1), "standard", 3, &[1, 2, 3, 4], l)))],
        Ok(2),
    ));
    out.push(("missing", e.keyset.clone(), vec![ver(v1.clone(), None)], Err("LIST_APPROVAL_MISSING")));
    out.push(("malformed_wrong_list", e.keyset.clone(), vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &all, "program_allowlist")))], Err("LIST_APPROVAL_MALFORMED")));
    out.push(("hash_mismatch_list_changed", e.keyset.clone(), vec![ver(v2.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &all, l)))], Err("LIST_APPROVAL_HASH_MISMATCH")));
    out.push((
        "hash_mismatch_version_gap",
        e.keyset.clone(),
        vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &all, l))), ver(v2.clone(), Some(approval(&e, &v2, 3, Some(&v1), "standard", 8, &all, l)))],
        Err("LIST_APPROVAL_HASH_MISMATCH"),
    ));
    out.push(("keyset_stale", e.keyset.clone(), vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 7, &all, l)))], Err("LIST_APPROVAL_KEYSET_STALE")));
    out.push(("threshold_three_of_four", e.keyset.clone(), vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &[0, 1, 2], l)))], Err("LIST_APPROVAL_THRESHOLD")));
    out.push(("threshold_duplicate_signer", e.keyset.clone(), vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &[0, 0, 1, 1], l)))], Err("LIST_APPROVAL_THRESHOLD")));
    let std_v1 = approval(&e, &v2, 1, None, "standard", 8, &all, l);
    out.push((
        "emergency_two_of_five_ok",
        e.keyset.clone(),
        vec![ver(v2.clone(), Some(std_v1.clone())), ver(v2_retired.clone(), Some(approval(&e, &v2_retired, 2, Some(&v2), "emergency_retirement", 8, &[3, 4], l)))],
        Ok(2),
    ));
    out.push((
        "emergency_adds_entry",
        e.keyset.clone(),
        vec![ver(v2.clone(), Some(std_v1.clone())), ver(v2_added.clone(), Some(approval(&e, &v2_added, 2, Some(&v2), "emergency_retirement", 8, &[3, 4], l)))],
        Err("LIST_APPROVAL_NOT_REMOVAL_ONLY"),
    ));
    out.push((
        "emergency_over_unapproved_version",
        e.keyset.clone(),
        vec![ver(v2.clone(), Some(approval(&e, &v2, 1, None, "standard", 8, &[0, 1], l))), ver(v2_retired.clone(), Some(approval(&e, &v2_retired, 2, Some(&v2), "emergency_retirement", 8, &[3, 4], l)))],
        Err("LIST_APPROVAL_THRESHOLD"),
    ));
    out.push((
        "emergency_moves_retirement_later",
        e.keyset.clone(),
        vec![ver(v1_late.clone(), Some(approval(&e, &v1_late, 1, None, "standard", 8, &all, l))), ver(v1_later.clone(), Some(approval(&e, &v1_later, 2, Some(&v1_late), "emergency_retirement", 8, &[3, 4], l)))],
        Err("LIST_APPROVAL_NOT_REMOVAL_ONLY"),
    ));
    out.push((
        "emergency_one_signature",
        e.keyset.clone(),
        vec![ver(v2.clone(), Some(std_v1)), ver(v2_retired.clone(), Some(approval(&e, &v2_retired, 2, Some(&v2), "emergency_retirement", 8, &[4], l)))],
        Err("LIST_APPROVAL_THRESHOLD"),
    ));
    out
}

fn path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/lists/cases.json")
}

fn keyset_json(k: &Keyset) -> Value {
    json!({ "keys": k.keys.iter().map(|x| b64u::encode(x)).collect::<Vec<_>>(), "quorum": k.quorum, "version": k.version, "key_scheme": k.key_scheme })
}

fn keyset_from(v: &Value) -> Keyset {
    Keyset {
        keys: v["keys"].as_array().unwrap().iter().map(|k| b64u::decode(k.as_str().unwrap()).unwrap()).collect(),
        quorum: v["quorum"].as_u64().unwrap() as usize,
        version: v["version"].as_u64().unwrap() as u32,
        key_scheme: v["key_scheme"].as_u64().unwrap() as u8,
    }
}

#[test]
fn write_vectors_and_judge_them() {
    if std::env::var("NOTARY_WRITE_VECTORS").is_ok() {
        let cs: Vec<Value> = cases()
            .into_iter()
            .map(|(id, k, h, want)| {
                json!({ "id": id, "list": "accepted_runtimes", "list_card": RT_CARD, "keyset": keyset_json(&k),
                    "history": h.iter().map(|v| json!({ "value": v.value, "approval_text": v.approval_text })).collect::<Vec<_>>(),
                    "expect": match want { Ok(v) => json!({ "ok": true, "list_version": v }), Err(c) => json!({ "ok": false, "code": c }) } })
            })
            .collect();
        let out = json!({ "about": "Algorithm L (notary_lifecycle.md A.5): Rust-produced list histories with member signatures. Rust (notary-broker) and TypeScript (verifier lists.ts) must agree.", "cases": cs });
        std::fs::create_dir_all(path().parent().unwrap()).unwrap();
        std::fs::write(path(), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path()).expect("vectors/lists/cases.json")).unwrap();
    let cs = v["cases"].as_array().unwrap();
    assert!(cs.len() >= 14);
    for c in cs {
        let hist: Vec<ListVersion> = c["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| ListVersion { value: h["value"].clone(), approval_text: h["approval_text"].as_str().map(String::from) })
            .collect();
        let got = verify_list_approval(ListKind::AcceptedRuntimes, c["list_card"].as_str().unwrap(), &hist, &keyset_from(&c["keyset"]));
        let want = &c["expect"];
        match got {
            Ok((_, version)) => assert_eq!(want, &json!({ "ok": true, "list_version": version }), "{}", c["id"]),
            Err(code) => assert_eq!(want, &json!({ "ok": false, "code": code }), "{}", c["id"]),
        }
    }
}

#[test]
fn the_runtime_never_goes_backwards_or_below_its_floor() {
    let e = members(0, 8);
    let l = "accepted_runtimes";
    let v1 = json!([runtime(1, None)]);
    let v2 = json!([runtime(1, Some(("2026-06-01T00:00:00Z", "vulnerable")))]);
    let h1 = vec![ver(v1.clone(), Some(approval(&e, &v1, 1, None, "standard", 8, &[0, 1, 2, 3], l)))];
    let mut h2 = h1.clone();
    h2.push(ver(v2.clone(), Some(approval(&e, &v2, 2, Some(&v1), "emergency_retirement", 8, &[0, 1], l))));
    let pins = |floor| Pins {
        accepted_runtimes_card: RT_CARD.into(),
        program_allowlist_card: "0x22".into(),
        keyset: e.keyset.clone(),
        accepted_runtimes_floor: floor,
        program_allowlist_floor: 0,
    };
    let mut lists = Lists::new(pins(1));
    assert_eq!(lists.update(ListKind::AcceptedRuntimes, &h2), Ok(2));
    assert_eq!(lists.vulnerable_pcr0s(), vec![vec![1u8; 48]]);
    assert_eq!(lists.update(ListKind::AcceptedRuntimes, &h1), Err("LIST_VERSION_REGRESSION"));
    assert_eq!(lists.versions().0, 2, "the verified version is kept");
    let mut floored = Lists::new(pins(2));
    assert_eq!(floored.update(ListKind::AcceptedRuntimes, &h1), Err("LIST_VERSION_REGRESSION"));
    let mut wrong_keys = Lists::new(Pins { keyset: members(0, 8).keyset, ..pins(0) });
    assert_eq!(wrong_keys.update(ListKind::AcceptedRuntimes, &h1), Err("LIST_APPROVAL_THRESHOLD"), "a host can't supply its own keys");
}
