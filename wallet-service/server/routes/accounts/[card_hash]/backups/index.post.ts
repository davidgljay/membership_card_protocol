/**
 * POST /accounts/{card_hash}/backups — implementation-plan.md §Step 3.1.
 * Stores a wrapped decryption key blob; the wallet service never decrypts
 * it. Session-token authenticated.
 *
 * Thin H3 adapter — all logic lives in
 * ../../../../../src/routes/create-backup.ts, callable identically from
 * here and from the OHTTP gateway (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../../../db/client.js';
import { handleCreateBackup, type CreateBackupBody } from '../../../../../src/routes/create-backup.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const body = await readBody<CreateBackupBody>(event);
  const outcome = await handleCreateBackup({
    pool: getPool(),
    cardHash,
    authorizationHeader: getHeader(event, 'authorization'),
    body,
  });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  return { backup_id: outcome.backup_id };
});
