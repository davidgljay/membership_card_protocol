/**
 * GET /recovery/{recovery_id}/release — implementation-plan.md §Step 3.5.
 * Releases wrapped_blob + keyring_id once the 72-hour window has elapsed
 * with no cancellation. Idempotent after release; 425 before the window
 * closes; 410 if cancelled. expires_at is the only source of truth for
 * timing — never client-supplied.
 */

import { getPool } from '../../../db/client.js';
import { findRecoveryWindowById, releaseRecoveryWindow } from '../../../db/recovery.js';
import { findBackupRegistrationById } from '../../../db/backups.js';
import { auditLog } from '../../../utils/audit-log.js';

export default defineEventHandler(async (event) => {
  const recoveryId = getRouterParam(event, 'recovery_id');
  if (!recoveryId) {
    throw createError({ statusCode: 400, statusMessage: 'recovery_id is required.' });
  }

  const pool = getPool();
  const recovery = await findRecoveryWindowById(pool, recoveryId);
  if (!recovery) {
    throw createError({ statusCode: 404, statusMessage: 'No recovery window found.' });
  }

  const backup = await findBackupRegistrationById(pool, recovery.backup_reg_id);
  if (!backup) {
    throw createError({ statusCode: 404, statusMessage: 'No backup registration found.' });
  }

  if (recovery.status === 'released') {
    return { wrapped_blob: backup.wrapped_blob, keyring_id: backup.keyring_id };
  }
  if (recovery.status === 'cancelled') {
    throw createError({ statusCode: 410, statusMessage: 'Recovery was cancelled.' });
  }

  if (recovery.expires_at.getTime() > Date.now()) {
    const retryAfterSeconds = Math.ceil((recovery.expires_at.getTime() - Date.now()) / 1000);
    setResponseHeader(event, 'Retry-After', retryAfterSeconds);
    setResponseStatus(event, 425);
    return { error: 'Too early — the 72-hour cancellation window has not yet elapsed.', retry_after: retryAfterSeconds };
  }

  const released = await releaseRecoveryWindow(pool, recoveryId);
  if (!released) {
    // Lost the atomic race against a concurrent cancel — re-read to classify.
    const current = await findRecoveryWindowById(pool, recoveryId);
    if (current?.status === 'released') {
      return { wrapped_blob: backup.wrapped_blob, keyring_id: backup.keyring_id };
    }
    throw createError({ statusCode: 410, statusMessage: 'Recovery was cancelled.' });
  }

  auditLog('info', 'recovery_key_released', { recovery_id: recoveryId });

  return { wrapped_blob: backup.wrapped_blob, keyring_id: backup.keyring_id };
});
