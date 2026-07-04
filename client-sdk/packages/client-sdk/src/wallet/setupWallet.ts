import { mlDsa44GenerateKeypair, mlDsa44Sign } from '../crypto/mldsa.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url, base64UrlToBytes } from '../util/base64url.js';
import { deriveDecryptionKey, devicePasskeyOutputFromRegistration } from './kdf.js';
import { encryptKeyring, computeKeyringId } from './keyring.js';
import {
  registerDeviceSubCard,
  type WalletAppCardIdentity,
  type RegisterSubCardFn,
  type SignedSubCardDocument,
} from './deviceSubCard.js';
import type { PasskeyProvider } from '../providers/PasskeyProvider.js';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';

/**
 * Initial wallet setup (`wallet_backup_and_recovery.md §Process 1`, Steps
 * 1–9): generate the master ML-DSA-44 keypair, create the device-bound
 * passkey, exchange with the wallet service to obtain `service_secret`,
 * derive `decryption_key`, initialize + persist the encrypted keyring, and
 * generate + register the device sub-card (Steps 7–9, `deviceSubCard.ts`)
 * that all routine signing operations use from this point on (Step 10).
 *
 * Steps 7–9 are performed inline here, in the same function, rather than
 * as a separately callable step: `decryption_key` and the master private
 * key are local variables scoped to this function's body specifically so
 * neither is ever exposed via any SDK-facing return value (see the
 * "Security-critical structural note" below) — splitting device sub-card
 * registration into its own public entry point would force one of them to
 * cross a function boundary the caller can observe. `wallet_backup_and_
 * recovery.md §Process 1` presents Steps 1–10 as one continuous flow with
 * no natural break point, which this mirrors.
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
 *      challenge, which this function still holds at this point). The
 *      final `keyring_id` and `service_secret` returned by step 2 are what
 *      this function reports and uses — the provisional blob and its
 *      `keyring_id` from step 1 are immediately superseded server-side and
 *      never referenced again.
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
export interface WalletSetupOptions {
  passkeyProvider: PasskeyProvider;
  storageProvider: StorageProvider;
  transport: ObliviousProtocolTransport;
  secureKeyProvider: SecureKeyProvider;
  /** The wallet software's own governance-certified app identity (see `deviceSubCard.ts`'s doc — injected/stubbed pending Phase 4). */
  walletAppCard: WalletAppCardIdentity;
  /** Stands in for Phase 4 Step 4.4's press-submission flow (see `deviceSubCard.ts`'s doc — injected/stubbed pending Phase 4). */
  registerSubCard: RegisterSubCardFn;
  /** Whitelist of message-type strings the device sub-card may sign. */
  capabilities: string[];
  /** Storage key the encrypted keyring blob is cached under locally. Defaults to `'keyring'`. */
  storageKey?: string;
  /** `SecureKeyProvider` key identifier for the device sub-card. Defaults to `'device-sub-card'`. */
  subCardKeyId?: string;
}

export interface WalletSetupResult {
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

async function requestJson<T>(
  transport: ObliviousProtocolTransport,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await transport.request(
    { kind: 'wallet_service' },
    {
      method,
      path,
      ...(body !== undefined
        ? { body: new TextEncoder().encode(JSON.stringify(body)), headers: { 'content-type': 'application/json' } }
        : {}),
    }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`setupWallet: ${method} ${path} returned status ${response.status}`);
  }
  return JSON.parse(new TextDecoder().decode(response.body)) as T;
}

export async function setupWallet(options: WalletSetupOptions): Promise<WalletSetupResult> {
  const { passkeyProvider, storageProvider, transport, secureKeyProvider, walletAppCard, registerSubCard, capabilities } =
    options;
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
    const devicePasskeyOutput = devicePasskeyOutputFromRegistration(registration.attestationObject);

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
        // extraction should replace this once Step 2.2 (device sub-card /
        // routine WebAuthn login) needs to verify against it.
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
      capabilities,
      ...(options.subCardKeyId ? { subCardKeyId: options.subCardKeyId } : {}),
    });

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
