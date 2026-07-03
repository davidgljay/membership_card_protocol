// Tests for server/do/device-channel.ts's DeviceChannel Durable Object —
// same shape as uuid-connection.do-test.ts, but keyed by
// `device_credential` instead of `uuid` (relay.md §7.4,
// relay_data_model.md §10.3). See uuid-connection.do-test.ts's header
// comment for the general rationale (real Hibernation API under workerd
// via @cloudflare/vitest-pool-workers, not a hand-mocked `this.ctx`).

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DeliverMessage } from './device-channel';

interface Env {
  UUID_CONNECTION: DurableObjectNamespace;
  DEVICE_CHANNEL: DurableObjectNamespace;
}

const typedEnv = env as unknown as Env;

/** Opens a real WebSocket connection into the given device_credential's DO
 * instance, mirroring server/cloudflare-entry.ts's handleSseUpgrade (minus
 * the credential-validation step, which is the stateless layer's job —
 * relay_data_model.md §10.2).
 */
async function openDeviceChannelConnection(deviceCredential: string) {
  const id = typedEnv.DEVICE_CHANNEL.idFromName(deviceCredential);
  const stub = typedEnv.DEVICE_CHANNEL.get(id);

  const url = new URL(
    `https://do-under-test/anything?device_credential=${encodeURIComponent(deviceCredential)}`
  );
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
 * Always passes an explicit close code — see uuid-connection.do-test.ts's
 * identical helper for why workerd rejects the no-argument close() form.
 */
async function closeAndWait(client: WebSocket, code = 1000, reason?: string): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    client.addEventListener('close', () => resolve(), { once: true });
  });
  client.close(code, reason);
  await closed;
}

describe('DeviceChannel Durable Object', () => {
  it('delivers a message over an open connection for the addressed device_credential', async () => {
    const credential = 'cred-aaaaaaaaaaaaaaaaaaaaaaaa';
    const { stub, client } = await openDeviceChannelConnection(credential);

    const uuid = '99999999-9999-4999-8999-999999999999';
    const message: DeliverMessage = { uuid, blob: 'ZGV2aWNlLWNoYW5uZWwtYmxvYg' };
    const framePromise = nextMessage(client);

    const res = await postDeliver(stub, message);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ delivered: true });

    const frame = await framePromise;
    expect(JSON.parse(frame)).toEqual({ uuid, blob: 'ZGV2aWNlLWNoYW5uZWwtYmxvYg' });

    await closeAndWait(client);
  });

  it('reports delivered:false (404) when no socket is open for this device_credential', async () => {
    const credential = 'cred-bbbbbbbbbbbbbbbbbbbbbbbb';
    const id = typedEnv.DEVICE_CHANNEL.idFromName(credential);
    const stub = typedEnv.DEVICE_CHANNEL.get(id);

    const res = await postDeliver(stub, {
      uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
      blob: 'bm8tY29ubmVjdGlvbg',
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ delivered: false });
  });

  it('/internal/status reflects one open connection once a socket has been accepted', async () => {
    const credential = 'cred-cccccccccccccccccccccccc';
    const { stub, client } = await openDeviceChannelConnection(credential);

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 1 });

    await closeAndWait(client);
  });

  it('removes the connection from the open-socket set on webSocketClose, so a subsequent deliver reports delivered:false', async () => {
    const credential = 'cred-dddddddddddddddddddddddd';
    const { stub, client } = await openDeviceChannelConnection(credential);

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 1 });

    await closeAndWait(client, 1000, 'app backgrounded');

    await expect(getStatus(stub)).resolves.toEqual({ openConnections: 0 });

    const res = await postDeliver(stub, {
      uuid: 'bbbbbbbb-2222-4222-8222-222222222222',
      blob: 'dG9vLWxhdGU',
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ delivered: false });
  });

  it('delivering to a different device_credential does not deliver into an unrelated channel\'s open connection', async () => {
    const credA = 'cred-eeeeeeeeeeeeeeeeeeeeeeee';
    const credB = 'cred-ffffffffffffffffffffffff';

    const { client: clientA } = await openDeviceChannelConnection(credA);

    const idB = typedEnv.DEVICE_CHANNEL.idFromName(credB);
    const stubB = typedEnv.DEVICE_CHANNEL.get(idB);

    const res = await postDeliver(stubB, {
      uuid: 'cccccccc-3333-4333-8333-333333333333',
      blob: 'bm90LWZvci1i',
    });
    expect(res.status).toBe(404);

    await closeAndWait(clientA);
  });
});
