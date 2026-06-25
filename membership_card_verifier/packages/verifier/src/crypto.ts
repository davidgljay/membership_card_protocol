import { keccak_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { sha3_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { p256 } from "@noble/curves/p256";
import { createDecipheriv } from "node:crypto";
import { CardProtocolError } from "./errors.js";

export function keccak256(input: Uint8Array): string {
  const hash = keccak_256(input);
  return Buffer.from(hash).toString("hex");
}

export function hkdfSha3256(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha3_256, ikm, undefined, new TextEncoder().encode(info), 32);
}

/**
 * Decrypts AES-256-GCM ciphertext.
 * Encoding: 12-byte nonce || ciphertext || 16-byte GCM tag (standard Node.js layout).
 */
export function aes256gcmDecrypt(
  key: Uint8Array,
  noncePlusCiphertext: Uint8Array
): Uint8Array {
  if (noncePlusCiphertext.length < 12 + 16) {
    throw new CardProtocolError(
      "DECRYPTION_FAILED",
      "Encrypted payload too short to contain nonce and GCM tag"
    );
  }
  const nonce = noncePlusCiphertext.subarray(0, 12);
  const tag = noncePlusCiphertext.subarray(noncePlusCiphertext.length - 16);
  const ciphertext = noncePlusCiphertext.subarray(12, noncePlusCiphertext.length - 16);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(plain);
  } catch {
    throw new CardProtocolError("DECRYPTION_FAILED", "AES-256-GCM authentication failure");
  }
}

/**
 * Verifies an ML-DSA-44 signature.
 *
 * NOTE: @noble/post-quantum has no independent security audit at time of writing (2026-06-20).
 * Additionally, this implementation has no side-channel protection — a documented limitation
 * of all JS post-quantum implementations. Lower risk here because no private key material
 * is handled by this package (verification only). Monitor @noble/post-quantum for future audit.
 */
export function mlDsa44Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  // @noble/post-quantum API: verify(sig, msg, publicKey)
  return ml_dsa44.verify(signature, message, publicKey);
}

/**
 * Verifies a secp256r1 (P-256) signature using SHA-256 prehash.
 *
 * This is the Phase 1 signing scheme used before ML-DSA-44 is rolled out.
 * Algorithm: SHA-256(canonical_message_bytes) → verify with P-256 ECDSA.
 *
 * publicKey: 64 bytes, x||y uncompressed (no 0x04 prefix), matching the on-chain
 *   StoragePressAuthEntry.press_public_key layout.
 * message: raw canonical payload bytes (prehash is applied here).
 * signature: 64 bytes, r||s compact format.
 */
export function secp256r1Phase1Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  // Prepend the 0x04 uncompressed-point prefix expected by @noble/curves.
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(publicKey, 1);

  const msgHash = sha256(message);

  try {
    return p256.verify(signature, msgHash, uncompressed);
  } catch {
    return false;
  }
}
