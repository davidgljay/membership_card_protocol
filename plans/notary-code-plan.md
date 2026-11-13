# Digital Notaries — Code Plan (Phase 4)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Specs: [notary-spec-changes.md](notary-spec-changes.md) (approved at CP3, 2026-11-12) · Design record: [notary-design-decisions.md](notary-design-decisions.md)

**Status:** **Approved by David at CP4, 2026-11-12.** No code has been written. Phase 5 starts with the questions step 5.0 (CP5).

This document sets out:
- the layout of `notary/` and the crate and package boundaries;
- the changes needed in other parts of the repository;
- the build order, which follows Phases 5–7;
- the test strategy for each package;
- a traceability map from every spec requirement to a module and a test (§8).

Library choices and interface details that need David's input are collected in §10. Those that can wait are asked at step 5.0 (CP5).

**Terminology:** "AWS Nitro Enclaves" or "the enclave" for the TEE; "nitropack" for the web framework; "`nitro-devnode`" only for the Arbitrum dev node in the integration stack.

---

## 1. Principles

1. **One spec section, one module.** Each module names the spec section it implements in its header comment. The traceability map in §8 is kept up to date as code lands.
2. **AWS format isolation (G5).** Only these places may parse or produce the AWS Nitro Enclaves attestation format:
   - `notary-attest::aws`;
   - `notary-attestation/src/aws-nitro-enclaves.ts` (the TypeScript platform-module package, §3.1a);
   - `notary/deploy/`.

   A CI grep check enforces this (§7.4).
3. **Shared types are defined once per language,** and kept identical across languages by shared test vectors in `notary/vectors/`. The TypeScript and Rust implementations don't call each other.
4. **The press is not refactored** (strategic-plan non-goal; CP10). The host copies the patterns it needs from `press/` rather than importing press modules, because `press/` is an application, not a package.
5. **Nothing reaches the chain or AWS without a checkpoint.** Contract changes and on-chain registrations are CP7. AWS resources are CP8. Local `nitro-devnode` deployments in the integration stack are not on-chain actions in that sense.

---

## 2. Layout of `notary/`

```
notary/
  README.md                 what's here; running the local stack           (7.3)
  OPERATOR.md               standing up a notary; sizing; upgrades          (7.3)
  rust-toolchain.toml       pinned stable toolchain + wasm32-unknown-unknown (own pin; not contracts/)
  Cargo.toml                workspace: runtime/*, lint, sim, templates/*
  vectors/                  cross-language test vectors (JSON), see §7.2
  runtime/
    crates/
      notary-types/         objects §20–§34, §2.1/§2.2 sections, JCS, H, CIDs, domain separation
      notary-crypto/        ML-DSA-44, X-Wing draft-06 HPKE, secp256r1, keccak/SHA3, HKDF,
                            ChaCha20-Poly1305, AES-256-GCM; zeroizing, mlocked secret buffers
      notary-attest/        AttestationBackend (§5): NsmBackend, SimulatorBackend;
                            Rust-side verifier modules (aws, sim) + shared V6–V12, for algorithm P
      notary-admission/     algorithm A (A1–A11), the ABI and fuel table constants, lint warnings
      notary-cards/         card-chain verification in Rust: evidence bundles, policy snapshots,
                            predicates with parameter references, revocation, sub-cards (B1–B11)
      notary-messaging/     ADR-007 per-sub-card encryption for notary_output messages
      notary-worker/        wasmi executor, fuel/memory/wall limits, broker–worker framing (§8)
      notary-broker/        everything else in the broker (see §2.1)
    bin/notary-runtime/     one binary, `--mode broker|worker`; seccomp, UIDs, rlimits on Linux
    tests/                  multi-process runtime tests against notary/sim
  lint/                     `notary-lint` CLI over notary-admission (+ LINT_* warnings)
  guest/                    `notary-guest`: no_std ABI bindings, fixed-point maths, small JSON
                            reader/writer for templates (no floats, no alloc surprises)
  templates/
    aggregate/  vote/  derive/   Rust → wasm32; each with policy JSON, README, and tests
  attestation-ts/           @membership-card-protocol/notary-attestation: TS platform modules
                            (aws-nitro-enclaves, simulator) for the AttestationVerifier interface
  sim/                      enclave simulator: test root CA, fake NSM service (attest + clock),
                            enclave launcher (spawns notary-runtime), socket transport
  host/                     nitropack TypeScript service (notary_host.md)
  deploy/
    docker-compose.yml      host + redis + vsock proxy (production shape)
    docker-compose.sim.yml  host + redis + notary-sim (local / CI)
    eif/                    reproducible EIF build recipe (Dockerfile, pinned inputs, PCR0 script)
  scripts/                  governance publication helpers (see §3.6)
```

### 2.1 Inside `notary-broker`

| Module | Implements | Spec |
|---|---|---|
| `host_proto` | vsock/socket framing, message validation, the host→enclave and enclave→host message tables | runtime §9 |
| `keyring` | `K_inst`, `K_id`/`K_chain`, state key, `k_T,p`, `K_job,e`; key lineage and exposure; invariants I1–I3 | runtime §4, §15 |
| `genesis` | genesis request and offer handling, countersigning the notary card | lifecycle Phase 0; objects §20 |
| `jobs` | job checks (step 17), the state machines for aggregate and per-input jobs, epochs, key rotation | runtime §10; lifecycle Phase 2; objects §21–§22 |
| `inputs` | `SealedInput` opening, B1–B11, dedupe by root key, `latest_wins` revisions, receipts | lifecycle Phase 5, Appendix B; objects §23–§26 |
| `chain` | header linkage, `chain_ref` freshness floor, NSM-time reading | runtime §13; replication §5 |
| `snapshots` | policy snapshots and updates, the per-card fetch fallback | host §8; propagation §2 |
| `lists` | governance lists: pins, algorithm L, version floors, no regression | runtime §12; lifecycle A.5; objects §34 |
| `transforms` | output checks, k-suppression, clamping, rounding, buckets | runtime §11 |
| `close` | quorum close, recomputation, cosignatures, notarization, `counted_inputs` | replication §5; lifecycle Phase 6–7; objects §27 |
| `joblog` | job-log and identity-log records, anchor gating; identity-log `seq` 0 `opened` at countersign, jobs gated on its anchor (E26) | objects §28; host §9; lifecycle step 9 |
| `replication` | handoff (algorithm P, P1–P5), upgrades and migration epochs, `input_ack` quorum, heartbeats, re-replication, epochs | replication §2–§7; objects §29–§30 |
| `derive` | `dup_tag`, D1–D4, the two-round offer, the issuance pool, anonymity sets, batched release | propagation §1, §3, §4 |
| `propagation` | `expiry_only`, `sealed_link` links, the watch loop, successor rule, 820/920, timing defenses | propagation §5–§7; objects §32 |
| `state_blob` | encrypted state blob, versioning, handoff-carried version | replication §8; objects §31 |
| `registry` | `RegisterCard` / `BatchUpdateCardHeads` payloads signed with `K_chain`, calldata specified | host §10; registry_contract §6.1 |
| `output` | public outputs, `notary_output` messages, derived-card publication | lifecycle Phase 7; messaging §24 |
| `workers` | spawning, supervising and killing workers | runtime §3, §8 |

`notary-broker` is a library crate. The binary wires it to a transport and an `AttestationBackend`, so the tests in `runtime/tests/` drive the same code as production through the simulator.

### 2.2 The simulator (`notary/sim`)

- **Test root CA.** Issues attestation documents in the AWS Nitro Enclaves format (COSE_Sign1, ES384, CBOR), signed by a test root. PCRs and the debug flag are configurable per enclave.
- **Fake NSM service.** One socket per simulated enclave, with `attest` and a **controllable clock**. Tests can set NSM time apart from chain time, which close tests need (T9).
- **Launcher.** Spawns `notary-runtime` broker processes as "enclaves", each connected to the host by a Unix or TCP socket in place of vsock. It can kill one to simulate loss.
- **Same parser as production.** Documents are parsed by the production verifier modules. The simulator differs only in its root and `platform` (`ATT_PLATFORM_NOT_ALLOWED` unless enabled).

**Where isolation is tested.** Worker isolation (seccomp, UIDs) needs Linux. On macOS the simulator runs workers without seccomp and logs a warning. The isolation tests run in the Linux container used by CI and the integration stack.

### 2.3 Host (`notary/host`)

Built on nitropack, structured like `press/`.

| Path | Implements | Spec |
|---|---|---|
| `server/routes/ohttp/*` | key config and gateway; dispatch only to "oblivious" routes | host §5–§6; oblivious_transport §Notary Host Destination |
| `server/routes/jobs/*`, `genesis/*`, `peer`, `health` | HTTP endpoints | host §5 |
| `src/enclave/` | `EnclaveTransport` (vsock on Linux, socket for the simulator), message codec, per-enclave sessions, re-attestation | host §11; runtime §9 |
| `src/chain/` | header stream, policy snapshots and updates (never filtered), list-card feed, registry submission of enclave-signed payloads unchanged, gas | host §8, §10 |
| `src/eas/` | anchoring job-log records under the notary schema; `anchor_receipt` | host §9 |
| `src/ipfs/` | pinning exact bytes (`raw` codec), adapted from `press/src/ipfs` | host §9 |
| `src/storage/` | Redis keys and retention, including deleting ciphertexts at finalize | host §7 |
| `src/receipts/` | `HostReceipt` signing with `K_host` | objects §25 |
| `src/peer/` | peer relay between hosts | host §11 |
| `src/delivery/` | `notary_output` delivery through message routing | host §12 |
| `src/monitoring/` | alerts (never job data) | host §13 |
| `src/config.ts` | environment variables | host §4 |
| `src/types.ts` | host- and enclave-only objects: handoff, heartbeat, state-blob header, propagation batch (mostly relayed as bytes) | protocol-objects §29–§32 |

---

## 3. Changes outside `notary/`

### 3.1 `membership_card_verifier/packages/verifier`

| Change | Spec |
|---|---|
| A **subpath export `@membership-card-protocol/verifier/notary`** holding everything below. The core entry point imports none of it. Ordinary verifiers that leave `VerifierConfig.notary` unset don't load it, and bundlers drop it. | card_verifier §5 |
| `src/notary/types.ts`, `canonical.ts`: types for what a verifier meets: the §2.1/§2.2 sections, the notary card (§20), notarization and job log (§27–§28), attestation binding (§33) and lists (§34), plus hashing helpers and the `AttestationVerifier` interface | protocol-objects §2.1–§2.2, §20, §27–§28, §33–§34 |
| `src/notary/attest.ts`: the shared V steps (V6–V12) over a platform module's parsed result. **No** platform format parsing here. | runtime §5; lifecycle A.1 |
| `src/notary/lists.ts`: algorithm L | lifecycle A.5; objects §34 |
| `src/notary/genesis.ts`: algorithm G | lifecycle A.3 |
| `src/notary/notarization.ts`: algorithm N and the `verifyNotarization` entry point | lifecycle A.4; card_verifier §6.5 |
| Stage 4 step 5a: `expires_at` | card_verifier §7.4 |
| Stage 5 step 3a: derived-card checks, including `source_kind` | card_verifier §7.5 |
| `VerifierConfig.notary`; new error codes | card_verifier §5, §9 |
| `RpcProvider.getGovernanceKeyset`, plus its implementation in `verifier-rpc-provider` | card_verifier §4.1; registry_contract §5 |

`verifier-py` is not changed in this run (P1).

**Type locations in TypeScript.** Notary types are split by who uses them:
- verifier-facing objects in `verifier/notary`;
- wallet objects (§21–§26) in the wallet SDK;
- host- and enclave-only objects (§29–§32) in `notary/host`.

All three are checked against the same `notary/vectors/`, so there is still one definition per object across TypeScript and Rust.

### 3.1a New package `notary/attestation-ts` → `@membership-card-protocol/notary-attestation`

| Change | Spec |
|---|---|
| V1–V5 platform modules `aws-nitro-enclaves.ts` and `simulator.ts`, implementing the verifier's `AttestationVerifier` interface, with their parsing dependencies (CBOR, COSE, X.509, P-384) | runtime §5; lifecycle A.1 |

- **Who uses it.** Wallets, the notary host, and any verifier that opts into derived cards or notarizations, by passing the modules in `VerifierConfig.notary.attestation`. The spec already defines that injection point, so no spec change is needed.
- **G5.** This is the only TypeScript package that parses the AWS Nitro Enclaves document format.
- **Where it lives.** In `notary/` beside the Rust attestation crate, so both platform implementations sit together for review.

### 3.2 `wallet-sdk/packages/wallet-sdk`

| Change | Spec |
|---|---|
| `src/notary/types.ts`: wallet objects: job, announcement, input and countersign, sealed input, host receipt, validation receipt | protocol-objects §21–§26 |
| `src/notary/config.ts`; depends on `verifier/notary` and `notary-attestation` | wallet_sdk §7b.1 |
| `src/notary/job.ts`: build, sign and pin a `NotaryJob` as requester, and send it to each replica host | lifecycle Phase 2 steps 14–15; objects §21 |
| `src/notary/link.ts`: parse `mcard://notary-job` share links | lifecycle Phase 3 |
| `src/notary/verifyJob.ts`: algorithm W, using the verifier's V and L | §7b.2; lifecycle A.2 |
| `src/notary/consent.ts`: consent model built only from the policy and job; requester text labelled | §7b.3 |
| `src/notary/submit.ts`: input signing by sub-card, X-Wing HPKE inner envelope, oblivious outer envelope, opening the sealed receipt | §7b.4; objects §23–§26 |
| `src/notary/watch.ts`: stored inputs, epoch watching, automatic resubmission | §7b.5; replication §7 |
| `src/notary/inclusion.ts`: inclusion check against `input_commitment` | §7b.6 |
| `src/notary/derived.ts`: `requestDerivedCard`, two-round flow, holder countersign, sealed-link disclosure | §7b.7; propagation §3, §8 |
| `src/messaging/`: receive `notary_output` messages; `"notary_input"` sub-card capability | messaging §24 |
| new dependency `@hpke/hybridkem-x-wing` (draft-06) | E.2 |

### 3.3 `relay/`

Register the notary host as a third destination kind in the oblivious target registry (`relay/src/utils/oblivious_targets.ts`; the path was corrected from `oblivious-targets.ts`, erratum E4), and add tests. *(oblivious_transport §Notary Host Destination)*

### 3.4 `contracts/` — **CP7**

- **Write-gate step 8.** Every signed field must equal the calldata, with error E-49 `PAYLOAD_CALLDATA_MISMATCH`. This touches the logic contract and the verifier module, with Rust unit tests and a devnode test. *(registry_contract §6.1)*
- **No other contract changes.** Notary authorization uses the existing `AuthorizePress`, and list checks use the existing `GetGovernanceKeyset` read.

The code is written only after David approves it at CP7. Deploying it to Sepolia or mainnet is a separate CP7 approval.

### 3.5 `integration_tests/`

- **New compose services:**
  - `notary-sim`;
  - three `notary-host` replicas, each with its own Redis;
  - EAS contracts (SchemaRegistry and EAS) deployed to `nitro-devnode` by the `deploy-contracts` step, plus the notary schema;
  - the governance list cards and template policies, published by the bootstrap scripts.
- **`suites/notary/`:** one spec file per acceptance criterion (§8.2), plus `adversarial/` for step 7.2.
- **`run.sh`:** adds `cargo test` for `notary/`, and the AWS-format isolation check (§7.4).

### 3.6 `governance/` scripts

Each one is run only with David's approval (CP7):
- `notary-lists.ts`: build a list version, collect member signatures (`list_approval`), and publish. It supports `standard` and `emergency_retirement`, and checks rule E before asking for signatures.
- `notary-policies.ts`: build `NotaryCardPolicy`, the list-card policy and the three template policies for `RegisterPolicy`, and `AuthorizePress` payloads per (template, operator).
- `eas-schema.ts`: register the notary job-log schema.

In the integration stack the same scripts run against `nitro-devnode` with test member keys.

---

## 4. Build order

The order follows the implementation plan's steps, with the proposed amendments in §9. Within a step, items run top to bottom.

| Step | Builds | Depends on | Exit test |
|---|---|---|---|
| **5.1** Objects and serialization | `notary-types`; TypeScript types in `verifier/notary`, wallet SDK and host (§3.1); `notary/vectors/` (objects, JCS, hashes, `user_data` layout); **X-Wing interop vectors** (runtime §17, checkpoint 1) | — | TS and Rust give identical bytes for every vector; X-Wing JS↔Rust both directions (else **CP9**) |
| **5.2** Attestation | `notary-attest` (backends, Rust verifier modules); `notary/sim`; `notary-attestation` (TS platform modules) and V in `verifier/notary` | 5.1 | Simulator documents verify in TS and Rust with the same parser path; each `ATT_*` code has a failing fixture |
| **5.3** Runtime core *(Opus)* | `notary-crypto`, `notary-admission`, `notary-worker`, the core `notary-broker` modules (`host_proto`, `keyring`, `jobs`, `inputs`, `chain`, `lists`, `transforms`, `close` for a single replica, `joblog`, `workers`), `bin/notary-runtime`, `notary/lint`, `notary-guest`; wasmi checkpoint (runtime §17, checkpoint 4) | 5.1–5.2 | Every `ADM_*` reject; I1–I3; isolation between jobs; leaky program bounded; L verified; wasmi fuel determinism (else **CP9**) |
| **5.3a** Card checks in Rust *(Opus; approved)* | `notary-cards`; the vector generator and CI regeneration check (§7.5) | 5.1 | Agrees with every TypeScript-generated vector; coverage map complete (§7.5) |
| **5.4** Wallet and verifier | §3.1 and §3.2 (W, consent, submit, inclusion, G, N, L, `verifyNotarization`); `verifier-rpc-provider` | 5.1–5.2 | One test per G2 rejection; consent text test |
| **5.5** Host | `notary/host`; `deploy/docker-compose.sim.yml`; relay registration (§3.3) | 5.3–5.4 | The end-to-end path runs in compose against the simulator |
| **5.6** Capacity benchmark | `notary/runtime/benches/` | 5.3 | Numbers recorded here; limits errata if needed |
| **6.1** Aggregation | `templates/aggregate`, input commitment, receipt inclusion | 5.x | k-suppression test; independent `verifyNotarization` |
| **6.2** Vote and long-running jobs | `templates/vote`, `latest_wins`, close by chain and NSM time, epochs and resubmission (single replica) | 6.1 | Ballot replacement; close before and after `closes_at`; epoch restart |
| **6.3** Replication *(Opus)* | `replication`, multi-replica `close`, peer relay in the host | 6.2 | Kill one replica with no loss; re-replication; each refused handoff; handoffs logged |
| **6.4a** Write gate *(proposed, §9; CP7)* | §3.4 | CP7 approval | E-49 contract tests; devnode test |
| **6.4** Derived cards | `templates/derive`, `derive`, `registry`, the `source_kind` refusal, issuance pool | 6.3, 6.4a, 5.3a | Standard verification passes; `DERIVE_DUPLICATE`; anonymity-set refusal |
| **6.5** Propagation *(Opus)* | `propagation`, `state_blob`, snapshots and the watch loop, wallet disclosure | 6.4 | Revocation within the window; rolled-back blob refused; `expiry_only` lapse |
| **7.1** Integration suite | `integration_tests/suites/notary/`, compose services, governance scripts against the devnode | 6.x | One passing test per acceptance criterion |
| **7.2** Adversarial suite | `suites/notary/adversarial/` | 7.1 | Each attack refused or detected |
| **7.3** Docs | `notary/README.md`, `OPERATOR.md` | 7.1 | Followed from a clean checkout |

---

## 5. Dependencies to choose at 5.0

These are the expected choices, confirmed at 5.0 (CP5). An unworkable one is a CP9 stop.

| Need | Rust | TypeScript |
|---|---|---|
| X-Wing draft-06 HPKE | `hpke` 0.15.1 (`mlkem`), `x-wing` 0.1.1 (**not** `rxwing`) | `hpke-js` 1.8 + `@hpke/hybridkem-x-wing` 0.7.1 |
| ML-DSA-44 | `ml-dsa` (RustCrypto) | `@noble/post-quantum` (existing) |
| secp256r1 | `p256` | `@noble/curves` (existing) |
| COSE / CBOR / X.509 (attestation; TS side only in `notary-attestation`) | `coset`, `ciborium`, `x509-cert` + `p384` | `cbor-x` (or a minimal decoder) + `@peculiar/x509` or a hand-rolled chain check with `@noble/curves` p384 |
| JCS (RFC 8785) | hand implementation, checked against `specs/serialization-conformance.json` | existing `canonicalize.ts` |
| WASM | `wasmi` (pinned exact version), `wasmparser` for admission | — |
| Isolation | `seccompiler`, `nix` | — |
| Secrets | `zeroize`, `memsec` (mlock) | — |
| NSM | `aws-nitro-enclaves-nsm-api` (only in `notary-attest::aws`) | — |
| vsock | `tokio-vsock` (Linux) | `node:net` over the vsock proxy |

---

## 6. Risks that shape the order

1. **Card verification in Rust (`notary-cards`).** This is the largest single piece. It re-implements in Rust the parts of the verifier's Stages 2–5 that B1–B11 need:
   - signatures and sub-card chains;
   - ancestry walks;
   - policy predicates with parameter references;
   - revocation from snapshots;
   - ADR-006 content decryption.

   A mismatch with the TypeScript verifier would make the enclave accept a card a verifier rejects, or the reverse. The mitigations are vectors generated by the TypeScript verifier and regenerated in CI, a coverage map, differential fuzzing, and an early start in step 5.3a (§7.5).
2. **X-Wing interop** (CP9 checkpoint 1). This is tested first, in 5.1, before anything depends on it.
3. **wasmi determinism** (CP9 checkpoint 4). This is tested in 5.3, before the templates are written.
4. **NSM limits and NSM time** (CP9 checkpoints 2–3). These can only be confirmed in Phase 8. The simulator models the documented limits, and the close logic is written so that a failure of T9 is a configuration stop, not a redesign.
5. **EAS on the devnode.** If the EAS contracts don't deploy on `nitro-devnode`, the job log falls back to a local mock anchor in the integration stack only, recorded as a test-environment deviation. Production anchoring is unaffected.

---

## 7. Test strategy

### 7.1 By package

| Package | Kind | Notes |
|---|---|---|
| `notary-types` | unit + vectors | Round-trip and canonical bytes for every object |
| `notary-crypto` | unit + vectors + `proptest` | KATs from FIPS 204 and the X-Wing draft; zeroization tests on drop |
| `notary-attest` | unit + fixtures | One fixture per `ATT_*`; real AWS sample documents (public, recorded) for the parser path |
| `notary-admission` / `lint` | unit, one fixture `.wasm` per A1–A11 reject and per lint warning | Fixtures built from `.wat` in the repository |
| `notary-cards` | conformance vectors + unit | Every vector produces the same verdict and code as the TypeScript verifier |
| `notary-worker` | unit + Linux-only isolation tests | Fuel exhaustion, memory, wall clock, `output_twice`, a seccomp violation kills the worker |
| `notary-broker` | unit per module + `runtime/tests/` multi-process against the simulator | Uses the simulator's clock for close and rotation tests |
| `templates/*` | unit (native) + wasm run under `notary-worker` | Fixed-point outputs; schema section matches the policy |
| `verifier/notary` | vitest, fixtures from the simulator | Every reject code in V6–V12, G, N and L; a test that the core entry point doesn't import `verifier/notary` |
| `notary-attestation` | vitest, simulator fixtures + recorded public AWS sample documents | Every V1–V5 code |
| wallet-sdk `src/notary` | vitest with a mocked host and a real simulator attestation | G2 rejections; consent; resubmission |
| `notary/host` | vitest with a mock enclave | Routes, never-filter snapshots, storage retention, direct-route refusal |
| `contracts` (6.4a) | Rust unit + devnode | E-49 |
| `integration_tests/suites/notary` | end to end on compose | §8.2 |

### 7.2 Shared vectors (`notary/vectors/`)

- **`objects/`:** each §20–§34 object in canonical bytes, plus its hash.
- **`user_data/`:** 181-byte layouts for purposes 0x01–0x04.
- **`xwing/`:** fixed seeds → `enc`, `ct`, exported secret (generated in both directions).
- **`cards/`:** card chains, sub-cards, revocations and predicates, generated by a script that runs the TypeScript verifier and records its verdict and code. `notary-cards` must agree with every one.
- **`lists/`:** list versions with approvals, covering each L reject code and rule E.
- **`dup_tag/`:** HMAC inputs and outputs.

### 7.3 Determinism

Close recomputation is tested by running the same close on three simulated replicas and comparing bytes. The templates and a randomized program corpus are both run under two builds of the runtime.

### 7.4 Static checks in CI

- **AWS format isolation:** grep for `cabundle`, `nsm`, `COSE_Sign1` and the AWS root fingerprint outside the allowed paths. Any hit fails (G5).
- **Terminology:** no bare "Nitro" in new docs under `notary/`.
- **No float instructions** in built templates (`notary-lint` on every template).
- **Reproducible template builds:** two builds compared by hash.

---

### 7.5 Keeping `notary-cards` in step with the TypeScript verifier

*Decided by David, 2026-11-12: a Rust port, kept in step by these mechanisms.*

**Scope of the port.** Only the parts of the verifier that B1–B11 call:

| Ported | Verifier stage |
|---|---|
| ML-DSA-44 signatures on card documents and log entries; the `prev_log_root` chain | 3–4 |
| Ancestry walk to a trusted root; ADR-006 content decryption | 3 |
| Signing sub-card checks: `notary_input` capability, `valid_until`, holder binding, `active_subcards`, app-card chain | 2 |
| Revocation and press authorization, read from policy snapshots | 4–5 |
| Predicates, including parameter references; `expires_at` | 5 |

Not ported: EAS annotations, non-compliance reporting, login and DNS.

**Mechanisms:**
1. **The TypeScript verifier generates the expected answers.** `membership_card_verifier/scripts/gen-notary-conformance.ts` builds fixtures: valid chains, plus one mutation per check. It runs the TypeScript verifier on each and writes the bytes, verdict and code to `notary/vectors/cards/`. `notary-cards` must agree on every vector. A committed table maps verifier codes to B-step codes.
2. **CI regeneration.** CI reruns the generator and fails if the output differs from the committed vectors. So a verifier change that alters any verdict can't merge without new vectors, and the new vectors then fail the Rust tests until the port is updated.
3. **Coverage map.** `notary/vectors/cards/coverage.json` lists each ported check with its valid and invalid vector IDs. CI fails if a ported check lacks either.
4. **Differential fuzzing.** A nightly job mutates valid fixtures (`proptest` on the Rust side, the TypeScript verifier in a Node subprocess) and reports any disagreement as a bug. It isn't gating, but every disagreement found becomes a new committed vector.
5. **Spec discipline.** Changes to `card_validation.md` or `card_verifier.md` Stages 2–5 state in their changelog whether they affect `notary-cards`.

**Rule changes and runtime images:**
- **Vector-set hash.** Each runtime image records the hash of the vector set it passed, in its build metadata and in the runtime's accepted-list entry notes. Governance can then see which rule set each accepted runtime implements.
- **Security changes** *(corrected 2026-11-12)*. A security-relevant tightening of the verifier needs a new runtime image, with a new `close_compat` because the vector set changes. How the old runtime is retired depends on the flaw:
  - **Eligibility flaws** that didn't expose keys or inputs use the **expedited supersede** (72 hours' notice). Keys are handed on and jobs move by migration epoch.
  - **Emergency retirement** is only for flaws that could expose keys or inputs, because it makes every key that lived in the runtime unusable (algorithm E).

  This goes into `notary/OPERATOR.md` and the governance runbook in step 7.3.

## 8. Traceability

### 8.1 Spec requirements → module → test

| Requirement (spec) | Module(s) | Test(s) |
|---|---|---|
| Policy authoring with `notary-lint` (lifecycle Phase 1) | `notary/lint` | lint fixtures, including `LINT_*` warnings |
| Job requesting and share links (lifecycle Phase 2 steps 14–15, Phase 3) | wallet `job.ts`, `link.ts` | job signed and accepted by three hosts; link round trip |
| Notary policy section, parameter references (objects §2.1; spec §9 P0) | `notary-types`; `verifier/notary` types; `notary-cards` predicates; wallet `consent.ts` | vectors `objects/`; `notary-cards` predicate vectors; wallet `JOB_PARAMETERS_OUT_OF_BOUNDS` |
| Template policies, `source_kind` (objects §2.2) | `notary-types`; broker `derive`; verifier Stage 5 step 3a | `ADM_FEATURE_UNSUPPORTED`; verifier `NOTARY_DERIVED_SHAPE` for `web_evidence` |
| `expires_at` (objects §1) | verifier Stage 4 step 5a | verifier unit: expired card rejected |
| Notary card and genesis (objects §20; lifecycle Phase 0; G) | broker `genesis`; verifier `genesis.ts`; host `/genesis` | genesis round trip in `runtime/tests`; G rejects `NOT_GENESIS_MISMATCH`, `NOT_OPERATOR_INVALID` |
| Job and announcement (objects §21–§22; Phase 2) | broker `jobs`; host `/jobs` | `job_keyed` / `job_rejected`; announcement re-attestation |
| Inputs, sealed input, receipts (objects §23–§26; Phase 5) | wallet `submit.ts`; broker `inputs`; host `receipts` | sealed receipt unreadable by host; `INPUT_*` per B-step |
| B1–B11 (lifecycle App. B) | broker `inputs` + `notary-cards` | one test per B-step reject |
| Dedupe by root key; `latest_wins` | broker `inputs` | key rotation isn't a second contributor; `REVISION_CONFLICT` |
| Algorithm A, ABI, fuel table (runtime §6–§7) | `notary-admission`, `notary-worker` | one `.wasm` per A1–A11; fuel determinism |
| Image and measurement, reproducible build (runtime §2) | `deploy/eif` | two builds, same PCR0 (Phase 8; a local `docker build` reproducibility check in 7.1) |
| Limits and ceilings (runtime §14) | `notary-admission` (A10), `notary-worker`, broker `inputs` (size) | each ceiling exceeded once: fuel, wall, memory, `max_inputs`, `SealedInput` size |
| Broker/worker isolation (runtime §3) | `bin/notary-runtime`, `notary-worker`, broker `workers` | Linux isolation tests; cross-job isolation test |
| Keys and invariants I1–I3; zeroization (runtime §4, §15) | `keyring`, `notary-crypto` | host-supplied key refused; drop-zeroize tests |
| Attestation backends and V (runtime §5; A.1) | `notary-attest`; `notary-attestation`; `verifier/notary` `attest.ts` | every `ATT_*` fixture, in TS and Rust |
| W (A.2; wallet §7b.2) | wallet `verifyJob.ts` | one test per W step code |
| N and `verifyNotarization` (A.4; card_verifier §6.5) | verifier `notarization.ts` | one test per `NOT_*`; job-log gap and fork warnings |
| L and governance lists (A.5; objects §34; runtime §12) | broker `lists`; verifier `lists.ts`; `governance/scripts/notary-lists.ts` | vectors `lists/`: each `LIST_APPROVAL_*`, rule E, keyset rotation fail-closed, `LIST_VERSION_REGRESSION` |
| Output checks and transforms (runtime §11) | broker `transforms` | leaky program bounded; k-suppression; `OUTPUT_SCHEMA_VIOLATION` |
| Chain data and freshness floor (runtime §13) | broker `chain` | stale chain state refused below a wallet's `chain_ref` |
| Notarization, `counted_inputs`, inclusion (objects §27; wallet §7b.6) | broker `close`; wallet `inclusion.ts` | inclusion proof from a receipt |
| Job log and EAS anchoring (objects §28; host §9) | broker `joblog`; host `eas` | no next record before `anchor_receipt`; every handoff logged |
| Replica set, handoff, P1–P5 (replication §2–§3; objects §29) | broker `replication`; host `peer` | refused handoff per P-check; `HANDOFF_*`, including `HANDOFF_COMPAT_MISMATCH` and `HANDOFF_KEY_EXPOSED` |
| Runtime upgrades: rolling handoff, `runtime_migration` epochs (replication §3, §7; objects §34 `close_compat`) | broker `replication`, `jobs`; `notary/sim` (two runtime builds with different PCR0s) | rolling upgrade of a live vote with no lost ballots; incompatible upgrade by migration epoch with wallet resubmission |
| Key lineage and exposure: algorithm E, key re-keying, template re-seed (lifecycle A.6; runtime §4; propagation §1) | broker `keyring`, `lists`, `derive`; verifier `verifier/notary` E; wallet W step 10a | emergency retirement in the simulator: notary card dead, `key_exposure` epoch, template generation `g + 1`, verifier `NOTARY_KEY_EXPOSED` after `retired_at` and a warning before it; `NOTARY_LINEAGE_INCOMPLETE` |
| Quorum acknowledgment (replication §4) | broker `replication`, `inputs` | no validation receipt before q acks |
| Close by chain and NSM time, cosigning quorum (replication §5) | broker `close`, `chain` | NSM clock behind chain: no close; header ahead: no close |
| Heartbeats, re-replication (replication §6; objects §30) | broker `replication`; host enclave manager | kill one, return to `min_live` |
| Epochs, total loss, resubmission (replication §7) | broker `jobs`; wallet `watch.ts` | kill all; resubmit; latest ballot wins |
| State blob (replication §8; objects §31) | broker `state_blob`; host storage | rolled-back blob refused |
| `dup_tag`, periods, renewal (propagation §1) | broker `derive`, `keyring` (`k_T,p`) | vectors `dup_tag/`; same source → same tag across operators |
| Evidence bundles and never-filtered snapshots (propagation §2; host §8) | broker `snapshots`; host `chain` | host test: snapshot includes all cards; per-card fetch only in the fallback |
| Issuance flow D1–D4, holder countersign (propagation §3) | broker `derive`; wallet `derived.ts` | each `DERIVE_*` |
| Anonymity set and batches (propagation §4) | broker `derive` | refusal below `min_anonymity_set` |
| `expiry_only`, `sealed_link`, 820/920, timing (propagation §5–§7; update_codes) | broker `propagation`; objects §32 | revocation within `min_delay + batch_window`; code mapping; successor follow |
| Wallet disclosures (propagation §8) | wallet `derived.ts`, `consent.ts` | disclosure text present for `sealed_link` |
| No `PressIssuanceRecord` for derived cards (objects §11) | broker `derive`, `output` | none sent |
| Registry writes with calldata (host §10; registry §6.1 step 8) | broker `registry`; host `chain`; `contracts` | E-49 contract test; host submits unchanged |
| `notary_output` messages (messaging §24) | `notary-messaging`; broker `output`; host `delivery`; wallet `messaging` | private output readable only by listed recipients |
| Oblivious notary destination (oblivious_transport) | host gateway; `relay/` | direct route refused (`NH_DIRECT_FORBIDDEN`) |
| Host configuration, storage retention, monitoring (host §4, §7, §13) | host `config`, `storage`, `monitoring` | ciphertexts deleted at finalize; alerts carry no job data |
| Governance holdings and registrations (notary_certification) | `governance/scripts/*` | devnode bootstrap in the integration stack |
| Threat model T1–T10, L1–L10; colluding operators (lifecycle §Threat Model; replication §9) | all broker modules | `suites/notary/adversarial/` (step 7.2), one test per attack listed there |
| Error codes (all notary tables) | every module above | code-coverage script: every code in the specs is raised by at least one test |

### 8.2 Acceptance criteria → integration test (`integration_tests/suites/notary/`)

| Criterion (spec §9) | Test file |
|---|---|
| G1 aggregation, `k_min` | `aggregation.spec.ts` |
| G1 vote, close by chain and enclave time | `vote.spec.ts` |
| G1 derived card, unlinkable from host records | `derived_card.spec.ts` |
| G1 `sealed_link` and `expiry_only` | `propagation.spec.ts` |
| G1 real hardware | Phase 8 (deferred) |
| G2 wallet rejections | `wallet_rejections.spec.ts` (+ wallet-sdk unit tests) |
| G2 inclusion | `inclusion.spec.ts` |
| G2 consent from policy only | `consent.spec.ts` |
| G2 non-compliant programs | `admission.spec.ts` (+ admission unit tests) |
| G2 leaky program bounded | `privacy_bounds.spec.ts` |
| G3 templates, no-code activation | `templates.spec.ts` |
| G3 operator stands up a notary in under an hour | step 7.3 clean-checkout walkthrough (manual, timed) |
| G4 kill one replica | `replication.spec.ts` |
| G4 kill all, resubmission | `total_loss.spec.ts` |
| G4 handoffs logged, receipts | `job_log.spec.ts` |
| G5 specs reviewed first | done (CP3) |
| G5 integration tests pass (sim; AWS later) | the suite itself; Phase 8 for AWS |
| G5 AWS format isolation | CI check (§7.4) |

### 8.3 Landed modules and tests (kept current as code lands)

| Step | Spec | Module | Tests (command, result at landing) |
|---|---|---|---|
| 5.1 | Conventions, §20–§34 object shapes, JCS, `H`, CIDs | `notary/runtime/crates/notary-types/src/{jcs,objects,formats,b64u}.rs`; `membership_card_verifier/packages/verifier/src/notary/{canonical,types}.ts` | `cargo test -p notary-types` (6 vector tests); `pnpm test` in `notary/vectors-tools` (20 tests); verifier `test/notary/canonical.test.ts` |
| 5.1 | §27 `input_commitment` (incl. empty list, E1) | `notary-types/src/merkle.rs`; `canonical.ts: inputCommitment` | `vectors/objects/merkle.json`, both sides |
| 5.1 | §33 `user_data` layout | `notary-types/src/user_data.rs`; `canonical.ts: encodeUserData/decodeUserData` | `vectors/user_data/layouts.json`, both sides |
| 5.1 | §21–§26 wallet objects | `wallet-sdk/packages/wallet-sdk/src/notary/{types,notary-types}.ts` | wallet `test/notary/types.test.ts` (incl. subpath import-graph check) |
| 5.1 | §29–§32 host/enclave objects | `notary/host/src/types.ts` | `pnpm test` in `notary/host` |
| 5.1 | X-Wing draft-06 interop (runtime §17.1) | `notary/vectors-tools/src/hpke.ts`; `notary-crypto/tests/xwing_interop.rs` | `cargo test -p notary-crypto --test xwing_interop`; vectors-tools `test/xwing.test.ts` |
| 5.1 | ML-DSA-44 interop | `notary-crypto/tests/mldsa_interop.rs` | `cargo test -p notary-crypto --test mldsa_interop`; vectors-tools `test/vectors.test.ts` |
| 5.2 | Algorithm V1–V5, AWS format (Rust) | `notary/runtime/crates/notary-attest/src/aws.rs` (verifier, test PKI builder, `NsmBackend` behind feature `nsm`, untested until Phase 8) | `cargo test -p notary-attest` (`tests/att_codes.rs`: 49 cases, all 13 `ATT_*` codes; `aws::root_tests`) |
| 5.2 | Algorithm V6–V12, platform gate (Rust) | `notary-attest/src/verify.rs` | same 49 cases |
| 5.2 | V1–V5, AWS format (TypeScript) | `notary/attestation-ts/src/{aws-nitro-enclaves,simulator,cbor}.ts` | `pnpm test` in `notary/attestation-ts` (52 tests: the same 49 Rust-built documents judged identically; root fingerprint; strict CBOR) |
| 5.2 | V6–V12, platform gate (TypeScript) | `membership_card_verifier/packages/verifier/src/notary/attest.ts` | exercised by the same 49 cases |
| 5.2 | Simulator: test root CA, fake enclave service, `SimulatorBackend`, controllable attested clock | `notary/sim/src/lib.rs`; `notary-attest/src/sim.rs` | `cargo test -p notary-sim` (3 tests) |
| 5.2 | AWS root certificate (pinned) | `notary/deploy/aws/AWS_NitroEnclaves_Root-G1.der` + README | fingerprint tests in Rust and TypeScript |
| 5.2 | G5 isolation + terminology check | `notary/scripts/check-aws-isolation.sh` | run it; a planted `cabundle` probe fails it |
| 5.4 | Algorithm W (W1–W15), wallet | `wallet-sdk/packages/wallet-sdk/src/notary/{verifyJob,parameters,config}.ts` | wallet `test/notary/verifyJob.test.ts`: 32 tests with real simulator attestations; the six G2 rejections, every W step |
| 5.4 | Consent model (§7b.3), built from policy and job only | `wallet-sdk/.../src/notary/consent.ts` | `verifyJob.test.ts` "consent model" (requester text labelled; custom-program label; participation and derived-card disclosures) |
| 5.4 | Inclusion check and Merkle paths (§7b.6) | `wallet-sdk/.../src/notary/inclusion.ts` | wallet `test/notary/inclusion.test.ts` (5 tests) |
| 5.4 | Stage 5 step 3a: notary-issued (derived) cards (G for later verifiers via `genesis_request`, shape, E, `source_kind`) | `verifier/src/notary/derived.ts`; Stage 5 hook in `verifier/src/stages/stage5.ts` | `notary/attestation-ts/test/derived.test.ts` (10 tests, real genesis attestations); verifier `test/stages/stage5.test.ts` (4 hook tests). Wiring into `CardVerifier` is Phase 7 |
| 5.5 (partial) | Host service on nitropack: config, KV and storage keys/retention, host receipts, job intake, announcement/status, input ingress with receipts, enclave protocol (framing, socket transport, session), enclave-request dispatcher (publish/pin exact bytes, anchor, chain submit unchanged, deliver, peer relay, need_replica, alerts, fetch), never-filtered snapshots, monitoring, operator routes, peer relay, OHTTP gateway and router | `notary/host/src/**`, `notary/host/server/**` | `pnpm test` in `notary/host` (69 tests against a **mock enclave**: `src/enclave/mock.ts`); `pnpm run typecheck:server` (route files); the built server answers over real HTTP (direct routes 403 `NH_DIRECT_FORBIDDEN`) |
| 5.5 | Relay registration of the notary host as a third destination kind | `relay/src/utils/oblivious_targets.ts` (`kind`) | `relay/tests/unit/oblivious-targets.test.ts` (3 tests) |
| 5.5 | Deploy files (not run) | `notary/deploy/{docker-compose.yml,docker-compose.sim.yml,Dockerfile.host,eif/,README.md}` | none: need the runtime (5.3) and AWS (CP8) |
| 5.4 | Algorithm E, key exposure | `verifier/src/notary/exposure.ts` | verifier `test/notary/exposure.test.ts` (15 tests; since batch 2, `seq` 0 must be the `opened` record naming the genesis attestation (E26): gap, fork, prev link, signatures, wrong card, malformed `pcr0_to`, earliest vulnerable retirement, boundary at `t_x`) |
| 5.4 | Stage 4 step 5a (`expires_at`); `RevocationStatus.reason` | `verifier/src/stages/stage4.ts`, `types.ts` | verifier `test/stages/stage4.test.ts` (6 new tests; erratum E15 for the future-expiry reading) |
| 5.4 | `VerifierConfig.notary`; optional `RpcProvider.getGovernanceKeyset` / `getNotaryLogAnchors`; `NOTARY_CODES` | `verifier/src/types.ts`, `CardVerifier.ts`, `notary/types.ts` | compile-checked; exercised by the RPC provider tests |
| 5.4 | `getGovernanceKeyset`, `getNotaryLogAnchors` (EAS client-side filtering) | `verifier-rpc-provider/src/{index,notaryAnchors}.ts` | `verifier-rpc-provider/test/notary.test.ts` (8 tests with mock contract and mock EAS reader; real chain in Phase 7) |
| 5.4 | Core entry point never imports `./notary` | `verifier/package.json` `exports["./notary"]` | verifier `test/notary/isolation.test.ts` (3 tests; a planted import makes it fail) |
| 5.4 | Share links, job requesting, watching and resubmission | `wallet-sdk/.../src/notary/{link,job,watch}.ts` | wallet `test/notary/linkJobWatch.test.ts` (15 tests) |
| 5.4 | Algorithm L, governance list approval, rule E | `membership_card_verifier/packages/verifier/src/notary/lists.ts` | verifier `test/notary/lists.test.ts` (11 tests: every `LIST_APPROVAL_*` code, rule E cases, ECDSA and ML-DSA keysets, keyset-rotation fail-closed). Rust broker side (`lists`) is step 5.3 |
| 5.4 | Sealing, `receipt_sealed`, receipt checks, `submitNotaryInput` (persist before send) | `wallet-sdk/.../src/notary/submit.ts` | wallet `test/notary/submit.test.ts` (12 tests; info/aad equal the X-Wing interop vectors) |
| 5.4 | Algorithm N, `verifyNotarization`, output validation | `membership_card_verifier/packages/verifier/src/notary/notarization.ts` | `notary/attestation-ts/test/notarization.test.ts` (20 tests with real simulator attestations: every `NOT_*` code, ATT codes at N6, key-exposure and anchor-time handling, log-gap/fork/total-loss warnings; E6 cosignature form) |
| 5.4 | Algorithm G, genesis attestation | `verifier/src/notary/genesis.ts` | `notary/attestation-ts/test/genesis.test.ts` (9 tests) |
| 5.4 | Notarization and genesis attestation fixtures | `notary/sim/tests/{notarization,genesis}_fixtures.rs` | used by the two test files above |
| 5.4 | Job attestation fixtures | `notary/sim/tests/job_fixtures.rs` → `notary/vectors/attestation/job_attestations.json` | used by `verifyJob.test.ts` |

| 5.3 | CP9 checkpoint 4: wasmi suitability (§6 rejections, fuel determinism, frozen table) | `notary/runtime/crates/notary-worker/src/lib.rs` (`engine_config`, `frozen_operator_cost`, `FROZEN_DYNAMIC_COSTS`) | `cargo test -p notary-worker --test cp9` (7 tests); identical in debug, release, `--features portable-dispatch`, Linux aarch64 and x86_64 containers; `vectors/fuel/corpus.json` |
| 5.3 | Program ABI `notary_v1` (§7), run limits (§14), fresh instance per run (§3) | `notary-worker/src/lib.rs` (`Program`, `RunLimits`, `RunError`) | `tests/cp9.rs` `abi_*`, `every_run_gets_a_fresh_instance` |
| 5.3 | Broker–worker protocol (§8) | `notary-worker/src/protocol.rs`; `notary/runtime/bin/notary-runtime/src/process_workers.rs` | `cargo test -p notary-runtime --test worker_process` (1 test on macOS; 2 on Linux) |
| 5.3 | Worker isolation (§3): own UID, rlimits, seccomp exactly the §3 list | `notary-runtime/src/sandbox.rs` | `worker_process.rs::a_running_worker_is_sandboxed` (Linux aarch64 container: passes; x86_64 needs a native run, E27) |
| 5.3 | Algorithm A (A1–A11), deferred-feature refusals, lint warnings (§6) | `notary/runtime/crates/notary-admission/src/lib.rs`; `notary/lint/src/main.rs` (`notary-lint`) | `cargo test -p notary-admission` (14 tests: every `ADM_*` code, `ADM_DP_UNSUPPORTED`, `ADM_FEATURE_UNSUPPORTED`, both `LINT_*`) |
| 5.3 | Crypto wrappers, secrets mlocked and zeroized (§4, §15) | `notary-crypto/src/lib.rs` (`SecretBytes`, `MlDsaKey`, `XWingKey`, `ChainKey`, receipts, hashes, HKDF) | `cargo test -p notary-crypto --test wrappers` (6 tests: noble and wallet vectors, receipt sealing, ECDSA digests, known answers) |
| 5.3 | Keyring, invariants I1–I3, admission-gated job keys, key lineage (§4) | `notary-broker/src/keyring.rs` | `cargo test -p notary-broker --test keyring` (4 tests) |
| 5.3 | Algorithm L and governance lists in the runtime (§12, A.5) | `notary-broker/src/lists.rs` | `cargo test -p notary-broker --test lists` (writes and judges `vectors/lists/cases.json`, 14 cases); TypeScript agrees: `pnpm test` in `notary/vectors-tools` (`test/lists.test.ts`, 15 tests) |
| 5.3 | Output checks and privacy transforms (§11), leaky program | `notary-broker/src/transforms.rs` | `cargo test -p notary-broker --test transforms` (5 tests incl. `a_deliberately_leaky_program_cannot_exceed_the_privacy_bounds`) |
| 5.3 | Host–enclave protocol (§9), genesis and countersign (Phase 0, G2), job checks + admission + attestation + anchor-gated announcement (Phase 2), B1–B4 and B9–B11 with sealed receipts (Phase 5), close by chain AND attested time with the notarization (Phase 6–7, single replica), job log (§28), key erasure, abort | `notary-broker/src/{host_proto,jobs,inputs,close,joblog,chain,params,env}.rs` | `cargo test -p notary-broker --test broker` (8 tests under the simulator; B5–B8 through a test `CardOracle` until 5.3a) |
| 5.3 | Runtime binary (`--mode broker|worker`) | `notary/runtime/bin/notary-runtime/src/{main,host_conn,process_workers,sandbox}.rs` | builds; worker mode tested above; broker mode uses a fail-closed card oracle until 5.3a and is exercised end to end in 5.5 |
| 5.3 | Guest library for templates (§7) | `notary/guest/src/lib.rs` (`notary-guest`) | `cargo test -p notary-guest` (3 tests); builds for `wasm32-unknown-unknown` |

| 5.3a | Predicate system with parameter references (E28), TypeScript reference | `membership_card_verifier/packages/verifier/src/notary/predicates.ts` | exercised by the 58 conformance cases (generator runs it) |
| 5.3a | B5–B8 reference over a card world (real Stage 2/3/4) | `verifier/src/notary/contributor.ts` (`checkContributor`, `CardWorld`) | generator; verifier `pnpm test` 252 passed |
| 5.3a | §7.5 mechanism 1: vectors generated by the TypeScript verifier | `verifier/scripts/gen-notary-conformance.ts` → `notary/vectors/cards/{cases,coverage}.json` | `pnpm check:notary-conformance` (58 cases, 35 checks; deterministic) |
| 5.3a | Rust port: Stage 2 (sub-card), Stage 3 (pinned roots, E29), Stage 4 (revocation, `expires_at`, history), predicates, B5–B8, root key | `notary/runtime/crates/notary-cards/src/{stages,predicates,contributor,support,world}.rs` | `cargo test -p notary-cards --test conformance` (agrees on all 58 cases; coverage complete). A planted predicate bug gives 2 disagreements. |
| 5.3a | §7.5 mechanisms 2–3: CI regeneration and coverage | `notary/scripts/check-card-vectors.sh`; `integration_tests/run.sh` notary steps | a planted stale vector fails the check (exit 1); clean tree passes |
| 5.3a | Enclave card oracle: evidence, whole-policy snapshots, per-card fallback, CID checks | `notary-broker/src/cards_oracle.rs` (`SnapshotOracle`, `CardPins`); used by `notary-runtime` | `cargo test -p notary-broker --test cards_oracle` (all 58 cases via snapshots, via fetches and via evidence; forged evidence refused) |
| 5.3a | Snapshot fields Stage 2/4 need (E30) | `notary/host/src/chain/snapshots.ts` | host `pnpm test` 69 passed |

| E31 | Algorithm R (lifecycle A.7): policy at `policy_state_cid`, requester; TypeScript reference | `verifier/src/notary/policy.ts` (`readPolicy`, `requesterAllowed`) | generator writes `notary/vectors/cards/policy_cases.json` (21 cases) |
| E31 | Algorithm R, Rust | `notary-cards/src/policy.rs`; `SnapshotOracle::{policy, requester_allowed}` | `cargo test -p notary-cards --test policy_conformance` (agrees on all 21); in `check-card-vectors.sh` |
| E31 | List histories over `fetch` (runtime §12): press signatures, `prev_log_root`, holder intent signer (E33), pinned list-card keys | `notary-cards/src/lists_read.rs`; `SnapshotOracle::list_history`; runtime pins file | `cargo test -p notary-broker --test list_reads` (genuine card accepted by L; 4 tamperings refused; unpinned card never read) |
| E32 | `single_operator_quorums` in `list_approval`, rule E | `verifier/src/notary/{types,lists}.ts`; `notary-types/src/objects.rs`; `notary-broker/src/lists.rs` | `vectors/lists/cases.json` now 20 cases (6 new), Rust and TypeScript agree (`lists.rs`, vectors-tools `lists.test.ts`) |
| E32 | Single-operator detection, N warning | `verifier/src/notary/{quorum,notarization}.ts` | verifier `test/notary/quorum.test.ts` (5); attestation-ts notarization test expects `SINGLE_OPERATOR_QUORUM` for its one-card job |
| E32 | Wallet W7 refusal, consent flag and disclosure | `wallet-sdk/.../src/notary/{verifyJob,consent}.ts` | wallet `verifyJob.test.ts` "single-operator quorums" (4) |
| E34 | Single-operator enforcement in verifiers, not enclaves | `verifier/src/notary/notarization.ts` (`singleOperatorRefusedSinceMs`, `NOT_SINGLE_OPERATOR_REFUSED`); broker check removed | attestation-ts notarization test (boundary); `broker.rs::enclaves_do_not_enforce_the_single_operator_switch` |

Attestation vectors: `NOTARY_WRITE_VECTORS=1 cargo test -p notary-attest --test att_codes` writes `notary/vectors/attestation/cases.json`.

Regenerate and check vectors: `pnpm run gen` / `pnpm run check` in `notary/vectors-tools`; Rust-produced vectors: `NOTARY_WRITE_VECTORS=1 cargo test -p notary-crypto`.

---

## 9. Amendments to the implementation plan (approved at CP4 and applied)

1. **Add 5.3a, "Card checks in Rust" (`notary-cards`), using Opus.** *Approved 2026-11-12.* It is large and security-critical (§6, risk 1; §7.5).
2. **Add 6.4a, "Registry write-gate calldata binding" (CP7).** The spec makes it a prerequisite for derived cards, but the plan has no step for it.
3. **Add governance and EAS scripts (§3.6) to 7.1.** The integration stack needs them to bootstrap lists, policies and the schema.
4. **Add `notary-messaging` to 6.1.** Private `statement` outputs need ADR-007 encryption in Rust.

---

## 10. Questions for David at CP4 (all answered)

These affect structure, so they are asked now rather than at 5.0.

1. **Where TypeScript notary code lives.** *Revised 2026-11-12 at David's request.* Notary code goes in a `verifier/notary` subpath that ordinary verifiers never load. AWS and simulator parsing goes in a separate `notary-attestation` package, injected through `config.notary.attestation`. Wallet-only and host-only types live in the wallet SDK and the host (§3.1, §3.1a).
2. **Card checks in Rust.** *Decided 2026-11-12:* a Rust port (`notary-cards`, step 5.3a), kept in step by the mechanisms in §7.5. Running the TypeScript verifier in an embedded JavaScript engine was considered and kept as a fallback.
3. **The plan amendments in §9.** *Approved at CP4* and applied to the implementation plan as steps 5.3a and 6.4a, and additions to 6.1, 6.3, 6.4 and 7.1.
4. **EAS on the local devnode.** *Approved at CP4:* deploy the EAS contracts into the integration stack. If that fails, use a mock anchor only in tests.

---

## 11. Capacity benchmark results (step 5.6)

*To be filled in at 5.6.*
