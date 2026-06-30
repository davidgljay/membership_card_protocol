/**
 * GET /accounts/{card_hash}/service-secret — implementation-plan.md §Step 2.3.
 * Session-token authenticated. Rate-limited to 10 calls per session token
 * lifetime (the token itself expires after 15 minutes regardless).
 */

import { requireSessionTokenRaw, AuthError } from '../../../utils/auth.js';
import { sessionTokenId } from '../../../../src/auth/session-token.js';
import { getPool } from '../../../db/client.js';
import { findAccountByCardHash } from '../../../db/accounts.js';
import { getSecretsService } from '../../../utils/secrets.js';
import { createKvStore } from '../../../utils/kv-store.js';
import { checkAndIncrement } from '../../../utils/rate-limit.js';
import { kvKeys } from '../../../../src/kv.js';

const SESSION_TTL_SECONDS = 15 * 60;
const CALLS_PER_SESSION = 10;

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  let session;
  try {
    session = await requireSessionTokenRaw(event);
  } catch (err) {
    if (err instanceof AuthError) {
      throw createError({ statusCode: err.statusCode, statusMessage: err.message });
    }
    throw err;
  }

  if (session.payload.card_hash !== cardHash) {
    throw createError({ statusCode: 403, statusMessage: 'Session token does not authorize this card_hash.' });
  }

  const kv = createKvStore();
  const allowed = await checkAndIncrement(
    kv,
    kvKeys.serviceSecretCalls(sessionTokenId(session.token)),
    CALLS_PER_SESSION,
    SESSION_TTL_SECONDS
  );
  if (!allowed) {
    setResponseStatus(event, 429);
    return { error: 'service_secret retrieval limit reached for this session.' };
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const secretsService = getSecretsService();
  const plaintext = await secretsService.decryptSecret(
    account.service_secret_enc,
    account.service_secret_dek_enc
  );

  // Log: access event only — no key material (Step 6.2 invariant).
  console.info(`[wallet-service] service_secret accessed card_hash=${cardHash}`);

  return { service_secret: plaintext.toString('base64url') };
});
