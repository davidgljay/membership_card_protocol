import { describe, it, expect, beforeEach } from 'vitest';
import { sendFcmPush, _resetFcmTokenCacheForTests, type FcmServiceAccount } from './fcm';

async function generateTestServiceAccountKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
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

describe('FCM client (server/utils/push/fcm.ts) — no live network calls', () => {
  beforeEach(() => {
    _resetFcmTokenCacheForTests();
  });

  it('exchanges the service-account JWT for an access token, then sends a data-only message', async () => {
    const keyPem = await generateTestServiceAccountKeyPem();
    const account: FcmServiceAccount = {
      project_id: 'test-project',
      private_key: keyPem,
      client_email: 'test@test-project.iam.gserviceaccount.com',
    };

    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url: url.toString(),
        body: init.body as string,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (url.toString().includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'projects/test-project/messages/123' }), { status: 200 });
    }) as typeof fetch;

    const result = await sendFcmPush(account, 'device-tok', { uuid: 'uuid-1' }, fakeFetch);

    expect(result).toEqual({
      ok: true,
      status: 200,
      messageName: 'projects/test-project/messages/123',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[1]?.url).toBe(
      'https://fcm.googleapis.com/v1/projects/test-project/messages:send'
    );
    expect(calls[1]?.headers.authorization).toBe('Bearer fake-access-token');
    const sentBody = JSON.parse(calls[1]!.body);
    expect(sentBody).toEqual({
      message: { token: 'device-tok', data: { uuid: 'uuid-1' }, android: { priority: 'high' } },
    });
    // Must never use `notification` — relay has no content to display (relay.md §1).
    expect(sentBody.message.notification).toBeUndefined();
  });

  it('caches the access token across calls within the TTL window', async () => {
    const keyPem = await generateTestServiceAccountKeyPem();
    const account: FcmServiceAccount = {
      project_id: 'p',
      private_key: keyPem,
      client_email: 'svc@p.iam.gserviceaccount.com',
    };
    let tokenExchangeCount = 0;
    const fakeFetch = (async (url: string) => {
      if (url.toString().includes('oauth2.googleapis.com')) {
        tokenExchangeCount += 1;
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'x' }), { status: 200 });
    }) as typeof fetch;

    await sendFcmPush(account, 'd1', { uuid: 'a' }, fakeFetch);
    await sendFcmPush(account, 'd2', { uuid: 'b' }, fakeFetch);

    expect(tokenExchangeCount).toBe(1);
  });

  it('reports failure with the error message parsed from FCM error body', async () => {
    const keyPem = await generateTestServiceAccountKeyPem();
    const account: FcmServiceAccount = {
      project_id: 'p',
      private_key: keyPem,
      client_email: 'svc@p.iam.gserviceaccount.com',
    };
    const fakeFetch = (async (url: string) => {
      if (url.toString().includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { message: 'Requested entity was not found.' } }),
        { status: 404 }
      );
    }) as typeof fetch;

    const result = await sendFcmPush(account, 'unregistered-tok', { uuid: 'a' }, fakeFetch);
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: 'Requested entity was not found.',
    });
  });
});
