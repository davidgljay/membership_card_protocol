import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "../utils/http.js";
import { getCredential } from "../utils/storage/redis.js";
import { registerSSEConnection, removeSSEConnection } from "../utils/sse_connections.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>
): Promise<void> {
  const credential = extractBearerToken(req);

  if (!credential) {
    sendError(res, 401, "MISSING_CREDENTIAL", "Authorization header with Bearer token is required");
    return;
  }

  let credRecord;
  try {
    credRecord = await getCredential(credential);
  } catch (err) {
    console.error("Redis read failed during SSE auth:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to validate credential");
    return;
  }

  if (!credRecord) {
    sendError(res, 401, "INVALID_CREDENTIAL", "Device credential is unknown or has expired");
    return;
  }

  // Establish SSE stream
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering if present
  });
  res.flushHeaders();

  registerSSEConnection(credential, res);

  // Heartbeat to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    if (res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    res.write(":\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    removeSSEConnection(credential);
  };

  req.on("close", cleanup);
  req.on("error", (err) => {
    console.error("SSE connection error:", err);
    cleanup();
  });
  res.on("error", (err) => {
    console.error("SSE response error:", err);
    cleanup();
  });
}
