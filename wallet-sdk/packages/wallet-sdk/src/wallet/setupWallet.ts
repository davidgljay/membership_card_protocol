import { randomBytes } from '@noble/hashes/utils.js';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { bytesToBase64Url, base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import { deriveDecryptionKey, passkeyOutputFromPrf } from './kdf.js';
import { encryptKeyring, computeKeyringId } from './keyring.js';
import { requestJson } from './httpJson.js';
import { registerDeviceSubCard } from './deviceSubCard.js';
import { registerBackup, type NotificationChannels } from './backupRegistration.js';
import type {
  PasskeyProvider,
  StorageProvider,
  SecureKeyProvider,
  ObliviousProtocolTransport,
  YubiKeyProvider,
  WalletAppCardIdentity,
  RegisterSubCardFn,
  SignedSubCardDocument,
  CardVerifier,
} from '@membership-card-protocol/app-sdk';

/**
 * Initial wallet setup (`wallet_backup_and_recovery.md §Process 1`, Steps
 * 1–14): generate the master ML-DSA-44 keypair, create the device-bound
 * passkey, exchange with the wallet service to obtain `service_secret`,
 * derive `decryption_key`, initialize + persist the encrypted keyring,
 * register synced-passkey and (opt-in) YubiKey backups (Steps 11–14,
 * `backupRegistration.ts`), and generate + register the device sub-card
 * (Steps 7–9, `deviceSubCard.ts`) that all routine signing operations use
 * from this point on (Step 10).
 *
 * Steps 7–9 and 11–14 are performed inline here, in the same function,
 * rather than as separately callable steps: `decryption_key` and the master
 * private key are local variables scoped to this function's body
 * specifically so neither is ever exposed via any SDK-facing return value
 * (see the "Security-critical structural note" below) — splitting device
 * sub-card registration or backup registration into their own public entry
 * points would force one of them to cross a function boundary the caller
 * can observe. `wallet_backup_and_recovery.md §Process 1` presents Steps
 * 1–15 as one continuous flow with no natural break point, which this
 * mirrors.
 *
 * ## Ordering judgment call: the `POST /accounts` bootstrap problem
 *
 * `decryption_key = KDF(device_passkey_output, service_secret)` needs
 * `service_secret`, which only exists once the wallet service generates it —
 * and per `plans/wallet-service/implementation-plan.md §Step 2.2`,
 * `service_secret` is returned **only** in `POST /accounts`'s response,
 * while `encrypted_keyring_blob` is a **required field of that same
 * request**. The client cannot encrypt the keyring under the final
 * `decryption_key` before making the one call that discloses
 * `service_secret` — there is no prior endpoint that yields it.
 *
 * Resolution (mirrors the two-call shape the wallet-service plan already
 * defines for the structurally identical post-recovery case, Step 2.4):
 *   1. `POST /accounts/challenge` → sign with the master key → `POST
 *      /accounts`, submitting the keyring encrypted under a **provisional**
 *      key derived from `device_passkey_output` alone (no `service_secret`
 *      folded in yet — this provisional ciphertext is never the wallet's
 *      long-term state and is superseded within the same setup call before
 *      `setupWallet` returns). This satisfies `encrypted_keyring_blob`
 *      being a required field and yields `service_secret` plus a
 *      `session_token` in the response.
 *   2. Immediately re-encrypt the same keyring contents under the *real*
 *      `decryption_key = KDF(device_passkey_output, service_secret)`, and
 *      replace the provisional blob via `POST
 *      /accounts/{card_hash}/keyring/challenge` + `PUT
 *      /accounts/{card_hash}/keyring` (Step 2.4's keyring-rotation
 *      endpoint — authenticated the same way, by the master key signing a
 *      challenge, which this function still holds at this point), passing
 *      `rotate_service_secret: false`. The final `keyring_id` this call
 *      returns is what this function reports; `service_secret` is
 *      unchanged from step 1 (the same value already used to derive
 *      `decryption_key` above) — the provisional blob and its `keyring_id`
 *      from step 1 are immediately superseded server-side and never
 *      referenced again.
 *
 * Why `rotate_service_secret: false` matters (found while building Step
 * 2.4's recovery flow): this endpoint previously rotated `service_secret`
 * unconditionally on every call. Since the client cannot know a secret
 * before a call that mints it, and the endpoint always minted a *different*
 * one than whatever the client had just encrypted with, no finite chain of
 * calls to it could ever leave the stored blob's true encryption secret
 * matching what `GET /accounts/{card_hash}/service-secret` would later
 * return — a structural bug, not a client-side mistake, fixed by adding
 * this flag (`wallet-service` `keyring.put.ts`'s doc comment has the full
 * account). This function's step 2 call is exactly the case the flag
 * exists for: it installs a blob already encrypted under the *current*
 * (step 1's) secret, so the server must not mint a different one out from
 * under it.
 *
 * This keeps `decryption_key` — the value the spec is explicit that
 * "neither `device_passkey_output` alone nor `service_secret` alone can
 * reconstruct" — as the only key that ever protects the keyring blob this
 * function leaves in place; the provisional single-factor blob exists only
 * as a transient value inside this one exchange, superseded before this
 * function returns.
 *
 * Security-critical structural note: the master private key is generated
 * inside this function, used only to sign wallet-service challenges and to
 * populate the one keyring entry it initializes, and is never returned,
 * logged, or stored anywhere outside the encrypted keyring blob.
 * `WalletSetupResult` (the only value this function returns) has no field
 * that can carry it.
 */
export interface WalletSetupOptions<T = void> {
  passkeyProvider: PasskeyProvider;
  storageProvider: StorageProvider;
  transport: ObliviousProtocolTransport;
  secureKeyProvider: SecureKeyProvider;
  /** The wallet software's own governance-certified app identity (see `deviceSubCard.ts`'s doc). */
  walletAppCard: WalletAppCardIdentity;
  /** The press-submission callback the device sub-card is registered through (App SDK's `createPressSubCardRegistrar`, `app_sdk.md §7.3`). */
  registerSubCard: RegisterSubCardFn;
  /** The shared `CardVerifier` instance — see `deviceSubCard.ts`'s doc for why it's needed here too. */
  cardVerifier: CardVerifier;
  /** Whitelist of message-type strings the device sub-card may sign. */
  capabilities: string[];
  /** Storage key the encrypted keyring blob is cached under locally. Defaults to `'keyring'`. */
  storageKey?: string;
  /** `SecureKeyProvider` key identifier for the device sub-card. Defaults to `'device-sub-card'`. */
  subCardKeyId?: string;
  /**
   * Where backup-recovery notifications should be sent (`wallet_backup_and_
   * recovery.md §Process 1` Step 13 — "at least one notification channel is
   * required", enforced server-side by `POST /accounts/{card_hash}/backups`).
   */
  notificationChannels: NotificationChannels;
  /**
   * Opt-in YubiKey backup (Step 14). Omit to skip YubiKey registration
   * entirely — the synced-passkey backup (Steps 11–13) is always performed,
   * since the spec describes it as automatic/default, not opt-in.
   */
  yubiKeyProvider?: YubiKeyProvider;
  /** YubiKey PIN, required only if `yubiKeyProvider` is supplied. */
  yubiKeyPin?: string;
  /**
   * Optional hook run after the keyring, backups, and device sub-card are
   * all established — still inside this function's body, i.e. while
   * `decryptionKey` is still valid, before the `finally` block clears
   * `masterSecretKey`. Exists for flows that need exactly one more
   * keyring-touching operation as part of the *same* continuous wallet
   * creation (open-offer new-wallet acceptance's "invoke wallet setup
   * inline") — without duplicating this entire function's body, and
   * without `decryptionKey` ever crossing this function's own return
   * boundary the way it never has.
   */
  postSetupHook?: (decryptionKey: Uint8Array) => Promise<T>;
}

export interface WalletSetupResult<T = void> {
  /** keccak256 address of the master public key — the holder's card_hash / on-chain identity. */
  cardHash: string;
  /** Raw ML-DSA-44 master public key bytes. Public; safe to expose. */
  masterPublicKey: Uint8Array;
  accountId: string | number;
  keyringId: string;
  sessionToken: string;
  expiresAt: string;
  /** WebAuthn credential ID for the device-bound passkey created in Step 2. Public identifier, not secret. */
  passkeyCredentialId: Uint8Array;
  /** Raw ML-DSA-44 public key of the device sub-card generated in Step 7. Public; safe to expose. Routine signing uses `secureKeyProvider.sign(subCardKeyId, ...)`, never the master key. */
  subCardPublicKey: Uint8Array;
  /** `SecureKeyProvider` key identifier the device sub-card was generated under. */
  subCardKeyId: string;
  /** The signed `SubCardDocument` submitted for on-chain registration. */
  subCardDocument: SignedSubCardDocument;
  /** Whether `registerSubCard` (Step 9) reported the registration as accepted. */
  subCardRegistered: boolean;
  /** `backup_id` for the synced-passkey backup registration (Steps 11–13; always performed). */
  syncedPasskeyBackupId: string;
  /** `backup_id` for the YubiKey backup registration (Step 14), present only if `yubiKeyProvider` was supplied. */
  yubiKeyBackupId?: string;
  /** Return value of `postSetupHook`, if one was supplied. */
  postSetupHookResult: T;
}

interface AccountsChallengeResponseBody {
  challenge: string;
  expires_at: string;
}

interface AccountsCreateResponseBody {
  service_secret: string;
  account_id: string | number;
  keyring_id: string;
  session_token: string;
  expires_at: string;
}

interface KeyringChallengeResponseBody {
  challenge: string;
  expires_at: string;
}

interface KeyringUpdateResponseBody {
  service_secret: string;
  keyring_id: string;
}

export async function setupWallet<T = void>(options: WalletSetupOptions<T>): Promise<WalletSetupResult<T>> {
  const {
    passkeyProvider,
    storageProvider,
    transport,
    secureKeyProvider,
    walletAppCard,
    registerSubCard,
    cardVerifier,
    capabilities,
    notificationChannels,
    yubiKeyProvider,
    yubiKeyPin,
    postSetupHook,
  } = options;
  const storageKey = options.storageKey ?? 'keyring';

  // --- Step 1: generate the master ML-DSA-44 keypair (spec Step 1).
  // Private key is held in this local variable only, for the remainder of
  // this function. ---
  const masterKeypair = mlDsa44GenerateKeypair();
  const masterPublicKey = masterKeypair.publicKey;
  const cardHash = keccak256(masterPublicKey);
  let masterSecretKey: Uint8Array | undefined = masterKeypair.secretKey;

  try {
    // --- Step 2: device-bound passkey (spec Step 2). ---
    const accountsChallenge = await requestJson<AccountsChallengeResponseBody>(
      transport,
      'POST',
      '/accounts/challenge'
    );
    const accountsChallengeBytes = base64UrlToBytes(accountsChallenge.challenge);

    const registration = await passkeyProvider.register(accountsChallengeBytes);
    // CP-1 finding: device_passkey_output must NOT be derived from
    // `attestationObject` — those exact bytes are submitted below as
    // `webauthn_public_key`, so a KDF input derived from them would let the
    // wallet service (which already holds `service_secret`) recompute
    // `decryption_key` on its own. `prfOutput` is never transmitted
    // anywhere by this SDK. See `kdf.ts`'s `passkeyOutputFromPrf` doc and
    // `plans/client-sdk/milestones/cp1-security-review.md`.
    if (!registration.prfOutput) {
      throw new Error(
        'setupWallet: device-bound passkey registration did not return a PRF output; device_passkey_output cannot be derived securely (see CP-1 security review).'
      );
    }
    const devicePasskeyOutput = passkeyOutputFromPrf(registration.prfOutput);

    // Master key signs the wallet-service challenge, proving control of the
    // newly generated master key (`plans/wallet-service/
    // implementation-plan.md §Step 2.2`).
    const accountSignature = mlDsa44Sign(masterSecretKey, accountsChallengeBytes);

    // --- Provisional keyring: encrypted under `device_passkey_output`
    // alone, solely to satisfy `POST /accounts`'s required
    // `encrypted_keyring_blob` field before `service_secret` exists. See
    // this function's doc comment ("Ordering judgment call") for why this
    // step exists and why it is safe: this ciphertext is superseded before
    // `setupWallet` returns and is never the wallet's resting state. ---
    const provisionalKeyringBlob = encryptKeyring(
      [{ cardAddress: cardHash, privateKey: masterSecretKey }],
      devicePasskeyOutput
    );

    const accountsCreateResponse = await requestJson<AccountsCreateResponseBody>(
      transport,
      'POST',
      '/accounts',
      {
        challenge: accountsChallenge.challenge,
        signature: bytesToBase64Url(accountSignature),
        card_hash: cardHash,
        master_pubkey: bytesToBase64Url(masterPublicKey),
        webauthn_credential_id: bytesToBase64Url(registration.credentialId),
        // Judgment call: `PasskeyProvider.register()` (Step 1.2, already
        // committed) returns the raw WebAuthn `attestationObject`, not a
        // parsed COSE public key — CBOR/attestation parsing to extract the
        // credential public key is not part of that interface and is out
        // of scope for this step (it matters for WebAuthn *login*
        // assertion verification, `plans/wallet-service/
        // implementation-plan.md §Step 2.1`, not for account creation,
        // which never verifies this field — it only stores it). The
        // wallet service stores `webauthn_public_key` opaquely at account
        // creation (`wallet-service/src/routes/accounts-create.ts`), so
        // this passes `attestationObject` through directly; a real COSE
        // extraction should replace this once routine WebAuthn login
        // needs to verify against it.
        webauthn_public_key: bytesToBase64Url(registration.attestationObject),
        encrypted_keyring_blob: bytesToBase64Url(provisionalKeyringBlob),
      }
    );

    // --- Steps 3–4: `service_secret` now known; derive the real
    // `decryption_key`. ---
    const serviceSecret = base64UrlToBytes(accountsCreateResponse.service_secret);
    const decryptionKey = deriveDecryptionKey(devicePasskeyOutput, serviceSecret);

    // --- Step 5: re-encrypt the keyring under the real `decryption_key`
    // and replace the provisional blob via the keyring-rotation endpoint
    // (Step 2.4), which also mints the `service_secret` this setup
    // ultimately reports and returns a fresh `keyring_id`. ---
    const finalKeyringBlob = encryptKeyring(
      [{ cardAddress: cardHash, privateKey: masterSecretKey }],
      decryptionKey
    );

    const keyringChallenge = await requestJson<KeyringChallengeResponseBody>(
      transport,
      'POST',
      `/accounts/${cardHash}/keyring/challenge`
    );
    const keyringChallengeBytes = base64UrlToBytes(keyringChallenge.challenge);
    const keyringSignature = mlDsa44Sign(masterSecretKey, keyringChallengeBytes);

    const keyringUpdateResponse = await requestJson<KeyringUpdateResponseBody>(
      transport,
      'PUT',
      `/accounts/${cardHash}/keyring`,
      {
        challenge: keyringChallenge.challenge,
        signature: bytesToBase64Url(keyringSignature),
        new_encrypted_keyring_blob: bytesToBase64Url(finalKeyringBlob),
        rotate_service_secret: false,
      }
    );

    // Sanity check: the blob we just submitted server-side is the blob
    // whose hash the server reports back as `keyring_id`.
    const expectedKeyringId = computeKeyringId(finalKeyringBlob);
    if (keyringUpdateResponse.keyring_id !== expectedKeyringId) {
      throw new Error(
        'setupWallet: server-reported keyring_id does not match locally computed keccak256(encrypted_blob).'
      );
    }

    // --- Store/cache the final encrypted keyring locally via
    // StorageProvider. ---
    await storageProvider.set(storageKey, finalKeyringBlob);

    // --- Steps 11–13: synced-passkey backup registration
    // (`backupRegistration.ts`; `wallet_backup_and_recovery.md §Process 1`).
    // Always performed — the spec describes this path as automatic/default,
    // unlike the opt-in YubiKey path below. Uses `decryptionKey` while it's
    // still in scope, same rationale as Steps 7–9's use of `masterSecretKey`.
    //
    // Judgment call: `PasskeyProvider` (Step 1.2) has no parameter
    // distinguishing a device-bound credential (Step 2's `register()` call
    // above) from a synced one — synced-vs-device-bound is a platform
    // authenticator attachment setting, not something this SDK's interface
    // models. This calls `register()` a second time for a separate
    // credential. The challenge here is generated locally rather than
    // fetched from the wallet service: unlike Step 2's device passkey, this
    // credential is never submitted to or verified by the wallet service
    // (only the resulting wrapped blob is).
    //
    // Unlike the device-bound passkey (which derives its wrapping input from
    // `attestationObject`, since it is only ever used again within this same
    // `setupWallet` call), this wrapping key MUST be re-derivable later, on
    // a different device, during recovery (`recovery.ts`, Step 2.4,
    // `wallet_backup_and_recovery.md §Process 2a` Step 8) — after the
    // credential syncs via iCloud Keychain / Google Password Manager, the
    // recovering client can only `assert()` against it, never `register()`
    // it again, and a WebAuthn `attestationObject` is registration-ceremony-
    // specific and not reproducible from an assertion. This requires the
    // WebAuthn PRF extension's evaluated output (`prfOutput`, added to
    // `PasskeyProvider` for exactly this reason): a deterministic,
    // credential-bound secret available from both `register()` and `assert()`
    // for the same credential. See `kdf.ts`'s `passkeyOutputFromPrf`. ---
    const syncedPasskeyChallenge = randomBytes(32);
    const syncedPasskeyRegistration = await passkeyProvider.register(syncedPasskeyChallenge);
    if (!syncedPasskeyRegistration.prfOutput) {
      throw new Error(
        'setupWallet: synced-passkey registration did not return a PRF output; this backup would be unrecoverable ' +
          'later (recovery can only assert() against this credential, never register() it again).'
      );
    }
    const syncedPasskeyOutput = passkeyOutputFromPrf(syncedPasskeyRegistration.prfOutput);

    const syncedPasskeyBackup = await registerBackup({
      transport,
      sessionToken: accountsCreateResponse.session_token,
      cardHash,
      type: 'synced_passkey',
      decryptionKey,
      wrappingKey: syncedPasskeyOutput,
      keyringId: keyringUpdateResponse.keyring_id,
      notificationChannels,
      cancellationPubkey: masterPublicKey,
    });

    // --- Step 14: opt-in YubiKey backup registration, only if a
    // `YubiKeyProvider` was supplied. ---
    let yubiKeyBackupId: string | undefined;
    if (yubiKeyProvider) {
      if (!yubiKeyPin) {
        throw new Error('setupWallet: yubiKeyPin is required when yubiKeyProvider is supplied.');
      }
      const yubiKeyWrappingKey = await yubiKeyProvider.deriveWrappingKey(yubiKeyPin);
      const yubiKeyBackup = await registerBackup({
        transport,
        sessionToken: accountsCreateResponse.session_token,
        cardHash,
        type: 'yubikey',
        decryptionKey,
        wrappingKey: yubiKeyWrappingKey,
        keyringId: keyringUpdateResponse.keyring_id,
        notificationChannels,
        cancellationPubkey: masterPublicKey,
      });
      yubiKeyBackupId = yubiKeyBackup.backupId;
    }

    // --- Steps 7–9: device sub-card generation and registration
    // (`deviceSubCard.ts`). Uses `masterSecretKey` while it's still in
    // scope, before the `finally` block below clears it — matching Step
    // 8's "accessed from the keyring... cleared after signing" (the key
    // never left this function's scope in the first place, so "accessed
    // from the keyring" is satisfied by construction rather than by an
    // actual decrypt-from-storage round trip). ---
    const deviceSubCard = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash,
      masterPublicKey,
      masterSecretKey,
      walletAppCard,
      registerSubCard,
      cardVerifier,
      capabilities,
      ...(options.subCardKeyId ? { subCardKeyId: options.subCardKeyId } : {}),
    });

    // --- Optional post-setup hook (see WalletSetupOptions' doc) — still
    // runs inside this try block, before the finally clears masterSecretKey,
    // so decryptionKey is valid for the hook's entire execution. ---
    const postSetupHookResult = (
      postSetupHook ? await postSetupHook(decryptionKey) : undefined
    ) as T;

    return {
      cardHash,
      masterPublicKey,
      accountId: accountsCreateResponse.account_id,
      keyringId: keyringUpdateResponse.keyring_id,
      sessionToken: accountsCreateResponse.session_token,
      expiresAt: accountsCreateResponse.expires_at,
      passkeyCredentialId: registration.credentialId,
      subCardPublicKey: deviceSubCard.subCardPublicKey,
      subCardKeyId: deviceSubCard.subCardKeyId,
      subCardDocument: deviceSubCard.document,
      subCardRegistered: deviceSubCard.registered,
      syncedPasskeyBackupId: syncedPasskeyBackup.backupId,
      ...(yubiKeyBackupId ? { yubiKeyBackupId } : {}),
      postSetupHookResult,
    };
  } finally {
    // --- Step 6: clear the master private key from memory after the
    // keyring is posted, regardless of success or failure. ---
    if (masterSecretKey) {
      masterSecretKey.fill(0);
    }
    masterSecretKey = undefined;
  }
}
