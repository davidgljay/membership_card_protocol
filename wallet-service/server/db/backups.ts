/**
 * backup_registrations repository (implementation-plan.md §Step 3.1).
 * The wallet service never decrypts `wrapped_blob`; it is stored and
 * returned opaquely, and only ever returned in full to the holder's own
 * client at registration time (Step 3.1) and at key release (Step 3.5) —
 * never echoed back by the GET-by-id lookup used for display.
 */

import type { Pool } from 'pg';

export type BackupType = 'synced_passkey' | 'yubikey';

export interface NotificationChannels {
  email?: string;
  sms?: string;
  webhook?: string;
  secondary_contact?: { name: string; email?: string; sms?: string };
}

export interface BackupRegistrationRow {
  id: string;
  holder_id: string;
  type: BackupType;
  wrapped_blob: string;
  keyring_id: string;
  notification_channels: NotificationChannels;
  cancellation_pubkey: string;
  created_at: Date;
}

export interface CreateBackupRegistrationInput {
  holderId: string;
  type: BackupType;
  wrappedBlob: string;
  keyringId: string;
  notificationChannels: NotificationChannels;
  cancellationPubkey: string;
}

export async function createBackupRegistration(
  pool: Pool,
  input: CreateBackupRegistrationInput
): Promise<BackupRegistrationRow> {
  const { rows } = await pool.query<BackupRegistrationRow>(
    `INSERT INTO backup_registrations (
       holder_id, type, wrapped_blob, keyring_id, notification_channels, cancellation_pubkey
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.holderId,
      input.type,
      input.wrappedBlob,
      input.keyringId,
      JSON.stringify(input.notificationChannels),
      input.cancellationPubkey,
    ]
  );
  const row = rows[0];
  if (!row) {
    throw new Error('createBackupRegistration: insert returned no row.');
  }
  return row;
}

export async function findBackupRegistrationById(
  pool: Pool,
  id: string
): Promise<BackupRegistrationRow | null> {
  const { rows } = await pool.query<BackupRegistrationRow>(
    'SELECT * FROM backup_registrations WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}
