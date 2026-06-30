/**
 * POST /accounts — implementation-plan.md §Step 2.2 (resolved CP-1).
 * Creates a holder account for the new-wallet open-offer acceptance path
 * (open_offer_acceptance_new_wallet.md §Phase 2 Steps 6-10). Authenticated
 * by the freshly-generated master card key signing the challenge from
 * POST /accounts/challenge — proves control of the key being registered.
 * No external registration token; see strategic-plan.md OQ-WS-1.
 */

import { getPool } from '../../db/client.js';
import { findAccountByCardHash, createAccount } from '../../db/accounts.js';
import { insertKeyringBlob } from '../../db/keyrings.js';
import { consumeChallenge } from '../../db/challenges.js';
import { verifyMasterCardSignature } from '../../../src/auth/master-card-signature.js';
import { issueSessionToken } from '../../../src/auth/session-token.js';
import { keccak256OfBase64Url } from '../../../src/crypto.js';
import { getSecretsService } from '../../utils/secrets.js';
import { loadConfig } from '../../../src/config.js';

interface CreateAccountBody {
  challenge?: string;
  signature?: string;
  card_hash?: string;
  master_pubkey?: string;
  webauthn_credential_id?: string;
  webauthn_public_key?: string;
  encrypted_keyring_blob?: string;
}

const SERVICE_SECRET_BYTES = 32;

export default defineEventHandler(async (event) => {
  const body = await readBody<CreateAccountBody>(event);
  const {
    challenge,
    signature,
    card_hash: cardHash,
    master_pubkey: masterPubkey,
    webauthn_credential_id: webauthnCredentialId,
    webauthn_public_key: webauthnPublicKey,
    encrypted_keyring_blob: encryptedKeyringBlob,
  } = body ?? {};

  if (
    !challenge ||
    !signature ||
    !cardHash ||
    !masterPubkey ||
    !webauthnCredentialId ||
    !webauthnPublicKey ||
    !encryptedKeyringBlob
  ) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'challenge, signature, card_hash, master_pubkey, webauthn_credential_id, webauthn_public_key, and encrypted_keyring_blob are all required.',
    });
  }

  const pool = getPool();

  const consumed = await consumeChallenge(pool, 'account_creation', null, challenge);
  if (!consumed) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid or expired challenge.' });
  }

  const challengeBytes = new Uint8Array(Buffer.from(challenge, 'base64url'));
  const validSignature = verifyMasterCardSignature(challengeBytes, signature, masterPubkey);
  if (!validSignature) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid master card key signature.' });
  }

  const existing = await findAccountByCardHash(pool, cardHash);
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'An account already exists for this card_hash.' });
  }

  const keyringId = keccak256OfBase64Url(encryptedKeyringBlob);

  const secretsService = getSecretsService();
  const serviceSecretPlain = crypto.getRandomValues(new Uint8Array(SERVICE_SECRET_BYTES));
  const { ciphertext, dekEnc } = await secretsService.encryptSecret(Buffer.from(serviceSecretPlain));

  let account;
  try {
    account = await createAccount(pool, {
      cardHash,
      masterPubkey,
      keyringId,
      serviceSecretEnc: ciphertext,
      serviceSecretDekEnc: dekEnc,
      webauthnCredentialId,
      webauthnPublicKey,
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === '23505') {
      // Unique violation — either card_hash (race with the check above) or
      // webauthn_credential_id (a credential id collision, vanishingly
      // unlikely for a properly random WebAuthn credential).
      throw createError({ statusCode: 409, statusMessage: 'Account or credential already registered.' });
    }
    throw err;
  }

  await insertKeyringBlob(pool, keyringId, cardHash, encryptedKeyringBlob);
  // Federation broadcast to peer wallet services (Step 4.1a) lands in Phase 4.

  const config = loadConfig();
  const { token, payload } = issueSessionToken(cardHash, config.SESSION_TOKEN_SECRET);

  // Log: account creation event only — no key material, no request/response body (Step 6.2 invariant).
  console.info(`[wallet-service] account created card_hash=${cardHash}`);

  return {
    service_secret: Buffer.from(serviceSecretPlain).toString('base64url'),
    account_id: account.id,
    keyring_id: keyringId,
    session_token: token,
    expires_at: new Date(payload.expires_at).toISOString(),
  };
});
