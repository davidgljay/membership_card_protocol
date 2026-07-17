# Matrix Crypto Binding Decision (Phase 5, Step 17)

**Date:** 2026-07-14 (amended same day — David signed off)
**Status:** Decided. Web: `@matrix-org/matrix-sdk-crypto-wasm`. React Native: build a custom Turbo Module against the official crypto-only `matrix-sdk-crypto-ffi` crate via `uniffi-bindgen-react-native` (Option 2 below) — not `react-native-matrix-sdk` adoption. Step 18 may proceed.
**Scope:** Which library/binding implements Olm/Megolm E2EE inside the JS/TS client SDK packages. The strategic choice of *native Matrix E2EE over a custom AES scheme* was already made (`plans/matrix-strategic-plan.md` §Rationale, Open Question 2) — this document is binding selection only.

---

## Correction to task premise: `client-sdk-web` and `client-sdk-rn` are not empty

The brief for this step assumed both packages were unstarted placeholders. That's stale — both already exist under `client-sdk/packages/client-sdk-web/` and `client-sdk/packages/client-sdk-rn/`, each with a `package.json`, `src/`, `test/`, build tooling, and working provider implementations (`StorageProvider`, `SecureKeyProvider`, `PasskeyProvider`, `RealtimeTransportProvider`, `MultiInstanceLock`) that satisfy interfaces defined in the main `client-sdk` package. Notably:

- `client-sdk-rn/package.json` **already depends on `react-native-keychain@^10.0.0`**, `react-native-passkey`, `react-native-sse`, `@react-native-async-storage/async-storage`, and `@noble/ciphers`, and its `SecureKeyProvider.ts` already wraps ML-DSA-44 keys with an AES-256-GCM key held in `react-native-keychain` at `SECURE_HARDWARE`. There is real RN tooling and convention in place — Step 18 is not starting from zero.
- `client-sdk-web/package.json` depends only on `@membership-card-protocol/client-sdk` (workspace) plus dev deps (`fake-indexeddb`, `jsdom`); no crypto/WASM dependency has been added yet.
- Neither package currently has any Matrix-related code. `client-sdk/packages/client-sdk/src/matrix/` exists (`discovery.ts`, per Goal 6 room discovery) but has no E2EE/crypto machinery — that's what Step 18 adds.
- The main `client-sdk` package's existing crypto surface (`src/crypto/mldsa.ts`, `hashes.ts`, `hpke.ts`, `mlkem.ts`) is built entirely on `@noble/*` pure-JS/TS libraries — thin wrappers with no independent primitive implementations, each carrying an explicit disclosed-limitation comment (e.g., no side-channel protection, no independent audit for post-quantum primitives). Whatever Megolm/Olm binding is chosen should be introduced in the same spirit: an explicit, documented dependency boundary, not new cryptography written in-house.

This correction doesn't change the recommendation below, but Step 18 should treat `client-sdk-web`/`client-sdk-rn` as existing packages to extend, not scaffold.

---

## Web target: `@matrix-org/matrix-sdk-crypto-wasm`

**Recommendation: adopt it. This is the standard, actively maintained path — it's what `matrix-js-sdk` itself now uses.**

Facts, verified directly against the npm registry and GitHub (not training-data recall):

- **Package:** `@matrix-org/matrix-sdk-crypto-wasm` — WASM bindings for the Rust `matrix-sdk-crypto` crate (the `OlmMachine` state machine: sessions, device verification, key backup, cross-signing — not just the raw Olm/Megolm ratchet).
- **Current version:** `18.3.1`, published **2026-06-02** (~6 weeks before this writeup) — [npm registry](https://registry.npmjs.org/@matrix-org/matrix-sdk-crypto-wasm), confirmed via direct registry query. First published 2023-07-13; 64 releases to date. Actively maintained, not stale.
- **License:** Apache-2.0. Maintained by Element/matrix.org (`matrix-org/matrix-sdk-crypto-wasm` on GitHub).
- **Bundle size (measured directly from the published tarball, not an estimate):** the tarball unpacks to 6.65 MB total (`unpackedSize` from npm registry metadata), but that includes both Node and web entry points plus TypeScript types. The actual `.wasm` binary shipped (`pkg/matrix_sdk_crypto_wasm_bg.wasm`) is **5.57 MB raw / ~1.85 MB gzip-over-the-wire** (measured by downloading the tarball and gzip-ing the extracted `.wasm` file directly). This is a real, non-trivial addition to a web bundle — consistent with the strategic plan's flagged concern — but it's a one-time cached download (served with long-lived caching in practice, as `element-web` does), not re-fetched per session.
- **Packaging:** ships separate Node (`fs.readFile`) and web (`fetch`) entry points, both CJS and ESM, so it should drop cleanly into `client-sdk-web`'s existing Vitest/browser-oriented test setup (`fake-indexeddb`, `jsdom`) without extra bundler config beyond WASM asset handling.
- **Why this over hand-rolling on top of vodozemac directly:** libolm was formally deprecated in August 2024 in favor of vodozemac; `matrix-sdk-crypto-wasm` already wraps vodozemac's Olm/Megolm ratchet **inside the full `OlmMachine` session-management state machine** that `matrix-js-sdk` itself depends on for encryption. This is the actual production path other Matrix clients use, not a lower-level primitive requiring us to reimplement session/device/key-backup bookkeeping.

Source: [`@matrix-org/matrix-sdk-crypto-wasm` on npm](https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm), [GitHub repo](https://github.com/matrix-org/matrix-sdk-crypto-wasm), [libolm deprecation announcement](https://matrix.org/blog/2024/08/libolm-deprecation/), [matrix-js-sdk rust-crypto migration issue #3964](https://github.com/matrix-org/matrix-js-sdk/issues/3964).

---

## React Native target: no equivalent official crypto-only binding exists yet

This is the real open question in this writeup.

**Confirmed: RN cannot use the web WASM package as-is.**
- Hermes (React Native's default JS engine) has **no `WebAssembly.global` support** — confirmed current as of this research (`facebook/hermes` issue #429, still open/unresolved).
- The community workarounds (`react-native-webassembly`, using the Wasm3 interpreter; `polygen`, using `wasm2c`-generated C) are both third-party, non-official, and neither is designed for a WASM module the size and complexity of `matrix_sdk_crypto_wasm_bg.wasm`. Wasm3 specifically **does not support multiple memory regions**, which is a real compatibility risk for a large `wasm-pack`-built binary like this one, not just a performance concern.
- **Conclusion: RN must go through native FFI, not WASM.** A single package/build cannot realistically target both web and RN — this needs two separate bindings per platform, not one crate reused.

**What exists for native FFI on RN:**
- `matrix-sdk-crypto-ffi` — an **official**, crypto-only Rust crate (part of `matrix-rust-sdk`) using Uniffi bindings, already used to ship E2EE into Kotlin/Swift native Matrix clients (Element X). Confirmed as crypto-only (session mgmt, device verification, key backup — not full client/sync) via the crate's own docs.
- `uniffi-bindgen-react-native` — Mozilla/Filament's tool (announced Dec 2024) for generating RN Turbo Modules from Uniffi-annotated Rust crates. This is the mechanism, not a finished binding.
- `react-native-matrix-sdk` (`unomed-dev`, npm scope `@unomed`) — the only existing project applying that tool to Matrix. **But it wraps the full `matrix-rust-sdk` client (sync, rooms, timeline — not just `matrix-sdk-crypto-ffi`)**, not a crypto-only surface. Current status: v0.9.1 (March 2026), 16 releases, 66 stars, 4 open issues — active but early-stage, and Mozilla's own announcement of the underlying tooling describes it as "an early release." Sponsored by Unomed, not by the Matrix core team.

**The real tradeoff for David:** there is no drop-in, crypto-only, officially-maintained RN binding today. Two realistic paths:
1. **Adopt `react-native-matrix-sdk`** and use only its crypto/E2EE surface, ignoring its room/sync features (Card Protocol's own bridge/Synapse module already owns room and policy logic per the strategic plan). Risk: depending on an early-stage, single-maintainer community project for a security-critical dependency, and pulling in a much larger native surface (full client) than needed.
2. **Build a thin custom Turbo Module** with `uniffi-bindgen-react-native` directly against the official `matrix-sdk-crypto-ffi` crate — matching what Element X does for Kotlin/Swift, scoped to crypto only. More upfront work (Rust build pipeline, native module packaging for iOS+Android), but avoids taking on an unrelated full-client dependency and matches the official, audited crypto surface exactly.

No production-grade third option surfaced in this research — this genuinely needs David's call, not a default recommendation, because it's a real build-vs-adopt tradeoff with different risk profiles, not a maintenance-status question with an obvious answer.

Sources: [Hermes WASM support issue #429](https://github.com/facebook/hermes/issues/429), [react-native-webassembly](https://github.com/cawfree/react-native-webassembly), [polygen](https://github.com/callstackincubator/polygen), [matrix_sdk_crypto_ffi docs](https://matrix-org.github.io/matrix-rust-sdk/matrix_sdk_crypto_ffi/index.html), [uniffi-bindgen-react-native announcement](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/), [react-native-matrix-sdk](https://github.com/unomed-dev/react-native-matrix-sdk).

---

## Alternative considered: bare `vodozemac` JS bindings

Several bindings exist that expose *only* the raw vodozemac Olm/Megolm ratchet, without the `OlmMachine` session-management layer that `matrix-sdk-crypto-wasm` provides:
- `vodozemac-wasm-bindings` (community, `Mekacher-Anis`)
- `@towns-protocol/vodozemac` (maintained by Towns Protocol for their own chat product, supports both web and Node)
- `matrix-org/vodozemac-bindings` (official language-binding scaffolding, not a finished npm package)

**Why not preferred:** vodozemac itself is independently audited (2022 public audit, cited by matrix.org) and is the same cryptographic core `matrix-sdk-crypto-wasm` uses underneath — so the *cryptography* isn't materially different. The gap is everything `OlmMachine` handles on top: session lifecycle, device-list tracking, key backup/recovery, cross-signing, replay/rollback protection. Adopting bare vodozemac means Card Protocol's `client-sdk` would have to reimplement that state machine itself — exactly the "reinventing group-ratchet cryptography" the strategic plan's Rationale section already argued against for the AES-scheme alternative. It doesn't avoid that risk, it just moves it up one layer. Not recommended unless a concrete reason emerges to avoid the `matrix-sdk-crypto-wasm` dependency specifically (e.g., its bundle size proves unacceptable after real measurement in `client-sdk-web`).

---

## Recommendation

| Target | Package | Version (as of 2026-07-14) | Mechanism |
|---|---|---|---|
| `client-sdk` (shared interfaces only) | — | — | Define crypto-provider interfaces here per existing `providers/` pattern; no binding lives in the shared package itself, consistent with how `SecureKeyProvider`/`StorageProvider` are already split into per-platform packages. |
| `client-sdk-web` | `@matrix-org/matrix-sdk-crypto-wasm` | `18.3.1` | WASM, official, actively maintained, same dependency `matrix-js-sdk` uses. |
| `client-sdk-rn` | **Open question — no adopt-vs-build decision made** | — | Native FFI required (WASM is not viable on Hermes). Choose between `react-native-matrix-sdk` (adopt, early-stage, full-client scope) or a custom Turbo Module against `matrix-sdk-crypto-ffi` (build, crypto-only, official crate, more upfront work). |

**Open question for David:** the RN path. Both options are legitimate; neither is obviously better without weighing "ship faster on a less mature community dependency" against "more build work but a scoped, officially-maintained crypto core." This should be resolved explicitly before Step 18 writes any RN crypto code — the web path (`matrix-sdk-crypto-wasm`) can proceed independently since it has a clear, low-risk answer.
