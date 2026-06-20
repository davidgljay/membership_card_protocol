// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mock Verifier Module
/// @notice Solidity wrapper around the RIP-7212 precompile for use in Foundry tests.
///         Mirrors the interface of the Stylus verifier-module contract.
///
/// @dev The actual Stylus verifier module is a WASM contract that calls the RIP-7212
///      precompile. This Solidity mock does exactly the same thing, allowing Foundry
///      tests to verify the same signature verification logic without WASM.
contract MockVerifier {
    /// @dev RIP-7212 secp256r1 precompile address.
    address constant RIP7212 = address(0x0000000000000000000000000000000000000100);

    /// @notice Verify a secp256r1 (P-256) signature using the RIP-7212 precompile.
    ///
    /// @param message_hash  keccak256 of the signed payload (32 bytes)
    /// @param signature     r||s concatenated (64 bytes, NOT DER-encoded)
    /// @param public_key    Uncompressed x||y (64 bytes, no 0x04 prefix)
    ///
    /// @return true if the signature is valid, false otherwise.
    function verify_secp256r1(
        bytes32 message_hash,
        bytes calldata signature,
        bytes calldata public_key
    ) external view returns (bool) {
        if (signature.length != 64) return false;
        if (public_key.length != 64) return false;

        bytes32 r;
        bytes32 s;
        bytes32 x;
        bytes32 y;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            x := calldataload(public_key.offset)
            y := calldataload(add(public_key.offset, 32))
        }

        bytes memory input = abi.encode(message_hash, r, s, x, y);
        (bool success, bytes memory output) = RIP7212.staticcall(input);

        if (!success || output.length != 32) return false;
        return abi.decode(output, (bytes32)) == bytes32(uint256(1));
    }
}

/// @title Mock Verifier Always True
/// @notice A mock verifier that always returns true. Used for tests where
///         we want to test logic without generating real secp256r1 signatures.
///         NEVER deploy this to production or any network where security matters.
contract MockVerifierAlwaysTrue {
    function verify_secp256r1(
        bytes32,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }
}

/// @title Mock Verifier Always False
/// @notice A mock verifier that always returns false. Used for testing error paths.
contract MockVerifierAlwaysFalse {
    function verify_secp256r1(
        bytes32,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return false;
    }
}
