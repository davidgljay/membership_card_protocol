import type { MultiInstanceLock } from '@membership-card-protocol/app-sdk';

/**
 * Default React Native `MultiInstanceLock` (OQ-SDK-8): a no-op.
 *
 * Multi-instance coordination is a web-only concern (multiple tabs sharing
 * one origin's storage); RN's single-foreground-instance-per-app model has
 * no equivalent to coordinate.
 */
export class NoopMultiInstanceLock implements MultiInstanceLock {
  async acquire(_name: string): Promise<() => void> {
    return () => {};
  }
}
