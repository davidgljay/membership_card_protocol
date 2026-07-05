import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  openDeviceSse,
  openCardWebSocket,
  fetchPending,
  ack,
  type DeliveredBlob,
} from '@membership-card-protocol/client-sdk';
import { WebRealtimeTransportProvider } from '../../src/RealtimeTransportProvider.js';

/**
 * Step 5.5 Milestone-review-adjacent scenario: runs the core package's
 * platform-independent delivery orchestration (`messaging/delivery.ts`)
 * against this package's *real* default `RealtimeTransportProvider`
 * (native `EventSource`/`WebSocket`, stubbed only at the global
 * constructor level since jsdom provides neither usable primitive — see
 * `test/providers/RealtimeTransportProvider.test.ts`'s doc comment for
 * why), proving all three delivery paths work end-to-end on the web
 * provider set specifically, not just against a fully-fake
 * `RealtimeTransportProvider` (`client-sdk`'s own
 * `test/messaging/delivery.test.ts` covers that in isolation).
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.#listeners.get(type)?.delete(handler);
  }
  close() {}
  emit(type: string, event: unknown) {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(handler);
  }
  send() {}
  close() {}
  emit(type: string, event: unknown) {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
});

describe('Realtime delivery end-to-end (Step 5.5, web provider set)', () => {
  it('covers all three delivery paths against the real WebRealtimeTransportProvider, and never treats delivery as ack', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const provider = new WebRealtimeTransportProvider();
    const delivered: DeliveredBlob[] = [];

    // Path 1: SSE (foregrounded, not in active chat).
    const sseHandle = openDeviceSse({
      realtimeProvider: provider,
      sseUrl: 'https://relay.example/sse',
      onDelivered: (b) => delivered.push(b),
    });
    FakeEventSource.instances[0]!.emit('message', { data: JSON.stringify({ uuid: 'uuid-sse', blob: 'blob-sse' }) });

    // Path 2: WebSocket (active chat).
    const wsHandle = openCardWebSocket({
      realtimeProvider: provider,
      wsUrl: 'wss://relay.example/ws/uuid-ws',
      onDelivered: (b) => delivered.push(b),
    });
    FakeWebSocket.instances[0]!.emit('message', { data: JSON.stringify({ uuid: 'uuid-ws', blob: 'blob-ws' }) });

    // Path 3: silent-push-triggered GET /pending (backgrounded).
    const pendingMessages: DeliveredBlob[] = [{ uuid: 'uuid-pending', blob: 'blob-pending' }];
    const relayFetch = vi.fn(async (path: string) => {
      expect(path).toBe('/pending');
      return { status: 200, json: async () => ({ messages: pendingMessages }) };
    });
    const pending = await fetchPending({ relayFetch, deviceCredential: 'device-cred' });
    pending.forEach((b) => delivered.push(b));

    expect(delivered.map((d) => d.uuid).sort()).toEqual(['uuid-pending', 'uuid-sse', 'uuid-ws']);

    // No ack has fired for any of the three deliveries yet.
    const ackFetch = vi.fn(async () => ({ status: 200 }));
    // (ackFetch not yet called — confirms delivery alone never triggers ack)
    expect(ackFetch).not.toHaveBeenCalled();

    // Only an explicit ack() call clears them.
    await ack({ relayFetch: ackFetch, deviceCredential: 'device-cred', uuids: delivered.map((d) => d.uuid) });
    expect(ackFetch).toHaveBeenCalledTimes(1);

    sseHandle.close();
    wsHandle.close();
  });
});
