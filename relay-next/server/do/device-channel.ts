// Durable Object: one instance per device_credential, backing GET /sse
// (relay.md §7.4, relay_data_model.md §10). Same Hibernation-API pattern as
// UuidConnection (server/do/uuid-connection.ts) — see that file's module
// doc for the full rationale, which applies identically here except for
// the addressing key (device_credential instead of uuid) and the absence
// of any UUID state transition on teardown (relay.md §7.4 step 7: "there is
// nothing in Redis for this teardown to update").
//
// Implementation choice for the SSE contract itself: this class exposes a
// WebSocket-shaped connection internally (Hibernation only works with
// WebSocket, not a raw streamed Response, inside a Durable Object) and the
// stateless layer's GET /sse handler (server/api/sse.get.ts) translates
// that into genuine `text/event-stream` framing for the device — this is
// explicitly called out as an acceptable Phase 2 implementation choice in
// relay.md §7.4 ("either is compatible with this section's request/response
// contract, which is unchanged from v0.6"). The device-facing contract
// (Content-Type: text/event-stream, `data: {...}\n\n` framing, 30s
// heartbeat comments) is what relay.md §7.4 specifies and is what
// server/api/sse.get.ts must produce, regardless of the DO-internal
// transport.
//
// PRIVACY INVARIANT: same as uuid-connection.ts — never
// `this.ctx.storage.*`; only in-memory fields / serializeAttachment.

import { DurableObject } from 'cloudflare:workers';

interface ChannelAttachment {
  device_credential: string;
}

export interface DeliverMessage {
  uuid: string;
  blob: string;
}

export class DeviceChannel extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('upgrade') === 'websocket') {
      const credential = url.searchParams.get('device_credential');
      if (!credential) {
        return new Response('missing device_credential', { status: 400 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        device_credential: credential,
      } satisfies ChannelAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal call from /deliver/{uuid} (relay_data_model.md §10.3,
    // relay.md §7.4 step 6): "does this device_credential's DO currently
    // hold an open connection?"
    if (url.pathname === '/internal/deliver' && request.method === 'POST') {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) {
        return Response.json({ delivered: false }, { status: 404 });
      }
      const message = (await request.json()) as DeliverMessage;
      const payload = JSON.stringify({ uuid: message.uuid, blob: message.blob });
      for (const socket of sockets) {
        socket.send(payload);
      }
      return Response.json({ delivered: true });
    }

    if (url.pathname === '/internal/status') {
      return Response.json({ openConnections: this.ctx.getWebSockets().length });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(client: WebSocket, message: ArrayBuffer | string) {
    // Heartbeat pings from the translating SSE layer, if any, are the only
    // expected inbound traffic; nothing else is meaningful on this
    // device-level channel. No-op, documented explicitly (see
    // uuid-connection.ts's identical note).
    void client;
    void message;
  }

  async webSocketClose(client: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    // relay.md §7.4 step 7: no UUID/Redis state transition on close — this
    // channel is not tied to any single UUID's lifecycle. Just tear down.
    client.close(code, 'closing');
  }

  async webSocketError(_client: WebSocket, _error: unknown) {
    // Nothing to reconcile in Redis for this channel type (see above).
  }
}
