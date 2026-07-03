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
    '^@membership-card-protocol/client-sdk/testing$':
      '<rootDir>/../client-sdk/src/testing/index.ts',
    '^@membership-card-protocol/client-sdk$': '<rootDir>/../client-sdk/src/index.ts',
    // client-sdk's own file: dependencies on the verifier packages hit the
    // same "exports" map has no require condition" gap Jest's CJS resolver
    // runs into — those two packages aren't published to npm yet either,
    // so map straight to their source for the same reason as above.
    '^@membership-card-protocol/verifier$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier/src/index.ts',
    '^@membership-card-protocol/verifier-ipfs-provider$':
      '<rootDir>/../../../membership_card_verifier/packages/verifier-ipfs-provider/src/index.ts',
    // The verifier package's own @noble/* deps live in
    // membership_card_verifier's separate, non-hoisted pnpm store
    // (.pnpm/@noble+post-quantum@.../node_modules/@noble/...), which the
    // transformIgnorePatterns allow-list below can't match (it only checks
    // the segment immediately after "node_modules/", not pnpm's nested
    // virtual store layout). Redirect to this workspace's own hoisted,
    // already-working @noble/* install instead.
    '^@noble/(.*)$': '<rootDir>/../../node_modules/@noble/$1',
    // Source uses NodeNext/bundler-style relative imports ending in `.js`
    // (pointing at the `.ts` source file, per TS convention for ESM
    // output). Jest's CJS-style resolver doesn't do that remapping itself.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // The react-native preset's default only spares react-native-prefixed
  // packages from the "don't transform node_modules" rule. @noble/* ships
  // ESM-only, so it needs the same exemption or Jest's CJS require() chokes
  // on its `import` statements.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
};
