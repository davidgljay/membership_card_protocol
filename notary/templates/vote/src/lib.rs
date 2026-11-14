//! The `vote` template (implementation step 6.2): up to eight options and abstain, counted in fixed slots.
//!
//! - **Input**: `{ "choice": integer }`, 0 = abstain, 1 to 8 = that option (`input_schema` bounds it to 0..=8).
//! - **Parameters**: `question` and optional `option_1 … option_8` labels. They are shown to voters and recorded in the
//!   signed job; **the program never reads them**, so the schema stays fixed whatever the question is.
//! - **Output** (`schema.json`, embedded as `notary.output_schema`): `option_1 … option_8` and `abstain`, each clamped.
//!
//! The policy's `input_replacement: "latest_wins"` and the runtime decide which ballot counts (the highest revision per
//! contributor), so the program just counts what it is given. A ballot outside 0..=8 aborts the run (`abort:3`); the
//! broker has already checked the payload against `input_schema`, so this is a defence, not a path.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
extern crate alloc;

use notary_guest as g;

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

pub const OPTIONS: usize = 8;

/// `counts[0]` is abstentions; `counts[k]` is option `k`. `None` for a ballot outside 0..=8.
pub fn tally(choices: &[i64]) -> Option<[i64; OPTIONS + 1]> {
    let mut counts = [0i64; OPTIONS + 1];
    for c in choices {
        if !(0..=OPTIONS as i64).contains(c) {
            return None;
        }
        counts[*c as usize] += 1;
    }
    Some(counts)
}

const NAMES: [&str; OPTIONS] = ["option_1", "option_2", "option_3", "option_4", "option_5", "option_6", "option_7", "option_8"];

pub fn run_program() {
    #[cfg(target_arch = "wasm32")]
    let mut choices = alloc::vec::Vec::new();
    #[cfg(not(target_arch = "wasm32"))]
    let mut choices = Vec::new();
    for i in 0..g::input_count() {
        match g::json_int(&g::input(i), "choice") {
            Some(c) => choices.push(c),
            None => g::fail(3),
        }
    }
    let Some(counts) = tally(&choices) else { g::fail(3) };
    let mut out = g::Output::default().int("abstain", counts[0]);
    for (name, n) in NAMES.iter().zip(&counts[1..]) {
        out = out.int(name, *n);
    }
    out.finish();
}

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
        assert_eq!(notary_types::jcs::canonical(&policy["notary"]["output_schema"]).unwrap(), SCHEMA_JSON);
    }

    #[test]
    fn counts_each_slot_and_abstentions() {
        let t = tally(&[1, 1, 2, 0, 8, 8, 8]).unwrap();
        assert_eq!(t, [1, 2, 1, 0, 0, 0, 0, 0, 3]);
        assert!(tally(&[9]).is_none() && tally(&[-1]).is_none());
        assert_eq!(tally(&[]).unwrap(), [0; 9]);
    }

    #[test]
    fn the_program_writes_canonical_output() {
        g::harness::set(br#"{"question":"Q"}"#, &[br#"{"choice":2}"#, br#"{"choice":2}"#, br#"{"choice":0}"#]);
        run_program();
        assert_eq!(
            String::from_utf8(g::harness::output().unwrap()).unwrap(),
            r#"{"abstain":1,"option_1":0,"option_2":2,"option_3":0,"option_4":0,"option_5":0,"option_6":0,"option_7":0,"option_8":0}"#
        );
    }
}
