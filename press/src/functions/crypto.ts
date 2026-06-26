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
import { createCipheriv, randomBytes } from 'node:crypto';

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
 */
export function aes256gcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(12 + ciphertext.length + 16);
  out.set(nonce, 0);
  out.set(ciphertext, 12);
  out.set(tag, 12 + ciphertext.length);
  return out;
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
