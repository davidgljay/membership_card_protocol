import { describe, it, expect } from 'vitest';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';

describe('ML-DSA-44', () => {
  it('round-trips: a signature from a generated keypair verifies against that keypair', () => {
    const { publicKey, secretKey } = mlDsa44GenerateKeypair();
    const message = new TextEncoder().encode('card protocol test message');
    const signature = mlDsa44Sign(secretKey, message);
    expect(mlDsa44Verify(publicKey, message, signature)).toBe(true);
  });

  it('rejects a signature verified against the wrong message', () => {
    const { publicKey, secretKey } = mlDsa44GenerateKeypair();
    const signature = mlDsa44Sign(secretKey, new TextEncoder().encode('original'));
    expect(
      mlDsa44Verify(publicKey, new TextEncoder().encode('tampered'), signature)
    ).toBe(false);
  });

  it('rejects a signature verified against the wrong public key', () => {
    const { secretKey } = mlDsa44GenerateKeypair();
    const { publicKey: otherPublicKey } = mlDsa44GenerateKeypair();
    const message = new TextEncoder().encode('card protocol test message');
    const signature = mlDsa44Sign(secretKey, message);
    expect(mlDsa44Verify(otherPublicKey, message, signature)).toBe(false);
  });

  it('generateKeypair with the same seed is deterministic', () => {
    const seed = new Uint8Array(32).fill(7);
    const a = mlDsa44GenerateKeypair(seed);
    const b = mlDsa44GenerateKeypair(seed);
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.secretKey).toEqual(b.secretKey);
  });
});
