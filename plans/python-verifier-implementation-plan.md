Strategic plan: [python-verifier-strategic-plan.md](./python-verifier-strategic-plan.md)

# Python Verifier Port — Implementation Plan

## Assumption to confirm at kickoff

New package lives at `membership_card_verifier/packages/verifier-py/`, alongside the existing JS `verifier`, `verifier-ipfs-provider`, and `verifier-rpc-provider` packages. This mirrors the monorepo's existing layout without mixing Python packaging files into the JS package. **Flag this to the user before Phase 1, step 1 — if wrong, every subsequent path in this plan needs updating.**

Reference source for the whole port: `membership_card_verifier/packages/verifier/src/` (1,618 lines across `CardVerifier.ts`, `canonicalize.ts`, `constants.ts`, `crypto.ts`, `errors.ts`, `index.ts`, `types.ts`, `version.ts`, `stages/stage1.ts`–`stage6.ts`) and its test suite under `test/`.

Target package layout (created in Phase 1):
```
membership_card_verifier/packages/verifier-py/
  pyproject.toml
  README.md
  src/membership_card_verifier/
    __init__.py
    errors.py
    constants.py
    version.py
    canonicalize.py
    crypto.py
    types.py
    card_verifier.py
    stages/{__init__,stage1,stage2,stage3,stage4,stage5,stage6}.py
  tests/
    conftest.py
    fixtures.py
    test_canonicalize.py
    test_crypto.py
    test_errors.py
    test_version.py
    stages/test_stage{1..6}.py
    integration/{test_verifier,test_full_pipeline,test_skip_propagation,test_versioning}.py
  vectors/   # shared cross-language JSON test vectors (Phase 5)
```

---

## Phase 1: Scaffolding & Core Primitives

Small, mechanical, well-specified translations. Every step in this phase is a strong candidate for a Haiku subagent — each source file is short (9–130 lines), has no cross-file ambiguity once given the JS source, and success is checkable by direct comparison.

### Step 1.1 — Package scaffold
**What:** Create `pyproject.toml` (hatchling backend, package name `membership-card-verifier`, import name `membership_card_verifier`, Python `>=3.11`), dependencies `cryptography` and `httpx`, dev dependencies `pytest`, `pytest-asyncio`, `ruff`, `mypy`. Create the directory tree above with empty `__init__.py` files.
**Who:** Claude (sets conventions the rest of the plan depends on — not delegated).
**Context:** `membership_card_verifier/packages/verifier/package.json` (for version/description parity), strategic plan decisions section.
**Done when:** `pip install -e .` succeeds from `verifier-py/` in an empty venv and `import membership_card_verifier` works (even with stub contents).

### Step 1.2 — Port `errors.py`
**What:** Translate `src/errors.ts` (`CardProtocolError`) to a Python exception class with `code: str` and `message`.
**Who:** Haiku subagent.
**Context:** `membership_card_verifier/packages/verifier/src/errors.ts` (full file, 9 lines).
**Done when:** `CardProtocolError("SOME_CODE", "msg")` raises with `.code` and `str(e) == "msg"` accessible; a one-line pytest smoke test passes.

### Step 1.3 — Port `constants.py` and `version.py`
**What:** Translate `src/constants.ts` (endpoint placeholders, `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`) and `src/version.ts` (`extract_protocol_version`, raising `CardProtocolError` with `MISSING_PROTOCOL_VERSION` / `UNKNOWN_PROTOCOL_VERSION`).
**Who:** Haiku subagent.
**Context:** `membership_card_verifier/packages/verifier/src/constants.ts`, `src/version.ts` (full files, 10 and 27 lines), and the completed `errors.py` from Step 1.2.
**Done when:** `extract_protocol_version({"protocol_version": "0.1"})` returns `"0.1"`; missing/unknown version cases raise the correct `CardProtocolError` codes, matching `test/version.test.ts` scenarios.

### Step 1.4 — Port `canonicalize.py`
**What:** Translate `src/canonicalize.ts` — RFC 8785 JCS: sort keys by Unicode code point, no whitespace, UTF-8 bytes out, `null` preserved, numbers via JSON-compatible formatting, raise on non-finite numbers.
**Who:** Haiku subagent, but flag for review — this is the highest-interop-risk primitive in this phase (see Phase 5).
**Context:** `membership_card_verifier/packages/verifier/src/canonicalize.ts` (full file, 29 lines), `test/canonicalize.test.ts` (translate its cases as the acceptance check).
**Done when:** Output is byte-identical to the JS version's `TextEncoder().encode(...)` output for every case in the translated `test/canonicalize.test.ts`, including nested objects, unicode keys/strings, negative numbers, `null`, empty arrays/objects. Python's `json.dumps` number formatting must be checked against JS `JSON.stringify` number formatting — do not assume they match without a test case for edge values (e.g. `1e21`, `-0`, very small floats).

### Step 1.5 — Port `crypto.py`
**What:** Translate `src/crypto.ts`: `keccak256` (hex string out), `hkdf_sha3_256`, `aes256gcm_decrypt` (12-byte nonce || ciphertext || 16-byte tag layout, `DECRYPTION_FAILED` on auth failure or short input), `ml_dsa44_verify`, `secp256r1_phase1_verify` (SHA-256 prehash, 64-byte x||y pubkey prefixed with `0x04`, 64-byte r||s signature).
**Who:** Claude, not delegated — this is the module where the `cryptography` library's ML-DSA API needs to be confirmed live (per strategic plan open question #2), not assumed from documentation.
**Context:** `membership_card_verifier/packages/verifier/src/crypto.ts` (full file, 92 lines), strategic plan §"Decisions From Review" (ML-DSA library = `cryptography`), `test/crypto.test.ts`.
**Done when:** All functions implemented; a quick self-consistency check (sign+verify round trip isn't needed since this package is verify-only, but decrypt a locally-AES-encrypted test blob and confirm `keccak256`/`hkdf` outputs match known test vectors from `test/crypto.test.ts`) passes. If `cryptography`'s ML-DSA API differs materially from what research suggested, note the actual API shape in this step's output for Step 1.1's dependency pin.

### Step 1.6 — Port `types.py`
**What:** Translate `src/types.ts` (230 lines) to Python — dataclasses (or `TypedDict`s, pick one convention and use it consistently) for `RpcProvider`/`IpfsProvider` (as `typing.Protocol` with `async def` methods per the asyncio decision), `CardEntry`, `PressAuthEntry`, `SubCardEntry`, `LogEntry`, `EasAttestation`, `CardDocument`, `PastKey`, `SubCardDocument`, `SubCardLimitation`, `FieldRequirement`, `VerifierConfig`, `SignedMessageEnvelope`, `SignatureEntry`, `VerifyCardOptions`, `EnvelopeVerificationResult`, `SignatureVerificationResult`, `CardVerificationResult`, `RevocationStatus`, `LogUpdate`, `VerificationError`, `EasAnnotation`, `NonComplianceReport`, `FailedCheck`.
**Who:** Haiku subagent — mechanical field-by-field translation, but the *type convention choice* (dataclass vs TypedDict vs Pydantic) should be decided by Claude first and handed to the subagent as an instruction, not left to it.
**Context:** `membership_card_verifier/packages/verifier/src/types.ts` (full file), a one-line instruction on which Python type convention to use.
**Done when:** Every JS interface has a Python equivalent with matching field names (snake_case is fine per Python convention, but note any renames explicitly in a comment) and matching optionality; `card_verifier.py` (Phase 3) can import all of them without needing ad-hoc dicts.

### Phase 1 Milestone Review
**What:** Verify `errors.py`, `constants.py`, `version.py`, `canonicalize.py`, `crypto.py`, `types.py` are mutually consistent — same error codes used across files, `types.py`'s `VerifierConfig` fields match what `crypto.py`/`canonicalize.py` will be called with, no circular imports. Run the Phase 1 test files. Confirm the `cryptography` ML-DSA API question from Step 1.5 didn't surface a blocker (e.g., an unavailable backend) that changes the dependency story from the strategic plan.
**Who:** Claude.
**Context:** All Phase 1 output files, strategic plan open question #2.
**Done when:** All Phase 1 tests green, one-paragraph summary written noting any deviations from the strategic plan (e.g., if `cryptography`'s API required a different approach than expected), and explicit go-ahead to start Phase 2.

**Clarification checkpoint:** If Step 1.5 finds `cryptography`'s ML-DSA support is unavailable, broken, or requires an unreasonably new OpenSSL/AWS-LC build, stop and check in before proceeding — this contradicts a strategic-plan decision and needs a real conversation about the `dilithium-py` fallback, not a silent substitution.

---

## Phase 2: Stage Modules

Each stage is a direct, well-bounded translation with a single JS source file as ground truth. All are strong Haiku candidates given Phase 1 primitives are done — the logic is already fully worked out in the reference implementation, no design decisions remain.

### Step 2.1 — Port `stages/stage1.py`
**What:** Translate `src/stages/stage1.ts` — dispatch on `key_scheme` (`mldsa44` default vs `secp256r1_phase1`), base64url decode + exact length checks (1312/2420 bytes for mldsa44, 64/64 for secp256r1_phase1), canonicalize payload, verify.
**Who:** Haiku subagent.
**Context:** `stages/stage1.ts` (full file, 77 lines), completed `canonicalize.py`, `crypto.py`, `errors.py` from Phase 1, `test/stages/stage1.test.ts` as the translation target for `tests/stages/test_stage1.py`.
**Done when:** All `test/stages/stage1.test.ts` scenarios pass in Python translation, including both key schemes and both length-mismatch error paths.

### Step 2.2 — Port `stages/stage2.py`
**What:** Translate `src/stages/stage2.ts` (258 lines) — the longest and most stateful stage: card entry lookup, sub-card doc decrypt, holder/app binding checks, master card decrypt, active_subcards directory check, on-chain sub-card registration check, holder + app ML-DSA signature verification, app_card chain walk to `appCertificationRoot`. Preserve the exact early-return points and error codes (`CARD_NOT_FOUND`, `ADDRESS_BINDING_MISMATCH`, `SUB_CARD_NOT_IN_ACTIVE_DIRECTORY`, `INVALID_HOLDER_SIGNATURE`, `SUB_CARD_INACTIVE`, `INVALID_APP_SIGNATURE`, `APP_CARD_CHAIN_NOT_TRUSTED`).
**Who:** Haiku subagent, but this step should be given the full file rather than a summary — it's long enough that paraphrasing risks dropping one of the 15 numbered steps in the JS comments.
**Context:** `stages/stage2.ts` (full file), Phase 1 outputs, `test/stages/stage2.test.ts`.
**Done when:** All `test/stages/stage2.test.ts` scenarios pass; every early-return path (there are ~9 distinct hard-rejection points) has a corresponding passing/failing test case.

### Step 2.3 — Port `stages/stage3.py`
**What:** Translate `src/stages/stage3.ts` — chain walk from a starting card doc, checking `trustedRoots` and `isPolicyAuthorizer` at each hop, decrypting ancestor docs, `CHAIN_DEPTH_EXCEEDED` after `maxChainDepth` hops.
**Who:** Haiku subagent.
**Context:** `stages/stage3.ts` (full file, 100 lines), Phase 1 outputs, `test/stages/stage3.test.ts`.
**Done when:** All `test/stages/stage3.test.ts` scenarios pass, including the depth-exceeded case and both "next address is already root" and "root found after ancestry exhausted" base cases.

### Step 2.4 — Port `stages/stage4.py`
**What:** Translate `src/stages/stage4.ts` — parallel log fetch (`asyncio.gather`, not `Promise.all`, per the asyncio decision), partition 1xx–7xx as `log_updates` vs 8xx/9xx as revocations, earliest-revocation-wins, staleness check against `revocationFreshnessWindowSeconds`, `was_valid_at_signing_time` / `is_currently_valid` computation including the `rejectStaleRevocation` override.
**Who:** Haiku subagent.
**Context:** `stages/stage4.ts` (full file, 119 lines), Phase 1 outputs, `test/stages/stage4.test.ts`.
**Done when:** All `test/stages/stage4.test.ts` scenarios pass, including not-revoked, 8xx revoked, 9xx loud_revocation, and stale-data cases with both `rejectStaleRevocation` values.

### Step 2.5 — Port `stages/stage5.py`
**What:** Translate `src/stages/stage5.ts` — policy snapshot fetch, `field_definitions` required-field check, press authorization check (including `press_subsequently_revoked`), non-compliance report POST via `httpx` (per the HTTP client decision) to `registryEndpoint ?? PRESS_REGISTRY_BODY_ENDPOINT`, base64url-encoding the raw card bytes into the report.
**Who:** Haiku subagent.
**Context:** `stages/stage5.ts` (full file, 130 lines), Phase 1 outputs, `test/stages/stage5.test.ts`. Note the HTTP client decision (httpx, async) explicitly in the handoff — the JS version uses bare `fetch`.
**Done when:** All `test/stages/stage5.test.ts` scenarios pass with an `httpx` mock/mock transport standing in for the Registry Body endpoint (mirror whatever mocking approach the JS test uses for `fetch`).

### Step 2.6 — Port `stages/stage6.py`
**What:** Translate `src/stages/stage6.ts` — opt-in via `fetchAnnotations`, recommended-annotators fetch (`httpx`), merge with `additionalAnnotators`, parallel EAS attestation fetch per chain address, per-attestation content fetch + the documented-incomplete annotator chain walk (preserve the `TODO` comment and current simplified behavior — do not silently "fix" it beyond what the JS version does).
**Who:** Haiku subagent.
**Context:** `stages/stage6.ts` (full file, 132 lines), Phase 1 outputs, `test/stages/stage6.test.ts`.
**Done when:** All `test/stages/stage6.test.ts` scenarios pass, including the `fetchAnnotations: false` short-circuit.

### Phase 2 Milestone Review
**What:** Confirm all six stage modules share consistent function signatures (what each takes/returns), consistent error-code usage matching the JS reference table, and that `types.py`'s stage result shapes (if you introduced per-stage result dataclasses) are used consistently. Run the full Phase 1 + Phase 2 test suite.
**Who:** Claude.
**Context:** `stages/stage1.py`–`stage6.py`, their test files, README.md's error code reference table (for cross-check).
**Done when:** All Phase 1 + Phase 2 tests green; every error code in the JS README's table is confirmed present and correctly triggered in the Python stages; summary written; go-ahead to start Phase 3.

---

## Phase 3: Orchestration

### Step 3.1 — Port `card_verifier.py`
**What:** Translate `src/CardVerifier.ts` (369 lines) — the `CardVerifier` class: constructor validation (`MISSING_RPC_PROVIDER`, `MISSING_IPFS_PROVIDER`, `APP_CERTIFICATION_ROOT_NOT_CONFIGURED`) and defaults merging, `verify_envelope()` (protocol version extraction with its own error-envelope early-return shape, envelope_id via SHA-256 of canonicalized envelope, `asyncio.gather` over signature entries), `verify_card()` (the documented simplified/no-Stage-2 path for direct card checks), and the private `_verify_signature_entry` / `_build_result` / `_skipped_result` helpers with their exact skip-propagation branching (stage2 hard-rejection skips 3–5; stage3 hard-rejection on `DECRYPTION_FAILED`/`ADDRESS_BINDING_MISMATCH` skips 4–5).
**Who:** Claude, not delegated. This is the file where all the cross-stage control flow and skip-propagation semantics live — Goal 1 of the strategic plan (behavioral identity) lives or dies here, and it needs a careful line-by-line read against the JS source rather than a paraphrase.
**Context:** `src/CardVerifier.ts` (full file), all of Phase 1 and Phase 2 outputs, `test/integration/verifier.test.ts`, `test/integration/full-pipeline.test.ts`, `test/integration/skip-propagation.test.ts`, `test/integration/versioning.test.ts` (read, don't yet translate — that's Step 4.x).
**Done when:** `CardVerifier(config).verify_envelope(envelope)` and `.verify_card(address)` are implemented with matching signatures/behavior to the JS class; a hand-written smoke test exercising one full "everything passes" path and one "stage 2 hard rejection" path (mirroring `skip-propagation.test.ts`) passes before moving to full test translation.

### Phase 3 Milestone Review
**What:** Read `card_verifier.py` against `CardVerifier.ts` line-by-line (not just test-pass) to catch behavioral drift that happens to pass a thin smoke test — e.g., confirm the exact conditions for stage-skip, confirm `errors` accumulation order, confirm `verify_card`'s intentionally-simplified chain-walk-of-one behavior is preserved rather than "improved."
**Who:** Claude.
**Context:** `src/CardVerifier.ts`, `card_verifier.py`.
**Done when:** Line-by-line comparison complete, any discrepancies fixed, summary of any intentional deviations (should be none) written, go-ahead to start Phase 4.

**Clarification checkpoint:** If this review finds the JS reference implementation itself has a bug or an inconsistency with its own README (e.g., `verify_card`'s documented "skip Stage 2" behavior vs. what the code does), stop and check in rather than deciding unilaterally whether the Python port should reproduce the bug or fix it.

---

## Phase 4: Test Suite Translation

Direct, mechanical translations against a fixed reference (the JS test files) — good Haiku candidates, one file at a time, now that Phases 1–3 give them something real to test against.

### Step 4.1 — Translate `test/fixtures.ts` → `tests/fixtures.py`
**What:** Translate every fixture object/helper in `test/fixtures.ts` into Python equivalents (same field values, same structure), per the strategic plan's "translate JS fixtures" decision.
**Who:** Haiku subagent.
**Context:** `membership_card_verifier/packages/verifier/test/fixtures.ts` (full file), completed `types.py`.
**Done when:** Every fixture importable from `tests/fixtures.py` with identical data to its JS counterpart.

### Steps 4.2–4.7 — Translate each stage test file
**What:** For each of `test/stages/stage{1..6}.test.ts`, produce `tests/stages/test_stage{1..6}.py` covering the same scenarios (already used as the "done when" bar in Phase 2, but now formalized as committed test files using `tests/fixtures.py`).
**Who:** Haiku subagent, one file per subagent call.
**Context:** The specific `test/stages/stageN.test.ts` file, the corresponding `stages/stageN.py`, `tests/fixtures.py`.
**Done when:** Each translated test file passes against its Python stage module.

### Step 4.8 — Translate integration tests
**What:** Translate `test/integration/verifier.test.ts`, `full-pipeline.test.ts`, `skip-propagation.test.ts`, `versioning.test.ts` into `tests/integration/test_*.py`.
**Who:** Claude (not delegated) — these tests are the actual proof of Goal 1/Goal 4 and exercise the orchestration logic from Phase 3 that itself wasn't delegated; keep the same level of scrutiny.
**Context:** All four JS integration test files, `card_verifier.py`, `tests/fixtures.py`.
**Done when:** All four translated integration test files pass.

### Step 4.9 — Translate remaining unit tests
**What:** Translate `test/canonicalize.test.ts`, `test/crypto.test.ts`, `test/errors.test.ts`, `test/version.test.ts` (if not already fully covered by Phase 1 acceptance work) into committed `tests/test_*.py` files.
**Who:** Haiku subagent.
**Context:** The four JS test files, corresponding Phase 1 Python modules.
**Done when:** All pass.

### Phase 4 Milestone Review
**What:** Run the complete Python test suite (`pytest`) and confirm the count/shape of test cases roughly matches the JS suite's (no silently-dropped scenarios). Check for any JS test that couldn't be meaningfully translated (e.g., relies on a Node-specific mock) and confirm it has a Python-appropriate equivalent rather than being skipped.
**Who:** Claude.
**Context:** Full `tests/` directory, full JS `test/` directory (for the comparison).
**Done when:** Full suite green, a short coverage-parity note written, go-ahead to start Phase 5.

---

## Phase 5: Cross-Language Interoperability Verification

This is the highest-risk phase per the strategic plan's Goal 2 and is not delegated to Haiku — it requires running both the JS and Python packages side by side and comparing raw output, which needs judgment about what discrepancies matter.

### Step 5.1 — Generate shared vectors from the JS package
**What:** Write a small script (in the JS `verifier` package or a scratch script) that generates a `vectors/*.json` corpus: canonicalize() outputs for a range of tricky objects (unicode, nested, negative numbers, null, empty containers, large/small numbers), and — if feasible without real key material — any deterministic crypto outputs (e.g., a fixed AES-GCM ciphertext + key + expected plaintext, a fixed keccak256 input/output, a fixed HKDF input/output). ML-DSA signature verification vectors: use a known-answer test vector from the FIPS 204 spec or from `@noble/post-quantum`'s own test vectors if bundled, rather than generating fresh keypairs (verification-only package, no signing capability needed).
**Who:** Claude.
**Context:** `membership_card_verifier/packages/verifier/src/crypto.ts`, `src/canonicalize.ts`, `test/crypto.test.ts`, `test/canonicalize.test.ts` (existing test vectors are a good starting corpus).
**Done when:** `verifier-py/vectors/*.json` committed with inputs and expected outputs for canonicalize, keccak256, hkdf-sha3-256, aes-256-gcm decrypt, and ML-DSA-44 verify (using known-answer vectors, not freshly-generated keys).

### Step 5.2 — Verify Python against the vectors
**What:** Write `tests/test_interop_vectors.py` that loads `vectors/*.json` and asserts the Python primitives produce the exact expected outputs.
**Who:** Claude (mechanical once vectors exist, but keep with the interop work rather than splitting to Haiku — small enough not to matter).
**Context:** `vectors/*.json` from Step 5.1, `canonicalize.py`, `crypto.py`.
**Done when:** All vector-based assertions pass. Any failure here is a stop-the-line issue — it means the port is not byte-compatible with the JS package, which is Goal 2 of the strategic plan.

### Phase 5 Milestone Review
**What:** Confirm every primitive listed in the strategic plan's Goal 2 objectives (canonicalize, ML-DSA-44 verify, secp256r1 verify, AES-256-GCM decrypt, keccak256, HKDF-SHA3-256) has at least one passing cross-language vector. Note any primitive where true cross-language vectors weren't achievable (e.g., no accessible ML-DSA known-answer test) and what substitute confidence was used instead.
**Who:** Claude.
**Context:** Strategic plan §Goal 2 / Key Objectives, `vectors/`, `tests/test_interop_vectors.py`.
**Done when:** Coverage confirmed or gaps explicitly documented, go-ahead to start Phase 6.

**Clarification checkpoint:** If any interop vector fails and the cause isn't a simple bug (e.g., it looks like a genuine algorithmic mismatch between `cryptography`'s ML-DSA implementation and `@noble/post-quantum`'s), stop and check in — this is exactly the risk the strategic plan flagged, and it may mean the library choice from the strategic plan's decision needs revisiting.

---

## Phase 6: Packaging & Polish

### Step 6.1 — Lint/type-check pass
**What:** Run `ruff check` and `mypy` across `src/` and `tests/`, fix findings.
**Who:** Haiku subagent, with instruction to report anything that looks like a genuine bug (not just style) rather than silently "fixing" it in a way that changes behavior.
**Context:** Full `verifier-py/` tree, `pyproject.toml` lint/type-check config.
**Done when:** Clean `ruff check` and `mypy` runs, or documented justified exceptions.

### Step 6.2 — README
**What:** Write `verifier-py/README.md` mirroring the JS package's README structure (How it works, Installation, Quick start, Providers, Configuration, Reading a result, The verification pipeline, Error handling, Non-compliance reporting, Serialization utility, Cryptographic notice, Before going to production) with Python-flavored code samples (`async def`, `Protocol` providers, `pip install`).
**Who:** Claude — needs judgment about what changes from the JS version (e.g., no separate provider packages to install since those are out of scope) rather than a mechanical translation.
**Context:** JS `README.md` (full file), final `verifier-py/` API surface.
**Done when:** README accurately describes the shipped Python API, with no stale JS-isms (npm install commands, `Promise`, etc.).

### Step 6.3 — Final verification
**What:** Fresh-venv install (`pip install -e verifier-py/`), run full `pytest`, run `ruff`/`mypy`, confirm no leftover placeholder-endpoint strings are silently different from the JS constants (`PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER`, `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` should match verbatim, per Goal 1).
**Who:** Claude.
**Context:** Full `verifier-py/` tree.
**Done when:** Clean install, full green test suite, lint/type-check clean, placeholder strings verified identical to the JS package — plan complete.

---

## Clarification Checkpoints (summary)

- Before Phase 1 step 1: confirm the package location assumption (`membership_card_verifier/packages/verifier-py/`).
- End of Phase 1: if `cryptography`'s ML-DSA support is unavailable/broken, stop before building the rest of the crypto module around it.
- End of Phase 3: if the JS reference has an internal inconsistency (code vs. its own README), stop rather than choosing unilaterally whether to reproduce or fix it.
- End of Phase 5: if a cross-language crypto vector fails for an algorithmic (not bug) reason, stop — this may require revisiting the library choice.
