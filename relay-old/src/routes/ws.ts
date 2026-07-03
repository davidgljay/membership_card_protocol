import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { isValidUuidV4 } from "../utils/http.js";
import { getUuid, transitionUuid } from "../utils/storage/redis.js";

// Close codes defined in relay.md §6.3
const WS_CLOSE = {
  INVALID_UUID: 4000,
  WALLET_REJECTED: 4002,
  UNKNOWN_UUID: 4004,
  UUID_CONSUMED: 4010,
  GOING_AWAY: 1001,
  INTERNAL_ERROR: 1011,
} as const;

// Map from device socket to wallet socket for cleanup
const activePeers = new Map<WebSocket, WebSocket>();

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

  // Step 5: open outbound WebSocket to wallet service
  const walletUrl = `${record.wallet_ws_url}/${uuid}`;
  const walletSocket = new WebSocket(walletUrl);

  activePeers.set(deviceSocket, walletSocket);

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
    activePeers.delete(deviceSocket);
  };

  const teardown = (initiator: "device" | "wallet") => {
    const other = initiator === "device" ? walletSocket : deviceSocket;
    if (other.readyState === WebSocket.OPEN) {
      other.close(WS_CLOSE.GOING_AWAY, "Other side disconnected");
    }
    consumeUuid();
  };

  let bridgeEstablished = false;

  walletSocket.on("open", () => {
    // Step 6: bridge is established — wire up message forwarding
    bridgeEstablished = true;

    deviceSocket.on("message", (data, isBinary) => {
      if (walletSocket.readyState === WebSocket.OPEN) {
        walletSocket.send(data, { binary: isBinary });
      }
    });

    walletSocket.on("message", (data, isBinary) => {
      if (deviceSocket.readyState === WebSocket.OPEN) {
        deviceSocket.send(data, { binary: isBinary });
      }
    });
  });

  walletSocket.on("error", (err) => {
    if (!bridgeEstablished) {
      // Wallet connection failed before the bridge opened — tell device the wallet rejected
      console.warn("Wallet connection failed before bridge established:", err.message);
      deviceSocket.close(WS_CLOSE.WALLET_REJECTED, "Wallet service connection failed");
    } else {
      console.error("Wallet socket error:", err);
    }
  });

  walletSocket.on("close", () => {
    teardown("wallet");
  });

  deviceSocket.on("error", (err) => {
    console.error("Device socket error:", err);
    teardown("device");
  });

  deviceSocket.on("close", () => {
    teardown("device");
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
