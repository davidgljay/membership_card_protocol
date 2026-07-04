/**
 * GET /keyrings/{keyring_id} — implementation-plan.md §Step 4.1a.
 * Holder-facing endpoint, called during recovery (Step 3.5's release flow
 * hands the client a keyring_id; the client then fetches the blob itself).
 * Serves any keyring_id this instance holds a replica of, regardless of
 * whether the requesting holder's primary service is this instance — that
 * is the entire point of replication.
 *
 * Thin H3 adapter — all logic lives in ../../../src/routes/keyrings-get.ts
 * (client-sdk implementation plan Step 1.4c), callable identically from
 * here and from the OHTTP gateway (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../db/client.js';
import { handleKeyringsGet } from '../../../src/routes/keyrings-get.js';

export default defineEventHandler(async (event) => {
  const keyringId = getRouterParam(event, 'keyring_id');
  const outcome = await handleKeyringsGet({ pool: getPool(), keyringId });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  return { encrypted_blob: outcome.encrypted_blob };
});
