import type { RealtimeTransportProvider } from '@membership-card-protocol/client-sdk';

/**
 * Default web `RealtimeTransportProvider` (OQ-SDK-3): native `EventSource`
 * for SSE, native `WebSocket` for active-chat sessions.
 */
export class WebRealtimeTransportProvider implements RealtimeTransportProvider {
  subscribeSSE(
    url: string,
    onMessage: (data: string) => void,
    onError: (error: unknown) => void
  ): () => void {
    const source = new EventSource(url);
    const messageHandler = (event: MessageEvent) => onMessage(event.data as string);
    const errorHandler = (event: Event) => onError(event);
    source.addEventListener('message', messageHandler);
    source.addEventListener('error', errorHandler);
    return () => {
      source.removeEventListener('message', messageHandler);
      source.removeEventListener('error', errorHandler);
      source.close();
    };
  }

  connectWebSocket(url: string): ReturnType<RealtimeTransportProvider['connectWebSocket']> {
    const socket = new WebSocket(url);
    return {
      send(data: string | Uint8Array) {
        socket.send(data);
      },
      close() {
        socket.close();
      },
      onMessage(handler: (data: string | Uint8Array) => void) {
        socket.addEventListener('message', (event: MessageEvent) => {
          handler(event.data as string | Uint8Array);
        });
      },
      onClose(handler: (code: number, reason: string) => void) {
        socket.addEventListener('close', (event: CloseEvent) => {
          handler(event.code, event.reason);
        });
      },
      onError(handler: (error: unknown) => void) {
        socket.addEventListener('error', (event: Event) => {
          handler(event);
        });
      },
    };
  }
}
