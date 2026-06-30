/**
 * masterCardSignatureAuth (implementation-plan.md §Step 1.4, OQ-WS-1,
 * OQ-WS-6). Used for recovery re-registration, keyring rotation
 * challenge/response, and recovery cancellation — any flow where the
 * device may not yet have a session token and must prove control of the
 * master card key directly.
 *
 * NOTE: @noble/post-quantum has no independent security audit at time of
 * writing (mirrors the note in press/src/functions/crypto.ts). Acceptable
 * here since this only verifies signatures over ephemeral, server-issued
 * challenges — no long-lived key material is derived from this path.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

/**
 * Verifies that `signatureB64` is a valid ML-DSA-44 signature over
 * `challenge` under `masterPubkeyB64` (base64url-encoded pubkey, as stored
 * in holder_accounts.master_pubkey).
 */
export function verifyMasterCardSignature(
  challenge: Uint8Array,
  signatureB64: string,
  masterPubkeyB64: string
): boolean {
  try {
    const signature = fromBase64Url(signatureB64);
    const publicKey = fromBase64Url(masterPubkeyB64);
    // @noble/post-quantum API: verify(sig, msg, publicKey)
    return ml_dsa44.verify(signature, challenge, publicKey);
  } catch {
    return false;
  }
}

const CHALLENGE_BYTES = 32;

/** Generates a fresh random challenge for a challenge/response flow. */
export function generateChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
}
