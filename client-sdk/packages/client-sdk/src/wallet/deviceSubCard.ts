import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Sign } from '../crypto/mldsa.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

/**
 * `SubCardDocument` (`protocol-objects.md §16`) — the genesis document for
 * a sub-card. This module only ever assembles the **wallet self-signing**
 * variant (`subcards.md`'s "wallet self-signing exception": the requesting
 * app IS the wallet, so the user-consent step is skipped) — the general
 * third-party request/countersign flow is Phase 4's job.
 */
export interface SubCardDocumentFields {
  holder_primary_card: string;
  holder_primary_card_pubkey: string;
  app_card: string;
  app_card_pubkey: string;
  capabilities: string[];
  recipient_pubkey: string;
  issued_at: string;
  valid_until?: string;
  attestation_level: 'T1' | 'T2';
  attestation_proof?: string;
}

export interface SignedSubCardDocument extends SubCardDocumentFields {
  app_signature: string;
  holder_signature: string;
}

/**
 * The wallet software's own governance-certified app identity
 * (`subcards.md`: "The wallet is itself an app — it has its own app card
 * and creates its own sub-cards"). This is a fixed identity belonging to
 * the wallet application itself, not something generated per holder —
 * bootstrapping/certifying it is out of scope for this step and is
 * injected here, following implementation-plan.md Step 2.2's own
 * allowance to "stub the self-signing path here and wire it to the real
 * implementation once Phase 4 lands."
 */
export interface WalletAppCardIdentity {
  /** Mutable pointer of the wallet's own app card. */
  cardPointer: string;
  /** ML-DSA-44 public key of the wallet's own app card, 1312 bytes raw. */
  publicKey: Uint8Array;
  /** Signs `message` with the wallet app card's own private key. */
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface RegisterSubCardResult {
  registered: boolean;
}

/**
 * Stands in for Phase 4 Step 4.4's press-submission flow — the spec's
 * simplified "posted on Arbitrum One" (`wallet_backup_and_recovery.md
 * §Process 1` Step 9) is, per `protocol-objects.md §16` step 10, actually
 * accomplished by a press verifying the completed document off-chain and
 * calling `RegisterSubCard` on-chain. Injected for the same reason as
 * `WalletAppCardIdentity` above.
 */
export type RegisterSubCardFn = (doc: SignedSubCardDocument) => Promise<RegisterSubCardResult>;

export interface RegisterDeviceSubCardOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `holder_primary_card` — the holder's card_hash. */
  cardHash: string;
  /** `holder_primary_card_pubkey`. */
  masterPublicKey: Uint8Array;
  /**
   * Used once, synchronously, to produce `holder_signature`. Caller retains
   * ownership of this value's lifecycle (accessed from the keyring,
   * cleared after use — `wallet_backup_and_recovery.md §Process 1` Step 8);
   * this function does not clear or retain it.
   */
  masterSecretKey: Uint8Array;
  walletAppCard: WalletAppCardIdentity;
  registerSubCard: RegisterSubCardFn;
  /** Whitelist of message-type strings this sub-card may sign. Left to the caller — the device sub-card's routine-operation scope is a product decision, not something this step hardcodes. */
  capabilities: string[];
  /** `SecureKeyProvider` key identifier for the new device sub-card. Defaults to `'device-sub-card'`. */
  subCardKeyId?: string;
  validUntil?: string;
}

export interface DeviceSubCardResult {
  subCardPublicKey: Uint8Array;
  subCardKeyId: string;
  document: SignedSubCardDocument;
  registered: boolean;
}

const DEFAULT_SUB_CARD_KEY_ID = 'device-sub-card';

/**
 * Device sub-card generation and registration
 * (`wallet_backup_and_recovery.md §Process 1` Steps 7–9).
 *
 * `attestation_level` is hardcoded to `'T1'` (hardware-backed key storage
 * only — accurate for what `SecureKeyProvider` actually provides) since no
 * App Attest / Play Integrity attestation provider exists in this SDK yet;
 * `subcards.md` requires governing-policy sign-off to accept T1 generally,
 * but the wallet's own first-party device sub-card is a closed case. `T2`
 * support needs a real attestation provider, out of scope here.
 *
 * No user-consent step: per `subcards.md`'s "wallet self-signing
 * exception," this is skipped when the requesting app is the wallet
 * itself.
 */
export async function registerDeviceSubCard(
  options: RegisterDeviceSubCardOptions
): Promise<DeviceSubCardResult> {
  const {
    secureKeyProvider,
    cardHash,
    masterPublicKey,
    masterSecretKey,
    walletAppCard,
    registerSubCard,
    capabilities,
    validUntil,
  } = options;
  const subCardKeyId = options.subCardKeyId ?? DEFAULT_SUB_CARD_KEY_ID;

  // Step 7: device sub-card keypair, non-exportable (hardware-backed on RN,
  // non-extractable WebCrypto on web — SecureKeyProvider's default
  // implementations, Steps 1.5/1.6).
  const subCardPublicKey = await secureKeyProvider.generateKey(subCardKeyId);

  const unsignedFields: SubCardDocumentFields = {
    holder_primary_card: cardHash,
    holder_primary_card_pubkey: bytesToBase64Url(masterPublicKey),
    app_card: walletAppCard.cardPointer,
    app_card_pubkey: bytesToBase64Url(walletAppCard.publicKey),
    capabilities,
    recipient_pubkey: bytesToBase64Url(subCardPublicKey),
    issued_at: new Date().toISOString(),
    attestation_level: 'T1',
    ...(validUntil ? { valid_until: validUntil } : {}),
  };

  // app_signature: covers all fields except both signature fields
  // (protocol-objects.md §16).
  const appSignature = await walletAppCard.sign(canonicalize(unsignedFields));
  const withAppSignature = { ...unsignedFields, app_signature: bytesToBase64Url(appSignature) };

  // Step 8: holder_signature, via the master key accessed from the keyring
  // — no consent prompt (wallet self-signing exception).
  const holderSignature = mlDsa44Sign(masterSecretKey, canonicalize(withAppSignature));
  const document: SignedSubCardDocument = {
    ...withAppSignature,
    holder_signature: bytesToBase64Url(holderSignature),
  };

  // Step 9: press submission (stubbed — see this function's doc comment).
  const { registered } = await registerSubCard(document);

  return { subCardPublicKey, subCardKeyId, document, registered };
}
