//! `notary-lint <policy.json> <program.wasm> [--allowlist <list.json>] [--now-ms <ms>]`
//!
//! Runs algorithm A exactly as the runtime does (notary_runtime.md §6), then the non-fatal lint warnings.
//! `policy.json` is a whole `PolicyCardDocument` (its `notary` section is used) or the `notary` section alone.
//! A11 for `shared` programs is checked only when an allowlist is given (a JSON array of
//! `{ "program_cid", "accepted_from_ms", "retired_at_ms"? }` taken from a list version verified by algorithm L);
//! without one, lint reports `allowlist_not_checked`.
//!
//! Prints one JSON object and exits 0 if admitted, 1 if refused, 2 on usage or I/O errors.
use notary_admission::{admit, lint_warnings, AllowlistEntry, RuntimeContext};
use serde_json::{json, Value};

fn main() {
    std::process::exit(run(std::env::args().skip(1).collect()));
}

fn run(args: Vec<String>) -> i32 {
    let mut pos = Vec::new();
    let (mut allowlist_path, mut now_ms) = (None, None);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--allowlist" => allowlist_path = it.next(),
            "--now-ms" => now_ms = it.next().and_then(|s| s.parse::<i64>().ok()),
            _ => pos.push(a),
        }
    }
    let [policy_path, program_path] = pos.as_slice() else {
        eprintln!("usage: notary-lint <policy.json> <program.wasm> [--allowlist <list.json>] [--now-ms <ms>]");
        return 2;
    };
    let read = |p: &str| std::fs::read(p).map_err(|e| format!("{p}: {e}"));
    let (policy, program) = match (read(policy_path), read(program_path)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let Ok(policy) = serde_json::from_slice::<Value>(&policy) else {
        eprintln!("{policy_path}: not JSON");
        return 2;
    };
    let notary = policy.get("notary").cloned().unwrap_or(policy);
    let allowlist: Option<Vec<AllowlistEntry>> = match allowlist_path {
        None => None,
        Some(p) => {
            let Ok(Value::Array(items)) = read(&p).map(|b| serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)) else {
                eprintln!("{p}: expected a JSON array");
                return 2;
            };
            Some(
                items
                    .iter()
                    .filter_map(|e| {
                        Some(AllowlistEntry {
                            program_cid: e.get("program_cid")?.as_str()?.to_string(),
                            accepted_from_ms: e.get("accepted_from_ms")?.as_i64()?,
                            retired_at_ms: e.get("retired_at_ms").and_then(Value::as_i64),
                        })
                    })
                    .collect(),
            )
        }
    };
    let now = now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    });
    let ctx = RuntimeContext { allowlist: allowlist.as_deref(), now_ms: now, held_jobs: 0 };
    let warnings = lint_warnings(&notary);
    let shared_unchecked = notary.get("isolation").and_then(Value::as_str) == Some("shared") && allowlist.is_none();
    let (out, status) = match admit(&program, &notary, &ctx) {
        Ok(a) => (
            json!({ "admitted": true, "warnings": warnings, "allowlist_not_checked": shared_unchecked,
                    "limits": { "fuel": a.limits.fuel, "memory_pages": a.limits.memory_pages, "wall_ms": a.limits.wall_ms, "max_inputs": a.limits.max_inputs } }),
            0,
        ),
        Err(e) => (json!({ "admitted": false, "error": e.code, "detail": e.detail, "warnings": warnings }), 1),
    };
    println!("{out}");
    status
}
