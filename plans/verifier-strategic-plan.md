# membership_card_verifier — Strategic Plan

**Date:** 2026-06-20  
**Status:** Draft  
**Spec:** [specs/object_specs/card_verifier.md](../specs/object_specs/card_verifier.md)  
**Companion document:** [verifier-implementation-plan.md](./verifier-implementation-plan.md)

---

## Goals

### 1. Implement a correct, spec-complete 5-stage verification pipeline

The core deliverable is a TypeScript/ESM library that takes a `SignedMessageEnvelope` and returns a structured `EnvelopeVerificationResult` covering all five stages: signature validity, sub-card-to-master link, chain walk to a trusted root, revocation check, and policy compliance. Every stage must behave exactly as specified — including hard rejections, skip propagation, and the non-short-circuiting guarantee.

### 2. Keep the package thin and I/O-agnostic

The spec's most important architectural decision is that the package makes no network calls itself. All Arbitrum One reads and IPFS fetches flow through caller-supplied `RpcProvider` and `IpfsProvider` interfaces. This must hold unconditionally — no bundled HTTP clients, no implicit gateway calls, no hidden globals. This is what makes the package safe to embed in verifier services with wildly different transport stacks.

### 3. Ship reference provider companion packages

Decision 1 in the spec calls for `@card-protocol/verifier-rpc-provider` (ethers.js wrapper) and `@card-protocol/verifier-ipfs-provider` (web3.storage wrapper) as independently-versioned companion packages. These lower the barrier to adoption for integrators who don't want to write their own transport wrappers, and they serve as executable documentation of the provider interfaces.

### 4. Establish a conformance-verified, auditable cryptographic core

The package depends on ML-DSA-44, AES-256-GCM, HKDF-SHA3-256, keccak256, and RFC 8785 canonicalization. These must be correct before anything else can be trusted. The `canonicalize()` function must pass all vectors in `specs/serialization-conformance.json`. The ML-DSA-44 implementation (`@noble/post-quantum`) has no independent security audit yet (per spec §12) — this limitation must be documented and tracked.

---

## Rationale

**Goal 1 — Correct pipeline:** The whole value of a verification library is that callers can trust its output. Any deviation from the spec — a skipped stage, a missing hard reject, an incorrect skip propagation — can cause a relying party to accept a card it shouldn't. The implementation plan must be structured around the spec sections, not around implementation convenience.

**Goal 2 — Thin and I/O-agnostic:** The existing Rust `verifier-module` in `contracts/verifier-module/` is the on-chain verification contract. The TypeScript library serves off-chain verifiers (frontends, services, CLIs). Keeping it I/O-agnostic means the same package can be used in a Next.js API route, a Lambda function, or a local CLI without needing different builds for different environments. It also makes the library trivially testable — tests supply mock providers.

**Goal 3 — Reference providers:** Without reference providers, every integrator has to read the spec and write their own bindings. For a protocol at this stage, that friction translates directly to adoption friction. The companion packages aren't part of the trust model — they're commoditized glue — but they matter for getting the protocol used.

**Goal 4 — Auditable crypto:** Post-quantum cryptography is new enough that implementation errors are plausible and high-impact. Pinning `@noble/post-quantum` and `@noble/hashes` as the only crypto dependencies (no browser WebCrypto, no OpenSSL bindings, no bundled WASM blobs) keeps the cryptographic surface auditable. The conformance test suite for canonicalization is already specified (`serialization-conformance.json`); we need equivalent coverage for the crypto primitives.

---

## Key Objectives

### Goal 1 — Correct pipeline
- `verifyEnvelope` returns a result with all five stage fields populated (never `undefined`) for every signature entry.
- Hard rejections cause exactly the downstream stages specified in §7 to be marked `"skipped"` and no others.
- All error codes in §9 are reachable by test cases.

### Goal 2 — Thin and I/O-agnostic
- Zero bundled HTTP clients, IPFS clients, or Arbitrum One clients in the package's `dependencies`.
- All network access isolated behind the `RpcProvider` and `IpfsProvider` interfaces; every call site in the source is traceable to one of these interfaces.
- Test suite runs entirely with mock providers (no real network required).

### Goal 3 — Reference providers
- `@card-protocol/verifier-rpc-provider`: wraps ethers.js v6, covers all five `RpcProvider` methods, independently versioned.
- `@card-protocol/verifier-ipfs-provider`: wraps a web3.storage-compatible client, covers `IpfsProvider.fetch`, independently versioned.
- Both packages are functional enough to run against a local Arbitrum testnet + local IPFS node.

### Goal 4 — Auditable crypto
- `canonicalize()` passes all vectors in `specs/serialization-conformance.json`.
- Unit tests cover ML-DSA-44 verify (valid and invalid signatures), AES-256-GCM (correct decryption and authentication failure), HKDF-SHA3-256 (known-answer test), and keccak256 (known-answer test).
- `README` documents the `@noble/post-quantum` audit status and the side-channel caveat from spec §12.

---

## Open Questions

1. **Package location.** Where does `membership_card_verifier` live? Options: (a) a new top-level directory `membership_card_verifier/` in this repo alongside `contracts/`; (b) inside a `packages/` monorepo tree. This affects how companion packages are co-located and whether a workspace tool (pnpm workspaces, turborepo) is needed.

2. **Test framework.** No test setup is specified. Vitest is the natural choice for ESM/TypeScript (no transform config needed, fast, native `.mjs` support). Any preference, or is Jest acceptable?

3. **`EasAnnotation` type.** The result type references `EasAnnotation[]` for Stage 6, but the type is not defined in the spec. For v1 should we: (a) stub as `unknown[]` until Stage 6 is specced; (b) define a minimal shape now; or (c) omit the field from the result type and leave `annotations` for a future minor version?

4. **Non-compliance endpoint.** The spec uses a placeholder URL (`PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER`). For the implementation, should we read this from an environment variable (e.g., `CARD_PROTOCOL_REGISTRY_ENDPOINT`), or is a hardcoded stub + a config override in `VerifierConfig` the right pattern?

5. **npm scope.** The spec names the package `@card-protocol/verifier`. Should `membership_card_verifier` be the directory name only (and the npm package name stays `@card-protocol/membership-card-verifier`), or should the npm package name also change?
