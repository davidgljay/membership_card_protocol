import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { isValidUuidV4 } from "../utils/http.js";
import { getUuid, transitionUuid } from "../utils/storage/redis.js";
import { registerWsConnection, removeWsConnection } from "../utils/ws_connections.js";

// Close codes defined in relay.md §7.3
const WS_CLOSE = {
  INVALID_UUID: 4000,
  UNKNOWN_UUID: 4004,
  UUID_CONSUMED: 4010,
  GOING_AWAY: 1001,
  INTERNAL_ERROR: 1011,
} as const;

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (deviceSocket: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  const uuid = match?.[1] ?? "";

  // Step 1: validate UUID format
  if (!isValidUuidV4(uuid)) {
    deviceSocket.close(WS_CLOSE.INVALID_UUID, "Invalid UUID format");
    return;
  }

  // Step 2: look up UUID
  let record;
  try {
    record = await getUuid(uuid);
  } catch (err) {
    console.error("Redis read failed in /ws:", err);
    deviceSocket.close(WS_CLOSE.INTERNAL_ERROR, "Internal error");
    return;
  }

  if (!record) {
    deviceSocket.close(WS_CLOSE.UNKNOWN_UUID, "Unknown UUID");
    return;
  }

  // Step 3: check status
  if (record.status !== "unused") {
    deviceSocket.close(WS_CLOSE.UUID_CONSUMED, "UUID already used");
    return;
  }

  // Step 4: transition unused → active
  let transition;
  try {
    transition = await transitionUuid(uuid, "unused", "active");
  } catch (err) {
    console.error("Redis transition failed in /ws:", err);
    deviceSocket.close(WS_CLOSE.INTERNAL_ERROR, "Internal error");
    return;
  }

  if (!transition.ok) {
    deviceSocket.close(WS_CLOSE.UUID_CONSUMED, "UUID already used");
    return;
  }

  // Step 5: register device WebSocket, keyed by device_credential (not the
  // UUID) — see ws_connections.ts for why: this is the device-level delivery
  // channel POST /deliver/{uuid} looks up for a *different* UUID's blob.
  registerWsConnection(record.device_credential, deviceSocket);

  let tornDown = false;
  const consumeUuid = async () => {
    if (tornDown) return;
    tornDown = true;
    const result = await transitionUuid(uuid, "active", "consumed").catch((e) => {
      console.error("Failed to consume UUID on WS teardown:", e);
      return { ok: false as const, reason: "NOT_FOUND" as const };
    });
    if (!result.ok && result.reason === "WRONG_STATUS") {
      console.warn(`Unexpected UUID status on WS teardown: ${result.currentStatus}`);
    }
    // NOT_FOUND is benign (UUID expired via TTL or Redis was reset)
    removeWsConnection(record.device_credential);
  };

  // Step 6: set up message handler to discard incoming frames (delivery-only)
  deviceSocket.on("message", () => {
    // Frames from device are ignored per relay.md §7.3:
    // "Any frames sent by the device over this WebSocket connection are
    // ignored by the relay (the connection is delivery-only)."
  });

  deviceSocket.on("error", (err) => {
    console.error("Device socket error:", err);
    consumeUuid();
  });

  deviceSocket.on("close", () => {
    consumeUuid();
  });
});

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.match(/^\/ws\/[^/]+$/)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}
