//! The committed `vote` module (templates/modules/vote.wasm) against the runtime: admitted (A1–A12) with the template
//! policy, runs under the `notary_v1` engine, and gives the right tally. Latest-ballot-wins is the runtime's job and is
//! tested through the broker (`ballot_replacement_…` below).
use notary_admission::{admit, RuntimeContext};
use notary_types::formats;
use notary_worker::{Program, RunLimits};
use serde_json::{json, Value};

fn module() -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../modules/vote.wasm")).expect("run templates/build.sh vote")
}

fn policy(wasm: &[u8]) -> Value {
    let mut p: Value = serde_json::from_str(include_str!("../policy.json")).unwrap();
    let n = &mut p["notary"];
    n["program_cid"] = json!(formats::cid_of_bytes(wasm));
    n["contributor_predicate"] = json!({ "issued_under_template": "bafkreimemberpolicy" });
    n.clone()
}

fn allowlisted(wasm: &[u8]) -> RuntimeContext<'static> {
    let cid = formats::cid_of_bytes(wasm);
    let list: &'static [notary_admission::AllowlistEntry] = Box::leak(vec![notary_admission::AllowlistEntry { program_cid: cid, accepted_from_ms: 0, retired_at_ms: None }].into_boxed_slice());
    RuntimeContext { allowlist: Some(list), now_ms: 1_000, held_jobs: 0 }
}

#[test]
fn the_committed_module_is_admitted_with_the_template_policy() {
    let wasm = module();
    admit(&wasm, &policy(&wasm), &allowlisted(&wasm)).unwrap_or_else(|e| panic!("{} {}", e.code, e.detail));
}

fn run(inputs: &[String]) -> Value {
    let program = Program::load(&module()).expect("loads under the notary_v1 engine");
    let inputs: Vec<Vec<u8>> = inputs.iter().map(|s| s.clone().into_bytes()).collect();
    let out = program.run(br#"{"question":"Q"}"#, &inputs, RunLimits::default()).expect("runs");
    assert!(out.fuel_used < 2_000 * inputs.len() as u64 + 100_000, "{} fuel for {} inputs", out.fuel_used, inputs.len());
    let v: Value = serde_json::from_slice(&out.bytes).unwrap();
    assert_eq!(out.bytes, notary_types::jcs::canonical(&v).unwrap(), "canonical bytes");
    v
}

#[test]
fn it_tallies_the_slots_and_abstentions() {
    let ballots: Vec<String> = [1, 1, 2, 0, 8, 8, 8, 3].iter().map(|c| format!("{{\"choice\":{c}}}")).collect();
    let got = run(&ballots);
    let want = [("abstain", 1), ("option_1", 2), ("option_2", 1), ("option_3", 1), ("option_4", 0), ("option_5", 0), ("option_6", 0), ("option_7", 0), ("option_8", 3)];
    for (k, v) in want {
        assert_eq!(got[k], v, "{k}");
    }
}

#[test]
fn an_out_of_range_ballot_or_a_missing_choice_aborts() {
    let program = Program::load(&module()).unwrap();
    for bad in [r#"{"choice":9}"#, r#"{"choice":-1}"#, r#"{"nope":1}"#] {
        let r = program.run(b"{}", &[bad.as_bytes().to_vec()], RunLimits::default());
        assert_eq!(r.err().map(|e| e.reason()), Some("abort:3".to_string()), "{bad}");
    }
}

#[test]
fn a_thousand_ballots_fit_the_arena() {
    let ballots: Vec<String> = (0..1000).map(|i| format!("{{\"choice\":{}}}", i % 9)).collect();
    assert_eq!(run(&ballots)["abstain"], 112);
}
