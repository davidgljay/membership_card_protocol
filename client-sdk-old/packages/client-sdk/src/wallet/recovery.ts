import { mlDsa44Sign, mlDsa44GetPublicKey } from '../crypto/mldsa.js';
import { keccak256 } from '../crypto/hashes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToBase64Url, base64UrlToBytes } from '../util/base64url.js';
import { deriveDecryptionKey, passkeyOutputFromPrf } from './kdf.js';
import { encryptKeyring, decryptKeyring, computeKeyringId } from './keyring.js';
import { unwrapDecryptionKey } from './backupRegistration.js';
import { requestJson } from './httpJson.js';
import {
  registerDeviceSubCard,
  type WalletAppCardIdentity,
  type RegisterSubCardFn,
  type SignedSubCardDocument,
} from './deviceSubCard.js';
import {
  deregisterSubCardsAfterRecovery,
  type PreviouslyActiveSubCard,
  type SubCardDeregistrationOutcome,
} from './subCardDeregistration.js';
import type { PasskeyProvider } from '../providers/PasskeyProvider.js';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { YubiKeyProvider } from '../providers/YubiKeyProvider.js';

/**
 * Recovery (`wallet_backup_and_recovery.md §Process 2a` synced-passkey,
 * §Process 2b` YubiKey), post-recovery re-registration (`§Process 3`) —
 * Step 2.4 — and post-recovery sub-card deregistration
 * (`subcards.md §Deregistration After Key Recovery`) — Step 2.5.
 *
 * Three independent, separately callable primitives cover initiation and
 * the cancellation window (`initiateRecovery`, `cancelRecovery`,
 * `releaseRecoveryKey`) — these don't touch `decryption_key` and have no
 * reason to be bundled with the rest. `fetchKeyringBlob` is a thin,
 * single-purpose fetch. `recoverWallet` is the one large orchestrating
 * function, mirroring `setupWallet.ts`'s own structure and its "keep
 * `decryption_key`/master secret key function-scoped" invariant: it accepts
 * an already-released `wrappedBlob`/`keyringId` (obtained by polling
 * `releaseRecoveryKey` beforehand — polling/backoff is the caller's
 * concern, not this module's) and performs unwrap → fetch → decrypt →
 * deregister previously-active sub-cards → re-register → device-sub-card-
 * reissue as one continuous flow, exactly as `wallet_backup_and_recovery.md`
 * describes Steps 6–11 with no natural break point.
 *
 * Step 2.5's batch deregistration (`subCardDeregistration.ts`) is folded
 * into this same function, right after the master key is recovered and
 * before re-registration, rather than exposed as a separately callable
 * step: it needs `masterSecretKey` (the only valid signer,
 * `subcards.md §Authorization for Deregistration`), which — like
 * `decryptionKey` — never crosses this function's return boundary.
 */

export type RecoveryMethod = 'synced_passkey' | 'yubikey';

export interface InitiateRecoveryResult {
  recoveryId: string;
  expiresAt: string;
  notifiedChannels?: string[];
}

interface InitiateRecoveryResponseBody {
  recovery_id: string;
  expires_at: string;
  notified_channels?: string[];
}

/**
 * `POST /accounts/{card_hash}/recovery` (`wallet_backup_and_recovery.md
 * §Process 2a/2b` Steps 1–2; `plans/wallet-service/implementation-
 * plan.md §Step 3.2`). No session token — this is called by someone who
 * may not have their device.
 *
 * Judgment call: the wallet service has no session-less endpoint to
 * enumerate a holder's registered `backup_id`s (`GET .../backups/{id}` is
 * session-token-authenticated, per `backupRegistration.ts`'s doc), so
 * `backupId` must be supplied by the caller — e.g. a host app persisting
 * `WalletSetupResult.syncedPasskeyBackupId`/`yubiKeyBackupId` in its own
 * (non-keyring) local storage at setup time.
 */
export async function initiateRecovery(
  transport: ObliviousProtocolTransport,
  cardHash: string,
  backupId: string
): Promise<InitiateRecoveryResult> {
  const response = await requestJson<InitiateRecoveryResponseBody>(
    transport,
    'POST',
    `/accounts/${cardHash}/recovery`,
    { backup_id: backupId }
  );
  return {
    recoveryId: response.recovery_id,
    expiresAt: response.expires_at,
    ...(response.notified_channels ? { notifiedChannels: response.notified_channels } : {}),
  };
}

export interface CancelRecoveryResult {
  cancelled: boolean;
}

interface CancelRecoveryResponseBody {
  cancelled: boolean;
}

/**
 * `POST /recovery/{recovery_id}/cancel` (`wallet_backup_and_recovery.md
 * §Process 2a/2b` Steps 4–5 / 3–4; `plans/wallet-service/implementation-
 * plan.md §Step 3.4`). The cancellation credential is the master card key
 * (OQ-WS-6, resolved — see `wallet-service/server/routes/recovery/
 * [recovery_id]/cancel.post.ts`'s doc): `challenge` is `recoveryId`'s own
 * UTF-8 bytes, base64url; `signature` is an ML-DSA-44 signature over those
 * bytes, verified server-side against the `cancellation_pubkey` registered
 * with the backup (`masterPublicKey`, per `backupRegistration.ts`'s doc).
 *
 * Judgment call: `masterSecretKey` is taken as a direct parameter, the same
 * shape `deviceSubCard.ts`'s `registerDeviceSubCard` uses — the caller
 * (the legitimate holder, whose own device/passkey/session is still
 * intact; this is precisely the "attacker initiated recovery, holder still
 * has their device" threat model `wallet_backup_and_recovery.md`'s
 * Security notes describe) is responsible for however it reconstructs its
 * own master key to authorize this call. Building a general "unlock this
 * wallet's master key" primitive is out of this step's scope — no prior
 * step has needed one, since routine signing uses the device sub-card key
 * (`deviceSubCard.ts`), never the master key.
 */
export async function cancelRecovery(
  transport: ObliviousProtocolTransport,
  recoveryId: string,
  masterSecretKey: Uint8Array
): Promise<CancelRecoveryResult> {
  const challengeBytes = new TextEncoder().encode(recoveryId);
  const signature = mlDsa44Sign(masterSecretKey, challengeBytes);

  const response = await requestJson<CancelRecoveryResponseBody>(
    transport,
    'POST',
    `/recovery/${recoveryId}/cancel`,
    {
      challenge: bytesToBase64Url(challengeBytes),
      signature: bytesToBase64Url(signature),
    }
  );
  return { cancelled: response.cancelled };
}

export type ReleaseRecoveryKeyOutcome =
  | { status: 'released'; wrappedBlob: Uint8Array; keyringId: string }
  | { status: 'too_early'; retryAfterSeconds: number }
  | { status: 'cancelled' };

/**
 * `GET /recovery/{recovery_id}/release` (`wallet_backup_and_recovery.md
 * §Process 2a/2b` Step 6/5; `plans/wallet-service/implementation-plan.md
 * §Step 3.5`). Unlike every other call in this module, a non-2xx response
 * here (425 before the 72-hour window closes, 410 if cancelled) is an
 * expected outcome, not a failure — so this returns a discriminated union
 * instead of throwing, letting callers poll/backoff on `'too_early'`
 * without try/catch-driven control flow.
 */
export async function releaseRecoveryKey(
  transport: ObliviousProtocolTransport,
  recoveryId: string
): Promise<ReleaseRecoveryKeyOutcome> {
  const response = await transport.request(
    { kind: 'wallet_service' },
    { method: 'GET', path: `/recovery/${recoveryId}/release` }
  );
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    wrapped_blob?: string;
    keyring_id?: string;
    retry_after?: number;
  };

  if (response.status === 200 && body.wrapped_blob && body.keyring_id) {
    return { status: 'released', wrappedBlob: base64UrlToBytes(body.wrapped_blob), keyringId: body.keyring_id };
  }
  if (response.status === 425) {
    return { status: 'too_early', retryAfterSeconds: body.retry_after ?? 0 };
  }
  if (response.status === 410) {
    return { status: 'cancelled' };
  }
  throw new Error(`releaseRecoveryKey: GET /recovery/${recoveryId}/release returned status ${response.status}`);
}

interface KeyringGetResponseBody {
  encrypted_blob: string;
}

/**
 * `GET /keyrings/{keyring_id}` (`wallet_backup_and_recovery.md §Keyring
 * Storage and Replication`; `plans/wallet-service/implementation-plan.md
 * §Step 4.1a`). Callable against any federation member — not necessarily
 * the holder's original primary service — since the blob is replicated to
 * every instance; this function takes `transport` as a parameter precisely
 * so a caller can point it at a stub "non-primary" instance in tests.
 */
export async function fetchKeyringBlob(transport: ObliviousProtocolTransport, keyringId: string): Promise<Uint8Array> {
  const response = await requestJson<KeyringGetResponseBody>(transport, 'GET', `/keyrings/${keyringId}`);
  return base64UrlToBytes(response.encrypted_blob);
}

interface KeyringChallengeResponseBody {
  challenge: string;
  expires_at: string;
}

interface KeyringUpdateResponseBody {
  service_secret: string;
  keyring_id: string;
}

export interface RecoverWalletOptions {
  transport: ObliviousProtocolTransport;
  storageProvider: StorageProvider;
  secureKeyProvider: SecureKeyProvider;
  /** Used both to `assert()` the synced-passkey credential (if `method === 'synced_passkey'`) and to `register()` the new device-bound passkey for re-registration (Process 3 Step 10), regardless of method. */
  passkeyProvider: PasskeyProvider;
  walletAppCard: WalletAppCardIdentity;
  registerSubCard: RegisterSubCardFn;
  capabilities: string[];
  cardHash: string;
  method: RecoveryMethod;
  /** From `releaseRecoveryKey`'s `'released'` outcome. */
  wrappedBlob: Uint8Array;
  keyringId: string;
  /** Required when `method === 'yubikey'`. */
  yubiKeyProvider?: YubiKeyProvider;
  yubiKeyPin?: string;
  storageKey?: string;
  subCardKeyId?: string;
  /**
   * Sub-cards active before the simulated loss (Step 2.5,
   * `subcards.md §Deregistration After Key Recovery`) — supplied by the
   * caller (e.g. its own cached card list), since neither the recovered
   * keyring nor anything else this SDK persists tracks sub-card issuance.
   * Omit to skip batch deregistration entirely.
   */
  previouslyActiveSubCards?: PreviouslyActiveSubCard[];
}

export interface RecoverWalletResult {
  cardHash: string;
  masterPublicKey: Uint8Array;
  /** New `keyring_id`, minted by re-registration (Process 3 Step 10). */
  keyringId: string;
  /** WebAuthn credential ID for the new device-bound passkey created during re-registration. */
  passkeyCredentialId: Uint8Array;
  subCardPublicKey: Uint8Array;
  subCardKeyId: string;
  subCardDocument: SignedSubCardDocument;
  subCardRegistered: boolean;
  /** Per-sub-card outcomes from Step 2.5's batch deregistration; present only if `previouslyActiveSubCards` was supplied. */
  subCardDeregistrations?: SubCardDeregistrationOutcome[];
}

/**
 * Recovers the wallet from an already-released backup (`wrappedBlob` +
 * `keyringId`) and immediately re-registers it on this device (`Process 3`),
 * restoring the dual-factor encryption model with a fresh `decryption_key`
 * and `keyring_id`.
 *
 * `decryptionKey` and the recovered master secret key are local variables
 * scoped to this function's body only, for the same reason `setupWallet`
 * scopes them — see that function's doc comment.
 */
export async function recoverWallet(options: RecoverWalletOptions): Promise<RecoverWalletResult> {
  const {
    transport,
    storageProvider,
    secureKeyProvider,
    passkeyProvider,
    walletAppCard,
    registerSubCard,
    capabilities,
    cardHash,
    method,
    wrappedBlob,
    keyringId,
    yubiKeyProvider,
    yubiKeyPin,
    previouslyActiveSubCards,
  } = options;
  const storageKey = options.storageKey ?? 'keyring';

  // --- Steps 7–8 (2a) / 6–7 (2b): derive the wrapping key for whichever
  // method was used, and unwrap decryption_key. ---
  let wrappingKey: Uint8Array;
  if (method === 'synced_passkey') {
    // The synced passkey syncs to this (new) device via iCloud Keychain /
    // Google Password Manager — it is asserted against, never registered
    // again (see `kdf.ts`'s `passkeyOutputFromPrf` doc for why this matters:
    // `attestationObject` isn't reproducible from an assertion, which is
    // exactly why `backupRegistration.ts`'s wrap step requires a PRF output
    // instead). No `credentialId` is supplied — per `PasskeyProvider.
    // assert()`'s own doc, omitting it lets the platform's passkey UI
    // resolve which credential to use, which is sufficient here since the
    // synced passkey is the only credential registered for this purpose at
    // this origin.
    const assertion = await passkeyProvider.assert(randomBytes(32));
    if (!assertion.prfOutput) {
      throw new Error(
        'recoverWallet: synced-passkey assertion did not return a PRF output; cannot reconstruct the wrapping key.'
      );
    }
    wrappingKey = passkeyOutputFromPrf(assertion.prfOutput);
  } else {
    if (!yubiKeyProvider || !yubiKeyPin) {
      throw new Error('recoverWallet: yubiKeyProvider and yubiKeyPin are required when method is "yubikey".');
    }
    wrappingKey = await yubiKeyProvider.deriveWrappingKey(yubiKeyPin);
  }

  const decryptionKey = unwrapDecryptionKey(wrappedBlob, wrappingKey);

  // --- Step 6 (both): fetch the encrypted keyring blob by keyring_id from
  // whichever federation member `transport` is configured to reach. ---
  const encryptedKeyringBlob = await fetchKeyringBlob(transport, keyringId);

  // --- Step 9 (both): decrypt. The full wallet — master key and any other
  // keyring entries — is now accessible. ---
  const entries = decryptKeyring(encryptedKeyringBlob, decryptionKey);
  const masterEntry = entries.find((entry) => entry.cardAddress === cardHash);
  if (!masterEntry) {
    throw new Error(`recoverWallet: decrypted keyring has no entry for card_hash ${cardHash}.`);
  }
  let masterSecretKey: Uint8Array | undefined = masterEntry.privateKey;
  const masterPublicKey = mlDsa44GetPublicKey(masterSecretKey);
  if (keccak256(masterPublicKey) !== cardHash) {
    throw new Error('recoverWallet: recovered master key does not match the expected card_hash.');
  }

  try {
    // --- Step 2.5: batch-deregister sub-cards active before the loss,
    // signed by the freshly recovered master key — before re-registration,
    // matching `subcards.md`'s own ordering ("the holder should deregister
    // all existing sub-cards" as the first post-recovery action, ahead of
    // "each app should be prompted to re-request"). Skipped entirely if the
    // caller didn't supply a list. ---
    let subCardDeregistrations: SubCardDeregistrationOutcome[] | undefined;
    if (previouslyActiveSubCards && previouslyActiveSubCards.length > 0) {
      subCardDeregistrations = await deregisterSubCardsAfterRecovery(
        transport,
        masterSecretKey,
        previouslyActiveSubCards
      );
    }

    // --- Process 3, Step 10: re-registration. New device-bound passkey,
    // new decryption_key, new keyring_id — the same provisional/final
    // two-step bootstrap `setupWallet.ts` uses for the analogous problem
    // (the client cannot know `service_secret` before encrypting the blob
    // it must submit to obtain it). Unlike `setupWallet`, there is no `POST
    // /accounts/challenge` + `POST /accounts` pair here — the account
    // already exists; `keyring/challenge` + `PUT keyring`, authenticated by
    // the recovered master key, is the entire re-registration mechanism:
    // the provisional call mints a genuinely new `service_secret`
    // (`rotate_service_secret` defaults to `true`, appropriate here since
    // recovery should invalidate whatever secret the lost/compromised
    // device knew), and the final call installs the blob encrypted under
    // *that* secret with `rotate_service_secret: false` so the server
    // doesn't mint a third, mismatched one — see `setupWallet.ts`'s doc
    // comment on this flag for why it exists. ---
    const newPasskeyChallenge = randomBytes(32);
    const newPasskeyRegistration = await passkeyProvider.register(newPasskeyChallenge);
    // CP-1 finding: derive from prfOutput, not attestationObject — see
    // setupWallet.ts's identical fix and kdf.ts's passkeyOutputFromPrf doc.
    if (!newPasskeyRegistration.prfOutput) {
      throw new Error(
        'recoverWallet: new device-bound passkey registration did not return a PRF output; device_passkey_output cannot be derived securely (see CP-1 security review).'
      );
    }
    const devicePasskeyOutput = passkeyOutputFromPrf(newPasskeyRegistration.prfOutput);

    const provisionalBlob = encryptKeyring(entries, devicePasskeyOutput);
    const provisionalChallenge = await requestJson<KeyringChallengeResponseBody>(
      transport,
      'POST',
      `/accounts/${cardHash}/keyring/challenge`
    );
    const provisionalChallengeBytes = base64UrlToBytes(provisionalChallenge.challenge);
    const provisionalSignature = mlDsa44Sign(masterSecretKey, provisionalChallengeBytes);
    const provisionalUpdate = await requestJson<KeyringUpdateResponseBody>(
      transport,
      'PUT',
      `/accounts/${cardHash}/keyring`,
      {
        challenge: provisionalChallenge.challenge,
        signature: bytesToBase64Url(provisionalSignature),
        new_encrypted_keyring_blob: bytesToBase64Url(provisionalBlob),
      }
    );

    const newServiceSecret = base64UrlToBytes(provisionalUpdate.service_secret);
    const newDecryptionKey = deriveDecryptionKey(devicePasskeyOutput, newServiceSecret);

    const finalBlob = encryptKeyring(entries, newDecryptionKey);
    const finalChallenge = await requestJson<KeyringChallengeResponseBody>(
      transport,
      'POST',
      `/accounts/${cardHash}/keyring/challenge`
    );
    const finalChallengeBytes = base64UrlToBytes(finalChallenge.challenge);
    const finalSignature = mlDsa44Sign(masterSecretKey, finalChallengeBytes);
    const finalUpdate = await requestJson<KeyringUpdateResponseBody>(transport, 'PUT', `/accounts/${cardHash}/keyring`, {
      challenge: finalChallenge.challenge,
      signature: bytesToBase64Url(finalSignature),
      new_encrypted_keyring_blob: bytesToBase64Url(finalBlob),
      // Install the blob already encrypted under `newServiceSecret` (the
      // provisional call's own result) without the server minting yet
      // another, mismatched one — see `setupWallet.ts`'s doc comment on
      // this same flag for the full rationale (found while building this
      // function).
      rotate_service_secret: false,
    });

    const expectedKeyringId = computeKeyringId(finalBlob);
    if (finalUpdate.keyring_id !== expectedKeyringId) {
      throw new Error(
        'recoverWallet: server-reported keyring_id does not match locally computed keccak256(encrypted_blob).'
      );
    }

    await storageProvider.set(storageKey, finalBlob);

    // --- Process 3, Step 11: new device sub-card. ---
    const deviceSubCard = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash,
      masterPublicKey,
      masterSecretKey,
      walletAppCard,
      registerSubCard,
      capabilities,
      ...(options.subCardKeyId ? { subCardKeyId: options.subCardKeyId } : {}),
    });

    return {
      cardHash,
      masterPublicKey,
      keyringId: finalUpdate.keyring_id,
      passkeyCredentialId: newPasskeyRegistration.credentialId,
      subCardPublicKey: deviceSubCard.subCardPublicKey,
      subCardKeyId: deviceSubCard.subCardKeyId,
      subCardDocument: deviceSubCard.document,
      subCardRegistered: deviceSubCard.registered,
      ...(subCardDeregistrations ? { subCardDeregistrations } : {}),
    };
  } finally {
    if (masterSecretKey) {
      masterSecretKey.fill(0);
    }
    masterSecretKey = undefined;
  }
}
