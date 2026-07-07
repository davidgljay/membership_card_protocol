/** @type {import('jest').Config} */
export default {
  preset: 'react-native',
  testMatch: ['**/test/**/*.test.ts'],
  moduleNameMapper: {
    // Map straight to source rather than the compiled dist/ output: the
    // package.json "exports" map only declares an "import" condition
    // (this package is ESM-only), which Jest's CJS-style resolver doesn't
    // match. Going through .ts source sidesteps that — it transforms the
    // same way every other .ts file in this package's own test suite
    // already does.
    '^@membership-card-protocol/app-sdk/testing$':
      '<rootDir>/../../../app-sdk/packages/app-sdk/src/testing/index.ts',
    '^@membership-card-protocol/app-sdk$': '<rootDir>/../../../app-sdk/packages/app-sdk/src/index.ts',
    // app-sdk's own file: dependencies on the verifier packages hit the
    // same "exports" map has no require condition" gap Jest's CJS resolver
    // runs into — those two packages aren't published to npm yet either,
    // so map straight to their source for the same reason as above.
    '^@membership-card-protocol/verifier$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier/src/index.ts',
    '^@membership-card-protocol/verifier-ipfs-provider$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier-ipfs-provider/src/index.ts',
    // Source uses NodeNext/bundler-style relative imports ending in `.js`
    // (pointing at the `.ts` source file, per TS convention for ESM
    // output). Jest's CJS-style resolver doesn't do that remapping itself.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
  // The react-native preset's default only spares react-native-prefixed
  // packages from the "don't transform node_modules" rule. @noble/* and
  // @react-native/* ship ESM-only or with Flow types, so they need the same
  // exemption or Jest's CJS require() chokes on their `import` statements
  // or Flow type annotations — including app-sdk's own copy, which pnpm
  // resolves through its separate, non-hoisted `.pnpm/@noble+curves@<ver>/
  // node_modules/@noble/...` virtual-store layout. A single combined
  // pattern handles both shapes (hoisted `node_modules/@noble/...` and
  // nested `.pnpm/@noble+.../node_modules/@noble/...`).
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native|@noble|\\.pnpm/@noble|\\.pnpm/@react-native)',
  ],
};
