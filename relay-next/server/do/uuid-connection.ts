// Durable Object: one instance per UUID, backing GET /ws/{uuid}
// (relay.md §7.3, relay_data_model.md §10). Directly follows the proven
// pattern from relay-next/spike-do-ws/durable-object.ts — raw Hibernation
// API (`acceptWebSocket`/`getWebSockets`/serializeAttachment), NOT Nitro's
// `cloudflare-durable` preset (single fixed instance, can't address by
// UUID) or crossws's adapter (export path dropped in the installed
// version) — see spike-do-ws/README.md for the full rationale, unchanged
// here.
//
// AUTHORITY SPLIT (relay_data_model.md §10.1, §10.2): this class never
// holds a Redis client and never calls Redis. All Redis reads/writes for
// the unused -> active and active -> consumed transitions happen in the
// stateless Nitro HTTP-handler layer (server/api/ws/[uuid].get.ts for
// opening, this class's webSocketClose calling back via fetch() for
// closing). This is not an oversight — see §10.2's two reasons
// (portability of the stateless layer; keeping the DO's own concurrency
// model simple) and do not "fix" this by importing a Redis client here.
//
// PRIVACY INVARIANT (relay_data_model.md §10.4): this class must never call
// `this.ctx.storage.*` (SQLite-backed, disk-resident, point-in-time
// recovery on by default). All state here is either a plain in-memory
// instance field or WebSocket.serializeAttachment/deserializeAttachment —
// both RAM-only, never written to disk by the platform.

import { DurableObject } from 'cloudflare:workers';

interface ConnectionAttachment {
  uuid: string;
}

export interface DeliverMessage {
  uuid: string;
  blob: string;
}

export class UuidConnection extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('upgrade') === 'websocket') {
      const uuid = url.searchParams.get('uuid');
      if (!uuid) {
        return new Response('missing uuid', { status: 400 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Hibernation API entry point — see module doc.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ uuid } satisfies ConnectionAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal call from the stateless /deliver/{uuid} handler
    // (relay_data_model.md §10.3 "Delivering a message" step 2): "does this
    // DO currently hold an open connection, and if so, deliver into it."
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

  // No webSocketMessage handler needed beyond ignoring device frames — this
  // is an inbound-only delivery channel (relay.md §7.3: "Any frames sent by
  // the device over this WebSocket connection are ignored by the relay").
  async webSocketMessage(_client: WebSocket, _message: ArrayBuffer | string) {
    // Intentionally a no-op. Documented explicitly (rather than omitted)
    // so a future reader doesn't mistake the absence of a handler for an
    // oversight — relay.md §7.3 is explicit that inbound device frames on
    // this channel are ignored.
  }

  // Session teardown (relay.md §7.3, relay_data_model.md §10.3 "Closing a
  // connection"): request the Redis active -> consumed transition via the
  // stateless layer's internal endpoint. This DO does NOT write to Redis
  // itself (§10.2). If this handler never runs (DO evicted uncleanly), the
  // UUID is left `active` until the periodic reconciliation scan catches it
  // — a bounded-staleness window, not a correctness violation (§10.3 step 3).
  async webSocketClose(
    client: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    const attachment = client.deserializeAttachment() as ConnectionAttachment | null;
    const uuid = attachment?.uuid;
    client.close(code, 'closing');
    if (uuid) {
      await this.notifyClosed(uuid);
    }
  }

  async webSocketError(client: WebSocket, _error: unknown) {
    const attachment = client.deserializeAttachment() as ConnectionAttachment | null;
    const uuid = attachment?.uuid;
    if (uuid) {
      await this.notifyClosed(uuid);
    }
  }

  private async notifyClosed(uuid: string): Promise<void> {
    // env.RELAY_ORIGIN is a plain string binding/var pointing back at this
    // same Worker's own origin, so the DO can call the stateless layer's
    // internal teardown endpoint via ordinary fetch() (relay_data_model.md
    // §10.2 point 1 — DOs reach the stateless layer via fetch(), not a
    // shared in-process call, precisely so the stateless layer's Redis
    // access stays out of DO code).
    const env = this.env as { RELAY_ORIGIN?: string; INTERNAL_API_SECRET?: string };
    if (!env.RELAY_ORIGIN) {
      // No origin configured (e.g. isolated unit test of this class) —
      // nothing to call back into. The reconciliation scan remains the
      // backstop regardless (§10.3 step 3).
      return;
    }
    try {
      await fetch(`${env.RELAY_ORIGIN}/internal/ws-closed/${uuid}`, {
        method: 'POST',
        headers: env.INTERNAL_API_SECRET
          ? { 'x-internal-secret': env.INTERNAL_API_SECRET }
          : {},
      });
    } catch {
      // Best-effort. If this fetch fails, the UUID stays `active` in Redis
      // until the reconciliation scan resolves it — the same bounded-
      // staleness case §10.3 step 3 already describes for a DO eviction
      // that never runs webSocketClose at all. Not re-thrown: there is no
      // caller here that could usefully react to it (this runs inside the
      // DO's own close-handler teardown, not a request/response cycle).
    }
  }
}
