/**
 * uuid_pools repository (implementation-plan.md §Step 4.4, §Step 5.1).
 * Per-subcard delivery routing — each registered subcard has its own pool
 * of single-use UUIDs the relay accepts blobs against.
 */

import type { Pool } from 'pg';

export interface UuidPoolRow {
  uuid: string;
  card_hash: string;
  subcard_hash: string;
  consumed: boolean;
  registered_at: Date;
  expires_at: Date;
}

/**
 * Atomically claims the oldest unconsumed, unexpired UUID for a subcard
 * and marks it consumed in the same statement — two concurrent delivery
 * attempts for the same subcard can never claim the same UUID.
 */
export async function claimNextUuid(pool: Pool, cardHash: string, subcardHash: string): Promise<string | null> {
  const { rows } = await pool.query<{ uuid: string }>(
    `UPDATE uuid_pools
     SET consumed = true
     WHERE uuid = (
       SELECT uuid FROM uuid_pools
       WHERE card_hash = $1 AND subcard_hash = $2 AND consumed = false AND expires_at > now()
       ORDER BY registered_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING uuid`,
    [cardHash, subcardHash]
  );
  return rows[0]?.uuid ?? null;
}
