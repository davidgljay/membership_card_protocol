import { describe, it } from 'vitest';

/**
 * Cross-platform scenario test (Step 3.2c): RN-flavored counterpart of
 * `setupWallet.web.test.ts`, intended to drive `setupWallet` against
 * `sdk-providers-rn`'s real `SecureEnclaveKeyProvider` /
 * `AsyncStorageProvider`.
 *
 * **Named, confirmed blocker — this file deliberately does not import
 * `@membership-card-protocol/sdk-providers-rn`.** `sdk-providers-rn`'s real
 * provider classes (`SecureEnclaveKeyProvider` wraps
 * `react-native-keychain`, `AsyncStorageProvider` wraps
 * `@react-native-async-storage/async-storage`) are only ever exercised
 * under Jest with the `react-native` preset
 * (`sdk-providers-rn/jest.config.js`: `preset: 'react-native'`,
 * `@react-native/babel-preset` for Flow-syntax stripping, plus that
 * preset's own native-module mocks) — `sdk-providers-rn`'s own
 * `package.json` runs `"test": "jest"`, not Vitest, for exactly this
 * reason. `wallet-sdk` uses Vitest throughout.
 *
 * Confirmed empirically (both as a standalone module import and via a
 * dynamic `await import()` wrapped in try/catch inside a test body — the
 * latter still surfaces as a Vitest "Unhandled Rejection" that fails the
 * whole `pnpm test` run even though the `try`/`catch` correctly caught the
 * promise rejection, because the underlying failure originates in Vite's
 * module-graph loading machinery, not the awaited promise itself):
 * importing `@membership-card-protocol/sdk-providers-rn` under Vitest
 * throws at module-load time, before any test body runs —
 * `react-native-keychain`'s own `package.json` has no `"exports"` map, so
 * Node/Vite's resolver falls through to its `"react-native"`/`"source"`
 * field (`./src/index`) rather than `"main"` (`./lib/commonjs/index.js`),
 * pulling in unbundled Flow-typed source that transitively `require`s
 * `react-native` itself. The actual error, captured verbatim from a real
 * `pnpm test` run:
 *
 * ```
 * SyntaxError: Cannot use import statement outside a module
 *  ❯ Object.<anonymous> .../react-native-keychain/src/index.ts:1:1
 * Module .../react-native/index.js:27 seems to be an ES Module but shipped
 * in a CommonJS package.
 * ```
 *
 * This reproduces even with `vitest.config.ts`'s `server.deps.inline`
 * entries for RN modules already in place (that setting addresses ESM/CJS
 * interop, not Flow-syntax parsing), and even inside a `describe.skip`
 * block (Vitest still statically loads every test file's top-level module
 * graph during collection regardless of `.skip`).
 *
 * This is a genuine cross-toolchain gap (Vitest vs. Jest + the
 * `react-native` preset's Flow-stripping and native-module mocking), not a
 * fixable-in-this-file environment mismatch. Reproducing Jest's
 * `react-native` preset inside Vitest (a Vite plugin that strips Flow
 * syntax and remaps native-module imports to mocks) would be a
 * disproportionate, package-tooling-level change — out of scope for
 * writing scenario tests, and out of scope for this task to fix inside
 * `sdk-providers-rn` (a separate package). Reported per the coordinator's
 * explicit allowance to name this blocker rather than route around it
 * with a fake provider standing in for the real one.
 *
 * The RN-flavored counterparts of the other two Step 3.2c scenarios
 * (`subCardAuthorization`, `offerAcceptance`) would hit the identical
 * import-time failure for the same reason (both need
 * `@membership-card-protocol/sdk-providers-rn`'s real `SecureKeyProvider`/
 * `StorageProvider` classes) and are not separately duplicated here.
 */
describe('setupWallet against real RN providers (Step 3.2c)', () => {
  it.todo(
    'blocked: sdk-providers-rn real providers require the Jest react-native preset (Flow-syntax stripping, native-module mocks) that Vitest cannot load — see this file\'s doc comment for the exact captured error and why importing the real classes here breaks pnpm test entirely, not just this one test'
  );
});
