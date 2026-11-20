//! The `derive` template (code-plan §2; implementation step 6.4): the program of a derived-card job.
//!
//! - **Input** (one per run: a per-input job runs once per input): the source card's values for the job's
//!   `parameters.projected_fields`, as RFC 8785 JSON: `{ "<field>": <value>, … }`. The broker builds it from the source card
//!   it has verified, so the program never sees a card, a key or an address.
//! - **Output**: the same object, byte for byte. It becomes the derived card's `projected` field.
//!
//! The program is deliberately a copy. What makes a derived card private is not in it: the broker refuses any output that
//! isn't exactly the projected values, verbatim (check D4), so a faulty or hostile version of this program can't add, drop
//! or alter a value, and the anonymity-set rule (propagation §4) decides whether the values are shared widely enough to
//! release. A different transformation (a bucketed value, a derived flag) is a different template.
//!
//! The output schema is empty (`schema.json`): the shape follows the job's `projected_fields`, which the template policy
//! bounds, and the broker enforces it per run.
//!
//! Aborts: `abort:3` for an input that isn't a JSON object.
#![cfg_attr(target_arch = "wasm32", no_std)]

use notary_guest as g;

/// The ABI version and the output schema, as the custom sections admission checks (A9).
#[cfg(target_arch = "wasm32")]
#[link_section = "notary.abi"]
#[used]
static ABI: [u8; 9] = *b"notary_v1";

const SCHEMA_JSON: &[u8] = include_bytes!("../schema.json");
#[cfg(target_arch = "wasm32")]
#[link_section = "notary.output_schema"]
#[used]
static SCHEMA: [u8; SCHEMA_JSON.len()] = {
    let mut out = [0u8; SCHEMA_JSON.len()];
    let mut i = 0;
    while i < out.len() {
        out[i] = SCHEMA_JSON[i];
        i += 1;
    }
    out
};

/// Whether `json` looks like one JSON object (`{ … }`, no leading or trailing bytes).
pub fn is_object(json: &[u8]) -> bool {
    json.len() >= 2 && json[0] == b'{' && json[json.len() - 1] == b'}'
}

/// The program body.
pub fn run_program() {
    if g::input_count() != 1 {
        g::fail(3);
    }
    let input = g::input(0);
    if !is_object(&input) {
        g::fail(3);
    }
    g::output_raw(&input);
}

/// The module's `run` export (`() -> i32`).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn run() -> i32 {
    run_program();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_the_canonical_form_of_the_policy_schema() {
        let policy: serde_json::Value = serde_json::from_str(include_str!("../policy.json")).unwrap();
        let canonical = notary_types::jcs::canonical(&policy["notary"]["output_schema"]).unwrap();
        assert_eq!(canonical, SCHEMA_JSON, "schema.json must be the canonical output_schema of policy.json");
    }

    #[test]
    fn the_program_copies_its_input() {
        g::harness::set(b"{}", &[br#"{"level":"gold","team":"red"}"#]);
        run_program();
        assert_eq!(g::harness::output().unwrap(), br#"{"level":"gold","team":"red"}"#);
    }

    #[test]
    fn only_a_json_object_is_copied() {
        assert!(is_object(b"{}") && is_object(br#"{"a":1}"#));
        assert!(!is_object(b"") && !is_object(b"[1]") && !is_object(b"{") && !is_object(b"1"));
    }
}
