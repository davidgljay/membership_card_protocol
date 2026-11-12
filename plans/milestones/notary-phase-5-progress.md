# Digital Notaries — Phase 5 Progress (handoff note)

**Date:** 2026-11-12 · **Branch:** `notary` · **Nothing committed** (CP11). Everything is in the working tree.

## Status by step

| Step | State |
|---|---|
| 5.0 questions | **Done, ticked.** CP5 answered "OK to all" (Q11 downloads approved; E1 agreed). |
| 5.1 types and serialization | **Done, ticked.** TS and Rust agree on every vector; X-Wing and ML-DSA interop proven both ways (CP9 checkpoint 1 passed). |
| 5.2 simulator and attestation | **Done, ticked.** Simulator documents verify in Rust and TypeScript through the same parser path; every `ATT_*` code has a failing fixture. Real AWS documents: not tested (see Deviations). |
| 5.3, 5.3a | **Not started** (Opus; not in scope). |
| 5.4 wallet and verifier support | **Done, ticked** (its Done-when is met). Four items are deliberately deferred; see "5.4: deferred". |
| 5.5 host service | **Built against a mock enclave; NOT ticked.** The Done-when (the end-to-end path in compose against the simulator) needs the runtime from 5.3 (and a chain, EAS and IPFS wired for real, Phase 7). See "5.5: built and not built". |
| 5.6 capacity benchmark | **Blocked on 5.3.** |
| 5.7 milestone review | Separate session. |

## Tests (all run at the end of this session)

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | all pass: notary-types vectors (6), X-Wing interop (2), ML-DSA interop (3), attestation codes (2, 49 cases), AWS-root fingerprint (1), simulator (3 + 1 fixture writer) |
| `pnpm test` in `notary/vectors-tools` | 22 passed; `pnpm run check`: vectors up to date (23 files) |
| `pnpm test` in `notary/attestation-ts` | 81 passed (52 attestation + 20 notarization + 9 genesis) |
| `membership_card_verifier/packages/verifier-rpc-provider`: `pnpm test` | 29 passed, 9 skipped (pre-existing integration tests that need a chain) |
| `pnpm test` in `notary/host` | 69 passed (7 files); `pnpm run typecheck` and `typecheck:server` clean; `nitro build` succeeds; the built server answers over HTTP |
| `relay`: `npx vitest run tests/unit/oblivious-targets.test.ts` | 3 passed (`uuid-lifecycle` needs a Redis at `::1:6379`: pre-existing, unrelated) |
| `membership_card_verifier/packages/verifier`: `pnpm test` | 248 passed (includes the new notary tests; no regression) |
| `wallet-sdk/packages/wallet-sdk`: `pnpm test`, `pnpm run typecheck` | 231 passed, 1 todo; typecheck clean |
| `notary/scripts/check-aws-isolation.sh` | OK; a planted `cabundle` probe makes it fail |

## 5.4: done and left

**Done** (in `wallet-sdk/.../src/notary/`):
- algorithm W, steps W1–W15, tested with real simulator attestations: all six G2 rejections (wrong PCR0, debug mode, program hash ≠ `program_cid`, mismatched nonce, stale, notary not approved, parameters out of bounds) plus every other W step;
- the consent model (policy and job only; requester text separate and labelled; custom-program label; participation and derived-card disclosures);
- the inclusion check and Merkle inclusion paths;
- wallet object types (§21–§26) and the side-effect-free `notary-types` subpath;
- in the verifier: `src/notary/{canonical,types,attest}.ts` and the `./notary` subpath export.

**Added after David accepted the E6/E7 proposals:** algorithm L (`verifier/src/notary/lists.ts`, 11 tests) and `wallet/.../submit.ts` (sealing, `receipt_sealed`, receipt checks, persist-before-send; 12 tests). A real bug found on the way: `parseCanonicalNotary` leaked a raw `SyntaxError`; fixed.

**Also added after E12–E14 were decided:** algorithm N / `verifyNotarization` (`verifier/src/notary/notarization.ts`, 20 tests) and algorithm G (`genesis.ts`, 9 tests), both against real simulator attestations.

**Added in the last two passes:** algorithm E (`exposure.ts`, 14 tests); Stage 4 step 5a (`expires_at`, 6 tests); `VerifierConfig.notary`, optional `RpcProvider` methods and `NOTARY_CODES`; `getGovernanceKeyset` and `getNotaryLogAnchors` in `verifier-rpc-provider` (8 tests); the core-entry isolation test (3); wallet `link.ts`, `job.ts`, `watch.ts` (15 tests).

## 5.4: deferred (not blocking the Done-when)

- **Wiring Stage 5 step 3a into `CardVerifier`** (Phase 7): the logic (`verifyNotaryIssuedCard`, E17 accepted) and the Stage 5 hook are built and tested; what remains is the adapter that supplies the notary card lookup and reads.
- **Wallet `derived.ts`** (6.4) and **`notary_output` messaging** (6.1/6.4).
- **The `CardVerifier`-backed adapters** for `NotaryChainReads`, `NotarizationReads` and `ExposureReads` (Phase 7 wiring; the algorithms take them as injected reads and are tested with mocks plus real simulator attestations).
- **Rust `notary-cards` and the broker's `lists`** (5.3 and 5.3a).

## 5.5: built and not built

**Built and tested (69 host tests, plus the route files typechecked and the built server run over HTTP):**
- config validation (every problem reported at once); KV interface and the §7 keys with retention (ciphertexts deleted at finalize, 30-day receipts and job records, permanent logs, current-and-previous blobs);
- host receipts signed with K_host; job intake validated against the policy (requester signature, `min_live`, local replica cards, `program_cid` bytes against their CID digest) and `create_job` to a local enclave; announcements pinned as exact raw bytes and served; status;
- input ingress: size, job known and open, strict shape, store **before** receipt (a storage failure issues no receipt), forward the exact sealed input, `receipt_sealed` passed through untouched; undecryptable inputs dropped; unavailable enclaves keep the ciphertext;
- the framed enclave protocol, a socket transport (the same for the vsock proxy and the simulator), a session with timeouts and `NH_ENCLAVE_UNAVAILABLE`;
- the enclave-request dispatcher (pin exact bytes, serve by CID, index logs, `eas_anchor` → receipt or backlog alert, `chain_submit` unchanged, `deliver`, peer relay, `need_replica`, sanitized alerts, `fetch`);
- never-filtered policy snapshots and updates; monitoring that cannot carry job data; operator-token routes; the peer relay; the OHTTP gateway with a real HPKE round trip, and the two oblivious-only routes (a direct request gets 403 `NH_DIRECT_FORBIDDEN`);
- the relay registers the notary host as a third destination kind (3 tests).

**Not built or not verified:**
- the **end-to-end path** (needs the runtime, 5.3): the compose files are written, not run;
- the **mock enclave proves plumbing only**: it holds no keys, runs no program and checks no input;
- production **chain, EAS, IPFS (Kubo) and gas-wallet implementations** (viem calls): interfaces and the EAS data encoding exist; wiring is Phase 7;
- **block-header streaming** (`chain_headers`, header RLP), **re-attestation timers**, **snapshot refresh timers** and the **`close_chunk` / re-replication flows**: the message plumbing exists, the schedulers and the multi-replica flows belong with 5.3 and 6.3;
- `src/delivery`, `src/peer` clients are thin interfaces (HTTP posts); no relay-side integration test.

## Deviations and decisions to know about

1. **No real AWS attestation document tested.** I searched for a public recorded sample. The only one found (`pontifex`'s `tests/mock-attestation-doc.cose`) is sanitized (`certificate` is `[3,4]`), so it can't exercise chain validation, and I did not add it. The AWS root was downloaded (approved, Q11), verified against AWS's documented fingerprint and pinned in `notary/deploy/aws/`. The real-document parser test waits for Phase 8.
2. **Rust COSE parsing is hand-written on `ciborium`, without `coset`** (Q14 expected `coset`). `Sig_structure` is 20 lines and a manual check keeps the strictness rules explicit. `ciborium` accepts indefinite-length CBOR; the TypeScript decoder rejects it (so TS is stricter on malformed documents). Noted in the `aws.rs` header.
3. **Simulator naming.** The spec calls it the "fake NSM service". To satisfy the G5 grep (Q16: simulator modules contain none of the AWS terms), it is `FakeEnclave`, and the clock call is `attested_time_ms`.
4. **`DeriveKeyPair` differs between the two X-Wing libraries** (E8); the protocol doesn't use it.
5. **Neither ML-DSA implementation is audited** (E9). Interop is proven; flagged for the security review.
6. **TypeScript attestation uses `@noble/curves` 1.9.7 with `prehash: true`** (its default is no prehash); a bug here made every valid chain fail until found, and the 49 shared cases now guard it.
7. **`NsmBackend`** (feature `nsm`) is written and compiles on macOS but is untested until Phase 8.
8. **Q1 (5.5 and 5.6)** was approved as recommended: 5.5 would be built against a mock enclave without ticking; 5.6 not started. I ran out of this session before 5.5.

## Open errata needing David (full text in `plans/notary-questions-phase-5.md`)

- **E6** (blocks algorithm L, N, cosignatures): is the signed message the 32 raw digest bytes or the base64url text of `H(body)`?
- **E7** (blocks receipts): nonce and aad of `receipt_sealed`.
- **E2, E3, E10, E11**: spec lines to add or clarify (strict unknown fields; EAS "indexed by `job_hash`"; `inst_key_hash` in W13; `issuer_card` is a pointer but compared with a CID).
- Pending: **permission to add a sanitized sample document** is not requested; no action needed.

## Next session, in order

1. (E12–E14 decided.)
2. (5.4 done.)
3. 5.5: finish after 5.3 exists: run the compose against the simulator, wire the real chain/EAS/IPFS services, add the header-streaming and refresh schedulers, then tick.
4. Stop at 5.3 and tell David.
