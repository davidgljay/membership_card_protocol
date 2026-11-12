//! Cross-language vector contract (code-plan §7.2, Q5). The TypeScript generator wrote
//! notary/vectors/; this test parses every `input`, re-serializes it, and must reproduce the
//! committed bytes, hashes, CIDs and verdicts. It never regenerates them.
use notary_types::{b64u, formats, jcs, merkle, objects::*, user_data::UserData};
use serde_json::Value;
use std::path::PathBuf;

fn vec_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors").join(rel)
}
fn load(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(vec_path(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))).unwrap()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing string {k}"))
}
fn code<T>(r: Result<T, notary_types::NotaryError>) -> &'static str {
    match r { Ok(_) => "ok", Err(e) => e.code }
}

/// Re-serialize through the typed struct and require identical canonical bytes.
fn typed_roundtrip<T: serde::Serialize + serde::de::DeserializeOwned>(v: &Value, ty: &str) {
    let t: T = from_value(v, ty).expect("typed parse");
    assert_eq!(jcs::canonical_of(&t).unwrap(), jcs::canonical(v).unwrap(), "typed round trip for {ty}");
}

#[test]
fn object_vectors_agree() {
    let names = [
        "genesis_request", "job", "announcement", "input", "countersign", "sealed_input", "host_receipt", "validation_receipt",
        "validation_receipt_rejected", "notarization", "job_log", "identity_log", "handoff", "heartbeat", "state_blob",
        "propagation_batch", "list_approval",
    ];
    for name in names {
        let file = load(&format!("objects/{name}.json"));
        for c in file["cases"].as_array().unwrap() {
            let input = &c["input"];
            let canon = jcs::canonical(input).unwrap();
            assert_eq!(String::from_utf8(canon.clone()).unwrap(), s(c, "canonical_utf8"), "{name}: canonical bytes");
            assert_eq!(b64u::encode(&canon), s(c, "canonical_b64u"), "{name}: b64u");
            assert_eq!(jcs::h(input).unwrap(), s(c, "h"), "{name}: H");
            assert_eq!(formats::cid_of_bytes(&canon), s(c, "cid"), "{name}: CID");
            assert_eq!(jcs::parse_canonical(&canon).unwrap(), *input, "{name}: parse_canonical");
            if let Some(sb) = c.get("signing_bytes_b64u") {
                let fields: Vec<&str> = c["signature_checks"].as_array().unwrap().iter().map(|x| s(x, "field")).collect();
                let unsigned = jcs::without_fields(input, &fields);
                assert_eq!(b64u::encode(&jcs::canonical(&unsigned).unwrap()), sb.as_str().unwrap(), "{name}: signing bytes");
            }
            let ty = s(c, "type");
            match name {
                "genesis_request" => typed_roundtrip::<GenesisRequest>(input, ty),
                "job" => typed_roundtrip::<NotaryJob>(input, ty),
                "announcement" => typed_roundtrip::<JobAnnouncement>(input, ty),
                "input" => typed_roundtrip::<NotaryInput>(input, ty),
                "countersign" => typed_roundtrip::<NotaryCountersign>(input, ty),
                "sealed_input" => typed_roundtrip::<SealedInput>(input, ty),
                "host_receipt" => typed_roundtrip::<HostReceipt>(input, ty),
                "validation_receipt" | "validation_receipt_rejected" => typed_roundtrip::<ValidationReceipt>(input, ty),
                "notarization" => typed_roundtrip::<Notarization>(input, ty),
                "job_log" | "identity_log" => typed_roundtrip::<JobLogRecord>(input, ty),
                "handoff" => typed_roundtrip::<HandoffRecord>(input, ty),
                "heartbeat" => typed_roundtrip::<Heartbeat>(input, ty),
                "state_blob" => typed_roundtrip::<StateBlobHeader>(input, ty),
                "propagation_batch" => typed_roundtrip::<PropagationBatch>(input, ty),
                "list_approval" => typed_roundtrip::<ListApproval>(input, ty),
                _ => unreachable!(),
            }
        }
    }
}

#[test]
fn reject_vectors_agree() {
    let r = load("objects/rejects.json");
    for c in r["json"].as_array().unwrap() {
        let got = code(jcs::parse_canonical(s(c, "text").as_bytes()));
        let any: Vec<&str> = match c.get("expected_any") {
            Some(a) => a.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect(),
            None => vec![s(c, "expected")],
        };
        assert!(any.contains(&got), "{}: got {got}, expected one of {any:?}", s(c, "id"));
    }
    for c in r["objects"].as_array().unwrap() {
        // only SealedInput is used for the object-level rejects
        let got = code(from_value::<SealedInput>(&c["object"], s(c, "expected_type")));
        assert_eq!(got, s(c, "expected"), "{}", s(c, "id"));
    }
}

#[test]
fn format_vectors_agree() {
    let f = load("formats.json");
    for c in f["base64url"]["valid"].as_array().unwrap() {
        let bytes: Vec<u8> = (0..s(c, "hex").len() / 2).map(|i| u8::from_str_radix(&s(c, "hex")[2 * i..2 * i + 2], 16).unwrap()).collect();
        assert_eq!(b64u::encode(&bytes), s(c, "b64u"));
        assert_eq!(b64u::decode(s(c, "b64u")).unwrap(), bytes);
    }
    for c in f["base64url"]["invalid"].as_array().unwrap() {
        assert_eq!(code(b64u::decode(s(c, "value"))), s(c, "expected"), "{}", s(c, "id"));
    }
    for c in f["timestamp"]["valid"].as_array().unwrap() {
        assert_eq!(formats::parse_timestamp(s(c, "value")).unwrap(), c["ms"].as_i64().unwrap(), "{}", s(c, "value"));
    }
    for c in f["timestamp"]["invalid"].as_array().unwrap() {
        assert_eq!(code(formats::parse_timestamp(s(c, "value"))), s(c, "expected"), "{}", s(c, "value"));
    }
    for c in f["duration"]["valid"].as_array().unwrap() {
        assert_eq!(formats::parse_duration(s(c, "value")).unwrap(), c["ms"].as_i64().unwrap(), "{}", s(c, "value"));
    }
    for c in f["duration"]["invalid"].as_array().unwrap() {
        assert_eq!(code(formats::parse_duration(s(c, "value"))), s(c, "expected"), "{}", s(c, "value"));
    }
    for c in f["cid"]["valid"].as_array().unwrap() {
        let d: [u8; 32] = (0..32).map(|i| u8::from_str_radix(&s(c, "digest_hex")[2 * i..2 * i + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap();
        assert_eq!(formats::cid_from_digest(&d), s(c, "cid"));
        assert_eq!(formats::digest_from_cid(s(c, "cid")).unwrap(), d);
    }
    for c in f["cid"]["invalid"].as_array().unwrap() {
        assert_eq!(code(formats::digest_from_cid(s(c, "value"))), s(c, "expected"), "{}", s(c, "value"));
    }
    let p = &f["card_pointer"]["valid"];
    assert_eq!(formats::card_pointer(&b64u::decode(s(p, "public_key_b64u")).unwrap()), s(p, "card_pointer"));
    formats::assert_card_pointer(s(p, "card_pointer")).unwrap();
    for bad in f["card_pointer"]["invalid"].as_array().unwrap() {
        assert_eq!(code(formats::assert_card_pointer(bad.as_str().unwrap())), "CARD_POINTER_INVALID");
    }
}

fn hashes(v: &Value) -> Vec<[u8; 32]> {
    v.as_array().unwrap().iter().map(|x| b64u::decode_len(x.as_str().unwrap(), 32).unwrap().try_into().unwrap()).collect()
}

#[test]
fn merkle_vectors_agree() {
    let m = load("objects/merkle.json");
    for c in m["cases"].as_array().unwrap() {
        let root = merkle::input_commitment(&hashes(&c["input_hashes_b64u"])).unwrap();
        assert_eq!(b64u::encode(&root), s(c, "root_b64u"), "{}", s(c, "id"));
    }
    for c in m["invalid"].as_array().unwrap() {
        assert_eq!(code(merkle::input_commitment(&hashes(&c["input_hashes_b64u"]))), s(c, "expected"), "{}", s(c, "id"));
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap()).collect()
}

#[test]
fn user_data_vectors_agree() {
    let u = load("user_data/layouts.json");
    assert_eq!(u["length"].as_u64().unwrap() as usize, notary_types::user_data::LEN);
    for c in u["cases"].as_array().unwrap() {
        let f = &c["fields"];
        let h = |k: &str| -> [u8; 32] { f.get(k).map_or([0; 32], |x| b64u::decode_len(x.as_str().unwrap(), 32).unwrap().try_into().unwrap()) };
        let ud = UserData {
            purpose: c["purpose"].as_u64().unwrap() as u8, id_key_hash: h("idKeyHash"), chain_key_hash: h("chainKeyHash"),
            inst_key_hash: h("instKeyHash"), program_hash: h("programHash"), job_hash: h("jobHash"),
            epoch: f.get("epoch").map_or(0, |e| e.as_str().unwrap().parse().unwrap()),
            isolation: f.get("isolation").map_or(0, |i| i.as_u64().unwrap() as u8),
        };
        assert_eq!(hex_of(&ud.encode()), s(c, "user_data_hex"), "{}", s(c, "id"));
        assert_eq!(UserData::decode(&unhex(s(c, "user_data_hex"))).unwrap(), ud, "{}", s(c, "id"));
    }
    for c in u["invalid"].as_array().unwrap() {
        assert_eq!(code(UserData::decode(&unhex(s(c, "user_data_hex")))), s(c, "expected"), "{}", s(c, "id"));
    }
}

fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn rfc8785_conformance_cases() {
    // specs/serialization-conformance.json: the repo's hand-reviewed RFC 8785 cases. Cases that
    // use floats, nulls or arrays of mixed content are skipped where the notary layer rejects them.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../specs/serialization-conformance.json");
    let j: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut checked, mut skipped) = (0, 0);
    for c in j["cases"].as_array().unwrap() {
        match jcs::canonical(&c["input"]) {
            Ok(b) => {
                assert_eq!(String::from_utf8(b).unwrap(), s(c, "expected_json"), "{}", s(c, "id"));
                checked += 1;
            }
            Err(e) => {
                assert!(["JSON_NULL", "JSON_NON_INTEGER", "JSON_INTEGER_RANGE"].contains(&e.code), "{}: {e}", s(c, "id"));
                skipped += 1;
            }
        }
    }
    println!("RFC 8785 conformance: {checked} matched, {skipped} rejected by notary strictness");
    assert!(checked >= 20);
}
