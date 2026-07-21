/** Shared hashing helpers used across account creation, keyring storage, and federation routing. */

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';

/**
 * keccak256 of a base64url string's decoded bytes, returned as unprefixed
 * lowercase hex — matching the convention used throughout the rest of the
 * system (app-sdk's `keccak256`, wallet-sdk's `computeKeyringId`/`cardHash`,
 * `CardVerifier`), all of which compare their outputs directly against each
 * other with no `0x` prefix. This function's every caller compares its
 * result against one of those values (card_hash, keyring_id), so a
 * prefixed result here was a real, previously-unexercised mismatch — see
 * `card_verifier.md`/`registry.ts`'s own doc comments on this convention.
 */
export function keccak256OfBase64Url(base64url: string): string {
  const bytes = Buffer.from(base64url, 'base64url');
  return Buffer.from(keccak_256(bytes)).toString('hex');
}

/**
 * Hashes a client IP address for use as a rate-limit bucket key (Step 6.1).
 * The raw IP is never used as a key or stored anywhere — only this
 * non-reversible hash, so even an ephemeral KV rate-limit record never
 * holds the IP itself.
 */
export function hashIp(ip: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(ip))).toString('hex');
}
