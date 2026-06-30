/**
 * WebAuthn passkey login (implementation-plan.md §Step 2.1, resolving
 * CP-1). Used only for the existing-wallet open-offer acceptance path
 * (`open_offer_acceptance_existing_wallet.md` Step 6) — the holder must
 * authenticate as the existing account before the wallet service will
 * release `service_secret`.
 *
 * New-wallet account creation does not use this module: the passkey
 * credential is registered (not verified) as part of `POST /accounts`
 * (Step 2.2), authenticated instead by the freshly-generated master card
 * key signing the account-creation challenge.
 */

import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface StoredWebAuthnCredential {
  id: string; // base64url credential id
  publicKey: Uint8Array; // COSE public key
  counter: number;
}

export type WebAuthnLoginResult =
  | { ok: true; newCounter: number }
  | { ok: false; reason: 'verification_failed' | 'counter_reused' | 'error' };

/**
 * Verifies a WebAuthn authentication assertion against a previously
 * registered credential. The caller is responsible for persisting
 * `newCounter` back onto the stored credential on success — failing to do
 * so reopens the replay window this check exists to close.
 */
export async function verifyWebAuthnLogin(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  rpId: string,
  origin: string,
  credential: StoredWebAuthnCredential
): Promise<WebAuthnLoginResult> {
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      // Buffer-backed Uint8Arrays are typed ArrayBufferLike, which strict
      // lib.dom typings reject for BufferSource; copy into a fresh,
      // plain-ArrayBuffer-backed Uint8Array (same issue as src/secrets/).
      credential: { ...credential, publicKey: Uint8Array.from(credential.publicKey) },
      requireUserVerification: true,
    });

    if (!result.verified) {
      return { ok: false, reason: 'verification_failed' };
    }
    // Per the WebAuthn spec, a non-increasing counter signals a cloned
    // authenticator or a replayed assertion. Authenticators that never
    // increment (counter stays 0) are the one accepted exception.
    if (result.authenticationInfo.newCounter <= credential.counter && credential.counter !== 0) {
      return { ok: false, reason: 'counter_reused' };
    }
    return { ok: true, newCounter: result.authenticationInfo.newCounter };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
