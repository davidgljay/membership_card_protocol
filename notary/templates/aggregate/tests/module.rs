//! The committed `aggregate` module (templates/modules/aggregate.wasm) against the runtime: it is admitted (A1–A12) with the
//! template policy, runs under the `notary_v1` engine, and gives the same bytes as the native logic. The build itself is
//! checked by `templates/build.sh aggregate --check` (CI).
use notary_admission::{admit, RuntimeContext};
use notary_template_aggregate::aggregate;
use notary_types::formats;
use notary_worker::{Program, RunLimits};
use serde_json::{json, Value};

fn module() -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../modules/aggregate.wasm")).expect("run templates/build.sh aggregate")
}

/// The template policy with its placeholders filled in.
fn policy(wasm: &[u8]) -> Value {
    let mut p: Value = serde_json::from_str(include_str!("../policy.json")).unwrap();
    let n = &mut p["notary"];
    n["program_cid"] = json!(formats::cid_of_bytes(wasm));
    n["contributor_predicate"] = json!({ "issued_under_template": "bafkreimemberpolicy" });
    n.clone()
}

fn allowlisted(wasm: &[u8]) -> RuntimeContext<'static> {
    // shared isolation needs the program on the verified allowlist
    let cid = formats::cid_of_bytes(wasm);
    let list: &'static [notary_admission::AllowlistEntry] = Box::leak(vec![notary_admission::AllowlistEntry { program_cid: cid, accepted_from_ms: 0, retired_at_ms: None }].into_boxed_slice());
    RuntimeContext { allowlist: Some(list), now_ms: 1_000, held_jobs: 0 }
}

#[test]
fn the_committed_module_is_admitted_with_the_template_policy() {
    let wasm = module();
    let admitted = admit(&wasm, &policy(&wasm), &allowlisted(&wasm)).unwrap_or_else(|e| panic!("{} {}", e.code, e.detail));
    assert_eq!(admitted.program_hash, notary_crypto_sha256(&wasm));
}

fn notary_crypto_sha256(b: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).into()
}

#[test]
fn the_module_gives_the_native_logic_s_bytes_and_a_small_fuel_bill() {
    let wasm = module();
    let program = Program::load(&wasm).expect("loads under the notary_v1 engine");
    let values = [1i64, 5, 5, 9, 10, 100, -4];
    let inputs: Vec<Vec<u8>> = values.iter().map(|v| format!("{{\"value\":{v}}}").into_bytes()).collect();
    let out = program.run(br#"{"edge_1":5,"edge_2":10}"#, &inputs, RunLimits::default()).expect("runs");
    let t = aggregate(&values, &[5, 10]).unwrap();
    let got: Value = serde_json::from_slice(&out.bytes).unwrap();
    assert_eq!(got["count"], t.count);
    assert_eq!(got["sum"], t.sum);
    for i in 0..8 {
        assert_eq!(got[format!("bucket_{}", i + 1)], t.buckets[i], "bucket {}", i + 1);
    }
    // canonical bytes: sorted keys, no spaces
    assert_eq!(out.bytes, notary_types::jcs::canonical(&got).unwrap());
    assert!(out.fuel_used < 200_000, "{} fuel for 7 inputs", out.fuel_used);
}

#[test]
fn a_run_with_no_inputs_and_no_edges_is_all_zero() {
    let program = Program::load(&module()).unwrap();
    let out = program.run(b"{}", &[], RunLimits::default()).unwrap();
    let got: Value = serde_json::from_slice(&out.bytes).unwrap();
    assert_eq!((got["count"].as_i64(), got["sum"].as_i64(), got["bucket_1"].as_i64()), (Some(0), Some(0), Some(0)));
}

#[test]
fn bad_edges_or_a_missing_value_abort_the_run() {
    let program = Program::load(&module()).unwrap();
    let r = program.run(br#"{"edge_1":5,"edge_2":5}"#, &[br#"{"value":1}"#.to_vec()], RunLimits::default());
    assert_eq!(r.err().map(|e| e.reason()), Some("abort:4".to_string()));
    let r = program.run(b"{}", &[br#"{"nope":1}"#.to_vec()], RunLimits::default());
    assert_eq!(r.err().map(|e| e.reason()), Some("abort:3".to_string()));
}

#[test]
fn a_thousand_inputs_fit_the_arena() {
    let program = Program::load(&module()).unwrap();
    let inputs: Vec<Vec<u8>> = (0..1000).map(|i| format!("{{\"value\":{}}}", i % 50).into_bytes()).collect();
    let out = program.run(br#"{"edge_1":10,"edge_2":20}"#, &inputs, RunLimits::default()).expect("runs");
    let got: Value = serde_json::from_slice(&out.bytes).unwrap();
    assert_eq!(got["count"], 1000);
}

/// The runtime applies the schema's transforms to what the module returns: a bucket with fewer than 5 contributors is
/// omitted (small-cell suppression), an empty bucket stays 0, and the counts are clamped. This is what keeps a small
/// group's cell out of the public result, whatever the program says.
#[test]
fn small_cells_are_suppressed_by_the_runtime_and_empty_ones_stay_zero() {
    let wasm = module();
    let program = Program::load(&wasm).unwrap();
    let mut values = vec![1i64; 4]; // four in bucket_1: under the floor of 5
    values.extend(vec![7i64; 8]); //   eight in bucket_2: shown
    let inputs: Vec<Vec<u8>> = values.iter().map(|v| format!("{{\"value\":{v}}}").into_bytes()).collect();
    let raw = program.run(br#"{"edge_1":5}"#, &inputs, RunLimits::default()).unwrap();
    let schema = policy(&wasm)["output_schema"].clone();
    let shown = notary_broker::transforms::apply(&raw.bytes, &schema).expect("passes the output checks");
    assert!(shown.get("bucket_1").is_none(), "four contributors: the cell is omitted: {shown}");
    assert_eq!(shown["bucket_2"], 8);
    assert_eq!((shown["count"].as_i64(), shown["sum"].as_i64(), shown["bucket_3"].as_i64()), (Some(12), Some(60), Some(0)));
}
