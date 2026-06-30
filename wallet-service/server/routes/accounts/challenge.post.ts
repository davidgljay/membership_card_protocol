/**
 * POST /accounts/challenge — implementation-plan.md §Step 2.2.
 * Unauthenticated — there is no account yet to authenticate against.
 * Rate-limited by IP.
 */

import { getPool } from '../../db/client.js';
import { issueChallenge } from '../../db/challenges.js';
import { createKvStore } from '../../utils/kv-store.js';
import { checkAndIncrement } from '../../utils/rate-limit.js';
import { kvKeys } from '../../../src/kv.js';

const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';

  const kv = createKvStore();
  const allowed = await checkAndIncrement(
    kv,
    kvKeys.challengeRate('account_creation', ip),
    RATE_LIMIT,
    RATE_WINDOW_SECONDS
  );
  if (!allowed) {
    setResponseStatus(event, 429);
    return { error: 'Too many account creation attempts. Try again later.' };
  }

  const pool = getPool();
  const { challenge, expiresAt } = await issueChallenge(pool, 'account_creation', null);

  return { challenge, expires_at: expiresAt.toISOString() };
});
