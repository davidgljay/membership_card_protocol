//! Code-plan §7.5, mechanism 4: the Rust side of differential fuzzing. Judges the mutants that
//! `verifier/scripts/fuzz-notary-conformance.ts` writes to `$NOTARY_FUZZ_FILE` and reports every disagreement with the
//! TypeScript verdict (or any panic). Skipped when the variable is unset, so `cargo test` stays offline and fast.
use notary_cards::{check_contributor, ContributorConfig, ContributorResult, World};
use notary_types::b64u;
use serde_json::{json, Value};

fn judge(c: &Value) -> Option<Value> {
    let world = World::from_json(&c["world"])?; // a world the port cannot read is not a verdict
    let cfg = &c["config"];
    let trusted: Vec<String> = cfg["trustedRoots"].as_array()?.iter().filter_map(|x| x.as_str().map(String::from)).collect();
    let config = ContributorConfig {
        trusted_roots: &trusted,
        app_certification_root: cfg["appCertificationRoot"].as_str()?,
        login_service_root: cfg["loginServiceCertificationRoot"].as_str()?,
        now_ms: notary_types::formats::parse_timestamp(cfg["nowIso"].as_str()?).ok()?,
        max_chain_depth: cfg.get("maxChainDepth").and_then(Value::as_u64).unwrap_or(64) as usize,
    };
    Some(match check_contributor(&world, &c["input"], &c["predicate"], c["parameters"].as_object()?, &config) {
        ContributorResult::Ok { root_key_hash, chain_addresses } => json!({ "ok": true, "root_key_hash": b64u::encode(&root_key_hash), "chain_addresses": chain_addresses }),
        ContributorResult::Err { code, .. } => json!({ "ok": false, "code": code }),
    })
}

#[test]
fn rust_agrees_with_typescript_on_the_fuzzed_mutants() {
    let Ok(path) = std::env::var("NOTARY_FUZZ_FILE") else { return };
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut bad, mut skipped, mut n) = (vec![], 0, 0);
    for c in file["cases"].as_array().unwrap() {
        n += 1;
        match std::panic::catch_unwind(|| judge(c)) {
            Err(_) => bad.push(format!("{}: Rust PANICKED", c["id"])),
            Ok(None) => skipped += 1,
            Ok(Some(got)) if got != c["expect"] => bad.push(format!("{}: TypeScript {} / Rust {}", c["id"], c["expect"], got)),
            Ok(Some(_)) => {}
        }
    }
    eprintln!("fuzz: {n} mutants, {skipped} unreadable by the port, {} disagreement(s)", bad.len());
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
