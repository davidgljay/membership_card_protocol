import { describe, it, expect } from 'vitest';
import { deriveDecryptionKey, devicePasskeyOutputFromRegistration } from '../../src/wallet/kdf.js';

describe('deriveDecryptionKey', () => {
  it('matches a fixed test vector (device_passkey_output = 0x01*32, service_secret = 0x02*32)', () => {
    // Test vector computed independently via @noble/hashes/hkdf directly
    // (sha3_256, ikm = devicePasskeyOutput, salt = serviceSecret, info =
    // 'card-protocol-wallet-decryption-key-v1', length = 32) — see
    // src/wallet/kdf.ts's doc comment for why ikm/salt are assigned this
    // way. Recomputed with:
    //
    //   import { sha3_256 } from '@noble/hashes/sha3';
    //   import { hkdf } from '@noble/hashes/hkdf';
    //   const devicePasskeyOutput = new Uint8Array(32).fill(1);
    //   const serviceSecret = new Uint8Array(32).fill(2);
    //   const info = new TextEncoder().encode('card-protocol-wallet-decryption-key-v1');
    //   hkdf(sha3_256, devicePasskeyOutput, serviceSecret, info, 32);
    const devicePasskeyOutput = new Uint8Array(32).fill(1);
    const serviceSecret = new Uint8Array(32).fill(2);

    const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, serviceSecret);

    expect(Buffer.from(decryptionKey).toString('hex')).toBe(
      'eea64dee2187c3067c61d96a4daffc3980c59fe0856742af179c6c7ba5c89ee9'
    );
    expect(decryptionKey.length).toBe(32);
  });

  it('is deterministic for the same inputs', () => {
    const devicePasskeyOutput = new Uint8Array(32).fill(5);
    const serviceSecret = new Uint8Array(32).fill(9);
    expect(deriveDecryptionKey(devicePasskeyOutput, serviceSecret)).toEqual(
      deriveDecryptionKey(devicePasskeyOutput, serviceSecret)
    );
  });

  it('changing device_passkey_output alone changes the output (neither input alone reconstructs it)', () => {
    const serviceSecret = new Uint8Array(32).fill(9);
    const a = deriveDecryptionKey(new Uint8Array(32).fill(1), serviceSecret);
    const b = deriveDecryptionKey(new Uint8Array(32).fill(2), serviceSecret);
    expect(a).not.toEqual(b);
  });

  it('changing service_secret alone changes the output', () => {
    const devicePasskeyOutput = new Uint8Array(32).fill(1);
    const a = deriveDecryptionKey(devicePasskeyOutput, new Uint8Array(32).fill(9));
    const b = deriveDecryptionKey(devicePasskeyOutput, new Uint8Array(32).fill(10));
    expect(a).not.toEqual(b);
  });
});

describe('devicePasskeyOutputFromRegistration', () => {
  it('matches a fixed test vector for a known attestationObject', () => {
    // keccak256("fixed-attestation-object-for-test-vector"), verified
    // independently against @noble/hashes' keccak_256 directly.
    const attestationObject = new TextEncoder().encode('fixed-attestation-object-for-test-vector');
    const output = devicePasskeyOutputFromRegistration(attestationObject);
    expect(Buffer.from(output).toString('hex')).toBe(
      'f5eaf5094a2ee6565db839b97553a0840eace2d59df345f1b21eae811b7d87e4'
    );
  });

  it('is deterministic and differs across distinct attestation objects', () => {
    const a = devicePasskeyOutputFromRegistration(new TextEncoder().encode('a'));
    const b = devicePasskeyOutputFromRegistration(new TextEncoder().encode('b'));
    expect(a).not.toEqual(b);
    expect(devicePasskeyOutputFromRegistration(new TextEncoder().encode('a'))).toEqual(a);
  });
});
