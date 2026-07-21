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

const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encodes bytes as a base64url string, no padding — the encode-direction
 * counterpart to {@link base64UrlToBytes}, avoiding the same
 * `Buffer.prototype.toString("base64url")` polyfill gap.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    output += BASE64URL_CHARS[b0 >> 2];
    output += BASE64URL_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) {
      output += BASE64URL_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    }
    if (b2 !== undefined) {
      output += BASE64URL_CHARS[b2 & 0x3f];
    }
  }
  return output;
}

/**
 * Decodes a base64url string to bytes without relying on `Buffer.from(str,
 * "base64url")` — the browser `buffer` polyfill used when this package is
 * bundled for a browser target (e.g. the web SDK harness) doesn't support
 * the `"base64url"` encoding argument, throwing `Unknown encoding:
 * base64url` (confirmed empirically). `Buffer.from(bytes).toString("hex")`
 * elsewhere in this file is unaffected — only the from-base64url decode
 * direction hits the polyfill gap.
 */
export function base64UrlToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of cleaned) {
    const value = STANDARD_ALPHABET.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return new Uint8Array(bytes);
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
