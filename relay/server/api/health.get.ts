// GET /health — relay.md §7.7.
//
// Replaces the Phase 1 scaffold stub (which only proved the build/deploy
// pipeline worked — see its removed comment). This is the real handler:
// Redis PING + a KV round-trip (the device registry's storage() mount),
// mirroring the spec's "Redis PING and a SQLite SELECT 1" description but
// against this migration's actual two stores (Redis Cloud primary, KV
// device registry) — the spec's literal "sqlite" field name is kept in the
// response per relay.md §7.7's example JSON verbatim (not renamed to `kv`),
// since relay.md's response schema is the authoritative contract and this
// implementation should not quietly diverge from a documented field name.
// Flagged in the Phase 2 report as a candidate for a future spec wording
// cleanup, not resolved here.

import type { H3Event } from 'h3';
import { createRedisClientForRequest } from '../utils/redis/client-factory';
import { getDeviceRegistryStorage } from '../utils/kv/storage-factory';

export default defineEventHandler(async (event: H3Event) => {
  let redisOk = false;
  let kvOk = false;

  try {
    const redis = createRedisClientForRequest(event);
    try {
      redisOk = await redis.ping();
    } finally {
      await redis.close();
    }
  } catch {
    redisOk = false;
  }

  try {
    const kv = getDeviceRegistryStorage(event);
    const probeKey = '__health_probe__';
    await kv.setItem(probeKey, { ok: true }, { ttl: 60 });
    const value = await kv.getItem(probeKey);
    kvOk = !!value;
  } catch {
    kvOk = false;
  }

  const healthy = redisOk && kvOk;
  if (!healthy) {
    setResponseStatus(event, 503);
  }

  return {
    status: healthy ? 'ok' : 'degraded',
    redis: redisOk ? 'ok' : 'error',
    sqlite: kvOk ? 'ok' : 'error',
  };
});
