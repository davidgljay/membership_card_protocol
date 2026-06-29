import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, sendError } from "../utils/http.js";
import { getApp } from "../utils/apps.js";
import { setUuid, setCredential, getCredential, refreshCredential } from "../utils/storage/redis.js";
import { upsertDevice } from "../utils/storage/sqlite.js";
import type { UuidRecord } from "../utils/storage/redis.js";

interface RegisterBody {
  app_id?: unknown;
  push_token?: unknown;
  count?: unknown;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>
): Promise<void> {
  let body: RegisterBody;
  try {
    body = JSON.parse(await readBody(req)) as RegisterBody;
  } catch {
    sendError(res, 400, "MISSING_FIELD", "Request body must be valid JSON");
    return;
  }

  const { app_id, push_token, count: rawCount } = body;

  if (!app_id || typeof app_id !== "string") {
    sendError(res, 400, "MISSING_FIELD", "app_id is required");
    return;
  }
  if (!push_token || typeof push_token !== "string") {
    sendError(res, 400, "MISSING_FIELD", "push_token is required");
    return;
  }

  let count = 10;
  if (rawCount !== undefined) {
    if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1 || rawCount > 100) {
      sendError(res, 400, "INVALID_COUNT", "count must be an integer between 1 and 100");
      return;
    }
    count = rawCount;
  }

  const app = getApp(app_id);
  if (!app) {
    sendError(res, 404, "UNKNOWN_APP", `Unknown app_id: ${app_id}`);
    return;
  }

  const ttl = parseInt(process.env.UUID_TTL_SECONDS ?? "2592000", 10);
  const existingCredential = extractBearerToken(req);

  let deviceCredential: string;
  let isBootstrap: boolean;

  if (existingCredential) {
    // Replenishment: validate existing credential
    let credRecord;
    try {
      credRecord = await getCredential(existingCredential);
    } catch (err) {
      console.error("Redis read failed during credential lookup:", err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to validate credential");
      return;
    }

    if (!credRecord) {
      sendError(res, 401, "INVALID_CREDENTIAL", "Device credential is unknown or has expired");
      return;
    }

    // Update push_token if rotated, refresh TTL
    try {
      await refreshCredential(existingCredential, push_token, ttl);
    } catch (err) {
      console.error("Failed to refresh credential:", err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to refresh credential");
      return;
    }

    deviceCredential = existingCredential;
    isBootstrap = false;
  } else {
    // Bootstrap: generate a new credential
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    deviceCredential = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

    try {
      await setCredential(deviceCredential, {
        push_token,
        app_id,
        created_at: new Date().toISOString(),
      }, ttl);
    } catch (err) {
      console.error("Redis write failed during credential creation:", err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to create credential");
      return;
    }

    isBootstrap = true;
  }

  // Generate UUIDs under the resolved credential
  const uuids: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const uuid = crypto.randomUUID();
      const record: UuidRecord = {
        app_id,
        push_token,
        wallet_ws_url: app.wallet_ws_url,
        device_credential: deviceCredential,
        status: "unused",
        created_at: new Date().toISOString(),
      };
      await setUuid(uuid, record, ttl);
      uuids.push(uuid);
    }
  } catch (err) {
    console.error("Redis write failed during UUID generation:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to write UUID records");
    return;
  }

  try {
    upsertDevice(push_token, app_id);
  } catch (err) {
    console.error("SQLite upsert failed during registration:", err);
    // Non-fatal: UUIDs are already written; log and continue
  }

  if (isBootstrap) {
    sendJson(res, 200, { uuids, device_credential: deviceCredential });
  } else {
    sendJson(res, 200, { uuids });
  }
}
