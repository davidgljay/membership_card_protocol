import { describe, it, expect } from 'vitest';
import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';
import { gcm } from '@noble/ciphers/aes.js';
import { getKeyConfig, decapsulate } from '../../src/ohttp-gateway.js';
import type { PressConfig } from '../../src/config.js';

const SUITE = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

const TEST_CONFIG = {
  PRESS_OHTTP_PRIVATE_KEY: Buffer.alloc(32, 3),
} as unknown as PressConfig;

// Mirrors the "client" side of client-sdk's ObliviousProtocolTransport.
async function sealAsClient(publicKeyB64: string, envelope: unknown) {
  const publicKey = await SUITE.kem.deserializePublicKey(
    new Uint8Array(Buffer.from(publicKeyB64, 'base64url')).buffer
  );
  const sender = await SUITE.createSenderContext({ recipientPublicKey: publicKey });
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = new Uint8Array(await sender.seal(plaintext));
  const responseKey = new Uint8Array(
    await sender.export(new TextEncoder().encode('card-protocol-ohttp-response-v1'), 32)
  );
  return {
    body: {
      enc: Buffer.from(sender.enc).toString('base64url'),
      ciphertext: Buffer.from(ciphertext).toString('base64url'),
    },
    openResponse: (response: { nonce: string; ciphertext: string }) => {
      const nonce = new Uint8Array(Buffer.from(response.nonce, 'base64url'));
      const ct = new Uint8Array(Buffer.from(response.ciphertext, 'base64url'));
      const plaintextResponse = gcm(responseKey, nonce).decrypt(ct);
      return JSON.parse(new TextDecoder().decode(plaintextResponse));
    },
  };
}

describe('press ohttp-gateway (client-sdk implementation plan Step 1.4d)', () => {
  it('getKeyConfig derives a public key matching hpke-js for the same private key, and carries the given target_id', async () => {
    const config = getKeyConfig(TEST_CONFIG, 'press-address-1');
    expect(config.targetId).toBe('press-address-1');
    expect(config.kemId).toBe(KemId.DhkemX25519HkdfSha256);

    // Confirm the derived public key is actually usable for HPKE (not just
    // structurally present) by sealing a message to it.
    const { body } = await sealAsClient(config.publicKey, { path: '/issue', method: 'POST' });
    expect(body.enc.length).toBeGreaterThan(0);
  });

  it('round-trips a full request/response exchange end-to-end', async () => {
    const config = getKeyConfig(TEST_CONFIG, 'press-address-1');
    const { body, openResponse } = await sealAsClient(config.publicKey, {
      path: '/open-offer/claim',
      method: 'POST',
      body: Buffer.from(JSON.stringify({ example: true })).toString('base64url'),
    });

    const { envelope, encapsulateResponse } = await decapsulate(TEST_CONFIG, body);
    expect(envelope.path).toBe('/open-offer/claim');
    expect(JSON.parse(Buffer.from(envelope.body!, 'base64url').toString())).toEqual({ example: true });

    const sealedResponse = await encapsulateResponse({ status: 200, headers: {} });
    expect(openResponse(sealedResponse)).toEqual({ status: 200, headers: {} });
  });
});
