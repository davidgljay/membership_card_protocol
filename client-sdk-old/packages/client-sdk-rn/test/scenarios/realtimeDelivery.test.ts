// No __esModule/default wrapping: react-native-sse's real module is
// `module.exports = EventSource` (a bare CJS export) — see
// test/providers/RealtimeTransportProvider.test.ts's doc comment.
jest.mock('react-native-sse', () => require('../mocks/eventTargetFakes.js').MockRNEventSource);

import { MockRNEventSource, MockWebSocket } from '../mocks/eventTargetFakes.js';
import { RNRealtimeTransportProvider } from '../../src/RealtimeTransportProvider.js';
import {
  openDeviceSse,
  openCardWebSocket,
  fetchPending,
  ack,
  type DeliveredBlob,
} from '@membership-card-protocol/client-sdk';

/**
 * Step 5.5 Milestone-review-adjacent scenario: mirrors
 * `client-sdk-web/test/scenarios/realtimeDelivery.test.ts` exactly, but
 * against the RN default `RealtimeTransportProvider`
 * (`react-native-sse` + native RN `WebSocket`) — proving all three
 * delivery paths, and the never-ack-on-delivery-alone invariant, hold
 * identically on both provider sets.
 */

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockRNEventSource.instances = [];
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});

afterAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe('Realtime delivery end-to-end (Step 5.5, RN provider set)', () => {
  it('covers all three delivery paths against the real RNRealtimeTransportProvider, and never treats delivery as ack', async () => {
    const provider = new RNRealtimeTransportProvider();
    const delivered: DeliveredBlob[] = [];

    // Path 1: SSE (foregrounded, not in active chat).
    const sseHandle = openDeviceSse({
      realtimeProvider: provider,
      sseUrl: 'https://relay.example/sse',
      onDelivered: (b) => delivered.push(b),
    });
    MockRNEventSource.instances[0]!.emit('message', {
      data: JSON.stringify({ uuid: 'uuid-sse', blob: 'blob-sse' }),
    });

    // Path 2: WebSocket (active chat).
    const wsHandle = openCardWebSocket({
      realtimeProvider: provider,
      wsUrl: 'wss://relay.example/ws/uuid-ws',
      onDelivered: (b) => delivered.push(b),
    });
    MockWebSocket.instances[0]!.emit('message', {
      data: JSON.stringify({ uuid: 'uuid-ws', blob: 'blob-ws' }),
    });

    // Path 3: silent-push-triggered GET /pending (backgrounded).
    const pendingMessages: DeliveredBlob[] = [{ uuid: 'uuid-pending', blob: 'blob-pending' }];
    const relayFetch = jest.fn(async (path: string) => {
      expect(path).toBe('/pending');
      return { status: 200, json: async () => ({ messages: pendingMessages }) };
    });
    const pending = await fetchPending({ relayFetch, deviceCredential: 'device-cred' });
    pending.forEach((b) => delivered.push(b));

    expect(delivered.map((d) => d.uuid).sort()).toEqual(['uuid-pending', 'uuid-sse', 'uuid-ws']);

    const ackFetch = jest.fn(async () => ({ status: 200 }));
    expect(ackFetch).not.toHaveBeenCalled();

    await ack({ relayFetch: ackFetch, deviceCredential: 'device-cred', uuids: delivered.map((d) => d.uuid) });
    expect(ackFetch).toHaveBeenCalledTimes(1);

    sseHandle.close();
    wsHandle.close();
  });
});
