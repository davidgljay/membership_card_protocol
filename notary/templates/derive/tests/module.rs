//! The committed `derive` module (templates/modules/derive.wasm) against the runtime: admitted (A1–A12) with the template
//! policy, runs under the `notary_v1` engine and copies its input byte for byte. The build itself is checked by
//! `templates/build.sh derive --check`. The `source_kind` refusal (propagation §9) is checked here against the real policy.
use notary_admission::{admit, AllowlistEntry, RuntimeContext};
use notary_types::formats;
use notary_worker::{Program, RunLimits};
use serde_json::{json, Value};

fn module() -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../modules/derive.wasm")).expect("run templates/build.sh derive")
}

/// The template policy's `notary` section with the program CID filled in.
fn policy(wasm: &[u8]) -> Value {
    let mut p: Value = serde_json::from_str(include_str!("../policy.json")).unwrap();
    p["notary"]["program_cid"] = json!(formats::cid_of_bytes(wasm));
    p["notary"].clone()
}

fn allowlisted(wasm: &[u8]) -> RuntimeContext<'static> {
    let list: &'static [AllowlistEntry] = Box::leak(vec![AllowlistEntry { program_cid: formats::cid_of_bytes(wasm), accepted_from_ms: 0, retired_at_ms: None }].into_boxed_slice());
    RuntimeContext { allowlist: Some(list), now_ms: 1_000, held_jobs: 0 }
}

#[test]
fn the_committed_module_is_admitted_with_the_template_policy() {
    let wasm = module();
    let admitted = admit(&wasm, &policy(&wasm), &allowlisted(&wasm)).unwrap_or_else(|e| panic!("{} {}", e.code, e.detail));
    assert_eq!(admitted.limits.max_inputs > 0, true);
}

#[test]
fn a_v1_runtime_refuses_the_reserved_source_kind_and_escrowed_link() {
    let wasm = module();
    let code = |n: &Value| admit(&wasm, n, &allowlisted(&wasm)).err().map(|e| e.code);
    let mut n = policy(&wasm);
    n["derived_card"]["source_kind"] = json!("web_evidence");
    assert_eq!(code(&n), Some("ADM_FEATURE_UNSUPPORTED"), "source_kind other than card");
    n["derived_card"]["source_kind"] = json!("card");
    assert_eq!(code(&n), None);
    n["derived_card"].as_object_mut().unwrap().remove("source_kind");
    assert_eq!(code(&n), None, "absent means card");
    n["revocation_propagation"]["mode"] = json!("escrowed_link");
    assert_eq!(code(&n), Some("ADM_FEATURE_UNSUPPORTED"), "escrowed_link");
}

#[test]
fn the_module_copies_the_projected_values_byte_for_byte() {
    let program = Program::load(&module()).expect("loads under the notary_v1 engine");
    for input in [&br#"{"level":"gold"}"#[..], br#"{"level":"gold","team":"red","years":7}"#, br#"{"on":true}"#] {
        let out = program.run(br#"{"projected_fields":["level"],"source_policy":"bafkreix"}"#, &[input.to_vec()], RunLimits::default()).expect("runs");
        assert_eq!(out.bytes, input);
        assert!(out.fuel_used < 50_000, "{} fuel", out.fuel_used);
    }
}

#[test]
fn an_input_that_is_not_one_object_aborts_the_run() {
    let program = Program::load(&module()).unwrap();
    let abort = |inputs: &[Vec<u8>]| program.run(b"{}", inputs, RunLimits::default()).err().map(|e| e.reason());
    assert_eq!(abort(&[b"[1]".to_vec()]), Some("abort:3".to_string()));
    assert_eq!(abort(&[]), Some("abort:3".to_string()));
    assert_eq!(abort(&[b"{}".to_vec(), b"{}".to_vec()]), Some("abort:3".to_string()));
}

/// The runtime's output check for a derived card (D4), seen from the template: a program that returned anything but the
/// projected values would be refused by the broker. The module can't produce it, so this pins the module's side.
#[test]
fn the_template_policy_is_what_the_broker_expects_of_a_derive_policy() {
    let wasm = module();
    let n = policy(&wasm);
    assert_eq!((n["mode"].as_str(), n["output_action"].as_str()), (Some("per_input"), Some("card")));
    assert!(n.get("job_requester_predicate").is_none(), "anyone may open a job (D9)");
    assert_eq!(n["output_schema"], json!([]));
    assert_eq!(n["contributor_predicate"], json!({ "issued_under_template": { "param": "source_policy" } }));
    assert_eq!(notary_broker::derive::DeriveParams::from_notary(&n).unwrap().min_anon, 10);
}
