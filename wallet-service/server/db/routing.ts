/**
 * routing_table / routing_nonces repository (implementation-plan.md §Step
 * 4.1). routing_table holds one row per card_hash — the *current* binding
 * only; conflict resolution (src/federation/binding.ts) decides whether an
 * incoming announcement replaces it. routing_nonces is the replay-prevention
 * cache, independent of which announcement currently "wins" for a card_hash.
 */

import type { Pool } from 'pg';
import type { SignatureEntry } from '../../src/federation/binding.js';

export type BindingType = 'card_registration' | 'card_migration';

export interface RoutingTableRow {
  card_hash: string;
  wallet_service_id: string;
  endpoint: string;
  type: BindingType;
  announced_at: Date;
  nonce: string;
  signatures: SignatureEntry[];
}

export async function findRoutingEntry(pool: Pool, cardHash: string): Promise<RoutingTableRow | null> {
  const { rows } = await pool.query<RoutingTableRow>('SELECT * FROM routing_table WHERE card_hash = $1', [
    cardHash,
  ]);
  return rows[0] ?? null;
}

export async function listRoutingTable(pool: Pool): Promise<RoutingTableRow[]> {
  const { rows } = await pool.query<RoutingTableRow>('SELECT * FROM routing_table ORDER BY card_hash');
  return rows;
}

export async function upsertRoutingEntry(pool: Pool, entry: RoutingTableRow): Promise<void> {
  await pool.query(
    `INSERT INTO routing_table (card_hash, wallet_service_id, endpoint, type, announced_at, nonce, signatures)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (card_hash) DO UPDATE
       SET wallet_service_id = $2, endpoint = $3, type = $4, announced_at = $5, nonce = $6, signatures = $7`,
    [
      entry.card_hash,
      entry.wallet_service_id,
      entry.endpoint,
      entry.type,
      entry.announced_at,
      entry.nonce,
      JSON.stringify(entry.signatures),
    ]
  );
}

/**
 * Atomically records a nonce as seen. Returns false if it was already
 * present (replay) — the INSERT's primary-key conflict is the concurrency
 * boundary, same pattern as auth_challenges' single-use consumption.
 */
export async function recordNonceIfNew(pool: Pool, nonce: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO routing_nonces (nonce) VALUES ($1) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
    [nonce]
  );
  return rows.length > 0;
}

const NONCE_RETENTION_HOURS = 24;

export async function pruneOldNonces(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM routing_nonces WHERE seen_at < now() - make_interval(hours => $1)`,
    [NONCE_RETENTION_HOURS]
  );
  return rowCount ?? 0;
}
