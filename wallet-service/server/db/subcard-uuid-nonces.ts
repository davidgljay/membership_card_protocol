/**
 * subcard_uuid_registration_nonces repository — replay protection for POST
 * /cards/{card_hash}/subcards/{subcard_hash}/uuids
 * (notification_relay.md v0.8 §Process 1 steps 6-8; migration
 * 1772400600000_subcard-uuid-registration-nonces.cjs explains why this is
 * a separate table from routing_nonces / server/db/routing.ts).
 */

import type { Pool } from 'pg';

/**
 * Atomically records a (subcard_hash, nonce) pair as seen. Returns false
 * if that pair was already present (replay) — same INSERT-conflict
 * concurrency pattern as routing.ts's recordNonceIfNew.
 */
export async function recordSubcardUuidNonceIfNew(pool: Pool, subcardHash: string, nonce: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO subcard_uuid_registration_nonces (subcard_hash, nonce)
     VALUES ($1, $2)
     ON CONFLICT (subcard_hash, nonce) DO NOTHING
     RETURNING nonce`,
    [subcardHash, nonce]
  );
  return rows.length > 0;
}

// Matches the endpoint's own timestamp-tolerance window (see
// TIMESTAMP_WINDOW_MS in uuids.post.ts) plus a margin — a nonce can never
// usefully be replayed once its originating timestamp has aged out of the
// window anyway, so retaining much longer than that window is dead weight,
// same reasoning as routing.ts's NONCE_RETENTION_HOURS but scaled to this
// endpoint's much shorter (5-minute) replay window.
const NONCE_RETENTION_HOURS = 1;

export async function pruneOldSubcardUuidNonces(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM subcard_uuid_registration_nonces WHERE seen_at < now() - make_interval(hours => $1)`,
    [NONCE_RETENTION_HOURS]
  );
  return rowCount ?? 0;
}
