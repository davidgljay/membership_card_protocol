import { postCardUpdate } from '../updates/postCardUpdate.js';
import type { ObliviousProtocolTransport } from '@membership-card-protocol/app-sdk';

/**
 * Sub-card 8xx revocation (`subcard_creation_policy.md §Revocation — 8xx`;
 * `card_updates.md`) — submitted via the general card-update-intent flow
 * (`POST /update`), not a sub-card-specific endpoint, per
 * `protocol-objects.md §4 UpdateIntentPayload`.
 *
 * **Structural 9xx exclusion**, per the strategic plan's explicit scope
 * exclusion ("the SDK does not expose an API capable of constructing a 9xx
 * sub-card revocation"): {@link SubCardRevocationCode} is a literal union
 * of exactly the codes `subcard_creation_policy.md §Revocation — 8xx`
 * assigns to the sub-card context (800, 801, 810, 811) — there is no
 * TypeScript value of that type that names a 9xx code, so no caller of
 * {@link revokeSubCard} can construct one even by mistake. This is
 * enforced again at runtime (not just relying on the type system) in case
 * a caller bypasses TypeScript.
 *
 * **Who signs:** `subcard_creation_policy.md` grants 8xx revocation
 * privileges to both "the user" and "the application" — concretely, per
 * this step's own framing, that means the *wallet's own device sub-card*
 * (routine signing key, `deviceSubCard.ts`) for a user-initiated
 * revocation (code 801), or the *requesting app's own installation card*
 * for an app-initiated one (code 811). Either is expressed as an
 * {@link UpdateIntentSigner} — the press resolves the actual public key
 * itself from `updater_card` (`press.md §5.3`'s `processUpdateIntent`:
 * "call `verifier.verifyCard(updateIntent.updater_card_address)` and
 * extract the public key from the resolved card chain"), so this function
 * never needs the signer's public key, only its pointer and a `sign`
 * callback — App SDK's `WalletAppCardIdentity` already satisfies this
 * shape structurally, and a `SecureKeyProvider`-backed sub-card key can be
 * adapted to it with a one-line closure.
 */

export type SubCardRevocationCode = 800 | 801 | 810 | 811;

const VALID_CODES: ReadonlySet<number> = new Set([800, 801, 810, 811]);

export interface UpdateIntentSigner {
  /** `updater_card` — mutable pointer of the signer's own card. */
  cardPointer: string;
  /** base64url public key of the signer's card — the press verifies the intent signature with it. */
  publicKey: string;
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface RevokeSubCardOptions {
  transport: ObliviousProtocolTransport;
  /** Any press listed in the policy's `approved_presses` — the updater need not use the original issuing press. */
  pressBaseUrl: string;
  /** Mutable pointer of the sub-card being revoked (`target_card`). */
  targetSubCard: string;
  /** base64url public key of the sub-card being revoked — the press uses it to append to the sub-card's encrypted log (press.md §5.3). */
  targetSubCardPublicKey: string;
  /** Whoever is submitting this revocation — see this module's doc for the two expected cases. */
  updater: UpdateIntentSigner;
  code: SubCardRevocationCode;
  /** Defaults to now. May predate posting, per `card_updates.md`. */
  effectiveDate?: string;
  note?: string;
  /** Defaults to `true`. */
  notifyHolder?: boolean;
}

export interface RevokeSubCardResult {
  logEntryCid: string;
  newLogHeadCid: string;
}


export async function revokeSubCard(options: RevokeSubCardOptions): Promise<RevokeSubCardResult> {
  if (!VALID_CODES.has(options.code)) {
    throw new Error(
      `revokeSubCard: code ${options.code} is not a valid sub-card 8xx revocation code (must be one of 800, 801, 810, 811).`
    );
  }

  const updateIntent = {
    target_card: options.targetSubCard,
    updater_card: options.updater.cardPointer,
    code: options.code,
    revocation: {
      effective_date: options.effectiveDate ?? new Date().toISOString(),
      ...(options.note ? { note: options.note } : {}),
    },
    notify_holder: options.notifyHolder ?? true,
    timestamp: new Date().toISOString(),
  };

  try {
    return await postCardUpdate({
      transport: options.transport,
      pressBaseUrl: options.pressBaseUrl,
      intent: updateIntent,
      sign: options.updater.sign,
      signerPublicKey: options.updater.publicKey,
      targetCardPublicKey: options.targetSubCardPublicKey,
    });
  } catch (err) {
    throw new Error(`revokeSubCard: ${(err as Error).message}`);
  }
}
