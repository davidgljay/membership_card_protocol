/**
 * Injected realtime-delivery transport abstraction (OQ-SDK-3).
 *
 * Covers both of the relay's realtime channels — SSE for foreground device
 * delivery (`notification_relay.md §Process 4`) and per-card WebSocket
 * sessions for active chat (`§Process 3`) — behind one interface, so
 * `notification_relay.md`'s delivery-path logic (Phase 5) doesn't branch on
 * platform.
 *
 * Default implementations: native `EventSource` + `WebSocket` on web
 * (`@membership-card-protocol/client-sdk-web`); native `WebSocket` plus a
 * shipped SSE implementation (e.g. `react-native-sse` or an equivalent
 * fetch-streaming polyfill) on React Native
 * (`@membership-card-protocol/client-sdk-rn`) — RN does not fall back to
 * `GET /pending` polling as its primary foreground mechanism.
 */
export interface RealtimeTransportProvider {
  /**
   * Open an SSE subscription.
   *
   * @param url - The relay's SSE endpoint, including any auth query
   *   parameters the caller has already attached.
   * @param onMessage - Invoked once per received SSE event.
   * @param onError - Invoked on connection error (the provider is
   *   responsible for its own reconnect behavior; this is a notification,
   *   not a request to reconnect).
   * @returns An unsubscribe function that closes the connection.
   */
  subscribeSSE(
    url: string,
    onMessage: (data: string) => void,
    onError: (error: unknown) => void
  ): () => void;

  /**
   * Open a WebSocket connection.
   *
   * @param url - The relay's WebSocket endpoint.
   * @returns A handle exposing send/close and the three standard WebSocket
   *   event callbacks, kept minimal and transport-agnostic rather than
   *   exposing the platform `WebSocket` object directly.
   */
  connectWebSocket(url: string): {
    send(data: string | Uint8Array): void;
    close(): void;
    onMessage(handler: (data: string | Uint8Array) => void): void;
    onClose(handler: (code: number, reason: string) => void): void;
    onError(handler: (error: unknown) => void): void;
  };
}
