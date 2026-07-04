/**
 * POST /accounts/challenge — implementation-plan.md §Step 2.2, §Step 6.1.
 * Unauthenticated — there is no account yet to authenticate against.
 * Rate-limited by (hashed) IP — supplementary to the explicit 5/IP/hour
 * limit on POST /accounts itself; this bounds challenge issuance, the
 * cheaper of the two calls, at the same rate.
 *
 * Thin H3 adapter — all logic lives in
 * ../../../src/routes/accounts-challenge.ts (client-sdk implementation
 * plan Step 1.4c), callable identically from here and from the OHTTP
 * gateway (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../db/client.js';
import { handleAccountsChallenge } from '../../../src/routes/accounts-challenge.js';

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
  const outcome = await handleAccountsChallenge({ pool: getPool(), ip });

  if (!outcome.ok) {
    setResponseHeader(event, 'Retry-After', outcome.retryAfterSeconds);
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  return { challenge: outcome.challenge, expires_at: outcome.expires_at };
});
