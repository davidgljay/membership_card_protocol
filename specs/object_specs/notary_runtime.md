# Card Protocol — Notary Runtime Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft. Specified, not implemented.  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Processes:** `process_specs/notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md` · **Objects:** `protocol-objects.md` §20–§34 · **Design record:** `plans/notary-design-decisions.md` §2.3, §2.4
**Amended 2026-11-12:** §9 `create_job` reads the policy with algorithm R through `fetch`; `genesis_ready` adds `request` and `notary_card`. §12 pins list-card public keys and reads list history through `fetch`. §16 adds `CLOSE_NOT_DUE`. Source: `plans/notary-spec-wording-e31.md`, approved by David 2026-11-12.

**Amended 2026-11-12 (E35):** §16 adds `IDENTITY_LOG_PENDING`. Approved by David 2026-11-12.

> **Terminology.** This spec describes software that runs inside **AWS Nitro Enclaves**, called "the enclave". "NSM" is the enclave's security module, which issues the **enclave attestation** (the AWS Nitro Enclaves attestation document). This software is unrelated to nitropack, the web framework the host uses. See `ARCHITECTURE.md`, terminology note.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Image and Measurement](#2-image-and-measurement)
3. [Processes and Isolation](#3-processes-and-isolation)
4. [Keys](#4-keys)
5. [Attestation Backends](#5-attestation-backends)
6. [Program Admission (Algorithm A)](#6-program-admission-algorithm-a)
7. [Program ABI](#7-program-abi)
8. [Broker–Worker Protocol](#8-brokerworker-protocol)
9. [Host–Enclave Protocol](#9-hostenclave-protocol)
10. [Job Lifecycle States](#10-job-lifecycle-states)
11. [Output Checks and Privacy Transforms](#11-output-checks-and-privacy-transforms)
12. [Governance Lists Inside the Runtime](#12-governance-lists-inside-the-runtime)
13. [Chain Data](#13-chain-data)
14. [Limits](#14-limits)
15. [Zeroization](#15-zeroization)
16. [Error Codes](#16-error-codes)
17. [Implementation Checkpoints](#17-implementation-checkpoints)
18. [Related Specs](#18-related-specs)

---

## 1. Overview

The notary runtime is one audited Rust program, packaged as an enclave image whose measurement (PCR0) is on the governance accepted-runtime list (`protocol-objects.md §34`). One runtime instance serves many jobs. Each job's WASM program runs in its own worker process, under an interpreter, with no access to keys or to other jobs.

The runtime's guarantees:
- No key leaves the enclave except by attested handoff.
- No program runs unless it passed admission.
- No job key exists before its program is admitted.
- No output leaves the enclave unchecked.

Everything the host sends is untrusted.

Code lives in `notary/runtime/` (Rust, std, a separate workspace from `contracts/`). The admission checks are a shared crate, also used by the `notary-lint` CLI (`notary/lint/`).

---

## 2. Image and Measurement

- **Reproducible build.** Two independent builds of the same source commit and toolchain must give the same PCR0. The build recipe is pinned to IPFS and named in the accepted-runtime entry (`build_recipe_cid`).
- **Contents.** A minimal kernel and init; the runtime binary (broker and worker modes); and, compiled into the binary:
  - the **governance pins** (§12);
  - the **ABI version** string `notary_v1` and its fuel cost table (§7).
- **What's absent.** No shell, no network stack beyond vsock, and no persistent storage.
- **Debug mode.** An image started in debug mode reports PCR0, PCR1 and PCR2 as zeros. Every verifier rejects that (`ATT_DEBUG_MODE`).

---

## 3. Processes and Isolation

```
 ┌──────────────────────── enclave (one PCR0) ──────────────────────────┐
 │  broker (1 process, UID broker)            workers (1 per job,        │
 │  • all keys (§4)                     pipe   UID per worker)           │
 │  • /dev/nsm (broker UID only)      ◄──────► • wasmi interpreter       │
 │  • HPKE decryption, signatures,              • one job's checked       │
 │    chain checks, dedupe index                  payloads only           │
 │  • output checks and transforms (§11)       • seccomp: read/write on   │
 │  • vsock to host (the only channel out)       its two pipes, exit,     │
 │                                               memory; nothing else     │
 └───────────────▲──────────────────────────────────────────────────────┘
                 │ vsock
              notary host (`notary_host.md`)
```

- **Broker.** One process. Holds every key, talks to the NSM and to the host, checks inputs (`notary_lifecycle.md` Appendix B), and applies output checks.
- **Workers.** One per job.
  - Started when the job first needs to run its program: at close for aggregate jobs, or at the first input for per-input jobs.
  - Each **run** gets a fresh wasmi store and instance, so no program state carries from one input to the next.
  - An aggregate job's worker is killed after its run. A per-input job's worker lives until the job ends.
- **Isolation measures:**
  - each worker runs under its own UID;
  - `/dev/nsm` is readable only by the broker's UID;
  - workers run under seccomp-bpf with only `read` and `write` on their two pipe descriptors, `exit_group`, `mmap`/`munmap`/`brk`, and `futex`;
  - the filesystem is read-only;
  - workers have memory and CPU rlimits.

  An interpreter escape therefore lands in a process with no keys, no NSM, no network, and only its own job's payloads.
- **Shared and dedicated.** In `shared` mode a runtime holds workers for up to 256 jobs, all running allowlisted programs. In `dedicated` mode it admits exactly one job and refuses `create_job` for any other (`ADM_DEDICATED_REQUIRED`). The mode is bound into every job attestation (`protocol-objects.md §33`, `isolation`).
- **No JIT.** Programs run in **wasmi**, an interpreter, not a JIT compiler, to avoid compiler bugs that could break out of the sandbox.

---

## 4. Keys

| Key | Created | Held | Leaves the enclave? |
|---|---|---|---|
| `K_inst` (ML-DSA-44) | At boot | Broker | Never |
| `K_id` (ML-DSA-44), `K_chain` (secp256r1) | At notary genesis, or received by identity handoff | Broker keyring, one pair per notary card | Only by identity handoff |
| State key | With the identity, or by identity handoff | Broker keyring | Only by identity handoff |
| `k_T,p` (`dup_tag` key) | First template enclave, or by template handoff | Broker | Only by template handoff |
| `K_job,e` (X-Wing draft-06) | After program admission, per (job, epoch) | Broker | Only by job handoff |
| Ephemeral handoff key (X-Wing) | Per handoff | Broker | Never; erased after the handoff |

**Key lineage** *(added 2026-11-12)*. Every key in the keyring carries its **lineage**: the set of PCR0s it has lived in. A key created here starts with this runtime's PCR0. A handoff payload carries each key's lineage, and the receiver adds its own PCR0. When the broker verifies a list version (§12) that retires a PCR0 as `"vulnerable"`, it checks every key against it. For each key whose lineage contains that PCR0, it raises `alert key_exposed` and acts as follows:
- **`K_id`, `K_chain` and the state key:** never sign or decrypt with them again. The notary card is dead and the operator must redo genesis (`notary_lifecycle.md` Appendix A.6).
- **`K_job,e`:** stop issuing receipts for that job, and keep the key only until a `key_exposure` epoch is anchored (`notary_replication_and_recovery.md` §7).
- **`k_T,p`:** re-seed the template chain (`derived_card_revocation_propagation.md` §1).

An exposed key is never handed on (P5).

**Invariants** (tested):
- **I1.** No key is exported except by the handoff protocol (`notary_replication_and_recovery.md` §3).
- **I2.** No key is imported except by that protocol. In particular, a host-supplied identity key is never accepted.
- **I3.** A key's hash is put in an attestation only if the runtime holds that key.

**Cryptography.**
- **Algorithms.**
  - ML-DSA-44 (FIPS 204), signing and verification.
  - X-Wing draft-06 HPKE (the `hpke` crate with the `mlkem` feature, the `x-wing` crate at draft 06; **not** `rxwing`, which implements draft 11).
  - ChaCha20-Poly1305, SHA-256, SHA3-256, keccak256, and HKDF-SHA256 / HKDF-SHA3-256.
  - secp256r1 ECDSA for chain payloads.
  - AES-256-GCM, to decrypt card content (ADR-006).
- **Constant time.** All secret-dependent operations use constant-time implementations.
- **Randomness.** Comes from the NSM's random source, mixed into the kernel's RNG at boot.

---

## 5. Attestation Backends

```rust
trait AttestationBackend {            // inside the enclave
    fn attest(&self, user_data: [u8; 181], public_key: Option<[u8; 32]>, nonce: [u8; 32])
        -> Result<Vec<u8>, AttestError>;   // returns the attestation document bytes
    fn platform(&self) -> &'static str;     // "aws-nitro-enclaves" | "simulator"
}
```

| Backend | Used in | Notes |
|---|---|---|
| `NsmBackend` | Production | Requests from `/dev/nsm`. `user_data` is 181 bytes, `public_key` 32 bytes and `nonce` 32 bytes, all within the NSM's documented maximums. **These limits must be re-confirmed on real hardware (§17).** |
| `SimulatorBackend` | Development, CI, `notary/sim` | Emits the same COSE_Sign1 / CBOR document format, signed by a test root CA with configurable PCRs and a debug flag. Production verifiers refuse it (`ATT_PLATFORM_NOT_ALLOWED`). |

**Verifier side.** Wallets, verifiers, and other enclaves running algorithm P use an `AttestationVerifier` with one module per platform. Each module implements steps V1–V5 of algorithm V (`notary_lifecycle.md` Appendix A.1): format, root, chain at the document's timestamp, signature, and debug detection. Steps V6–V12 are shared code operating on the parsed result:

```ts
interface AttestationVerifier {
  platform: "aws-nitro-enclaves" | "simulator";
  verifyEnvelope(doc: Uint8Array, trustRoot: Uint8Array):
    { ok: true; measurement: Uint8Array; pcrs: Map<number, Uint8Array>; timestamp: number;
      userData: Uint8Array; nonce?: Uint8Array; publicKey?: Uint8Array }
    | { ok: false; code: "ATT_MALFORMED" | "ATT_ROOT_MISMATCH" | "ATT_CHAIN_INVALID" | "ATT_SIGNATURE_INVALID" };
}
```

**Isolation of the AWS format.** No module outside these verifier modules, the backend, and image packaging parses the AWS document format.

**Using the NSM as a clock.** At close, the broker requests an attestation and reads its `timestamp` (`notary_replication_and_recovery.md` step 14). This relies on assumption T9: the parent instance can't influence NSM time.

---

## 6. Program Admission (Algorithm A)

The runtime runs algorithm A when it loads a program for a job, and `notary-lint` runs the same code at policy creation. **A runs to completion before the broker generates `K_job`.**

**Allowed WebAssembly features (v1):**
- WebAssembly 1.0 (MVP), plus `mutable-global`, `sign-extension`, `multi-value` and `bulk-memory`.

**Rejected features:**
- threads, atomics and shared memory;
- SIMD and relaxed SIMD;
- **every floating-point type and instruction**;
- exceptions and tail calls;
- reference types beyond one `funcref` table;
- GC, `memory64` and multi-memory;
- the component model;
- a `start` function.

**Why no floating point.** Aggregate results are recomputed at close by several replicas, which must produce identical bytes (`notary_replication_and_recovery.md` §5). Integer-only programs make that hold with no floating-point rules to audit. Templates use fixed-point arithmetic.

| # | Check | Code |
|---|---|---|
| A1 | `program_cid` is CIDv1 with codec `raw` and hash sha2-256, and SHA-256 of the module bytes equals the CID's digest | `ADM_HASH_MISMATCH` |
| A2 | Module size ≤ 4 MiB | `ADM_TOO_LARGE` |
| A3 | Validates under the allowed feature set; no start function | `ADM_FEATURE_DISALLOWED` |
| A4 | Every import is one of the seven in §7, with exactly that signature. No imported memories, tables or globals. | `ADM_IMPORT_DISALLOWED` |
| A5 | Exactly one defined memory, not shared, exported as `"memory"`. Its declared maximum is ≤ 256 pages (16 MiB) and ≤ `limits.memory_pages` if the policy sets it. | `ADM_MEMORY_LIMIT` |
| A6 | At most one table, of type `funcref`, with a declared maximum ≤ 1,024 entries | `ADM_TABLE_LIMIT` |
| A7 | ≤ 10,000 functions, ≤ 1,000 locals per function, ≤ 1,000 globals, and ≤ 1 MiB of data segments in total | `ADM_STRUCTURE_LIMIT` |
| A8 | Exactly two exports: `"memory"` and `"run": () -> i32` | `ADM_EXPORTS_INVALID` |
| A9 | Custom section `"notary.abi"` is exactly the UTF-8 bytes `notary_v1`. Custom section `"notary.output_schema"` is UTF-8 RFC 8785 JSON equal, byte for byte, to the canonical form of the policy's `output_schema`. Each appears once. Other custom sections, including `"name"`, are ignored but count toward A2. | `ADM_SCHEMA_MISMATCH` |
| A10 | The policy's `limits`, if set, are within the runtime ceilings (§14) | `ADM_LIMITS_EXCEED_CEILING` |
| A11 | If `isolation` is `"shared"`, `program_cid` is on the runtime's verified allowlist (§12): accepted now and not retired. If `"dedicated"`, the runtime holds no other job. | `ADM_NOT_ALLOWLISTED_FOR_SHARED`, `ADM_DEDICATED_REQUIRED` |

The ceilings in A2, A5, A7 and A10 are provisional until the capacity benchmark (implementation step 5.6). Changes are recorded as spec errata.

**Lint warnings** (non-fatal, `notary-lint` only):
- `LINT_WEAK_GRANULARITY`: an integer output field has neither `round_to` nor `buckets`, and `k_min < 10`.
- `LINT_NO_SNAPSHOT_POLICY`: the `contributor_predicate` names no policy that can be snapshotted, so contributors will see the participation disclosure (`notary_lifecycle.md` step 31).

---

## 7. Program ABI

**ABI `notary_v1`.** All functions are imported from module `"notary_v1"`, and every value is `i32`:

| Import | Signature | Behaviour |
|---|---|---|
| `input_count` | `() -> i32` | Number of inputs in this run (always 1 for per-input jobs) |
| `input_len` | `(i) -> i32` | Byte length of input `i`'s payload (RFC 8785 JSON) |
| `input_read` | `(i, ptr, len) -> i32` | Copies the payload into guest memory and returns the bytes copied. Traps if out of range. |
| `param_len` | `() -> i32` | Byte length of `job.parameters` (RFC 8785 JSON) |
| `param_read` | `(ptr, len) -> i32` | Copies the parameters |
| `output_write` | `(ptr, len) -> i32` | Submits the output (RFC 8785 JSON). Callable once; a second call traps (`output_twice`). |
| `abort` | `(code) -> !` | Ends the run with a program error |

**What a program can't reach.** There is no clock, randomness, I/O, key access, card address, or access to another job. Inputs reach a program only after the broker has checked them. Each input is the contributor's `payload` (for derived cards, the requested source field values), in `input_hash` order.

**Fuel table.** `notary_v1` fixes wasmi's per-instruction fuel costs. A runtime that changes them must use a new ABI string. A handoff requires both sides to report the same ABI (`notary_replication_and_recovery.md` P4), so replicas recomputing at close always agree on when fuel runs out.

---

## 8. Broker–Worker Protocol

**Framing.** Each frame is a 4-byte big-endian length followed by RFC 8785 JSON. A frame is at most 16 MiB; larger payloads are split into numbered chunks. Every message has `kind` and `req_id`.

| Direction | `kind` | Fields | Notes |
|---|---|---|---|
| B→W | `load` | `program` (bytes), `limits` | The worker hashes the program itself |
| W→B | `loaded` | `program_hash` | The broker kills the worker if the hash differs from the admitted one |
| B→W | `run` | `run_id`, `params`, `inputs[]` | Inputs are sorted by `input_hash`. No card data is sent. |
| W→B | `output` | `run_id`, `bytes`, `fuel_used` | The raw output; the broker applies §11 |
| W→B | `error` | `run_id`, `reason` | `reason` is one of `trap`, `fuel`, `memory`, `abort:<code>`, `output_twice`, `no_output` |
| B→W | `terminate` | — | The broker also kills the worker when its wall-clock limit passes |

---

## 9. Host–Enclave Protocol

The transport is vsock, using the framing in §8. **Everything from the host is untrusted.** The broker validates each message, and the host may drop, delay, reorder or replay any of them. A replayed `submit_input` produces the same `input_hash`, so it is idempotent.

**Host → enclave**

| `kind` | Fields | Broker action | Response |
|---|---|---|---|
| `hello` | `challenge` | Generates `K_inst` on first boot and attests (purpose `0x03`) | `hello_ack { inst_pubkey, attestation }` |
| `chain_headers` | `[{ number, header_rlp }]` | Hashes each header with keccak and checks it links by parent hash to the newest accepted header. Ignores older headers. | `chain_ack { newest }` |
| `fetch_result` | `req_id`, `bytes` or `not_found` | Answers an enclave `fetch`. IPFS objects are checked against their CID. | — |
| `policy_snapshot` | `policy_address`, `entries[]`, `subcards[]`, `heads[]`, `at_block` | Replaces the local snapshot for that policy | `snapshot_ack` |
| `policy_updates` | `policy_address`, `updates[]` (each `CardHeadUpdated` with the new head's bytes) | Applies the updates to the snapshot and runs the `sealed_link` watch loop (`derived_card_revocation_propagation.md` §6) | — |
| `genesis` | genesis request | Generates `K_id` and `K_chain` and attests (purpose `0x01`) | `genesis_ready { id_pubkey, chain_pubkey, attestation, request, notary_card }`. `request` is the completed genesis request whose hash is the attestation `nonce`; the enclave also `publish`es it, so the notary card can carry its CID (`genesis_request`, E17). `notary_card` is `keccak256(K_id)`. |
| `countersign_notary_card` | offer | Runs check G2 against its own keys, then signs `holder_signature` | `countersigned` |
| `create_job` | `job`, `program`, optional `restart` | Job checks (`notary_lifecycle.md` step 17), reading the policy and any requester chain with algorithm R (Appendix A.7) through `fetch`. Then algorithm A, then `K_job` and attestation (`0x02`). | `job_keyed { epoch, job_public_key, attestation }` or `job_rejected { code }` |
| `submit_input` | `job_hash`, `sealed_input` | B1–B11, then quorum forwarding (`notary_replication_and_recovery.md` §4) | `input_result { input_hash, receipt_sealed }` |
| `close_chunk` | `job_hash`, `seq`, `sealed_inputs[]`, `last` | Collects inputs for the close computation | `job_closed { notarization, record, outputs[] }` |
| `anchor_receipt` | `scope_id`, `seq`, `tx_receipt` | Unblocks the next job-log or identity-log record | — |
| `chain_result` | `req_id`, `tx_receipt` or `failed` | Result of a chain submission | — |
| `peer_message` | `from_instance`, `bytes` | Handoff, `input_ack`, cosignature, heartbeat | — |
| `abort_job` | `job_hash`, `reason` | Writes an `aborted` record and erases the job's keys | `job_log_record` |

**Enclave → host**

| `kind` | Fields | Host action |
|---|---|---|
| `fetch` | `req_id`, `what` | `what` is one of `policy_snapshot:<policy>`, `policy_updates:<policy,since_block>`, `ipfs:<cid>`, `card_head:<address>`, `press_auth:<policy,press>`, `subcard:<address>`, `events:<filter>`. **Per-card kinds are used only** for ancestors outside snapshotted policies, and for the disclosed fallback. |
| `publish` | `object`, `pin` | Pins to IPFS and serves the object (announcements, notarizations, `counted_inputs`, job-log records, derived cards, state blobs) |
| `announce` | the signed announcement | Serves it at `GET /jobs/{job_hash}/announcement` |
| `chain_submit` | `op`, `payload`, `signature` | Submits `RegisterCard` or `BatchUpdateCardHeads` from the gas wallet |
| `eas_anchor` | `record_cid`, `scope_id`, `seq` | Submits the EAS attestation |
| `deliver` | `routing_envelope` | Delivers a `notary_output` message through message routing |
| `peer_send` | `to_instance`, `bytes` | Relays to the host of the named replica |
| `need_replica` | `job_hash` or `notary_card` | Starts and attests a new enclave |
| `alert` | `level`, `code` | For operator monitoring only. Never carries job data. |

---

## 10. Job Lifecycle States

**Aggregate jobs** (including votes):

```
 (none) ──create_job ok──► KEYED(e) ──opens_at──► OPEN(e) ──closes_at (chain + NSM time)──► CLOSING
   │ A or job checks fail     │                      │ submit_input: B1–B11, quorum ack       │ all chunks
   ▼                          │ abort_job            │                                        ▼
 REJECTED                     ▼                      │                                    COMPUTING
                           ABORTED ◄──abort_job──────┘                                        │ q cosignatures
                              ▲                                                               ▼
                              └──── OUTPUT_SCHEMA_VIOLATION ──────────────────────────── FINALIZED
                                                                (keys, index, buffers erased)
 KEYED(e+1): a new replica set after total loss (notary_replication_and_recovery.md §7).
```

**Per-input jobs** (derived cards):

```
 (none) ──create_job──► KEYED(e) ──opens_at──► OPEN(e) ──key_period──► ROTATING(e→e+1) ──► OPEN(e+1)
                                                 │ per input: B1–B11, D1–D4, run,        │ K_job,e kept 1 h
                                                 │ offer; countersign → issuance pool    │ then erased
                                                 └──── ends_at ──► ENDED (all keys erased)
```

---

## 11. Output Checks and Privacy Transforms

The broker applies these in order to whatever a run returns:

1. **Parse.** The output is RFC 8785 JSON whose fields exactly match `output_schema`. Allowed types are `integer`, `boolean`, and `text` with an `enum` of at most 256 characters. Anything else is `OUTPUT_SCHEMA_VIOLATION`, and nothing is released.
2. **`clamp: [min, max]`**: `v ← min(max(v, min), max)`.
3. **`round_to: r`**: round to the nearest multiple of `r`, ties to even, in exact integer arithmetic. **Or** `buckets: [e0 < … < en]`: `v ← max{ eᵢ ≤ v }`; requires `clamp` with `min = e0`.
4. **`suppress_cell_below_k: k`**: if `0 < v < k`, omit the field (it must be `required: false`).
5. **Whole-output `k_min`**: applied before the run. If fewer than `k_min` contributors are counted, the output is `{ "insufficient_participation": true }` and the program doesn't run.

**What these transforms guarantee.** The output always stays within the policy's declared ranges and granularity, which is what bounds a leaky program. They don't make an arbitrary program private. That depends on the program allowlist's audits, and wallets label any non-allowlisted program "custom program — not independently audited".

**Differential privacy.** Specified, not implemented in v1. A runtime refuses any policy whose `privacy` sets `"dp"` (`ADM_DP_UNSUPPORTED`).

**Other deferred features.** A v1 runtime also refuses a policy whose `revocation_propagation.mode` is `"escrowed_link"`, or whose `derived_card.source_kind` is anything other than `"card"`, for example the reserved `"web_evidence"` (`ADM_FEATURE_UNSUPPORTED`). See `protocol-objects.md §2.1`.

---

## 12. Governance Lists Inside the Runtime

The runtime needs the accepted-runtime list (for handoff check P2) and the program allowlist (for A11). Its only source for them is the host.

1. **Pinned at build time.** The image contains:
   - the two list-card addresses and their **public keys** (each address is `keccak256` of its key; the key gives the list card's content key);
   - the ML-DSA-44 public keys allowed to sign their updates (the list holder's key and the PressRegistryBody press key);
   - the PressRegistryBody **member keyset** `{ keys, quorum, version, key_scheme }` used to check `list_approval` (algorithm L);
   - a **version floor** for each list.

   All of these are covered by PCR0.
2. **Read and checked.** The broker reads each list card's history through `fetch`, with no network connection: `card_head:<list card>` gives the head events in order (`notary_host.md` §8 shape), and `ipfs:<cid>` gives each version, checked against its CID and decrypted with the pinned list-card key (`decryptCardHead`). It checks every `intent_signature` and `press_signature` against the pinned keys, checks the `prev_log_root` chain, and runs algorithm L (`notary_lifecycle.md` Appendix A.5) against the pinned member keyset. A host that omits or reorders versions breaks L's `list_version` and `prev_list_hash` continuity, and a host that withholds the newest version is limit L5. The broker uses the `card_state` of the highest version that passes all checks.
3. **Reacts to retirements.** On each newly verified accepted-runtime list, the broker runs the key-lineage check (§4).
4. **Never goes backwards.** The broker refuses any version below the floor or below the highest it has seen. The highest version seen travels in heartbeats (`list_versions`) and handoffs, so restarted replicas inherit it.

**Member key rotation.** After `RotateGovernanceKeys`, new approvals name a keyset version the image doesn't have, so the runtime stops accepting list updates. It keeps its last verified version. The body therefore publishes a new runtime image with the new keyset whenever it rotates, and retires older images as superseded. A removed member's key stays valid in images built before the rotation until they are retired, so a removal for compromise is paired with an emergency retirement of those images.

**Residual risk (L5).** A host can withhold newer list versions. The remedy for a serious issue is to retire the runtime's PCR0 itself and publish an image with a higher floor; wallets and peers then refuse the old runtime. Rotating a pinned key also needs a new image.

---

## 13. Chain Data

| Data | Source | Verified in v1? |
|---|---|---|
| Block headers | `chain_headers` | Hash linkage only. Not consensus or finality. |
| IPFS objects | Input `evidence`; `fetch ipfs:` | Yes: CID hash and the signatures inside |
| Registry state (card heads, `PressAuthorizations`, sub-card `active` flags) | Policy snapshots and updates; per-card fetches only where disclosed | **No.** Recorded through `chain_state` in every notarization. This is limit L4. |
| Time for close | Header timestamp **and** NSM attestation timestamp | Headers: hash linkage only. NSM time: AWS-signed. |

**Freshness floor.** The broker never uses chain state older than the newest `chain_ref` it has accepted from an input. Each wallet's own recent block therefore limits how far back a host can push it.

---

## 14. Limits

| Limit | Runtime ceiling | Policy may lower it? |
|---|---|---|
| Fuel per run | 10⁹ | Yes (`limits.fuel`) |
| Wall-clock time per run | 60 s | Yes (`limits.wall_ms`) |
| Linear memory | 256 pages (16 MiB) | Yes (`limits.memory_pages`) |
| Contributors per job | 100,000 | Yes (`limits.max_inputs`) |
| `SealedInput` size | 256 KiB | No |
| Module size | 4 MiB | No |
| Concurrent jobs | 256 in `shared` mode; 1 in `dedicated` mode | No |

These are provisional until the capacity benchmark (implementation step 5.6).

---

## 15. Zeroization

Every secret and every decrypted payload lives in a buffer that is locked into memory (`mlock`) and zeroized when dropped (the Rust `zeroize` crate).

| Material | Erased when |
|---|---|
| `K_job,e` | The job is finalized or aborted, or 1 hour after rotation (per-input jobs) |
| Decrypted input plaintext | After B11, after each close re-check, and after each run |
| Worker address space | When the worker process exits. Per-input runs recreate the store for every input. |
| Dedupe index | When the job is finalized |
| Ephemeral handoff keys | When the handoff completes or fails |
| `k_T,p` | When period `p` plus `renewal_window` has passed |
| `K_inst` | Never persisted; dies with the enclave |

The host can't read enclave memory in any case. Zeroization limits what a later compromise inside the enclave could recover from earlier jobs.

---

## 16. Error Codes

| Code | Where | Meaning |
|---|---|---|
| `ADM_HASH_MISMATCH` … `ADM_DEDICATED_REQUIRED` | A1–A11 | Program not admitted (§6) |
| `ADM_DP_UNSUPPORTED` | Admission | The policy sets a DP budget, which v1 doesn't support |
| `ADM_FEATURE_UNSUPPORTED` | Admission | The policy uses a specified but deferred feature: `escrowed_link`, or a `source_kind` other than `"card"` |
| `OUTPUT_SCHEMA_VIOLATION` | §11 | Output invalid; the job is aborted with no output |
| `INPUT_*`, `REVISION_CONFLICT` | Broker | `notary_lifecycle.md` Appendix B |
| `DERIVE_*` | Broker | `derived_card_revocation_propagation.md` §3 |
| `HANDOFF_*` | Broker | `notary_replication_and_recovery.md` algorithm P and step 7 |
| `ATT_*` | Verifier modules and algorithm V | `notary_lifecycle.md` Appendix A.1 |
| `LIST_VERSION_REGRESSION` | §12 | A host supplied an older governance list version; refused and alerted |
| `CLOSE_NOT_DUE` | §9 `close_chunk` | Chain time or the attested time is still before `closes_at`; nothing closed, and the host retries later (`notary_replication_and_recovery.md` §5) |
| `IDENTITY_LOG_PENDING` | §9 `create_job` | The notary card's identity-log `seq` 0 isn't anchored yet (`notary_lifecycle.md` step 9); nothing opened, and the host anchors it and retries |
| `LIST_APPROVAL_*` | §12 | A list version isn't validly approved by members (`notary_lifecycle.md` Appendix A.5); refused, and the last verified version is kept |
| `LINT_WEAK_GRANULARITY`, `LINT_NO_SNAPSHOT_POLICY` | `notary-lint` | Warnings |

---

## 17. Implementation Checkpoints

Each must be confirmed before dependent work proceeds. A failure is a **CP9** stop (implementation plan):

1. **X-Wing interop.** Cross-language test vectors (fixed seeds → `enc`, `ct`, exported secret) produced by `@hpke/hybridkem-x-wing` 0.7.1 and by Rust `hpke` 0.15.1 with `mlkem` must match in both directions (implementation step 5.1).
2. **NSM limits.** On real hardware, `user_data` must accept 181 bytes, `public_key` 32 bytes and `nonce` 32 bytes (steps 5.2 and 8).
3. **NSM time.** The parent instance can't set or skew the NSM's attestation `timestamp` (assumption T9; steps 5.2 and 8).
4. **wasmi suitability.** Fuel metering is deterministic across builds of the pinned version, and the feature flags can disable everything §6 rejects (step 5.3).

---

## 18. Related Specs

- `process_specs/notary_lifecycle.md`: phases, algorithms V, W, G, N, input checks B1–B11, threat model
- `process_specs/notary_replication_and_recovery.md`: handoff (P), quorum, epochs, state blob
- `process_specs/derived_card_revocation_propagation.md`: derive checks D1–D4, watch loop, propagation
- `object_specs/notary_host.md`: the other end of §9
- `protocol-objects.md` §20–§34
- `ARCHITECTURE.md` ADR-013
