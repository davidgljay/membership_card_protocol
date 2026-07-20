/**
 * PostgreSQL connection access. On node-server/aws-lambda this is the
 * classic shared pool: one instance per process, reused across requests.
 *
 * On the cloudflare-module preset it can't be — a `pg.Pool` that keeps
 * connections alive across separate requests doesn't survive reliably
 * under workerd. A connection established while handling one request
 * intermittently hangs when reused during a later, different request, and
 * gets force-killed by the Workers runtime's watchdog (~50% failure rate
 * on a `getPool().query()` health check, confirmed empirically running
 * this service under real `wrangler dev`, not just from docs). This is
 * documented Cloudflare/pg behavior, not something local Hyperdrive
 * emulation fixes either — `wrangler dev`'s `localConnectionString` is a
 * passthrough with no pooling in local dev.
 *
 * Every one of this repo's ~37 call sites already calls `getPool()` fresh
 * at the top of its own request handler rather than caching the result
 * across requests itself, so the fix is entirely inside this function: on
 * Workers, return a brand-new small Pool per call instead of a cached
 * singleton, so its one connection is always established and used within
 * the same request. `idleTimeoutMillis`/`allowExitOnIdle` let pg clean it
 * up on its own without needing an explicit `.end()` threaded through
 * every caller. No call site elsewhere in this codebase uses transactions
 * or pool introspection (checked — only ever `pool.query(...)`), so
 * `max: 1` changes nothing observable.
 */

import { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';

// Standard Cloudflare Workers runtime detection —
// developers.cloudflare.com/workers/runtime-apis/web-standards/#navigator.
const isWorkersRuntime = (globalThis as { navigator?: { userAgent?: string } }).navigator
  ?.userAgent === 'Cloudflare-Workers';

let pool: Pool | null = null;

export function getPool(): Pool {
  const config = loadConfig();

  if (isWorkersRuntime) {
    return new Pool({
      connectionString: config.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 5_000,
      allowExitOnIdle: true,
    });
  }

  if (!pool) {
    pool = new Pool({ connectionString: config.DATABASE_URL });
  }
  return pool;
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
