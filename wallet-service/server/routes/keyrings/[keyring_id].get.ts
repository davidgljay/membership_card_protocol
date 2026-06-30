/**
 * GET /keyrings/{keyring_id} — implementation-plan.md §Step 4.1a.
 * Holder-facing endpoint, called during recovery (Step 3.5's release flow
 * hands the client a keyring_id; the client then fetches the blob itself).
 * Serves any keyring_id this instance holds a replica of, regardless of
 * whether the requesting holder's primary service is this instance — that
 * is the entire point of replication.
 */

import { getPool } from '../../db/client.js';
import { findKeyringBlob } from '../../db/keyrings.js';

export default defineEventHandler(async (event) => {
  const keyringId = getRouterParam(event, 'keyring_id');
  if (!keyringId) {
    throw createError({ statusCode: 400, statusMessage: 'keyring_id is required.' });
  }

  const pool = getPool();
  const blob = await findKeyringBlob(pool, keyringId);
  if (!blob) {
    throw createError({ statusCode: 404, statusMessage: 'No replica of this keyring_id held locally.' });
  }

  return { encrypted_blob: blob.encrypted_blob };
});
