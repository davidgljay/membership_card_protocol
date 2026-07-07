/**
 * Injected YubiKey wrapping-key abstraction — introduced by Step 2.3
 * (backup registration), not part of Phase 1's original provider set.
 *
 * `wallet_backup_and_recovery.md §Process 1` Step 14 ("YubiKey backup
 * registration, opt-in upgrade") describes the on-device operation only
 * abstractly: "the YubiKey computes a device-scoped derivation; the result
 * is used as a wrapping key," PIN required. It does not mandate a specific
 * YubiKey feature (FIDO2 `hmac-secret`, PIV, or HMAC-SHA1 challenge-response
 * are all candidates), and actual hardware interaction is out of scope for
 * this SDK phase — this interface contracts only the derived output, so a
 * concrete implementation (host app or a future
 * `client-sdk-*`/yubikey package) can be injected without this module
 * depending on any specific YubiKey transport library.
 *
 * Unlike the six Phase 1 providers, this one is optional: YubiKey backup is
 * opt-in (`WalletSetupOptions.yubiKeyProvider` is undefined by default).
 */
export interface YubiKeyProvider {
  /**
   * Derive a device-scoped wrapping key from an inserted YubiKey.
   *
   * @param pin - The YubiKey PIN, required to authorize the derivation.
   */
  deriveWrappingKey(pin: string): Promise<Uint8Array>;
}
