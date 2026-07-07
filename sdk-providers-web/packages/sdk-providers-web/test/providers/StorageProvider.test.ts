import { describe, it } from 'vitest';
import { storageProviderContractTests } from '@membership-card-protocol/app-sdk/testing';
import { IndexedDBStorageProvider } from '../../src/StorageProvider.js';

describe('IndexedDBStorageProvider contract', () => {
  for (const [name, run] of Object.entries(
    storageProviderContractTests(async () => new IndexedDBStorageProvider(`ns-${crypto.randomUUID()}`))
  )) {
    it(name, run);
  }
});
