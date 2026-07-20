/**
 * Press crypto unit tests: ML-DSA-44 sign/verify, secp256r1 sign,
 * AES-256-GCM encrypt/decrypt round-trip, content-key derivation.
 */

import { describe, it, expect } from 'vitest';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import {
  mlDsa44Sign,
  secp256r1Sign,
  aes256gcmEncrypt,
  aes256gcmDecrypt,
  deriveContentKey,
  keccak256,
  toBase64url,
  fromBase64url,
  mlDsa44PublicKeyFromPrivate,
} from '../../src/functions/crypto.js';

// Generate a deterministic ML-DSA-44 keypair from a fixed seed for testing.
const SEED = new Uint8Array(32).fill(0x42);
const { secretKey: ML_PRIV, publicKey: ML_PUB } = ml_dsa44.keygen(SEED);

// A real secp256r1 private key (32 bytes, test-only).
const SECP_PRIV_HEX = 'ab'.repeat(32);

describe('mlDsa44Sign', () => {
  it('produces a signature that verifies with @noble/post-quantum', () => {
    const message = new TextEncoder().encode('hello press');
    const sig = mlDsa44Sign(ML_PRIV, message);
    expect(sig.length).toBe(2420);
    expect(ml_dsa44.verify(sig, message, ML_PUB)).toBe(true);
  });

  it('a signature over different bytes does not verify', () => {
    const sig = mlDsa44Sign(ML_PRIV, new TextEncoder().encode('msg A'));
    expect(ml_dsa44.verify(sig, new TextEncoder().encode('msg B'), ML_PUB)).toBe(false);
  });
});

describe('mlDsa44PublicKeyFromPrivate', () => {
  it('extracts the correct 1312-byte public key from the 2560-byte expanded key', () => {
    const extracted = mlDsa44PublicKeyFromPrivate(ML_PRIV);
    expect(extracted.length).toBe(1312);
    expect(extracted).toEqual(ML_PUB);
  });

  it('throws on wrong-length input', () => {
    expect(() => mlDsa44PublicKeyFromPrivate(new Uint8Array(32))).toThrow('2560');
  });
});

describe('secp256r1Sign', () => {
  it('produces a 64-byte compact signature that verifies with @noble/curves', () => {
    const message = new TextEncoder().encode('registry payload');
    const hash = keccak256(message);
    const sig = secp256r1Sign(SECP_PRIV_HEX, hash);
    expect(sig.length).toBe(64);

    // Verify with noble/curves using the same hash.
    const pubKey = p256.getPublicKey(SECP_PRIV_HEX, false); // uncompressed
    expect(p256.verify(sig, hash, pubKey, { prehash: false })).toBe(true);
  });

  it('accepts a 0x-prefixed private key', () => {
    const hash = keccak256(new TextEncoder().encode('test'));
    const sig1 = secp256r1Sign(SECP_PRIV_HEX, hash);
    const sig2 = secp256r1Sign(`0x${SECP_PRIV_HEX}`, hash);
    expect(sig1).toEqual(sig2);
  });
});

describe('AES-256-GCM encrypt / decrypt round-trip', () => {
  const key = new Uint8Array(32).fill(0x01);

  it('decrypts to the original plaintext', async () => {
    const plaintext = new TextEncoder().encode('{"card":"data"}');
    const ciphertext = await aes256gcmEncrypt(key, plaintext);
    // Output is nonce(12) + ciphertext + tag(16)
    expect(ciphertext.length).toBe(12 + plaintext.length + 16);
    const decrypted = await aes256gcmDecrypt(key, ciphertext);
    expect(decrypted).toEqual(plaintext);
  });

  it('each call produces a different ciphertext (random nonce)', async () => {
    const pt = new TextEncoder().encode('same plaintext');
    const c1 = await aes256gcmEncrypt(key, pt);
    const c2 = await aes256gcmEncrypt(key, pt);
    expect(c1).not.toEqual(c2);
  });

  it('decryption fails with a tampered ciphertext', async () => {
    const ct = await aes256gcmEncrypt(key, new TextEncoder().encode('data'));
    ct[20] ^= 0xff; // flip a byte in the ciphertext body
    await expect(aes256gcmDecrypt(key, ct)).rejects.toThrow();
  });
});

describe('deriveContentKey', () => {
  it('returns 32 bytes', () => {
    const pubkey = new Uint8Array(1312).fill(0xab);
    const key = deriveContentKey(pubkey);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same pubkey', () => {
    const pubkey = new Uint8Array(1312).fill(0xcd);
    expect(deriveContentKey(pubkey)).toEqual(deriveContentKey(pubkey));
  });

  it('differs for different pubkeys', () => {
    const a = deriveContentKey(new Uint8Array(1312).fill(0x01));
    const b = deriveContentKey(new Uint8Array(1312).fill(0x02));
    expect(a).not.toEqual(b);
  });
});

describe('toBase64url / fromBase64url', () => {
  it('round-trips bytes32 (32 bytes)', () => {
    const bytes = new Uint8Array(32).fill(0xde);
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
  });

  it('produces URL-safe encoding (no +, /, or = padding)', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const encoded = toBase64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('keccak256', () => {
  it('returns 32 bytes', () => {
    expect(keccak256(new TextEncoder().encode('hello')).length).toBe(32);
  });

  it('produces a known digest', () => {
    // keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    const empty = keccak256(new Uint8Array(0));
    expect(Buffer.from(empty).toString('hex')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });
});
