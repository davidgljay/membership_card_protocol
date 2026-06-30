/**
 * Shared PostgreSQL connection pool. One pool per process; Nitro reuses the
 * module instance across requests within a worker/node-server runtime.
 */

import { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const config = loadConfig();
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
