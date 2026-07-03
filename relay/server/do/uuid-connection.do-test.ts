// Tests for server/do/uuid-connection.ts's UuidConnection Durable Object,
// run under the real Workers runtime (workerd) via
// @cloudflare/vitest-pool-workers — see vitest.workers.config.ts's header
// comment for why this file lives in a separate config/pool from the rest
// of the suite, and `npm run test:do` for how to run it.
//
// These tests open genuine WebSocket connections into a real
// `UuidConnection` instance (via `env.UUID_CONNECTION.get(id).fetch(...)`
// with `Upgrade: websocket` headers, exactly as
// server/cloudflare-entry.ts's `handleWsUpgrade` does in production) and
// then exercise the DO's `/internal/deliver` and `/internal/status`
// endpoints against that same instance — i.e. this drives the actual
// Hibernation API (`acceptWebSocket`/`getWebSockets`) inside Miniflare's
// workerd, not a hand-rolled mock of `this.ctx`.
//
// relay_data_model.md §10.3 "Delivering a message" step 2 / relay.md §7.3
// is the authoritative behavior under test: does this UUID's DO hold an
// open connection right now, and if so, does /internal/deliver push the
// message into it (and report delivered:true), falling back to
// delivered:false (404) when no connection is open.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DeliverMessage } from './uuid-connection';

interface Env {
  UUID_CONNECTION: DurableObjectNamespace;
  DEVICE_CHANNEL: DurableObjectNamespace;
}

const typedEnv = env as unknown as Env;

/** Opens a real WebSocket connection into the given UUID's DO instance,
 * mirroring server/cloudflare-entry.ts's handleWsUpgrade (minus the Redis
 * validation step, which is the stateless layer's job, not this DO's —
 * relay_data_model.md §10.2). Returns the client-side WebSocket, already
 * `.accept()`ed so it can send/receive frames, plus the stub so callers
 * can hit /internal/* on the same DO instance.
 */
async function openWsConnection(uuid: string) {
  const id = typedEnv.UUID_CONNECTION.idFromName(uuid);
  const stub = typedEnv.UUID_CONNECTION.get(id);

  const url = new URL(`https://do-under-test/anything?uuid=${encodeURIComponent(uuid)}`);
  const res = await stub.fetch(url, {
    headers: { upgrade: 'websocket' },
  });

  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected a 101 WebSocket upgrade, got ${res.status}`);
  }
  const client = res.webSocket;
  client.accept();
  return { stub, client };
}

async function postDeliver(stub: DurableObjectStub, message: DeliverMessage): Promise<Response> {
  return stub.fetch('https://do-under-test/internal/deliver', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
}

async function getStatus(stub: DurableObjectStub): Promise<{ openConnections: number }> {
  const res = await stub.fetch('https://do-under-test/internal/status');
  return res.json();
}

/** Waits for the next message frame received on `client`, as a Promise. */
function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      client.removeEventListener('message', onMessage);
      resolve(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    };
    client.addEventListener('message', onMessage);
    client.addEventListener(
      'error',
      (event) => {
        client.removeEventListener('message', onMessage);
        reject(event);
      },
      { once: true }
    );
  });
}

/** Closes `client` and waits for the close handshake (and therefore the
 * DO's async webSocketClose handler) to fully settle before returning.
 * Required so @cloudflare/vitest-pool-workers's isolated-storage snapshot
 * (taken at the end of each test) never races an in-flight DO teardown —
 * see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage.
 *
 * Always passes an explicit close code: workerd's WebSocket.close()
 * rejects the no-argument form with "Invalid WebSocket close code: 1005"
 * (1005 is a reserved code that must never actually appear on the wire
 * per the WebSocket spec, so it cannot be used as a real close() argument
 * even though it's the *reported* code for "closed with no status" —
 * calling close() with no arguments in workerd throws rather than
 * defaulting to something sendable).
 */
async function closeAndWait(client: WebSocket, code = 1000, reason?: string): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    client.addEventListener('close', () => resolve(), { once: true });
  });
  client.close(code, reason);
  await closed;
}

describe('UuidConnection Durable Object', () => {
  it('delivers a message over an open WebSocket connection for the addressed uuid', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const { stub, client } = await openWsConnection(uuid);

    const message: DeliverMessage = { uuid, blob: 'ZW5jcnlwdGVkLWJsb2I' };
    const framePromise = nextMessage(client);

    const res = await postDeliver(stub, message);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ delivered: true });

    const frame = await framePromise;
    expect(JSON.parse(frame)).toEqual({ uuid, blob: 'ZW5jcnlwdGVkLWJsb2I' });

    await closeAndWait(client);
  });

  it('reports delivered:false (404) when no socket is open for this uuid', async () => {
    const uuid = '22222222-2222-4222-8222-222222222222';
    const id = typedEnv.UUID_CONNECTION.idFromName(uuid);
    const stub = typedEnv.UUID_CONNECTION.get(id);

    const res = await postDeliver(stub, { uuid, blob: 'ZGVsaXZlcmVkLW5vd2hlcmU' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ delivered: false });
  });

  it('/internal/status reflects zero open connections for a never-connected uuid', async () => {
    const uuid = '33333333-3333-4333-8333-333333333333';
    const id = typedEnv.UUID_CONNECTION.idFromName(uuid);
    const stub = typedEnv.UUID_CONNECTION.get(id);

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 0 });
  });

  it('/internal/status reflects one open connection once a socket has been accepted', async () => {
    const uuid = '44444444-4444-4444-8444-444444444444';
    const { stub, client } = await openWsConnection(uuid);

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 1 });

    await closeAndWait(client);
  });

  it('ignores inbound frames sent by the device over this WebSocket (delivery-only channel)', async () => {
    const uuid = '55555555-5555-4555-8555-555555555555';
    const { stub, client } = await openWsConnection(uuid);

    // relay.md §7.3: "Any frames sent by the device over this WebSocket
    // connection are ignored by the relay." Sending a frame must not
    // throw, close the connection, or otherwise disturb deliverability —
    // proven below by immediately delivering into the same connection
    // afterwards without any intervening delay/poll.
    client.send('device says hello');

    const framePromise = nextMessage(client);
    const res = await postDeliver(stub, { uuid, blob: 'c3RpbGwtYWxpdmU' });
    expect(res.status).toBe(200);
    await framePromise;

    await closeAndWait(client);
  });

  it('removes the connection from the open-socket set on webSocketClose, so a subsequent deliver reports delivered:false', async () => {
    const uuid = '66666666-6666-4666-8666-666666666666';
    const { stub, client } = await openWsConnection(uuid);

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 1 });

    await closeAndWait(client, 1000, 'device done');

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 0 });

    const res = await postDeliver(stub, { uuid, blob: 'dG9vLWxhdGU' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ delivered: false });
  });

  it('delivering to a different uuid does not deliver into an unrelated uuid\'s open connection', async () => {
    const uuidA = '77777777-7777-4777-8777-777777777777';
    const uuidB = '88888888-8888-4888-8888-888888888888';

    const { client: clientA } = await openWsConnection(uuidA);
    // No connection opened for uuidB.

    const idB = typedEnv.UUID_CONNECTION.idFromName(uuidB);
    const stubB = typedEnv.UUID_CONNECTION.get(idB);

    const res = await postDeliver(stubB, { uuid: uuidB, blob: 'bm90LWZvci1h' });
    expect(res.status).toBe(404);

    await closeAndWait(clientA);
  });
});
