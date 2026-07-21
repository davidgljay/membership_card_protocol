/**
 * Request-orchestration logic for POST /accounts/{card_hash}/backups
 * (implementation-plan.md §Step 3.1). Factored out of
 * server/routes/accounts/[card_hash]/backups/index.post.ts so the OHTTP
 * gateway (server/routes/ohttp/gateway.post.ts) can call the exact same
 * logic the plaintext route calls — same convention as
 * accounts-challenge.ts / keyring-challenge.ts.
 *
 * `setupWallet` always registers a synced-passkey backup as part of the
 * same continuous account-setup flow (see wallet-sdk's setupWallet.ts),
 * over the same oblivious transport as account creation and keyring
 * install — reachable through the gateway for the same IP-hiding reason
 * those are.
 *
 * Session-token auth (`requireSessionTokenRaw`'s H3-`event`-based header
 * read) doesn't apply directly here — there's no H3 event inside the
 * gateway dispatcher — so this takes the raw bearer token string instead;
 * the gateway extracts it from `OhttpEnvelope.headers.authorization`.
 */

import type { Pool } from 'pg';
import { findAccountByCardHash } from '../../server/db/accounts.js';
import { createBackupRegistration, type BackupType, type NotificationChannels } from '../../server/db/backups.js';
import { verifySessionToken } from '../auth/session-token.js';
import { createKvStore } from '../../server/utils/kv-store.js';
import { auditLog } from '../../server/utils/audit-log.js';
import { loadConfig } from '../config.js';

export interface CreateBackupBody {
  type?: BackupType;
  wrapped_blob?: string;
  keyring_id?: string;
  notification_channels?: NotificationChannels;
  cancellation_pubkey?: string;
}

export type CreateBackupOutcome =
  | { ok: true; backup_id: string }
  | { ok: false; statusCode: 400 | 401 | 403 | 404; statusMessage: string };

export async function handleCreateBackup(params: {
  pool: Pool;
  cardHash: string | undefined;
  authorizationHeader: string | undefined;
  body: CreateBackupBody | undefined;
}): Promise<CreateBackupOutcome> {
  const { pool, cardHash, authorizationHeader, body } = params;
  if (!cardHash) {
    return { ok: false, statusCode: 400, statusMessage: 'card_hash is required.' };
  }

  if (!authorizationHeader?.startsWith('Bearer ')) {
    return { ok: false, statusCode: 401, statusMessage: 'Missing bearer token.' };
  }
  const token = authorizationHeader.slice('Bearer '.length);
  const config = loadConfig();
  const kv = createKvStore();
  const verified = await verifySessionToken(token, config.SESSION_TOKEN_SECRET, kv);
  if (!verified.ok) {
    return { ok: false, statusCode: 401, statusMessage: `Invalid session token: ${verified.reason}.` };
  }
  if (verified.payload.card_hash !== cardHash) {
    return { ok: false, statusCode: 403, statusMessage: 'Session token does not authorize this card_hash.' };
  }

  const {
    type,
    wrapped_blob: wrappedBlob,
    keyring_id: keyringId,
    notification_channels: notificationChannels,
    cancellation_pubkey: cancellationPubkey,
  } = body ?? {};

  if (!type || (type !== 'synced_passkey' && type !== 'yubikey')) {
    return { ok: false, statusCode: 400, statusMessage: "type must be 'synced_passkey' or 'yubikey'." };
  }
  if (!wrappedBlob || !keyringId || !notificationChannels || !cancellationPubkey) {
    return {
      ok: false,
      statusCode: 400,
      statusMessage: 'wrapped_blob, keyring_id, notification_channels, and cancellation_pubkey are all required.',
    };
  }
  const hasChannel =
    !!notificationChannels.email ||
    !!notificationChannels.sms ||
    !!notificationChannels.webhook ||
    !!notificationChannels.secondary_contact;
  if (!hasChannel) {
    return { ok: false, statusCode: 400, statusMessage: 'At least one notification channel is required.' };
  }

  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    return { ok: false, statusCode: 404, statusMessage: 'No account found for this card_hash.' };
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

  return { ok: true, backup_id: backup.id };
}
