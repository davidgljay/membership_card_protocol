// Per-request Redis client construction. Nitro/Workers invoke handlers
// per-request with no persistent process to hold a long-lived connection
// pool (relay_data_model.md §5.3's "no startup moment" note applies
// equally here) — each request gets its own RedisClient, connects lazily
// on first command (see resp-client.ts's ensureConnected), and the
// underlying TCP/TLS socket is closed at the end of the request via
// `event.waitUntil`-style cleanup where the caller is responsible for
// calling `close()`. This mirrors how a Workers `connect()` socket's
// lifetime is expected to be scoped to a single request.

import type { H3Event } from 'h3';
import { RedisClient } from './resp-client';
import { requireEnv } from '../env';

export function createRedisClientForRequest(event: H3Event): RedisClient {
  const url = requireEnv(event, 'REDIS_PRIMARY_URL');
  return new RedisClient({ url });
}
