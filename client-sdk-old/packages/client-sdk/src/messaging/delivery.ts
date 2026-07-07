import type { RealtimeTransportProvider } from '../providers/RealtimeTransportProvider.js';

/**
 * Realtime delivery (Step 5.5): device-level SSE (`notification_relay.md
 * §Process 4`), per-card WebSocket for active chat (`§Process 3`), and
 * silent-push-triggered `GET /pending` catch-up (`§Process 5`) — all three
 * paths converge on the same `POST /ack` acknowledgment step (`§Process
 * 6`, `relay.md §7.6`), which is the **only** thing that triggers the
 * relay's staggered wallet-clearance.
 *
 * **The central invariant this module enforces structurally:** a `POST
 * /deliver` 200-equivalent (i.e., the relay having successfully accepted
 * and forwarded a blob to this device over SSE or WebSocket) is never
 * treated as equivalent to "acked." `message_routing.md`'s "Wallet
 * services must not clear messages based solely on relay delivery"
 * instruction is a wallet-service-side rule, but the device-side mirror of
 * it is just as real: this module's `onDelivered` callbacks (SSE message
 * received, WebSocket message received) never themselves call `ack` — the
 * caller must explicitly acknowledge after successfully processing
 * (decrypting, verifying, persisting) each message. There is no code path
 * in this module from "blob arrived" to "wallet clearance triggered" that
 * skips the caller's own explicit `ack()` call.
 */

export interface DeliveredBlob {
  uuid: string;
  /** base64url-encoded, still ML-KEM-encrypted `RoutingEnvelope.payload` — this module never decrypts; that's Step 5.2's job. */
  blob: string;
}

// ─── Process 4: device-level SSE (foregrounded, not in active chat) ───────

export interface SseConnectionOptions {
  realtimeProvider: RealtimeTransportProvider;
  /** The relay's `GET /sse` endpoint, including the `Authorization: Bearer {device_credential}` the caller has already attached as a query param or the provider's own header-injection mechanism. */
  sseUrl: string;
  onDelivered: (blob: DeliveredBlob) => void;
  onError?: (error: unknown) => void;
}

export interface SseConnectionHandle {
  /** Close the SSE connection (e.g. app backgrounding — `§Process 4` step 8). */
  close: () => void;
}

interface SseDeliveryEvent {
  uuid: string;
  blob: string;
}

/**
 * Opens a device-level SSE subscription. Each event
 * (`data: {"uuid":"<uuid>","blob":"<base64url>"}`, `relay.md §7.4`)
 * invokes `onDelivered` — the caller decrypts/verifies/persists and then
 * separately calls {@link ack} once satisfied, per this module's central
 * invariant.
 */
export function openDeviceSse(options: SseConnectionOptions): SseConnectionHandle {
  const close = options.realtimeProvider.subscribeSSE(
    options.sseUrl,
    (data) => {
      let event: SseDeliveryEvent;
      try {
        event = JSON.parse(data) as SseDeliveryEvent;
      } catch {
        // Malformed event (e.g. a heartbeat comment leaking through, or a
        // relay bug) — not a message; drop silently rather than treat as
        // a delivery.
        return;
      }
      if (typeof event.uuid !== 'string' || typeof event.blob !== 'string') {
        return;
      }
      options.onDelivered({ uuid: event.uuid, blob: event.blob });
    },
    options.onError ?? (() => {})
  );
  return { close };
}

// ─── Process 3: per-card WebSocket (active chat) ───────────────────────────

export interface WebSocketSessionOptions {
  realtimeProvider: RealtimeTransportProvider;
  /** `wss://relay.example/ws/{uuid}` — the next unused WebSocket UUID from this card's local pool, already selected and removed by the caller (`§Process 3` step 1). */
  wsUrl: string;
  onDelivered: (blob: DeliveredBlob) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: unknown) => void;
}

export interface WebSocketSessionHandle {
  /** Close the session (e.g. chat session ends or app backgrounds — `§Process 3` step 10). */
  close: () => void;
}

/**
 * Opens a per-card WebSocket delivery channel for active chat. **Inbound
 * only** — per `relay.md §7.3`, outbound (device → wallet) messages never
 * transit this connection; the caller sends those directly to the wallet
 * service's own HTTPS endpoint via a completely separate code path (this
 * module has no outbound-send API for that reason — {@link
 * WebSocketSessionHandle} exposes only `close`, not `send`, since
 * `relay.md` explicitly states "any frames sent by the device over this
 * WebSocket connection are ignored by the relay").
 */
export function openCardWebSocket(options: WebSocketSessionOptions): WebSocketSessionHandle {
  const connection = options.realtimeProvider.connectWebSocket(options.wsUrl);

  connection.onMessage((data) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    let event: SseDeliveryEvent;
    try {
      event = JSON.parse(text) as SseDeliveryEvent;
    } catch {
      return;
    }
    if (typeof event.uuid !== 'string' || typeof event.blob !== 'string') {
      return;
    }
    options.onDelivered({ uuid: event.uuid, blob: event.blob });
  });

  if (options.onClose) {
    connection.onClose(options.onClose);
  }
  if (options.onError) {
    connection.onError(options.onError);
  }

  return { close: () => connection.close() };
}

// ─── Process 5: catch-up via GET /pending ──────────────────────────────────

export interface FetchPendingOptions {
  /** Injected HTTP client for the relay's plain HTTPS API — the relay is not a wallet-service/press destination, so this is not `ObliviousProtocolTransport`. */
  relayFetch: (
    path: string,
    init: { method: string; headers?: Record<string, string> }
  ) => Promise<{ status: number; json: () => Promise<unknown> }>;
  deviceCredential: string;
}

interface PendingResponseBody {
  messages: DeliveredBlob[];
}

/**
 * `GET /pending` (`relay.md §7.5`, `notification_relay.md §Process 5`):
 * called on wake (silent push, app launch, or coming back online).
 * Returns every blob the relay was holding for this device, already
 * atomically cleared from the relay's own store on the relay's side — but
 * that is the *relay's* bookkeeping, not wallet clearance; the caller must
 * still {@link ack} each returned UUID once processed, exactly as for
 * SSE/WebSocket delivery, so the *wallet service's* copies are cleared
 * too (`§Process 6`).
 */
export async function fetchPending(options: FetchPendingOptions): Promise<DeliveredBlob[]> {
  const response = await options.relayFetch('/pending', {
    method: 'GET',
    headers: { authorization: `Bearer ${options.deviceCredential}` },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`fetchPending: GET /pending returned status ${response.status}`);
  }
  const body = (await response.json()) as PendingResponseBody;
  return body.messages;
}

// ─── Process 6: explicit acknowledgment (the only path to wallet clearance) ─

export interface AckOptions {
  relayFetch: (
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{ status: number }>;
  deviceCredential: string;
  uuids: string[];
}

/**
 * `POST /ack` (`relay.md §7.6`, `notification_relay.md §Process 6`) — the
 * **only** call in this module that triggers the relay's staggered
 * wallet-clearance. Callers must invoke this only after a delivered blob
 * has been successfully decrypted, verified, and persisted locally
 * (Step 5.2's `handleInboundRoutingEnvelope`) — never merely because a
 * blob arrived. This module provides no automatic/implicit ack path from
 * any delivery function above; every one of `openDeviceSse`,
 * `openCardWebSocket`, and `fetchPending` returns control to the caller
 * without ever calling this function itself.
 */
export async function ack(options: AckOptions): Promise<void> {
  if (options.uuids.length === 0) {
    return;
  }
  const response = await options.relayFetch('/ack', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ uuids: options.uuids }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ack: POST /ack returned status ${response.status}`);
  }
}
