// `ws` (pulled in by viem's WebSocket transport, which the host never uses) tries to load two optional native
// accelerators inside try/catch and falls back to plain JavaScript. The host bundles everything (noExternals), so
// they are aliased to this module, which throws on load exactly as a missing package would.
throw new Error("optional native module not bundled");
