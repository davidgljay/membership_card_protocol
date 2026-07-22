// Stub for native RN modules this harness never actually invokes
// (react-native-passkey, react-native-sse), but which sdk-providers-rn's
// index.ts barrel-exports alongside the providers this harness *does* use
// (AsyncStorageProvider, SecureEnclaveKeyProvider) — importing anything
// from that index pulls in every provider's own imports transitively, so
// these need to resolve to *something* even though this harness's
// scenario.ts never calls into them. PasskeyProvider is a hand-rolled fake
// instead (src/mockPasskeyProvider.ts, not ReactNativePasskeyProvider);
// realtime transport isn't part of this smoke scenario at all.
//
// A plain no-op stub, not a throwing one: babel's CJS/ESM interop wrapper
// reads properties off a default import's module.exports at import time
// (e.g. checking `__esModule`), so anything that throws on property access
// breaks the import itself, before this harness's code ever runs.
function Noop() {}
Noop.default = Noop;
module.exports = Noop;
