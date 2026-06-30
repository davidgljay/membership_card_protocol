/**
 * POST /auth/passkey/login — implementation-plan.md §Step 2.1.
 * Verifies a WebAuthn assertion against the holder's registered passkey
 * credential and issues a session token, used before service_secret
 * retrieval in the existing-wallet open-offer flow.
 */

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { loadConfig } from '../../../../src/config.js';
import { getPool } from '../../../db/client.js';
import { findAccountByCardHash, updateWebAuthnSignCount } from '../../../db/accounts.js';
import { consumeChallenge } from '../../../db/challenges.js';
import { verifyWebAuthnLogin } from '../../../../src/auth/webauthn.js';
import { issueSessionToken } from '../../../../src/auth/session-token.js';

interface LoginBody {
  card_hash?: string;
  challenge?: string;
  assertion?: AuthenticationResponseJSON;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<LoginBody>(event);
  const { card_hash: cardHash, challenge, assertion } = body ?? {};
  if (!cardHash || !challenge || !assertion) {
    throw createError({
      statusCode: 400,
      statusMessage: 'card_hash, challenge, and assertion are required.',
    });
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account || !account.webauthn_credential_id || !account.webauthn_public_key) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const consumed = await consumeChallenge(pool, 'passkey_login', cardHash, challenge);
  if (!consumed) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid or expired challenge.' });
  }

  const config = loadConfig();
  const result = await verifyWebAuthnLogin(
    assertion,
    challenge,
    config.WEBAUTHN_RP_ID,
    config.WEBAUTHN_ORIGIN,
    {
      id: account.webauthn_credential_id,
      publicKey: new Uint8Array(Buffer.from(account.webauthn_public_key, 'base64url')),
      counter: Number(account.webauthn_sign_count),
    }
  );

  if (!result.ok) {
    throw createError({ statusCode: 401, statusMessage: `WebAuthn verification failed: ${result.reason}.` });
  }

  await updateWebAuthnSignCount(pool, cardHash, result.newCounter);

  const { token, payload } = issueSessionToken(cardHash, config.SESSION_TOKEN_SECRET);

  return { session_token: token, expires_at: new Date(payload.expires_at).toISOString() };
});
