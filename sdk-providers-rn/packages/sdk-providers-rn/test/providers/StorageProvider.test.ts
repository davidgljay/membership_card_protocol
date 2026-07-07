jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { storageProviderContractTests } from '@membership-card-protocol/app-sdk/testing';
import { AsyncStorageProvider } from '../../src/StorageProvider.js'; // jest-config mapps alias below

describe('AsyncStorageProvider contract', () => {
  for (const [name, run] of Object.entries(
    storageProviderContractTests(async () => new AsyncStorageProvider(`ns-${Math.random()}`))
  )) {
    it(name, run);
  }
});
