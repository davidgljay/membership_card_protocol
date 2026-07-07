/**
 * Injected named-lock abstraction for multi-tab/multi-instance coordination
 * (OQ-SDK-8).
 *
 * On web, two tabs may share the same keyring/`StorageProvider`; this lock
 * prevents them from independently consuming the same UUID from a pool or
 * racing a keyring update against each other. Not applicable on React
 * Native's single-foreground-instance model.
 *
 * Default implementations: a `BroadcastChannel`-based lock on web
 * (`@membership-card-protocol/client-sdk-web`); a no-op on React Native
 * (`@membership-card-protocol/client-sdk-rn`).
 */
export interface MultiInstanceLock {
  /**
   * Acquire the named lock, waiting if another instance currently holds it.
   *
   * @param name - Lock name; callers sharing a name contend for the same
   *   lock.
   * @returns A release function. Must be called exactly once to release the
   *   lock.
   */
  acquire(name: string): Promise<() => void>;
}
