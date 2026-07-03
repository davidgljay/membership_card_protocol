import { DurableObject } from "cloudflare:workers";

// Phase 1.2 spike — plans/relay-serverless-migration-implementation-plan.md
//
// One Durable Object instance == one device-side WebSocket connection,
// addressed by UUID (relay.md §7.3's GET /ws/{uuid}, simplified for this
// spike — no Redis-backed UUID lifecycle here, just the connection shape).
//
// NOTE ON crossws: this spike talks to the Cloudflare Workers Hibernation
// API (`this.ctx.acceptWebSocket`, `this.ctx.getWebSockets`,
// `serializeAttachment`/`deserializeAttachment`) directly rather than going
// through `crossws`'s `cloudflare-durable` adapter. That adapter exists and
// is what Nitro's built-in `cloudflare-durable` preset uses internally, but
// two things made using it directly impractical for this spike and are
// worth recording:
//
//   1. The currently-published `crossws@0.4.8` (what a fresh
//      `npm install crossws` resolves to today) has DROPPED
//      "./adapters/cloudflare-durable" from its package.json `exports`
//      map entirely — the adapter's compiled files are still physically
//      present in the npm tarball but are no longer importable via the
//      package's public export surface. `nitropack@2.11+` (this repo's
//      pinned version, matching `press/package.json`) still depends on
//      the older `crossws@0.3.5`, which DOES export it — but that's a
//      transitive, nested copy (`nitropack/node_modules/crossws`), not
//      something a project should import from directly.
//   2. Nitro's own `cloudflare-durable` preset (see
//      spike-do-ws/README.md) hardcodes a single fixed DO instance name,
//      which doesn't fit our one-DO-per-UUID requirement anyway — so
//      reaching for the adapter Nitro itself uses wouldn't have solved
//      the actual problem this spike needs to solve.
//
// Both points are called out in the Phase 1 milestone summary as
// ecosystem rough edges to watch when Phase 2 builds the real
// DO-backed connection layer, consistent with how the implementation
// plan asked nitrojs/nitro#2436-adjacent issues to be surfaced rather
// than quietly worked around.
//
// PRIVACY INVARIANT: this class must never call `this.ctx.storage.put(...)`
// (or any other DO storage write). Durable Object storage is SQLite-backed,
// disk-resident, with point-in-time recovery on by default — the opposite
// of the RAM-only guarantee the relay's UUID<->device association model
// depends on (see strategic-plan.md "Why Durable Object storage is the
// wrong place for UUID associations"). Everything here is either a plain
// instance field (discarded whenever this JS context is torn down) or
// attached to the WebSocket itself via serializeAttachment — the
// hibernation-survival mechanism the Workers runtime provides — which is
// still RAM, never disk.

interface ConnectionAttachment {
  uuid: string;
}

export class UuidConnection extends DurableObject {
  // In-memory only. Reset to 0 whenever this DO instance's JS context is
  // (re)constructed — including after hibernation wakeup, which is exactly
  // the behavior we want: nothing here is meant to survive as "real" state
  // across a restart the way Redis-backed UUID status does.
  private deliveryCount = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("upgrade") === "websocket") {
      const uuid = url.searchParams.get("uuid") ?? "unknown";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // This is the Hibernation API entry point: acceptWebSocket (not
      // server.accept()) tells the runtime it may evict this DO's JS
      // context from memory while the socket is idle, and re-instantiate
      // it later when a message arrives — WITHOUT tearing down the
      // underlying WebSocket connection to the client. That's the whole
      // point relative to the plain `ws`/Node model: billable compute
      // stops accruing while idle, but the connection itself survives.
      this.ctx.acceptWebSocket(server);

      // serializeAttachment persists small (<=2KiB) JSON-serializable
      // state ON THE SOCKET ITSELF, which the runtime keeps across
      // hibernation. This is RAM/connection-scoped state managed by the
      // platform — not DO storage, not disk. It is how a rehydrated DO
      // instance (after hibernation wakeup) knows which uuid a given
      // socket belongs to without needing durable storage.
      server.serializeAttachment({ uuid } satisfies ConnectionAttachment);

      console.log(`[DO] Accepted WebSocket for uuid=${uuid} (hibernatable)`);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Non-WebSocket fetch = the "/deliver/{uuid}" simulation: an external
    // HTTP call routed to this specific DO instance, checking whether a
    // live WebSocket is attached and pushing a message into it if so.
    if (url.pathname === "/deliver") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) {
        return Response.json(
          { delivered: false, reason: "no_open_connection" },
          { status: 404 }
        );
      }
      this.deliveryCount += 1;
      const body = await request.text();
      for (const socket of sockets) {
        socket.send(`delivered:${body || "(empty)"}:count=${this.deliveryCount}`);
      }
      return Response.json({ delivered: true, count: this.deliveryCount });
    }

    if (url.pathname === "/status") {
      return Response.json({
        openSockets: this.ctx.getWebSockets().length,
        deliveryCount: this.deliveryCount,
      });
    }

    return new Response("not found", { status: 404 });
  }

  // Required by the Hibernation API: called for every message on any
  // WebSocket this DO has accepted via acceptWebSocket — including the
  // FIRST message after a hibernation wakeup, where `this` is a fresh
  // instance with deliveryCount reset to 0. We recover the uuid via
  // deserializeAttachment rather than any instance field, which is the
  // part of this API that actually makes hibernation transparent to
  // application code.
  async webSocketMessage(client: WebSocket, message: ArrayBuffer | string) {
    const attachment = client.deserializeAttachment() as
      | ConnectionAttachment
      | null;
    const uuid = attachment?.uuid ?? "unknown";
    const text = typeof message === "string" ? message : "(binary)";
    console.log(`[DO] Message for uuid=${uuid}: ${text}`);
    client.send(`echo:${text}`);
  }

  async webSocketClose(
    client: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ) {
    const attachment = client.deserializeAttachment() as
      | ConnectionAttachment
      | null;
    console.log(
      `[DO] Closed for uuid=${attachment?.uuid ?? "unknown"}: code=${code} reason=${reason} wasClean=${wasClean}`
    );
    client.close(code, reason);
  }

  async webSocketError(client: WebSocket, error: unknown) {
    console.error("[DO] WebSocket error", error);
  }
}
