import { keccak_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { sha3_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { p256 } from "@noble/curves/p256";
import { CardProtocolError } from "./errors.js";

export function keccak256(input: Uint8Array): string {
  const hash = keccak_256(input);
  return Buffer.from(hash).toString("hex");
}

export function hkdfSha3256(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha3_256, ikm, undefined, new TextEncoder().encode(info), 32);
}

// Web Crypto's BufferSource rejects a Uint8Array view over a larger/shared
// backing buffer under strict lib.dom typings — copy into a fresh,
// plain-ArrayBuffer-backed Uint8Array first (same fix used elsewhere in
// this codebase for the identical API, e.g. wallet-service's
// WebCryptoBackend and press's aes256gcmEncrypt/Decrypt).
function toArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

/**
 * Decrypts AES-256-GCM ciphertext.
 * Encoding: 12-byte nonce || ciphertext || 16-byte GCM tag (standard Node.js layout).
 *
 * Uses Web Crypto (`crypto.subtle`) rather than `node:crypto`'s
 * createDecipheriv — the latter is one of the Node APIs `unenv` doesn't
 * polyfill under Workers' `nodejs_compat` (confirmed for the sibling
 * `createCipheriv` API in press's own crypto.ts; this package's
 * `createDecipheriv` is the same class of gap, and press itself depends on
 * this package, so this was already a latent bug in already-shipped code —
 * just not yet triggered, since evaluatePredicates/CardVerifier.verifyCard
 * is only reached by targeted issuance to an *existing* recipient, a path
 * Phase 2.1's fixture didn't exercise). `crypto.subtle` is a native Workers
 * API, available in browsers, and available in Node 22+.
 */
export async function aes256gcmDecrypt(
  key: Uint8Array,
  noncePlusCiphertext: Uint8Array
): Promise<Uint8Array> {
  if (noncePlusCiphertext.length < 12 + 16) {
    throw new CardProtocolError(
      "DECRYPTION_FAILED",
      "Encrypted payload too short to contain nonce and GCM tag"
    );
  }
  const nonce = noncePlusCiphertext.subarray(0, 12);
  const ciphertextAndTag = noncePlusCiphertext.subarray(12);

  try {
    const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      cryptoKey,
      toArrayBuffer(ciphertextAndTag)
    );
    return new Uint8Array(plaintext);
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
