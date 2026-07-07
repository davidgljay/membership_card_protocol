import RNEventSource from 'react-native-sse';
import type { RealtimeTransportProvider } from '@membership-card-protocol/app-sdk';

/**
 * Typed structurally rather than against DOM's WebSocket (or @types/node's
 * undici equivalent) — this package's compiled output is consumed inside a
 * real RN app, where the ambient `WebSocket` type comes from React
 * Native's own globals.d.ts, which shapes its events differently from
 * either of those.
 */
interface WebSocketHandle {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', handler: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
}

/**
 * Default React Native `RealtimeTransportProvider` (OQ-SDK-3): native
 * `WebSocket` for active-chat sessions, and a shipped `react-native-sse`
 * implementation for SSE — RN has no native `EventSource`, and
 * `react-native-sse`'s fetch-streaming-based implementation keeps
 * foreground message delivery as timely as web's native `EventSource`,
 * rather than falling back to `GET /pending` polling as RN's primary
 * foreground mechanism.
 */
export class RNRealtimeTransportProvider implements RealtimeTransportProvider {
  subscribeSSE(
    url: string,
    onMessage: (data: string) => void,
    onError: (error: unknown) => void
  ): () => void {
    const source = new RNEventSource(url);
    const messageHandler = (event: { data: string | null }) => {
      if (event.data !== null) onMessage(event.data);
    };
    const errorHandler = (event: unknown) => onError(event);
    source.addEventListener('message', messageHandler);
    source.addEventListener('error', errorHandler);
    return () => {
      source.removeEventListener('message', messageHandler);
      source.removeEventListener('error', errorHandler);
      source.close();
    };
  }

  connectWebSocket(url: string): ReturnType<RealtimeTransportProvider['connectWebSocket']> {
    const socket = new WebSocket(url) as unknown as WebSocketHandle;

    return {
      send(data: string | Uint8Array) {
        socket.send(data);
      },
      close() {
        socket.close();
      },
      onMessage(handler: (data: string | Uint8Array) => void) {
        socket.addEventListener('message', (event) => {
          handler(event.data as string | Uint8Array);
        });
      },
      onClose(handler: (code: number, reason: string) => void) {
        socket.addEventListener('close', (event) => {
          handler(event.code ?? 0, event.reason ?? '');
        });
      },
      onError(handler: (error: unknown) => void) {
        socket.addEventListener('error', (event) => {
          handler(event);
        });
      },
    };
  }
}
