/**
 * recovery_windows repository (implementation-plan.md §Step 3.2, §Step 3.4,
 * §Step 3.5). The 72-hour timer is a persisted `expires_at` column, never
 * an in-process timer (strategic-plan.md §Why the 72-hour window must be
 * hardened) — every check here is a comparison against server-side
 * `now()`, never client-supplied time.
 */

import type { Pool } from 'pg';

export type RecoveryStatus = 'pending' | 'cancelled' | 'released';

export interface RecoveryWindowRow {
  id: string;
  backup_reg_id: string;
  initiated_at: Date;
  expires_at: Date;
  status: RecoveryStatus;
  cancelled_at: Date | null;
  released_at: Date | null;
}

const RECOVERY_WINDOW_HOURS = 72;

export async function findActiveRecoveryWindow(
  pool: Pool,
  backupRegId: string
): Promise<RecoveryWindowRow | null> {
  const { rows } = await pool.query<RecoveryWindowRow>(
    `SELECT * FROM recovery_windows WHERE backup_reg_id = $1 AND status = 'pending'`,
    [backupRegId]
  );
  return rows[0] ?? null;
}

export async function createRecoveryWindow(
  pool: Pool,
  backupRegId: string
): Promise<RecoveryWindowRow> {
  const { rows } = await pool.query<RecoveryWindowRow>(
    `INSERT INTO recovery_windows (backup_reg_id, expires_at)
     VALUES ($1, now() + make_interval(hours => $2))
     RETURNING *`,
    [backupRegId, RECOVERY_WINDOW_HOURS]
  );
  const row = rows[0];
  if (!row) {
    throw new Error('createRecoveryWindow: insert returned no row.');
  }
  return row;
}

export async function findRecoveryWindowById(
  pool: Pool,
  id: string
): Promise<RecoveryWindowRow | null> {
  const { rows } = await pool.query<RecoveryWindowRow>('SELECT * FROM recovery_windows WHERE id = $1', [
    id,
  ]);
  return rows[0] ?? null;
}

/**
 * Atomically cancels a pending, unexpired window. Returns the updated row,
 * or null if conditions weren't met — the caller re-reads the row to
 * distinguish idempotent-cancel (already 'cancelled') from too-late
 * (expired or 'released': implementation-plan.md §Step 3.4 "cancellation
 * after 72-hour expiry returns 410").
 */
export async function cancelRecoveryWindow(pool: Pool, id: string): Promise<RecoveryWindowRow | null> {
  const { rows } = await pool.query<RecoveryWindowRow>(
    `UPDATE recovery_windows
     SET status = 'cancelled', cancelled_at = now()
     WHERE id = $1 AND status = 'pending' AND expires_at > now()
     RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

/** Atomically releases a pending, expired window. Returns the updated row, or null if conditions aren't met (caller inspects current status to pick 425 vs 410). */
export async function releaseRecoveryWindow(pool: Pool, id: string): Promise<RecoveryWindowRow | null> {
  const { rows } = await pool.query<RecoveryWindowRow>(
    `UPDATE recovery_windows
     SET status = 'released', released_at = now()
     WHERE id = $1 AND status = 'pending' AND expires_at < now()
     RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}
