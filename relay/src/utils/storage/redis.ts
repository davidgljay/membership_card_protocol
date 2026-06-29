import Redis from "ioredis";

export type UuidStatus = "unused" | "in_flight" | "active" | "consumed";

export interface UuidRecord {
  app_id: string;
  push_token: string;
  wallet_ws_url: string;
  status: UuidStatus;
  created_at: string;
}

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL environment variable is required");
    client = new Redis(url);
    client.on("error", (err) => {
      console.error("Redis error:", err);
    });
  }
  return client;
}

const TRANSITION_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'status')
if current == false then
  return {err = 'NOT_FOUND'}
end
if current == 'consumed' then
  return {err = 'WRONG_STATUS:consumed'}
end
if current ~= ARGV[1] then
  return {err = 'WRONG_STATUS:' .. current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 'OK'
`;

export async function getUuid(uuid: string): Promise<UuidRecord | null> {
  const redis = getRedisClient();
  const raw = await redis.hgetall(`uuid:${uuid}`);
  if (!raw || !raw.status) return null;
  return raw as unknown as UuidRecord;
}

export async function setUuid(
  uuid: string,
  record: UuidRecord,
  ttlSeconds: number
): Promise<void> {
  const redis = getRedisClient();
  const key = `uuid:${uuid}`;
  await redis.hset(key, record as unknown as Record<string, string>);
  await redis.expire(key, ttlSeconds);
}

export async function deleteUuid(uuid: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`uuid:${uuid}`);
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_STATUS"; currentStatus?: string };

export async function transitionUuid(
  uuid: string,
  from: UuidStatus,
  to: UuidStatus
): Promise<TransitionResult> {
  const redis = getRedisClient();
  try {
    const result = await redis.eval(TRANSITION_SCRIPT, 1, `uuid:${uuid}`, from, to);
    if (result === "OK") return { ok: true };
    return { ok: false, reason: "NOT_FOUND" }; // unexpected non-OK non-error
  } catch (err: unknown) {
    // ioredis throws ReplyError when Lua calls redis.error_reply(...)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("NOT_FOUND")) return { ok: false, reason: "NOT_FOUND" };
    const match = msg.match(/WRONG_STATUS:(.+)/);
    if (match) return { ok: false, reason: "WRONG_STATUS", currentStatus: match[1] };
    throw err; // unexpected Redis error — re-throw
  }
}

export async function isStoreEmpty(): Promise<boolean> {
  const redis = getRedisClient();
  const [cursor, keys] = await redis.scan("0", "MATCH", "uuid:*", "COUNT", "1");
  return cursor === "0" && keys.length === 0;
}

export async function scanActiveUuids(): Promise<string[]> {
  const redis = getRedisClient();
  const activeUuids: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "uuid:*", "COUNT", "100");
    cursor = nextCursor;
    for (const key of keys) {
      const status = await redis.hget(key, "status");
      if (status === "active" || status === "in_flight") {
        activeUuids.push(key.slice("uuid:".length));
      }
    }
  } while (cursor !== "0");

  return activeUuids;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
