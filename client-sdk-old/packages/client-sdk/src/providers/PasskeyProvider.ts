/**
 * Injected WebAuthn/passkey abstraction (OQ-SDK-2).
 *
 * Abstracts `navigator.credentials` on web vs. an injected React Native
 * implementation, so wallet setup, backup wrapping, and recovery logic
 * (`wallet_backup_and_recovery.md`) can call one interface regardless of
 * platform.
 *
 * Default implementations: `navigator.credentials` on web
 * (`@membership-card-protocol/client-sdk-web`); `react-native-passkey` on
 * React Native (`@membership-card-protocol/client-sdk-rn`) — a host app may
 * inject its own RN implementation to override the shipped default.
 */
export interface PasskeyProvider {
  /**
   * Register a new passkey for this device, per
   * `wallet_backup_and_recovery.md §Process 1`'s device-bound passkey
   * creation step.
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
     * it (added Step 2.4, `wallet/recovery.ts`) — a deterministic,
     * credential-bound secret, unlike `attestationObject` (which is
     * ceremony-specific and never reproducible from a later `assert()`).
     * Required for a synced-passkey backup registration
     * (`wallet/backupRegistration.ts`) to be recoverable later, since
     * recovery can only `assert()` against a synced credential, never
     * `register()` it again.
     */
    prfOutput?: Uint8Array;
  }>;

  /**
   * Produce an assertion against a previously registered passkey — used
   * both for routine authentication challenges and for deriving
   * `device_passkey_output` during backup wrapping/recovery.
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
    /** Same WebAuthn PRF extension output as `register()`'s, for the same credential — see that field's doc. */
    prfOutput?: Uint8Array;
  }>;
}
