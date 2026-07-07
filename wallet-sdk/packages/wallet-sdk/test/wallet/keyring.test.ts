import { describe, it, expect } from 'vitest';
import { encryptKeyring, decryptKeyring, computeKeyringId } from '../../src/wallet/keyring.js';
import { keccak256 } from '@membership-card-protocol/app-sdk';

describe('encryptKeyring / decryptKeyring', () => {
  it('round-trips a single entry', () => {
    const decryptionKey = new Uint8Array(32).fill(3);
    const entries = [{ cardAddress: 'abc123', privateKey: new Uint8Array([1, 2, 3, 4, 5]) }];

    const blob = encryptKeyring(entries, decryptionKey);
    const decrypted = decryptKeyring(blob, decryptionKey);

    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]!.cardAddress).toBe('abc123');
    expect(decrypted[0]!.privateKey).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('produces different ciphertext for the same input on each call (fresh nonce)', () => {
    const decryptionKey = new Uint8Array(32).fill(4);
    const entries = [{ cardAddress: 'x', privateKey: new Uint8Array([9, 9, 9]) }];

    const blobA = encryptKeyring(entries, decryptionKey);
    const blobB = encryptKeyring(entries, decryptionKey);

    expect(blobA).not.toEqual(blobB);
  });

  it('fails to decrypt with the wrong key', () => {
    const entries = [{ cardAddress: 'x', privateKey: new Uint8Array([1, 2, 3]) }];
    const blob = encryptKeyring(entries, new Uint8Array(32).fill(1));
    expect(() => decryptKeyring(blob, new Uint8Array(32).fill(2))).toThrow();
  });
});

describe('computeKeyringId', () => {
  it('is keccak256 of the encrypted blob', () => {
    const blob = new TextEncoder().encode('some-encrypted-blob-bytes');
    expect(computeKeyringId(blob)).toBe(keccak256(blob));
  });
});
