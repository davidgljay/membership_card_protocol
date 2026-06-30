/**
 * POST /federation/keyrings/delete — implementation-plan.md §Step 4.1a.
 * Receives a signed delete instruction for a superseded keyring_id from a
 * peer wallet service. Idempotent: deleting an already-absent keyring_id
 * returns success.
 */

import { getPool } from '../../../db/client.js';
import { deleteKeyringBlob } from '../../../db/keyrings.js';
import { verifySignedKeyringMessage, type SignedKeyringDeleteMessage } from '../../../../src/federation/keyring-sync.js';

export default defineEventHandler(async (event) => {
  const message = await readBody<SignedKeyringDeleteMessage>(event);
  if (!message?.payload?.keyring_id) {
    throw createError({ statusCode: 400, statusMessage: 'payload.keyring_id is required.' });
  }

  if (!verifySignedKeyringMessage(message)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature.' });
  }

  const pool = getPool();
  await deleteKeyringBlob(pool, message.payload.keyring_id);

  console.info(`[wallet-service] federation keyring replica deleted keyring_id=${message.payload.keyring_id}`);

  return { deleted: true };
});
