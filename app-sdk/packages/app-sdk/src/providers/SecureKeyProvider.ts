/**
 * Injected hardware-backed (or platform-equivalent) non-exportable signing
 * key abstraction.
 *
 * This is the interface both the device sub-card key and the requester-side
 * sub-card key (OQ-SDK-10) are generated and used through — the SDK never
 * holds a sub-card private key as a plain JS value outside the single
 * signing operation that needs it.
 *
 * See `wallet_sdk.md` (Secure Enclave/TPM custody for the device sub-card
 * key) and `subcards.md §Sub-Card Key Management` (non-exportability and
 * attestation-tier requirements this interface's default implementations
 * must satisfy).
 *
 * Default implementations: a non-extractable WebCrypto `CryptoKey`
 * persisted via IndexedDB on web (software-only — see OQ-SDK-1's disclosed
 * security-posture gap vs. native); Secure Enclave (iOS) / StrongBox-backed
 * `AndroidKeyStore` (Android) on React Native.
 */
export interface SecureKeyProvider {
  /**
   * Generate a new non-exportable ML-DSA-44 keypair and return a handle to
   * it. The private key never leaves the provider's custody — no method on
   * this interface returns private key material.
   *
   * @param keyId - Caller-chosen identifier used to retrieve this key again
   *   via {@link sign}/{@link getPublicKey}/{@link delete}.
   * @returns The new key's public key.
   */
  generateKey(keyId: string): Promise<Uint8Array>;

  /**
   * Sign `message` with the private key referenced by `keyId`.
   *
   * @throws If no key exists under `keyId`.
   */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;

  /**
   * Return the public key for a previously generated key.
   *
   * @returns The public key, or `undefined` if no key exists under `keyId`.
   */
  getPublicKey(keyId: string): Promise<Uint8Array | undefined>;

  /**
   * Irreversibly delete the key referenced by `keyId`. A no-op (not an
   * error) if the key does not exist.
   */
  delete(keyId: string): Promise<void>;
}
