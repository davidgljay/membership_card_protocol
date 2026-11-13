//! Algorithm A: one test per reject code (runtime §6, A1–A11), the deferred-feature refusals (§11, §16), the lint
//! warnings, and acceptance of a well-formed program that then runs under the notary-worker engine.
use notary_admission::{admit, lint_warnings, AllowlistEntry, Isolation, RuntimeContext};
use notary_types::{formats, jcs};
use serde_json::{json, Value};

const IMPORTS: &str = r#"
  (import "notary_v1" "input_count" (func (result i32)))
  (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))"#;

fn schema() -> Value {
    json!([{ "name": "count", "type": "integer", "required": true, "clamp": [0, 1000], "round_to": 5 }])
}

fn wat_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// A well-formed module, with optional overrides of its parts.
struct M<'a> {
    imports: &'a str,
    memory: &'a str,
    extra: &'a str,
    exports: &'a str,
    abi: Option<&'a str>,
    schema: Option<String>,
}

impl Default for M<'_> {
    fn default() -> Self {
        Self {
            imports: IMPORTS,
            memory: "(memory 1 4)",
            extra: "",
            exports: r#"(export "memory" (memory 0)) (export "run" (func $run))"#,
            abi: Some("notary_v1"),
            schema: Some(String::from_utf8(jcs::canonical(&schema()).unwrap()).unwrap()),
        }
    }
}

impl M<'_> {
    fn bytes(&self) -> Vec<u8> {
        let abi = self.abi.map(|a| format!("(@custom \"notary.abi\" \"{}\")", wat_str(a))).unwrap_or_default();
        let sch = self.schema.as_ref().map(|s| format!("(@custom \"notary.output_schema\" \"{}\")", wat_str(s))).unwrap_or_default();
        let src = format!(
            "(module {} {} {} (func $run (result i32) (drop (call $out (i32.const 0) (i32.const 0))) (i32.const 0)) {} {} {})",
            self.imports, self.memory, self.extra, self.exports, abi, sch
        );
        wat::parse_str(src).expect("wat")
    }
}

fn policy_for(bytes: &[u8], isolation: &str) -> Value {
    json!({
        "program_cid": formats::cid_of_bytes(bytes),
        "mode": "aggregate",
        "isolation": isolation,
        "output_schema": schema(),
        "privacy": { "k_min": 10 },
        "contributor_predicate": { "issued_under_template": "bafkreitest" },
    })
}

fn ctx() -> RuntimeContext<'static> {
    RuntimeContext { allowlist: None, now_ms: 1_000, held_jobs: 0 }
}

fn code(bytes: &[u8], policy: &Value, ctx: &RuntimeContext<'_>) -> &'static str {
    match admit(bytes, policy, ctx) {
        Ok(_) => "OK",
        Err(e) => e.code,
    }
}

fn reject(m: M<'_>) -> &'static str {
    let b = m.bytes();
    code(&b, &policy_for(&b, "dedicated"), &ctx())
}

#[test]
fn admits_a_well_formed_program_that_then_runs() {
    let b = M::default().bytes();
    let p = policy_for(&b, "dedicated");
    let a = admit(&b, &p, &ctx()).expect("admitted");
    assert_eq!(a.isolation, Isolation::Dedicated);
    assert_eq!(a.limits.fuel, 1_000_000_000);
    // the worker engine accepts the same module
    assert!(notary_worker::Program::load(&b).is_ok());
}

#[test]
fn a1_hash_mismatch() {
    let b = M::default().bytes();
    let mut p = policy_for(&b, "dedicated");
    p["program_cid"] = json!(formats::cid_of_bytes(b"other bytes"));
    assert_eq!(code(&b, &p, &ctx()), "ADM_HASH_MISMATCH");
    p["program_cid"] = json!("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"); // dag-pb, not raw
    assert_eq!(code(&b, &p, &ctx()), "ADM_HASH_MISMATCH");
}

#[test]
fn a2_too_large() {
    let filler = format!("(data (i32.const 0) \"{}\")", "a".repeat(4 * 1024 * 1024 + 1));
    assert_eq!(reject(M { extra: &filler, ..M::default() }), "ADM_TOO_LARGE");
}

#[test]
fn a3_feature_disallowed() {
    assert_eq!(reject(M { extra: "(func (local f32))", ..M::default() }), "ADM_FEATURE_DISALLOWED");
    assert_eq!(reject(M { extra: "(func (drop (v128.const i32x4 0 0 0 0)))", ..M::default() }), "ADM_FEATURE_DISALLOWED");
    assert_eq!(reject(M { extra: "(func $s) (start $s)", ..M::default() }), "ADM_FEATURE_DISALLOWED");
    assert_eq!(reject(M { extra: "(func $t (return_call $t))", ..M::default() }), "ADM_FEATURE_DISALLOWED");
    assert_eq!(reject(M { memory: "(memory 1 1 shared)", ..M::default() }), "ADM_FEATURE_DISALLOWED");
}

#[test]
fn a4_import_disallowed() {
    let wrong_name = r#"(import "notary_v1" "clock" (func (result i32))) (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))"#;
    assert_eq!(reject(M { imports: wrong_name, ..M::default() }), "ADM_IMPORT_DISALLOWED");
    let wrong_sig = r#"(import "notary_v1" "input_len" (func (param i64) (result i32))) (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))"#;
    assert_eq!(reject(M { imports: wrong_sig, ..M::default() }), "ADM_IMPORT_DISALLOWED");
    let wrong_module = r#"(import "env" "output_write" (func $out (param i32 i32) (result i32)))"#;
    assert_eq!(reject(M { imports: wrong_module, ..M::default() }), "ADM_IMPORT_DISALLOWED");
    let global = r#"(import "notary_v1" "g" (global i32)) (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))"#;
    assert_eq!(reject(M { imports: global, ..M::default() }), "ADM_IMPORT_DISALLOWED");
}

#[test]
fn a5_memory_limit() {
    assert_eq!(reject(M { memory: "(memory 1)", ..M::default() }), "ADM_MEMORY_LIMIT");
    assert_eq!(reject(M { memory: "(memory 1 257)", ..M::default() }), "ADM_MEMORY_LIMIT");
    let b = M { memory: "(memory 1 64)", ..M::default() }.bytes();
    let mut p = policy_for(&b, "dedicated");
    p["limits"] = json!({ "memory_pages": 16 });
    assert_eq!(code(&b, &p, &ctx()), "ADM_MEMORY_LIMIT");
}

#[test]
fn a6_table_limit() {
    assert_eq!(reject(M { extra: "(table 2000 2000 funcref)", ..M::default() }), "ADM_TABLE_LIMIT");
    assert_eq!(reject(M { extra: "(table 1 funcref)", ..M::default() }), "ADM_TABLE_LIMIT");
    assert_eq!(code(&M { extra: "(table 4 8 funcref)", ..M::default() }.bytes(), &policy_for(&M { extra: "(table 4 8 funcref)", ..M::default() }.bytes(), "dedicated"), &ctx()), "OK");
}

#[test]
fn a7_structure_limit() {
    let locals = format!("(func (local {}))", "i32 ".repeat(1001));
    assert_eq!(reject(M { extra: &locals, ..M::default() }), "ADM_STRUCTURE_LIMIT");
    let globals: String = (0..1001).map(|_| "(global i32 (i32.const 0))").collect();
    assert_eq!(reject(M { extra: &globals, ..M::default() }), "ADM_STRUCTURE_LIMIT");
    let data = format!("(data (i32.const 0) \"{}\")", "a".repeat(1024 * 1024 + 1));
    assert_eq!(reject(M { extra: &data, ..M::default() }), "ADM_STRUCTURE_LIMIT");
    let funcs: String = (0..10_000).map(|_| "(func)").collect();
    assert_eq!(reject(M { extra: &funcs, ..M::default() }), "ADM_STRUCTURE_LIMIT");
}

#[test]
fn a8_exports_invalid() {
    assert_eq!(reject(M { exports: r#"(export "memory" (memory 0))"#, ..M::default() }), "ADM_EXPORTS_INVALID");
    assert_eq!(
        reject(M { exports: r#"(export "memory" (memory 0)) (export "run" (func $run)) (export "extra" (func $run))"#, ..M::default() }),
        "ADM_EXPORTS_INVALID"
    );
    assert_eq!(
        reject(M { extra: "(func $bad (param i32) (result i32) (i32.const 0))", exports: r#"(export "memory" (memory 0)) (export "run" (func $bad))"#, ..M::default() }),
        "ADM_EXPORTS_INVALID"
    );
}

#[test]
fn a9_schema_mismatch() {
    assert_eq!(reject(M { abi: None, ..M::default() }), "ADM_SCHEMA_MISMATCH");
    assert_eq!(reject(M { abi: Some("notary_v2"), ..M::default() }), "ADM_SCHEMA_MISMATCH");
    assert_eq!(reject(M { schema: None, ..M::default() }), "ADM_SCHEMA_MISMATCH");
    // not canonical (whitespace), so not byte-equal
    assert_eq!(reject(M { schema: Some(serde_json::to_string_pretty(&schema()).unwrap()), ..M::default() }), "ADM_SCHEMA_MISMATCH");
    // duplicated section
    let dup = format!("(@custom \"notary.abi\" \"notary_v1\")");
    assert_eq!(reject(M { extra: &dup, ..M::default() }), "ADM_SCHEMA_MISMATCH");
}

#[test]
fn a10_limits_exceed_ceiling() {
    let b = M::default().bytes();
    for limits in [json!({ "fuel": 1_000_000_001u64 }), json!({ "wall_ms": 60_001 }), json!({ "max_inputs": 100_001 }), json!({ "fuel": 0 }), json!({ "unknown": 1 })] {
        let mut p = policy_for(&b, "dedicated");
        p["limits"] = limits.clone();
        assert_eq!(code(&b, &p, &ctx()), "ADM_LIMITS_EXCEED_CEILING", "{limits}");
    }
    let mut p = policy_for(&b, "dedicated");
    p["limits"] = json!({ "fuel": 5000, "wall_ms": 100, "max_inputs": 3, "memory_pages": 4 });
    let a = admit(&b, &p, &ctx()).unwrap();
    assert_eq!((a.limits.fuel, a.limits.wall_ms, a.limits.max_inputs, a.limits.memory_pages), (5000, 100, 3, 4));
}

#[test]
fn a11_isolation() {
    let b = M::default().bytes();
    let cid = formats::cid_of_bytes(&b);
    let shared = policy_for(&b, "shared");
    let empty: Vec<AllowlistEntry> = vec![];
    assert_eq!(code(&b, &shared, &RuntimeContext { allowlist: Some(&empty), now_ms: 1_000, held_jobs: 3 }), "ADM_NOT_ALLOWLISTED_FOR_SHARED");
    let retired = vec![AllowlistEntry { program_cid: cid.clone(), accepted_from_ms: 0, retired_at_ms: Some(500) }];
    assert_eq!(code(&b, &shared, &RuntimeContext { allowlist: Some(&retired), now_ms: 1_000, held_jobs: 0 }), "ADM_NOT_ALLOWLISTED_FOR_SHARED");
    let future = vec![AllowlistEntry { program_cid: cid.clone(), accepted_from_ms: 2_000, retired_at_ms: None }];
    assert_eq!(code(&b, &shared, &RuntimeContext { allowlist: Some(&future), now_ms: 1_000, held_jobs: 0 }), "ADM_NOT_ALLOWLISTED_FOR_SHARED");
    let ok = vec![AllowlistEntry { program_cid: cid, accepted_from_ms: 0, retired_at_ms: Some(5_000) }];
    assert_eq!(code(&b, &shared, &RuntimeContext { allowlist: Some(&ok), now_ms: 1_000, held_jobs: 3 }), "OK");
    let dedicated = policy_for(&b, "dedicated");
    assert_eq!(code(&b, &dedicated, &RuntimeContext { allowlist: None, now_ms: 1_000, held_jobs: 1 }), "ADM_DEDICATED_REQUIRED");
}

#[test]
fn deferred_features_are_refused() {
    let b = M::default().bytes();
    let mut p = policy_for(&b, "dedicated");
    p["privacy"]["dp"] = json!({ "epsilon_milli": 500 });
    assert_eq!(code(&b, &p, &ctx()), "ADM_DP_UNSUPPORTED");
    let mut p = policy_for(&b, "dedicated");
    p["revocation_propagation"] = json!({ "mode": "escrowed_link" });
    assert_eq!(code(&b, &p, &ctx()), "ADM_FEATURE_UNSUPPORTED");
    let mut p = policy_for(&b, "dedicated");
    p["derived_card"] = json!({ "source_kind": "web_evidence" });
    assert_eq!(code(&b, &p, &ctx()), "ADM_FEATURE_UNSUPPORTED");
    p["derived_card"] = json!({ "source_kind": "card" });
    assert_eq!(code(&b, &p, &ctx()), "OK");
}

#[test]
fn lint_warnings_match_runtime_section_6() {
    let b = M::default().bytes();
    let mut p = policy_for(&b, "dedicated");
    assert!(lint_warnings(&p).is_empty());
    p["output_schema"] = json!([{ "name": "count", "type": "integer", "required": true }]);
    p["privacy"]["k_min"] = json!(5);
    p["contributor_predicate"] = json!({ "is_holder": true });
    assert_eq!(lint_warnings(&p), vec!["LINT_WEAK_GRANULARITY", "LINT_NO_SNAPSHOT_POLICY"]);
    p["privacy"]["k_min"] = json!(10);
    assert_eq!(lint_warnings(&p), vec!["LINT_NO_SNAPSHOT_POLICY"]);
}
