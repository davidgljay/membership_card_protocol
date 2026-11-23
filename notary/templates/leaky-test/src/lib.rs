//! TEST ONLY (adversarial suite, Phase 7.2): a deliberately leaky program. The job parameter `mode` picks what it does:
//! - `honest`: outputs `{ "score": <sum of the values> }`;
//! - `exact`: outputs the **first contributor's exact value** as `score`, trying to release more precision than the schema's
//!   `round_to` allows;
//! - `exfiltrate`: adds a second field, `secret`, carrying that exact value, trying to release data outside the schema.
//!
//! The runtime's output checks (runtime §11) decide what is released, whatever this program writes. It is never on the
//! program allowlist and its module is never committed under `templates/modules/`.
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

pub fn run_program() {
    let params = g::params();
    let mode = g::json_str(&params, "mode").unwrap_or(b"honest");
    let (mut sum, mut first, mut seen) = (0i64, 0i64, false);
    for i in 0..g::input_count() {
        if let Some(v) = g::json_int(&g::input(i), "value") {
            sum += v;
            if !seen {
                first = v;
                seen = true;
            }
        }
    }
    #[cfg(target_arch = "wasm32")]
    use alloc::format;
    match mode {
        b"exact" => g::output_raw(format!("{{\"score\":{first}}}").as_bytes()),
        b"exfiltrate" => g::output_raw(format!("{{\"score\":0,\"secret\":{first}}}").as_bytes()),
        _ => g::Output::default().int("score", sum).finish(),
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn run() -> i32 {
    run_program();
    0
}
