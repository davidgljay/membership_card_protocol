/**
 * KvStore factory — picks the backend per implementation-plan.md §Step 1.4:
 * `cloudflare-kv` requires a real Workers KV binding (production Cloudflare
 * deploys only — see wrangler.toml's WALLET_KV binding); `postgres` is the
 * documented fallback and the default everywhere a binding isn't available,
 * including local dev (`nitro dev`) and CI, regardless of build preset.
 */

import type { KvStore } from '../../src/kv.js';
import { loadConfig } from '../../src/config.js';
import { createNitroKvStore } from './kv.js';
import { createPostgresKvStore } from '../../src/kv-postgres.js';
import { getPool } from '../db/client.js';

export function createKvStore(): KvStore {
  const config = loadConfig();
  if (config.KV_BACKEND === 'cloudflare-kv') {
    return createNitroKvStore();
  }
  return createPostgresKvStore(getPool());
}
