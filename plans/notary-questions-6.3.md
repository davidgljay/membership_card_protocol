# Digital Notaries — Step 6.3 (Replication): Decisions and Questions for David

**Date:** 2026-11-14 · **Branch:** `notary` · Brief: [notary-opus-prompt-6.3.md](notary-opus-prompt-6.3.md) · Phase 6 answers: [notary-questions-phase-6.md](notary-questions-phase-6.md) (Q5–Q9)

Q5–Q9 were approved and are written into the specs with "Amended 2026-11-14 (6.3)" lines. Everything below goes **beyond** Q5–Q9. Each item is implemented the way it recommends, and the spec text is marked "for David's review". Items marked **[security]** change what an untrusted host can do, or what a replica trusts. Reply "OK to all" or answer by number.

| # | Topic | Kind |
|---|---|---|
| R1 | Job-scope handoffs are sent only by the job leader | design, spec |
| R2 | Followers track the log: `anchor_receipt.record` and a new `log_record` message | **[security]** spec |
| R3 | Backward header linking, and headers kept only ≈ 7 hours | **[security]** spec, production gap |
| R4 | `store_input`: peers' hosts store forwarded ciphertexts | spec |
| R5 | `start_handoff`, `shutdown` and `replica_gone` → `replica_lost` | spec |
| R6 | Asynchronous answers; `close_pending`; `INPUT_ACK_TIMEOUT` | spec |
| R7 | Restarts on an enclave that doesn't hold the job; `prev_attestation` | **[security]** spec |
| R8 | What `state_version` means for each scope | spec (ambiguity) |
| R9 | A replica that becomes leader mid-close | **[security]** spec gap |
| R10 | Smaller choices (no question unless you object) | interface |
| R11 | Observations outside 6.3 | report |
| R12 | One originator per job across hosts | spec |

---

### R1. Job-scope handoffs are sent only by the job leader

- **Spec.** Step 10: "The job leader (for job scope) or S (for identity and template scopes) writes a `handoff` record". It doesn't say who sends a job-scope handoff.
- **Code.** `peer.rs::offer_job_handoffs` and `handoff.rs`. Only the leader (the live member with the lowest instance id) offers the job key. At formation that is the originator, the only key holder. So "the leader writes" and "S writes" are the same replica, and no message has to carry a handoff acknowledgment from S to a different leader.
- **Recommendation.** Keep it, and add one sentence to step 2/22: "Job-scope handoffs are sent by the job leader."

### R2. How followers see the log **[security]**

- **Gap.** Only the leader writes job-log records, but every replica must know the head: to serve only after its own `handoff` anchor (step 10), to learn it was counted lost (step 24), to stop at a newer `epoch_started` (§7), to erase keys after `notarized` (step 44), and to continue the log when it becomes leader. Nothing in the spec gets the records to the followers.
- **Code.**
  - Hosts give their enclave each record another replica wrote. Anchored records come as `anchor_receipt { scope_id, seq, tx_receipt, record }`, with the record's bytes. Every published record comes as a new host→enclave message `log_record { scope_id, seq, record }`.
  - The follower accepts a record only if it is signed by the `K_id` of a `replica_set` card (for an identity log, the card itself) and by the instance key it names, and it links to the follower's head. Records it missed are read back by CID (`fetch ipfs:`).
  - A record of an anchored kind that arrives through `log_record` is adopted, but **takes effect only when its anchor arrives**. Step 10 still holds: a host that withholds the anchor keeps the receiver idle (`tests/replication.rs::over_capacity_is_refused_and_a_receiver_serves_only_after_its_handoff_anchor`).
- **Why `log_record` is needed.** `replicated` and `closed` are unanchored kinds. A follower that sees only anchors never sees them, and becomes a leader with a stale head, which forks the log. The rolling-upgrade test found this.
- **Trust.** The same as today: an enclave can't verify an EAS receipt in v1, so "anchored" is the host's word, exactly as for the writer. A record's signatures can't be forged.
- **Recommendation.** Approve the `record` field and `log_record`. Host §9 then needs: "a host relays every job-log and identity-log record of its enclave's jobs and cards to the other hosts of the replica set, and gives its enclave the records the others wrote".

### R3. Headers: backward linking, and a ≈ 7-hour window **[security]**

- **Spec.** Runtime §9 `chain_headers`: "checks it links by parent hash to the newest accepted header. **Ignores older headers.**" Runtime §13: the first header is the anchor, within 10 minutes of attested time.
- **Problem.** A replica that joins a running vote (re-replication, rolling upgrade) anchors near "now". At close, every replica re-runs B3 on each counted input's `chain_ref`. The newcomer can't find older blocks, so it excludes those inputs, its counted set differs from the leader's, and close stalls (`close_mismatch`).
- **Code** (`chain.rs`). A header is also accepted if its hash is the parent of an accepted header (backward linking). This is the same hash linkage, so the host can't invent a block this way. The harness feeds a late joiner the newest header first, then the older ones.
- **Production gap, found while checking this** (outside 6.3; affects 6.2 votes today):
  - `HeaderChain` keeps 100,000 headers. Arbitrum One makes about 4 blocks a second, so that is about 7 hours.
  - A vote longer than that can't re-check its early ballots at close, even on a single replica.
  - Options: keep only the headers that inputs name (the floor and the `chain_ref`s in the index); or have the host stream headers sparsely; or bound vote length.
- **Recommendation.** Approve backward linking (amend §9 to "links by parent hash to an accepted header, forwards or backwards"). Decide the retention question separately; I suggest keeping the headers named by held inputs.

### R4. `store_input` (enclave → host)

- **Spec.** Step 12: "…and its host stores the ciphertext". The host relays peer bytes and never parses them, so it can't see the forwarded input.
- **Code.** A peer that acknowledges a forwarded input asks its own host `store_input { job_hash, epoch, input_hash, sealed_input }`. The host checks `H(sealed_input) == input_hash` and stores it, the same check as Q8's `need_inputs`.
- **Recommendation.** Approve (runtime §9, host §7 retention as `input:`).

### R5. Starting identity and template handoffs; stopping a replica

- **Code.**
  - `start_handoff { scope: "identity" | "template", card, template?, to_instance }` (host → enclave): the host chooses whom, as it already can through the directory. Every check still runs (P1–P5).
  - `shutdown {}` (host → enclave): the replica sends `replica_gone` to its peers, erases its job keys and answers `shutdown_ack`.
  - On `replica_gone` from a member, the leader writes `replica_lost` at once, whatever `min_live` says. Q7 says heartbeats may only *lower* the count; writing the record keeps the anchored log as the one source of the capacity count. Without this a rolling upgrade can't proceed: the stopped replica still counts against the cap until the liveness rule fires, and the liveness rule fires only below `min_live`.
- **Recommendation.** Approve the two messages and the rule "`replica_gone` → `replica_lost`" (amends step 21).

### R6. Asynchronous answers

- **`submit_input` with q > 1** has no reply until q acknowledgments arrive. `input_result` then goes out on its own with the same `req_id`. After 60 s the enclave answers `error INPUT_ACK_TIMEOUT` (new code), and no receipt is issued.
- **`close_chunk` with q > 1** answers `close_pending`. The leader later sends `job_closed` with the `close_chunk`'s `req_id`. Followers answer `close_pending`, and erase keys once they follow the `notarized` record.
- **Host impact.** The host's enclave session must accept replies that arrive after its timeout, and keep waiting about 70 s for `input_result`. Not built yet (see the progress note).
- **Recommendation.** Approve `INPUT_ACK_TIMEOUT` and `close_pending` (runtime §9, §16).

### R7. Restarts **[security]**

- **`runtime_migration`.** The enclave must confirm that its own `close_compat` differs from the previous epoch's. It knows the previous epoch's runtime only from an attestation of that epoch. The restart now carries `prev_attestation` (a CID). The enclave reads it by CID, verifies it as a purpose-0x02 attestation for this job and `prev_epoch`, and takes that document's PCR0. The host can't forge it. It can only name an attestation from another epoch, which fails the binding.
- **A job the enclave doesn't hold.** The enclave runs the full step-17 checks and admission, reads `last_log` by CID, checks it is a record of this job signed by a `replica_set` card, and continues the log from it. It takes that record's anchor as given: the host is trusted for anchors as everywhere (R2). A host can point at an older record; that forks the log, which verifiers see (step 26's threat note).
- **`key_exposure`.** Confirmed when this enclave's key for `prev_epoch` is exposed by its own verified list, or (non-holder) when `prev_attestation`'s PCR0 is retired as `"vulnerable"`.
- **Recommendation.** Approve `restart.prev_attestation` (runtime §9).

### R8. What `state_version` means

- **Spec.** §29 and §30 use `state_version` for job, identity and template state. Step 9: "refuses a `state_version` lower than any it has seen in heartbeats". The heartbeat carries one `identity_state_version` and no card.
- **Code.**
  - **Job scope:** the number of changes to the sender's dedupe index in that **epoch**. It is compared only with heartbeats **from the same sender for the same (job, epoch)**. Different replicas' counters aren't comparable, and a new epoch restarts at 0; the emergency-retirement test failed until the comparison was per epoch.
  - **Identity scope:** compared with heartbeats from instances known to hold the same card.
  - **Template scope:** 0.
- **Recommendation.** Spec these definitions in §29 and §30. Add `notary_card` to the heartbeat's identity version if you want cross-instance comparison.

### R9. A replica that becomes leader mid-close **[security]**

- **The rule holds.** A replica never co-signs two bodies (tested: `a_replica_never_cosigns_two_bodies_for_one_job`).
- **The consequence.** If the leader stops after followers co-signed its body, a new leader's own body differs (it names a different attestation, card and log head), so it can never reach q.
- **Code.**
  - A new leader that had co-signed the old body proposes **that same body**. Followers co-sign it again (same digest), and it can finalize if it holds the `K_id` of the body's `notary_card` (another instance of the same card).
  - Across operators it can't sign `notary_signature` for another card's body. Close then stalls. That is safe, but needs an operator.
- **Options.**
  - (a) Accept it: a cross-operator leader loss during close is a rare stall.
  - (b) Allow re-cosigning after an anchored `replica_lost` of the old leader. That is safe only if the old leader can't finalize later; it could, if it isn't really dead (partition).
  - (c) Let a body name the closing card after cosigning.
- **Recommendation.** (a) for v1, stated as a limit (L1).

### R10. Smaller choices (implemented; no question unless you object)

- **Refusals.** A refusal is reported only to the refusing side's host (`alert` with the code). There is no "refused" peer kind; the other side's session expires after five minutes.
- **Back-off.** A peer refused once isn't offered the same job again for five minutes; without it, ineligible peers starved eligible ones.
- **Directory.** `peer_directory` replaces the previous directory, and in-flight offers to peers no longer listed end.
- **Signatures.** `input_ack`, `close_cosign` and the other peer kinds rely on the envelope's `instance_signature`. The Heartbeat and HandoffRecord bodies also carry their own §29/§30 signatures. `ct_signature` (step 8) is kept, although the envelope signs it too.
- **Payload.** The handoff payload is canonical JSON. Key bytes pass through a `serde_json::Value` while being parsed; inputs already do the same. Zeroization of those copies is best-effort; review in Phase 8.
- **`close_body`.** It carries the `counted` list, so a disagreeing follower can ask its host for the missing ciphertexts (`need_inputs`, step 19's "a replica's host can resolve it").
- **Heartbeats.** They go to job peers only. Identity-only peers get none until 6.5's state blob needs them.
- **Template P3.** It uses the card oracle (`serves_template`), which fails closed until 6.4 implements it.
- **List floors.** An identity receiver raises its list floors to the versions in the payload (runtime §12 step 4).
- **List re-reads.** The governance lists are re-read on a tick at most once a minute, so an emergency retirement is noticed without a new job.

### R11. Observations outside 6.3 (reported, not changed)

- The ≈ 7-hour header window (R3).
- `anchor_receipt` is unauthenticated host input, now also used to gate serving. That is no weaker than before, but it is worth naming in the Phase 8 review next to L4.

### R12. One originator per job across hosts (host side)

- **Spec.** Lifecycle step 15: "Requester → operator hosts. Sends the job to the host of each operator in `replica_set`." Step 16: each host sends `create_job`. With N > 1, every host keying the job would make several originators, each with its own `K_job,0`.
- **Code** (`host/src/handlers/jobs.ts`).
  - Only the host serving `replica_set[0]`'s card sends `create_job`.
  - The others record the job (`status: "awaiting_handoff"`). Their enclaves receive the key by handoff. They learn which local instance holds it from the relayed `handoff` records, and serve the job once the relayed announcement arrives.
- **Recommendation.** Add to step 16: "With N > 1, only the host of the first `replica_set` card sends `create_job`; the others wait for the handoff."
