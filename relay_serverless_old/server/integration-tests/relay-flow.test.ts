// Integration tests for the five stateless HTTP handlers (register, deliver,
// pending, ack, health) — Phase 2 step 2.3's "Done when" clause: these run
// against the REAL built node-server output (`.output/server/index.mjs`,
// via `npm run build:node`), spawned as a genuine child process and driven
// over real HTTP by http-server-harness.ts, proving the portability claim
// rather than exercising handler functions in isolation with a fake H3Event.
//
// Contract source of truth: specs/object_specs/relay.md §7.1 (register),
// §7.2 (deliver), §7.5 (pending), §7.6 (ack), §7.7 (health).
//
// Requires `npm run build:node` to have been run first — see
// http-server-harness.ts's module doc; startHttpServerHarness throws a
// clear error if `.output/server/index.mjs` is missing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServerHarness, type HttpServerHarness } from './http-server-harness';
import type { AppConfig } from '../utils/app-registry';

const TEST_APP: AppConfig = {
  app_id: 'com.example.wallet',
  platform: 'apns',
  wallet_base_url: 'https://wallet.example.com',
  apns: {
    key_file: 'unused-in-tests.p8',
    key_id: 'ABC123DEFG',
    team_id: 'TEAM123456',
    bundle_id: 'com.example.wallet',
    sandbox: true,
  },
};

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let harness: HttpServerHarness;

/**
 * Under the node-server preset, an uncaught H3Error thrown via h3's
 * `createError` (http-errors.ts's `relayError`) is serialized by h3's
 * default error handler into an envelope — `{ error: true, url,
 * statusCode, statusMessage, message, data: {...} }` — with the actual
 * `{ error: <CODE>, message }` payload `relayError()` set as `data`
 * nested one level inside `data`, not at the response body's top level.
 * Confirmed by direct inspection of a live response body (not assumed).
 * This helper unwraps that envelope so tests assert on the relay's own
 * error code/message contract (relay.md §10), not h3's wrapper shape.
 */
function relayErrorPayload(body: unknown): { error: string; message: string } {
  const b = body as { data?: { error?: string; message?: string } };
  if (!b?.data?.error) {
    throw new Error(`Response body is not an h3 error envelope with a relay error code: ${JSON.stringify(body)}`);
  }
  return { error: b.data.error, message: b.data.message ?? '' };
}

async function register(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function deliver(uuid: string, blob: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/deliver/${uuid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob }),
  });
}

async function pending(credential: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/pending`, {
    headers: { authorization: `Bearer ${credential}` },
  });
}

async function ack(credential: string, uuids: string[]): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ uuids }),
  });
}

async function health(): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/health`);
}

/** Bootstraps a fresh device credential + one UUID, for tests that need a starting point. */
async function bootstrapDevice(count = 1): Promise<{ device_credential: string; uuids: string[] }> {
  const res = await register({ app_id: TEST_APP.app_id, push_token: 'push-token-abc', count });
  const body = (await res.json()) as { device_credential: string; uuids: string[] };
  return body;
}

/**
 * Narrows `arr[0]` from `string | undefined` to `string` (tsconfig.json's
 * `noUncheckedIndexedAccess` applies to test files too) by asserting the
 * array is non-empty — every call site below only uses this on an array
 * this same test just confirmed has at least one element.
 */
function firstOf(arr: string[]): string {
  const value = arr[0];
  if (value === undefined) {
    throw new Error('Expected at least one element');
  }
  return value;
}

beforeEach(async () => {
  harness = await startHttpServerHarness({ appRegistryFile: { apps: [TEST_APP] } });
}, 20_000);

afterEach(async () => {
  await harness.teardown();
});

describe('GET /health', () => {
  it('returns 200 with status ok and both dependencies ok', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const body = await res.json();
    // health.get.ts intentionally names the KV-check field "sqlite" per
    // relay.md §7.7's literal response schema — not renamed to "kv".
    expect(body).toEqual({ status: 'ok', redis: 'ok', sqlite: 'ok' });
  });
});

describe('POST /register', () => {
  it('bootstrap: returns uuids and a device_credential when no Authorization header is sent', async () => {
    const res = await register({ app_id: TEST_APP.app_id, push_token: 'push-token-1', count: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uuids: string[]; device_credential: string };
    expect(body.uuids).toHaveLength(5);
    for (const uuid of body.uuids) {
      expect(uuid).toMatch(UUID_V4_RE);
    }
    expect(typeof body.device_credential).toBe('string');
    expect(body.device_credential.length).toBeGreaterThan(0);
  });

  it('defaults count to 10 when omitted', async () => {
    const res = await register({ app_id: TEST_APP.app_id, push_token: 'push-token-2' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uuids: string[] };
    expect(body.uuids).toHaveLength(10);
  });

  it('replenishment: presenting a valid credential returns only new uuids, no device_credential field', async () => {
    const { device_credential } = await bootstrapDevice(3);
    const res = await register(
      { app_id: TEST_APP.app_id, push_token: 'push-token-1', count: 2 },
      { authorization: `Bearer ${device_credential}` }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.uuids)).toBe(true);
    expect((body.uuids as string[]).length).toBe(2);
    expect(body.device_credential).toBeUndefined();
  });

  it('rejects missing app_id with 400 MISSING_FIELD', async () => {
    const res = await register({ push_token: 'push-token-1' });
    expect(res.status).toBe(400);
    expect(relayErrorPayload(await res.json()).error).toBe('MISSING_FIELD');
  });

  it('rejects missing push_token with 400 MISSING_FIELD', async () => {
    const res = await register({ app_id: TEST_APP.app_id });
    expect(res.status).toBe(400);
    expect(relayErrorPayload(await res.json()).error).toBe('MISSING_FIELD');
  });

  it('rejects count outside 1-100 with 400 INVALID_COUNT', async () => {
    const tooMany = await register({ app_id: TEST_APP.app_id, push_token: 'p', count: 101 });
    expect(tooMany.status).toBe(400);
    expect(relayErrorPayload(await tooMany.json()).error).toBe('INVALID_COUNT');

    const tooFew = await register({ app_id: TEST_APP.app_id, push_token: 'p', count: 0 });
    expect(tooFew.status).toBe(400);
    expect(relayErrorPayload(await tooFew.json()).error).toBe('INVALID_COUNT');
  });

  it('rejects unknown app_id with 404 UNKNOWN_APP', async () => {
    const res = await register({ app_id: 'com.example.not-registered', push_token: 'p' });
    expect(res.status).toBe(404);
    expect(relayErrorPayload(await res.json()).error).toBe('UNKNOWN_APP');
  });

  it('rejects an unknown/expired bearer credential on replenishment with 401 INVALID_CREDENTIAL', async () => {
    const res = await register(
      { app_id: TEST_APP.app_id, push_token: 'p' },
      { authorization: 'Bearer not-a-real-credential' }
    );
    expect(res.status).toBe(401);
    expect(relayErrorPayload(await res.json()).error).toBe('INVALID_CREDENTIAL');
  });
});

describe('POST /deliver/{uuid}', () => {
  it('delivers to a registered, unused UUID and falls back gracefully with no DO available (node-server has no Cloudflare env)', async () => {
    const { uuids } = await bootstrapDevice(1);
    const res = await deliver(firstOf(uuids), 'ZW5jcnlwdGVkLWJsb2I');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it('rejects a malformed UUID with 400 INVALID_UUID', async () => {
    const res = await deliver('not-a-uuid', 'blob');
    expect(res.status).toBe(400);
    expect(relayErrorPayload(await res.json()).error).toBe('INVALID_UUID');
  });

  it('rejects a missing blob with 400 MISSING_FIELD', async () => {
    const { uuids } = await bootstrapDevice(1);
    const res = await fetch(`${harness.baseUrl}/api/deliver/${firstOf(uuids)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(relayErrorPayload(await res.json()).error).toBe('MISSING_FIELD');
  });

  it('rejects delivery to an unknown UUID with 404 UNKNOWN_UUID', async () => {
    const res = await deliver('11111111-1111-4111-8111-111111111111', 'blob');
    expect(res.status).toBe(404);
    expect(relayErrorPayload(await res.json()).error).toBe('UNKNOWN_UUID');
  });

  it('rejects delivery to an already-consumed UUID with 410 UUID_CONSUMED', async () => {
    const { uuids } = await bootstrapDevice(1);
    const uuid = firstOf(uuids);
    const first = await deliver(uuid, 'first-blob');
    expect(first.status).toBe(200);

    const second = await deliver(uuid, 'second-blob');
    expect(second.status).toBe(410);
    expect(relayErrorPayload(await second.json()).error).toBe('UUID_CONSUMED');
  });
});

describe('GET /pending', () => {
  it('rejects a request with no Authorization header with 401 MISSING_CREDENTIAL', async () => {
    const res = await fetch(`${harness.baseUrl}/api/pending`);
    expect(res.status).toBe(401);
    expect(relayErrorPayload(await res.json()).error).toBe('MISSING_CREDENTIAL');
  });

  it('rejects an unknown credential with 401 INVALID_CREDENTIAL', async () => {
    const res = await pending('not-a-real-credential');
    expect(res.status).toBe(401);
    expect(relayErrorPayload(await res.json()).error).toBe('INVALID_CREDENTIAL');
  });

  it('returns an empty messages array when nothing is pending', async () => {
    const { device_credential } = await bootstrapDevice(1);
    const res = await pending(device_credential);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('surfaces a delivered message for the right device_credential, and clears it on read', async () => {
    const { device_credential, uuids } = await bootstrapDevice(1);
    const uuid = firstOf(uuids);
    const deliverRes = await deliver(uuid, 'cGVuZGluZy1ibG9i');
    expect(deliverRes.status).toBe(200);

    const first = await pending(device_credential);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { messages: Array<{ uuid: string; blob: string }> };
    expect(firstBody.messages).toEqual([{ uuid, blob: 'cGVuZGluZy1ibG9i' }]);

    // Read-and-clear: a second GET /pending should now be empty.
    const second = await pending(device_credential);
    expect(await second.json()).toEqual({ messages: [] });
  });

  it('does not leak a delivered message to a different device_credential', async () => {
    const deviceA = await bootstrapDevice(1);
    const deviceB = await bootstrapDevice(1);
    const uuidA = firstOf(deviceA.uuids);
    await deliver(uuidA, 'blob-for-a');

    const bResult = await pending(deviceB.device_credential);
    expect(await bResult.json()).toEqual({ messages: [] });

    const aResult = await pending(deviceA.device_credential);
    const aBody = (await aResult.json()) as { messages: Array<{ uuid: string; blob: string }> };
    expect(aBody.messages).toEqual([{ uuid: uuidA, blob: 'blob-for-a' }]);
  });
});

describe('POST /ack', () => {
  it('rejects a request with no Authorization header with 401 MISSING_CREDENTIAL', async () => {
    const res = await fetch(`${harness.baseUrl}/api/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuids: ['x'] }),
    });
    expect(res.status).toBe(401);
    expect(relayErrorPayload(await res.json()).error).toBe('MISSING_CREDENTIAL');
  });

  it('rejects an unknown credential with 401 INVALID_CREDENTIAL', async () => {
    const res = await ack('not-a-real-credential', ['x']);
    expect(res.status).toBe(401);
    expect(relayErrorPayload(await res.json()).error).toBe('INVALID_CREDENTIAL');
  });

  it('rejects a missing/empty uuids array with 400 MISSING_FIELD', async () => {
    const { device_credential } = await bootstrapDevice(1);

    const missing = await ack(device_credential, undefined as unknown as string[]);
    expect(missing.status).toBe(400);
    expect(relayErrorPayload(await missing.json()).error).toBe('MISSING_FIELD');

    const empty = await ack(device_credential, []);
    expect(empty.status).toBe(400);
    expect(relayErrorPayload(await empty.json()).error).toBe('MISSING_FIELD');
  });

  it('acks a delivered message with 200 and an empty body', async () => {
    const { device_credential, uuids } = await bootstrapDevice(1);
    const uuid = firstOf(uuids);
    await deliver(uuid, 'blob-to-ack');
    await pending(device_credential); // drain, as a device normally would before acking

    const res = await ack(device_credential, [uuid]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('acking the same uuid twice is handled without error (still 200)', async () => {
    const { device_credential, uuids } = await bootstrapDevice(1);
    const uuid = firstOf(uuids);
    await deliver(uuid, 'blob-to-ack-twice');

    const first = await ack(device_credential, [uuid]);
    expect(first.status).toBe(200);

    const second = await ack(device_credential, [uuid]);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({});
  });

  it('acking an unknown uuid is silently skipped per relay.md §7.6, still 200', async () => {
    const { device_credential } = await bootstrapDevice(1);
    const res = await ack(device_credential, ['22222222-2222-4222-8222-222222222222']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe('end-to-end flow: register -> deliver -> pending -> ack', () => {
  it('chains the full realistic device journey', async () => {
    // 1. Bootstrap a device and get a pool of UUIDs.
    const registerRes = await register({
      app_id: TEST_APP.app_id,
      push_token: 'e2e-push-token',
      count: 3,
    });
    expect(registerRes.status).toBe(200);
    const { uuids, device_credential } = (await registerRes.json()) as {
      uuids: string[];
      device_credential: string;
    };
    expect(uuids).toHaveLength(3);

    // 2. Wallet service delivers a message against one of those UUIDs.
    const targetUuid = firstOf(uuids);
    const deliverRes = await deliver(targetUuid, 'ZTJlLWVuY3J5cHRlZC1wYXlsb2Fk');
    expect(deliverRes.status).toBe(200);
    expect(await deliverRes.json()).toEqual({});

    // 3. Delivering again to the same (now-consumed) UUID is rejected.
    const redeliverRes = await deliver(targetUuid, 'second-attempt');
    expect(redeliverRes.status).toBe(410);

    // 4. Device wakes (e.g. after silent push) and polls for pending messages.
    const pendingRes = await pending(device_credential);
    expect(pendingRes.status).toBe(200);
    const pendingBody = (await pendingRes.json()) as {
      messages: Array<{ uuid: string; blob: string }>;
    };
    expect(pendingBody.messages).toEqual([
      { uuid: targetUuid, blob: 'ZTJlLWVuY3J5cHRlZC1wYXlsb2Fk' },
    ]);

    // 5. A second poll before acking returns nothing new (already cleared by read-and-clear).
    const secondPendingRes = await pending(device_credential);
    expect((await secondPendingRes.json()) as { messages: unknown[] }).toEqual({ messages: [] });

    // 6. Device acknowledges receipt, scheduling staggered wallet clearance.
    const ackRes = await ack(device_credential, [targetUuid]);
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({});

    // 7. The other two UUIDs from the original pool remain usable.
    const secondUuid = uuids[1];
    if (secondUuid === undefined) {
      throw new Error('Expected a second uuid from the bootstrap pool');
    }
    const secondDeliverRes = await deliver(secondUuid, 'another-message');
    expect(secondDeliverRes.status).toBe(200);
    const followUpPending = (await pending(device_credential).then((r) => r.json())) as {
      messages: Array<{ uuid: string; blob: string }>;
    };
    expect(followUpPending.messages).toEqual([{ uuid: secondUuid, blob: 'another-message' }]);
  });
});
