/**
 * POST /accounts/{card_hash}/recovery — implementation-plan.md §Step 3.2.
 * Initiates recovery for a specific backup registration. No session token
 * required — this is called by someone who may not have their device.
 * Only one active recovery window is allowed per backup registration at a
 * time.
 */

import { getPool } from '../../../db/client.js';
import { findAccountByCardHash } from '../../../db/accounts.js';
import { findBackupRegistrationById } from '../../../db/backups.js';
import { findActiveRecoveryWindow, createRecoveryWindow } from '../../../db/recovery.js';
import { fanOutRecoveryNotifications } from '../../../utils/notification-fanout.js';
import { enforceRateLimit } from '../../../utils/enforce-rate-limit.js';
import { kvKeys } from '../../../../src/kv.js';
import { auditLog } from '../../../utils/audit-log.js';

const RECOVERY_RATE_LIMIT = 3;
const RECOVERY_RATE_WINDOW_SECONDS = 24 * 60 * 60;

interface InitiateRecoveryBody {
  backup_id?: string;
}

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  const body = await readBody<InitiateRecoveryBody>(event);
  const backupId = body?.backup_id;
  if (!backupId) {
    throw createError({ statusCode: 400, statusMessage: 'backup_id is required.' });
  }

  await enforceRateLimit(
    event,
    kvKeys.recoveryInitiationRate(cardHash),
    RECOVERY_RATE_LIMIT,
    RECOVERY_RATE_WINDOW_SECONDS
  );

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const backup = await findBackupRegistrationById(pool, backupId);
  if (!backup || backup.holder_id !== account.id) {
    throw createError({ statusCode: 404, statusMessage: 'No backup registration found.' });
  }

  const active = await findActiveRecoveryWindow(pool, backup.id);
  if (active) {
    setResponseStatus(event, 409);
    return { recovery_id: active.id, expires_at: active.expires_at.toISOString() };
  }

  const recovery = await createRecoveryWindow(pool, backup.id);
  const notifiedChannels = await fanOutRecoveryNotifications(pool, recovery, backup, 'recovery_initiated');

  auditLog('info', 'recovery_initiated', { card_hash: cardHash, recovery_id: recovery.id });

  return {
    recovery_id: recovery.id,
    expires_at: recovery.expires_at.toISOString(),
    notified_channels: notifiedChannels,
  };
});
