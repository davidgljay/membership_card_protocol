/**
 * Cryptographic operations for the Chitt Protocol.
 * Uses ML-DSA-44 (FIPS 204) for all signature verification.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa';
import { base64urlDecode } from './serialization.js';

/** ML-DSA-44 public key size in bytes. */
export const ML_DSA_44_PUBLIC_KEY_BYTES = 1312;

/** ML-DSA-44 signature size in bytes. */
export const ML_DSA_44_SIGNATURE_BYTES = 2420;

/**
 * Verify an ML-DSA-44 signature over a canonical CBOR payload.
 *
 * @param publicKeyB64  Base64url-encoded ML-DSA-44 public key (1312 bytes).
 * @param message       The exact bytes that were signed (canonical CBOR of the payload).
 * @param signatureB64  Base64url-encoded ML-DSA-44 signature (2420 bytes).
 * @returns true if the signature is cryptographically valid.
 */
export function verifySignature(
  publicKeyB64: string,
  message: Uint8Array,
  signatureB64: string,
): boolean {
  try {
    const publicKey = base64urlDecode(publicKeyB64);
    const signature = base64urlDecode(signatureB64);

    if (publicKey.length !== ML_DSA_44_PUBLIC_KEY_BYTES) {
      return false;
    }
    if (signature.length !== ML_DSA_44_SIGNATURE_BYTES) {
      return false;
    }

    return ml_dsa44.verify(publicKey, message, signature);
  } catch {
    return false;
  }
}
