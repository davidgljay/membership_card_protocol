import { describe, it, expect } from 'vitest';
import { runPlaceholderScenario } from '@membership-card-protocol/client-sdk/testing';
import { IndexedDBStorageProvider } from '../../src/StorageProvider.js';

/**
 * Step 1.7: the shared cross-platform scenario, run against the web
 * default providers. See client-sdk/src/testing/scenarios.ts's doc — the
 * same scenario function runs unmodified in client-sdk-rn's test suite
 * (test/scenarios/placeholder.test.ts) against the RN defaults, and both
 * must produce the same result.
 */
describe('shared scenario harness — placeholder (web)', () => {
  it('produces the same result the RN provider set is expected to produce', async () => {
    const storage = new IndexedDBStorageProvider(`scenario-${crypto.randomUUID()}`);
    const result = await runPlaceholderScenario({ storage });

    expect(result).toEqual({
      stored: true,
      retrieved: 'placeholder-scenario-value',
      deletedAfterRemoval: true,
    });
  });
});
