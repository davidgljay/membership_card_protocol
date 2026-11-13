//! Field-definition checks for job `parameters` against `parameter_bounds` (W6) and input `payload` against
//! `input_schema` (B9), in the card field type system (`card_protocol_spec.md` §The Field Type System): declared
//! fields only, required fields present, and `min` / `max` / `regex` / `enum` limits. Regexes run on the `regex`
//! crate, which matches in linear time, so a policy can't make the enclave spin.
use notary_types::formats;
use serde_json::Value;

pub fn check(values: &Value, defs: Option<&Value>) -> Result<(), String> {
    let obj = values.as_object().ok_or("must be an object")?;
    let defs = match defs {
        None => {
            return if obj.is_empty() { Ok(()) } else { Err("no fields are declared".into()) };
        }
        Some(d) => d.as_array().ok_or("field definitions must be an array")?,
    };
    for k in obj.keys() {
        if !defs.iter().any(|d| d.get("name").and_then(Value::as_str) == Some(k)) {
            return Err(format!("undeclared field {k}"));
        }
    }
    for d in defs {
        let name = d.get("name").and_then(Value::as_str).ok_or("field definition without a name")?;
        let Some(v) = obj.get(name) else {
            if d.get("required").and_then(Value::as_bool).unwrap_or(false) {
                return Err(format!("{name} is required"));
            }
            continue;
        };
        let bad = || format!("{name} is out of bounds");
        match d.get("type").and_then(Value::as_str) {
            Some("integer") => {
                let x = v.as_i64().ok_or_else(bad)?;
                if d.get("min").and_then(Value::as_i64).is_some_and(|m| x < m) || d.get("max").and_then(Value::as_i64).is_some_and(|m| x > m) {
                    return Err(bad());
                }
            }
            Some("boolean") => {
                v.as_bool().ok_or_else(bad)?;
            }
            Some("text") => {
                let s = v.as_str().ok_or_else(bad)?;
                if let Some(e) = d.get("enum").and_then(Value::as_array) {
                    if !e.iter().any(|x| x.as_str() == Some(s)) {
                        return Err(bad());
                    }
                }
                if let Some(r) = d.get("regex").and_then(Value::as_str) {
                    let re = regex::Regex::new(&format!("^(?:{r})$")).map_err(|_| format!("{name}: bad regex"))?;
                    if !re.is_match(s) {
                        return Err(bad());
                    }
                }
            }
            Some("cid") => {
                let s = v.as_str().ok_or_else(bad)?;
                if !s.starts_with('b') || s.len() < 10 || !s[1..].bytes().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c)) {
                    return Err(bad());
                }
            }
            Some("card-pointer") => {
                formats::assert_card_pointer(v.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
            }
            Some("base64url") => {
                notary_types::b64u::decode(v.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
            }
            other => return Err(format!("{name}: unsupported field type {other:?}")),
        }
    }
    Ok(())
}
