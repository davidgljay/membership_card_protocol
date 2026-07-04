/**
 * POST /accounts — implementation-plan.md §Step 2.2 (resolved CP-1).
 * Creates a holder account for the new-wallet open-offer acceptance path
 * (open_offer_acceptance_new_wallet.md §Phase 2 Steps 6-10). Authenticated
 * by the freshly-generated master card key signing the challenge from
 * POST /accounts/challenge — proves control of the key being registered.
 * No external registration token; see strategic-plan.md OQ-WS-1.
 *
 * Thin H3 adapter — all logic lives in
 * ../../../src/routes/accounts-create.ts (client-sdk implementation plan
 * Step 1.4c), callable identically from here and from the OHTTP gateway
 * (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../db/client.js';
import {
  handleAccountsCreate,
  type RawCreateAccountBody,
} from '../../../src/routes/accounts-create.js';

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
  const rawBody = await readBody<RawCreateAccountBody>(event);
  const outcome = await handleAccountsCreate({ pool: getPool(), ip, rawBody });

  if (!outcome.ok) {
    if (outcome.retryAfterSeconds !== undefined) {
      setResponseHeader(event, 'Retry-After', outcome.retryAfterSeconds);
    }
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  const { ok: _ok, ...body } = outcome;
  return body;
});
