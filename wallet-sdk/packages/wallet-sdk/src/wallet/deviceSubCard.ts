import { requestSubCard } from '@membership-card-protocol/app-sdk';
import type {
  SecureKeyProvider,
  WalletAppCardIdentity,
  RegisterSubCardFn,
  SignedSubCardDocument,
} from '@membership-card-protocol/app-sdk';
import { assembleSubCardConsent } from '../subcards/consent.js';
import { countersignSubCardRequest } from '../subcards/countersign.js';
import { handleSubCardRequest } from '../subcards/handleSubCardRequest.js';
import type { CardVerifier } from '@membership-card-protocol/app-sdk';

/**
 * Device sub-card generation and registration
 * (`wallet_backup_and_recovery.md §Process 1` Steps 7–9;
 * `wallet_sdk.md §5.4`).
 *
 * Per the strategic plan's resolved `deviceSubCard` collapse decision
 * (Split-SDK-3): this is now a thin wrapper around App SDK's ordinary
 * `requestSubCard` + this package's own consent/countersign primitives,
 * rather than a parallel self-signing implementation. The wallet is both
 * requester and granter here — it self-authorizes the consent step
 * (`decision.approvedCapabilities === requestedCapabilities`, no actual
 * UI/consent step) — but otherwise goes through the ordinary protocol
 * pipeline (request → validate → consent → countersign → register), so the
 * device sub-card's lifecycle is identical to any other sub-card from a
 * protocol perspective. The old parallel self-signing code path (generate
 * key, hand-assemble `SubCardDocumentFields`, sign both `app_signature` and
 * `holder_signature` directly) has been superseded by this wrapper.
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
 * itself — but the request/validate/consent/countersign pipeline itself is
 * still exercised, just with the wallet supplying both roles.
 */
export interface RegisterDeviceSubCardOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `holder_primary_card` — the holder's card_hash. */
  cardHash: string;
  /** `holder_primary_card_pubkey`. */
  masterPublicKey: Uint8Array;
  /**
   * Used once, synchronously, to countersign the request. Caller retains
   * ownership of this value's lifecycle (accessed from the keyring,
   * cleared after use — `wallet_backup_and_recovery.md §Process 1` Step 8);
   * this function does not clear or retain it.
   */
  masterSecretKey: Uint8Array;
  /** The wallet's own governance-certified app identity — the requester side of this self-request. */
  walletAppCard: WalletAppCardIdentity;
  registerSubCard: RegisterSubCardFn;
  /** Whitelist of message-type strings this sub-card may sign. Left to the caller — the device sub-card's routine-operation scope is a product decision, not something this step hardcodes. */
  capabilities: string[];
  /** `SecureKeyProvider` key identifier for the new device sub-card. Defaults to `'device-sub-card'`. */
  subCardKeyId?: string;
  validUntil?: string;
  /**
   * The shared `CardVerifier` instance used to validate the wallet's own
   * app-card chain (§6.1) before self-authorizing consent — same instance
   * used everywhere else in this SDK. Since the wallet's own app card is
   * necessarily already trusted (it's the wallet's own governance-certified
   * identity), this validation step is expected to always pass; it is run
   * anyway so the device sub-card goes through the identical pipeline any
   * other sub-card would, per this module's own design goal.
   */
  cardVerifier: CardVerifier;
}

export interface DeviceSubCardResult {
  subCardPublicKey: Uint8Array;
  subCardKeyId: string;
  document: SignedSubCardDocument;
  registered: boolean;
}

const DEFAULT_SUB_CARD_KEY_ID = 'device-sub-card';

/**
 * Thin wrapper: App SDK's `requestSubCard` (request) → this package's own
 * `handleSubCardRequest` (validate) → `assembleSubCardConsent` (consent,
 * self-authorized) → `countersignSubCardRequest` (countersign + register).
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
    cardVerifier,
  } = options;
  const subCardKeyId = options.subCardKeyId ?? DEFAULT_SUB_CARD_KEY_ID;

  // Step 1: request, via App SDK's ordinary requester-side primitive — the
  // wallet acts as its own requesting app.
  const { subCardPublicKey, document: appSignedRequest } = await requestSubCard({
    secureKeyProvider,
    subCardKeyId,
    appCard: walletAppCard,
    holderPrimaryCard: cardHash,
    holderPrimaryCardPubkey: masterPublicKey,
    capabilities,
    attestationLevel: 'T1',
    ...(validUntil ? { validUntil } : {}),
  });

  // Step 2: validate, via this package's own wallet-side validation — the
  // wallet's own app card must pass the identical checks any other app's
  // would.
  const validated = await handleSubCardRequest({ cardVerifier, request: appSignedRequest });
  if (!validated.valid) {
    throw new Error(
      `registerDeviceSubCard: the wallet's own app-signed request failed validation (${validated.code}): ${validated.reason}`
    );
  }

  // Step 3: consent, self-authorized — the wallet is both requester and
  // granter, so `grantableCapabilities` is set to the full requested set
  // and the decision approves exactly that (no UI/consent step).
  const consentData = assembleSubCardConsent({
    validated,
    appIdentity: { name: 'wallet' },
    walletGrantableCapabilities: capabilities,
  });

  // Step 4: countersign + register, via this package's own primitives.
  const outcome = await countersignSubCardRequest({
    consentData,
    decision: { approved: true, approvedCapabilities: consentData.requestedCapabilities },
    masterSecretKey,
    registerSubCard,
  });

  if (!outcome.countersigned) {
    throw new Error(`registerDeviceSubCard: self-countersign unexpectedly failed: ${outcome.reason}`);
  }

  return {
    subCardPublicKey,
    subCardKeyId,
    document: outcome.document,
    registered: outcome.registered,
  };
}
