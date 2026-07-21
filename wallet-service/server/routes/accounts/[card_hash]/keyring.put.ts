/**
 * PUT /accounts/{card_hash}/keyring — implementation-plan.md §Step 2.4.
 * Replaces the holder's keyring blob after recovery re-registration.
 * Authenticated with masterCardSignatureAuth: holder signs the challenge
 * from POST /accounts/{card_hash}/keyring/challenge with the recovered
 * master card key. By default issues a new service_secret (old one is
 * invalidated by being overwritten) and invalidates all previously issued
 * session tokens for this card_hash.
 *
 * `rotate_service_secret` (client-sdk implementation plan Step 2.4 fix,
 * default `true` — preserves this endpoint's original recovery-only
 * behavior for any caller that doesn't pass it): a client that already
 * encrypted `new_encrypted_keyring_blob` under `KDF(device_passkey_output,
 * <the account's CURRENT service_secret>)` needs to install that blob
 * *without* this call minting a different secret out from under it — since
 * this endpoint previously rotated unconditionally on every call, no
 * finite sequence of calls to it could ever leave the stored blob's true
 * encryption secret matching what `GET /accounts/{card_hash}/service-
 * secret` (the "daily-use decryption key derivation" endpoint) would
 * return. Passing `rotate_service_secret: false` replaces the keyring blob
 * and keyring_id as usual but leaves `service_secret_enc`/`_dek_enc`
 * untouched, and echoes back the *unchanged* current secret rather than
 * minting one.
 *
 * Both `client-sdk`'s `setupWallet` (finalizing the real, dual-factor-
 * encrypted blob right after `POST /accounts`) and `recoverWallet`
 * (finalizing after its own provisional rotation) use this: the call that
 * mints a genuinely new secret (`POST /accounts`, or recovery's first,
 * provisional `PUT`) is always followed by exactly one
 * `rotate_service_secret: false` call installing the blob actually
 * encrypted under that secret.
 *
 * Thin H3 adapter — all logic lives in ../../../../src/routes/keyring-put.ts,
 * callable identically from here and from the OHTTP gateway
 * (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../../db/client.js';
import { handleKeyringUpdate, type KeyringUpdateBody } from '../../../../src/routes/keyring-put.js';

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const body = await readBody<KeyringUpdateBody>(event);
  const outcome = await handleKeyringUpdate({ pool: getPool(), cardHash, body });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  return { service_secret: outcome.service_secret, keyring_id: outcome.keyring_id };
});
