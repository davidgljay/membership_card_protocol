# membership_card_verifier — Implementation Plan

**Date:** 2026-06-20  
**Status:** Complete  
**Strategic plan:** [verifier-strategic-plan.md](./verifier-strategic-plan.md)  
**Spec:** [specs/object_specs/card_verifier.md](../specs/object_specs/card_verifier.md)

---

## Clarification Checkpoints

Before proceeding at these points, pause and confirm with David:

- **Before creating any file that already exists** — show the conflict and get a decision.
- **Before publishing any package to npm** — confirm version, registry, and access settings.
- **Before Phase 4** (companion packages) — confirm that Phase 3's core package tests are passing and the API surface looks right. Companion packages depend on a stable interface.
- **If any crypto primitive produces unexpected output on a known-answer test** — stop and surface the failure before proceeding to stage integration.

---

## Phase 1: Scaffolding

### Step 1.1 — Create top-level package directory

**What:** Create `membership_card_verifier/` at the repo root. Inside it, create three subdirectories: `packages/verifier/`, `packages/verifier-rpc-provider/`, `packages/verifier-ipfs-provider/`. Add a root `package.json` configured for pnpm workspaces pointing at all three.

**Who:** Claude

**Context needed:** None beyond the directory structure decision (top-level, pnpm workspaces).

**Done when:** `pnpm install` runs without error from `membership_card_verifier/` and the workspace resolver finds all three packages.

---

### Step 1.2 — Configure `packages/verifier/`

**What:** Add `package.json` (`name: "@membership-card-protocol/verifier"`, `"type": "module"`, `engines: { node: ">=22" }`), `tsconfig.json` (strict, ESM, `moduleResolution: bundler`), and `vitest.config.ts`. Add `@noble/post-quantum` and `@noble/hashes` as dependencies. Add `typescript` and `vitest` as devDependencies.

**Who:** Claude

**Context needed:** spec §3 (runtime/module requirements), §12 (dependencies).

**Done when:** `pnpm tsc --noEmit` and `pnpm vitest run` both succeed (zero source files yet — just config validation).

---

### Step 1.3 — Define all TypeScript interfaces

**What:** Create `packages/verifier/src/types.ts` containing every interface and type from the spec: `RpcProvider`, `IpfsProvider`, `VerifierConfig`, `CardVerifier` class signature, `SignedMessageEnvelope`, `SignatureEntry`, `VerifyCardOptions`, `EnvelopeVerificationResult`, `SignatureVerificationResult`, `CardVerificationResult`, `LogUpdate`, `VerificationError`, `EasAnnotation`, `CardEntry`, `PressAuthEntry`, `SubCardEntry`, `SubCardDocument` (implied by Stage 2), `LogEntry`, `EasAttestation`, `NonComplianceReport`, `FailedCheck`.

**Who:** Claude

**Context needed:** spec §4 (provider interfaces), §5 (config), §6 (API), §8 (result types), §7.7 (non-compliance report body).

**Done when:** `pnpm tsc --noEmit` passes with all types defined and no `any` escapes except where explicitly noted in comments.

---

### Step 1.4 — Add conformance test scaffold

**What:** Create `packages/verifier/src/canonicalize.ts` with a stub `canonicalize()` that throws `"not implemented"`. Create `packages/verifier/test/canonicalize.test.ts` that imports the test vectors from `specs/serialization-conformance.json` and asserts each vector's input serializes to the expected output. Run the tests — they should fail with "not implemented".

**Who:** Claude

**Context needed:** spec §10 (serialization), `specs/serialization-conformance.json`.

**Done when:** Test file exists, imports correctly, and fails on the stub with a clear "not implemented" error (not a type error or import error).

---

### Phase 1 Milestone Review

**Context needed:** `packages/verifier/package.json`, `packages/verifier/tsconfig.json`, `packages/verifier/vitest.config.ts`, `packages/verifier/src/types.ts`, `packages/verifier/test/canonicalize.test.ts`, `specs/object_specs/card_verifier.md §4, §5, §6, §8`.

**Done when:** All interface names match the spec exactly; no duplicate or missing types; `tsc --noEmit` is clean; conformance tests fail only on the stub, not on import/config errors; all three workspace packages are resolvable.

---

## Phase 2: Cryptographic Primitives

### Step 2.1 — `canonicalize()`

**What:** Implement `canonicalize(obj: unknown): Uint8Array` in `packages/verifier/src/canonicalize.ts` per RFC 8785: Unicode code-point key sorting, no whitespace, UTF-8, no BOM, no base64 padding. No library dependencies — implement directly (~30 lines per spec ADR).

**Who:** Claude

**Context needed:** spec §10 (serialization), `specs/serialization-conformance.json`.

**Done when:** All conformance vectors in `serialization-conformance.json` pass.

---

### Step 2.2 — `keccak256()`

**What:** Create `packages/verifier/src/crypto.ts`. Implement `keccak256(input: Uint8Array): string` (returns bytes32 hex) using `@noble/hashes/sha3`. Write a known-answer test: `keccak256(new Uint8Array(0))` must equal `"c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"`.

**Who:** Claude

**Context needed:** spec §11 (keccak256 purpose); `@noble/hashes` docs for `keccak_256`.

**Done when:** Known-answer test passes.

---

### Step 2.3 — `hkdfSha3256()`

**What:** Add `hkdfSha3256(ikm: Uint8Array, info: string): Uint8Array` to `crypto.ts`. Uses `@noble/hashes` HKDF with SHA3-256. `info` is UTF-8 encoded; no salt. Write a known-answer test using a fixed input and expected output (compute expected offline or from a reference implementation).

**Who:** Claude

**Context needed:** spec §11 (HKDF-SHA3-256: `ikm = recipient_pubkey`, `info = "card-content-v1"`).

**Done when:** Known-answer test passes.

---

### Step 2.4 — `aes256gcmDecrypt()`

**What:** Add `aes256gcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array` to `crypto.ts` using Node.js `crypto.createDecipheriv("aes-256-gcm", ...)`. Must throw a typed `CardProtocolError` with code `"DECRYPTION_FAILED"` on GCM authentication failure. Write two tests: successful decryption round-trip and authentication failure on a tampered ciphertext.

**Who:** Claude

**Context needed:** spec §11 (AES-256-GCM: 96-bit nonce, tag verified by GCM), §9 (`DECRYPTION_FAILED` error code).

**Done when:** Both tests pass; tampered-ciphertext test triggers `CardProtocolError` with code `"DECRYPTION_FAILED"`.

---

### Step 2.5 — `mlDsa44Verify()`

**What:** Add `mlDsa44Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean` to `crypto.ts` using `@noble/post-quantum` `ml_dsa44.verify`. Write two tests: valid signature returns `true`, flipped byte in signature returns `false`. Add a comment in the source flagging the audit status and side-channel caveat from spec §12.

**Who:** Claude

**Context needed:** spec §11 (ML-DSA-44: pubkey = 1,312 bytes, sig = 2,420 bytes), §12 (`@noble/post-quantum` audit caveat).

**Done when:** Both tests pass; audit caveat comment is present in source.

---

### Step 2.6 — `CardProtocolError`

**What:** Create `packages/verifier/src/errors.ts` defining `CardProtocolError extends Error` with a `code: string` field. Export it from the package entry point. Write a test confirming `instanceof CardProtocolError` and that `code` is accessible.

**Who:** Claude

**Context needed:** spec §9 (error classes and codes).

**Done when:** Test passes; `CardProtocolError` is exported from the package.

---

### Phase 2 Milestone Review

**Context needed:** `packages/verifier/src/crypto.ts`, `packages/verifier/src/canonicalize.ts`, `packages/verifier/src/errors.ts`, all Phase 2 test files, `specs/serialization-conformance.json`.

**Done when:** All crypto unit tests pass; no `any` in crypto module; all conformance vectors pass; `CardProtocolError` is exported; audit caveat comment is in `mlDsa44Verify`; no side-effect imports in crypto module (pure functions only).

---

## Phase 3: Verification Stages

Each stage is implemented as a standalone async function that accepts typed inputs and returns a typed partial result. Stages are composed in Phase 4. Each stage function is tested independently with mock providers.

### Step 3.1 — Stage 1: Signature Validity

**What:** Implement `verifyStage1(entry: SignatureEntry, payload: unknown): Stage1Result` in `packages/verifier/src/stages/stage1.ts`. Steps per spec §7.1: base64url-decode `public_key` (throw `INVALID_PUBLIC_KEY_LENGTH` if not 1,312 bytes), base64url-decode `signature` (throw `INVALID_SIGNATURE_LENGTH` if not 2,420 bytes), canonicalize payload, call `mlDsa44Verify`. Returns `{ signature_valid: boolean }`.

Write tests for: valid signature, invalid signature (returns `false`, does not throw), wrong-length public key (throws `CardProtocolError`), wrong-length signature (throws `CardProtocolError`).

**Who:** Claude

**Context needed:** spec §7.1, §9 (error codes `INVALID_PUBLIC_KEY_LENGTH`, `INVALID_SIGNATURE_LENGTH`); `src/crypto.ts`, `src/errors.ts`.

**Done when:** All four test cases pass.

---

### Step 3.2 — Stage 2: Sub-Card to Master Link

**What:** Implement `verifyStage2(publicKey: Uint8Array, rpc: RpcProvider, ipfs: IpfsProvider): Promise<Stage2Result>` in `packages/verifier/src/stages/stage2.ts`. Steps per spec §7.2. Returns `{ scope_clean: boolean | "skipped", signer_card: string, masterCardDoc?: MasterCardDoc }` (the decoded master card doc is threaded to Stage 3).

Hard rejection paths: card not found → `scope_clean: false` + stop; AES-GCM failure → `scope_clean: false` + stop; address binding mismatch → `scope_clean: false` + stop.

Write tests with mock providers for: happy path (all checks pass, `scope_clean: true`), card not found, decryption failure, address binding mismatch, sub-card inactive (`scope_clean: false` but no hard stop), invalid `app_signature`.

**Who:** Claude

**Context needed:** spec §7.2 (all 13 steps); `src/crypto.ts` (keccak256, hkdfSha3256, aes256gcmDecrypt, mlDsa44Verify); `src/types.ts` (RpcProvider, IpfsProvider, SubCardEntry, SubCardDocument).

**Done when:** All six test scenarios pass with mock providers.

---

### Step 3.3 — Stage 3: Chain Walk

**What:** Implement `verifyStage3(masterCardDoc: MasterCardDoc, signerCardAddress: string, rpc: RpcProvider, ipfs: IpfsProvider, config: Pick<VerifierConfig, "trustedRoots" | "maxChainDepth">): Promise<Stage3Result>` in `packages/verifier/src/stages/stage3.ts`. Steps per spec §7.3. Returns `{ chain_reaches_trusted_root: boolean | "skipped", chain_card_addresses: string[] }` (addresses used by Stage 4).

Hard rejection paths: address binding mismatch, AES-GCM failure, depth exceeded.

Write tests for: chain terminates at trusted root, chain terminates at `trustedRoots` config, chain exhausted without trusted root, depth exceeded, binding mismatch mid-walk.

**Who:** Claude

**Context needed:** spec §7.3 (6 steps); `src/crypto.ts`; `src/types.ts` (RpcProvider, IpfsProvider); `verifier-strategic-plan.md §Key Objectives` (maxChainDepth default = 64).

**Done when:** All five test scenarios pass.

---

### Step 3.4 — Stage 4: Revocation Check

**What:** Implement `verifyStage4(chainCardAddresses: string[], signingTimestamp: string, rpc: RpcProvider, config: Pick<VerifierConfig, "revocationFreshnessWindowSeconds" | "rejectStaleRevocation">): Promise<Stage4Result>` in `packages/verifier/src/stages/stage4.ts`. Steps per spec §7.4: parallel log fetches, partition by code range, earliest revocation governs, freshness check.

Returns `{ revocation, was_valid_at_signing_time, is_currently_valid, log_updates }`.

Write tests for: no revocation, 8xx revocation (before and after signing time), 9xx revocation, stale data with `rejectStaleRevocation: true`, stale data with `rejectStaleRevocation: false`, multiple revocation entries (earliest governs).

**Who:** Claude

**Context needed:** spec §7.4 (6 steps); `src/types.ts` (LogEntry, LogUpdate); spec §9 (`STALE_REVOCATION_DATA`).

**Done when:** All six test scenarios pass.

---

### Step 3.5 — Stage 5: Policy Compliance + Non-Compliance Reporting

**What:** Implement `verifyStage5(cardDoc: CardDoc, cardEntry: CardEntry, rpc: RpcProvider, ipfs: IpfsProvider, config: Pick<VerifierConfig, "registryEndpoint">): Promise<Stage5Result>` in `packages/verifier/src/stages/stage5.ts`. Steps per spec §7.5.

Non-compliance reporting (spec §7.7): when `policy_compliant: false`, POST to `config.registryEndpoint ?? PRESS_REGISTRY_BODY_ENDPOINT` + `/non-compliance`. One attempt only; failure sets `non_compliance_reported: false` and records error `NON_COMPLIANCE_REPORT_FAILED`.

The `PRESS_REGISTRY_BODY_ENDPOINT` constant is defined in `packages/verifier/src/constants.ts` as `"PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER"`.

Write tests for: compliant card, non-compliant card (field violation), non-compliant card (no press authorization), press subsequently revoked (compliant, informational flag set), non-compliance report POST failure (verification still returns result).

**Who:** Claude

**Context needed:** spec §7.5 (5 steps), §7.7 (non-compliance report shape); `src/types.ts` (NonComplianceReport, FailedCheck, PressAuthEntry); `src/constants.ts`.

**Done when:** All five test scenarios pass; `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` is the actual string in `constants.ts` (not a real URL).

---

### Step 3.6 — Stage 6: EAS Annotation Lookup

**What:** Implement `verifyStage6(chainCardAddresses: string[], rpc: RpcProvider, ipfs: IpfsProvider, config: Pick<VerifierConfig, "fetchAnnotations" | "additionalAnnotators" | "trustedRoots" | "maxChainDepth">): Promise<EasAnnotation[]>` in `packages/verifier/src/stages/stage6.ts`. Steps per spec §7.6.

The recommended annotator list endpoint constant is `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` in `constants.ts`. Fetch failure is non-fatal (proceeds with empty recommended list). Individual annotation fetch/decrypt failures are non-fatal (annotation omitted, error recorded).

Write tests for: `fetchAnnotations: false` returns `[]` without any network calls; happy path with one recommended and one additional annotator; annotator chain walk fails (`annotator_chain_trusted: false`); annotation IPFS fetch fails (omitted from result, error recorded); recommended annotators endpoint fetch fails (proceeds with empty list, `additionalAnnotators` still applied).

**Who:** Claude

**Context needed:** spec §7.6 (5 steps); `src/types.ts` (EasAnnotation, EasAttestation); `src/crypto.ts` (for annotator chain walk); `src/stages/stage3.ts` (reuse chain-walk logic).

**Done when:** All five test scenarios pass; stage3 chain-walk logic is reused (not duplicated).

---

### Phase 3 Milestone Review

**Context needed:** All `src/stages/*.ts` files, all `test/stages/*.test.ts` files, `src/constants.ts`, `specs/object_specs/card_verifier.md §7`.

**Done when:** All stage unit tests pass; hard rejection skip semantics match the spec exactly (confirmed by cross-checking each stage's test for downstream `"skipped"` handling); `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` and `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` appear only in `constants.ts`, not scattered across stage files; no real network calls made in any test.

---

## Phase 4: API Assembly

### Step 4.1 — `CardVerifier` class

**What:** Implement `packages/verifier/src/CardVerifier.ts`. The constructor accepts `VerifierConfig` and validates required fields (`rpc`, `ipfs`). Apply defaults for optional fields per spec §5.

**Who:** Claude

**Context needed:** spec §5 (VerifierConfig defaults); `src/types.ts`.

**Done when:** `new CardVerifier({ rpc, ipfs })` constructs without error; invalid config (missing `rpc`) throws `CardProtocolError`.

---

### Step 4.2 — `verifyEnvelope()`

**What:** Implement `CardVerifier.verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult>`. For each entry in `envelope.signatures`: run Stage 1; derive card address; run Stages 2–6 in order, threading outputs (master card doc from Stage 2 to Stage 3, chain addresses from Stage 3 to Stage 4, etc.); assemble `SignatureVerificationResult`. Compute `envelope_id` as SHA-256 of `canonicalize(envelope)`, hex-encoded.

The `addressed_to_verifier` field is `false` for v1 (verifier card registration is deferred — spec §13 decision 5).

**Who:** Claude

**Context needed:** spec §6.1, §8 (result shapes); all stage modules; `src/crypto.ts`.

**Done when:** Integration test with mock providers verifies a two-signature envelope and returns two `SignatureVerificationResult` entries with all fields populated.

---

### Step 4.3 — `verifyCard()`

**What:** Implement `CardVerifier.verifyCard(cardAddress: string, options?: VerifyCardOptions): Promise<CardVerificationResult>`. Skips Stage 1 (`signature_valid: null`). Starts from Stage 2 using the card address directly (no `public_key` to derive from). Per spec §6.2.

**Who:** Claude

**Context needed:** spec §6.2; `src/types.ts` (CardVerificationResult = SignatureVerificationResult minus `signature_valid`).

**Done when:** Integration test confirms `signature_valid` is `null` and all other fields are populated.

---

### Step 4.4 — Package entry point and exports

**What:** Create `packages/verifier/src/index.ts` exporting: `CardVerifier`, `CardProtocolError`, `canonicalize`, and all TypeScript interfaces (as type-only exports). Ensure tree-shakeable — no side effects at import time.

**Who:** Claude

**Context needed:** spec §10 (`canonicalize` is explicitly exported); §9 (`CardProtocolError` is thrown to callers).

**Done when:** `import { CardVerifier, CardProtocolError, canonicalize } from "@membership-card-protocol/verifier"` resolves correctly in a test consumer file.

---

### Phase 4 Milestone Review

**Context needed:** `src/CardVerifier.ts`, `src/index.ts`, all Phase 4 test files, `specs/object_specs/card_verifier.md §6, §8`.

**Done when:** `verifyEnvelope` and `verifyCard` integration tests pass end-to-end with mock providers; all result fields match spec §8 exactly (names, types, nullable semantics); `envelope_id` is deterministic across two calls with the same input; package exports are clean (no accidental leakage of internal types).

---

## Phase 5: Companion Packages

### Step 5.1 — `@membership-card-protocol/verifier-rpc-provider`

**What:** Implement `packages/verifier-rpc-provider/` with a default export class `EthersRpcProvider implements RpcProvider`. Wraps ethers.js v6. Implements all six `RpcProvider` methods: `getCardEntry`, `isPolicyAuthorizer`, `getPressAuthorization`, `getSubCardEntry`, `getLogEntries`, `getEasAnnotations`. Constructor accepts an ethers `Provider` and the registry contract address. Add ethers.js v6 as a peer dependency (not bundled).

Write tests against a mock ethers provider that returns fixed contract data.

**Who:** Claude

**Context needed:** `src/types.ts` (RpcProvider interface); spec §4.1 (method contracts); ethers.js v6 contract API.

**Done when:** All six method tests pass with mock ethers provider; package is independently versioned (`0.1.0`).

---

### Step 5.2 — `@membership-card-protocol/verifier-ipfs-provider`

**What:** Implement `packages/verifier-ipfs-provider/` with a default export class `Web3StorageIpfsProvider implements IpfsProvider`. Wraps a web3.storage-compatible client. Implements `fetch(cid: string): Promise<Uint8Array>`. Constructor accepts a client instance and an optional timeout (default 30s). Add web3.storage client as a peer dependency.

Write a test using a mock client that returns fixed bytes for a given CID.

**Who:** Claude

**Context needed:** `src/types.ts` (IpfsProvider interface); spec §4.2 (must throw if CID cannot be resolved within timeout).

**Done when:** Test passes; timeout behavior is tested (mock rejects after delay → `IpfsProvider.fetch` throws).

---

### Phase 5 Milestone Review

**Context needed:** `packages/verifier-rpc-provider/src/`, `packages/verifier-ipfs-provider/src/`, `src/types.ts` (provider interfaces).

**Done when:** Both companion packages implement their respective interfaces without type errors (`implements RpcProvider` and `implements IpfsProvider` compile cleanly); neither package is listed in `@membership-card-protocol/verifier`'s dependencies; both are independently versioned.

---

## Phase 6: Integration and Conformance

### Step 6.1 — Full pipeline integration test

**What:** Write `packages/verifier/test/integration/full-pipeline.test.ts`. Construct a complete mock scenario: a sub-card signing an envelope, with a master card, two ancestors, and a trusted root — all backed by mock `RpcProvider` and `IpfsProvider` that return pre-computed cryptographic fixtures. Verify that `verifyEnvelope` returns `signature_valid: true`, `scope_clean: true`, `chain_reaches_trusted_root: true`, `is_currently_valid: true`, `policy_compliant: true`.

**Who:** Claude

**Context needed:** All stage modules; `src/CardVerifier.ts`; cryptographic primitive outputs from Phase 2 (use the same known-answer keys to construct fixtures).

**Done when:** Integration test passes end-to-end with zero real network calls.

---

### Step 6.2 — Hard rejection and skip propagation tests

**What:** Write tests that exercise every hard rejection in the spec and verify the correct downstream stages are marked `"skipped"`. Cover: Stage 2 card not found (Stages 3–5 skipped); Stage 2 decryption failure (Stages 3–5 skipped); Stage 3 binding mismatch (Stages 4–5 skipped on that chain); Stage 3 depth exceeded (Stages 4–5 skipped).

**Who:** Claude

**Context needed:** spec §7 (hard rejection semantics for each stage); `src/stages/*.ts`.

**Done when:** All four skip-propagation tests pass and match the spec's described behavior exactly.

---

### Step 6.3 — README

**What:** Write `packages/verifier/README.md` covering: quick-start example (construct `CardVerifier`, call `verifyEnvelope`), provider interface contract (what implementers must supply), configuration reference (all `VerifierConfig` fields and defaults), error handling (three classes of error per spec §9), the `@noble/post-quantum` audit status caveat, and the placeholder endpoint note (to be replaced before production).

**Who:** Claude

**Context needed:** spec §2 (design principles), §3, §4, §5, §9, §12, §13 decision 2 (audit caveat).

**Done when:** README compiles (no broken markdown), all config fields from `VerifierConfig` are documented, audit caveat is present verbatim.

---

### Phase 6 Milestone Review

**Context needed:** All test files, `README.md`, `src/index.ts`, `src/constants.ts`.

**Done when:** `pnpm vitest run` passes across all three packages with zero failures; both placeholder endpoint constants appear exactly once each (in `constants.ts`); README documents the audit caveat; no real network call is made in any test file; the export surface of `@membership-card-protocol/verifier` matches spec §6 exactly.
