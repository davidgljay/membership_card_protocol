/**
 * POST /federation/keyrings — implementation-plan.md §Step 4.1a.
 * Receives a signed keyring blob replica from a peer wallet service.
 * Idempotent: re-receiving the same keyring_id is a no-op
 * (insertKeyringBlob's ON CONFLICT DO NOTHING).
 */

import { getPool } from '../../../db/client.js';
import { insertKeyringBlob } from '../../../db/keyrings.js';
import { verifySignedKeyringMessage, type SignedKeyringMessage } from '../../../../src/federation/keyring-sync.js';

export default defineEventHandler(async (event) => {
  const message = await readBody<SignedKeyringMessage>(event);
  if (!message?.payload?.keyring_id || !message.payload.card_hash || !message.payload.encrypted_blob) {
    throw createError({ statusCode: 400, statusMessage: 'payload.keyring_id, card_hash, and encrypted_blob are required.' });
  }

  if (!verifySignedKeyringMessage(message)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature.' });
  }

  const pool = getPool();
  await insertKeyringBlob(pool, message.payload.keyring_id, message.payload.card_hash, message.payload.encrypted_blob);

  console.info(`[wallet-service] federation keyring replica stored keyring_id=${message.payload.keyring_id}`);

  return { stored: true };
});
