/**
 * GET /accounts/{card_hash}/backups/{backup_id} — implementation-plan.md §Step 3.1.
 * Returns all fields except wrapped_blob — that value is only ever
 * returned to the holder's own client at registration time and to the
 * recovering device at key release (Step 3.5), never on lookup.
 */

import { requireSessionTokenRaw, AuthError } from '../../../../utils/auth.js';
import { getPool } from '../../../../db/client.js';
import { findAccountByCardHash } from '../../../../db/accounts.js';
import { findBackupRegistrationById } from '../../../../db/backups.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const backupId = getRouterParam(event, 'backup_id');
  if (!cardHash || !backupId) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash and backup_id are required.' });
  }

  let session;
  try {
    session = await requireSessionTokenRaw(event);
  } catch (err) {
    if (err instanceof AuthError) throw createError({ statusCode: err.statusCode, statusMessage: err.message });
    throw err;
  }
  if (session.payload.card_hash !== cardHash) {
    throw createError({ statusCode: 403, statusMessage: 'Session token does not authorize this card_hash.' });
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const backup = await findBackupRegistrationById(pool, backupId);
  if (!backup || backup.holder_id !== account.id) {
    throw createError({ statusCode: 404, statusMessage: 'No backup registration found.' });
  }

  return {
    backup_id: backup.id,
    type: backup.type,
    keyring_id: backup.keyring_id,
    notification_channels: backup.notification_channels,
    cancellation_pubkey: backup.cancellation_pubkey,
    created_at: backup.created_at.toISOString(),
  };
});
