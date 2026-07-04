/**
 * Request-orchestration logic for POST /accounts/challenge
 * (implementation-plan.md §Step 2.2, §Step 6.1).
 *
 * Factored out of server/routes/accounts/challenge.post.ts (client-sdk
 * implementation plan Step 1.4c) so the OHTTP gateway
 * (server/routes/ohttp/gateway.post.ts) can call the exact same logic the
 * plaintext route calls — same convention already established by
 * src/routes/subcard-uuid-registration.ts / subcard-deregistration.ts.
 *
 * Pure of any H3/Nitro dependency (no createError/enforceRateLimit,
 * which rely on Nitro's build-time auto-imports and aren't available
 * under plain vitest — same reason subcard-uuid-registration.ts avoids
 * them) — calls checkSlidingWindow directly instead of the
 * enforceRateLimit H3 wrapper, and returns a discriminated outcome the
 * caller (route file or gateway) turns into an H3 error / sealed error
 * response respectively.
 */

import type { Pool } from 'pg';
import { issueChallenge } from '../../server/db/challenges.js';
import { checkSlidingWindow } from '../../server/utils/rate-limit.js';
import { createKvStore } from '../../server/utils/kv-store.js';
import { auditLog } from '../../server/utils/audit-log.js';
import { kvKeys } from '../kv.js';
import { hashIp } from '../crypto.js';

const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;

export type AccountsChallengeOutcome =
  | { ok: true; challenge: string; expires_at: string }
  | { ok: false; statusCode: 429; statusMessage: string; retryAfterSeconds: number };

export async function handleAccountsChallenge(params: {
  pool: Pool;
  ip: string;
}): Promise<AccountsChallengeOutcome> {
  const { pool, ip } = params;

  const rateKey = kvKeys.accountCreationRate(hashIp(ip));
  const rate = await checkSlidingWindow(createKvStore(), rateKey, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) {
    auditLog('warn', 'rate_limit_exceeded', {
      key: rateKey,
      limit: RATE_LIMIT,
      window_seconds: RATE_WINDOW_SECONDS,
    });
    return {
      ok: false,
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  const { challenge, expiresAt } = await issueChallenge(pool, 'account_creation', null);
  return { ok: true, challenge, expires_at: expiresAt.toISOString() };
}
