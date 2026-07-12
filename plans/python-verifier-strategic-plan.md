# Python Verifier Port — Strategic Plan

Companion: [python-verifier-implementation-plan.md](./python-verifier-implementation-plan.md)

Scope: a Python port of `@membership-card-protocol/verifier` only (the `membership_card_verifier/packages/verifier` package). `verifier-rpc-provider` and `verifier-ipfs-provider` are explicitly out of scope — Python callers supply their own provider implementations, same as any JS caller who doesn't use the ready-made wrappers.

---

## Goals

1. **Ship a pip-installable package that is behaviorally identical to the JS verifier.** Same six-stage pipeline, same result shape, same error codes, same configuration surface — a Python caller reading the JS README should be able to predict the Python API almost exactly.

2. **Guarantee cross-language interoperability at the byte level.** Canonicalization (RFC 8785), keccak256 address derivation, ML-DSA-44 verification, AES-256-GCM decryption, and HKDF-SHA3-256 key derivation must produce identical results to the JS package for identical inputs. A card verified as valid by the JS package must never be verified as invalid by the Python package, or vice versa.

3. **Let Python services participate in the Card Protocol without a Node.js runtime.** Backend verifiers, audit tooling, and CLI utilities written in Python today have no way to check envelope validity except shelling out to Node. This removes that dependency.

4. **Reach the JS package's test confidence level.** The JS package has unit tests per stage, per crypto primitive, and integration tests for the full pipeline plus edge cases (skip propagation, versioning). The Python port should carry equivalent coverage, ideally against literal shared test vectors rather than independently-invented ones.

## Rationale

**Behavioral identity (Goal 1)** matters because this package's entire value is that "any party with access to IPFS and the Arbitrum One registry can verify a card" — independently. If the Python port drifts from the JS semantics (different skip logic, different field names, different error taxonomy), it stops being an independent verifier of the *same* protocol and becomes a second protocol that happens to look similar. Divergence here is a governance risk, not just an API inconvenience.

**Byte-level interoperability (Goal 2)** is the highest-risk part of this port. JS post-quantum crypto (`@noble/post-quantum`) and Python post-quantum crypto are different implementations of the same FIPS 204 spec — correctness bugs or encoding mismatches (e.g., point compression, canonicalization edge cases with non-ASCII strings or negative-zero numbers) are exactly the kind of thing that passes casual testing and fails on a specific real card. This needs cross-language test vectors, not just "does verify() return true on a hand-built fixture."

**No Node dependency (Goal 3)** is the actual reason to do this port. Card Protocol infrastructure is polyglot (contracts in Rust, various SDKs, a relay service) — teams building Python-side tooling (auditors, batch revocation scanners, data pipelines) currently have no first-party verifier.

**Test parity (Goal 4)** exists because a partially-tested cryptographic verifier is worse than no verifier — it creates false confidence. The JS package's test suite is the spec in practice; matching it is cheaper than re-deriving correctness independently and less likely to miss an edge case the JS authors already found (see `test/integration/skip-propagation.test.ts`, `test/integration/versioning.test.ts`).

## Key Objectives

**Goal 1 — Behavioral identity**
- All 6 stages implemented with the same skip-propagation semantics (`"skipped"` sentinel, hard-rejection rules) as `CardVerifier.ts`.
- `VerifierConfig`, `SignatureVerificationResult`, `CardVerificationResult`, and all supporting types have direct Python equivalents (dataclasses or Pydantic models) with matching field names and semantics.
- Every JS error code in the README's reference table (`INVALID_PUBLIC_KEY_LENGTH`, `DECRYPTION_FAILED`, `CHAIN_DEPTH_EXCEEDED`, etc.) is reproduced exactly, thrown as the Python equivalent of `CardProtocolError`.

**Goal 2 — Interoperability**
- `canonicalize()` produces byte-identical output to the JS version across a shared corpus of test objects (nested objects, unicode keys, negative numbers, `null` values, empty arrays/objects).
- ML-DSA-44 verify, secp256r1/SHA-256 verify, AES-256-GCM decrypt, keccak256, and HKDF-SHA3-256 all pass a shared set of cross-language vectors (JS-generated ciphertexts/signatures verified successfully by Python, and vice versa where applicable).
- A committed real (or realistic, protocol-shaped) `SignedMessageEnvelope` fixture verifies identically — same result object modulo language-native type representation — in both packages.

**Goal 3 — No Node dependency**
- `pip install membership-card-verifier` (or `pip install -e .` from source) is sufficient to get a working `CardVerifier` given caller-supplied providers — no npm, no Node runtime, no subprocess shelling to JS anywhere in the import path.
- Provider interfaces are expressed as `typing.Protocol` (or ABCs) matching `RpcProvider`/`IpfsProvider` shapes, documented well enough that a Python caller can write a working provider without reading the JS source.

**Goal 4 — Test parity**
- Every JS test file under `test/` and `test/stages/` has a corresponding Python test module covering the same scenarios (not necessarily the same test code, but the same behaviors: each stage's pass/fail/skip paths, both integration tests, versioning behavior).
- CI runs the Python test suite on the target Python version(s) and it's green before this is considered done.

## Decisions Already Made

- **Async model:** the Python port will mirror the JS package's async design. `RpcProvider`/`IpfsProvider` are `Protocol` classes with `async def` methods; `CardVerifier.verify_envelope()` / `verify_card()` are coroutines.
- **Package identity:** distribution name `membership-card-verifier` (PyPI-style), import name `membership_card_verifier`, minimum supported version Python 3.11.
- **Plans location:** this document and its implementation companion live in `plans/`, alongside the existing JS verifier plans (`verifier-strategic-plan.md`, `verifier-implementation-plan.md`).

## Decisions From Review

- **ML-DSA-44 library:** `cryptography` (pyca), backed by AWS-LC/BoringSSL, is the primary implementation — it also covers AES-256-GCM, ECDSA P-256, and HKDF, minimizing the dependency surface. The backend-availability risk (older deployment targets lacking a recent enough build) is accepted for now; not building a `dilithium-py` fallback in this initiative. Revisit if a real deployment target can't meet the `cryptography` version requirement.
- **HTTP client:** `httpx`, for Stage 5's non-compliance report POST — async-native, consistent with the asyncio decision.
- **Test vectors:** the Python suite translates the JS package's `test/fixtures.ts` fixtures directly into Python, so both suites exercise the same scenarios. Python-only fixtures are additive, not a replacement.
- **Publishing:** out of scope. The deliverable is a fully-tested, locally installable package (`pip install -e .` or install from a git URL). No PyPI release step in this initiative.

## Open Questions

1. **Packaging/build tooling.** No existing Python packaging convention was found elsewhere in this repo (it's a JS/TS + Rust monorepo). Defaulting to a standard `pyproject.toml` with `hatchling` as the build backend, `pytest` for tests, and `ruff`/`mypy` for lint/type-check — flag during Phase 1 if there's a house preference instead.

2. **`cryptography` ML-DSA API stability.** ML-DSA support in `cryptography` is recent; the exact API (method names, key/signature encoding expectations) needs to be confirmed against the installed version at implementation time rather than assumed from research done during planning.
