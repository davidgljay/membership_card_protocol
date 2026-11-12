# Digital Notaries — Strategic Plan

Companion: [notary-implementation-plan.md](notary-implementation-plan.md) (written after the open questions below are answered).

Source: design discussion with David, 2026-11-11 (decisions recorded in §Design Decisions below).

## Starting point

A **notary** observes signed statements from card holders, runs a declared analysis on them, signs the result, and discards the inputs. The four v1 use cases, all to be implemented and tested:

1. **Aggregation** — a community organizer learns how much members talk to one another, as a k-anonymous aggregate, without seeing anyone's individual data.
2. **Voting** — members cast ballots over a voting period; the notary publishes a signed tally at close.
3. **Derived cards** — a holder presents a full card (e.g. a Meta employee card) and receives a reduced card that states only "Meta employee."
4. **Revocation propagation** — the notary that granted a derived card watches the source card and passes revocations on to the derived card, in a way the notary policy declares.

The protocol already has most of the shape. A press receives signed inputs, runs a fixed program (policy predicate checks), signs an output, and keeps only an auditor-encrypted log (`card_protocol_spec.md §The Press Model`, `ARCHITECTURE.md` ADR-005). A notary generalizes that pattern to arbitrary declared programs. Existing pieces it reuses:

| Notary concept | Existing mechanism |
|---|---|
| Notary card (operator authorization) | **Press sub-card** + `approved_presses` → `approved_notaries` |
| Notary policy | **PolicyCardDocument** (`protocol-objects.md §2`), policy creation flow and chain walk |
| Job activation and sharing | **OpenCardOffer** pattern (`protocol-objects.md §6`, `open_offer_creation.md`) — signed, hosted on the wallet service, shared as a link |
| Encrypted input submission | **Oblivious transport** (`process_specs/oblivious_transport.md`) — HPKE to the destination's key, forwarded by the relay |
| Derived-card issuance | Press issuance with holder countersignature |
| Notarization record | Card **log entries** (`protocol-objects.md §3`), optionally **EAS** (ADR-008) |
| Runtime acceptance list | Governance-signed protocol artifacts (ADR-011) |

What is genuinely new: a measured enclave runtime, attestation verification in wallets, the job / input / notarization objects, replica key handoff, and three program templates.

## Design Decisions (carried in from discussion)

- **Platform: AWS Nitro Enclaves for v1.** Other TEEs (SEV-SNP, TDX) and cryptographic templates (Prio/DAP, threshold encryption, client-side ZK) are deferred. Keep AWS swappable: a `platform` field on notary cards and notarizations, and one verifier module per attestation format.
- **The program computes; the policy routes.** WASM programs map inputs to an output value only. Recipients and actions (`output_action`, `output_recipients`) come from the policy, never the program.
- **Notary policy** = a `PolicyCardDocument` with a `notary` section: `program_cid`, `mode`, `input_schema`, `contributor_predicate`, `requester_predicate`, `parameter_bounds`, `output_schema`, `output_action` (`statement` | `card`), `output_recipients`, `retention: "none"`, `platform`.
- **Notary operators** hold a **notary sub-card** of the policy (issued by the administrator, countersigned by the operator), listed in `approved_notaries`. Operators run a parent host (Docker Compose on an enclave-capable EC2 instance) plus the governance-approved enclave image.
- **Generic measured runtime.** One audited runtime image (Rust) loads WASM programs by CID. For each job it loads and hashes the program **before** generating that job's key, binds the key to that job's sandbox only, and requests a per-job attestation with `{program_hash, job_hash}` in `user_data`, the job public key in `public_key`, and `hash(job)` in `nonce`. PCR0 identifies the runtime; everything else in the attestation is per job.
- **Multi-job runtime (v1 requirement).** One enclave serves many jobs, because AWS allows only four enclaves per parent instance. Inside the enclave:
  - a **broker process** holds all keys and decrypts inputs; programs never see keys
  - each job runs in its own **worker process** and receives only its own plaintext
  - programs execute in a **WASM interpreter** (e.g. wasmi), not a JIT, to avoid compiler-bug sandbox escapes
  - per-job limits on fuel, memory and wall-clock time; keys and buffers zeroized when a job ends
- **Isolation field.** Notary policies declare `isolation: "shared" | "dedicated"`. Only programs on the governance **program allowlist** may run `shared`; any other program runs alone in a `dedicated` enclave. The runtime enforces this, and wallets show "audited template" vs. "custom program — not independently audited."
- **Program allowlist.** A governance-signed, logged list of audited program hashes, parallel to the PCR0 list. Allowlisted programs have reproducible builds: `program_cid` maps to a source commit and toolchain.
- **Program admission checks** run inside the runtime at load (and therefore are covered by attestation): only the runtime's host-function imports; no threads, shared memory, imported/exported memories or tables, or non-deterministic features; declared memory, table, size and function-count caps; exact export signatures; an output-schema custom section that must match the policy's `output_schema`. The same checks ship as a `notary-lint` CLI and run at policy creation for early feedback.
- **Runtime-enforced privacy.** Privacy rules are applied by the runtime to whatever the program returns, never by the program: k-suppression, clamping to declared ranges, rounding/bucketing, and differential-privacy noise where the policy sets a budget.
- **Accepted runtimes** are a governance-maintained, signed, logged list of PCR0 values (not a PCR8 signing key).
- **Enforcement point: the wallet verifies attestation before encrypting any input** — AWS root chain, debug off, PCR0 in the accepted list, program hash = `program_cid`, nonce = job hash. The consent screen is generated from the policy, not from requester text.
- **Program-bound inputs.** Each input is signed by the contributor's sub-card over `{job_hash, payload}` and HPKE-encrypted (ML-KEM-768 + X25519) to the job key, sent via the relay's oblivious transport.
- **Receipts.** The host returns a signed receipt for the ciphertext hash; the enclave returns a signed validation receipt.
- **Processing.** The enclave verifies signatures, chains (content-addressed card documents plus a host-supplied Arbitrum state root), revocation, contributor eligibility, and dedupes one input per card. Output is suppressed below `k`. Output is checked against `output_schema`.
- **What goes on the public record.** The public log entry records only that the notary acted: job, policy, input commitment, accepted/rejected counts, and the notarization hash. No input data. The output itself is encrypted to its recipients unless the policy declares it public. Notarizations are log entries on the notary sub-card's log; EAS anchoring is optional per policy. Heartbeats stay off-chain.
- **Operators per job.** Any operator in `approved_notaries` may serve a policy; the requester chooses per job.
- **Replicas.** The requester sets the replica count; the default is **3 replicas across availability zones**.
- **Notarization** = signed record of `{job, policy_id, notary_card, program_cid, attestation, chain_state_root, input_commitment (Merkle root of accepted ciphertext hashes), accepted, rejected, output, enclave_signature}`.
- **Job modes.** `aggregate` — one-shot: one output per key, then key erased. `per_input` — standing job, one output per input, key rotated per period. Long-running jobs (votes) store ciphertexts outside the enclave and **recompute from all inputs at close**; no running tally exists.
- **Close is anchored to the chain**: the enclave finalizes only when shown a state root whose block timestamp ≥ `closes_at`.
- **Replication.** The job names a replica set and `min_live`. Replicas receive the job key via **mutual attestation handoff** (identical PCR0, same program, same job, operator in the replica set); every handoff is logged. Replicas send signed heartbeats and re-replicate below `min_live`. Losing every replica loses the key — this is deliberate and not recoverable.
- **Epochs.** A restarted job gets a new epoch and key; wallets automatically resubmit stored inputs.
- **Derived cards.** Short `valid_until` (renewed by re-presenting the source card), a per-source-card per-period nullifier, batched issuance to prevent timing linkage, and a minimum anonymity-set check on projected fields.
- **Derived-card authority.** Source policies do not limit which notaries may derive from their cards; any holder may show a card to any notary. The derived card's chain runs through the notary policy, and the notary is the party that vouches for the source card. Verifiers decide whether to trust that notary.
- **Revocation propagation.** The notary policy declares `revocation_propagation`:
  - `expiry_only` — no link is kept; revocation takes effect at expiry. (v1)
  - `sealed_link` — the enclave keeps the source→derived link, the host feeds it registry updates, and the enclave signs derived-card revocations. Links persist in an encrypted state blob anchored on-chain and are handed to replicas; if every replica dies, links are lost and the card falls back to expiry. Revocations are released in batches after a minimum delay, mixed with ordinary expiries, to prevent timing linkage. The policy lists which update codes propagate (default: 8xx/9xx only). The wallet discloses that a sealed link is kept. (v1)
  - `escrowed_link` — link encrypted to a threshold of auditors, opened only on challenge. (Documented, not built in v1.)
- **Votes: the latest valid ballot counts.** A later ballot from the same card replaces the earlier one, including across epoch resubmissions.
- **Chain state in the enclave (v1).** The host supplies an Arbitrum state root, recorded in every notarization; inputs reference a recent block hash and the enclave rejects state older than the newest one referenced. Full Arbitrum state proofs are later work.
- **Press unchanged in v1.** Notaries share object definitions with the press; the press is not refactored into a notary.
- **Stack.** Enclave runtime, admission checks and templates in Rust (templates compiled to WASM). Parent host in TypeScript on **nitropack**, matching `press/`. Specs and code must always say "AWS Nitro Enclaves" or "nitropack" in full where ambiguity is possible.
- **Real hardware later.** All development and CI run against a local enclave simulator with a test attestation root. David provisions AWS when the feature approaches launch; until then no AWS resources are created.
- **Economics.** Nitro Enclaves add no charge beyond EC2. Graviton instances need only 2 vCPUs. A 3-replica operator is roughly $160/month (3 × c7g.large, us-east-1 on-demand) to $320/month (3 × c7g.xlarge), less with a savings plan. Cost is driven by keeping enclaves alive, not by data volume. With the multi-job runtime, one operator can plausibly serve many communities; the right instance size and per-operator capacity are to be measured in the runtime spike. Variable costs: on-chain notarization and handoff writes (< $0.10 each) and derived-card registry writes.
- **Known limits, to be stated in the spec:** AWS is trusted as the hardware root; the operator controls I/O (can drop inputs or delay close, cannot read or alter them); host-supplied chain state can be stale (recorded per notarization); enclave side channels.

## Goals

- [ ] **G1. Communities can run trusted analyses over members' signed data and get results anyone can verify.** Aggregation, voting, derived cards and revocation propagation all work end to end.
- [ ] **G2. Contributors can confirm, before sharing anything, exactly what code will run on their data, who gets the result, and that the operator cannot read it.**
- [ ] **G3. Activating a notary is lightweight.** A community uses a template policy and an existing operator, with no code and no new infrastructure of its own.
- [ ] **G4. Long-running jobs survive enclave failures, and any data loss is visible and attributable.**
- [ ] **G5. The specs remain the source of truth.** Notaries are fully specified before they are built, tested against the specs, and the AWS dependency is isolated so it can be replaced later.

## Rationale

**G1.** This is the measurement infrastructure Relationality Lab needs: organizers can show funders and partners verified evidence of community strength without surveilling members. Voting and derived cards share the same runtime and objects, so building all three tests whether the abstraction is actually general rather than shaped around one case.

**G2.** A notary's only value is that people trust it with data they would not hand to the organizer. That trust has to be checkable by the contributor's own wallet, not asserted by the operator. The design puts the check at the one point where it enforces something — before encryption — so swapped code never receives plaintext.

**G3.** If every notary needs custom code, an audit and its own deployment, almost no community will use one. Separating program (audited once, reused by CID), policy (a template anyone can instantiate) and operator (a service that competes on reliability, since attestation removes the need to trust it) keeps the per-community cost close to that of issuing an open offer.

**G4.** A vote whose ballots vanish when an EC2 instance restarts is worse than no vote. Because credible deletion means a lost key cannot be recovered, the design must make loss unlikely (replicas, cross-operator for votes) and accountable (receipts, heartbeats, handoff logs) rather than reversible.

**G5.** This repo works spec-first, with consistency reviews (`plans/spec-consistency/`) and spec-derived integration tests. Notaries touch shared objects (`PolicyCardDocument`, wallet SDK consent flow, press issuance, governance artifacts), so ripple effects need to be found deliberately. AWS Nitro is a pragmatic v1 choice, not a protocol commitment, and the spec should say so.

## Key Objectives

**G1 (trusted analyses)**
- [ ] An aggregation job with ≥ k contributors produces a notarization that an independent verifier accepts using only CIDs and chain data; with < k contributors it outputs "insufficient participation."
- [ ] A vote across a voting period produces a tally matching the cast ballots, finalized only after `closes_at` per chain time.
- [ ] A derived card is issued containing only the projected fields, passes standard card verification, and cannot be linked to the source card by the host's records.
- [ ] With `sealed_link`, revoking a source card revokes its derived card within the policy's batching window, and the host's records alone cannot match the two; with `expiry_only`, the derived card lapses at `valid_until`.
- [ ] *(Deferred until David provisions AWS)* All four use cases run on real AWS Nitro Enclaves at least once, not only in the local simulator.

**G2 (contributor assurance)**
- [ ] The wallet SDK rejects each of: wrong PCR0, debug-mode attestation, program hash ≠ `program_cid`, stale or mismatched nonce, notary not in `approved_notaries`, parameters outside `parameter_bounds` — each covered by a test.
- [ ] Contributors can verify inclusion of their input in `input_commitment` using their receipt.
- [ ] The consent screen content is derived entirely from the policy and job; a test confirms requester-supplied text is shown only as labeled requester text.
- [ ] The runtime rejects each class of non-compliant program (disallowed import, threads/shared memory, non-deterministic features, oversize limits, schema mismatch), and refuses to run a non-allowlisted program `shared` — each covered by a test.
- [ ] A deliberately leaky test program cannot exceed the policy's privacy bounds, because k-suppression, clamping and noise are applied by the runtime.

**G3 (lightweight activation)**
- [ ] Three template policies (aggregation, vote, derived card) are published; a community activates each by signing a job, with no code.
- [ ] A new operator can stand up a notary from `notary/` documentation and Docker Compose in under an hour.

**G4 (failure tolerance)**
- [ ] Killing any single replica mid-vote loses no ballots; tests cover re-replication back to `min_live`.
- [ ] Killing all replicas triggers a new epoch, wallets resubmit stored ballots, and the final tally is correct for online voters, counting each card's latest valid ballot.
- [ ] Every key handoff appears in the job log; voters hold enclave-signed receipts proving valid submission.

**G5 (spec-first)**
- [ ] `specs/` contains the notary process and object specs, an ADR in `ARCHITECTURE.md`, and a README section, reviewed before code starts.
- [ ] Integration tests derived from the spec pass against the local simulator and against Nitro.
- [ ] No module outside the attestation verifier and runtime packaging references Nitro-specific formats.

## Open Questions

All resolved 2026-11-11; the answers are recorded in §Design Decisions:

1. Notarization recording — only the fact that the notary acted is public; outputs encrypted to recipients; log entries, EAS optional.
2. Operators — any operator in `approved_notaries`, chosen per job.
3. Replicas — requester's choice, default 3 across availability zones.
4. Derived-card authority — source policies don't limit notaries; the notary vouches.
5. Derived-card revocation — `expiry_only` and `sealed_link` in v1; `escrowed_link` documented. Revocation propagation is now a fourth use case.
6. Vote resubmission — the latest valid ballot counts.
7. Host framework — nitropack.
8. Real hardware — David provisions AWS later; simulator until then.
9. Chain state — record the host-supplied state root; inputs reference a recent block hash; state proofs later.
10. Press refactor — not in v1; shared object definitions only.

Design questions that remain are detailed-design questions (object schemas, on-chain authorization of notaries, which governance body owns the runtime and program lists). They are resolved in Phase 2 of the implementation plan, with David's approval.
