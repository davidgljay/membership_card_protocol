import { describe, it, expect } from 'vitest';
import {
  mlKem768GenerateKeypair,
  mlKem768Encapsulate,
  mlKem768Decapsulate,
} from '../../src/crypto/mlkem.js';

describe('ML-KEM-768', () => {
  it('round-trips: decapsulating with the secret key recovers the encapsulated shared secret', () => {
    const { publicKey, secretKey } = mlKem768GenerateKeypair();
    const { cipherText, sharedSecret } = mlKem768Encapsulate(publicKey);
    const recovered = mlKem768Decapsulate(cipherText, secretKey);
    expect(recovered).toEqual(sharedSecret);
  });

  it('two encapsulations to the same public key produce different shared secrets', () => {
    const { publicKey } = mlKem768GenerateKeypair();
    const a = mlKem768Encapsulate(publicKey);
    const b = mlKem768Encapsulate(publicKey);
    expect(a.sharedSecret).not.toEqual(b.sharedSecret);
  });

  it('decapsulating with the wrong secret key does not recover the same shared secret', () => {
    const { publicKey } = mlKem768GenerateKeypair();
    const { secretKey: wrongSecretKey } = mlKem768GenerateKeypair();
    const { cipherText, sharedSecret } = mlKem768Encapsulate(publicKey);
    const recovered = mlKem768Decapsulate(cipherText, wrongSecretKey);
    expect(recovered).not.toEqual(sharedSecret);
  });

  it('generateKeypair with the same seed is deterministic', () => {
    const seed = new Uint8Array(64).fill(3);
    const a = mlKem768GenerateKeypair(seed);
    const b = mlKem768GenerateKeypair(seed);
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.secretKey).toEqual(b.secretKey);
  });
});
