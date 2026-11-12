# Digital Notaries — Implementation Plan

Strategic plan: [notary-strategic-plan.md](notary-strategic-plan.md) — read §Design Decisions before starting any step. All strategic open questions were resolved 2026-11-11.

**Working files this plan produces** (in `plans/`, flat, matching recent plans):
- `notary-spec-impact.md` — Phase 1 scan results
- `notary-design-decisions.md` — Phase 2 detailed design, approved by David
- `notary-spec-changes.md` — Phase 3 change summary for review
- `notary-code-plan.md` — Phase 4 code inventory and build order
- `notary-questions-phase-N.md` — implementation questions asked at the start of each build phase, with David's answers
- `milestones/notary-phase-N-summary.md` — one per milestone review

**Code lives in a new top-level `notary/` directory** (layout set in Phase 4), plus targeted changes to `wallet-sdk/`, `membership_card_verifier/`, `integration_tests/`, and possibly `contracts/`.

**Documentation deliverables:** a "Notaries" section in `README.md` (plain language, same voice as the rest of the README), an ADR in `specs/ARCHITECTURE.md`, and new specs under `specs/`.

**Resuming:** find the first unchecked `- [ ]` step. Checked steps are done; don't redo them.

**Terminology rule for every step:** write "AWS Nitro Enclaves" (or "the enclave") for the TEE and "nitropack" for the web framework. Never bare "Nitro."

## Model recommendations

| Phase | Model | Why |
|---|---|---|
| 1. Scan specs and code | **Sonnet** | Reading and cataloguing against explicit questions |
| 2. Detailed design decisions | **Opus** | Security-critical protocol design: schemas, attestation, handoff, on-chain authorization |
| 3. Write specs | **Opus** for 3.1, 3.3, 3.4, 3.5 and the milestone review; **Sonnet** for the rest | Core process specs carry design judgment; object reference, README and cross-reference edits follow the approved decisions |
| 4. Code plan | **Opus** | Architecture of the runtime, process isolation and package boundaries |
| 5. Build the foundation | **Sonnet**, except **Opus** for 5.3 (broker/worker isolation) | Clear specs exist by then; isolation code needs careful judgment |
| 6. Build the use cases | **Sonnet** for 6.1, 6.2, 6.4; **Opus** for 6.3 (replication) and 6.5 (sealed-link propagation) | Replication and sealed links are the subtlest security code |
| 7. Integration and docs | **Sonnet**; **Opus** for the final review | Spec-derived tests are mechanical; final review checks the whole |
| 8. Real hardware (deferred) | **Sonnet**, escalate to **Opus** for attestation failures | Mostly operational |

Every build phase (5–8) begins with a **questions step**: before writing code, Claude lists the implementation questions the phase raises and waits for David's answers.

---

## Phase 1: Scan existing specs and code — *Sonnet*

Goal: a complete list of every spec and code area that must change or be created, with the section and reason, before anything is edited. Output: `plans/notary-spec-impact.md`.

- [x] **1.1 Scan policy and object specs**
  - **What**: Read `protocol-objects.md §2` (PolicyCardDocument), `§3` (LogEntry), `§6` (OpenCardOffer), `§11` (PressIssuanceRecord), `§14` (CardEntry on-chain), `§15–16` (sub-cards), and `card_protocol_spec.md` §The Press Model and §1 (policy creation, `approved_presses`). For each, note what a notary needs: the `notary` policy section, `approved_notaries`, the notary sub-card, log entries for notarizations, and which objects are new (NotaryJob, NotaryInput, receipts, Notarization, HandoffRecord, Heartbeat, state-blob anchor, propagation batch).
  - **Who**: Claude
  - **Context needed**: the sections above; strategic plan §Design Decisions
  - **Done when**: "§A Objects and policy" in `notary-spec-impact.md` lists each existing object to change and each new object, with the section to edit.

- [x] **1.2 Scan press, registry and contract**
  - **What**: Read `object_specs/press.md`, `object_specs/registry_contract.md`, `ARCHITECTURE.md` ADR-005, ADR-011, ADR-012, and `contracts/logic-contract/src/` (`write_gate.rs`, `card_ops.rs`, `subcard_ops.rs`, `governance_ops.rs`). Determine how a notary sub-card could be authorized to (a) write log entries and (b) register and revoke derived cards on-chain: reuse `PressAuthorizations`, add a role flag, or add a new table. Do not decide; list the options with their consequences.
  - **Who**: Claude
  - **Context needed**: the files above; strategic plan §Design Decisions (derived cards, recording)
  - **Done when**: "§B Press and on-chain authorization" lists the options, the affected contract functions, and whether contract changes are unavoidable.

- [x] **1.3 Scan wallet, verifier and transport**
  - **What**: Read `object_specs/wallet_sdk.md`, `object_specs/wallet.md`, `object_specs/card_verifier.md`, `process_specs/oblivious_transport.md`, `process_specs/open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `card_offering_and_acceptance.md`, `card_validation.md`. List where notary support is added: attestation verification, the consent screen, encrypted input submission over oblivious transport, receipts, automatic resubmission, notarization verification, derived-card verification, sealed-link disclosure.
  - **Who**: Claude
  - **Context needed**: the files above
  - **Done when**: "§C Wallet, verifier, transport" lists each addition with its spec and section.

- [x] **1.4 Scan governance, updates and logs**
  - **What**: Read `governance/README.md`, each body's `mandate.md`, `ARCHITECTURE.md` ADR-011, `update_codes.md`, `process_specs/card_updates.md`, `process_specs/log_auditing.md`. Identify which body could own the accepted-runtime (PCR0) list and the program allowlist, how a signed and logged governance artifact is published today, and which update codes propagate under `sealed_link`.
  - **Who**: Claude
  - **Context needed**: the files above
  - **Done when**: "§D Governance and updates" lists the candidate owners and the existing publishing mechanism.

- [x] **1.5 Inventory reusable code**
  - **What**: Survey `press/src` (HPKE via `hpke-js`, ML-DSA via `@noble/post-quantum`, registry writes via `viem`, nitropack layout), `membership_card_verifier/packages/verifier`, `contracts/protocol-types`, and `integration_tests/` (docker-compose stack, suites, harnesses). Note what the notary host, wallet changes and tests can reuse. Check whether `hpke-js` offers an ML-KEM + X25519 hybrid KEM, and which Rust crates provide the same on the enclave side.
  - **Who**: Claude
  - **Context needed**: the directories above
  - **Done when**: "§E Reusable code" lists each reuse candidate, and the hybrid-KEM library situation on both sides is recorded.

- [x] **1.6 Phase 1 Milestone Review**
  - **What**: Check §A–E for contradictions and for strategic-plan decisions the scan shows won't work as stated. Grep `specs/` for every object and field name to be changed, to catch references outside the scanned files. List the detailed design questions Phase 2 must answer.
  - **Who**: Claude
  - **Context needed**: `notary-spec-impact.md`; strategic plan §Design Decisions
  - **Done when**: contradictions are resolved in place, `milestones/notary-phase-1-summary.md` is written, and the Phase 2 question list is at the end of `notary-spec-impact.md`. If any strategic decision is in doubt, stop at **CP1**.

---

## Phase 2: Detailed design decisions — *Opus*

Goal: settle every design question the specs depend on, and get David's approval, before writing spec text. Output: `plans/notary-design-decisions.md`, one section per topic, each with the decision, the alternatives considered, and the reason.

- [x] **2.1 Object schemas**
  - **What**: Define the fields, signers and canonical serialization (RFC 8785) for: the `notary` section of `PolicyCardDocument` (including `isolation`, `revocation_propagation`, privacy parameters), NotaryJob, job announcement, NotaryInput, host receipt, enclave validation receipt, Notarization, public log entry, HandoffRecord, Heartbeat, state-blob anchor, and propagation batch. Follow the conventions in `protocol-objects.md`.
  - **Who**: Claude, then David reviews
  - **Context needed**: `notary-spec-impact.md §A, §C`; `protocol-objects.md` (conventions, §2, §3, §6); strategic plan §Design Decisions
  - **Done when**: every object has a field table and an example, and every signature names what it covers.

- [x] **2.2 On-chain authorization and governance ownership**
  - **What**: Choose how notary sub-cards are authorized on-chain (from §B's options), and which governance body owns the PCR0 list and the program allowlist (from §D), including how each list is signed, logged and distributed to wallets and runtimes.
  - **Who**: Claude proposes; **David decides**
  - **Context needed**: `notary-spec-impact.md §B, §D`; ADR-011
  - **Done when**: the decision is recorded, with the contract changes it implies.

- [x] **2.3 Attestation and admission**
  - **What**: Specify the wallet's attestation verification algorithm (certificate chain, PCR0, debug check, `user_data` layout, nonce, freshness), the abstraction that lets a simulator backend and an AWS Nitro Enclaves backend share it, and the runtime's program admission checks (exact import list, banned features, limits, output-schema custom section format).
  - **Who**: Claude
  - **Context needed**: strategic plan §Design Decisions (runtime, admission, isolation); `notary-spec-impact.md §C`
  - **Done when**: both algorithms are written as numbered steps with a reject reason for each check.

- [x] **2.4 Runtime architecture and host protocol**
  - **What**: Define the broker/worker split, the broker↔worker protocol, the host↔enclave (vsock) message set, job lifecycle states, per-job limits, zeroization, and the privacy transforms (k-suppression, clamping, bucketing). Decide whether differential-privacy noise ships in v1 or is specified and deferred.
  - **Who**: Claude; **David decides** on DP scope
  - **Context needed**: strategic plan §Design Decisions (multi-job runtime, privacy)
  - **Done when**: a message table and a state diagram exist for both protocols.

- [x] **2.5 Long-running jobs, replication and recovery**
  - **What**: Specify the mutual-attestation key handoff, handoff records, heartbeats, re-replication, epochs and wallet resubmission, the latest-ballot-wins rule (keyed per card, across epochs), chain-anchored close, and the state-blob format with on-chain anchoring and rollback protection used by `sealed_link`.
  - **Who**: Claude
  - **Context needed**: strategic plan §Design Decisions (replication, epochs, close, revocation propagation)
  - **Done when**: each protocol is written as numbered steps, with what an attacker controlling the host can and cannot do at each step.

- [x] **2.6 Derived cards and revocation propagation**
  - **What**: Specify the derived-card nullifier (inputs, period), the anonymity-set check (how the enclave counts cards with the same projected value, given that it only sees the host's chain data), batched issuance, `valid_until` and renewal, and the `sealed_link` watch loop: which registry events the host feeds, the batching window, minimum delay, and propagated codes.
  - **Who**: Claude
  - **Context needed**: strategic plan §Design Decisions (derived cards, revocation propagation); `update_codes.md`
  - **Done when**: both flows are written as numbered steps, and the timing-linkage defenses are stated as parameters with defaults.

- [x] **2.7 Phase 2 Milestone Review**
  - **What**: Check the sections for consistency with each other and with the strategic plan: shared field names, one serialization, no protocol relying on a property another removes. List the threat-model assumptions in one place.
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md`; strategic plan
  - **Done when**: inconsistencies are fixed, `milestones/notary-phase-2-summary.md` is written, and the document goes to David at **CP2**.

---

## Phase 3: Write specs — *Opus for 3.1, 3.3, 3.4, 3.5 and the review; Sonnet for the rest*

Goal: notaries fully specified, consistent with existing specs, and approved before code. Every step uses `notary-design-decisions.md` as its source of truth.

- [x] **3.1 ARCHITECTURE.md: new ADR** *(Opus)*
  - **What**: Add an ADR (next number after ADR-012) titled "Notaries — Attested Computation over Signed Inputs". It covers context, decision, the AWS Nitro Enclaves choice and how to swap it later, the multi-job runtime, trust assumptions and known limits, and alternatives considered: other TEEs, Prio/MPC, zkVM, client-side proofs. Add notary components to the Component Map and the notary flow to Key Data Flows, and update the Table of Contents.
  - **Who**: Claude
  - **Context needed**: `specs/ARCHITECTURE.md` (ADR format, ADR-005, ADR-011); `notary-design-decisions.md`; strategic plan
  - **Done when**: the ADR is present, linked from the TOC and Component Map, and consistent with ADR-005 and ADR-011.

- [x] **3.2 protocol-objects.md: new and changed objects** *(Sonnet)*
  - **What**: Add the `notary` section to §2 PolicyCardDocument and new numbered sections for each new object from 2.1. Update the Object Relationship Summary and the Serialization Quick Reference.
  - **Who**: Claude
  - **Context needed**: `specs/protocol-objects.md`; `notary-design-decisions.md §2.1`
  - **Done when**: every object in 2.1 has a section in the existing format, and serialization examples are given.

- [x] **3.3 Process spec: notary lifecycle** *(Opus)*
  - **What**: Create `specs/process_specs/notary_lifecycle.md`. It covers: operator setup, notary policy creation, job activation and announcement, sharing, contributor verification and consent, input submission and receipts, processing, output routing, and the notarization. Include the three job modes and the aggregation, vote and derived-card flows. Use the same format as `open_offer_creation.md`: actors, preconditions, steps, failure cases.
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md §2.1–2.4, §2.6`; `process_specs/open_offer_creation.md` (format)
  - **Done when**: every step names its actor, its inputs and outputs, and its failure handling.

- [x] **3.4 Process spec: replication and recovery** *(Opus)*
  - **What**: Create `specs/process_specs/notary_replication_and_recovery.md`: the handoff protocol, heartbeats, re-replication, epochs, wallet resubmission, latest-ballot-wins, chain-anchored close, and what happens on total loss.
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md §2.5`
  - **Done when**: written in the same process format, with a threat note at each step.

- [x] **3.5 Process spec: derived-card revocation propagation** *(Opus)*
  - **What**: Create `specs/process_specs/derived_card_revocation_propagation.md`: `expiry_only`, `sealed_link`, and `escrowed_link` (marked "specified, not implemented in v1"), the state blob, batching and delay, and propagated codes.
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md §2.5–2.6`; `update_codes.md`
  - **Done when**: written in process format, with timing-linkage defenses as named parameters.

- [x] **3.6 Object specs: runtime and host; changes to existing object specs** *(Sonnet)*
  - **What**:
    - Create `specs/object_specs/notary_runtime.md` (broker/worker, admission, privacy transforms, attestation backends, limits) and `specs/object_specs/notary_host.md` (nitropack service: endpoints, relay ingress, IPFS and log publishing, registry writes, monitoring).
    - Update `wallet_sdk.md`, `wallet.md`, `card_verifier.md`, `registry_contract.md` (if 2.2 requires it) and `press.md` (cross-references only).
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md`; `notary-spec-impact.md §B, §C`; each target spec
  - **Done when**: each new spec exists in the house format, and each changed spec has a changelog line.

- [x] **3.7 card_protocol_spec.md and governance text** *(Sonnet)*
  - **What**:
    - Add a numbered feature section, "Notaries," to `card_protocol_spec.md`: problem statement, goals, non-goals, user stories for the four use cases, P0/P1/P2 requirements, acceptance criteria and open questions, in the style of the existing sections.
    - Add governance text for the PCR0 list and the program allowlist to the body chosen in 2.2.
    - Add any new update codes to `update_codes.md`.
  - **Who**: Claude
  - **Context needed**: `card_protocol_spec.md` (§1 format); `notary-design-decisions.md §2.2`; the chosen body's `mandate.md`
  - **Done when**: the acceptance criteria map one-to-one onto the strategic plan's Key Objectives.

- [x] **3.8 README.md: Notaries section** *(Sonnet)*
  - **What**: Add a "Notaries" subsection under §Core Flows (what a notary does, using the running-club voice and examples already in the README: a club health check, a vote, an "anonymous member" card). Add a "Notary" entry under §Protocol Components, and link the new specs from §Specification. Plain language, no cryptographic detail.
  - **Who**: Claude
  - **Context needed**: `README.md` (full, for voice); strategic plan §Starting point
  - **Done when**: the section reads consistently with the surrounding README, and every spec link resolves.

- [x] **3.9 Phase 3 Milestone Review and spec-change summary** *(Opus)*
  - **What**: Run a consistency pass in the style of `plans/spec-consistency/` across every file touched in 3.1–3.8: field names, object numbers, cross-links, and terminology (no bare "Nitro"). Write `plans/notary-spec-changes.md` summarizing every change by file, for David's review.
  - **Who**: Claude
  - **Context needed**: all files changed in Phase 3; `notary-design-decisions.md`
  - **Done when**: no inconsistencies remain, `milestones/notary-phase-3-summary.md` is written, and David approves at **CP3**.

---

## Phase 4: Code plan — *Opus*

- [x] **4.1 Lay out `notary/` and the cross-repo changes**: `notary-code-plan.md`, **approved by David at CP4, 2026-11-12**
  - **What**: Write `plans/notary-code-plan.md`. Proposed layout, to be confirmed:
    - `notary/runtime/` — Rust: broker, worker, attestation backends (AWS Nitro Enclaves NSM and simulator), HPKE, admission checks, privacy transforms, wasmi execution
    - `notary/lint/` — `notary-lint` CLI, sharing the admission crate
    - `notary/templates/` — Rust → WASM: `aggregate`, `vote`, `derive`
    - `notary/sim/` — local enclave simulator with a test attestation root
    - `notary/host/` — nitropack TypeScript service
    - `notary/deploy/` — docker-compose and the reproducible enclave image (EIF) build
    - `notary/README.md` and `notary/OPERATOR.md`

    It also lists the changes to `wallet-sdk/`, `membership_card_verifier/`, `contracts/` (if 2.2 requires them) and `integration_tests/suites/notary/`, with the build order, test strategy per package, and the spec section each module implements.
  - **Who**: Claude
  - **Context needed**: `notary-spec-changes.md`; `notary-spec-impact.md §E`; `press/` layout; `integration_tests/README.md`
  - **Done when**: every spec requirement maps to a module and a test, and David approves at **CP4**.

---

## Phase 5: Build the foundation — *Sonnet (5.3 Opus)*

Goal: one end-to-end path running in the simulator: a job is announced with an attestation, a wallet verifies it and submits an encrypted input, the enclave processes it, and a notarization is published.

- [x] **5.0 Phase 5 questions**
  - **What**: Read the Phase 5 parts of `notary-code-plan.md` and list every implementation question (library choices, interface details, ambiguities in the specs) in `plans/notary-questions-phase-5.md`. Ask David, and **wait for answers before writing code** (**CP5**).
  - **Who**: Claude, then David
  - **Context needed**: `notary-code-plan.md`; the relevant specs
  - **Done when**: every question has an answer recorded in the file.

- [x] **5.1 Shared object types and serialization**
  - **What**: Implement the new objects from `protocol-objects.md` as TypeScript types and Rust structs, with RFC 8785 canonicalization and test vectors, following `serialization-conformance.json`.
  - **Who**: Claude
  - **Context needed**: `protocol-objects.md` (new sections); `specs/serialization-conformance.json`
  - **Done when**: the TS and Rust implementations produce identical bytes for all test vectors.

- [x] **5.2 Simulator and attestation backends**
  - **What**: Build `notary/sim` (test root CA, attestation documents in the AWS Nitro Enclaves format, configurable PCRs and debug flag) and the runtime's attestation abstraction with simulator and NSM backends. The NSM backend is written now but tested only in Phase 8.
  - **Who**: Claude
  - **Context needed**: `notary_runtime.md` (attestation); `notary-design-decisions.md §2.3`
  - **Done when**: the runtime can request per-job attestations from the simulator, and the documents parse with the same code that will parse real ones.

- [ ] **5.3 Runtime core: broker, workers, admission, privacy** *(Opus)*
  - **What**: Implement the broker (per-job keygen, HPKE decryption, key custody, zeroization), the worker processes (wasmi execution, fuel and memory limits), the admission checks, the privacy transforms, the per-job single-use output, and the host protocol. Build `notary/lint` on the shared admission crate.
  - **Who**: Claude
  - **Context needed**: `notary_runtime.md`; `notary-design-decisions.md §2.3–2.4`
  - **Done when**: unit tests cover every admission reject reason, key isolation between jobs, and the privacy transforms, including a deliberately leaky test program.

- [ ] **5.3a Card checks in Rust (`notary-cards`)** *(Opus; added at CP4)*
  - **What**: Port the verifier logic that B1–B11 need into `notary-cards` (`notary-code-plan.md` §7.5). Build the TypeScript vector generator, the CI regeneration check and the coverage map.
  - **Who**: Claude
  - **Context needed**: `card_verifier.md` Stages 2–5; `card_validation.md`; `notary_lifecycle.md` Appendix B; `notary-code-plan.md` §7.5
  - **Done when**: `notary-cards` agrees with every TypeScript-generated vector, the coverage map is complete, and CI fails on a deliberately stale vector set.

- [x] **5.4 Wallet SDK and verifier support**
  - **What**: Add to `wallet-sdk`:
    - the attestation verifier (one module per platform: simulator and AWS Nitro Enclaves)
    - the policy checks and consent-screen model, built from the policy only
    - HPKE input submission over oblivious transport
    - receipt storage and inclusion checks

    Add notarization verification to `membership_card_verifier`.
  - **Who**: Claude
  - **Context needed**: `wallet_sdk.md` and `card_verifier.md` (notary sections); `notary_lifecycle.md`
  - **Done when**: tests reject each failure case in strategic-plan objective G2.

- [ ] **5.5 Host service**
  - **What**: Build `notary/host` on nitropack: job intake and validation against the policy, enclave job creation, announcement publishing (IPFS and wallet service), ciphertext ingress via the relay with receipts, feeding chain state, notarization publishing, log entries, and notary sub-card setup. Add it to `notary/deploy` docker-compose.
  - **Who**: Claude
  - **Context needed**: `notary_host.md`; `press/` (patterns for nitropack, `viem`, IPFS)
  - **Done when**: the end-to-end path above runs in docker-compose against the simulator.

- [ ] **5.6 Capacity benchmark**
  - **What**: Measure inputs per second, per-job memory and close-time recomputation for 1,000 and 10,000 inputs, with many concurrent jobs, in the simulator. Record the results and a provisional instance-size recommendation in `notary-code-plan.md`.
  - **Who**: Claude
  - **Context needed**: the runtime from 5.3
  - **Done when**: the numbers are recorded, and any result contradicting the strategic plan's economics is flagged to David.

- [ ] **5.7 Phase 5 Milestone Review**
  - **What**: Check that the code matches the specs (names, objects, checks), that test coverage maps to the specs, and that nothing outside the attestation modules and image packaging references AWS-specific formats.
  - **Who**: Claude
  - **Context needed**: Phase 5 code; `notary-code-plan.md`; the relevant specs
  - **Done when**: deviations are fixed in code or recorded as spec errata for David, and `milestones/notary-phase-5-summary.md` is written.

---

## Phase 6: Build the use cases — *Sonnet (6.3 and 6.5 Opus)*

- [ ] **6.0 Phase 6 questions**
  - **What**: Same as 5.0, for Phase 6, in `plans/notary-questions-phase-6.md`. **Wait for answers** (**CP5**).
  - **Who**: Claude, then David
  - **Context needed**: `notary-code-plan.md`; Phase 5 summary
  - **Done when**: every question has an answer recorded.

- [ ] **6.1 Aggregation template**
  - **What**: Build the `aggregate` template and policy, the one-shot job mode, the input commitment, and receipt inclusion checks. Build `notary-messaging` (ADR-007 encryption in Rust) for private `statement` outputs *(added at CP4)*.
  - **Who**: Claude
  - **Context needed**: `notary_lifecycle.md` (aggregation); `notary_runtime.md`
  - **Done when**: tests cover the k-suppression path, an independently verified notarization, and a private output readable only by its listed recipients.

- [ ] **6.2 Voting template and long-running jobs**
  - **What**: Build the `vote` template and policy: stored ciphertexts recomputed at close, enclave validation receipts, latest valid ballot counts (keyed per card), chain-anchored close, epochs and wallet resubmission.
  - **Who**: Claude
  - **Context needed**: `notary_lifecycle.md` (vote); `notary_replication_and_recovery.md` (epochs, close)
  - **Done when**: tests cover ballot replacement, close before and after `closes_at`, and an epoch restart with resubmission.

- [ ] **6.3 Replication** *(Opus)*
  - **What**: Implement the mutual-attestation handoff (P1–P5), handoff records, heartbeats and re-replication, with replicas across separate simulated hosts. Also implement runtime upgrades (rolling handoff, `close_compat`, `runtime_migration` epochs) and key exposure (lineage, algorithm E, `key_exposure` epochs) *(added during CP4 review)*.
  - **Who**: Claude
  - **Context needed**: `notary_replication_and_recovery.md`; `notary-design-decisions.md §2.5`
  - **Done when**: tests cover:
    - killing one replica mid-vote with no ballots lost;
    - re-replication back to `min_live`;
    - a refused handoff for each mismatch case;
    - every handoff appearing in the log;
    - a rolling upgrade of a live vote with no ballots lost;
    - an incompatible upgrade by migration epoch;
    - an emergency retirement that makes the notary card unusable and re-keys its jobs.

- [ ] **6.4a Registry write-gate calldata binding** *(added at CP4; requires CP7)*
  - **What**: Implement `registry_contract.md §6.1` step 8 (every signed field must equal the calldata, error E-49) in the logic contract and verifier module, with Rust unit tests and a devnode test. Write no code until David approves at CP7. Deploying anywhere other than the local devnode is a separate CP7 approval.
  - **Who**: Claude, after David approves
  - **Context needed**: `registry_contract.md §6.1`; `contracts/` conventions; memory note on Stylus ABI conventions
  - **Done when**: the E-49 tests pass, existing contract tests still pass, and the devnode stack uses the new contract.

- [ ] **6.4 Derived-card template**
  - **What**: Build the `derive` template and policy: per-input mode with key rotation each period, `dup_tag` (including re-seeding by generation), the anonymity-set check, batched issuance through the notary acting as press, `expires_at` with renewal, and the `source_kind` refusal. Depends on 5.3a and 6.4a.
  - **Who**: Claude
  - **Context needed**: `notary_lifecycle.md` (derived cards); `notary-design-decisions.md §2.6`; `press.md` (issuance)
  - **Done when**: derived cards pass standard verification, and tests show duplicate refusal and the anonymity-set refusal.

- [ ] **6.5 Revocation propagation** *(Opus)*
  - **What**: Implement `expiry_only` and `sealed_link`: the state blob with on-chain anchoring and rollback refusal, the registry watch loop, batched and delayed revocation release, and the propagated-code filter. Add the sealed-link disclosure in the wallet.
  - **Who**: Claude
  - **Context needed**: `derived_card_revocation_propagation.md`; `notary-design-decisions.md §2.5–2.6`
  - **Done when**: tests cover revocation within the batching window, refusal of a rolled-back blob, and lapse at expiry for `expiry_only`.

- [ ] **6.6 Phase 6 Milestone Review**
  - **What**: Check the four use cases for consistency (shared runtime paths, objects and receipts), and map tests to the strategic-plan objectives under G1 and G4.
  - **Who**: Claude
  - **Context needed**: Phase 6 code and tests; strategic plan §Key Objectives
  - **Done when**: `milestones/notary-phase-6-summary.md` lists each objective with its covering tests, and any gaps are fixed.

---

## Phase 7: Integration, conformance and docs — *Sonnet (7.4 Opus)*

- [ ] **7.0 Phase 7 questions**
  - **What**: Same as 5.0, for Phase 7. **Wait for answers** (**CP5**).
  - **Who**: Claude, then David
  - **Context needed**: Phase 6 summary; `integration_tests/README.md`
  - **Done when**: every question has an answer recorded.

- [ ] **7.1 Spec-derived integration suite**
  - **What**: Add `integration_tests/suites/notary/` against the docker-compose stack, with one test per acceptance criterion in the `card_protocol_spec.md` Notaries section, following `integration-testing-strategic-plan.md`. Add the governance and EAS scripts (`notary-code-plan.md` §3.6) and run them against the devnode only. Deploy EAS into the stack, with a test-only mock anchor if EAS won't deploy *(added at CP4)*.
  - **Who**: Claude
  - **Context needed**: `card_protocol_spec.md` (Notaries); `integration_tests/` conventions
  - **Done when**: every acceptance criterion has a passing test.

- [ ] **7.2 Adversarial suite**
  - **What**: Add hostile-operator tests:
    - wrong PCR0, debug attestation, mismatched program, replayed nonce
    - a non-allowlisted program asking for shared isolation
    - a leaky program
    - dropped inputs (detected via receipts)
    - stale chain state
    - killing every replica
    - rollback of the sealed-link blob
    - timing correlation in derived-card issuance and revocation
  - **Who**: Claude
  - **Context needed**: `notary-design-decisions.md` (threat assumptions); the process specs
  - **Done when**: each attack is either refused or detected, as the spec says it should be.

- [ ] **7.3 Operator docs**
  - **What**: Write `notary/README.md` (what's in the directory, how to run it locally) and `notary/OPERATOR.md` (standing up a notary, sizing and cost, monitoring, upgrading the runtime when governance updates the PCR0 list), modeled on `press/OPERATOR.md`.
  - **Who**: Claude
  - **Context needed**: `press/OPERATOR.md`; `notary_host.md`; capacity numbers from 5.6
  - **Done when**: a fresh reader can run the full local stack from the docs alone. Claude checks this by following them in a clean checkout.

- [ ] **7.4 Final Milestone Review** *(Opus)*
  - **What**: Check the specs, code, README, the ARCHITECTURE ADR and the docs against each other. Tick the strategic-plan objectives that are met, and mark the real-hardware objective as deferred.
  - **Who**: Claude
  - **Context needed**: all phase summaries; strategic plan; changed specs
  - **Done when**: `milestones/notary-final-summary.md` is written and the strategic plan's checkboxes are updated.

---

## Phase 8: Real hardware — *Sonnet; deferred until David provisions AWS*

- [ ] **8.0 Phase 8 questions and go-ahead**
  - **What**: Confirm the AWS account, region, instance types and budget cap with David. **Create no AWS resources until he says to** (**CP8**).
  - **Who**: David decides
  - **Context needed**: `notary/OPERATOR.md`; 5.6 capacity numbers
  - **Done when**: written go-ahead, with a budget cap.

- [ ] **8.1 Reproducible enclave image and PCR0 publication**
  - **What**: Build the enclave image (EIF) reproducibly in `notary/deploy`, confirm two independent builds give the same PCR0, and publish it to a test governance list.
  - **Who**: Claude, with David publishing
  - **Context needed**: `notary/deploy`; governance text from 3.7
  - **Done when**: the PCR0 matches across rebuilds and appears on the test list.

- [ ] **8.2 Run the use cases on AWS Nitro Enclaves**
  - **What**: Run aggregation, a vote with three replicas across availability zones (including killing a replica), derived-card issuance and a sealed-link revocation on real instances. Measure capacity and cost against the strategic plan's economics.
  - **Who**: Claude
  - **Context needed**: integration suite from 7.1; `notary/OPERATOR.md`
  - **Done when**: all four pass, the numbers are recorded, instances are shut down, and the deferred objective is ticked.

---

## Clarification Checkpoints

Stop and check with David when:

- **CP1 — A decision doesn't survive the specs.** Phase 1 finds that a strategic-plan decision conflicts with existing spec behavior in a way that can't be resolved within the new text alone.
- **CP2 — Design approval (required).** After Phase 2, before any spec text: David reviews `notary-design-decisions.md`, including the on-chain authorization and governance-ownership decisions.
- **CP3 — Spec approval (required).** After Phase 3, before any code: David reviews `notary-spec-changes.md`.
- **CP4 — Code plan approval (required).** After Phase 4, before Phase 5.
- **CP5 — Implementation questions (required, every build phase).** Steps 5.0, 6.0, 7.0 and 8.0: Claude asks its questions and writes no code for that phase until they're answered. Questions that come up mid-phase and affect security or a spec are asked immediately, not guessed.
- **CP6 — Breaking shared objects.** Before changing `CardDocument`, `PolicyCardDocument`, `SubCardDocument` or `LogEntry` in a way that breaks existing tests or already-registered cards.
- **CP7 — Contracts and on-chain actions.** Before any change under `contracts/`, and before any testnet or mainnet transaction or governance-list publication.
- **CP8 — AWS and spending.** No AWS resources are created, and nothing that costs money is started, without David's explicit go-ahead and budget cap.
- **CP9 — Security deviations.** If a required primitive or library isn't workable (e.g. no usable hybrid ML-KEM HPKE, wasmi unsuitable, a vsock or NSM limitation), or if implementation would weaken a guarantee in the specs, stop and propose options. Don't substitute quietly.
- **CP10 — Out-of-scope bugs.** Bugs found outside notary code (verifier, press, messaging) are reported, not fixed.
- **CP11 — Git.** Commit or push only when David asks.
