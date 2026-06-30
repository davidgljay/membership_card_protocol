/**
 * GET /accounts/{card_hash}/service-secret — implementation-plan.md §Step
 * 2.3, §Step 6.1. Session-token authenticated. Rate-limited to 10 calls
 * per session token lifetime (the token itself expires after 15 minutes
 * regardless).
 */

import { requireSessionTokenRaw, AuthError } from '../../../utils/auth.js';
import { sessionTokenId } from '../../../../src/auth/session-token.js';
import { getPool } from '../../../db/client.js';
import { findAccountByCardHash } from '../../../db/accounts.js';
import { getSecretsService } from '../../../utils/secrets.js';
import { enforceRateLimit } from '../../../utils/enforce-rate-limit.js';
import { kvKeys } from '../../../../src/kv.js';
import { auditLog } from '../../../utils/audit-log.js';

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

  await enforceRateLimit(
    event,
    kvKeys.serviceSecretCalls(sessionTokenId(session.token)),
    CALLS_PER_SESSION,
    SESSION_TTL_SECONDS
  );

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const secretsService = getSecretsService();
  let plaintext;
  try {
    plaintext = await secretsService.decryptSecret(account.service_secret_enc, account.service_secret_dek_enc);
  } catch (err) {
    auditLog('error', 'secrets_backend_failure', { operation: 'decryptSecret', card_hash: cardHash, error: String(err) });
    throw err;
  }

  // Audit log: access event only — card_hash + non-reversible session_token_id, no key material (Step 6.2).
  auditLog('info', 'service_secret_accessed', { card_hash: cardHash, session_token_id: sessionTokenId(session.token) });

  return { service_secret: plaintext.toString('base64url') };
});
