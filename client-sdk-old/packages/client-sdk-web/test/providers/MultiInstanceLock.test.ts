import { describe, it, expect } from 'vitest';
import { multiInstanceLockContractTests } from '@membership-card-protocol/client-sdk/testing';
import { BroadcastChannelMultiInstanceLock } from '../../src/MultiInstanceLock.js';

describe('BroadcastChannelMultiInstanceLock contract', () => {
  for (const [name, run] of Object.entries(
    multiInstanceLockContractTests(async () => new BroadcastChannelMultiInstanceLock())
  )) {
    it(name, run);
  }
});

describe('BroadcastChannelMultiInstanceLock — two-tab simulation', () => {
  it('a second, independent lock instance (simulating another tab) cannot acquire while the first holds the lock', async () => {
    const tabA = new BroadcastChannelMultiInstanceLock();
    const tabB = new BroadcastChannelMultiInstanceLock();

    const releaseA = await tabA.acquire('cross-tab-lock');

    let tabBAcquired = false;
    const tabBAcquirePromise = tabB.acquire('cross-tab-lock').then((release) => {
      tabBAcquired = true;
      return release;
    });

    // Give tab B's acquire attempt a chance to run and confirm it's still
    // blocked while tab A holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tabBAcquired).toBe(false);

    releaseA();

    const releaseB = await tabBAcquirePromise;
    expect(tabBAcquired).toBe(true);
    releaseB();
  });
});
