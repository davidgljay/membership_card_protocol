/**
 * Verifies inbound calls to wallet-service's AS transaction-push endpoint
 * (matrix-implementation-plan.md Phase 4 Step 15a). Per the Matrix
 * Application Service spec, Synapse authenticates itself to the AS with a
 * bearer token equal to this AS's own hs_token, supplied either as an
 * `Authorization: Bearer <token>` header or an `access_token` query param.
 * Pure/H3-agnostic (same convention as src/routes/accounts-challenge.ts)
 * so it's testable without Nitro's auto-imports.
 */

import { timingSafeEqual } from 'node:crypto';

export function verifyHomeserverToken(providedToken: string | undefined, expectedHsToken: string): boolean {
  if (!providedToken) return false;
  const providedBuf = Buffer.from(providedToken);
  const expectedBuf = Buffer.from(expectedHsToken);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
