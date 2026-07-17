/**
 * Injected WebAuthn/passkey abstraction (OQ-SDK-2).
 *
 * Abstracts `navigator.credentials` on web vs. an injected React Native
 * implementation, so device-custody setup and re-establishment flows
 * (`wallet_sdk.md`) can call one interface regardless of platform. This
 * package exports the interface for consistency with the other provider
 * interfaces, but does not require or consume `PasskeyProvider` directly —
 * see `wallet_sdk.md` for the flows that actually use it.
 *
 * Default implementations: `navigator.credentials` on web
 * (`@membership-card-protocol/sdk-providers-web`); `react-native-passkey` on
 * React Native (`@membership-card-protocol/sdk-providers-rn`) — a host app may
 * inject its own RN implementation to override the shipped default.
 */
export interface PasskeyProvider {
  /**
   * Register a new passkey for this device, per `wallet_sdk.md`'s
   * device-bound passkey creation step.
   *
   * @param challenge - Server-issued registration challenge.
   * @returns The attestation response and the resulting credential ID.
   */
  register(challenge: Uint8Array): Promise<{
    credentialId: Uint8Array;
    attestationObject: Uint8Array;
    clientDataJSON: Uint8Array;
    /**
     * WebAuthn PRF extension output, if the platform authenticator supports
     * it — a deterministic, credential-bound secret, unlike
     * `attestationObject` (which is ceremony-specific and never
     * reproducible from a later `assert()`). Required by Wallet SDK's
     * synced-passkey device-custody re-establishment flows to be usable
     * later, since those flows can only `assert()` against a synced
     * credential, never `register()` it again.
     */
    prfOutput?: Uint8Array;
  }>;

  /**
   * Produce an assertion against a previously registered passkey — used
   * both for routine authentication challenges and, in Wallet SDK, for
   * deriving `device_passkey_output` during its device-custody flows.
   *
   * @param challenge - Server-issued assertion challenge.
   * @param credentialId - Optional credential to assert against; omitted to
   *   let the platform's passkey UI resolve which credential to use.
   */
  assert(
    challenge: Uint8Array,
    credentialId?: Uint8Array
  ): Promise<{
    credentialId: Uint8Array;
    authenticatorData: Uint8Array;
    clientDataJSON: Uint8Array;
    signature: Uint8Array;
    /** Same WebAuthn PRF extension output as {@link register}'s, for the same credential — see that field's doc. */
    prfOutput?: Uint8Array;
  }>;
}
