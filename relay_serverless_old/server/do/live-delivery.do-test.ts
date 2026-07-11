// Tests for do-client.ts's attemptLiveDelivery() — the function
// server/api/deliver/[uuid].post.ts delegates to for relay.md §7.2 step 7's
// full behavior: which channel (SSE vs WS) wins, AND that channel's
// differing staggered-delete-scheduling rule:
//
//   - SSE: "Do not remove from message store yet — wait for POST /ack."
//     -> attemptLiveDelivery must NOT invoke the injected enqueueDelete
//        callback when delivery went out over SSE (DeviceChannel).
//   - WS:  "forward blob. Schedule staggered delete on delivery."
//     -> attemptLiveDelivery MUST invoke enqueueDelete exactly once,
//        synchronously as part of the same call, when delivery went out
//        over WebSocket (UuidConnection).
//
// This is the fix for the spec-vs-code divergence flagged against relay.md
// §7.2 step 7: previously, deliver/[uuid].post.ts called
// deliverToDeviceChannel/deliverToUuidConnection directly and never
// enqueued a staggered delete for the WS branch at all (WS-delivered
// messages relied entirely on the device separately calling POST /ack,
// which relay.md never specifies for the WS channel — POST /ack is
// documented as the device's channel-agnostic mechanism, but §7.2 step 7's
// WS branch explicitly says the schedule happens "on delivery", not on a
// later ack).
//
// WHY THIS EXERCISES REAL DO STUBS RATHER THAN MOCKING deliverToDeviceChannel
// / deliverToUuidConnection: do-client-routing.do-test.ts already
// established (and documents at length) that testing the routing decision
// against real DO stubs from workerd's `env` (via `cloudflare:test`) is
// preferable to mocking the DO layer, since it proves the actual Durable
// Object runtime is being asked, not a stand-in. This file reuses that same
// approach and connection-opening helpers so that BOTH halves of the
// contract — which channel wins, AND whether the delete gets enqueued — are
// proven against genuine DO connections, not just the branch condition in
// isolation. Only the delete-queue side is a spy (an injected
// `enqueueDelete` callback), because attemptLiveDelivery is deliberately
// decoupled from any concrete queue implementation (see its doc comment in
// do-client.ts) — the real Redis-backed DeleteQueue is exercised
// separately in server/utils/redis/delete-queue.test.ts, and wiring a real
// Redis connection into the workerd pool is out of scope here for the same
// reasons do-client-routing.do-test.ts's header comment gives for not
// wiring Redis into that file either.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';
import { attemptLiveDelivery } from '../utils/do-client';

function fakeEvent(): H3Event {
  return { context: { cloudflare: { env } } } as unknown as H3Event;
}

interface Env {
  UUID_CONNECTION: DurableObjectNamespace;
  DEVICE_CHANNEL: DurableObjectNamespace;
}

const typedEnv = env as unknown as Env;

async function openWsConnection(uuid: string) {
  const id = typedEnv.UUID_CONNECTION.idFromName(uuid);
  const stub = typedEnv.UUID_CONNECTION.get(id);
  const url = new URL(`https://do-under-test/anything?uuid=${encodeURIComponent(uuid)}`);
  const res = await stub.fetch(url, { headers: { upgrade: 'websocket' } });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected a 101 WebSocket upgrade, got ${res.status}`);
  }
  const client = res.webSocket;
  client.accept();
  return client;
}

async function openDeviceChannelConnection(deviceCredential: string) {
  const id = typedEnv.DEVICE_CHANNEL.idFromName(deviceCredential);
  const stub = typedEnv.DEVICE_CHANNEL.get(id);
  const url = new URL(
    `https://do-under-test/anything?device_credential=${encodeURIComponent(deviceCredential)}`
  );
  const res = await stub.fetch(url, { headers: { upgrade: 'websocket' } });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected a 101 WebSocket upgrade, got ${res.status}`);
  }
  const client = res.webSocket;
  client.accept();
  return client;
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      client.removeEventListener('message', onMessage);
      resolve(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    };
    client.addEventListener('message', onMessage);
    client.addEventListener('error', (event) => reject(event), { once: true });
  });
}

/** See do-client-routing.do-test.ts's identical helper for why this
 * explicit-close-code-then-await pattern is required under
 * @cloudflare/vitest-pool-workers's `isolatedStorage: false` configuration.
 */
async function closeAndWait(client: WebSocket): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    client.addEventListener('close', () => resolve(), { once: true });
  });
  client.close(1000);
  await closed;
}

/** A spy for the `enqueueDelete` callback attemptLiveDelivery takes. */
function makeEnqueueSpy() {
  let callCount = 0;
  return {
    async enqueueDelete(): Promise<void> {
      callCount += 1;
    },
    get callCount() {
      return callCount;
    },
  };
}

describe('attemptLiveDelivery (do-client.ts) — relay.md §7.2 step 7 SSE/WS delete-scheduling branch', () => {
  it('SSE delivery: reports channel "sse", delivers the frame, and does NOT enqueue a staggered delete', async () => {
    const credential = 'cred-live-delivery-sse';
    const client = await openDeviceChannelConnection(credential);
    const spy = makeEnqueueSpy();

    const uuid = 'bbbbbbbb-0000-4000-8000-000000000001';
    const framePromise = nextMessage(client);

    const outcome = await attemptLiveDelivery(
      fakeEvent(),
      uuid,
      { device_credential: credential, wallet_base_url: 'https://wallet.example.com' },
      { uuid, blob: 'c3NlLWRlbGl2ZXJ5' },
      spy.enqueueDelete
    );

    expect(outcome).toEqual({ channel: 'sse', delivered: true });

    const frame = await framePromise;
    expect(JSON.parse(frame)).toEqual({ uuid, blob: 'c3NlLWRlbGl2ZXJ5' });

    // The crux of the fix: an SSE-delivered message must NOT have a
    // staggered delete scheduled here. It waits for POST /ack
    // (server/api/ack.post.ts), which is a completely separate code path
    // this test does not invoke — so if the spy were ever called, it could
    // only be attemptLiveDelivery's SSE branch incorrectly enqueueing.
    expect(spy.callCount).toBe(0);

    await closeAndWait(client);
  });

  it('WebSocket delivery: reports channel "ws", delivers the frame, and DOES enqueue a staggered delete immediately', async () => {
    const uuid = 'bbbbbbbb-0000-4000-8000-000000000002';
    const client = await openWsConnection(uuid);
    const spy = makeEnqueueSpy();

    const framePromise = nextMessage(client);

    const outcome = await attemptLiveDelivery(
      fakeEvent(),
      uuid,
      { device_credential: 'cred-live-delivery-ws', wallet_base_url: 'https://wallet.example.com' },
      { uuid, blob: 'd3MtZGVsaXZlcnk' },
      spy.enqueueDelete
    );

    expect(outcome).toEqual({ channel: 'ws', delivered: true });

    const frame = await framePromise;
    expect(JSON.parse(frame)).toEqual({ uuid, blob: 'd3MtZGVsaXZlcnk' });

    // The crux of the fix: a WS-delivered message MUST have the staggered
    // delete scheduled immediately, as part of this same call — there is
    // no separate ack step for the WS channel per relay.md §7.2 step 7.
    expect(spy.callCount).toBe(1);

    await closeAndWait(client);
  });

  it('no live connection: reports channel "none", delivered:false, and does not enqueue a delete (falls through to push instead)', async () => {
    const uuid = 'bbbbbbbb-0000-4000-8000-000000000003';
    const spy = makeEnqueueSpy();

    const outcome = await attemptLiveDelivery(
      fakeEvent(),
      uuid,
      { device_credential: 'cred-live-delivery-none', wallet_base_url: 'https://wallet.example.com' },
      { uuid, blob: 'bm8tbGl2ZS1jb25u' },
      spy.enqueueDelete
    );

    expect(outcome).toEqual({ channel: 'none', delivered: false });
    expect(spy.callCount).toBe(0);
  });

  it('priority: when both SSE and WS connections are open, SSE wins and the delete is still NOT enqueued (WS branch never runs)', async () => {
    const uuid = 'bbbbbbbb-0000-4000-8000-000000000004';
    const credential = 'cred-live-delivery-both-open';

    const sseClient = await openDeviceChannelConnection(credential);
    const wsClient = await openWsConnection(uuid);
    const spy = makeEnqueueSpy();

    const sseFramePromise = nextMessage(sseClient);

    const outcome = await attemptLiveDelivery(
      fakeEvent(),
      uuid,
      { device_credential: credential, wallet_base_url: 'https://wallet.example.com' },
      { uuid, blob: 'Ym90aC1vcGVuLWxpdmU' },
      spy.enqueueDelete
    );

    expect(outcome).toEqual({ channel: 'sse', delivered: true });
    await sseFramePromise;

    // SSE won, so no delete was enqueued — confirming the WS branch (which
    // would have enqueued) genuinely never ran, not just that it happened
    // not to call the spy for some other reason.
    expect(spy.callCount).toBe(0);

    // The WS connection received nothing, corroborating that delivery went
    // to SSE only.
    let wsReceivedAnything = false;
    const wsListener = () => {
      wsReceivedAnything = true;
    };
    wsClient.addEventListener('message', wsListener);
    await new Promise((resolve) => setTimeout(resolve, 30));
    wsClient.removeEventListener('message', wsListener);
    expect(wsReceivedAnything).toBe(false);

    await closeAndWait(sseClient);
    await closeAndWait(wsClient);
  });
});
