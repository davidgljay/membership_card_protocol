import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody, sendError } from "../utils/http.js";
import { getObliviousTarget } from "../utils/oblivious_targets.js";

export async function handleOhttpForward(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const targetId = params["target_id"];
  if (!targetId) {
    sendError(res, 404, "NOT_FOUND", "target_id is required");
    return;
  }

  const target = getObliviousTarget(targetId);
  if (!target) {
    sendError(res, 404, "NOT_FOUND", `Unknown target_id: ${targetId}`);
    return;
  }

  const body = await readRawBody(req);
  const contentType = req.headers["content-type"] ?? "application/octet-stream";

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target.ohttp_gateway_url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: body.length > 0 ? new Uint8Array(body) : undefined,
    });
  } catch (err) {
    console.error(`Oblivious-forwarding fetch failed for target_id ${targetId}:`, err);
    sendError(res, 502, "GATEWAY_UNREACHABLE", "Destination gateway unreachable");
    return;
  }

  const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const upstreamContentType = upstreamResponse.headers.get("content-type");
  const headers: Record<string, string> = {};
  if (upstreamContentType) headers["content-type"] = upstreamContentType;

  res.writeHead(upstreamResponse.status, headers);
  res.end(upstreamBody);
}
