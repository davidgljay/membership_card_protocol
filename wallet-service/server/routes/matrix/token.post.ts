/**
 * POST /matrix/token — mints (or returns a cached, still-valid) Matrix
 * access token for the caller's own shadow account
 * (matrix-implementation-plan.md Phase 4 Step 15c). client-sdk uses this
 * to talk to Synapse directly (sync/send) once it holds a token.
 *
 * Thin H3 adapter — logic lives in src/matrix/provisioning.ts (ensures the
 * shadow account exists) and src/matrix/token-minting.ts (mints/caches the
 * token), same thin-route/pure-src split as
 * server/routes/accounts/challenge.post.ts.
 *
 * Session-token authenticated: the shadow account minted for is always
 * `deriveMatrixUserId(session.card_hash, ...)` — derived entirely from the
 * caller's own verified session, never a request body param — so a caller
 * can never mint a token for any shadow account but their own. Never
 * returns the AS token itself, only a token scoped to that one shadow
 * account.
 */

import { requireSessionToken, AuthError } from '../../utils/auth.js';
import { createKvStore } from '../../utils/kv-store.js';
import { loadConfig } from '../../../src/config.js';
import { provisionShadowAccount } from '../../../src/matrix/provisioning.js';
import { mintMatrixAccessToken } from '../../../src/matrix/token-minting.js';

export default defineEventHandler(async (event) => {
  let session;
  try {
    session = await requireSessionToken(event);
  } catch (err) {
    if (err instanceof AuthError) {
      throw createError({ statusCode: err.statusCode, statusMessage: err.message });
    }
    throw err;
  }

  const config = loadConfig();

  const { matrixUserId } = await provisionShadowAccount({
    cardHash: session.card_hash,
    serverName: config.MATRIX_SERVER_NAME,
    synapseBaseUrl: config.MATRIX_SYNAPSE_URL,
  });

  const kv = createKvStore();
  const { matrixAccessToken } = await mintMatrixAccessToken({
    matrixUserId,
    synapseBaseUrl: config.MATRIX_SYNAPSE_URL,
    kv,
  });

  return { matrix_access_token: matrixAccessToken, matrix_user_id: matrixUserId };
});
