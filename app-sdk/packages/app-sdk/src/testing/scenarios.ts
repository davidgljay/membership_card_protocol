import type { StorageProvider } from '../providers/StorageProvider.js';

/**
 * Shared cross-platform scenario harness (Step 1.7): a scenario is written
 * once, against the core package's public API, and run twice — once
 * wired to web default providers, once to RN default providers — proving
 * the harness itself works before real scenarios (wallet setup, offer
 * acceptance, sub-card requests, messaging) are written against it in
 * later phases.
 *
 * This placeholder scenario ("construct providers, call one no-op-ish
 * method, confirm identical output") uses StorageProvider specifically
 * because both platform defaults are expected to satisfy the exact same
 * contract (Step 1.2's storageProviderContractTests) — a real behavioral
 * equivalence to assert on, not just "did it throw."
 */
export interface PlaceholderScenarioProviders {
  storage: StorageProvider;
}

export interface PlaceholderScenarioResult {
  stored: boolean;
  retrieved: string | null;
  deletedAfterRemoval: boolean;
}

const KEY = 'placeholder-scenario-key';
const VALUE = 'placeholder-scenario-value';

export async function runPlaceholderScenario(
  providers: PlaceholderScenarioProviders
): Promise<PlaceholderScenarioResult> {
  await providers.storage.set(KEY, new TextEncoder().encode(VALUE));
  const retrievedBytes = await providers.storage.get(KEY);
  const retrieved = retrievedBytes ? new TextDecoder().decode(retrievedBytes) : null;

  await providers.storage.delete(KEY);
  const afterDelete = await providers.storage.get(KEY);

  return {
    stored: retrieved !== null,
    retrieved,
    deletedAfterRemoval: afterDelete === undefined,
  };
}
