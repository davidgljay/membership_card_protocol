//! One failing fixture per `ATT_*` code (notary_lifecycle.md A.1, V1–V12), plus passing cases.
//! The same cases are written to notary/vectors/attestation/cases.json (NOTARY_WRITE_VECTORS=1) and
//! verified by the TypeScript modules (notary-attestation, verifier/notary), so both languages parse and
//! judge the very same documents. Expected results are declared here, once.
use notary_attest::{
    aws::build::{self, build_document, cose_sign1, cose_wrap, es384_protected, pcrs, payload_bytes, CertSpec, DocFields, Pki, T_2020, T_2049},
    verify::{verify_attestation, AcceptedRuntime, Config, Context, Expected, RetireReason},
};
use notary_types::{b64u, formats::parse_timestamp, user_data::UserData};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PLATFORM: &str = "simulator";

fn now_ms() -> i64 {
    parse_timestamp("2026-11-12T10:00:00Z").unwrap()
}

fn h(n: u8) -> [u8; 32] {
    [n; 32]
}

/// An instance attestation (purpose 0x03) with a fresh-challenge nonce and an ephemeral key hash.
fn base_user_data() -> UserData {
    UserData { purpose: 0x03, inst_key_hash: h(3), ..Default::default() }
}

fn runtime(pcr0: u8) -> AcceptedRuntime {
    AcceptedRuntime { pcr0: vec![pcr0; 48], platform: PLATFORM.into(), accepted_from_ms: now_ms() - 86_400_000, retired_at_ms: None, retire_reason: None }
}

struct Case {
    id: &'static str,
    desc: &'static str,
    doc: Vec<u8>,
    root: Vec<u8>,
    platform: &'static str,
    allow_simulator: bool,
    envelope_code: Option<&'static str>, // expected V1–V5 failure
    v: Option<VCase>,
}

struct VCase {
    ctx_t_eval: i64,
    ctx_now: i64,
    max_age: Option<i64>,
    accepted: Vec<AcceptedRuntime>,
    expected: Expected,
    result: Result<Vec<&'static str>, &'static str>, // Ok(warnings) | Err(code)
}

fn nonce() -> Vec<u8> {
    vec![0xAB; 32]
}
fn ephemeral() -> Vec<u8> {
    vec![0xCD; 32]
}

fn fields(pki: &Pki, ts: i64) -> DocFields {
    let mut f = DocFields::new(pki, ts as u64, pcrs(0x10, false));
    f.user_data = Some(base_user_data().encode().to_vec());
    f.nonce = Some(nonce());
    f.public_key = Some(ephemeral());
    f
}

fn expected() -> Expected {
    Expected { user_data: base_user_data(), nonce: Some(nonce()), public_key: Some(ephemeral()) }
}

fn good_v() -> VCase {
    VCase { ctx_t_eval: now_ms(), ctx_now: now_ms(), max_age: Some(86_400_000), accepted: vec![runtime(0x10)], expected: expected(), result: Ok(vec![]) }
}

fn cases() -> Vec<Case> {
    let pki = Pki::new("att-tests");
    let other = Pki::new("att-tests-other");
    let ts = now_ms();
    let root = pki.root_der.clone();
    let mk = |id, desc, doc: Vec<u8>, envelope_code, v| Case { id, desc, doc, root: root.clone(), platform: PLATFORM, allow_simulator: true, envelope_code, v };
    let good = build_document(&fields(&pki, ts), &pki.leaf_key);
    let mut out = vec![];

    // --- passing ---
    out.push(mk("OK-instance", "valid instance attestation (purpose 0x03)", good.clone(), None, Some(good_v())));
    let mut v = good_v();
    v.accepted = vec![AcceptedRuntime { retired_at_ms: Some(ts + 86_400_000), retire_reason: Some(RetireReason::Vulnerable), ..runtime(0x10) }];
    v.result = Ok(vec!["runtime_retired_vulnerable"]);
    out.push(mk("OK-retired-later-vulnerable", "accepted at t_eval, retired as vulnerable later: success with warning", good.clone(), None, Some(v)));
    let mut v = good_v();
    v.accepted = vec![AcceptedRuntime { retired_at_ms: Some(ts + 86_400_000), retire_reason: Some(RetireReason::Superseded), ..runtime(0x10) }];
    out.push(mk("OK-retired-later-superseded", "retired later as superseded: success, no warning", good.clone(), None, Some(v)));

    // --- V1 ATT_MALFORMED ---
    let mal = |id, desc, doc: Vec<u8>| mk(id, desc, doc, Some("ATT_MALFORMED"), None);
    out.push(mal("MAL-not-cbor", "not CBOR", b"not a cbor document".to_vec()));
    out.push(mal("MAL-empty", "empty input", vec![]));
    out.push(mal("MAL-trailing", "valid document followed by a stray byte", [good.clone(), vec![0]].concat()));
    let mut untagged = good.clone();
    untagged.drain(0..1); // remove the tag byte 0xD2
    out.push(mal("MAL-no-tag", "COSE_Sign1 without tag 18", untagged));
    let es256 = { let mut v = vec![]; ciborium::into_writer(&ciborium::value::Value::Map(vec![(1.into(), (-7).into())]), &mut v).unwrap(); v };
    out.push(mal("MAL-alg-es256", "protected header says ES256", cose_sign1(es256, payload_bytes(&fields(&pki, ts)), &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.digest = "SHA256".into();
    out.push(mal("MAL-digest", "digest is not SHA384", build_document(&f, &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.module_id = String::new();
    out.push(mal("MAL-module-id-empty", "empty module_id", build_document(&f, &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.pcrs.clear();
    out.push(mal("MAL-no-pcrs", "no PCRs", build_document(&f, &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.pcrs.remove(&0);
    out.push(mal("MAL-no-pcr0", "PCR0 absent", build_document(&f, &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.cabundle.clear();
    out.push(mal("MAL-no-cabundle", "empty cabundle", build_document(&f, &pki.leaf_key)));
    let mut f = fields(&pki, ts);
    f.certificate = vec![1, 2, 3];
    out.push(mk("MAL-garbage-cert", "certificate is not DER", build_document(&f, &pki.leaf_key), Some("ATT_CHAIN_INVALID"), None));
    out.push(mal("MAL-short-signature", "signature is not 96 bytes", cose_wrap(es384_protected(), payload_bytes(&fields(&pki, ts)), vec![0; 64])));
    {
        // duplicate key in the payload map
        let mut p = vec![];
        let Some(ciborium::value::Value::Map(mut m)) = ciborium::from_reader::<ciborium::value::Value, _>(&payload_bytes(&fields(&pki, ts))[..]).ok() else { unreachable!() };
        m.push(m[0].clone());
        ciborium::into_writer(&ciborium::value::Value::Map(m), &mut p).unwrap();
        out.push(mal("MAL-duplicate-key", "duplicate key in the payload map", cose_sign1(es384_protected(), p, &pki.leaf_key)));
    }
    out.push(mal("MAL-oversize", "document larger than 64 KiB", { let mut f = fields(&pki, ts); f.module_id = "x".repeat(70_000); build_document(&f, &pki.leaf_key) }));

    // --- V3 ATT_ROOT_MISMATCH ---
    let mut f = DocFields::new(&other, ts as u64, pcrs(0x10, false));
    f.user_data = Some(base_user_data().encode().to_vec());
    out.push(mk("ROOT-other-pki", "chain rooted in a different root than the pinned one", build_document(&f, &other.leaf_key), Some("ATT_ROOT_MISMATCH"), None));

    // --- V4 ATT_CHAIN_INVALID ---
    let chain = |id, desc, p: Pki| {
        let mut f = fields(&p, ts);
        f.cabundle = p.cabundle();
        let mut c = mk(id, desc, build_document(&f, &p.leaf_key), Some("ATT_CHAIN_INVALID"), None);
        c.root = p.root_der.clone(); // pin this PKI's own root so only the chain rule under test fails
        c
    };
    let (ca, leaf) = (CertSpec::ca(T_2020, T_2049), CertSpec::leaf(T_2020, T_2049));
    out.push(chain("CHAIN-leaf-expired", "leaf expired before the document timestamp", Pki::with_specs("c1", ca.clone(), ca.clone(), CertSpec::leaf(T_2020, 1_700_000_000))));
    out.push(chain("CHAIN-leaf-not-yet-valid", "leaf not valid until after the document timestamp", Pki::with_specs("c2", ca.clone(), ca.clone(), CertSpec::leaf(2_000_000_000, T_2049))));
    out.push(chain("CHAIN-intermediate-expired", "intermediate expired", Pki::with_specs("c3", ca.clone(), CertSpec::ca(T_2020, 1_700_000_000), leaf.clone())));
    out.push(chain("CHAIN-intermediate-not-ca", "intermediate is not a CA", Pki::with_specs("c4", ca.clone(), CertSpec { ca: false, ..ca.clone() }, leaf.clone())));
    out.push(chain("CHAIN-no-keycertsign", "intermediate keyUsage lacks keyCertSign", Pki::with_specs("c5", ca.clone(), CertSpec { key_cert_sign: Some(false), ..ca.clone() }, leaf.clone())));
    out.push(chain("CHAIN-leaf-is-ca", "leaf is marked as a CA", Pki::with_specs("c6", ca.clone(), ca.clone(), CertSpec { ca: true, ..leaf.clone() })));
    out.push(chain("CHAIN-pathlen", "root pathLenConstraint 0 forbids the intermediate", Pki::with_specs("c7", CertSpec { path_len: Some(0), ..ca.clone() }, ca.clone(), leaf.clone())));
    out.push(chain("CHAIN-unknown-critical", "leaf carries an unknown critical extension", Pki::with_specs("c8", ca.clone(), ca.clone(), CertSpec { unknown_critical_extension: true, ..leaf.clone() })));
    {
        // intermediate omitted: leaf's issuer is not the root
        let mut f = fields(&pki, ts);
        f.cabundle = vec![pki.root_der.clone()];
        out.push(mk("CHAIN-missing-intermediate", "intermediate missing from the bundle", build_document(&f, &pki.leaf_key), Some("ATT_CHAIN_INVALID"), None));
        // leaf signed by a stranger with the right issuer name
        let rogue = build::key_from_seed(b"rogue");
        let bad_leaf = build::issue("test.leaf", &pki.leaf_key, "test.intermediate", &rogue, 9, CertSpec::leaf(T_2020, T_2049));
        let mut f = fields(&pki, ts);
        f.certificate = bad_leaf;
        out.push(mk("CHAIN-bad-cert-signature", "leaf certificate signed by a different key than the intermediate", build_document(&f, &pki.leaf_key), Some("ATT_CHAIN_INVALID"), None));
    }

    // --- V5 ATT_SIGNATURE_INVALID ---
    let rogue = build::key_from_seed(b"rogue-doc-signer");
    out.push(mk("SIG-wrong-key", "signed by a key that is not the leaf's", build_document(&fields(&pki, ts), &rogue), Some("ATT_SIGNATURE_INVALID"), None));
    let mut flipped = good.clone();
    let n = flipped.len();
    flipped[n - 5] ^= 1;
    out.push(mk("SIG-bit-flip", "one bit of the signature flipped", flipped, Some("ATT_SIGNATURE_INVALID"), None));
    {
        let mut f2 = fields(&pki, ts);
        f2.nonce = Some(vec![0xEE; 32]);
        let signed_other = build_document(&fields(&pki, ts), &pki.leaf_key);
        // re-wrap the modified payload with the original signature
        let Some(ciborium::value::Value::Tag(_, inner)) = ciborium::from_reader::<ciborium::value::Value, _>(&signed_other[..]).ok() else { unreachable!() };
        let ciborium::value::Value::Array(parts) = *inner else { unreachable!() };
        let ciborium::value::Value::Bytes(sig) = parts[3].clone() else { unreachable!() };
        out.push(mk("SIG-payload-modified", "payload modified after signing", cose_wrap(es384_protected(), payload_bytes(&f2), sig), Some("ATT_SIGNATURE_INVALID"), None));
    }

    // --- V6–V12 (valid envelopes, shared steps fail) ---
    let vfail = |id, desc, doc: Vec<u8>, mutate: &dyn Fn(&mut VCase), code: &'static str| {
        let mut v = good_v();
        mutate(&mut v);
        v.result = Err(code);
        mk(id, desc, doc, None, Some(v))
    };
    let dbg = { let mut f = fields(&pki, ts); f.pcrs = pcrs(0x10, true); build_document(&f, &pki.leaf_key) };
    out.push(vfail("V6-debug", "PCR0, PCR1 and PCR2 all zero", dbg, &|_| {}, "ATT_DEBUG_MODE"));
    out.push(vfail("V7-unknown-pcr0", "PCR0 not on the accepted list", good.clone(), &|v| v.accepted = vec![runtime(0x99)], "ATT_RUNTIME_NOT_ACCEPTED"));
    out.push(vfail("V7-retired-before", "retired before t_eval", good.clone(), &|v| v.accepted = vec![AcceptedRuntime { retired_at_ms: Some(ts - 1000), retire_reason: Some(RetireReason::Vulnerable), ..runtime(0x10) }], "ATT_RUNTIME_NOT_ACCEPTED"));
    out.push(vfail("V7-not-yet-accepted", "accepted_from after t_eval", good.clone(), &|v| v.accepted = vec![AcceptedRuntime { accepted_from_ms: ts + 1000, ..runtime(0x10) }], "ATT_RUNTIME_NOT_ACCEPTED"));
    let short_ud = { let mut f = fields(&pki, ts); f.user_data = Some(vec![0; 180]); build_document(&f, &pki.leaf_key) };
    out.push(vfail("V8-short-user-data", "user_data is 180 bytes", short_ud, &|_| {}, "ATT_USER_DATA_MALFORMED"));
    let bad_tag = { let mut f = fields(&pki, ts); let mut u = base_user_data().encode(); u[0] = b'X'; f.user_data = Some(u.to_vec()); build_document(&f, &pki.leaf_key) };
    out.push(vfail("V8-bad-tag", "user_data tag is not CARDNOTARY", bad_tag, &|_| {}, "ATT_USER_DATA_MALFORMED"));
    out.push(vfail("V9-purpose", "purpose is not the expected one", good.clone(), &|v| v.expected.user_data.purpose = 0x02, "ATT_PURPOSE_MISMATCH"));
    out.push(vfail("V10-binding", "a bound hash differs", good.clone(), &|v| v.expected.user_data.inst_key_hash = h(4), "ATT_BINDING_MISMATCH"));
    let unused = { let mut f = fields(&pki, ts); let mut u = base_user_data(); u.job_hash = h(7); f.user_data = Some(u.encode().to_vec()); build_document(&f, &pki.leaf_key) };
    out.push(vfail("V10-unused-nonzero", "a field unused for this purpose is not zero", unused, &|_| {}, "ATT_BINDING_MISMATCH"));
    out.push(vfail("V11-nonce", "nonce differs from the challenge", good.clone(), &|v| v.expected.nonce = Some(vec![0x01; 32]), "ATT_NONCE_MISMATCH"));
    let no_nonce = { let mut f = fields(&pki, ts); f.nonce = None; build_document(&f, &pki.leaf_key) };
    out.push(vfail("V11-nonce-missing", "nonce absent but expected", no_nonce, &|_| {}, "ATT_NONCE_MISMATCH"));
    out.push(vfail("V11-key", "public_key differs", good.clone(), &|v| v.expected.public_key = Some(vec![0x02; 32]), "ATT_KEY_MISMATCH"));
    out.push(vfail("V12-stale", "older than max_age", good.clone(), &|v| v.ctx_now = ts + 2 * 86_400_000, "ATT_STALE"));
    out.push(vfail("V12-future", "more than 5 minutes ahead of now", good.clone(), &|v| v.ctx_now = ts - 6 * 60_000, "ATT_STALE"));
    let mut v = good_v();
    v.ctx_now = ts - 4 * 60_000;
    out.push(mk("V12-within-skew", "4 minutes ahead of now is within the allowed skew", good.clone(), None, Some(v)));
    let mut v = good_v();
    v.max_age = None;
    v.ctx_now = ts + 400 * 86_400_000;
    out.push(mk("V12-no-max-age", "no max_age: age is not checked", good.clone(), None, Some(v)));

    // --- platform gate (before any parsing) ---
    let mut c = mk("PLAT-simulator-disallowed", "simulator documents refused unless the verifier opts in", good.clone(), None, Some({ let mut v = good_v(); v.result = Err("ATT_PLATFORM_NOT_ALLOWED"); v }));
    c.allow_simulator = false;
    out.push(c);
    let mut c = mk("PLAT-unknown", "unknown platform", good, None, Some({ let mut v = good_v(); v.result = Err("ATT_PLATFORM_NOT_ALLOWED"); v }));
    c.platform = "tpm";
    out.push(c);
    out
}

fn run(c: &Case) -> (Option<&'static str>, Option<Result<Vec<&'static str>, &'static str>>) {
    let cfg = Config { roots: BTreeMap::from([(c.platform.to_string(), c.root.clone())]), allow_simulator: c.allow_simulator };
    let Some(v) = &c.v else {
        // envelope-level case: expected code must come from V1–V5 (use a context that cannot fail later)
        let probe = good_v();
        let ctx = Context { t_eval_ms: probe.ctx_t_eval, now_ms: probe.ctx_now, max_age_ms: probe.max_age, accepted_runtimes: &probe.accepted, platform: c.platform };
        return match verify_attestation(&c.doc, &cfg, &probe.expected, &ctx) {
            Err(code) => (Some(code), None),
            Ok(_) => (None, None),
        };
    };
    let ctx = Context { t_eval_ms: v.ctx_t_eval, now_ms: v.ctx_now, max_age_ms: v.max_age, accepted_runtimes: &v.accepted, platform: c.platform };
    (None, Some(verify_attestation(&c.doc, &cfg, &v.expected, &ctx).map(|ok| ok.warnings)))
}

#[test]
fn every_att_code_has_a_failing_fixture_and_the_rust_verifier_agrees() {
    let all = cases();
    let mut seen = std::collections::BTreeSet::new();
    for c in &all {
        let (env_code, v_result) = run(c);
        match (&c.v, c.envelope_code) {
            (None, Some(expected)) => assert_eq!(env_code, Some(expected), "{}: {}", c.id, c.desc),
            (None, None) => panic!("{}: envelope case without expectation", c.id),
            (Some(v), _) => assert_eq!(v_result.unwrap(), v.result, "{}: {}", c.id, c.desc),
        }
        if let Some(code) = c.envelope_code { seen.insert(code); }
        if let Some(Err(code)) = c.v.as_ref().map(|v| v.result.clone()) { seen.insert(code); }
    }
    for code in [
        "ATT_MALFORMED", "ATT_ROOT_MISMATCH", "ATT_CHAIN_INVALID", "ATT_SIGNATURE_INVALID", "ATT_DEBUG_MODE", "ATT_RUNTIME_NOT_ACCEPTED",
        "ATT_USER_DATA_MALFORMED", "ATT_PURPOSE_MISMATCH", "ATT_BINDING_MISMATCH", "ATT_NONCE_MISMATCH", "ATT_KEY_MISMATCH", "ATT_STALE",
        "ATT_PLATFORM_NOT_ALLOWED",
    ] {
        assert!(seen.contains(code), "no failing fixture for {code}");
    }
    println!("{} attestation cases, {} distinct codes", all.len(), seen.len());
}

#[test]
fn write_attestation_vectors() {
    if std::env::var("NOTARY_WRITE_VECTORS").is_err() {
        return;
    }
    let all = cases();
    let rt = |r: &AcceptedRuntime| {
        let mut o = json!({ "pcr0": b64u::encode(&r.pcr0), "platform": r.platform, "accepted_from_ms": r.accepted_from_ms });
        if let Some(t) = r.retired_at_ms { o["retired_at_ms"] = json!(t); }
        if let Some(x) = r.retire_reason { o["retire_reason"] = json!(if x == RetireReason::Vulnerable { "vulnerable" } else { "superseded" }); }
        o
    };
    let out: Vec<Value> = all.iter().map(|c| {
        let cfg = Config { roots: BTreeMap::from([(c.platform.to_string(), c.root.clone())]), allow_simulator: c.allow_simulator };
        let _ = cfg;
        let mut o = json!({
            "id": c.id, "description": c.desc, "platform": c.platform, "allow_simulator": c.allow_simulator,
            "doc": b64u::encode(&c.doc), "trust_root": b64u::encode(&c.root),
        });
        if let Some(code) = c.envelope_code { o["envelope_code"] = json!(code); }
        if let Some(v) = &c.v {
            o["v"] = json!({
                "t_eval_ms": v.ctx_t_eval, "now_ms": v.ctx_now, "max_age_ms": v.max_age,
                "accepted_runtimes": v.accepted.iter().map(rt).collect::<Vec<_>>(),
                "expected": {
                    "user_data": b64u::encode(&v.expected.user_data.encode()),
                    "nonce": v.expected.nonce.as_ref().map(|n| b64u::encode(n)), "public_key": v.expected.public_key.as_ref().map(|n| b64u::encode(n)),
                },
                "result": match &v.result { Ok(w) => json!({ "ok": true, "warnings": w }), Err(c) => json!({ "ok": false, "code": c }) },
            });
        }
        o
    }).collect();
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/attestation");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("cases.json"),
        serde_json::to_string_pretty(&json!({
            "note": "Documents in the AWS Nitro Enclaves format signed by a TEST PKI (platform \"simulator\"); every case is judged identically by Rust and TypeScript. Generated by notary-attest tests/att_codes.rs.",
            "cases": out,
        })).unwrap() + "\n",
    ).unwrap();
}
