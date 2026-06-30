/**
 * POST /auth/passkey/challenge — implementation-plan.md §Step 2.1.
 * Issues a WebAuthn assertion challenge for an existing-wallet login.
 * Unauthenticated (that's the point — this is how the device proves it's
 * authenticated), rate-limited by card_hash.
 */

import { getPool } from '../../../db/client.js';
import { findAccountByCardHash } from '../../../db/accounts.js';
import { issueChallenge } from '../../../db/challenges.js';
import { createKvStore } from '../../../utils/kv-store.js';
import { checkAndIncrement } from '../../../utils/rate-limit.js';
import { kvKeys } from '../../../../src/kv.js';

const RATE_LIMIT = 20;
const RATE_WINDOW_SECONDS = 60 * 60;

export default defineEventHandler(async (event) => {
  const body = await readBody<{ card_hash?: string }>(event);
  const cardHash = body?.card_hash;
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  const kv = createKvStore();
  const allowed = await checkAndIncrement(
    kv,
    kvKeys.challengeRate('passkey_login', cardHash),
    RATE_LIMIT,
    RATE_WINDOW_SECONDS
  );
  if (!allowed) {
    setResponseStatus(event, 429);
    return { error: 'Too many login attempts. Try again later.' };
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account || !account.webauthn_credential_id) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const { challenge, expiresAt } = await issueChallenge(pool, 'passkey_login', cardHash);

  return {
    challenge,
    credential_id: account.webauthn_credential_id,
    expires_at: expiresAt.toISOString(),
  };
});
