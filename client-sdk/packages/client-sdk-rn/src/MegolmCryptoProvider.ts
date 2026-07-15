import type { MegolmCryptoProvider } from '@membership-card-protocol/client-sdk';

/**
 * React Native `MegolmCryptoProvider` — **scaffold only, not a working
 * implementation.** This class exists so callers have the right shape to
 * code against and a clear, descriptive failure instead of silence or a
 * fake pass, following the same honest-gap pattern
 * `wallet-service/src/matrix/card-chain-verifier.ts`'s
 * `CardChainVerifierNotConfiguredError` already uses in this codebase for
 * "the real thing isn't built yet."
 *
 * **Why there's no real implementation here (Matrix Phase 5, Step 18 —
 * see `plans/milestones/matrix-crypto-binding-decision.md` for the full
 * writeup):**
 *
 * - `client-sdk-web`'s `WasmMegolmCryptoProvider` wraps
 *   `@matrix-org/matrix-sdk-crypto-wasm`, which is WebAssembly. React
 *   Native's default JS engine, Hermes, has no `WebAssembly.global`
 *   support (`facebook/hermes` issue #429, open as of this writing) —
 *   the community WASM-on-Hermes workarounds (`react-native-webassembly`,
 *   `polygen`) are both third-party and, per the binding-decision doc,
 *   not suitable for a module the size/complexity of
 *   `matrix_sdk_crypto_wasm_bg.wasm` (e.g. Wasm3's lack of multi-memory
 *   support). So the web provider cannot simply be reused here.
 * - The chosen path instead (David's explicit call, "build" not "adopt
 *   `react-native-matrix-sdk`") is a custom Turbo Module wrapping the
 *   official, crypto-only `matrix-sdk-crypto-ffi` Rust crate (part of
 *   `matrix-rust-sdk`, the same crate Element X uses for Kotlin/Swift)
 *   via `uniffi-bindgen-react-native` (Mozilla/Filament's Rust-to-RN
 *   codegen tool). None of that exists yet.
 *
 * **What actually remains, for whoever picks this up:**
 * 1. **Rust build pipeline.** Vendor or depend on `matrix-sdk-crypto-ffi`,
 *    set up cross-compilation to the RN target triples this app ships
 *    (iOS device/simulator arm64/x86_64, Android arm64-v8a/armeabi-v7a/
 *    x86_64), and get `cargo`/`cargo-ndk`/`xcodebuild`-driven builds
 *    wired into this package's build (or a sibling native package's).
 * 2. **`uniffi-bindgen-react-native` codegen.** Run it against
 *    `matrix-sdk-crypto-ffi`'s UDL/proc-macro interface to generate the
 *    actual Turbo Module (JSI bindings, TS types) — this is the piece
 *    that turns the compiled Rust library into something callable from
 *    JS at all. As of the binding-decision doc, the only project that has
 *    done this against *any* Matrix Rust crate is `react-native-matrix-sdk`
 *    (community, and against the full client crate, not the crypto-only
 *    one) — there is no existing reference for the crypto-only crate to
 *    copy from.
 * 3. **Native module packaging.** Package the generated Turbo Module for
 *    both iOS (CocoaPods spec, Xcode project integration) and Android
 *    (Gradle module, JNI packaging), and wire it into
 *    `client-sdk-rn`'s existing native dependency set (this package
 *    already depends on `react-native-keychain`, so there's local
 *    precedent for a native-module dependency, but nothing at the
 *    Rust-FFI complexity level this needs).
 * 4. **This class's methods**, once the above exists, become thin
 *    wrappers over the generated Turbo Module's crypto-machine bindings —
 *    structurally the same shape as `client-sdk-web`'s
 *    `WasmMegolmCryptoProvider` (`flushOutgoingRequests`/`receiveSync`
 *    driving the machine's request/response and sync-ingestion loop,
 *    `ensureRoomSession`/`encryptRoomEvent`/`decryptRoomEvent` for the
 *    higher-level operations), since `matrix-sdk-crypto-ffi` exposes
 *    materially the same `OlmMachine`-shaped API surface as
 *    `matrix-sdk-crypto-wasm` does (`matrix_sdk_crypto_ffi` docs, cited
 *    in the binding-decision doc).
 *
 * None of this was buildable or testable in the sandbox this step was
 * implemented in — no Rust toolchain, no Xcode, no Android Studio, no
 * physical/simulated device. Every method below throws
 * `MegolmCryptoProviderNotImplementedError` rather than silently
 * succeeding or returning fabricated data.
 */
export class MegolmCryptoProviderNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `MegolmCryptoProvider.${method}() is not implemented on React Native yet — see ` +
        'client-sdk-rn/src/MegolmCryptoProvider.ts\'s header comment for exactly what remains ' +
        '(a Rust build pipeline against matrix-sdk-crypto-ffi, uniffi-bindgen-react-native codegen, ' +
        'and native iOS/Android Turbo Module packaging). This is a scaffold, not a working provider.'
    );
  }
}

/**
 * Stub `MegolmCryptoProvider`. Every method throws {@link
 * MegolmCryptoProviderNotImplementedError} — see this file's header
 * comment. Present so `client-sdk-rn` type-checks against the same
 * `MegolmCryptoProvider` interface `client-sdk-web` implements, and so a
 * host app can construct *something* satisfying the interface today
 * without the whole call graph failing to compile, while being loud
 * (throwing, not silently no-op'ing) the moment any method is actually
 * invoked.
 */
export class UnimplementedRNMegolmCryptoProvider implements MegolmCryptoProvider {
  async flushOutgoingRequests(): Promise<void> {
    throw new MegolmCryptoProviderNotImplementedError('flushOutgoingRequests');
  }

  async receiveSync(): Promise<void> {
    throw new MegolmCryptoProviderNotImplementedError('receiveSync');
  }

  async ensureRoomSession(): Promise<void> {
    throw new MegolmCryptoProviderNotImplementedError('ensureRoomSession');
  }

  async encryptRoomEvent(): Promise<Record<string, unknown>> {
    throw new MegolmCryptoProviderNotImplementedError('encryptRoomEvent');
  }

  async decryptRoomEvent(): Promise<never> {
    throw new MegolmCryptoProviderNotImplementedError('decryptRoomEvent');
  }
}
