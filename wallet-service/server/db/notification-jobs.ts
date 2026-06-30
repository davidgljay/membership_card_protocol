/**
 * notification_jobs repository (implementation-plan.md §Step 3.3).
 * PostgreSQL-backed job queue — not Redis — so jobs survive restarts,
 * matching the durability requirement on the 72-hour window itself.
 */

import type { Pool } from 'pg';

export type NotificationChannel =
  | 'email'
  | 'sms'
  | 'webhook'
  | 'secondary_contact_email'
  | 'secondary_contact_sms';

export type NotificationJobStatus = 'pending' | 'sent' | 'failed';

export interface NotificationJobRow {
  id: string;
  recovery_id: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  status: NotificationJobStatus;
  attempts: number;
  next_attempt_at: Date;
  sent_at: Date | null;
  created_at: Date;
}

export async function enqueueNotificationJob(
  pool: Pool,
  recoveryId: string,
  channel: NotificationChannel,
  payload: object
): Promise<NotificationJobRow> {
  const { rows } = await pool.query<NotificationJobRow>(
    `INSERT INTO notification_jobs (recovery_id, channel, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [recoveryId, channel, JSON.stringify(payload)]
  );
  const row = rows[0];
  if (!row) {
    throw new Error('enqueueNotificationJob: insert returned no row.');
  }
  return row;
}

export async function findJobsForRecovery(pool: Pool, recoveryId: string): Promise<NotificationJobRow[]> {
  const { rows } = await pool.query<NotificationJobRow>(
    'SELECT * FROM notification_jobs WHERE recovery_id = $1 ORDER BY created_at',
    [recoveryId]
  );
  return rows;
}

export async function findDueJobs(pool: Pool, limit = 100): Promise<NotificationJobRow[]> {
  const { rows } = await pool.query<NotificationJobRow>(
    `SELECT * FROM notification_jobs
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function markJobSent(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE notification_jobs SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`,
    [id]
  );
}

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;

/** Reschedules with exponential backoff, or marks permanently 'failed' past MAX_ATTEMPTS. */
export async function markJobFailed(pool: Pool, id: string, attempts: number): Promise<void> {
  const nextAttempts = attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    await pool.query(`UPDATE notification_jobs SET status = 'failed', attempts = $2 WHERE id = $1`, [
      id,
      nextAttempts,
    ]);
    return;
  }
  const backoffSeconds = BASE_BACKOFF_SECONDS * 2 ** attempts;
  await pool.query(
    `UPDATE notification_jobs
     SET attempts = $2, next_attempt_at = now() + make_interval(secs => $3)
     WHERE id = $1`,
    [id, nextAttempts, backoffSeconds]
  );
}
