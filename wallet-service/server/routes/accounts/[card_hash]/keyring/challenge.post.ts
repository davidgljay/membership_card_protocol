/**
 * POST /accounts/{card_hash}/keyring/challenge — implementation-plan.md §Step 2.4.
 * Issues a challenge for the post-recovery keyring rotation flow.
 *
 * Thin H3 adapter — all logic lives in
 * ../../../../../src/routes/keyring-challenge.ts, callable identically from
 * here and from the OHTTP gateway (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../../../db/client.js';
import { handleKeyringChallenge } from '../../../../../src/routes/keyring-challenge.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const outcome = await handleKeyringChallenge({ pool: getPool(), cardHash });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  return { challenge: outcome.challenge, expires_at: outcome.expires_at };
});
