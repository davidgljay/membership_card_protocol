/**
 * POST /accounts/{card_hash}/keyring/challenge — implementation-plan.md §Step 2.4.
 * Issues a challenge for the post-recovery keyring rotation flow.
 */

import { getPool } from '../../../../db/client.js';
import { findAccountByCardHash } from '../../../../db/accounts.js';
import { issueChallenge } from '../../../../db/challenges.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const { challenge, expiresAt } = await issueChallenge(pool, 'keyring_rotation', cardHash);

  return { challenge, expires_at: expiresAt.toISOString() };
});
