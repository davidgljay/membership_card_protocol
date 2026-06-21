#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

#[cfg(not(any(test, feature = "export-abi")))]
#[unsafe(no_mangle)]
pub extern "C" fn main() {}

#[cfg(feature = "export-abi")]
fn main() {
    use std::env;
    let cmd = env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "abi" => stylus_sdk::abi::export::print_abi::<storage_contract::StorageContract>(
            "MIT",
            "pragma solidity ^0.8.23;",
        ),
        "constructor" => {}
        _ => {}
    }
}
