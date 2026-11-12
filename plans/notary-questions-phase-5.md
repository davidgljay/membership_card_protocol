# Digital Notaries — Phase 5 Implementation Questions (step 5.0, CP5)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Code plan: [notary-code-plan.md](notary-code-plan.md)

**Status:** Answered, "OK to all" (David, 2026-11-12). Q11 downloads approved. **No code has been written.** Each question has a recommended answer. Reply with "OK to all" or answer by number. Anything marked **[security]** or **[spec]** is asked now rather than guessed (CP5, CP9).

**Scope of this phase as instructed:** 5.1, 5.2, 5.4, 5.5, 5.6, in the order of code-plan §4. Steps 5.3 and 5.3a are Opus and are not started. 5.5 and 5.6 depend on 5.3 (see Q1).

**How answers are recorded:** write the answer under **Answer:** in each question. I will not start 5.1 until every question has one.

---

## A. Plan and scope

### Q1. 5.5 and 5.6 can't meet their "Done when" without 5.3

- **Facts.**
  - 5.5's "Done when" is the end-to-end path running in docker-compose against the simulator. That needs the broker and worker from 5.3.
  - 5.6 measures the runtime from 5.3.
  - Code-plan §7.1 says the host is tested "with a mock enclave", so most of 5.5 can be built and tested without 5.3.
  - The implementation-plan header says Phase 5's goal is the end-to-end path, which only completes once 5.3 exists.
- **Recommendation.**
  1. Do 5.1, 5.2 and 5.4 in full and tick them.
  2. Build the 5.5 host against a mock enclave (an in-process `EnclaveTransport` that speaks the runtime §9 message table), with docker-compose files written but not run end to end. **Do not tick 5.5.** Record what remains (the compose run against the real runtime) in the handoff note.
  3. Don't start 5.6.
  4. Stop and tell you when I reach the point where 5.3 is needed.
- **Alternative.** Stop after 5.4 and leave 5.5 entirely for after 5.3.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q2. Execution order inside the session

Code-plan §4 gives 5.1 → 5.2 → (5.3, 5.3a) → 5.4 → 5.5 → 5.6.
- **Recommendation:** 5.1 → 5.2 → 5.4 → 5.5 (mock-enclave part). 5.4 needs only 5.1 and 5.2, so skipping 5.3 doesn't block it.

**Answer:** OK, as recommended (David, 2026-11-12).

---

## B. Step 5.1 — Shared object types and serialization

### Q3. Layout of the TypeScript workspace under `notary/` **[structure]**

- **Facts.** `press/`, `wallet-sdk/` and `membership_card_verifier/` are each their own pnpm workspace with vitest. `wallet-sdk` links its siblings with `file:` references. A script (`scripts/rewrite-file-deps.mjs`, described in `wallet-sdk/DEPLOYMENT.md`) rewrites those references at publish time.
- **Recommendation.**
  - `notary/` gets its own `pnpm-workspace.yaml` covering `attestation-ts`, `host` and a small `vectors-tools` package (the vector generator and its tests). Rust and TypeScript sit side by side in `notary/`, each with its own lockfile.
  - `wallet-sdk` and `membership_card_verifier` depend on `notary-attestation` through `file:` references, as they do for each other today.
  - I will **not** touch the publish-time rewrite scripts or `DEPLOYMENT.md` in this run. I'll list "register `notary-attestation` with the publish pipeline" as a follow-up for Phase 7.
  - Package manager and Node version follow `press/` (pnpm 9.6, Node ≥ 22).

**Answer:** OK, as recommended (David, 2026-11-12).

### Q4. Where host-side TypeScript gets the §21–§26 types **[structure]**

- **Facts.** Code-plan §3.1 places wallet objects (§21–§26) in `wallet-sdk/src/notary/types.ts`, and host-only objects (§29–§32) in `notary/host`. But the **host** also handles `NotaryJob`, `JobAnnouncement`, `SealedInput`, `HostReceipt` and the receipt/announcement formats. `wallet-sdk` pulls in `app-sdk`, provider packages and React-Native-related dependencies, which the host should not depend on.
- **Recommendation.**
  - Put §21–§26 in `wallet-sdk/src/notary/types.ts` as planned. Expose them through a **side-effect-free subpath export**, `@membership-card-protocol/wallet-sdk/notary-types` (types, the canonical-bytes helpers and the hash helpers only), and have the host import that subpath type-only plus helpers.
  - Add a vitest that checks this subpath imports nothing from the rest of the wallet.
  - Everything else is as in the code plan. Both copies of each shared definition are checked against `notary/vectors/`.
- **Alternative.** Put §21–§26 in `verifier/notary` with the other verifier-facing objects. That is simpler, but it departs from the approved code plan.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q5. Vector source of truth and file format **[structure]**

- **Plan.** Code-plan §7.2 requires `notary/vectors/{objects,user_data,xwing,lists,dup_tag}/`; `cards/` and `lists/` are produced later (5.3a / Phase 6), `dup_tag/` in 6.4. For 5.1 I will produce `objects/`, `user_data/` and `xwing/`.
- **Recommendation.**
  - **One JSON file per object kind**, each case holding `{ id, description, input, canonical_utf8, canonical_base64url, h_base64url }`. For signed objects, a case also carries the signing-bytes form (the object minus its signature field).
  - The TypeScript generator in `vectors-tools` builds inputs from fixed seeds and writes the expected bytes using the existing `canonicalize.ts` from the verifier. The committed files are then the contract.
  - **The Rust side does not regenerate them.** It parses each `input`, re-serializes it, and requires identical bytes and hash. Both sides therefore agree with the committed bytes, and the bytes are also checked against the hand-reviewed `specs/serialization-conformance.json` cases (TC-01 to TC-26).
  - A CI job regenerates and diffs (as for §7.5).
  - The vectors include a set of objects signed with ML-DSA-44 so that the signature check is cross-language too (see Q8).

**Answer:** OK, as recommended (David, 2026-11-12).

### Q6. Strictness of JCS numbers and of unknown fields **[security]**

Two decisions that the spec doesn't state.
1. **Numbers.** Notary objects contain only integers. The existing verifier `canonicalize.ts` accepts any finite number and preserves `null`. RFC 8785 requires ES6 number formatting, which a hand-written Rust serializer must match exactly for floats.
   - **Recommendation:** in the notary layer (not by editing `canonicalize.ts`), reject any non-integer number and any integer outside ±(2⁵³ − 1) when serializing or parsing a notary object, in both languages. Reject `null` inside notary objects (the conventions say absent fields are omitted, never `null`). Add test vectors for each rejection. The Rust JCS is then small and exact.
2. **Unknown fields.** §21–§34 objects carry a versioned `type` (e.g. `notary.job.v1`). The spec doesn't say whether an object with an extra field is valid.
   - **Recommendation:** **reject unknown top-level fields** on the §21–§34 objects (a new field means a new `type` version), but stay tolerant of the "other `CardDocument` fields" on the §20 notary card and inside card/policy sections. Hashes and signatures are always taken over the raw canonical bytes of the received object, never over a re-serialization of a typed struct.
   - **Why this is a security decision:** a tolerant parser plus a typed re-serialization could drop a signed field and still verify. Strict parsing plus raw-bytes hashing avoids it.
   - If you agree, I'd like the spec to say so; I'll record it as an erratum (E2 below) rather than edit the spec.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q7. Strict formats: base64url, timestamps, durations, card pointers, CIDs **[spec]**

The spec uses `base64url`, ISO 8601, durations, `card-pointer` and `cid` without a byte-level definition. For cross-language agreement I will implement these **strictly** and test them:

| Type | Proposed rule |
|---|---|
| `base64url` | Unpadded, alphabet `A–Z a–z 0–9 - _`, canonical (trailing bits zero). Padded or non-canonical input is rejected. Lengths are checked per field (e.g. 32 bytes for hashes, 1,312 for ML-DSA-44 public keys, 1,216 for X-Wing public keys, 1,120 for `enc`). |
| Timestamps | `YYYY-MM-DDTHH:MM:SS(.fff)?Z`, UTC only, valid calendar dates. Verifiers compare parsed instants and never reformat a signed string. |
| Durations | `PnD`, `PnW`, `PTnH`, `PTnM`, `PTnS` and their combinations. **No years or months** (variable length). Used for `key_period` and the derived-card durations. |
| `card-pointer` | 64 lowercase hex characters, no `0x` (`keccak256` of the public key), as in `wallet_sdk.md §8.1`. |
| `cid` | CIDv1, multibase base32 lowercase (`bafk…`, as the press produces), codec `raw`, hash sha2-256. Programs and public notary objects must be `raw`. |
| `input_hash` and Merkle leaves | Decode the 32-byte `input_hash` from base64url first. Leaf = `SHA-256(0x00 ‖ those 32 bytes)`. |

Is the strict set acceptable? In particular: confirm that the chain-time rule is "UTC `Z` only", and that card pointers are 64-hex lowercase with no `0x`.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q8. ML-DSA-44 library, signing mode, and interop **[security]**

- **Plan.** Rust `ml-dsa` (RustCrypto, currently **0.1.2**); TypeScript `@noble/post-quantum` (already in the verifier, `^0.5.4`; I'll stay on the installed version).
- **Concerns.**
  - `ml-dsa` 0.1.x is early. I haven't yet confirmed it matches noble's FIPS 204 pure mode (empty context).
  - noble signs with hedged randomness by default.
- **Recommendation.**
  - FIPS 204 pure ML-DSA-44, **empty context string**, as the verifier uses today.
  - Rust signing in the runtime will be **hedged**, with randomness from the NSM-seeded RNG. This isn't a spec question, only a note.
  - In 5.1, prove cross-verification in both directions (noble sign → Rust verify, Rust sign → noble verify) on the committed object vectors.
  - If `ml-dsa` fails interop or can't zeroize its secret key material, **I stop and propose** `fips204` (integritychain) or `libcrux-ml-dsa` (Cryspen, formally verified) rather than substitute quietly (CP9).
- Private-key storage form (32-byte seed vs expanded key) is a 5.3 decision. I'll use the seed form, which is what a broker needs to zeroize.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q9. X-Wing interop test design (CP9 checkpoint 1) **[security]**

- **Facts.**
  - `@hpke/hybridkem-x-wing` 0.7.1 does target draft-06 (its README links the draft-06 text) and accepts a **64-byte `ekm`** for deterministic encapsulation.
  - Rust `x-wing` 0.1.1 is "draft 06" and `hpke` 0.15.1 enables it with the `mlkem` feature (on by default).
  - Deterministic encapsulation in Rust is behind `x-wing`'s `hazmat` feature, and the `hpke` crate takes an RNG rather than an explicit seed.
  - `rxwing` (draft-11) is not used.
- **Recommendation.** Three layers:
  1. **KEM-level KATs.** The draft-06 test vectors against both libraries (`x-wing` with `hazmat` as a **dev-dependency only**).
  2. **HPKE-level fixed vectors.** Fixed recipient seed and fixed encapsulation seed give `enc`, `ct`, and the `Export("card-notary-receipt-v1", 32)` value, produced by one side, checked by the other. In Rust, a deterministic RNG yields the 64 encapsulation bytes in the order the crate consumes them; if that proves impossible, the Rust→JS direction uses a recorded random encapsulation checked by decryption.
  3. **Both directions, full protocol.** JS seals a `SealedInput` (info/aad per §24) → Rust opens it and exports; Rust seals → JS opens and exports; the plaintext and exported secrets must match.
- **If any layer fails:** stop and propose options (CP9). Nothing depends on X-Wing before this passes.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q10. Which Rust types land in 5.1

- **Recommendation.**
  - `notary-types` holds §20–§34, the `notary` section of §2.1 (with parameter references), the §2.2 template-policy shape, the `expires_at` field, JCS, `H`, CID helpers, the Merkle commitment and the 181-byte `user_data` layout.
  - It does **not** define `CardDocument`, `LogEntry` or `SubCardDocument`. Those belong with `notary-cards` (5.3a).
  - Same split on the TypeScript side: §2.1/§2.2 sections go in `verifier/notary/types.ts`, per code-plan §3.1.
  - `H(x)` and Merkle are implemented once per language and checked by shared vectors.

**Answer:** OK, as recommended (David, 2026-11-12).

---

## C. Step 5.2 — Simulator and attestation backends

### Q11. Downloading AWS public material **[needs your explicit yes]**

The attestation parser must be tested against real AWS documents (code-plan §7.1), and the verifier must pin AWS's root certificate. I'd like to fetch, from official AWS sources only:
- **`AWS_NitroEnclaves_Root-G1.zip`**, a few KB, from `https://aws-nitro-enclaves.amazonaws.com/`. I'd unzip it in the scratchpad, and **verify its SHA-256 and the certificate fingerprint against the value in AWS's own documentation** before pinning it. I will not rely on a fingerprint from memory.
- **A recorded, real attestation document** to use as a parser fixture. I haven't found a canonical official sample. I'd search for a public open-source test fixture and **show you its source before adding it to the repository**. If none is trustworthy, the fixture list says so and the real-document test waits for Phase 8.

Neither is run or executed. They're data. **Do you approve both downloads?**

**Answer:** OK, as recommended (David, 2026-11-12).

### Q12. Simulator test root: fixed or generated **[low risk]**

- **Recommendation.** A fixed, clearly labelled **test root key** (P-384, generated from a committed seed) in `notary/sim/fixtures/`, so fixtures are stable and vectors can be committed. A helper can also create a throw-away root per test. Production configs pin the real AWS root, so the test root is never trusted there. The `platform` field is `"simulator"`, refused unless a verifier opts in (`ATT_PLATFORM_NOT_ALLOWED`).

**Answer:** OK, as recommended (David, 2026-11-12).

### Q13. Does the runtime's `SimulatorBackend` hold the test CA key? **[structure]**

- Spec: `notary/sim` has a "fake NSM service … one socket per simulated enclave, with `attest` and a controllable clock" (code-plan §2.2). The runtime's `SimulatorBackend` should sit on the *client* side of that socket, so the runtime binary never contains the test CA key, and the same `NsmBackend`/`SimulatorBackend` trait works in the broker.
- **Recommendation.** Do it that way. Frames: 4-byte big-endian length + RFC 8785 JSON, as in runtime §8, with bytes as base64url. Unix socket by default, TCP optional (macOS and Linux both).

**Answer:** OK, as recommended (David, 2026-11-12).

### Q14. X.509 / COSE / CBOR libraries for the TypeScript attestation module **[security]**

- **Facts.**
  - `wallet-sdk` runs on React Native as well as web and Node. Hermes has no `crypto.subtle`.
  - The code plan suggests `@peculiar/x509`, which builds on WebCrypto, or a hand-rolled chain check with `@noble/curves` P-384.
  - The existing verifier already depends on `@noble/curves` and `@noble/hashes`.
- **Recommendation.**
  - **No WebCrypto dependency** in `notary-attestation`.
  - Signatures with `@noble/curves` (p384 / ES384).
  - ASN.1 parsing with `@peculiar/asn1-x509` (pure JavaScript).
  - A **small strict in-house CBOR decoder** (definite lengths only, no indefinite-length items, no duplicate map keys, no trailing bytes). COSE_Sign1 needs only maps, arrays, byte/text strings, unsigned integers and `null`. A strict parser is easier to audit than a general library, and this is the parser attackers will target.
  - Chain rules to implement and test: signature at each link, **validity at the document's timestamp**, issuer = subject of the next certificate, `basicConstraints` CA flag and `pathLenConstraint`, `keyUsage` `keyCertSign` on issuers, and rejection of unknown critical extensions. I'll write these as an explicit list in the module header with one test each, including against the real AWS document if Q11 is approved.
- **Rust side (`notary-attest::aws`, `sim`).** `ciborium` + `coset` for COSE, `x509-cert` + `p384` + `ecdsa` for the chain, the same explicit rules. `rustls-webpki` isn't used (it targets TLS server certificates).

**Answer:** OK, as recommended (David, 2026-11-12).

### Q15. Interface detail: `ATT_PLATFORM_NOT_ALLOWED` and the V steps

- The `AttestationVerifier.verifyEnvelope` result union in runtime §5 has four codes (V1–V5 failures). `ATT_PLATFORM_NOT_ALLOWED` is described in A.1 (text) but isn't in that union.
- **Recommendation.** The shared layer in `verifier/notary/attest.ts` raises it, from the configured platform allow-list, **before** calling a platform module. The platform module's union stays as written. I'll note this in the handoff as an interface detail, not an erratum.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q16. Where each V step lives, for the G5 grep check

- AWS-format parsing is confined to `notary-attest::aws`, `notary-attestation/src/aws-nitro-enclaves.ts` and `notary/deploy/`. The CI grep (code-plan §7.4) looks for `cabundle`, `nsm`, `COSE_Sign1` and the AWS root fingerprint outside those paths.
- **Question.** The simulator uses *the same format*, and so its module (`simulator.ts`, `notary-attest::sim`, `notary/sim`) necessarily mentions COSE. Is it acceptable that the simulator modules may also contain those strings, provided they only **import** the shared AWS parsing code and don't re-implement it?
- **Recommendation.** Yes: `simulator.ts` and `sim` call the parser in the AWS module with a different root, so they contain none of the grep terms; the grep stays as in §7.4. If that proves impractical, I'll ask before widening the allowed paths.

**Answer:** OK, as recommended (David, 2026-11-12).

---

## D. Step 5.4 — Wallet SDK and verifier support

### Q17. EAS anchor lookup by `job_hash` **[spec]**

- **Facts.** Protocol-objects §28 says job-log records are anchored by an EAS attestation with schema `{ job_hash, seq, record_cid }` "and indexed by `job_hash`". EAS's `Attested` event indexes only `recipient`, `attester` and `schemaUID`; custom schema fields are not indexed. `RpcProvider.getNotaryLogAnchors(scopeId)` (card_verifier §4.1) needs a lookup.
- **Recommendation.**
  - Implement `getNotaryLogAnchors` in `verifier-rpc-provider` by reading `Attested` events filtered by `schemaUID` (from a caller-supplied `fromBlock`, defaulting to the job's `opened` block when known), decoding the data, and filtering by `job_hash` client-side. It returns `{ seq, record_cid, timestamp }` with the **block timestamp**.
  - The host writes the attestation with `recipient` = zero address, and `refUID` unused. No schema change is needed.
  - Record "indexed by `job_hash`" as a wording erratum (E3).
- **Alternative.** Change the spec so the attestation's `recipient` is derived from `job_hash` for cheap indexing. That is a spec and schema change; I would not do it without your approval.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q18. Contract reads for `getGovernanceKeyset`

- The integration fixtures already use `getGovernanceKeyset(uint8 body_id) returns ((uint8[] keys, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme))`. I'll build the provider method on the same ABI fragment.
- **Question.** Is `body_id` for the PressRegistryBody a constant I should read from the `governance/` or `integration_tests` code, or does `NotaryConfig` carry it? **Recommendation:** put it in the provider's config with the value copied from `integration_tests/fixtures/src/governanceBootstrap.ts` as a documented default, and test it against the devnode ABI only in Phase 7. No contract changes.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q19. HPKE and X-Wing in the wallet on React Native

- `app-sdk` already depends on `hpke-js` ^1.8.0 (OHTTP), so WebCrypto/HPKE assumptions already hold in the wallet's runtimes.
- `@hpke/hybridkem-x-wing` uses the pure-JavaScript `mlkem` package plus `@hpke/common`. **Recommendation:** accept the dependency as planned, and test under Node only in this phase. A device test (Hermes) is not in scope, so it goes in the handoff as "untested on React Native".

**Answer:** OK, as recommended (David, 2026-11-12).

### Q20. Subpath export and build for `verifier/notary`

- The verifier builds with plain `tsc` into `dist`. **Recommendation:** add `exports["./notary"]` pointing at `dist/notary/index.js`, add a vitest asserting the core entry point's compiled import graph doesn't reach `dist/notary/` (code-plan §7.1), and keep `src/notary/` out of `src/index.ts`. I will not touch `verifier-py`.

**Answer:** OK, as recommended (David, 2026-11-12).

---

## E. Step 5.5 — Host service

### Q21. EAS client for the host

- **Recommendation.** Use `viem` with a hand-written minimal ABI fragment for `EAS.attest(...)` and the `Attested` event, not the full EAS SDK. This is the `viem` + `press/src/chain` pattern, and avoids a large dependency for one call.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q22. Redis client and KV abstraction

- `press/` uses nitropack's `useStorage` with an `ioredis`-backed `redis` driver, and a thin `KvStore` interface with an in-memory test version (`press/src/kv.ts`).
- **Recommendation.** Copy that pattern (as principle 4 of the code plan says: copy, don't import `press/`), including the in-memory store for unit tests. Storage keys and retention follow host §7 exactly, with a test that ciphertexts are deleted at finalize.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q23. `EnclaveTransport` and the vsock proxy

- Node has no native vsock. Host §3 says docker-compose runs a vsock proxy, which exposes a normal socket to Node.
- **Recommendation.** One `EnclaveTransport` interface with a socket implementation (Unix or TCP) used for **both** the simulator and the vsock proxy, which differ only in what listens at the other end. No Linux-only code in this phase. `tokio-vsock` stays a 5.3 concern on the Rust side.

**Answer:** OK, as recommended (David, 2026-11-12).

### Q24. Mock enclave for host tests (depends on Q1)

- **Recommendation.** An in-process mock that implements the host-facing message table of runtime §9 (valid `hello_ack`, `job_keyed`, `input_result`, `job_closed`, with fixed bytes) built from the `notary-types` vectors. It is test code only and never ships. It can't prove isolation or privacy properties, and the handoff note will say so.

**Answer:** OK, as recommended (David, 2026-11-12).

---

## F. Later-step notes (not blocking now; recorded so they aren't lost)

- **wasmi version (5.3).** The code plan says "pinned exact version". Current releases are `wasmi` 2.0.0 and 1.0.9. The checkpoint (runtime §17.4) needs fuel determinism and feature flags to disable everything §6 rejects. I'll choose and justify the version when you start 5.3.
- **`nsm-api` MSRV.** `aws-nitro-enclaves-nsm-api` 0.5.2 needs Rust 1.92. The local toolchain is 1.96, so a pinned toolchain in `notary/rust-toolchain.toml` is fine, but `hpke` needs 1.87 and `x-wing` 1.85. I'll pin the toolchain to one release in `rust-toolchain.toml` as planned (which exact release: I'd use 1.96, the installed stable).
- **Platform differences.** On macOS the workers' seccomp and UID isolation can't run (code-plan §2.2). Isolation tests belong in the Linux container.

---

## G. Errata and spec observations found while reading (no spec text edited)

| ID | Where | Observation | Proposed handling |
|---|---|---|---|
| **E1** | `protocol-objects.md §27`, lifecycle N8 | **Empty input set.** `input_commitment` is the Merkle root over the counted `input_hash` values, but nothing defines the root of an **empty** list, which occurs when `accepted = 0` (e.g. nobody contributed; `k_min ≥ 1` so the job is suppressed). N8 says the root must equal `input_commitment`. | Proposed: root of the empty list = `SHA-256("")` (RFC 6962 convention), a vector, and a spec line. **Needs your decision before the Merkle vectors are written (5.1).** |
| **E2** | `protocol-objects.md` notary conventions | Unknown fields on versioned notary objects are unspecified (Q6). | Strict rejection proposed. Needs a spec line. |
| **E3** | `protocol-objects.md §28` | "Indexed by `job_hash`" can't be literal for EAS (Q17). | Wording clarification, or a schema change if you prefer. |
| **E4** | `notary-code-plan.md §3.3` | The relay file is `relay/src/utils/oblivious_targets.ts`, not `relay/.../oblivious-targets.ts`. | Plan path typo; I'll correct the path in the code plan when I reach the relay change, unless you'd rather I leave the plan text alone. |
| **E5** | `notary_runtime.md §5` vs `notary_lifecycle.md A.1` | `ATT_PLATFORM_NOT_ALLOWED` is described in A.1 but absent from the §5 result union (Q15). | Interface note only; no change needed. |

| **E6** | `protocol-objects.md §27`, `§34` | "Each cosignature is over `H(body)`" and "each member signs `H(JCS(…))`": `H` is defined as a base64url string, so it is unclear whether the signed message is the 32 raw digest bytes or the 43-character base64url text. | **Needs your decision before 6.3 (cosignatures) and the governance scripts.** Proposed: the 32 raw digest bytes. Vectors in 5.1 treat cosignatures as structural placeholders and do not assume either. |
| **E7** | `protocol-objects.md §24` | `receipt_sealed` is "ChaCha20-Poly1305 under `Export("card-notary-receipt-v1", 32)`", but the nonce and aad are not given. | **Needs your decision before 5.3/5.4 (receipts).** Proposed: 12 zero-byte nonce is safe only because the key is single-use per input context; aad = canonical JSON of `{ "input_hash", "job_hash", "type": "notary.validation_receipt.sealed.v1" }`. The exporter secret itself is proven interoperable in 5.1. |
| **E8** | (observation, not a spec error) | `DeriveKeyPair(ikm)` differs between `hpke` 0.15.1 (follows draft-ietf-hpke-pq-03) and `@hpke/hybridkem-x-wing` 0.7.1 (X-Wing draft-06 expansion). The protocol never uses it: job keys are 32-byte secrets generated in the broker and exchanged as raw bytes, which interoperate bit for bit. | Do not call `derive_keypair`/`deriveKeyPair` in production code; the broker generates raw secrets. Recorded in the interop test. |
| **E9** | (security note) | Neither `@noble/post-quantum` nor the RustCrypto `ml-dsa` crate (README: "has never been independently audited") is audited. | Interop proven (identical keys and deterministic signatures, 5.1). Flagging for the security review at 5.7 and Phase 8 rather than substituting (CP9). |

| **E10** | `notary_lifecycle.md` A.2 step 13 vs `protocol-objects.md §33` | `inst_key_hash` is bound for every purpose, but W13 lists no expected value for it (a wallet cannot know a replica's instance key), while V10 says "each bound field equals the expected value". | Implemented: the shared V10 takes an `anyInstanceKey` option; the wallet requires `inst_key_hash` to be non-zero and does not compare it. Needs a one-line spec clarification. |
| **E11** | `notary_lifecycle.md` A.2 step 10 | "`issuer_card` = this policy": `issuer_card` is a card pointer but the job names the policy by CID (`policy_id`). | Implemented through the `NotaryChainReads.notaryCard` adapter, which must return the issuer's policy CID; the Phase 7 adapter over `CardVerifier` does the pointer-to-CID resolution. Needs a spec clarification. |

**Answers to E1–E5:** Agreed as proposed (David, 2026-11-12). E1: empty-set root = SHA-256("").

---

## H. What I will do the moment the answers are in

1. 5.1: Cargo workspace skeleton (`notary-types`, `notary-crypto` for the interop only), TS types and vector tools, the three vector sets, and the CP9 interop proofs (X-Wing, ML-DSA). **If interop fails I stop.**
2. 5.2: `notary/sim`, `notary-attest` (Rust), `notary-attestation` (TS) and the shared V steps, with one failing fixture per `ATT_*` code.
3. 5.4, then the mock-enclave host (5.5, not ticked).
4. After each step: run its tests, report the actual output, update the traceability table in code-plan §8, tick the step only when "Done when" is met.
5. Write `plans/milestones/notary-phase-5-progress.md` before stopping.

**Decisions at the end of the first Phase 5 session (David, 2026-11-12, "Accept proposals"):**
- **E6 decided:** cosignatures and list approvals sign the **32 raw digest bytes** of `H(body)` / `H(JCS(approval without "signatures"))`, not the base64url text.
- **E7 decided:** `receipt_sealed` = ChaCha20-Poly1305 under `Export("card-notary-receipt-v1", 32)` with a **12-byte all-zero nonce** (the key is single-use per HPKE context) and aad = RFC 8785 JSON of `{ "input_hash", "job_hash", "type": "notary.validation_receipt.sealed.v1" }`.
- **E2, E3, E10, E11 accepted as proposed** (strict unknown fields; EAS anchors found by client-side filtering; `anyInstanceKey` for W13; `issuer_card` resolved to the policy CID by the adapter). They still need one-line spec edits, which only David may approve.
- **E12 (new, found while implementing algorithm L; needs a decision):** for governance scheme 0 (ECDSA secp256r1), is the 32-byte digest the ECDSA *message hash* (HSM signs the digest as is) or the *message* that ECDSA hashes again with SHA-256? Implemented as the **digest used directly as the message hash** (what an HSM signing a digest does), behind a single pluggable function so changing it is a one-line fix. ML-DSA (scheme 1) signs the 32 digest bytes as its message.
- **E13 (new, found reading algorithm N step 6; needs a decision):** a notarization verifier cannot compute the expected attestation `public_key` (`SHA-256(job public key)`): the job key of the final epoch is not in the notarization, and N6 lists only `job_hash`, `final_epoch`, `program_hash` and `id_key_hash`. Proposed: require `public_key` to be present (32 bytes) and not compare it, as for `inst_key_hash` (E10); the nonce (`job_hash`) is still compared.
- **E14 (new, needs a decision):** the format of the `counted_inputs` object is not stated ("the sorted leaf list"). Proposed: RFC 8785 JSON array of base64url `input_hash` strings, pinned as a `raw` CID like every public notary object.
- **E13 and E14 decided (David, 2026-11-12):** accepted as proposed.
- **E12 analysis (2026-11-12), decision pending:** option A (digest = ECDSA message hash) equals standard ECDSA-SHA256 over the canonical JSON bytes, checked against OpenSSL (`node:crypto`); it matches the on-chain governance convention (RIP-7212 takes the 32-byte hash directly, `registry_contract.md §6.2`). Option B (hash the digest again) fails under OpenSSL over the canonical bytes and over any HSM that signs a digest as is. Recommendation: A.
- **E12 decided (David, 2026-11-12):** option A confirmed. The 32-byte digest is the ECDSA message hash (equivalent to ECDSA-SHA256 over the canonical JSON). Implemented in `verifyMemberSignature` (`verifier/src/notary/lists.ts`). The governance script must show members the list diff before they sign (blind-signing risk).
- **E15 (decided in code, flag for the spec; needs a one-line approval):** Stage 4 step 5a says `expires_at` "enters steps 6–7 like an 8xx `effective_date`" and is recorded under `revocation`. Taken literally, every unexpired derived card (they all carry `expires_at`) would report `status: "revoked"`. Implemented: the lapse is recorded under `revocation` (`status: "revoked"`, `code: null`, `reason: "expired"`) **only once `expires_at` has passed**; a future expiry changes nothing. Compared with the verifier's clock until a chain-time source exists.
- **E16 (needs a decision):** the EAS notary schema `{ job_hash, seq, record_cid }` has no ABI types in the spec. Implemented default `(bytes32 job_hash, uint64 seq, string record_cid)`, configurable in `notaryAnchors.schemaTypes`. The host (5.5) and `governance/scripts/eas-schema.ts` must use the same.
- **E17 (spec gap, blocks Stage 5 step 3a and algorithm G for later verifiers; needs a decision):** algorithm G binds the genesis attestation's nonce to `H(genesis request)`, and the request includes a random `nonce` and `requested_at`. Neither is on the notary card, and the card does not reference the request, so a verifier that is not the policy holder (derived-card verification, step 3a) **cannot recompute `H(request)`**. Without it, they cannot check that the attestation was made for *this* operator card and host key, which is exactly what the nonce exists to prevent. Proposed fix: add an immutable `genesis_request` field (CID of the pinned request) to the notary card (§20), so G can fetch the request, check it equals the card's own fields, and recompute the nonce. Until decided, step 3a is not implemented.
- **E17 decided (David, 2026-11-12): "Accept proposal".** The notary card (§20) gains an immutable `genesis_request` field (CID of the pinned genesis request). Implemented in `verifier/src/notary/derived.ts` (`verifyNotaryIssuedCard`): the later verifier fetches the request, requires it to equal the card's own `id_pubkey`/`chain_pubkey`/`operator_card`/`operator_host_pubkey`/`platform` and the notary policy CID, then runs algorithm G on the recomputed nonce. **Spec text still to change (needs David's approval):** `protocol-objects.md §20` (new field, and the genesis request must be pinned), `notary_lifecycle.md` A.3 (later verifiers fetch the request via the card's `genesis_request`), `card_verifier.md` §7.5 step 3a.
- **E18 (host additions the spec's tables do not cover; needs a one-line approval each):** (a) `ENCLAVE_ENDPOINTS`: how to reach each `ENCLAVE_CIDS` entry (through the vsock proxy, or a socket in the simulator); (b) `NOTARY_ADMIN_TOKEN`: the spec says `/genesis*` is "operator-authenticated" without a mechanism, so a shared bearer token (timing-safe compare) follows the press's admin routes; (c) `NOTARY_RELAY_TARGET_ID` and `NOTARY_PUBLIC_BASE_URL` for the announcement `transport` hints; (d) error code `NH_UNAUTHORIZED` (401) in the §14 table; (e) `NOTARY_HOST_MLDSA44_PRIVATE_KEY` is read as a 32-byte **seed** (base64url), the form the broker also uses.
- **E19 (observation):** the dependency tree needs two major versions of `@noble/hashes` (the verifier 1.x; `@noble/post-quantum` 0.5 uses 2.x). A nitropack build that traces dependencies as externals flattens them to one version and the built server crashes at startup. Found by running the built server, not by the unit tests. The host builds with `noExternals: true` (bundled), which fixes it. The press has the same dependency shape on a node-server build.

