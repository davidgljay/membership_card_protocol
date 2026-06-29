import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRegister } from "./routes/register.js";
import { handleNotify } from "./routes/notify.js";
import { handleHealth } from "./routes/health.js";

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

const routes: Route[] = [
  { method: "POST", pattern: /^\/register$/, paramNames: [], handler: handleRegister },
  { method: "POST", pattern: /^\/notify\/([^/]+)$/, paramNames: ["uuid"], handler: handleNotify },
  { method: "GET", pattern: /^\/health$/, paramNames: [], handler: handleHealth },
];

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
