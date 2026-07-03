import { describe, it, expect, vi } from 'vitest';
import { hpkeGenerateKeyConfig, hpkeOpen } from '../../src/crypto/hpke.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import { HpkeObliviousProtocolTransport } from '../../src/transport/ObliviousProtocolTransport.js';

const RELAY_BASE_URL = 'https://relay.example.com';
const WALLET_SERVICE_BASE_URL = 'https://wallet.example.com';
const WALLET_SERVICE_TARGET_ID = 'wallet-service-target';

describe('HpkeObliviousProtocolTransport', () => {
  it('fetches the destination key config, then routes the sealed request through the relay (never directly to the destination)', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();
    let keyConfigRequested = false;

    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${WALLET_SERVICE_BASE_URL}/ohttp/key-config`) {
        keyConfigRequested = true;
        return new Response(
          JSON.stringify({
            kemId: config.kemId,
            kdfId: config.kdfId,
            aeadId: config.aeadId,
            publicKey: bytesToBase64Url(config.publicKey),
            targetId: WALLET_SERVICE_TARGET_ID,
          }),
          { status: 200 }
        );
      }
      if (url === `${RELAY_BASE_URL}/ohttp/${WALLET_SERVICE_TARGET_ID}`) {
        const parsed = JSON.parse(init!.body as string) as { enc: string; ciphertext: string };
        const { plaintext, sealResponse } = await hpkeOpen(secretKey, {
          enc: base64UrlToBytes(parsed.enc),
          ciphertext: base64UrlToBytes(parsed.ciphertext),
        });
        const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as { path: string };
        expect(envelope.path).toBe('/accounts');
        const response = await sealResponse(
          new TextEncoder().encode(JSON.stringify({ status: 201, headers: {}, body: undefined }))
        );
        return new Response(
          JSON.stringify({
            nonce: bytesToBase64Url(response.nonce),
            ciphertext: bytesToBase64Url(response.ciphertext),
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch to ${url} — device must never call the destination directly`);
    });

    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: RELAY_BASE_URL,
      walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      fetch: fetchStub as unknown as typeof fetch,
    });

    const result = await transport.request({ kind: 'wallet_service' }, { method: 'POST', path: '/accounts' });

    expect(keyConfigRequested).toBe(true);
    expect(result.status).toBe(201);
    // Every fetch call target was either the destination's key-config
    // endpoint or the relay — never the destination's actual API path.
    for (const call of fetchStub.mock.calls) {
      const url = String(call[0]);
      expect(url === `${WALLET_SERVICE_BASE_URL}/ohttp/key-config` || url.startsWith(RELAY_BASE_URL)).toBe(
        true
      );
    }
  });

  it('a full round trip against a press destination completes correctly, including a request body', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();
    const pressBaseUrl = 'https://press.example.com';
    const targetId = 'press-target-1';

    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${pressBaseUrl}/ohttp/key-config`) {
        return new Response(
          JSON.stringify({
            kemId: config.kemId,
            kdfId: config.kdfId,
            aeadId: config.aeadId,
            publicKey: bytesToBase64Url(config.publicKey),
            targetId,
          }),
          { status: 200 }
        );
      }
      if (url === `${RELAY_BASE_URL}/ohttp/${targetId}`) {
        const parsed = JSON.parse(init!.body as string) as { enc: string; ciphertext: string };
        const { plaintext, sealResponse } = await hpkeOpen(secretKey, {
          enc: base64UrlToBytes(parsed.enc),
          ciphertext: base64UrlToBytes(parsed.ciphertext),
        });
        const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as {
          path: string;
          body?: string;
        };
        expect(envelope.path).toBe('/open-offer/claim');
        expect(envelope.body).toBe(bytesToBase64Url(new TextEncoder().encode('claim-payload')));
        const response = await sealResponse(
          new TextEncoder().encode(
            JSON.stringify({
              status: 200,
              headers: {},
              body: bytesToBase64Url(new TextEncoder().encode('claim-accepted')),
            })
          )
        );
        return new Response(
          JSON.stringify({
            nonce: bytesToBase64Url(response.nonce),
            ciphertext: bytesToBase64Url(response.ciphertext),
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: RELAY_BASE_URL,
      walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      fetch: fetchStub as unknown as typeof fetch,
    });

    const result = await transport.request(
      { kind: 'press', baseUrl: pressBaseUrl },
      { method: 'POST', path: '/open-offer/claim', body: new TextEncoder().encode('claim-payload') }
    );

    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('claim-accepted');
  });

  it('the relay never sees the plaintext path or body', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();

    let capturedRelayBody: string | undefined;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${WALLET_SERVICE_BASE_URL}/ohttp/key-config`) {
        return new Response(
          JSON.stringify({
            kemId: config.kemId,
            kdfId: config.kdfId,
            aeadId: config.aeadId,
            publicKey: bytesToBase64Url(config.publicKey),
            targetId: WALLET_SERVICE_TARGET_ID,
          }),
          { status: 200 }
        );
      }
      capturedRelayBody = init!.body as string;
      const parsed = JSON.parse(capturedRelayBody) as { enc: string; ciphertext: string };
      const { sealResponse } = await hpkeOpen(secretKey, {
        enc: base64UrlToBytes(parsed.enc),
        ciphertext: base64UrlToBytes(parsed.ciphertext),
      });
      const response = await sealResponse(
        new TextEncoder().encode(JSON.stringify({ status: 200, headers: {} }))
      );
      return new Response(
        JSON.stringify({
          nonce: bytesToBase64Url(response.nonce),
          ciphertext: bytesToBase64Url(response.ciphertext),
        }),
        { status: 200 }
      );
    });

    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: RELAY_BASE_URL,
      walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      fetch: fetchStub as unknown as typeof fetch,
    });

    await transport.request(
      { kind: 'wallet_service' },
      { method: 'POST', path: '/keyrings/super-secret-id' }
    );

    expect(capturedRelayBody).toBeDefined();
    expect(capturedRelayBody).not.toContain('/keyrings/super-secret-id');
    expect(capturedRelayBody).not.toContain('super-secret-id');
  });

  it('bypass mode calls the destination directly and skips the relay entirely', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe(`${WALLET_SERVICE_BASE_URL}/health`);
      return new Response('ok', { status: 200 });
    });

    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: RELAY_BASE_URL,
      walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      fetch: fetchStub as unknown as typeof fetch,
    });

    const result = await transport.request(
      { kind: 'wallet_service' },
      { method: 'GET', path: '/health', bypass: true }
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('ok');
  });

  it('caches the key config across requests within the TTL (only one key-config fetch for two requests)', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();
    let keyConfigFetches = 0;

    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${WALLET_SERVICE_BASE_URL}/ohttp/key-config`) {
        keyConfigFetches++;
        return new Response(
          JSON.stringify({
            kemId: config.kemId,
            kdfId: config.kdfId,
            aeadId: config.aeadId,
            publicKey: bytesToBase64Url(config.publicKey),
            targetId: WALLET_SERVICE_TARGET_ID,
          }),
          { status: 200 }
        );
      }
      const parsed = JSON.parse(init!.body as string) as { enc: string; ciphertext: string };
      const { sealResponse } = await hpkeOpen(secretKey, {
        enc: base64UrlToBytes(parsed.enc),
        ciphertext: base64UrlToBytes(parsed.ciphertext),
      });
      const response = await sealResponse(
        new TextEncoder().encode(JSON.stringify({ status: 200, headers: {} }))
      );
      return new Response(
        JSON.stringify({
          nonce: bytesToBase64Url(response.nonce),
          ciphertext: bytesToBase64Url(response.ciphertext),
        }),
        { status: 200 }
      );
    });

    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: RELAY_BASE_URL,
      walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
      fetch: fetchStub as unknown as typeof fetch,
    });

    await transport.request({ kind: 'wallet_service' }, { method: 'GET', path: '/a' });
    await transport.request({ kind: 'wallet_service' }, { method: 'GET', path: '/b' });

    expect(keyConfigFetches).toBe(1);
  });
});
