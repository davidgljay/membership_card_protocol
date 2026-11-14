//! The contributor policy set (notary_runtime.md §6, A12; protocol-objects.md §27 `contributor_policies`).
//!
//! A `contributor_predicate` is **closed** when a card can satisfy it only by being issued under one of a finite list
//! of policies. `issued_under_template` is closed; `any_of` is closed if it is non-empty and every child is; `all_of`
//! is closed if at least one child is; everything else is not. The policy set is the union of the closed leaves, with
//! `{ "param": name }` references resolved from the job's `parameters`.
//!
//! The TypeScript twin is `verifier/src/notary/policySet.ts`; both are checked against `notary/vectors/policy_set/`.
use serde_json::Value;
use std::collections::BTreeSet;

fn param_name(v: &Value) -> Option<&str> {
    let m = v.as_object()?;
    (m.len() == 1).then(|| m.get("param")?.as_str()).flatten()
}

/// Structural closedness, independent of any parameter values (what admission and `notary-lint` check).
pub fn is_closed(pred: &Value) -> bool {
    let Some(m) = pred.as_object().filter(|m| m.len() == 1) else { return false };
    let (op, v) = m.iter().next().expect("one entry");
    match op.as_str() {
        "issued_under_template" => v.is_string() || param_name(v).is_some(),
        "any_of" => v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(is_closed)),
        "all_of" => v.as_array().is_some_and(|a| a.iter().any(is_closed)),
        _ => false,
    }
}

fn collect(pred: &Value, params: &Value, out: &mut BTreeSet<String>) -> Option<()> {
    let m = pred.as_object().filter(|m| m.len() == 1)?;
    let (op, v) = m.iter().next().expect("one entry");
    match op.as_str() {
        "issued_under_template" => {
            let policy = match param_name(v) {
                Some(name) => params.get(name)?.as_str()?.to_string(),
                None => v.as_str()?.to_string(),
            };
            out.insert(policy);
            Some(())
        }
        "any_of" => v.as_array()?.iter().try_for_each(|c| collect(c, params, out)),
        "all_of" => {
            // only the closed children restrict; a child that is not closed adds nothing
            for c in v.as_array()?.iter().filter(|c| is_closed(c)) {
                collect(c, params, out)?;
            }
            Some(())
        }
        _ => None,
    }
}

/// The policy set, sorted and without duplicates. `None` when the predicate is open, or a parameter reference names a
/// parameter that is absent or not text.
pub fn policy_set(pred: &Value, params: &Value) -> Option<Vec<String>> {
    if !is_closed(pred) {
        return None;
    }
    let mut out = BTreeSet::new();
    collect(pred, params, &mut out)?;
    Some(out.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agrees_with_the_shared_vectors() {
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/policy_set/cases.json");
        let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        for c in file["cases"].as_array().unwrap() {
            assert_eq!(is_closed(&c["predicate"]), c["closed"].as_bool().unwrap(), "closed: {}", c["id"]);
            let want: Option<Vec<String>> = c["policy_set"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect());
            assert_eq!(policy_set(&c["predicate"], &c["parameters"]), want, "set: {}", c["id"]);
        }
    }
}
