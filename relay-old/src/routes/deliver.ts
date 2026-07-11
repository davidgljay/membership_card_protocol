import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidUuidV4, readBody, sendJson, sendError } from "../utils/http.js";
import { getUuid, transitionUuid, storeMessage } from "../utils/storage/redis.js";
import { getApp } from "../utils/apps.js";
import { dispatchPush } from "../utils/push/dispatch.js";
import { getSSEConnection } from "../utils/sse_connections.js";
import { getWsConnection } from "../utils/ws_connections.js";

interface DeliverBody {
  blob?: unknown;
}

export async function handleDeliver(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const { uuid } = params;

  if (!isValidUuidV4(uuid)) {
    sendError(res, 400, "INVALID_UUID", "Path parameter is not a valid UUID v4");
    return;
  }

  let body: DeliverBody;
  try {
    body = JSON.parse(await readBody(req)) as DeliverBody;
  } catch {
    sendError(res, 400, "MISSING_FIELD", "Request body must be valid JSON");
    return;
  }

  if (!body.blob || typeof body.blob !== "string") {
    sendError(res, 400, "MISSING_FIELD", "blob is required");
    return;
  }
  const blob = body.blob;

  let record;
  try {
    record = await getUuid(uuid);
  } catch (err) {
    console.error("Redis read failed in /deliver:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to read UUID record");
    return;
  }

  if (!record) {
    sendError(res, 404, "UNKNOWN_UUID", "UUID not found");
    return;
  }

  // Only accept delivery for unused UUIDs. Note: an "active" UUID is one
  // currently open as a GET /ws/{uuid} delivery channel for a *different*
  // future delivery — it is never itself a valid /deliver target (the device
  // pool allocates distinct UUIDs to WS-opening vs. message delivery; see
  // process_specs/notification_relay.md §UUID Pools). So "active" here
  // correctly falls through to the generic 410 below, same as "consumed" or
  // "in_flight".
  if (record.status !== "unused") {
    sendError(res, 410, "UUID_CONSUMED", "UUID has already been used or is in use");
    return;
  }

  // Atomically lock the UUID before storing the blob
  let transition;
  try {
    transition = await transitionUuid(uuid, "unused", "in_flight");
  } catch (err) {
    console.error("Redis transition failed in /deliver:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to transition UUID state");
    return;
  }

  if (!transition.ok) {
    sendError(res, 410, "UUID_CONSUMED", "UUID has already been used or is in use");
    return;
  }

  const app = getApp(record.app_id);
  if (!app) {
    await transitionUuid(uuid, "in_flight", "unused").catch((e) =>
      console.error("Failed to roll back UUID after missing app config:", e)
    );
    sendError(res, 500, "INTERNAL_ERROR", "App config not found for this UUID");
    return;
  }

  // Store the blob in the message store keyed by device_credential
  const ttl = parseInt(process.env.UUID_TTL_SECONDS ?? "2592000", 10);
  try {
    await storeMessage(record.device_credential, {
      uuid,
      blob,
      wallet_url: record.wallet_base_url,
      received_at: new Date().toISOString(),
    }, ttl);
  } catch (err) {
    console.error("Failed to store message blob:", err);
    await transitionUuid(uuid, "in_flight", "unused").catch((e) =>
      console.error("Failed to roll back UUID after store failure:", e)
    );
    sendError(res, 500, "INTERNAL_ERROR", "Failed to store message");
    return;
  }

  // UUID is consumed — blob is safely stored
  await transitionUuid(uuid, "in_flight", "consumed").catch((e) =>
    console.error("Failed to mark UUID consumed after blob store:", e)
  );

  // Attempt immediate delivery via SSE (highest priority)
  const sseConn = getSSEConnection(record.device_credential);
  if (sseConn) {
    try {
      sseConn.write(`data: ${JSON.stringify({ uuid, blob })}\n\n`);
      // Blob remains in store until /ack is received
      sendJson(res, 200, {});
      return;
    } catch (err) {
      console.error("SSE write failed, falling through to WebSocket/push:", err);
      // Fall through to WebSocket, then push dispatch
    }
  }

  // No SSE — try the device's active chat WebSocket, if any (relay.md §1
  // priority order: SSE, then WebSocket, then push). Keyed by
  // device_credential, same as SSE — see ws_connections.ts.
  const wsConn = getWsConnection(record.device_credential);
  if (wsConn && wsConn.readyState === 1 /* OPEN */) {
    try {
      wsConn.send(JSON.stringify({ uuid, blob }));
      // Blob remains in store until /ack is received, same as SSE delivery
      sendJson(res, 200, {});
      return;
    } catch (err) {
      console.error("WebSocket write failed, falling through to push:", err);
      // Fall through to push dispatch
    }
  }

  // Fall back to silent push
  try {
    await dispatchPush(record.push_token, uuid, app);
  } catch (err) {
    console.error("Push dispatch failed after blob stored:", err);
    // Blob is stored — device will pick it up via GET /pending on next wake.
    // Do not fail the request; the wallet has been relieved of delivery responsibility.
  }

  sendJson(res, 200, {});
}
