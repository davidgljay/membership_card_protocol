/**
 * Postgres-backed KvStore fallback for node-server/aws-lambda presets,
 * where no cloudflare-kv-binding is available (implementation-plan.md
 * §Step 1.4). Same semantics as the Nitro KV adapter: optional TTL,
 * lazy expiry on read.
 */

import type { Pool } from 'pg';
import type { KvStore } from './kv.js';

export function createPostgresKvStore(pool: Pool): KvStore {
  return {
    async getItem<T>(key: string): Promise<T | null> {
      const { rows } = await pool.query<{ value: T; expires_at: Date | null }>(
        'SELECT value, expires_at FROM kv_store WHERE key = $1',
        [key]
      );
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at && row.expires_at.getTime() < Date.now()) {
        await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
        return null;
      }
      return row.value;
    },

    async setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
      await pool.query(
        `INSERT INTO kv_store (key, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
        [key, JSON.stringify(value), expiresAt]
      );
    },

    async removeItem(key: string): Promise<void> {
      await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    },

    async increment(key: string, delta = 1): Promise<number> {
      const current = (await this.getItem<number>(key)) ?? 0;
      const next = current + delta;
      await this.setItem(key, next);
      return next;
    },
  };
}
