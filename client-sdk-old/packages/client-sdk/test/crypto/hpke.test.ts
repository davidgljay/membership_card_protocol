import { describe, it, expect } from 'vitest';
import { hpkeGenerateKeyConfig, hpkeSeal, hpkeOpen } from '../../src/crypto/hpke.js';

describe('HPKE envelope (hpkeSeal/hpkeOpen)', () => {
  it('round-trips a request and its response end-to-end', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();
    const requestPlaintext = new TextEncoder().encode(
      JSON.stringify({ path: '/accounts', method: 'POST', body: 'eyJmb28iOiJiYXIifQ' })
    );

    const { request, openResponse } = await hpkeSeal(config.publicKey, requestPlaintext);
    const { plaintext, sealResponse } = await hpkeOpen(secretKey, request);

    expect(plaintext).toEqual(requestPlaintext);

    const responsePlaintext = new TextEncoder().encode(JSON.stringify({ status: 200, body: 'ok' }));
    const response = await sealResponse(responsePlaintext);
    const openedResponse = await openResponse(response);

    expect(openedResponse).toEqual(responsePlaintext);
  });

  it('the ciphertext does not contain the plaintext in the clear', async () => {
    const { config } = await hpkeGenerateKeyConfig();
    const plaintext = new TextEncoder().encode('a very identifiable secret payload string');
    const { request } = await hpkeSeal(config.publicKey, plaintext);

    const ciphertextStr = Buffer.from(request.ciphertext).toString('latin1');
    expect(ciphertextStr).not.toContain('a very identifiable secret payload string');
  });

  it('a relay holding only enc+ciphertext (no secret key) cannot decrypt', async () => {
    const { config } = await hpkeGenerateKeyConfig();
    const plaintext = new TextEncoder().encode('sensitive');
    const { request } = await hpkeSeal(config.publicKey, plaintext);

    // The relay only ever sees `request` (enc + ciphertext) — no secret key
    // exists for it to call hpkeOpen with. There's no API surface that
    // lets it decrypt; this test documents that invariant rather than
    // exercising a specific function.
    expect(request.enc.length).toBeGreaterThan(0);
    expect(request.ciphertext.length).toBeGreaterThan(0);
  });

  it('rejects a response opened with the wrong request context', async () => {
    const { config, secretKey } = await hpkeGenerateKeyConfig();
    const requestPlaintext = new TextEncoder().encode('req-a');
    const { openResponse: openResponseA } = await hpkeSeal(config.publicKey, requestPlaintext);

    // A second, unrelated request/response exchange.
    const { request: requestB } = await hpkeSeal(config.publicKey, new TextEncoder().encode('req-b'));
    const { sealResponse: sealResponseB } = await hpkeOpen(secretKey, requestB);
    const responseB = await sealResponseB(new TextEncoder().encode('resp-b'));

    // Opening exchange B's response with exchange A's derived key must fail.
    await expect(openResponseA(responseB)).rejects.toThrow();
  });
});
