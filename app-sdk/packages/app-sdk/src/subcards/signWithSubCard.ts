import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

/**
 * Sign arbitrary data with a sub-card (`app_sdk.md §7.2`) — a thin wrapper
 * over `SecureKeyProvider.sign`, given a `keyId` (obtained from
 * `requestSubCard`'s result or from a wallet's own sub-card registry).
 * Used by apps and wallet-side integrators that need to prove sub-card
 * ownership without going through a full protocol flow (e.g., a relay
 * proving it owns its own sub-card when talking to a wallet-service, or an
 * app signing a challenge during app-to-wallet communication).
 *
 * Structurally identical to `SecureKeyProvider.sign` but operates at the
 * App SDK surface level, inheriting the same "structured guarantees against
 * key export" contract as any other this-SDK-visible function using secure
 * keys — this function never returns anything but the resulting signature
 * bytes, and never touches key material directly.
 */
export interface SignWithSubCardOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `SecureKeyProvider` key id for the sub-card whose key should sign `message`. */
  keyId: string;
  message: Uint8Array;
}

export async function signWithSubCard(options: SignWithSubCardOptions): Promise<Uint8Array> {
  return options.secureKeyProvider.sign(options.keyId, options.message);
}
