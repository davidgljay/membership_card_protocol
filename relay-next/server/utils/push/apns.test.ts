import { describe, it, expect, beforeEach } from 'vitest';
import { sendApnsPush, _resetApnsTokenCacheForTests, type ApnsCredentials } from './apns';

async function generateTestApnsKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

const TEST_CREDS: Omit<ApnsCredentials, 'keyP8'> = {
  keyId: 'TESTKEY01',
  teamId: 'TESTTEAM1',
  bundleId: 'org.example.testapp',
  sandbox: true,
};

describe('APNs client (server/utils/push/apns.ts) — no live network calls', () => {
  beforeEach(() => {
    _resetApnsTokenCacheForTests();
  });

  it('sends to the sandbox host when sandbox=true, with correct headers and payload', async () => {
    const keyPem = await generateTestApnsKeyPem();
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const fakeFetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = init.body as string;
      return new Response(null, { status: 200, headers: { 'apns-id': 'test-apns-id' } });
    }) as typeof fetch;

    const result = await sendApnsPush(
      { keyP8: keyPem, ...TEST_CREDS },
      'device-token-abc',
      { uuid: 'uuid-123' },
      fakeFetch
    );

    expect(result).toEqual({ ok: true, status: 200, apnsId: 'test-apns-id' });
    expect(capturedUrl).toBe('https://api.sandbox.push.apple.com/3/device/device-token-abc');
    expect(capturedHeaders['apns-topic']).toBe('org.example.testapp');
    expect(capturedHeaders['apns-push-type']).toBe('background');
    expect(capturedHeaders['apns-priority']).toBe('5');
    expect(capturedHeaders.authorization).toMatch(/^bearer /);
    expect(JSON.parse(capturedBody)).toEqual({ aps: { 'content-available': 1 }, uuid: 'uuid-123' });
  });

  it('sends to the production host when sandbox=false', async () => {
    const keyPem = await generateTestApnsKeyPem();
    let capturedUrl = '';
    const fakeFetch = (async (url: string) => {
      capturedUrl = url.toString();
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await sendApnsPush(
      { keyP8: keyPem, ...TEST_CREDS, sandbox: false },
      'tok',
      { uuid: 'u' },
      fakeFetch
    );
    expect(capturedUrl).toBe('https://api.push.apple.com/3/device/tok');
  });

  it('reports failure with reason parsed from APNs error body', async () => {
    const keyPem = await generateTestApnsKeyPem();
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })) as typeof fetch;

    const result = await sendApnsPush(
      { keyP8: keyPem, ...TEST_CREDS },
      'bad-token',
      { uuid: 'u' },
      fakeFetch
    );
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  it('caches the provider JWT across calls within the TTL window (does not re-sign every request)', async () => {
    const keyPem = await generateTestApnsKeyPem();
    const seenAuthHeaders: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const authHeader = (init.headers as Record<string, string>).authorization;
      seenAuthHeaders.push(authHeader ?? '');
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await sendApnsPush({ keyP8: keyPem, ...TEST_CREDS }, 'tok1', { uuid: 'a' }, fakeFetch);
    await sendApnsPush({ keyP8: keyPem, ...TEST_CREDS }, 'tok2', { uuid: 'b' }, fakeFetch);

    expect(seenAuthHeaders[0]).toBe(seenAuthHeaders[1]);
  });
});
