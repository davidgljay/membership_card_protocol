/**
 * PUT /matrix/transactions/{txnId} — wallet-service's Matrix Application
 * Service transaction-push endpoint (matrix-implementation-plan.md Phase 4
 * Step 15a). This is the `url` matrix/appservice-registration.yaml.template
 * points Synapse at; Synapse PUTs every event relevant to this AS's
 * namespaces here.
 *
 * Per the Matrix AS spec, Synapse authenticates itself to the AS with a
 * bearer token equal to this AS's own hs_token, as either an
 * `Authorization: Bearer <token>` header or an `access_token` query param.
 * Verified here (src/matrix/appservice-auth.ts) against
 * matrix/secrets/appservice-hs-token.txt; rejects with 401 on mismatch.
 *
 * Full event-driven bridge logic (parsing/acting on the pushed transaction
 * body) is explicitly out of scope for this pass — clients talk to Synapse
 * directly for sync/send once they hold a token from
 * POST /matrix/token (Step 15c). This handler only acknowledges receipt
 * (`{}`, 200) so Synapse doesn't retry the same transaction.
 */

import { verifyHomeserverToken } from '../../../../src/matrix/appservice-auth.js';
import { readAppServiceHsToken } from '../../../../src/matrix/appservice-tokens.js';

export default defineEventHandler(async (event) => {
  const authHeader = getHeader(event, 'authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

  const query = getQuery(event);
  const queryToken = typeof query['access_token'] === 'string' ? query['access_token'] : undefined;

  const providedToken = bearerToken ?? queryToken;
  const expectedHsToken = readAppServiceHsToken();

  if (!verifyHomeserverToken(providedToken, expectedHsToken)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  // Full event-driven bridge logic is out of scope for this pass (Step 15a).
  return {};
});
