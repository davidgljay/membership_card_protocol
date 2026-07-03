import Redis from "ioredis";

export type UuidStatus = "unused" | "in_flight" | "active" | "consumed";

export interface UuidRecord {
  app_id: string;
  push_token: string;
  wallet_ws_url: string;
  device_credential: string;
  status: UuidStatus;
  created_at: string;
}

export interface CredentialRecord {
  push_token: string;
  app_id: string;
  created_at: string;
}

export interface PendingMessage {
  uuid: string;
  blob: string;
  wallet_url: string;
  received_at: string;
}

export interface DeleteJob {
  wallet_url: string;
  uuid: string;
  attempts: number;
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

// ── Device credential store ────────────────────────────────────────────────

export async function setCredential(
  credential: string,
  record: CredentialRecord,
  ttlSeconds: number
): Promise<void> {
  const redis = getRedisClient();
  const key = `cred:${credential}`;
  await redis.hset(key, record as unknown as Record<string, string>);
  await redis.expire(key, ttlSeconds);
}

export async function getCredential(credential: string): Promise<CredentialRecord | null> {
  const redis = getRedisClient();
  const raw = await redis.hgetall(`cred:${credential}`);
  if (!raw || !raw.push_token) return null;
  return raw as unknown as CredentialRecord;
}

export async function refreshCredential(
  credential: string,
  pushToken: string,
  ttlSeconds: number
): Promise<boolean> {
  const redis = getRedisClient();
  const key = `cred:${credential}`;
  const exists = await redis.exists(key);
  if (!exists) return false;
  await redis.hset(key, "push_token", pushToken);
  await redis.expire(key, ttlSeconds);
  return true;
}

// ── Message store ──────────────────────────────────────────────────────────

const DRAIN_MESSAGES_SCRIPT = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
if #items > 0 then
  redis.call('DEL', KEYS[1])
end
return items
`;

export async function storeMessage(
  credential: string,
  entry: PendingMessage,
  ttlSeconds: number
): Promise<void> {
  const redis = getRedisClient();
  const key = `messages:${credential}`;
  await redis.rpush(key, JSON.stringify(entry));
  await redis.expire(key, ttlSeconds);
}

export async function drainMessages(credential: string): Promise<PendingMessage[]> {
  const redis = getRedisClient();
  const raw = (await redis.eval(DRAIN_MESSAGES_SCRIPT, 1, `messages:${credential}`)) as string[];
  return raw.map((item) => JSON.parse(item) as PendingMessage);
}

// ── Pending delete queue ───────────────────────────────────────────────────

const DEQUEUE_DELETES_SCRIPT = `
local now = ARGV[1]
local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #jobs > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
end
return jobs
`;

const PENDING_DELETES_KEY = "pending_deletes";

export async function enqueuePendingDelete(
  job: DeleteJob,
  executeAtMs: number
): Promise<void> {
  const redis = getRedisClient();
  await redis.zadd(PENDING_DELETES_KEY, executeAtMs, JSON.stringify(job));
}

export async function dequeuePendingDeletes(): Promise<DeleteJob[]> {
  const redis = getRedisClient();
  const now = Date.now().toString();
  const raw = (await redis.eval(
    DEQUEUE_DELETES_SCRIPT,
    1,
    PENDING_DELETES_KEY,
    now
  )) as string[];
  return raw.map((item) => JSON.parse(item) as DeleteJob);
}

export async function requeuePendingDelete(
  job: DeleteJob,
  executeAtMs: number
): Promise<void> {
  const redis = getRedisClient();
  await redis.zadd(PENDING_DELETES_KEY, executeAtMs, JSON.stringify(job));
}
