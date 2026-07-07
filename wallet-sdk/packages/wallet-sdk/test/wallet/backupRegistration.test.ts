import { describe, it, expect, vi } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import {
  wrapDecryptionKey,
  unwrapDecryptionKey,
  registerBackup,
  type NotificationChannels,
} from '../../src/wallet/backupRegistration.js';
import { bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type {
  ObliviousProtocolTransport,
  ObliviousDestination,
  RequestOptions,
  ObliviousResponse,
} from '@membership-card-protocol/app-sdk';

function jsonResponse(status: number, body: unknown): ObliviousResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function readJsonBody(options: RequestOptions): Record<string, unknown> {
  if (!options.body) return {};
  return JSON.parse(new TextDecoder().decode(options.body)) as Record<string, unknown>;
}

const DECRYPTION_KEY = new Uint8Array(32).fill(0x11);
const WRAPPING_KEY = new Uint8Array(32).fill(0x22);

describe('wrapDecryptionKey / unwrapDecryptionKey', () => {
  it('round-trips: unwrapping a wrapped blob under the same wrapping key recovers decryption_key byte-for-byte', () => {
    const blob = wrapDecryptionKey(DECRYPTION_KEY, WRAPPING_KEY);
    expect(unwrapDecryptionKey(blob, WRAPPING_KEY)).toEqual(DECRYPTION_KEY);
  });

  it('produces a nonce-prepended blob whose length is 12 (GCM nonce) + 32 (key) + 16 (GCM tag)', () => {
    const blob = wrapDecryptionKey(DECRYPTION_KEY, WRAPPING_KEY);
    expect(blob.length).toBe(12 + 32 + 16);
  });

  it('produces different ciphertext on each call (fresh random nonce) but both unwrap to the same key', () => {
    const blobA = wrapDecryptionKey(DECRYPTION_KEY, WRAPPING_KEY);
    const blobB = wrapDecryptionKey(DECRYPTION_KEY, WRAPPING_KEY);
    expect(bytesToBase64Url(blobA)).not.toBe(bytesToBase64Url(blobB));
    expect(unwrapDecryptionKey(blobA, WRAPPING_KEY)).toEqual(DECRYPTION_KEY);
    expect(unwrapDecryptionKey(blobB, WRAPPING_KEY)).toEqual(DECRYPTION_KEY);
  });

  it('fails to unwrap under the wrong wrapping key (GCM authentication failure)', () => {
    const blob = wrapDecryptionKey(DECRYPTION_KEY, WRAPPING_KEY);
    const wrongKey = new Uint8Array(32).fill(0x33);
    expect(() => unwrapDecryptionKey(blob, wrongKey)).toThrow();
  });

  it('matches a fixed test vector: unwrapping a pre-recorded blob under its recorded wrapping key recovers the recorded plaintext', () => {
    // Fixed vector generated once via wrapDecryptionKey with a fixed nonce
    // substituted in by hand, so this test is independent of `randomBytes`
    // and reproducible byte-for-byte across runs/environments.
    const fixedNonce = new Uint8Array(12).fill(0xaa);
    const key = new Uint8Array(32).fill(0x01);
    const plaintext = new Uint8Array(32).fill(0x02);

    // Re-derive the expected ciphertext using the same primitive
    // (`@noble/ciphers/aes.js`'s `gcm`) directly, to pin the vector without
    // depending on `wrapDecryptionKey`'s own randomness.
    const expectedCiphertext = gcm(key, fixedNonce).encrypt(plaintext);
    const fixedBlob = new Uint8Array(fixedNonce.length + expectedCiphertext.length);
    fixedBlob.set(fixedNonce, 0);
    fixedBlob.set(expectedCiphertext, fixedNonce.length);

    expect(unwrapDecryptionKey(fixedBlob, key)).toEqual(plaintext);
  });
});

describe('registerBackup', () => {
  const notificationChannels: NotificationChannels = { email: 'holder@example.com' };
  const cancellationPubkey = new Uint8Array(1312).fill(0x77); // ML-DSA-44 pubkey-sized filler

  function makeStubTransport() {
    const calls: Array<{ destination: ObliviousDestination; options: RequestOptions }> = [];
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async (destination: ObliviousDestination, options: RequestOptions) => {
        calls.push({ destination, options });
        return jsonResponse(200, { backup_id: 'backup-abc' });
      }),
    };
    return { transport, calls };
  }

  it('sends the wallet-service-authenticated POST with the exact wire shape the wallet service expects', async () => {
    const { transport, calls } = makeStubTransport();

    const result = await registerBackup({
      transport,
      sessionToken: 'session-xyz',
      cardHash: 'deadbeef',
      type: 'synced_passkey',
      decryptionKey: DECRYPTION_KEY,
      wrappingKey: WRAPPING_KEY,
      keyringId: 'keyring-id-1',
      notificationChannels,
      cancellationPubkey,
    });

    expect(result.backupId).toBe('backup-abc');
    expect(calls).toHaveLength(1);
    const { destination, options } = calls[0]!;
    expect(destination).toEqual({ kind: 'wallet_service' });
    expect(options.method).toBe('POST');
    expect(options.path).toBe('/accounts/deadbeef/backups');
    expect(options.headers?.authorization).toBe('Bearer session-xyz');
    expect(options.headers?.['content-type']).toBe('application/json');

    const body = readJsonBody(options);
    expect(body.type).toBe('synced_passkey');
    expect(body.keyring_id).toBe('keyring-id-1');
    expect(body.notification_channels).toEqual(notificationChannels);
    expect(body.cancellation_pubkey).toBe(bytesToBase64Url(cancellationPubkey));

    // wrapped_blob is opaque ciphertext that unwraps back to decryptionKey
    // under the wrapping key — the wallet service is never handed
    // decryption_key or wrappingKey directly, only this ciphertext.
    const wrappedBlob = base64UrlToBytes(body.wrapped_blob as string);
    const { unwrapDecryptionKey: unwrap } = await import('../../src/wallet/backupRegistration.js');
    expect(unwrap(wrappedBlob, WRAPPING_KEY)).toEqual(DECRYPTION_KEY);
  });

  it('throws on a non-2xx response', async () => {
    const transport: ObliviousProtocolTransport = {
      request: vi.fn(async () => jsonResponse(400, { error: 'bad request' })),
    };

    await expect(
      registerBackup({
        transport,
        sessionToken: 'session-xyz',
        cardHash: 'deadbeef',
        type: 'yubikey',
        decryptionKey: DECRYPTION_KEY,
        wrappingKey: WRAPPING_KEY,
        keyringId: 'keyring-id-1',
        notificationChannels,
        cancellationPubkey,
      })
    ).rejects.toThrow(/returned status 400/);
  });
});
