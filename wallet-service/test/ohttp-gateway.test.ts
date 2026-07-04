import { describe, it, expect, beforeEach } from 'vitest';
import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';
import { gcm } from '@noble/ciphers/aes.js';
import { getKeyConfig, decapsulate, _resetOhttpGatewayCacheForTests } from '../src/ohttp-gateway.js';

// Mirrors the suite fixed in src/ohttp-gateway.ts / client-sdk's
// crypto/hpke.ts — acts as the "client" side for these tests, HPKE-sealing
// a request the same way client-sdk's ObliviousProtocolTransport does.
const SUITE = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

beforeEach(() => {
  _resetOhttpGatewayCacheForTests();
});

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

describe('ohttp-gateway (client-sdk implementation plan Step 1.4c)', () => {
  it('getKeyConfig returns a stable public key and the given target_id across calls', async () => {
    const first = await getKeyConfig('wallet-service-1');
    const second = await getKeyConfig('wallet-service-1');
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.targetId).toBe('wallet-service-1');
    expect(first.kemId).toBe(KemId.DhkemX25519HkdfSha256);
  });

  it('round-trips a full request/response exchange end-to-end', async () => {
    const { publicKey } = await getKeyConfig('wallet-service-1');
    const { body, openResponse } = await sealAsClient(publicKey, {
      path: '/accounts/challenge',
      method: 'POST',
    });

    const { envelope, encapsulateResponse } = await decapsulate(body);
    expect(envelope).toEqual({ path: '/accounts/challenge', method: 'POST' });

    const sealedResponse = await encapsulateResponse({ status: 200, headers: {} });
    const opened = openResponse(sealedResponse);
    expect(opened).toEqual({ status: 200, headers: {} });
  });

  it('the persisted keypair survives an in-memory cache reset (KV-backed, not regenerated every process restart)', async () => {
    const { publicKey } = await getKeyConfig('wallet-service-1');
    const { body } = await sealAsClient(publicKey, { path: '/accounts/challenge', method: 'POST' });

    // Simulates a fresh process: the in-memory cache is gone, but the
    // wrapped private key is still in the KV store, so decapsulation
    // against a request sealed before the reset still succeeds.
    _resetOhttpGatewayCacheForTests();
    const { envelope } = await decapsulate(body);
    expect(envelope).toEqual({ path: '/accounts/challenge', method: 'POST' });
  });
});
