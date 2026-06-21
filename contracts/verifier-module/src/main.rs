#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

// Wasm entry point (used when export-abi feature is NOT enabled).
#[cfg(not(any(test, feature = "export-abi")))]
#[unsafe(no_mangle)]
pub extern "C" fn main() {}

// Host binary used by `cargo stylus export-abi` and `cargo stylus deploy` constructor check.
#[cfg(feature = "export-abi")]
fn main() {
    use std::env;
    let cmd = env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "abi" => stylus_sdk::abi::export::print_abi::<verifier_module::VerifierModule>(
            "MIT",
            "pragma solidity ^0.8.23;",
        ),
        // No Solidity constructor — contracts are initialized via initialize().
        "constructor" => {}
        _ => {}
    }
}
