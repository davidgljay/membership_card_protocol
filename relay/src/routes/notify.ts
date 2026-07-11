import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidUuidV4, sendJson, sendError } from "../utils/http.js";
import { getUuid, transitionUuid } from "../utils/storage/redis.js";
import { getApp } from "../utils/apps.js";
import { dispatchPush } from "../utils/push/dispatch.js";

export async function handleNotify(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const { uuid } = params;

  if (!isValidUuidV4(uuid)) {
    sendError(res, 400, "INVALID_UUID", "Path parameter is not a valid UUID v4");
    return;
  }

  let record;
  try {
    record = await getUuid(uuid);
  } catch (err) {
    console.error("Redis read failed in /notify:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to read UUID record");
    return;
  }

  if (!record) {
    sendError(res, 404, "UNKNOWN_UUID", "UUID not found");
    return;
  }

  if (record.status !== "unused") {
    sendError(res, 410, "UUID_CONSUMED", "UUID has already been used or is in use");
    return;
  }

  // Atomically transition unused → in_flight before dispatch
  let transition;
  try {
    transition = await transitionUuid(uuid, "unused", "in_flight");
  } catch (err) {
    console.error("Redis transition failed in /notify:", err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to transition UUID state");
    return;
  }

  if (!transition.ok) {
    // Concurrent request won the race
    sendError(res, 410, "UUID_CONSUMED", "UUID has already been used or is in use");
    return;
  }

  const app = getApp(record.app_id);
  if (!app) {
    // Config/Redis inconsistency — consume the UUID to prevent it from being retried indefinitely
    await transitionUuid(uuid, "in_flight", "consumed").catch((e) =>
      console.error("Failed to consume UUID after missing app config:", e)
    );
    sendError(res, 500, "INTERNAL_ERROR", "App config not found for this UUID");
    return;
  }

  try {
    await dispatchPush(record.push_token, uuid, app);
  } catch (err) {
    console.error("Push dispatch failed:", err);
    // Roll back to unused so the wallet service may retry
    await transitionUuid(uuid, "in_flight", "unused").catch((e) =>
      console.error("Failed to roll back UUID after push failure:", e)
    );
    sendError(res, 502, "PUSH_FAILED", "Failed to deliver push notification");
    return;
  }

  await transitionUuid(uuid, "in_flight", "consumed").catch((e) =>
    console.error("Failed to mark UUID consumed after successful push:", e)
  );

  sendJson(res, 200, {});
}
