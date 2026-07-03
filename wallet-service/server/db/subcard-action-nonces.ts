/**
 * subcard_action_nonces repository — replay protection for both signed
 * sub-card envelope endpoints:
 *   - POST   /cards/{card_hash}/subcards/{subcard_hash}/uuids   (action: 'register')
 *   - DELETE /cards/{card_hash}/subcards/{subcard_hash}         (action: 'deregister')
 * (notification_relay.md v0.9 §Process 1 steps 6-8, §Multi-Device Support
 * "Deregistration"; migration 1772400700000_generalize-subcard-action-nonces.cjs
 * explains why this is one generalized table rather than two nearly-identical
 * ones, and why it was renamed from subcard_uuid_registration_nonces rather
 * than left as-is with a second table added alongside it.)
 */

import type { Pool } from 'pg';

export type SubcardAction = 'register' | 'deregister';

/**
 * Atomically records a (subcard_hash, action, nonce) triple as seen.
 * Returns false if that triple was already present (replay) — same
 * INSERT-conflict concurrency pattern as routing.ts's recordNonceIfNew.
 * Scoping by `action` as well as `subcard_hash` means a register nonce
 * and a deregister nonce can never collide with each other even if a
 * caller (accidentally or maliciously) reused the same random nonce
 * value across both envelope types for the same subcard.
 */
export async function recordSubcardActionNonceIfNew(
  pool: Pool,
  subcardHash: string,
  action: SubcardAction,
  nonce: string
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO subcard_action_nonces (subcard_hash, action, nonce)
     VALUES ($1, $2, $3)
     ON CONFLICT (subcard_hash, action, nonce) DO NOTHING
     RETURNING nonce`,
    [subcardHash, action, nonce]
  );
  return rows.length > 0;
}

// Matches both endpoints' own timestamp-tolerance window (see
// TIMESTAMP_WINDOW_MS in src/routes/subcard-uuid-registration.ts and
// src/routes/subcard-deregistration.ts) plus a margin — a nonce can never
// usefully be replayed once its originating timestamp has aged out of the
// window anyway, so retaining much longer than that window is dead
// weight, same reasoning as routing.ts's NONCE_RETENTION_HOURS but scaled
// to these endpoints' much shorter (5-minute) replay window.
const NONCE_RETENTION_HOURS = 1;

export async function pruneOldSubcardActionNonces(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM subcard_action_nonces WHERE seen_at < now() - make_interval(hours => $1)`,
    [NONCE_RETENTION_HOURS]
  );
  return rowCount ?? 0;
}
