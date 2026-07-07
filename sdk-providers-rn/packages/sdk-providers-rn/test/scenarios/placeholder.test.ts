jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { runPlaceholderScenario } from '@membership-card-protocol/app-sdk/testing';
import { AsyncStorageProvider } from '../../src/StorageProvider.js';

/**
 * Step 1.7: the shared cross-platform scenario, run against the RN
 * default providers. See app-sdk/src/testing/scenarios.ts's doc — the
 * same scenario function runs unmodified in sdk-providers-web's test suite
 * (test/scenarios/placeholder.test.ts) against the web defaults, and both
 * must produce the same result.
 */
describe('shared scenario harness — placeholder (RN)', () => {
  it('produces the same result the web provider set is expected to produce', async () => {
    const storage = new AsyncStorageProvider(`scenario-${Math.random()}`);
    const result = await runPlaceholderScenario({ storage });

    expect(result).toEqual({
      stored: true,
      retrieved: 'placeholder-scenario-value',
      deletedAfterRemoval: true,
    });
  });
});
