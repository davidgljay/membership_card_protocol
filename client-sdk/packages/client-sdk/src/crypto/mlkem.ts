import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

/**
 * ML-KEM-768 (FIPS 203) — the SDK's key-encapsulation primitive for E2E
 * message transport (`ARCHITECTURE.md` ADR-004, ADR-007), including sender
 * per-subcard fan-out (`message_routing.md §Sender-Side Fan-out`).
 *
 * Thin wrapper over `@noble/post-quantum`; no independent implementation of
 * the KEM lives here. Not present in the verifier package, which is
 * verification-only and never encapsulates or decapsulates.
 */

export interface MlKem768Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface MlKem768Encapsulation {
  cipherText: Uint8Array;
  sharedSecret: Uint8Array;
}

/**
 * Generate a fresh ML-KEM-768 keypair.
 *
 * @param seed - Optional deterministic seed, for test vectors only. Callers
 *   generating real keys must omit this and let the underlying CSPRNG
 *   supply entropy.
 */
export function mlKem768GenerateKeypair(seed?: Uint8Array): MlKem768Keypair {
  return ml_kem768.keygen(seed);
}

/**
 * Encapsulate a fresh shared secret to `publicKey`. Used by a message
 * sender, once per recipient sub-card public key.
 */
export function mlKem768Encapsulate(publicKey: Uint8Array): MlKem768Encapsulation {
  return ml_kem768.encapsulate(publicKey);
}

/**
 * Recover the shared secret from `cipherText` using the corresponding
 * secret key. Used by a message recipient on receipt of a routing
 * envelope.
 */
export function mlKem768Decapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(cipherText, secretKey);
}
