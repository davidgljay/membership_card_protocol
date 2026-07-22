/** @type {import('jest').Config} */
export default {
  preset: 'react-native',
  testMatch: ['**/test/**/*.test.ts'],
  moduleNameMapper: {
    // sdk-providers-rn is a separate, sibling npm package with its own
    // node_modules tree (not hoisted into this one) — a jest.mock() call
    // registered in *this* package's setup wouldn't intercept sdk-providers-
    // rn's own require() of these native modules, since Node/Jest resolves
    // a package's dependencies relative to *its own* location, not the
    // caller's. moduleNameMapper matches by specifier string instead,
    // uniformly regardless of which node_modules copy would have resolved.
    // Same fakes/shapes as sdk-providers-rn's own unit tests
    // (test/providers/{SecureKeyProvider,StorageProvider}.test.ts).
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '^react-native-keychain$': '<rootDir>/test/mocks/reactNativeKeychainMock.js',
    // Never actually invoked by this harness — see the stub file's own doc.
    '^react-native-passkey$': '<rootDir>/test/mocks/unusedNativeModuleStub.js',
    '^react-native-sse$': '<rootDir>/test/mocks/unusedNativeModuleStub.js',
    // Every local workspace package here is ESM-only (no "require" export
    // condition) or, like wallet-sdk, only resolvable after a separate
    // build step — Jest's CJS-style resolver can't follow either. Map
    // straight to .ts source instead, exactly like sdk-providers-rn's own
    // jest.config.js does for the same reason: no build step needed, and
    // every file transforms the same way the rest of this suite already
    // does.
    '^@membership-card-protocol/app-sdk/testing$':
      '<rootDir>/../../../app-sdk/packages/app-sdk/src/testing/index.ts',
    '^@membership-card-protocol/app-sdk$': '<rootDir>/../../../app-sdk/packages/app-sdk/src/index.ts',
    '^@membership-card-protocol/wallet-sdk$': '<rootDir>/../../../wallet-sdk/packages/wallet-sdk/src/index.ts',
    '^@membership-card-protocol/sdk-providers-rn$':
      '<rootDir>/../../../sdk-providers-rn/packages/sdk-providers-rn/src/index.ts',
    '^@membership-card-protocol/verifier$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier/src/index.ts',
    '^@membership-card-protocol/verifier-ipfs-provider$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier-ipfs-provider/src/index.ts',
    '^@membership-card-protocol/verifier-rpc-provider$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier-rpc-provider/src/index.ts',
    '^@membership-card-protocol/integration-fixtures$': '<rootDir>/../../fixtures/src/index.ts',
    // Source uses NodeNext/bundler-style relative imports ending in `.js`
    // (pointing at the `.ts` source file, per TS convention for ESM
    // output). Jest's CJS-style resolver doesn't do that remapping itself.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
  // See sdk-providers-rn/jest.config.js's identical comment: the
  // react-native preset only exempts react-native-prefixed packages from
  // the "don't transform node_modules" rule; @noble/* and @react-native/*
  // ship ESM-only or with Flow types and need the same exemption,
  // including nested pnpm virtual-store copies pulled in transitively
  // through app-sdk/wallet-sdk/sdk-providers-rn.
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native|@noble|\\.pnpm/@noble|\\.pnpm/@react-native)',
  ],
};
