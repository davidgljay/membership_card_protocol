import { keccak_256, sha3_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';

/**
 * keccak256, used for on-chain address derivation from a public key
 * (`address = keccak256(ml_dsa_44_public_key)`, `card_verifier.md §11`) and
 * for the sub-card protocol's keccak256 binding checks (`subcards.md`).
 *
 * Returns lowercase hex, matching the verifier package's `keccak256` output
 * shape, so binding-check comparisons are string-for-string identical
 * between the two packages.
 */
export function keccak256(input: Uint8Array): string {
  return Buffer.from(keccak_256(input)).toString('hex');
}

/**
 * HKDF-SHA3-256, used for content-key derivation from a recipient public
 * key (`ikm = recipient_pubkey`, `info = "card-content-v1"`,
 * `card_verifier.md §11`) and, more generally, for any HKDF derivation
 * elsewhere in the SDK (e.g. the wallet backup KDF's HKDF step).
 */
export function hkdfSha3256(ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha3_256, ikm, undefined, new TextEncoder().encode(info), length);
}
