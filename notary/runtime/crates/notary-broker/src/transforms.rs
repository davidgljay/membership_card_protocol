//! Output checks and privacy transforms (notary_runtime.md §11; lifecycle Appendix B, output checks).
//!
//! Applied by the broker, never by the program, to whatever a run returns:
//! 1. parse: RFC 8785 JSON whose fields exactly match `output_schema` (`integer`, `boolean`, `text` with an `enum`
//!    of at most 256 characters); anything else is `OUTPUT_SCHEMA_VIOLATION` and nothing is released;
//! 2. `clamp: [min, max]`;
//! 3. `round_to: r` (nearest multiple, ties to even, exact integer arithmetic) **or** `buckets: [e0 < … < en]`
//!    (largest edge ≤ v; requires `clamp` with `min = e0`);
//! 4. `suppress_cell_below_k: k` (if `0 < v < k` the field is omitted; it must be `required: false`).
//!
//! The whole-output `k_min` rule is applied before the run (`insufficient_participation_output`).
use notary_types::jcs;
use serde_json::{json, Map, Value};

pub const OUTPUT_SCHEMA_VIOLATION: &str = "OUTPUT_SCHEMA_VIOLATION";
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// The fixed output when fewer than `k_min` contributors are counted.
pub fn insufficient_participation_output() -> Value {
    json!({ "insufficient_participation": true })
}

fn ints(v: Option<&Value>) -> Option<Vec<i64>> {
    v?.as_array()?.iter().map(Value::as_i64).collect()
}

/// Round to the nearest multiple of `r` (> 0), ties to the even multiple, in exact integer arithmetic.
pub fn round_ties_even(v: i64, r: i64) -> i64 {
    let q = v.div_euclid(r);
    let rem = v.rem_euclid(r); // 0..r
    let (lo, hi) = (q * r, (q + 1) * r);
    match (2 * rem as i128).cmp(&(r as i128)) {
        std::cmp::Ordering::Less => lo,
        std::cmp::Ordering::Greater => hi,
        std::cmp::Ordering::Equal => {
            if q.rem_euclid(2) == 0 {
                lo
            } else {
                hi
            }
        }
    }
}

/// Checks a policy `output_schema` is well formed for the transforms (used at job creation, so a bad schema is a
/// job rejection rather than a failure at close).
pub fn check_schema(schema: &Value) -> Result<(), String> {
    let fields = schema.as_array().ok_or("output_schema must be an array")?;
    let mut names = std::collections::BTreeSet::new();
    for f in fields {
        let name = f.get("name").and_then(Value::as_str).ok_or("field without a name")?;
        if !names.insert(name) {
            return Err(format!("duplicate field {name}"));
        }
        let required = f.get("required").and_then(Value::as_bool).unwrap_or(false);
        match f.get("type").and_then(Value::as_str) {
            Some("integer") => {
                let clamp = f.get("clamp").map(|c| ints(Some(c)).filter(|c| c.len() == 2 && c[0] <= c[1]).ok_or(format!("{name}: bad clamp")));
                let clamp = clamp.transpose()?;
                if let Some(r) = f.get("round_to") {
                    if r.as_i64().is_none_or(|r| r <= 0) {
                        return Err(format!("{name}: round_to must be a positive integer"));
                    }
                    if f.get("buckets").is_some() {
                        return Err(format!("{name}: round_to and buckets are exclusive"));
                    }
                }
                if let Some(b) = f.get("buckets") {
                    let b = ints(Some(b)).filter(|b| !b.is_empty() && b.windows(2).all(|w| w[0] < w[1])).ok_or(format!("{name}: bad buckets"))?;
                    if clamp.as_ref().is_none_or(|c| c[0] != b[0]) {
                        return Err(format!("{name}: buckets require clamp with min = e0"));
                    }
                }
                if let Some(k) = f.get("suppress_cell_below_k") {
                    if k.as_i64().is_none_or(|k| k < 1) || required {
                        return Err(format!("{name}: suppress_cell_below_k needs k ≥ 1 and required: false"));
                    }
                }
            }
            Some("boolean") => {}
            Some("text") => {
                let e = f.get("enum").and_then(Value::as_array).ok_or(format!("{name}: text needs an enum"))?;
                if e.is_empty() || e.iter().any(|x| x.as_str().is_none_or(|s| s.chars().count() > 256)) {
                    return Err(format!("{name}: enum values must be strings of at most 256 characters"));
                }
            }
            _ => return Err(format!("{name}: type must be integer, boolean or text")),
        }
    }
    Ok(())
}

/// Checks and transforms a run's raw output. Returns the canonical output object.
pub fn apply(raw: &[u8], schema: &Value) -> Result<Value, &'static str> {
    let out = jcs::parse_canonical(raw).map_err(|_| OUTPUT_SCHEMA_VIOLATION)?;
    let obj = out.as_object().ok_or(OUTPUT_SCHEMA_VIOLATION)?;
    let fields = schema.as_array().ok_or(OUTPUT_SCHEMA_VIOLATION)?;
    // exactly the declared fields
    for k in obj.keys() {
        if !fields.iter().any(|f| f.get("name").and_then(Value::as_str) == Some(k)) {
            return Err(OUTPUT_SCHEMA_VIOLATION);
        }
    }
    let mut result = Map::new();
    for f in fields {
        let name = f.get("name").and_then(Value::as_str).ok_or(OUTPUT_SCHEMA_VIOLATION)?;
        let required = f.get("required").and_then(Value::as_bool).unwrap_or(false);
        let Some(v) = obj.get(name) else {
            if required {
                return Err(OUTPUT_SCHEMA_VIOLATION);
            }
            continue;
        };
        match f.get("type").and_then(Value::as_str) {
            Some("boolean") => {
                if !v.is_boolean() {
                    return Err(OUTPUT_SCHEMA_VIOLATION);
                }
                result.insert(name.into(), v.clone());
            }
            Some("text") => {
                let s = v.as_str().ok_or(OUTPUT_SCHEMA_VIOLATION)?;
                let allowed = f.get("enum").and_then(Value::as_array).ok_or(OUTPUT_SCHEMA_VIOLATION)?;
                if s.chars().count() > 256 || !allowed.iter().any(|a| a.as_str() == Some(s)) {
                    return Err(OUTPUT_SCHEMA_VIOLATION);
                }
                result.insert(name.into(), v.clone());
            }
            Some("integer") => {
                let mut x = v.as_i64().filter(|x| x.abs() <= MAX_SAFE).ok_or(OUTPUT_SCHEMA_VIOLATION)?;
                if let Some(c) = ints(f.get("clamp")) {
                    let [lo, hi] = c[..] else { return Err(OUTPUT_SCHEMA_VIOLATION) };
                    x = x.clamp(lo, hi);
                }
                if let Some(r) = f.get("round_to").and_then(Value::as_i64) {
                    if r <= 0 {
                        return Err(OUTPUT_SCHEMA_VIOLATION);
                    }
                    x = round_ties_even(x, r);
                } else if let Some(edges) = ints(f.get("buckets")) {
                    x = edges.iter().copied().filter(|e| *e <= x).max().ok_or(OUTPUT_SCHEMA_VIOLATION)?;
                }
                if let Some(k) = f.get("suppress_cell_below_k").and_then(Value::as_i64) {
                    if x > 0 && x < k {
                        if required {
                            return Err(OUTPUT_SCHEMA_VIOLATION);
                        }
                        continue;
                    }
                }
                result.insert(name.into(), json!(x));
            }
            _ => return Err(OUTPUT_SCHEMA_VIOLATION),
        }
    }
    Ok(Value::Object(result))
}
