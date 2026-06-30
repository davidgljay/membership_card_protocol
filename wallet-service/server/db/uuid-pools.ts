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

const UUID_EXPIRY_DAYS = 30;

/**
 * Registers a batch of UUIDs for a subcard (implementation-plan.md §Step
 * 5.1). No authentication beyond a syntactically valid card_hash — the
 * device does not authenticate its identity here, by design (unlinkability).
 */
export async function registerUuids(
  pool: Pool,
  cardHash: string,
  subcardHash: string,
  uuids: string[]
): Promise<void> {
  if (uuids.length === 0) return;
  await pool.query(
    `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, registered_at, expires_at)
     SELECT u, $1, $2, now(), now() + make_interval(days => $3)
     FROM unnest($4::uuid[]) AS u
     ON CONFLICT (uuid) DO NOTHING`,
    [cardHash, subcardHash, UUID_EXPIRY_DAYS, uuids]
  );
}

/** True if any row (consumed or not) has ever been registered for this subcard — used to distinguish "never registered" (404) from "registered, now empty" (still a valid, deregistered subcard). */
export async function subcardHasAnyHistory(pool: Pool, cardHash: string, subcardHash: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM uuid_pools WHERE card_hash = $1 AND subcard_hash = $2 LIMIT 1',
    [cardHash, subcardHash]
  );
  return rows.length > 0;
}

/** Marks every UUID for a subcard as consumed (implementation-plan.md §Step 5.2). Returns the number of rows affected. */
export async function consumeAllForSubcard(pool: Pool, cardHash: string, subcardHash: string): Promise<number> {
  const { rowCount } = await pool.query(
    'UPDATE uuid_pools SET consumed = true WHERE card_hash = $1 AND subcard_hash = $2 AND consumed = false',
    [cardHash, subcardHash]
  );
  return rowCount ?? 0;
}

/** Deletes expired, already-consumed UUIDs (implementation-plan.md §Step 5.3). Returns the number of rows pruned. */
export async function pruneExpiredConsumedUuids(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM uuid_pools WHERE expires_at < now() AND consumed = true');
  return rowCount ?? 0;
}

export interface UuidPoolSize {
  card_hash: string;
  subcard_hash: string;
  available: number;
}

/**
 * Operator visibility (strategic-plan.md §Goal 5: "UUID pool sizes per
 * device"). The wallet's only granularity is subcard_hash, never a device
 * identity — exposing subcard_hash alone here is consistent with how it's
 * treated everywhere else in this codebase (safe standalone; the
 * unlinkability constraint is about correlating it to a device/IP/session,
 * not about hiding its existence).
 */
export async function listUuidPoolSizes(pool: Pool): Promise<UuidPoolSize[]> {
  const { rows } = await pool.query<{ card_hash: string; subcard_hash: string; available: string }>(
    `SELECT card_hash, subcard_hash, count(*) AS available
     FROM uuid_pools
     WHERE consumed = false AND expires_at > now()
     GROUP BY card_hash, subcard_hash
     ORDER BY card_hash, subcard_hash`
  );
  return rows.map((r) => ({ card_hash: r.card_hash, subcard_hash: r.subcard_hash, available: Number(r.available) }));
}
