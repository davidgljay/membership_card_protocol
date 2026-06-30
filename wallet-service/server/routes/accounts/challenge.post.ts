/**
 * POST /accounts/challenge — implementation-plan.md §Step 2.2, §Step 6.1.
 * Unauthenticated — there is no account yet to authenticate against.
 * Rate-limited by (hashed) IP — supplementary to the explicit 5/IP/hour
 * limit on POST /accounts itself; this bounds challenge issuance, the
 * cheaper of the two calls, at the same rate.
 */

import { getPool } from '../../db/client.js';
import { issueChallenge } from '../../db/challenges.js';
import { enforceRateLimit } from '../../utils/enforce-rate-limit.js';
import { kvKeys } from '../../../src/kv.js';
import { hashIp } from '../../../src/crypto.js';

const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
  await enforceRateLimit(event, kvKeys.accountCreationRate(hashIp(ip)), RATE_LIMIT, RATE_WINDOW_SECONDS);

  const pool = getPool();
  const { challenge, expiresAt } = await issueChallenge(pool, 'account_creation', null);

  return { challenge, expires_at: expiresAt.toISOString() };
});
