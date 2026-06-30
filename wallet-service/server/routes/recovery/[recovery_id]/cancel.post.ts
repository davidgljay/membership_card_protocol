/**
 * POST /recovery/{recovery_id}/cancel — implementation-plan.md §Step 3.4.
 * Cancellation credential is the master card key (OQ-WS-6, resolved):
 * `challenge` is the recovery_id's UTF-8 bytes, base64url; `signature` is
 * an ML-DSA-44 signature over those bytes, verified against the
 * `cancellation_pubkey` registered with the backup.
 */

import { getPool } from '../../../db/client.js';
import { findRecoveryWindowById, cancelRecoveryWindow } from '../../../db/recovery.js';
import { findBackupRegistrationById } from '../../../db/backups.js';
import { verifyMasterCardSignature } from '../../../../src/auth/master-card-signature.js';
import { fanOutRecoveryNotifications } from '../../../utils/notification-fanout.js';

interface CancelBody {
  challenge?: string;
  signature?: string;
}

export default defineEventHandler(async (event) => {
  const recoveryId = getRouterParam(event, 'recovery_id');
  if (!recoveryId) {
    throw createError({ statusCode: 400, statusMessage: 'recovery_id is required.' });
  }

  const body = await readBody<CancelBody>(event);
  const { challenge, signature } = body ?? {};
  if (!challenge || !signature) {
    throw createError({ statusCode: 400, statusMessage: 'challenge and signature are required.' });
  }

  // The challenge is defined as the recovery_id's own bytes — verify the
  // caller is signing *this* recovery's id, not replaying a signature
  // captured for a different window.
  let challengeText: string;
  try {
    challengeText = Buffer.from(challenge, 'base64url').toString('utf8');
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'challenge is not valid base64url.' });
  }
  if (challengeText !== recoveryId) {
    throw createError({ statusCode: 401, statusMessage: 'challenge does not match recovery_id.' });
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

  const challengeBytes = new Uint8Array(Buffer.from(challenge, 'base64url'));
  const validSignature = verifyMasterCardSignature(challengeBytes, signature, backup.cancellation_pubkey);
  if (!validSignature) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid cancellation signature.' });
  }

  const cancelled = await cancelRecoveryWindow(pool, recoveryId);
  if (!cancelled) {
    // Lost the atomic race, or the window was never cancellable — re-read to classify.
    const current = await findRecoveryWindowById(pool, recoveryId);
    if (current?.status === 'cancelled') {
      return { cancelled: true };
    }
    throw createError({ statusCode: 410, statusMessage: 'Recovery window can no longer be cancelled.' });
  }

  await fanOutRecoveryNotifications(pool, cancelled, backup, 'cancellation_confirmed');

  console.info(`[wallet-service] recovery cancelled recovery_id=${recoveryId}`);

  return { cancelled: true };
});
