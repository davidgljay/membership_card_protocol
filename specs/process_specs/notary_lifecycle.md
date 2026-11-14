# Notary Lifecycle — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Objects:** `protocol-objects.md` §2.1, §2.2, §20–§34 · **Design record:** `plans/notary-design-decisions.md` (approved at CP2)
**Amended 2026-11-12:** new Appendix A.7, algorithm R (policy and requester reads, over vsock only); step 17 and W3–W5 point to it. L4 and T7 restated (a single-operator quorum can count forged contributors), with a consent disclosure (step 25), the `SINGLE_OPERATOR_QUORUM` warning in N, and the governance switch in W7 (`JOB_SINGLE_OPERATOR_REFUSED`) and in N (`NOT_SINGLE_OPERATOR_REFUSED`); enclaves don't enforce it (E34). Source: `plans/notary-spec-wording-e31.md`, approved by David 2026-11-12.

**Amended 2026-11-13 (5.7 review):** Appendix B, B3: no wait for headers; the wallet retries (Q3). Source: `plans/notary-questions-5.7.md`, David approved 2026-11-13 (`plans/notary-questions-5.7.md`).

**Amended 2026-11-12 (batch 2):** step 5 offer includes `genesis_request`, and A.3 step 0 lets later verifiers recompute the nonce (E17); step 9 writes identity-log `seq` 0 as `opened`, and A.6 requires it (E26); A.1 step 10, W13 and N6 say which bound fields aren't compared (E10, E13); W10 says how `issuer_card` names the policy (E11). Source: `plans/notary-spec-wording-batch2.md`, approved by David 2026-11-12.

> **Terminology.** "The enclave" means an AWS Nitro Enclaves enclave. "Enclave attestation" means the AWS Nitro Enclaves attestation document, which is not the App Attest / Play Integrity attestation of `subcards.md`. "nitropack" is the web framework the notary host runs on. See the terminology note in `ARCHITECTURE.md`.

---

## Overview

A **notary** observes signed statements from card holders, runs a program a policy names, signs the result, and discards the inputs. The operator runs it, but can't read the inputs or change the result. The program runs inside an enclave whose code each contributor's wallet checks, through an enclave attestation, **before** encrypting anything.

This spec covers a notary from operator setup to a verified result:

| Phase | What happens |
|---|---|
| 0 | Operator setup |
| 1 | Notary policy creation |
| 2 | Job activation and announcement |
| 3 | Sharing |
| 4 | Contributor verification and consent |
| 5 | Input submission and receipts |
| 6 | Processing and close |
| 7 | Output routing and the notarization |

It then gives the aggregation, vote and derived-card flows, the error codes, and the notary threat model.

Two companion specs cover the rest:
- `notary_replication_and_recovery.md`: replica sets, key handoff, quorum acknowledgment and close, epochs and resubmission.
- `derived_card_revocation_propagation.md`: derived-card issuance in full, and revocation propagation.

**Job modes.**

| Mode | Policy `notary.mode` | Behaviour | Used for |
|---|---|---|---|
| One-shot aggregate | `aggregate` | Inputs collected until `closes_at`. One output computed from all counted inputs. Keys erased. | Aggregation (e.g. how much members talk to one another) |
| Long-running aggregate | `aggregate`, with `input_replacement: "latest_wins"` | As above. Ballots can be revised until close. Ciphertexts are stored outside the enclave and the result is **recomputed from all inputs at close**; no running tally exists. | Votes |
| Per-input | `per_input` | A standing job. One output per input. The job key rotates every `key_period`. | Derived cards |

---

## Actors

| Actor | Role |
|---|---|
| **Policy holder** | Holds the notary policy card. Issues notary cards to operators and maintains `approved_notaries`. For template policies (`protocol-objects.md §2.2`) this is the PressRegistryBody. |
| **Operator** | Runs a notary host and enclaves, and holds an ordinary card (`operator_card`) that makes it accountable |
| **Notary host** | The operator's nitropack service. Runs the oblivious-transport gateway, serves announcements, stores sealed inputs, supplies chain data, pins records, submits EAS anchors and chain writes. **Untrusted** for confidentiality and integrity (threat model below). |
| **Enclave (broker and workers)** | The measured runtime (`object_specs/notary_runtime.md`). The broker holds every key and checks inputs. Workers run the program. |
| **Job requester** | Signs a `NotaryJob`. Must satisfy `notary.job_requester_predicate`, if the policy sets one. |
| **Contributor** | A card holder whose wallet verifies the job and submits a signed, encrypted input |
| **Relay** | The oblivious forwarder (`oblivious_transport.md`). It sees the contributor's IP address but not the job or the content. |
| **Output recipients** | Parties listed in `notary.output_recipients`, or the public |
| **Verifier** | Anyone checking a notarization or a derived card (`card_verifier.md`) |
| **Governance (PressRegistryBody)** | Maintains the accepted-runtime list and program allowlist (`protocol-objects.md §34`), `NotaryCardPolicy`, and the template policies |

---

## Preconditions

- `NotaryCardPolicy` is registered (`RegisterPolicy`) and has an approved press.
- The two governance list cards exist, and the runtime's PCR0 is on the accepted-runtime list.
- The program (`notary.program_cid`) is pinned on IPFS. It is on the program allowlist if `isolation` is `"shared"`.
- The relay knows the notary host's `target_id`.
- For a derived-card template policy:
  - `RegisterPolicy(T)` has been done.
  - `AuthorizePress(T, notary card, chain_pubkey, keccak256(K_id))` has been done for each operator.
  - The write-gate calldata binding (`registry_contract.md §6.1`) is fixed. Derived cards must not ship before it is.
- The EAS job-log schema is registered on Arbitrum One.

---

## Steps

Each step names its **actor**, what it takes and produces, and how failure is handled. Error codes are listed in §Error Paths.

### Phase 0: Operator setup (notary genesis)

1. **Operator host → enclave.** The host boots an enclave and sends `hello` with a challenge. The enclave generates its instance key `K_inst` and returns a purpose-`0x03` attestation (`protocol-objects.md §33`).
   - *Failure:* the attestation does not verify locally; the host is misconfigured. Stop.
2. **Operator.** Builds a **genesis request** (`protocol-objects.md §20`) naming the notary policy, its `operator_card`, its `operator_host_pubkey` (`K_host`) and the platform, and sends it to the enclave.
3. **Enclave.** Generates the notary identity key `K_id` (ML-DSA-44) and chain key `K_chain` (secp256r1). Fills `id_pubkey` and `chain_pubkey` into the request. Requests a purpose-`0x01` attestation with `nonce = H(genesis request)`. Neither private key ever leaves the enclave.
4. **Operator → policy holder.** Sends the genesis request and the attestation.
5. **Policy holder's wallet.** Runs **algorithm G** (§Appendix A.3) with `max_age` = 7 days. If G passes, it builds the notary card offer:
   - `policy_id` = `NotaryCardPolicy`;
   - `issuer_card` = the notary policy;
   - `recipient_pubkey` = `id_pubkey`;
   - the fields `operator_card`, `operator_host_pubkey`, `chain_pubkey`, `platform`, `genesis_attestation` and `genesis_request` (the CID of the pinned request).

   It then signs `issuer_signature`.
   - *Failure:* G fails. Reject with the G code and don't issue.
6. **Enclave.** Checks that the offer names its own `K_id`, `K_chain` and genesis attestation, then countersigns (`holder_signature`) with `K_id`.
   - *Failure:* `NOT_GENESIS_MISMATCH`. Refuse.
7. **A press for `NotaryCardPolicy`.** Validates and registers the notary card.
8. **Policy holder.** Adds the card to `approved_notaries` (code 300 on the policy card).
   - For a template policy, governance also submits `AuthorizePress`. That is a CP7-class on-chain action, done once per (template, operator).
9. **Enclave.** Writes the first identity-log record (`protocol-objects.md §28`, `type: "notary.identity_log.v1"`): `seq` 0, kind `opened`, body `{ "attestations": [<genesis_attestation>] }`. The enclave writes it when it countersigns (step 6), since it isn't told when the card is registered and the record doesn't depend on registration. It opens no job and issues no derived card for this notary card until it has seen that record's anchor (`IDENTITY_LOG_PENDING`, `notary_runtime.md §16`). The operator then forms its identity replica set by identity-scope handoff (`notary_replication_and_recovery.md`).

**Postcondition:** an approved notary card whose key exists only inside the operator's enclaves.

### Phase 1: Notary policy creation

10. **Policy author.** Writes a `PolicyCardDocument` with a `notary` section (`protocol-objects.md §2.1`). For aggregation and voting, `field_definitions` is `[]`. Communities don't author derived-card policies; they use governance template policies (§2.2).
11. **Policy author.** Runs `notary-lint` on the policy and the program. Lint runs the same admission checks the runtime will (algorithm A, `notary_runtime.md`) and warns about weak privacy settings:
    - an integer output with no `round_to` or `buckets` when `k_min < 10`;
    - a `contributor_predicate` with no policy that can be snapshotted (§Phase 5, step 31).
    - *Failure:* any `ADM_*` error. Fix the policy or program before issuing.
12. **Policy authorizer, policy holder and a press.** The policy card is issued as any policy is (`policy_creation.md`). A notary policy whose cards are never registered under it (aggregation, vote) needs **no** `RegisterPolicy` and no `AuthorizePress`.
13. **Policy holder.** Issues notary cards to the chosen operators (Phase 0, steps 4–8).

### Phase 2: Job activation and announcement

14. **Job requester.** Builds and signs a `NotaryJob` (`protocol-objects.md §21`). It contains:
    - `policy_id`, plus `policy_state_cid` (the policy's current head);
    - `replica_set` and `min_live`, with q ≤ `min_live` ≤ N, where q = ⌊N/2⌋ + 1;
    - `parameters`, `opens_at`, and `closes_at` (aggregate) or `key_period` and `ends_at` (per-input);
    - `kem: "x-wing-draft-06"`, and an optional `requester_text`.

    It computes `job_hash = H(job)` and pins the job to IPFS.
15. **Requester → operator hosts.** Sends the job to the host of each operator in `replica_set`.
16. **Host → enclave.** Sends `create_job` with the job and the program bytes.
17. **Enclave (originator).** Repeats the wallet's job checks W2–W10 (Appendix A.2), plus a check that its own notary card is in `replica_set`. It reads the policy with **algorithm R** (Appendix A.7) and, when `job_requester_predicate` is present, the requester's chain the same way. Everything comes over vsock (`fetch`), checked by CID, and the enclave makes no network connection. Runs program admission (algorithm A). **Only then** generates the job key `K_job,0` (X-Wing) and requests a purpose-`0x02` attestation (`public_key` = `SHA-256(K_job public key)`, `nonce = job_hash`).
    - *Failure:* `job_rejected` with the W or `ADM_` code. No key is created.
18. **Enclaves.** The originator hands `K_job,0` to the other replicas until a quorum q holds it (`notary_replication_and_recovery.md`, forming the replica set). Each receiver attests with purpose `0x02` for the same key.
19. **Job leader enclave.** Writes the `opened` job-log record listing the attestations, and waits for its EAS anchor.
    - *Failure:* no anchor arrives. The job never opens, and the host is responsible.
20. **Job leader enclave → host.** Signs a `JobAnnouncement` (`protocol-objects.md §22`) for epoch 0. The host serves it at `GET /jobs/{job_hash}/announcement` and pins it.
21. **Every live replica, about every 6 hours.** Re-attests with the same key. The leader re-issues the announcement with the fresh attestations (same epoch, later `issued_at`).

### Phase 3: Sharing

22. **Job requester.** Shares the link `mcard://notary-job?j=<job_hash>&h=<relay target_id>`, by message, QR code, or posting.
23. **Contributor's wallet.** Fetches the announcement from the notary host **through the relay** (oblivious transport), so the host doesn't learn the contributor's IP address.
    - *Failure:* unreachable or not found. Retry, then show "job unavailable".

### Phase 4: Contributor verification and consent

24. **Wallet.** Runs **algorithm W** (Appendix A.2) on the newest announcement for the highest epoch it can find. Every check must pass before anything is encrypted.
    - *Failure:* any W or `ATT_` code. Show the reason and submit nothing.
25. **Wallet.** Builds the consent screen **from the policy (current head) and the job only**:
    - what is collected (`input_schema`);
    - what is computed (the program's allowlist name and audit, or "custom program — not independently audited");
    - who receives the output (`output_recipients`);
    - the privacy bounds (`k_min` and the output transforms);
    - the notary operators and their platform;
    - if the job has a single-operator quorum (L4): "One operator runs enough of this job's notaries to close it alone. The count can include contributors that operator invents. Your own input stays private either way."
    - the close time;
    - for derived cards, the disclosure lines in `derived_card_revocation_propagation.md`.

    If the step-31 fallback applies, it also shows: "The operator will learn that your card took part." `requester_text` appears only in a box labelled as the requester's own words.
26. **Contributor.** Approves or declines.
    - *Declined:* nothing is sent.

### Phase 5: Input submission and receipts

27. **Wallet.** Builds a `NotaryInput` (`protocol-objects.md §23`):
    - `contributor_card` = the contributor's master card;
    - `payload`, validated locally against `input_schema`;
    - `revision` (0, or the previous revision + 1 under `latest_wins`);
    - `chain_ref` = a recent block the wallet has seen;
    - `evidence` = the bytes of every IPFS object needed to check the contributor's card chain.

    It signs with a sub-card that has the `"notary_input"` capability.
28. **Wallet.** Seals the input to `K_job,epoch` (`protocol-objects.md §24`). It wraps the result in the oblivious-transport envelope (`path: /jobs/{job_hash}/inputs`) to the host's gateway key and sends it through the relay.
29. **Wallet.** **Stores the signed `NotaryInput`** until it has seen a valid notarization for the job, plus 7 days. It needs it for resubmission after a new epoch.
30. **Host.** Stores the `SealedInput` and signs a `HostReceipt` (`protocol-objects.md §25`). Then it passes `submit_input` to one of its enclaves holding the job.
31. **Enclave (receiver).** Runs input validation **B1–B11** (Appendix B). It reads card documents only from `evidence`, and registry state only from **policy snapshots**: complete registry state for every card under each policy the job depends on, kept current by the host. It never asks for a single card by address.
    - **Fallback.** A `contributor_predicate` with no `issued_under_template` policy can't be served from snapshots. The broker then fetches by address. The consent screen (step 25) has already said so.
32. **Enclave (receiver).** Forwards the sealed input to the other live replicas. Each runs B1–B11 itself and returns a signed acknowledgment. Once q replicas agree, the receiver signs a `ValidationReceipt` (`protocol-objects.md §26`) with `acks ≥ q`. Plaintext is zeroized whatever the result.
    - *Failure:* fewer than q acknowledgments within 60 s. No validation receipt; the wallet retries.
33. **Host → wallet.** Returns `{ host_receipt, receipt_sealed }` through the outer envelope. `receipt_sealed` is encrypted under a key exported from the inner HPKE context, so the host can't read whether the input was accepted.
34. **Wallet.** Checks both signatures:
    - the host receipt against `operator_host_pubkey`;
    - the validation receipt against the notary card's `K_id`.

    It then stores them.
    - *Failure:* no validation receipt within 10 minutes. Fetch the announcement again and resubmit. If the epoch has changed, follow `notary_replication_and_recovery.md` (resubmission).
35. **Revising (`latest_wins` only).** A contributor may submit again with a higher `revision` until close. The earlier input becomes `superseded`.

### Phase 6: Processing and close

**Aggregate jobs.**

36. **Every replica.** Waits until **both** a verified block header **and** a fresh NSM attestation timestamp are ≥ `closes_at`. A host can delay close but can't bring it forward.
37. **Hosts → enclaves.** Each host streams every stored `SealedInput` for the final epoch to its own replica (`close_chunk`).
38. **Job leader enclave.** Computes the result:
    1. Decrypts each input and re-runs B2–B10 against the closing chain state. A card revoked before close isn't counted.
    2. Keeps the highest accepted `revision` per contributor root key.
    3. Counts any accepted `input_hash` the host didn't supply as `dropped_after_acceptance`.
    4. If fewer than `k_min` contributors are counted, the output is `{ "insufficient_participation": true }` and the program doesn't run.
    5. Otherwise it runs the program once on the counted payloads, sorted by `input_hash`.
    6. Checks and transforms the output (Appendix B, output checks).
39. **Other replicas.** Each recomputes from its own host's ciphertexts and co-signs `H(body)` only if its counted set and output hash match. A replica never co-signs two bodies for one job. The leader needs q cosignatures (`notary_replication_and_recovery.md`, quorum close).
    - *Failure:* mismatch. The job stays in `CLOSING` and every operator is alerted.

**Per-input jobs.**

40. **Enclave.** For each accepted input, runs the program with that single payload, checks and transforms the output, and queues it for the job's output action. For derived cards that means the issuance pool (`derived_card_revocation_propagation.md`). At each `key_period` it rotates to a new epoch. The old key is kept for a one-hour grace window, then erased.

### Phase 7: Output routing and the notarization

41. **Job leader enclave.** Builds the `Notarization` (`protocol-objects.md §27`) with the cosignatures, and signs it with `K_id`. Asks the host to pin it and the `counted_inputs` list.
42. **Job leader enclave.** Writes the `notarized` job-log record. The host anchors it with EAS.
43. **Output routing** (`statement` jobs). The policy decides, never the program:
    - **public:** the value is in `notarization.output.public`;
    - **private:** the enclave encrypts the value to each recipient's sub-card keys as a `notary_output` card message signed by `K_id` (`message_routing.md` §Sender-Side Fan-out). The host relays the ciphertexts.
44. **Every replica.** Once it sees the `notarized` record, it erases `K_job`, the dedupe index, and every buffer.
45. **Contributors.** Each wallet checks that its latest accepted `input_hash` is in `counted_inputs`, and that the Merkle root matches `input_commitment`.
    - *Failure:* missing. The contributor holds a host receipt and a validation receipt with `acks ≥ q`, which attribute the drop to the operator.
46. **Anyone.** Verifies the notarization with **algorithm N** (Appendix A.4), using only CIDs and chain data.

---

## Use-case flows

### Aggregation

- **Example:** a club health check asking how many members a person spoke to this month.
- **Policy:** `mode: "aggregate"`, `input_replacement: "reject_duplicates"`, an allowlisted aggregation template, `output_schema` with `clamp` and `round_to` or `buckets`, `k_min` ≥ 5, `output_recipients: { "job_requester": true }`.
- **Phases:** 2 → 5 → 6 (aggregate) → 7 (private output to the requester).
- **What becomes public:** the job log, the counts, and the input commitment. Not the result.

### Vote

- **Policy:** `mode: "aggregate"`, `input_replacement: "latest_wins"`, the vote template, `output_recipients.public: true`.
- **Replicas:** run by several operators (cross-operator). A single host can then neither stall nor reset the vote.
- **Close:** at `closes_at`, by chain time and NSM time.
- **What a voter does:** revises freely until close. Keeps a receipt for the latest revision. Their wallet resubmits automatically if the job restarts in a new epoch.
- **Result:** a public, quorum-cosigned tally of the latest valid ballot per card.

### Derived card

- **Policy:** a governance template policy `T` (`protocol-objects.md §2.2`).
- **Job:** anyone opens a standing `per_input` job naming `source_policy` and `projected_fields`.
- **Contributor:** presents their source card and receives a reduced card under `T`, signed by the notary.
- **Detail:** issuance (two rounds, with the holder countersigning), batching, the anonymity-set rule, `dup_tag`, expiry and renewal, and revocation propagation are all in `derived_card_revocation_propagation.md`.

---

## Postconditions

- **Statement jobs:** a notarization on IPFS, verifiable by anyone, cosigned by a quorum of replicas, and listed in an EAS-anchored job log. The output reaches exactly the policy's recipients. Every job key, index and plaintext buffer is erased.
- **Each contributor:** holds receipts that prove submission and acceptance, and can check inclusion.
- **Nothing that identifies a contributor** is published, and the operator's records don't hold it either, except under the disclosed step-31 fallback.

---

## Error Paths

| Code | Raised by | Meaning | Handling |
|---|---|---|---|
| `ATT_MALFORMED`, `ATT_ROOT_MISMATCH`, `ATT_CHAIN_INVALID`, `ATT_SIGNATURE_INVALID` | V | The attestation document is invalid | Reject; never encrypt |
| `ATT_DEBUG_MODE` | V | The enclave is in debug mode (PCR0–2 are all zeros) | Reject |
| `ATT_RUNTIME_NOT_ACCEPTED` | V, W | PCR0 isn't on the accepted list at evaluation time, or (for wallets) it was retired as `"vulnerable"` | Reject |
| `ATT_USER_DATA_MALFORMED`, `ATT_PURPOSE_MISMATCH`, `ATT_BINDING_MISMATCH`, `ATT_NONCE_MISMATCH`, `ATT_KEY_MISMATCH` | V | The attestation isn't bound to this job, key or notary | Reject |
| `ATT_STALE` | V | The attestation is older than `max_age` | Fetch a newer announcement; reject if none |
| `ATT_PLATFORM_NOT_ALLOWED` | V | Simulator root or platform where the simulator isn't enabled | Reject |
| `ANN_MALFORMED`, `ANN_SIGNATURE_INVALID`, `ANN_EPOCH_REGRESSION` | W | The announcement is invalid, or older than one already seen | Reject |
| `JOB_SIGNATURE_INVALID`, `JOB_MALFORMED` | W | The job is invalid | Reject |
| `JOB_POLICY_UNTRUSTED`, `JOB_POLICY_CHANGED` | W | Policy chain invalid, or `notary` / `approved_notaries` changed since the job was signed | Reject; the requester re-issues the job |
| `JOB_REQUESTER_NOT_PERMITTED`, `JOB_PARAMETERS_OUT_OF_BOUNDS`, `JOB_NOTARY_NOT_APPROVED`, `JOB_KEM_UNSUPPORTED`, `JOB_PROGRAM_NOT_ALLOWLISTED` | W | The job isn't allowed by the policy or the wallet | Reject |
| `JOB_CLOSED` | W | Past `closes_at` / `ends_at` | Reject |
| `JOB_SINGLE_OPERATOR_REFUSED` | W (step 7) | One operator's replicas reach the quorum, and governance has retired single-operator quorums (`protocol-objects.md §34`) | Reject; the requester re-issues the job with replicas from several operators |
| `NOT_SINGLE_OPERATOR_REFUSED` | N (result) | A single-operator notarization closed at or after the time governance retired single-operator quorums | Verifier rejects |
| `NOTARY_LINEAGE_INCOMPLETE` | E | The notary card's identity log has a gap or fork, so its key lineage can't be established | Reject the item; the operator investigates the missing anchor |
| `JOB_NOTARY_KEY_EXPOSED` | W (step 10a) | A replica's notary card key has lived in a runtime retired as `"vulnerable"` (algorithm E) | Reject; the operator must redo genesis and the policy holder reissue |
| `LIST_APPROVAL_MISSING`, `LIST_APPROVAL_MALFORMED`, `LIST_APPROVAL_HASH_MISMATCH`, `LIST_APPROVAL_KEYSET_STALE`, `LIST_APPROVAL_THRESHOLD`, `LIST_APPROVAL_NOT_REMOVAL_ONLY` | L | A governance list's head isn't validly approved by PressRegistryBody members (Appendix A.5) | Fail closed: treat no runtime as accepted and no program as allowlisted. Runtimes keep their last verified version. |
| `NOT_GENESIS_MISMATCH`, `NOT_OPERATOR_INVALID` | G | The genesis attestation doesn't match the offer, or the operator card is invalid | Don't issue the notary card |
| `INPUT_*`, `REVISION_CONFLICT` | B | Input rejected (Appendix B) | Sent in the sealed validation receipt; the wallet shows the reason |
| `ADM_*` | A | Program not admitted (`notary_runtime.md`) | The job is rejected before any key exists |
| `OUTPUT_SCHEMA_VIOLATION` | Output checks | The program returned an invalid output | The job is aborted with no output; an `aborted` record is written |
| `NOT_MALFORMED`, `NOT_SIGNATURE_INVALID`, `NOT_NOTARY_NOT_APPROVED`, `NOT_NOTARY_REVOKED`, `NOT_POLICY_MISMATCH`, `NOT_CHAIN_MISMATCH`, `NOT_COMMITMENT_MISMATCH`, `NOT_SUPPRESSION_INVALID`, `NOT_OUTPUT_INVALID`, `NOT_QUORUM_INSUFFICIENT`, `NOT_EPOCH_SUPERSEDED`, `NOT_NOTARY_KEY_EXPOSED` | N | Notarization invalid (Appendix A.4, steps N1–N13) | Verifier rejects |
| warnings `JOB_LOG_GAP`, `JOB_LOG_FORK` | N | Records missing or forked | Verifier reports; the result stands |
| (no receipt) | Wallet | Input not acknowledged by a quorum | Retry; resubmit on a new epoch |

---

## Threat Model

**Adversary.** A notary operator's host is treated as **fully adversarial for I/O**. It can drop, delay, reorder and replay anything, run any number of its own accepted-runtime enclaves, and supply false chain data. The relay, other operators, requesters and contributors may also misbehave in the ways their roles allow.

**Assumptions.** These are the only things the notary design trusts:

| # | Assumption | If it fails |
|---|---|---|
| T1 | AWS is the hardware root: the AWS Nitro Enclaves root certificate, the NSM, and isolation of enclave memory from the parent instance | Attestations can be forged or keys read |
| T2 | Accepted runtimes are correct. They never export or import keys except by attested handoff, and keep broker/worker isolation. | Keys can leak. Retiring the PCR0 stops new use but recalls nothing. After an emergency retirement, every key that lived in that runtime is treated as exposed (algorithm E): notary cards stop working, jobs re-key, and template key chains are re-seeded. |
| T3 | Enclave side channels are out of scope | Key or input leakage. Mitigated by `dedicated` isolation for custom programs and constant-time cryptography. |
| T4 | Allowlisted programs match their audits (reproducible builds) | A malicious program can leak within its declared output bounds, but not beyond them |
| T5 | Governance (PressRegistryBody) acts in good faith: fewer than a quorum of members (4 of 5) collude to accept a runtime or program, and fewer than 2 collude to retire one. Each list version must carry member signatures (algorithm L), so the list-holder key alone can't change what is accepted. | A quorum could accept a malicious runtime. Two members could retire good runtimes or programs, which stops new jobs but discloses nothing and is reversed by the full body. |
| T6 | Cryptography holds: ML-DSA-44, X-Wing draft-06, ChaCha20-Poly1305, SHA-256, HMAC-SHA256, secp256r1 (on-chain only), and ES384 (AWS attestations) | X-Wing is a hybrid, so both halves would have to break to expose inputs |
| T7 | The operators of a quorum of a job's replicas do not collude | With collusion: stalls, forced resets, and drops that agree across replicas (still exposed by receipts), and forged contributors (L4). Never disclosure, and never a forged result over the inputs counted. **A single-operator quorum is collusion by construction**, so T7 holds for such a job only if that operator is honest. |
| T8 | Chain data is only as honest as the host's feed (v1 has no state proofs) | See L3 and L4 |
| T9 | The parent instance can't influence NSM time | Early close would become possible. Must be confirmed on real hardware before launch. |
| T10 | The relay and the notary host are run by different parties | The operator learns contributors' IP addresses |

**Known limits.** These are stated to users and integrators, not treated as bugs:

| # | Limit | Mitigation |
|---|---|---|
| L1 | The operator controls I/O. It can drop inputs, delay close, refuse handoffs or force a total loss. | Receipts make drops attributable. The anchored job log makes resets visible. Cross-operator replicas for votes. |
| L2 | Losing every replica loses offline voters' ballots | Online wallets resubmit. Three replicas across availability zones by default. |
| L3 | Block headers are checked only for hash linkage | Notarization check N7 compares against the real chain. NSM time gates close. |
| L4 | Registry reads are unverified, and card checks trust the registry to say which document is a card's head. The registry state comes from each replica's own host. So a host can count a recently revoked card, let a recipient's removed device read a private output, and **forge eligible contributors**: it can fabricate cards whose chains reach a trusted root's address, because no card signature binds a card to its key without the registry. With a **single-operator quorum** (the replicas whose notary cards share one `operator_card` number at least q), that operator can add forged inputs to a job's count undetected. With replicas from several operators, a forged input fails at every honest operator's replica, and close stalls. | Wallet `chain_ref` floors. `chain_state` recorded in every notarization. Single-operator quorums are a **bootstrap allowance** for early deployment, while few operators are active; they are disclosed to contributors (consent, step 25) and to verifiers (warning `SINGLE_OPERATOR_QUORUM`), and governance retires the allowance once several operators are active (`protocol-objects.md §34`, `single_operator_quorums`). Verified chain reads (`card_protocol_spec.md §9`, P2) close this. |
| L5 | A host can withhold governance list updates from its runtime | Version floors built into the runtime image. Wallets enforce the current lists. Retire the runtime's PCR0 for serious issues. |
| L6 | k-anonymity and output transforms don't stop differencing across repeated jobs | Differential privacy is specified for a later version. `notary-lint` warns. |
| L7 | Ancestor cards outside snapshotted policies, and fallback predicates, are fetched by address | Disclosed on the consent screen |
| L8 | Small communities get weak timing protection for revocation propagation | Batching parameters; mixing across communities; disclosure |
| L9 | Derived cards from different operators match as duplicates only while the template key survives | A new key from the next period |
| L10 | Anyone may open a derived-card job over any source policy | Derived cards state only the source CID and verbatim values |
| L11 | Anything a key signed, or anything sent to it, before its runtime was retired as `"vulnerable"` stays as trustworthy as that runtime was. Inputs encrypted to an exposed job key may have been read. | Items dated before the retirement carry a warning; items after it are rejected (algorithm E). Re-seeding a template key leaves duplicate detection across key generations incomplete for the rest of that period. |

**What the design guarantees under T1–T10:**
- The operator never sees an input's content.
- Every result is computed by the program the contributor's wallet checked, over inputs the enclave validated, and cosigned by a quorum.
- A notarization can be verified by anyone without trusting the operator.
- Every key handoff is publicly logged before the receiving replica acts.

---

## Appendix A: Attestation and verification algorithms

All reject codes are listed in §Error Paths.

### A.1 Algorithm V: verify one enclave attestation

**Inputs:** the document, the expected binding (purpose and the fields it binds; `protocol-objects.md §33`), `t_eval` (the chain time at which PCR0 must be accepted), an optional `max_age`, `now` (chain time), and the accepted-runtime list card, already verified by **L** (A.5).

**Platform-specific steps (V1–V5).** These live in one module per platform, behind the `AttestationVerifier` interface (`notary_runtime.md`). The simulator uses the same format with a test root, accepted only when the verifier is configured for it (`ATT_PLATFORM_NOT_ALLOWED` otherwise).

1. COSE_Sign1 with ES384 → `ATT_MALFORMED`.
2. All payload fields present, with `digest == "SHA384"` → `ATT_MALFORMED`.
3. `cabundle[0]` equals the pinned root byte for byte → `ATT_ROOT_MISMATCH`.
4. The certificate chain verifies, with every certificate valid **at the document's timestamp** → `ATT_CHAIN_INVALID`.
5. The COSE signature verifies with the leaf key → `ATT_SIGNATURE_INVALID`.

**Shared steps (V6–V12).**

6. PCR0, PCR1 and PCR2 are not all zero → `ATT_DEBUG_MODE`.
7. PCR0 is accepted at `t_eval` (`protocol-objects.md §34`) → `ATT_RUNTIME_NOT_ACCEPTED`. If the only match was retired as `"vulnerable"`, return success with the warning `runtime_retired_vulnerable`.
8. `user_data` is 181 bytes, with tag `CARDNOTARY` and version `0x01` → `ATT_USER_DATA_MALFORMED`.
9. The purpose is the expected one → `ATT_PURPOSE_MISMATCH`.
10. Each bound field equals the expected value, and each unused field is zero → `ATT_BINDING_MISMATCH`. Where a caller gives no expected value for a bound field (W13 for `inst_key_hash`; N6 for `inst_key_hash` and `public_key`), the field must be present, 32 bytes and non-zero, and isn't compared.
11. `nonce` and `public_key` are as §33 requires → `ATT_NONCE_MISMATCH` / `ATT_KEY_MISMATCH`.
12. If `max_age` is set: `now − max_age ≤ timestamp ≤ now + 5 min` → `ATT_STALE`.

### A.2 Algorithm W: wallet check of a job announcement (before encrypting)

The wallet uses its **own** chain reads, never data from the notary host. Configuration: the platform roots, `allowSimulator` (`false` in production builds), the list-card addresses, the `NotaryCardPolicy` CID, the accepted KEMs, and `max_attestation_age` (default 24 hours).

1. Announcement `type` and required fields → `ANN_MALFORMED`.
2. Job `type`. `keccak256(requester_pubkey) == requester_card`. `requester_signature` verifies. Compute `job_hash` → `JOB_SIGNATURE_INVALID`.
3. The policy chain reaches a trusted root → `JOB_POLICY_UNTRUSTED`. (Algorithm R, A.7, step R3.)
4. `policy_state_cid` is the current head or in its history, and `notary` and `approved_notaries` are unchanged at the current head → `JOB_POLICY_CHANGED`. (Algorithm R, step R2.)
5. The requester satisfies `job_requester_predicate` (absent means anyone) → `JOB_REQUESTER_NOT_PERMITTED`. The requester's chain is read as in algorithm R, step R5. `is_holder` holds iff `requester_card` is the policy card's holder (`keccak256` of the policy's `recipient_pubkey`).
6. `parameters` are within `parameter_bounds` → `JOB_PARAMETERS_OUT_OF_BOUNDS`.
7. The mode-specific fields are consistent, and q ≤ `min_live` ≤ N → `JOB_MALFORMED`. If the verified program allowlist's `single_operator_quorums` is `"refused"`, the replicas whose notary cards share one `operator_card` number fewer than q → `JOB_SINGLE_OPERATOR_REFUSED`.
8. Chain time is before `closes_at` / `ends_at` → `JOB_CLOSED`.
9. `kem` is accepted → `JOB_KEM_UNSUPPORTED`.
10. Every `replica_set` card is in the current `approved_notaries` and not revoked, has `policy_id = NotaryCardPolicy` and `issuer_card` = this policy's card (the address derived from the `recipient_pubkey` of the job's `policy_id` document, as in A.7 R1), and its `platform` equals `notary.platform` → `JOB_NOTARY_NOT_APPROVED`.
    - 10a. No `replica_set` card's key is exposed (algorithm **E**, A.6, at `t = now`) → `JOB_NOTARY_KEY_EXPOSED`.
11. `notary_signature` is by a `replica_set` card and verifies → `ANN_SIGNATURE_INVALID`.
12. The epoch chain is consistent, and the epoch isn't below the highest the wallet has stored for this job → `ANN_EPOCH_REGRESSION`.
13. At least one attestation passes **V** with: purpose `0x02`; `id_key_hash` = a `replica_set` card; `program_hash` from `program_cid`; `job_hash`; `epoch`; `isolation`; `public_key = SHA-256(job_public_key)`; `inst_key_hash` not compared (a wallet can't know a replica's instance key); `nonce = job_hash`; `t_eval = now`; `max_age = max_attestation_age` → `ATT_*`.
14. If `isolation == "shared"`: `program_cid` is on the current allowlist → `JOB_PROGRAM_NOT_ALLOWLISTED`.
15. If V raised `runtime_retired_vulnerable` → `ATT_RUNTIME_NOT_ACCEPTED`.

### A.3 Algorithm G: genesis attestation

0. **Later verifiers only.** Fetch the request at the card's `genesis_request` and check it against its CID. It must equal the card's `id_pubkey` (= `recipient_pubkey`), `chain_pubkey`, `operator_card`, `operator_host_pubkey` and `platform`, and its `policy_id` must be the card's `issuer_card` policy → `NOT_GENESIS_MISMATCH`. `H(genesis request)` in step 1 is that request's hash. (The policy holder already holds the request.)
1. **V** passes with: purpose `0x01`; `id_key_hash = keccak256(id_pubkey)`; `chain_key_hash = SHA-256(chain_pubkey)`; `nonce = H(genesis request)`. `t_eval` is `now` for the policy holder, or the notary card's `issued_at` for a later verifier. `max_age` is 7 days for the policy holder and none for a later verifier. → `ATT_*`.
2. The offer's `recipient_pubkey`, `chain_pubkey` and `genesis_attestation` match the request and the document → `NOT_GENESIS_MISMATCH`.
3. `operator_card` resolves and isn't revoked → `NOT_OPERATOR_INVALID`.

### A.4 Algorithm N: notarization verification

Uses CIDs and chain data only, so anyone can run it. Also specified as a verifier entry point in `card_verifier.md`.

1. `type` is right. The job at `job_cid` hashes to `job_hash` and its signature verifies → `NOT_MALFORMED`.
2. `keccak256(notary_signature.public_key) == notary_card`, and the signature verifies → `NOT_SIGNATURE_INVALID`.
3. `notary_card` is in `replica_set`, and in `approved_notaries` **at `policy_state_cid`**, with a valid chain → `NOT_NOTARY_NOT_APPROVED`.
4. The notary card has no 8xx or 9xx revocation effective at or before `closed_at` → `NOT_NOTARY_REVOKED`.
    - 4a. Run algorithm **E** (A.6) on the notary card and on each cosigning replica's card, with `t` = the chain time of the EAS anchor of the job's `notarized` record. An exposure at or before `t` → `NOT_NOTARY_KEY_EXPOSED`. An exposure after `t` → warning `notary_key_exposed_later`.
5. `program_cid` and `platform` equal the policy's at `policy_state_cid` → `NOT_POLICY_MISMATCH`.
6. `attestation` passes **V**: purpose `0x02`; `job_hash`, `final_epoch` and `program_hash`; `id_key_hash = notary_card`; `nonce = job_hash`; `public_key` and `inst_key_hash` not compared (the notarization doesn't carry the final epoch's job key or the instance key); `t_eval = closes_at` (aggregate) or `closed_at` (per-input); no `max_age` → `ATT_*`.
7. The block named in `chain_state` exists on the verifier's own chain view with that hash and timestamp, `closed_at` equals its timestamp, and `closed_at ≥ closes_at` → `NOT_CHAIN_MISMATCH`.
8. `counted_inputs` is sorted, has no duplicates, has `accepted` entries, and its Merkle root equals `input_commitment` → `NOT_COMMITMENT_MISMATCH`.
9. `suppressed == (accepted < k_min)`, with the fixed output when suppressed → `NOT_SUPPRESSION_INVALID`.
10. A public output validates against `output_schema` with its transforms, and `output_hash` matches → `NOT_OUTPUT_INVALID`.
11. Walk the job log to `seq` 0, checking signatures and the EAS anchors of anchored kinds → warnings `JOB_LOG_GAP` / `JOB_LOG_FORK`.
12. There are at least `close_quorum` cosignatures (= ⌊N/2⌋ + 1) from distinct instances. Each attestation passes **V** as in step 6 with `id_key_hash` set to its replica's own notary card (any card in `replica_set`), and each signature verifies over `H(body)` → `NOT_QUORUM_INSUFFICIENT`.
13. No `epoch_started` record for a higher epoch was anchored before `closed_at` → `NOT_EPOCH_SUPERSEDED`.

**Result:** valid, or the first reject code. Warnings are returned with the result: `runtime_retired_vulnerable`, `notary_key_exposed_later`, the chain-state age, `JOB_LOG_GAP` / `JOB_LOG_FORK`, any `total_loss` epochs, and `SINGLE_OPERATOR_QUORUM` when the replicas whose notary cards share one `operator_card` number at least `close_quorum` (L4: the count may include contributors that operator invented). A single-operator notarization whose `closed_at` is at or after `refused_since` is **rejected** with `NOT_SINGLE_OPERATOR_REFUSED`. `refused_since` is the on-chain time of the earliest program-allowlist version from which `single_operator_quorums` has been `"refused"` without interruption (`protocol-objects.md §34`).

**Where single-operator quorums are enforced.** Only wallets (W7) and verifiers (N), which read notary cards and the governance lists over their own chain connections. Enclaves don't check. An enclave can read another operator's notary card only from host-supplied registry data (L4), so a host could feed it forged cards claiming several operators, and the check would protect nothing. (Decided 2026-11-12, erratum E34.)

### A.5 Algorithm L: governance list approval

Run on a list card (`protocol-objects.md §34`) before its list is used. Algorithms V, W, G and N, and the runtime's §12 checks, use only a list that has passed L.

**Inputs:** the list card's verified log (Stages 3–5 for wallets and verifiers; `notary_runtime.md` §12 for runtimes) and the trusted keyset `K` = `{ keys, quorum, version, key_scheme }`. Wallets and verifiers read `K` from the current on-chain `GovernanceKeysets[PressRegistryBody]` with their own chain reads. Runtimes use the keyset built into the image.

1. The head version has a `list_approval` that parses, with `type`, `list` and `list_card` matching this card → `LIST_APPROVAL_MISSING` / `LIST_APPROVAL_MALFORMED`.
2. `list_hash` equals H(JCS(the head's list value)). If `list_version > 1`, `prev_list_hash` equals H(JCS(the previous version's list value)), and `list_version` is the previous one's plus 1 → `LIST_APPROVAL_HASH_MISMATCH`.
3. `governance_version == K.version` → `LIST_APPROVAL_KEYSET_STALE`.
4. Count the valid signatures over `H(JCS(approval without "signatures"))` from distinct `key_index` values in `K.keys`. This must be at least `K.quorum` for `"standard"` and at least `EMERGENCY_RETIREMENT_THRESHOLD` (2) for `"emergency_retirement"` → `LIST_APPROVAL_THRESHOLD`.
5. If `kind == "emergency_retirement"`: the change from the previous version satisfies rule E → `LIST_APPROVAL_NOT_REMOVAL_ONLY`. Then repeat steps 1–5 on the previous version, until a `"standard"` version passes. All of these versions must name `K.version`.

**Note.** Only the head (and any emergency chain above the latest standard version) needs checking. Entries are never deleted, so the head carries the full history that acceptance at a past `t_eval` needs.

### A.6 Algorithm E: key exposure

A notary card's keys (`K_id`, `K_chain`) are **exposed** once any runtime image they have lived in is retired as `"vulnerable"`. Algorithm E finds the moment that happened, using only public records. Used by W (step 10a), N (step 4a), `card_verifier.md` Stage 5 step 3a, and the runtime (`notary_runtime.md` §4).

**Inputs:** the notary card, its identity log (`protocol-objects.md §28`, `type: "notary.identity_log.v1"`, found through its EAS anchors), and the accepted-runtime list verified by **L**.

1. **Lineage.** The set of PCR0s the keys have lived in. It contains the PCR0 of the genesis attestation, plus `pcr0_to` of every `identity`-scope handoff record in the identity log. Walk the log to `seq` 0 as in N11. Record `seq` 0 must be `opened` and name the card's `genesis_attestation`. A gap, a fork, or a missing or different `seq` 0 → `NOTARY_LINEAGE_INCOMPLETE`.
2. **Exposure time.** `t_x` is the earliest `retired_at` among lineage entries retired with `retire_reason: "vulnerable"`. None → not exposed.
3. **Judging an item** dated `t`, where `t` must come from the chain and never from a notary-signed field:
   - derived card: the timestamp of its `CardRegistered` event;
   - notarization: the timestamp of the EAS anchor of its `notarized` record;
   - live job: now.

   If `t ≥ t_x`, the item is **rejected**. If `t < t_x`, it gets the warning `notary_key_exposed_later`.

**Why the log is complete.** A receiving enclave doesn't serve until its `handoff` record is anchored (`notary_replication_and_recovery.md` step 10). So every enclave that has used the keys appears in the anchored log. A copy taken outside the protocol is exactly what an exposed runtime makes possible, and the lineage already includes that runtime.

### A.7 Algorithm R: reading a policy and a requester

Used by the enclave at step 17, and by wallets and verifiers through the same logic. Wallets read the registry over their own chain connection. The enclave reads everything through the host over vsock (`fetch`, `notary_runtime.md` §9) and makes no network connection. Content is checked against its CID. Trust comes from the trusted roots pinned in the reader (in the enclave: the runtime image), never from where the bytes came from.

**Inputs:** `policy_id`, `policy_state_cid`, the job, and the reader's trusted roots.

1. **R1. Documents.** Fetch the documents at `policy_id` and `policy_state_cid` and check each against its CID. A document is accepted as plain RFC 8785 JSON, or as AES-256-GCM ciphertext under `HKDF-SHA3-256(recipient_pubkey, "card-content-v1")`, with `recipient_pubkey` read from the `policy_id` document. The policy's registry address is `keccak256(recipient_pubkey)`. → `JOB_POLICY_UNTRUSTED`.
2. **R2. State.** The policy's registry entry (a `card_head:` read) lists `policy_state_cid` among its head events. The `notary` section and `approved_notaries` of the current head (decrypted as any card head, `card_verifier.md` Stage 3) equal those at `policy_state_cid`. → `JOB_POLICY_CHANGED`.
3. **R3. Chain.** The policy card's chain reaches a trusted root and no card on it is revoked at chain time (`card_verifier.md` Stages 3–4). → `JOB_POLICY_UNTRUSTED`.
4. **R4. Notaries.** Every `replica_set` card is in `approved_notaries` at the current head. → `JOB_NOTARY_NOT_APPROVED`.
5. **R5. Requester** (only with `job_requester_predicate`). Read `requester_card`'s head from its registry entry, decrypted under `HKDF-SHA3-256(requester_pubkey, "card-content-v1")`. The binding is already checked in W2. Run Stages 3–4 on its chain, then the predicate with the parameters resolved, with `is_holder` as in W5. → `JOB_REQUESTER_NOT_PERMITTED`.

Registry reads are unverified in the enclave (L4). Wallets check R2–R4 with their own chain reads before contributing, so a host that misreports policy state can stop a job but can't mislead a contributor.

---

## Appendix B: Input validation and output checks (broker)

**Input validation (B1–B11).** Runs in order at `submit_input` and again at close. Card documents come from `evidence`, and registry state from policy snapshots (step 31). Plaintext is zeroized after the last step whatever the result.

| # | Check | Code |
|---|---|---|
| B1 | HPKE-open with `K_job,epoch`, using the `info` and `aad` in `protocol-objects.md §24` | `INPUT_UNDECRYPTABLE` (plain error to the host; no receipt possible) |
| B2 | `NotaryInput` `type` is right and `job_hash` matches | `INPUT_MALFORMED`, `INPUT_WRONG_JOB` |
| B3 | `chain_ref` is on the accepted header chain. The enclave doesn't wait for headers: a block it hasn't been sent yet is `INPUT_CHAIN_REF_UNKNOWN` at once, which costs no state, and the wallet retries after a short delay (the host streams headers about once a second). The newest accepted `chain_ref` becomes the floor for chain state. | `INPUT_CHAIN_REF_UNKNOWN`, `INPUT_CHAIN_REF_MISMATCH` |
| B4 | `chain_ref` time ≥ `opens_at`, and < `closes_at` (aggregate) | `INPUT_TOO_EARLY`, `INPUT_LATE` |
| B5 | The signer is a valid sub-card with `"notary_input"` capability (`protocol-objects.md §16` checks) | `INPUT_SIGNER_INVALID` |
| B6 | `keccak256(contributor_card_pubkey) == contributor_card ==` the sub-card's `holder_primary_card` | `INPUT_BINDING_MISMATCH` |
| B7 | The master card chains to a trusted root and isn't revoked | `INPUT_CARD_UNTRUSTED`, `INPUT_CARD_REVOKED` |
| B8 | `contributor_predicate`, with parameter references resolved | `INPUT_NOT_ELIGIBLE` |
| B9 | `payload` matches `input_schema` | `INPUT_SCHEMA_INVALID` |
| B10 | Dedupe by root key (`past_keys[0].pubkey` or `recipient_pubkey`). `reject_duplicates`: `revision` 0 and a new root key. `latest_wins`: a lower revision → `superseded`; the same revision and same signed input → accepted (resubmission); the same revision with different content → `REVISION_CONFLICT`; a higher revision → accepted and supersedes. | `INPUT_DUPLICATE`, `INPUT_REVISION_INVALID`, `REVISION_CONFLICT` |
| B11 | The job holds fewer than `max_inputs` contributors | `INPUT_CAPACITY` |

**What the broker keeps per accepted input:** `root_key_hash → { revision, input_hash, epoch }`. That records who has a counted input, not what they chose, and is not a running tally.

**Output checks.** Applied to whatever the program returns:
1. The output is RFC 8785 JSON whose fields exactly match `output_schema`: types `integer`, `boolean`, and `text` with an `enum`. Otherwise `OUTPUT_SCHEMA_VIOLATION`.
2. `clamp`.
3. `round_to` (nearest multiple, ties to even) or `buckets`.
4. `suppress_cell_below_k`.
5. The whole-output `k_min` rule.

---

## Related Specs

- `ARCHITECTURE.md` ADR-013: decision, alternatives, platform swap
- `protocol-objects.md` §2.1, §2.2, §20–§34: objects
- `process_specs/notary_replication_and_recovery.md`: replicas, handoff, quorum acknowledgment and close, epochs, resubmission, state blob
- `process_specs/derived_card_revocation_propagation.md`: derived-card issuance, `dup_tag`, revocation propagation
- `object_specs/notary_runtime.md`: broker/worker, program admission (algorithm A), privacy transforms, attestation backends, limits
- `object_specs/notary_host.md`: the nitropack host, its endpoints, snapshots, anchoring
- `object_specs/wallet_sdk.md`, `object_specs/card_verifier.md`: wallet and verifier sides
- `process_specs/oblivious_transport.md`: the outer envelope; the notary host as a destination
- `process_specs/policy_creation.md`: issuing the policy card
