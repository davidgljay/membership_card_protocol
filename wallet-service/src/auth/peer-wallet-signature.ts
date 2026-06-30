/**
 * Peer wallet service signature verification (implementation-plan.md
 * §Step 1.4, used inline by routing endpoints in Phase 4 — not exposed as
 * Nitro middleware since it applies to specific federation routes only).
 *
 * A peer's `wallet_service_id` is defined as keccak256(public_key); this
 * verifies both that the announcement is signed by the claimed key and
 * that the claimed key actually hashes to the claimed id.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { keccak_256 } from '@noble/hashes/sha3';

function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

export function verifyPeerWalletSignature(
  message: Uint8Array,
  signatureB64: string,
  peerPublicKeyB64: string,
  claimedWalletServiceId: string
): boolean {
  try {
    const publicKey = fromBase64Url(peerPublicKeyB64);
    const derivedId = toHex(keccak_256(publicKey));
    if (derivedId.toLowerCase() !== claimedWalletServiceId.toLowerCase()) {
      return false;
    }
    const signature = fromBase64Url(signatureB64);
    return ml_dsa44.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
