/**
 * Press-side cryptographic operations: signing and encryption.
 *
 * Verification functions live in @membership-card-protocol/verifier/crypto.
 * This module holds the counterpart operations that require private key material.
 *
 * NOTE: @noble/post-quantum has no independent security audit at time of writing.
 * This is acceptable for Phase 1 since the ML-DSA-44 key is held only in memory
 * within the press process and never persisted. Monitor for future audits.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { p256 } from '@noble/curves/p256';
import { keccak_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';
import { sha3_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';

// ---------------------------------------------------------------------------
// ML-DSA-44 signing
// ---------------------------------------------------------------------------

/**
 * Sign `message` with the press's ML-DSA-44 private key.
 * Returns the raw 2420-byte signature.
 */
export function mlDsa44Sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  // noble/post-quantum API: sign(message, secretKey)
  return ml_dsa44.sign(message, privateKey);
}

// ---------------------------------------------------------------------------
// secp256r1 signing (on-chain authorization)
// ---------------------------------------------------------------------------

/**
 * Sign `messageHash` (32 bytes, keccak256 of payload) with the press's
 * secp256r1 private key. Returns 64-byte r||s compact signature.
 *
 * Matches the Phase 1 on-chain scheme: keccak256(payload_bytes) is passed
 * directly as the hash; no additional SHA-256 prehash is applied here
 * (the contract verifies via RIP-7212 with the raw keccak256 digest).
 */
export function secp256r1Sign(privateKeyHex: string, messageHash: Uint8Array): Uint8Array {
  const privKey = privateKeyHex.startsWith('0x')
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  const sig = p256.sign(messageHash, privKey, { lowS: true, prehash: false });
  return sig.toCompactRawBytes();
}

// ---------------------------------------------------------------------------
// keccak256 digest
// ---------------------------------------------------------------------------

export function keccak256(input: Uint8Array): Uint8Array {
  return keccak_256(input);
}

// ---------------------------------------------------------------------------
// Content-key derivation (card document encryption)
// ---------------------------------------------------------------------------

/**
 * Derive the AES-256 content key for a card document.
 * Key = HKDF-SHA3-256(ikm=recipientPubkey, salt=undefined, info="card-content-v1", length=32)
 */
export function deriveContentKey(recipientPubkey: Uint8Array): Uint8Array {
  return hkdf(sha3_256, recipientPubkey, undefined, 'card-content-v1', 32);
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with AES-256-GCM using a random 96-bit nonce.
 * Output layout: 12-byte nonce || ciphertext || 16-byte GCM tag.
 *
 * Uses Web Crypto (`crypto.subtle`) rather than `node:crypto`'s
 * createCipheriv — the latter is one of the Node APIs `unenv` doesn't
 * polyfill under Workers' `nodejs_compat` ("crypto.createCipheriv is not
 * implemented yet!", confirmed running this under real `wrangler dev`).
 * `crypto.subtle` is a native Workers API (and available in Node 22+ too),
 * and its AES-GCM `encrypt` already returns ciphertext with the auth tag
 * appended — the same layout this function already produced, so the wire
 * format and every caller/decryptor are unaffected.
 */
export async function aes256gcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertextAndTag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, toArrayBuffer(plaintext));
  const out = new Uint8Array(12 + ciphertextAndTag.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ciphertextAndTag), 12);
  return out;
}

/**
 * Decrypt an AES-256-GCM payload produced by {@link aes256gcmEncrypt} (or by
 * the verifier package's identical `aes256gcmDecrypt` — same 12-byte-nonce ||
 * ciphertext || 16-byte-tag layout). Per ADR-006, card content is encrypted
 * under a key derived only from the card's own *public* key
 * (`deriveContentKey`), so the press — like anyone who knows the card's
 * public key — can decrypt registered card content without holding any
 * private key material.
 */
export async function aes256gcmDecrypt(key: Uint8Array, noncePlusCiphertext: Uint8Array): Promise<Uint8Array> {
  if (noncePlusCiphertext.length < 12 + 16) {
    throw new Error('aes256gcmDecrypt: payload too short to contain nonce and GCM tag');
  }
  const nonce = toArrayBuffer(noncePlusCiphertext.subarray(0, 12));
  const ciphertextAndTag = toArrayBuffer(noncePlusCiphertext.subarray(12));
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, ciphertextAndTag);
  return new Uint8Array(plaintext);
}

// Web Crypto's BufferSource rejects a Uint8Array view over a larger/shared
// backing buffer under strict lib.dom typings — copy into a fresh,
// plain-ArrayBuffer-backed Uint8Array first (same fix wallet-service's
// WebCryptoBackend already uses for this exact API).
function toArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Utility: encode bytes32 and CID bytes as base64url for payload JSON fields
// ---------------------------------------------------------------------------

export function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/**
 * Derive the on-chain press address from the ML-DSA-44 public key (1312 bytes).
 * address = keccak256(pubkey)[0..32] as bytes32
 */
export function pressAddressFromMlDsaPubkey(pubkey: Uint8Array): Uint8Array {
  return keccak256(pubkey);
}

/**
 * Extract the ML-DSA-44 public key from the private key.
 * In @noble/post-quantum's API, the private key seed is 32 bytes;
 * the "expanded" private key is 2560 bytes (seed + public key concatenated).
 * The public key occupies the last 1312 bytes of the expanded key.
 */
export function mlDsa44PublicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 2560) {
    throw new TypeError(
      `Expected 2560-byte ML-DSA-44 private key, got ${privateKey.length}`
    );
  }
  return ml_dsa44.getPublicKey(privateKey);
}
