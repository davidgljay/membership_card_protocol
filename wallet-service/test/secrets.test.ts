import { describe, it, expect, vi } from 'vitest';
import { WebCryptoBackend } from '../src/secrets/webcrypto-backend.js';
import { KmsBackend } from '../src/secrets/kms-backend.js';
import { SecretsService } from '../src/secrets/secrets-service.js';

function randomMasterKeyB64Url(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

describe('WebCryptoBackend', () => {
  it('round-trips a DEK through wrap/unwrap', async () => {
    const backend = new WebCryptoBackend(randomMasterKeyB64Url());
    const dek = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const wrapped = await backend.wrapDek(dek);
    const unwrapped = await backend.unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('rejects a master key that is not 32 bytes', () => {
    const shortKey = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    expect(() => new WebCryptoBackend(shortKey)).toThrow();
  });
});

describe('SecretsService (WebCryptoBackend)', () => {
  it('round-trips a secret through encrypt/decrypt', async () => {
    const service = new SecretsService(new WebCryptoBackend(randomMasterKeyB64Url()));
    const plaintext = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

    const { ciphertext, dekEnc } = await service.encryptSecret(plaintext);
    expect(ciphertext).not.toEqual(plaintext.toString('base64url'));

    const decrypted = await service.decryptSecret(ciphertext, dekEnc);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('throws when ciphertext has been tampered with', async () => {
    const service = new SecretsService(new WebCryptoBackend(randomMasterKeyB64Url()));
    const plaintext = Buffer.from('service-secret-32-bytes-of-data');

    const { ciphertext, dekEnc } = await service.encryptSecret(plaintext);
    const tampered = Buffer.from(ciphertext, 'base64url');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;

    await expect(
      service.decryptSecret(tampered.toString('base64url'), dekEnc)
    ).rejects.toThrow();
  });

  it('caches the unwrapped DEK so a second decrypt does not hit the backend', async () => {
    const backend = new WebCryptoBackend(randomMasterKeyB64Url());
    const unwrapSpy = vi.spyOn(backend, 'unwrapDek');
    const service = new SecretsService(backend);
    const plaintext = Buffer.from('cached-dek-test-plaintext-bytes');

    const { ciphertext, dekEnc } = await service.encryptSecret(plaintext);

    await service.decryptSecret(ciphertext, dekEnc);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);

    await service.decryptSecret(ciphertext, dekEnc);
    expect(unwrapSpy).toHaveBeenCalledTimes(1); // second call hit the in-memory cache
  });
});

describe('KmsBackend (mocked KMS client)', () => {
  function mockKmsClient(plaintextDek: Buffer) {
    return {
      send: vi.fn(async (command: { input?: { Plaintext?: Uint8Array } }) => {
        if (command.input?.Plaintext) {
          // EncryptCommand
          return { CiphertextBlob: new Uint8Array(Buffer.from('kms-ciphertext:').length + plaintextDek.length) };
        }
        // DecryptCommand
        return { Plaintext: new Uint8Array(plaintextDek) };
      }),
    };
  }

  it('round-trips a DEK through a mocked KMS client', async () => {
    const dek = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const client = mockKmsClient(dek);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = new KmsBackend('arn:aws:kms:us-east-1:123456789012:key/test', 'us-east-1', client as any);

    const wrapped = await backend.wrapDek(dek);
    expect(client.send).toHaveBeenCalledTimes(1);

    const unwrapped = await backend.unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('throws if KMS returns no CiphertextBlob', async () => {
    const client = { send: vi.fn(async () => ({})) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = new KmsBackend('arn:aws:kms:us-east-1:123456789012:key/test', 'us-east-1', client as any);
    await expect(backend.wrapDek(Buffer.from('x'))).rejects.toThrow();
  });
});
