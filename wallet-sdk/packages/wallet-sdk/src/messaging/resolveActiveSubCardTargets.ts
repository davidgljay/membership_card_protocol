import { keccak256 } from '@membership-card-protocol/app-sdk';
import type { CardDocument } from '@membership-card-protocol/app-sdk';

/**
 * A sub-card message target: the public key and derived address
 * from an entry in the master card's `active_subcards` directory.
 */
export interface SubCardMessageTarget {
  /** The ML-DSA-44 public key (base64url) from active_subcards entry. */
  pubkey: string;
  /** Derived address: keccak256(pubkey), lowercase hex without 0x prefix. */
  address: string;
}

/**
 * Read the master card's `active_subcards` directory and resolve each entry
 * to a `SubCardMessageTarget` (pubkey + derived address).
 *
 * This is a pure, synchronous function with no network I/O: it operates only
 * on the already-decrypted master `CardDocument`. The caller is responsible
 * for fetching and decrypting the master card independently.
 *
 * A card with no `active_subcards` field (or an empty array) returns `[]`,
 * matching the protocol's "absence = no active sub-cards" convention.
 * This function does not throw if the field is missing or malformed — it
 * treats any non-array value as "no sub-cards."
 *
 * The returned addresses are suitable for on-chain lookups or as routing
 * targets for message fanout via App SDK's `fanOutMessageToSubCards`, though
 * the actual ML-KEM public keys needed for message encryption must be
 * resolved separately (e.g. from on-chain device registration or a
 * side-channel credential store).
 *
 * This is the **read side** of the `active_subcards` directory only — see
 * §6.6 for the write side (code-510/511 posting on registration/deregistration).
 *
 * @param masterCard - The decrypted master `CardDocument`.
 * @returns Array of `SubCardMessageTarget`, one per active sub-card.
 */
export function resolveActiveSubCardTargets(masterCard: CardDocument): SubCardMessageTarget[] {
  const activeSubcards = masterCard.active_subcards;
  if (!Array.isArray(activeSubcards)) {
    return [];
  }

  return activeSubcards
    .map((pubkeyB64) => {
      let pubkeyBytes: Uint8Array;
      try {
        pubkeyBytes = new Uint8Array(Buffer.from(pubkeyB64, 'base64url'));
      } catch {
        // If base64url decode fails, skip this entry
        return null;
      }
      const address = keccak256(pubkeyBytes);
      return {
        pubkey: pubkeyB64,
        address,
      };
    })
    .filter((target): target is SubCardMessageTarget => target !== null);
}
