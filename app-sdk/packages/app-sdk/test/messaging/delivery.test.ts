import { describe, it, expect, vi } from 'vitest';
import type { RealtimeTransportProvider } from '../../src/providers/RealtimeTransportProvider.js';
import {
  openDeviceSse,
  openCardWebSocket,
  fetchPending,
  ack,
  type DeliveredBlob,
} from '../../src/messaging/delivery.js';

/**
 * A fake `RealtimeTransportProvider` whose SSE and WebSocket channels are
 * driven manually by the test (`fireSseMessage` / `fireWsMessage`) rather
 * than by a real EventSource/WebSocket — this is the "stub relay" Step
 * 5.5's acceptance criterion calls for, standing in for the real relay
 * across all three delivery paths.
 */
function makeFakeRealtimeTransport() {
  const sseHandlers: { onMessage: (data: string) => void; onError: (e: unknown) => void }[] = [];
  const wsHandlers = new Map<string, { onMessage?: (data: string | Uint8Array) => void; onClose?: (c: number, r: string) => void; onError?: (e: unknown) => void }>();
  const closedSse = { count: 0 };
  const closedWs = new Set<string>();

  const provider: RealtimeTransportProvider = {
    subscribeSSE(_url, onMessage, onError) {
      sseHandlers.push({ onMessage, onError });
      return () => {
        closedSse.count++;
      };
    },
    connectWebSocket(url) {
      const handlers: { onMessage?: (data: string | Uint8Array) => void; onClose?: (c: number, r: string) => void; onError?: (e: unknown) => void } = {};
      wsHandlers.set(url, handlers);
      return {
        send: vi.fn(),
        close: () => {
          closedWs.add(url);
        },
        onMessage: (handler) => {
          handlers.onMessage = handler;
        },
        onClose: (handler) => {
          handlers.onClose = handler;
        },
        onError: (handler) => {
          handlers.onError = handler;
        },
      };
    },
  };

  return {
    provider,
    fireSseMessage: (data: string) => sseHandlers.forEach((h) => h.onMessage(data)),
    fireWsMessage: (url: string, data: string) => wsHandlers.get(url)?.onMessage?.(data),
    closedSse,
    closedWs,
  };
}

function makeFakeRelayHttp() {
  const ackCalls: string[][] = [];
  let pendingMessages: DeliveredBlob[] = [];

  const relayFetch = vi.fn(
    async (path: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
      if (path === '/pending' && init.method === 'GET') {
        return {
          status: 200,
          json: async () => ({ messages: pendingMessages }),
        };
      }
      if (path === '/ack' && init.method === 'POST') {
        const body = JSON.parse(init.body!) as { uuids: string[] };
        ackCalls.push(body.uuids);
        return { status: 200 };
      }
      throw new Error(`unexpected relayFetch call: ${path}`);
    }
  );

  return {
    relayFetch,
    ackCalls,
    setPendingMessages: (messages: DeliveredBlob[]) => {
      pendingMessages = messages;
    },
  };
}

describe('Realtime delivery (Step 5.5)', () => {
  it('SSE path (foregrounded): a message delivered over SSE reaches onDelivered', () => {
    const { provider, fireSseMessage } = makeFakeRealtimeTransport();
    const delivered: DeliveredBlob[] = [];

    const handle = openDeviceSse({
      realtimeProvider: provider,
      sseUrl: 'https://relay.example/sse',
      onDelivered: (blob) => delivered.push(blob),
    });

    fireSseMessage(JSON.stringify({ uuid: 'uuid-sse-1', blob: 'ciphertext-1' }));

    expect(delivered).toEqual([{ uuid: 'uuid-sse-1', blob: 'ciphertext-1' }]);
    handle.close();
  });

  it('WebSocket path (active chat): a message delivered over an open per-card WebSocket reaches onDelivered', () => {
    const { provider, fireWsMessage } = makeFakeRealtimeTransport();
    const delivered: DeliveredBlob[] = [];

    const handle = openCardWebSocket({
      realtimeProvider: provider,
      wsUrl: 'wss://relay.example/ws/uuid-ws-1',
      onDelivered: (blob) => delivered.push(blob),
    });

    fireWsMessage('wss://relay.example/ws/uuid-ws-1', JSON.stringify({ uuid: 'uuid-ws-1', blob: 'ciphertext-2' }));

    expect(delivered).toEqual([{ uuid: 'uuid-ws-1', blob: 'ciphertext-2' }]);
    handle.close();
  });

  it('silent-push-triggered pending-pickup path (backgrounded): GET /pending returns queued blobs', async () => {
    const { relayFetch, setPendingMessages } = makeFakeRelayHttp();
    setPendingMessages([{ uuid: 'uuid-pending-1', blob: 'ciphertext-3' }]);

    const messages = await fetchPending({ relayFetch, deviceCredential: 'device-cred-1' });

    expect(messages).toEqual([{ uuid: 'uuid-pending-1', blob: 'ciphertext-3' }]);
  });

  it('a message is never marked "acked" merely by arriving over any delivery path — ack() is the only path to wallet clearance, and none of the delivery functions call it', async () => {
    const { provider, fireSseMessage, fireWsMessage } = makeFakeRealtimeTransport();
    const { relayFetch, ackCalls, setPendingMessages } = makeFakeRelayHttp();
    setPendingMessages([{ uuid: 'uuid-pending-2', blob: 'ciphertext-4' }]);

    const delivered: DeliveredBlob[] = [];

    // Deliver via all three paths.
    openDeviceSse({ realtimeProvider: provider, sseUrl: 'https://relay.example/sse', onDelivered: (b) => delivered.push(b) });
    fireSseMessage(JSON.stringify({ uuid: 'uuid-sse-2', blob: 'x' }));

    openCardWebSocket({ realtimeProvider: provider, wsUrl: 'wss://relay.example/ws/uuid-ws-2', onDelivered: (b) => delivered.push(b) });
    fireWsMessage('wss://relay.example/ws/uuid-ws-2', JSON.stringify({ uuid: 'uuid-ws-2', blob: 'y' }));

    await fetchPending({ relayFetch, deviceCredential: 'device-cred-2' });

    expect(delivered.map((d) => d.uuid)).toEqual(expect.arrayContaining(['uuid-sse-2', 'uuid-ws-2']));
    // Critically: no ack call has happened yet, despite three deliveries.
    expect(ackCalls).toHaveLength(0);

    // Only an explicit ack() call reaches the relay's clearance path.
    await ack({ relayFetch, deviceCredential: 'device-cred-2', uuids: ['uuid-sse-2', 'uuid-ws-2', 'uuid-pending-2'] });
    expect(ackCalls).toEqual([['uuid-sse-2', 'uuid-ws-2', 'uuid-pending-2']]);
  });

  it('ack() is a no-op for an empty uuid list (does not call the relay)', async () => {
    const { relayFetch, ackCalls } = makeFakeRelayHttp();
    await ack({ relayFetch, deviceCredential: 'device-cred-3', uuids: [] });
    expect(ackCalls).toHaveLength(0);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it('WebSocket handle exposes no send method — outbound never transits the relay connection', () => {
    const { provider } = makeFakeRealtimeTransport();
    const handle = openCardWebSocket({
      realtimeProvider: provider,
      wsUrl: 'wss://relay.example/ws/uuid-ws-3',
      onDelivered: () => {},
    });
    expect('send' in handle).toBe(false);
    handle.close();
  });
});
