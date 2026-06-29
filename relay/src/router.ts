import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRegister } from "./routes/register.js";
import { handleDeliver } from "./routes/deliver.js";
import { handleHealth } from "./routes/health.js";
import { handleSSE } from "./routes/sse.js";
import { handlePending, handleAck } from "./routes/pending.js";
import { sendJson } from "./utils/http.js";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function handleNotifyDeprecated(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>
): void {
  res.setHeader("Location", "/deliver/" + (_params["uuid"] ?? ""));
  sendJson(res, 410, {
    error: "ENDPOINT_DEPRECATED",
    message: "POST /notify/{uuid} has been replaced by POST /deliver/{uuid}",
  });
}

const routes: Route[] = [
  { method: "POST", pattern: /^\/register$/, paramNames: [], handler: handleRegister },
  { method: "POST", pattern: /^\/deliver\/([^/]+)$/, paramNames: ["uuid"], handler: handleDeliver },
  { method: "GET",  pattern: /^\/ws\/([^/]+)$/, paramNames: ["uuid"], handler: handleWs },
  { method: "GET",  pattern: /^\/sse$/, paramNames: [], handler: handleSSE },
  { method: "GET",  pattern: /^\/pending$/, paramNames: [], handler: handlePending },
  { method: "POST", pattern: /^\/ack$/, paramNames: [], handler: handleAck },
  { method: "GET",  pattern: /^\/health$/, paramNames: [], handler: handleHealth },
  // Deprecated — kept for one version; returns 410
  { method: "POST", pattern: /^\/notify\/([^/]+)$/, paramNames: ["uuid"], handler: handleNotifyDeprecated },
];

// WebSocket upgrade is handled in server.ts before the HTTP router is reached.
// This stub exists only so the route table is complete for documentation purposes.
function handleWs(_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): void {
  sendJson(res, 426, { error: "UPGRADE_REQUIRED", message: "This endpoint requires a WebSocket upgrade" });
}

export function router(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? "";
    });

    Promise.resolve(route.handler(req, res, params)).catch((err: unknown) => {
      console.error("Unhandled route error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: "Unexpected error" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "NOT_FOUND", message: "Route not found" }));
}
