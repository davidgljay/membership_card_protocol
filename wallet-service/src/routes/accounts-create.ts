/**
 * Request-orchestration logic for POST /accounts
 * (implementation-plan.md §Step 2.2, resolved CP-1).
 *
 * Factored out of server/routes/accounts/index.post.ts (client-sdk
 * implementation plan Step 1.4c) — see accounts-challenge.ts's doc for the
 * convention this follows (no createError/enforceRateLimit — not
 * available under plain vitest — a discriminated outcome instead). Logic
 * is otherwise unchanged from the original route, only moved.
 */

import type { Pool } from 'pg';
import { findAccountByCardHash, createAccount } from '../../server/db/accounts.js';
import { insertKeyringBlob } from '../../server/db/keyrings.js';
import { consumeChallenge } from '../../server/db/challenges.js';
import { verifyMasterCardSignature } from '../auth/master-card-signature.js';
import { issueSessionToken } from '../auth/session-token.js';
import { keccak256OfBase64Url, hashIp } from '../crypto.js';
import { getSecretsService } from '../../server/utils/secrets.js';
import { loadConfig, type WalletServiceConfig } from '../config.js';
import {
  announceOwnCardRegistration,
  replicateKeyringBlob,
} from '../../server/utils/federation-self.js';
import { checkSlidingWindow } from '../../server/utils/rate-limit.js';
import { createKvStore } from '../../server/utils/kv-store.js';
import { kvKeys } from '../kv.js';
import { auditLog } from '../../server/utils/audit-log.js';

const ACCOUNT_CREATION_RATE_LIMIT = 5;
const ACCOUNT_CREATION_RATE_WINDOW_SECONDS = 60 * 60;
const SERVICE_SECRET_BYTES = 32;

export interface RawCreateAccountBody {
  challenge?: string;
  signature?: string;
  card_hash?: string;
  master_pubkey?: string;
  webauthn_credential_id?: string;
  webauthn_public_key?: string;
  encrypted_keyring_blob?: string;
}

export type AccountsCreateOutcome =
  | {
      ok: true;
      service_secret: string;
      account_id: number | string;
      keyring_id: string;
      session_token: string;
      expires_at: string;
    }
  | { ok: false; statusCode: 400 | 401 | 409 | 429; statusMessage: string; retryAfterSeconds?: number };

export async function handleAccountsCreate(params: {
  pool: Pool;
  config?: WalletServiceConfig;
  ip: string;
  rawBody: RawCreateAccountBody | null | undefined;
}): Promise<AccountsCreateOutcome> {
  const { pool, ip, rawBody } = params;
  const config = params.config ?? loadConfig();

  const rateKey = kvKeys.accountCreationRate(hashIp(ip));
  const rate = await checkSlidingWindow(
    createKvStore(),
    rateKey,
    ACCOUNT_CREATION_RATE_LIMIT,
    ACCOUNT_CREATION_RATE_WINDOW_SECONDS
  );
  if (!rate.allowed) {
    auditLog('warn', 'rate_limit_exceeded', {
      key: rateKey,
      limit: ACCOUNT_CREATION_RATE_LIMIT,
      window_seconds: ACCOUNT_CREATION_RATE_WINDOW_SECONDS,
    });
    return {
      ok: false,
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  const {
    challenge,
    signature,
    card_hash: cardHash,
    master_pubkey: masterPubkey,
    webauthn_credential_id: webauthnCredentialId,
    webauthn_public_key: webauthnPublicKey,
    encrypted_keyring_blob: encryptedKeyringBlob,
  } = rawBody ?? {};

  if (
    !challenge ||
    !signature ||
    !cardHash ||
    !masterPubkey ||
    !webauthnCredentialId ||
    !webauthnPublicKey ||
    !encryptedKeyringBlob
  ) {
    return {
      ok: false,
      statusCode: 400,
      statusMessage:
        'challenge, signature, card_hash, master_pubkey, webauthn_credential_id, webauthn_public_key, and encrypted_keyring_blob are all required.',
    };
  }

  const consumed = await consumeChallenge(pool, 'account_creation', null, challenge);
  if (!consumed) {
    return { ok: false, statusCode: 401, statusMessage: 'Invalid or expired challenge.' };
  }

  const challengeBytes = new Uint8Array(Buffer.from(challenge, 'base64url'));
  const validSignature = verifyMasterCardSignature(challengeBytes, signature, masterPubkey);
  if (!validSignature) {
    return { ok: false, statusCode: 401, statusMessage: 'Invalid master card key signature.' };
  }

  const existing = await findAccountByCardHash(pool, cardHash);
  if (existing) {
    return { ok: false, statusCode: 409, statusMessage: 'An account already exists for this card_hash.' };
  }

  const keyringId = keccak256OfBase64Url(encryptedKeyringBlob);

  const secretsService = getSecretsService();
  const serviceSecretPlain = crypto.getRandomValues(new Uint8Array(SERVICE_SECRET_BYTES));
  let ciphertext: string, dekEnc: string;
  try {
    ({ ciphertext, dekEnc } = await secretsService.encryptSecret(Buffer.from(serviceSecretPlain)));
  } catch (err) {
    auditLog('error', 'secrets_backend_failure', {
      operation: 'encryptSecret',
      card_hash: cardHash,
      error: String(err),
    });
    throw err;
  }

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
      return { ok: false, statusCode: 409, statusMessage: 'Account or credential already registered.' };
    }
    throw err;
  }

  await insertKeyringBlob(pool, keyringId, cardHash, encryptedKeyringBlob);
  await Promise.all([
    announceOwnCardRegistration(cardHash),
    replicateKeyringBlob(keyringId, cardHash, encryptedKeyringBlob),
  ]);

  const { token, payload } = issueSessionToken(cardHash, config.SESSION_TOKEN_SECRET);

  auditLog('info', 'account_created', { card_hash: cardHash });
  auditLog('info', 'service_secret_created', { card_hash: cardHash });

  return {
    ok: true,
    service_secret: Buffer.from(serviceSecretPlain).toString('base64url'),
    account_id: account.id,
    keyring_id: keyringId,
    session_token: token,
    expires_at: new Date(payload.expires_at).toISOString(),
  };
}
