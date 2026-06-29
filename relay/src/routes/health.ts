import type { IncomingMessage, ServerResponse } from "node:http";
import { getRedisClient } from "../utils/storage/redis.js";
import { getDb } from "../utils/storage/sqlite.js";
import { sendJson } from "../utils/http.js";

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>
): Promise<void> {
  const [redisStatus, sqliteStatus] = await Promise.all([
    checkRedis(),
    checkSqlite(),
  ]);

  const healthy = redisStatus === "ok" && sqliteStatus === "ok";

  sendJson(res, healthy ? 200 : 503, {
    status: healthy ? "ok" : "degraded",
    redis: redisStatus,
    sqlite: sqliteStatus,
  });
}

async function checkRedis(): Promise<"ok" | "error"> {
  try {
    const pong = await getRedisClient().ping();
    return pong === "PONG" ? "ok" : "error";
  } catch {
    return "error";
  }
}

function checkSqlite(): "ok" | "error" {
  try {
    getDb().prepare("SELECT 1").get();
    return "ok";
  } catch {
    return "error";
  }
}
