import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

/**
 * ML-DSA-44 (FIPS 204) — the SDK's content-signing primitive for every
 * IPFS-side signature the client produces or checks: card offers, card
 * documents, log entries, message envelopes (`ARCHITECTURE.md` ADR-004,
 * `card_verifier.md §11`).
 *
 * Thin wrapper over `@noble/post-quantum`; no independent implementation of
 * the signature scheme lives here.
 */

export interface MlDsa44Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate a fresh ML-DSA-44 keypair.
 *
 * @param seed - Optional deterministic seed, for test vectors only. Callers
 *   generating real keys must omit this and let the underlying CSPRNG
 *   supply entropy.
 */
export function mlDsa44GenerateKeypair(seed?: Uint8Array): MlDsa44Keypair {
  return ml_dsa44.keygen(seed);
}

/**
 * Sign `message` with an ML-DSA-44 secret key.
 */
export function mlDsa44Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ml_dsa44.sign(message, secretKey);
}

/**
 * Recover the public key belonging to an ML-DSA-44 secret key.
 *
 * Used by recovery (`wallet/recovery.ts`, Step 2.4) to reconstruct
 * `masterPublicKey` from the master private key recovered out of the
 * decrypted keyring — `wallet/keyring.ts`'s `KeyringEntry` stores only
 * `privateKey`, not the corresponding public key, since Step 2.1 never
 * needed it (the public key was already in scope, freshly generated,
 * throughout `setupWallet`).
 */
export function mlDsa44GetPublicKey(secretKey: Uint8Array): Uint8Array {
  return ml_dsa44.getPublicKey(secretKey);
}

/**
 * Verify an ML-DSA-44 signature.
 *
 * NOTE: `@noble/post-quantum` has no independent security audit at time of
 * writing, and this implementation has no side-channel protection — a
 * documented limitation of all JS post-quantum implementations. Mirrors the
 * caveat already recorded in the verifier package's `mlDsa44Verify`.
 */
export function mlDsa44Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  return ml_dsa44.verify(signature, message, publicKey);
}
