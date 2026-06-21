//! # Verifier Module
//!
//! Phase 1 implementation: wraps the RIP-7212 secp256r1 precompile.
//!
//! ## Architecture role (§6.3 of registry_contract.md v0.3)
//!
//! - **No state.** This is a pure computation contract. It holds no storage.
//! - **Upgradeable via 48-hour timelock (UpgradeVerifier).** In Phase 3, this
//!   contract will be replaced with a Stylus WASM ML-DSA-44 verifier.
//! - **Address stored in logic contract.** The logic contract calls this on every
//!   signature verification. A verifier upgrade changes the address in the logic
//!   contract without requiring a logic contract upgrade.
//!
//! ## RIP-7212 precompile (§1 of spec)
//!
//! The precompile lives at `0x0000000000000000000000000000000000000100` on Arbitrum.
//! It verifies secp256r1 (P-256) signatures via the same algorithm as
//! [EIP-7212](https://eips.ethereum.org/EIPS/eip-7212).
//!
//! **Precompile ABI:**
//! Input  (160 bytes): `abi.encode(bytes32 hash, bytes32 r, bytes32 s, bytes32 x, bytes32 y)`
//! Output (32 bytes):  `bytes32(1)` = valid, `bytes32(0)` = invalid
//!
//! ## Security notes for auditors
//!
//! - The precompile does NOT check the 0x04 prefix; the logic contract must pass
//!   the raw x||y bytes (64 bytes total), not the full uncompressed point format.
//! - A `false` return does NOT revert. Callers (logic contract) are responsible for
//!   converting a false return into a revert with the appropriate error code.
//! - Failed staticcall (e.g., precompile not available) returns `false` conservatively.
//!   This prevents silent auth bypass if the precompile is somehow unavailable.
//! - Gas cost is approximately 3,450 gas per call (§1 of spec). This is the dominant
//!   cost factor for write operations.

#![cfg_attr(not(feature = "export-abi"), no_std)]
#[macro_use]
extern crate alloc;

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{Address, B256},
    call::RawCall,
    prelude::*,
};

/// RIP-7212 secp256r1 precompile address on Arbitrum One and Arbitrum Sepolia.
/// This is the standard address defined in EIP-7212.
const RIP7212_PRECOMPILE: Address = Address::new([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
]);

/// The verifier module contract.
///
/// Stateless contract wrapping the RIP-7212 precompile.
/// All state is held in the storage contract; this contract only computes.
#[storage]
#[entrypoint]
pub struct VerifierModule {}

#[public]
impl VerifierModule {
    /// Verify a secp256r1 (P-256) signature using the RIP-7212 precompile.
    ///
    /// # Arguments
    /// * `message_hash` — keccak256 of the signed payload (32 bytes)
    /// * `signature`    — r (32 bytes) concatenated with s (32 bytes) = 64 bytes total.
    ///                    NOT DER-encoded. NOT prefixed with recovery ID.
    /// * `public_key`   — Uncompressed point x||y (32+32 = 64 bytes total).
    ///                    NO 0x04 prefix — the precompile expects raw x and y coordinates.
    ///
    /// # Returns
    /// * `true`  — Signature is valid for the given message_hash and public_key.
    /// * `false` — Signature is invalid, OR the precompile call failed.
    ///
    /// # Does NOT revert
    /// Invalid signatures return `false`, not a revert. The logic contract
    /// checks the return value and reverts with E-06 or E-16 as appropriate.
    ///
    /// # Gas
    /// Approximately 3,450 gas per call (§1 of spec, EIP-7212 precompile cost).
    pub fn verify_secp256r1(
        &self,
        message_hash: B256,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) -> Result<bool, Vec<u8>> {
        let sig_bytes = signature.as_slice();
        let pk_bytes = public_key.as_slice();

        // Validate input lengths before calling precompile.
        // Wrong lengths would cause the precompile to return invalid.
        if sig_bytes.len() != 64 {
            return Ok(false);
        }
        if pk_bytes.len() != 64 {
            return Ok(false);
        }

        Ok(call_rip7212(message_hash.0, sig_bytes, pk_bytes))
    }
}

/// Low-level call to the RIP-7212 precompile.
///
/// Encodes input as: hash (32 bytes) || r (32 bytes) || s (32 bytes) || x (32 bytes) || y (32 bytes)
/// = 160 bytes total.
///
/// Returns true if the precompile returns bytes32(1), false otherwise (including call failure).
///
/// Security: We use `new_static()` to make this a staticcall, preventing the precompile
/// from modifying state (it can't anyway, but staticcall makes the intent explicit).
pub fn call_rip7212(hash: [u8; 32], signature: &[u8], public_key: &[u8]) -> bool {
    // Build the 160-byte input buffer.
    // Format: hash || r || s || x || y (each 32 bytes)
    let mut input = [0u8; 160];
    input[0..32].copy_from_slice(&hash);
    input[32..64].copy_from_slice(&signature[0..32]);   // r
    input[64..96].copy_from_slice(&signature[32..64]);  // s
    input[96..128].copy_from_slice(&public_key[0..32]); // x
    input[128..160].copy_from_slice(&public_key[32..64]); // y

    // Call the precompile via staticcall.
    // Returns Err if the call fails (precompile reverts, out of gas, etc.).
    // We treat any call failure as an invalid signature to fail safe.
    let result = unsafe {
        RawCall::new_static()
            .call(RIP7212_PRECOMPILE, &input)
    };

    match result {
        Ok(output) => {
            // Precompile returns 32 bytes: bytes32(1) = valid, bytes32(0) = invalid.
            // Check that the output is exactly bytes32(1).
            if output.len() != 32 {
                return false;
            }
            // The valid case is when the last byte is 1 and all others are 0.
            output[31] == 1
                && output[..31].iter().all(|&b| b == 0)
        }
        Err(_) => {
            // Call failed — treat as invalid to fail safely.
            // This could happen if the precompile is not available on the network
            // (e.g., non-Arbitrum fork without RIP-7212). Failing safe here
            // prevents silent authentication bypass.
            false
        }
    }
}

// In stylus-sdk 0.8, Vec<u8> natively implements AbiType and maps to Solidity `bytes`.
// No custom Bytes wrapper is needed.
