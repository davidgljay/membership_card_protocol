//! The predicate system with parameter references — twin of `verifier/src/notary/predicates.ts` (E28), with the same
//! fail-closed rules: one-key objects only; unknown leaves and `code_equals` are false; a parameter reference outside a
//! notary context makes the whole predicate false, and an unknown name makes the leaf false; regexes match the whole
//! string, and lookaround or backreferences make the leaf false.
use serde_json::{Map, Value};

pub struct Context<'a> {
    pub chain: &'a [(String, &'a Map<String, Value>)],
    pub addresses: &'a [String],
    pub parameters: Option<&'a Map<String, Value>>,
    pub is_holder: bool,
    pub is_issuer: bool,
}

struct Invalid;

fn unsupported(p: &str) -> bool {
    p.contains("(?=") || p.contains("(?!") || p.contains("(?<=") || p.contains("(?<!") || p.contains("\\k<")
        || p.as_bytes().windows(2).any(|w| w[0] == b'\\' && (b'1'..=b'9').contains(&w[1]))
}

/// Whole-string match, limited to the regex subset JavaScript and Rust both support.
pub fn full_match(pattern: &str, value: &str) -> bool {
    if unsupported(pattern) {
        return false;
    }
    regex::Regex::new(&format!("^(?:{pattern})$")).is_ok_and(|r| r.is_match(value))
}

fn resolve<'v>(v: &'v Value, ctx: &'v Context<'_>) -> Result<Option<&'v Value>, Invalid> {
    if let Value::Object(m) = v {
        if m.len() == 1 {
            if let Some(name) = m.get("param") {
                let params = ctx.parameters.ok_or(Invalid)?;
                return Ok(name.as_str().and_then(|n| params.get(n)));
            }
        }
    }
    Ok(Some(v))
}

fn eval(expr: &Value, ctx: &Context<'_>) -> Result<bool, Invalid> {
    let Value::Object(m) = expr else { return Ok(false) };
    if m.len() != 1 {
        return Ok(false);
    }
    let (op, raw) = m.iter().next().expect("one key");
    if matches!(op.as_str(), "any_of" | "all_of" | "none_of") {
        let Value::Array(items) = raw else { return Ok(false) };
        let mut results = Vec::with_capacity(items.len());
        for e in items {
            results.push(eval(e, ctx)?);
        }
        return Ok(match op.as_str() {
            "any_of" => results.iter().any(|x| *x),
            "all_of" => results.iter().all(|x| *x),
            _ => !results.iter().any(|x| *x),
        });
    }
    let Some(v) = resolve(raw, ctx)? else { return Ok(false) };
    Ok(match op.as_str() {
        "issued_under_template" => v.as_str().is_some_and(|t| ctx.chain.first().and_then(|(_, c)| c.get("policy_id")).and_then(Value::as_str) == Some(t)),
        "chain_includes" => v.as_str().is_some_and(|a| ctx.addresses.iter().any(|x| x == a)),
        "card_field_matches" => {
            let Value::Object(o) = v else { return Ok(false) };
            match (o.get("template").and_then(Value::as_str), o.get("field").and_then(Value::as_str), o.get("regex").and_then(Value::as_str)) {
                (Some(t), Some(f), Some(r)) if o.len() == 3 => ctx.chain.iter().any(|(_, c)| {
                    c.get("policy_id").and_then(Value::as_str) == Some(t) && c.get(f).and_then(Value::as_str).is_some_and(|x| full_match(r, x))
                }),
                _ => false,
            }
        }
        "is_holder" => v == &Value::Bool(true) && ctx.is_holder,
        "is_issuer" => v == &Value::Bool(true) && ctx.is_issuer,
        "chain_depth_at_most" => v.as_u64().is_some_and(|n| (ctx.addresses.len() as u64) <= n) && v.is_u64(),
        _ => false,
    })
}

/// Evaluates a predicate; an invalid predicate is `false`.
pub fn evaluate(predicate: &Value, ctx: &Context<'_>) -> bool {
    eval(predicate, ctx).unwrap_or(false)
}
