//! The yes/no/abstain `vote` template (implementation step 6.2). Input `{ "choice": "yes" | "no" | "abstain" }`, output
//! `{ "abstain", "no", "yes" }`, each clamped. The `question` parameter is shown to voters and never read by the program.
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

/// `(abstain, no, yes)`. `None` for a ballot that is none of the three words.
pub fn tally<'a>(choices: impl Iterator<Item = &'a [u8]>) -> Option<(i64, i64, i64)> {
    let (mut abstain, mut no, mut yes) = (0, 0, 0);
    for c in choices {
        match c {
            b"abstain" => abstain += 1,
            b"no" => no += 1,
            b"yes" => yes += 1,
            _ => return None,
        }
    }
    Some((abstain, no, yes))
}

pub fn run_program() {
    #[cfg(target_arch = "wasm32")]
    let mut inputs = alloc::vec::Vec::new();
    #[cfg(not(target_arch = "wasm32"))]
    let mut inputs = Vec::new();
    for i in 0..g::input_count() {
        inputs.push(g::input(i));
    }
    let mut words = alloc_words();
    for input in &inputs {
        match g::json_str(input, "choice") {
            Some(w) => words.push(w),
            None => g::fail(3),
        }
    }
    let Some((abstain, no, yes)) = tally(words.iter().copied()) else { g::fail(3) };
    g::Output::default().int("abstain", abstain).int("no", no).int("yes", yes).finish();
}

#[cfg(target_arch = "wasm32")]
fn alloc_words<'a>() -> alloc::vec::Vec<&'a [u8]> {
    alloc::vec::Vec::new()
}
#[cfg(not(target_arch = "wasm32"))]
fn alloc_words<'a>() -> Vec<&'a [u8]> {
    Vec::new()
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
    fn counts_the_three_words() {
        assert_eq!(tally([&b"yes"[..], b"yes", b"no", b"abstain"].into_iter()), Some((1, 1, 2)));
        assert_eq!(tally([&b"maybe"[..]].into_iter()), None);
    }

    #[test]
    fn the_program_writes_canonical_output() {
        g::harness::set(br#"{"question":"Q"}"#, &[br#"{"choice":"yes"}"#, br#"{"choice":"no"}"#, br#"{"choice":"yes"}"#]);
        run_program();
        assert_eq!(String::from_utf8(g::harness::output().unwrap()).unwrap(), r#"{"abstain":0,"no":1,"yes":2}"#);
    }
}
