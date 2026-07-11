import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, sendError } from "../utils/http.js";
import { getCredential, drainMessages, getUuid, enqueuePendingDelete } from "../utils/storage/redis.js";

const MAX_DELETE_DELAY_SECONDS = parseInt(process.env.MAX_DELETE_DELAY_SECONDS ?? "21600", 10);

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// GET /pending — returns all stored blobs for the authenticated device
export async function handlePending(
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
    console.error("Redis read failed during /pending auth:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to validate credential");
    return;
  }

  if (!credRecord) {
    sendError(res, 401, "INVALID_CREDENTIAL", "Device credential is unknown or has expired");
    return;
  }

  let messages;
  try {
    messages = await drainMessages(credential);
  } catch (err) {
    console.error("Redis read failed during /pending drain:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to retrieve messages");
    return;
  }

  sendJson(res, 200, {
    messages: messages.map(({ uuid, blob }) => ({ uuid, blob })),
  });
}

// POST /ack — schedules staggered wallet deletes for acknowledged UUIDs
export async function handleAck(
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
    console.error("Redis read failed during /ack auth:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to validate credential");
    return;
  }

  if (!credRecord) {
    sendError(res, 401, "INVALID_CREDENTIAL", "Device credential is unknown or has expired");
    return;
  }

  let body: { uuids?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { uuids?: unknown };
  } catch {
    sendError(res, 400, "MISSING_FIELD", "Request body must be valid JSON");
    return;
  }

  if (!Array.isArray(body.uuids) || body.uuids.length === 0) {
    sendError(res, 400, "MISSING_FIELD", "uuids must be a non-empty array");
    return;
  }

  const uuids = body.uuids as unknown[];
  const errors: string[] = [];

  for (const rawUuid of uuids) {
    if (typeof rawUuid !== "string") continue;

    let record;
    try {
      record = await getUuid(rawUuid);
    } catch (err) {
      console.error(`Redis read failed for UUID ${rawUuid} during /ack:`, err);
      errors.push(rawUuid);
      continue;
    }

    if (!record) {
      // UUID expired or already cleared — skip silently
      continue;
    }

    const delayMs = Math.floor(Math.random() * MAX_DELETE_DELAY_SECONDS * 1000);
    const executeAtMs = Date.now() + delayMs;

    try {
      await enqueuePendingDelete(
        { wallet_url: record.wallet_base_url, uuid: rawUuid, attempts: 0 },
        executeAtMs
      );
    } catch (err) {
      console.error(`Failed to enqueue delete for UUID ${rawUuid}:`, err);
      errors.push(rawUuid);
    }
  }

  if (errors.length > 0) {
    console.error("Partial /ack failure for UUIDs:", errors);
    // Return 200 anyway — partial failure is logged but not fatal.
    // Successfully enqueued deletes proceed; failed ones are benign (wallet retains until re-registration).
  }

  sendJson(res, 200, {});
}
