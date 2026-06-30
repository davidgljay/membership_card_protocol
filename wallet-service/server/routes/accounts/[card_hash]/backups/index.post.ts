/**
 * POST /accounts/{card_hash}/backups — implementation-plan.md §Step 3.1.
 * Stores a wrapped decryption key blob; the wallet service never decrypts
 * it. Session-token authenticated.
 */

import { requireSessionTokenRaw, AuthError } from '../../../../utils/auth.js';
import { getPool } from '../../../../db/client.js';
import { findAccountByCardHash } from '../../../../db/accounts.js';
import { createBackupRegistration, type BackupType, type NotificationChannels } from '../../../../db/backups.js';
import { auditLog } from '../../../../utils/audit-log.js';

interface CreateBackupBody {
  type?: BackupType;
  wrapped_blob?: string;
  keyring_id?: string;
  notification_channels?: NotificationChannels;
  cancellation_pubkey?: string;
}

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
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

  const body = await readBody<CreateBackupBody>(event);
  const {
    type,
    wrapped_blob: wrappedBlob,
    keyring_id: keyringId,
    notification_channels: notificationChannels,
    cancellation_pubkey: cancellationPubkey,
  } = body ?? {};

  if (!type || (type !== 'synced_passkey' && type !== 'yubikey')) {
    throw createError({ statusCode: 400, statusMessage: "type must be 'synced_passkey' or 'yubikey'." });
  }
  if (!wrappedBlob || !keyringId || !notificationChannels || !cancellationPubkey) {
    throw createError({
      statusCode: 400,
      statusMessage: 'wrapped_blob, keyring_id, notification_channels, and cancellation_pubkey are all required.',
    });
  }
  const hasChannel =
    !!notificationChannels.email ||
    !!notificationChannels.sms ||
    !!notificationChannels.webhook ||
    !!notificationChannels.secondary_contact;
  if (!hasChannel) {
    throw createError({ statusCode: 400, statusMessage: 'At least one notification channel is required.' });
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const backup = await createBackupRegistration(pool, {
    holderId: account.id,
    type,
    wrappedBlob,
    keyringId,
    notificationChannels,
    cancellationPubkey,
  });

  auditLog('info', 'backup_registration_created', { card_hash: cardHash, type, backup_id: backup.id });

  return { backup_id: backup.id };
});
