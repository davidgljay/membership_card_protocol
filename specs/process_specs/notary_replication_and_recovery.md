# Notary Replication and Recovery — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Objects:** `protocol-objects.md` §21, §22, §26–§31, §33 · **Lifecycle:** `notary_lifecycle.md` · **Design record:** `plans/notary-design-decisions.md` §2.5

> **Terminology.** "The enclave" means an AWS Nitro Enclaves enclave. "Enclave attestation" means the AWS Nitro Enclaves attestation document. See `ARCHITECTURE.md`, terminology note.

---

## Overview

A notary job runs on several enclaves, called **replicas**, so it survives one of them failing. Credible deletion means a job key that every replica has lost can't be recovered. So this spec makes loss **unlikely** (replicas, quorum acknowledgment) and **accountable** (receipts, heartbeats, a public job log), rather than reversible.

It covers:

| Section | Topic |
|---|---|
| §1 | Roles and parameters |
| §2 | Forming a replica set |
| §3 | Handoff protocol (with algorithm P) |
| §4 | Inputs across replicas |
| §5 | Chain-anchored close by quorum |
| §6 | Heartbeats, re-replication and replica loss |
| §7 | Epochs, total loss, wallet resubmission, latest-ballot-wins |
| §8 | The sealed-link state blob |
| §9 | Colluding operators |

**Threat notes.** Every protocol step ends in a threat note: what a **hostile host** (an operator's host acting against the protocol) can and cannot do at that step. The overall threat model, assumptions T1–T10 and limits L1–L10, is in `notary_lifecycle.md` §Threat Model.

---

## Actors

| Actor | Role |
|---|---|
| **Replica** | An enclave holding a job's key for one epoch. Each has an instance key `K_inst`, generated at boot and bound by its purpose-`0x03` attestation. |
| **Job leader** | The live replica of a job with the lowest `instance` value, `SHA-256(K_inst)`. It signs the job's log records and coordinates close. |
| **Identity leader** | The live holder of a notary card's `K_id` with the lowest `instance`. It is the only writer of that card's on-chain payloads, so replicas never collide on the write gate's `next_sequence`. |
| **Notary host** | Relays all traffic between replicas, starts replacement enclaves, stores ciphertexts and blobs, and submits EAS anchors. Untrusted. |
| **Contributor's wallet** | Keeps its signed inputs and resubmits them after a new epoch |

---

## §1 Parameters

| Name | Meaning | Default / rule |
|---|---|---|
| N | Total instances in `job.replica_set` | 3 |
| q | Quorum for acknowledgment and close | ⌊N/2⌋ + 1 |
| `min_live` | Re-replication floor | q ≤ `min_live` ≤ N; default q |
| Heartbeat interval | How often each replica sends a heartbeat to each peer | 30 s |
| Liveness window | How long a peer may be silent before it counts as down | 120 s |
| Handoff attestation age | Maximum age of a peer's attestation during a handoff | 5 min |
| Acknowledgment timeout | How long a receiving replica waits for q acknowledgments | 60 s |
| Per-input key grace | How long an old epoch's key is kept after rotation | 1 h |
| Wallet input retention | How long a wallet keeps a signed input | Until a valid notarization is seen, plus 7 days |

**Why a majority quorum.** Any two sets of q replicas share at least one replica, and an honest replica co-signs at most one result per job. So two conflicting results can never both reach a quorum, even when a host partitions the replicas. For the same reason, an input acknowledged by q replicas survives the loss of any minority of them.

**Leadership** is derived from heartbeats (§6). A partition can create two leaders. That is tolerated: they can fork the job log, which verifiers see as `JOB_LOG_FORK`, but they can't both get a result accepted (§5).

---

## §2 Forming a replica set (epoch 0)

1. **Host → originator enclave.** `create_job` with the job and the program. The originator runs the job checks and program admission, then generates `K_job,0` and attests with purpose `0x02` (`notary_lifecycle.md` steps 16–17).
   - *Threat note:* the host can refuse to start or send `create_job`, which only delays the job. It cannot make a key exist for a program that wasn't admitted, because admission comes first.
2. **Originator → each other instance in `replica_set`.** The originator runs a **job-scope handoff** (§3). For another operator's instances, the message goes through that operator's host. Each receiver attests with purpose `0x02` for the same key hash.
   - *Threat note:* hosts can drop handoff traffic, so the job never reaches q. They cannot get the key to a non-enclave, to a non-accepted runtime, or to a notary card outside `replica_set` (§3, P1–P5).
3. **Job leader**, once q instances hold the key. Writes the `opened` job-log record listing each instance's `0x02` attestation, and waits for its EAS anchor.
   - *Threat note:* the host can withhold the anchor, which delays opening. It cannot open the job with fewer than q replicas.
4. **Job leader → host.** Signs and publishes the epoch-0 `JobAnnouncement`. No input can exist before this point, because no wallet has the key.

---

## §3 Handoff protocol

A **sender** S transfers keys and state to a **receiver** R. All messages travel through hosts.

**Scopes:**

| Scope | Transfers | Allowed between |
|---|---|---|
| `job` | `K_job` for one epoch, the dedupe index, the job-log head and `seq` | Instances whose notary cards are in the job's `replica_set` |
| `identity` | The keyring (`K_id`, `K_chain`), the sealed-link state key and version, and the highest governance-list versions seen | Instances of the same notary card |
| `template` | The `dup_tag` ratchet key `k_T,p` (`derived_card_revocation_propagation.md`) | Instances of notary cards that serve the same template `T` |

**Steps:**

5. **S and R** each choose a fresh 32-byte challenge and send it to the other.
   - *Threat note:* the host can drop or delay challenges, so the handoff fails (denial of service). Fresh challenges mean old attestations can't be replayed.
6. **R** generates an ephemeral X-Wing **handoff key**. It requests a purpose-`0x03` attestation with `nonce` = S's challenge and `public_key = SHA-256(handoff key)`. For `job` scope it also runs program admission and requests a purpose-`0x04` attestation for the job and epoch, with the same nonce and `public_key`. **S** requests a purpose-`0x03` attestation with `nonce` = R's challenge.
7. **Each side runs algorithm P** (below) on the other. **S** also refuses (`HANDOFF_OVER_CAPACITY`) if its heartbeats show R's notary card already holds as many instances as `replica_set` allows.
   - *Threat note:* the host can start extra enclaves of its **own** operator, up to the capacity cap. It cannot substitute its own handoff key, because the key's hash is in R's attestation. It cannot target a debug enclave, a non-accepted runtime, the wrong notary card, or an enclave without the program admitted.
8. **S** builds the payload `{ scope, keys, state, state_version, state_hash, job_log_head, seq }`. It HPKE-seals it to R's handoff key with `info = "card-notary-handoff-v1" || S challenge || R challenge`, and signs `SHA-256(ciphertext)` with its `K_inst`.
   - *Threat note:* the host sees only ciphertext. It can't read keys or state.
9. **R** checks S's signature against the `K_inst` bound in S's attestation, and opens the payload. It refuses a `state_version` lower than any it has seen in heartbeats. It installs the keys, erases the handoff key, and signs the `HandoffRecord` (`protocol-objects.md §29`) as `receiver_signature`.
   - *Threat note:* the host cannot hand R older state, because versions only go forward.
10. **The job leader** (for `job` scope) or **S** (for `identity` and `template` scopes) writes a `handoff` record to the job log or the identity log, and waits for its EAS anchor. **R does not serve** (accept inputs, co-sign, write chain payloads) until it has seen that anchor.
    - *Threat note:* the host can withhold the anchor, so R never serves. It cannot make R act without a public handoff record. This is how "every key handoff appears in the job log" is enforced.

**Algorithm P: peer check.** Run by each side on the other. Codes are listed in §Error Paths.

| # | Check | Code |
|---|---|---|
| P1 | The peer's purpose-`0x03` attestation passes algorithm V (`notary_lifecycle.md` Appendix A.1) with `inst_key_hash = SHA-256(peer K_inst)`, `nonce` = this side's challenge, `t_eval = now` and `max_age` = 5 min | `ATT_*` |
| P2 | The peer's PCR0 is accepted according to this runtime's own verified list copy. Two different PCR0s are allowed only if both are accepted (a runtime upgrade). | `HANDOFF_RUNTIME_NOT_ACCEPTED` |
| P3 | **Job scope:** the peer's notary card is in `replica_set`, and the peer proves it holds that card's `K_id` by signing the challenge. **Identity scope:** the peer's notary card is this enclave's own. **Template scope:** the peer's notary card has `issuer_card == T` and is in `T.approved_notaries`. | `HANDOFF_SCOPE_DENIED` |
| P4 | **Job scope:** the receiver's purpose-`0x04` attestation shows the same `program_hash`, `job_hash`, `epoch` and `isolation`, and both sides report the same ABI version (`notary_v1`), so their fuel accounting matches → `HANDOFF_PROGRAM_MISMATCH`. Both PCR0s' accepted-runtime entries have the same `close_compat` (`protocol-objects.md §34`), so replicas validate and compute identically at close → `HANDOFF_COMPAT_MISMATCH`. | `HANDOFF_PROGRAM_MISMATCH`, `HANDOFF_COMPAT_MISMATCH` |
| P5 | **Every scope:** no key being transferred has a lineage containing a PCR0 retired as `"vulnerable"` (`notary_runtime.md` §4). An exposed key is never handed on. | `HANDOFF_KEY_EXPOSED` |

**Runtime upgrades.** Governance retires an old runtime in one of three ways (`governance/PressRegistryBody/notary_certification.md`):
- **`superseded`:** normally 30 days' notice;
- **expedited supersede:** at least 72 hours' notice, for fixes that didn't expose keys or inputs;
- **`vulnerable`:** emergency, immediate.

What an operator does depends on how the old and new runtimes compare:

| Old and new runtime | Identity and template keys | Running jobs |
|---|---|---|
| Same `close_compat`, superseded | Handoff to new-image enclaves (P2 allows two accepted PCR0s) | **Rolling handoff**, one replica at a time. Live replicas never drop below `min_live`. Usually one old instance stops before a new one starts, because of `HANDOFF_OVER_CAPACITY`. Wallets see only a re-issued announcement. |
| Different `close_compat`, superseded | Handoff, as above | Aggregate jobs that close before `retired_at` **finish on the old image**. Longer aggregate jobs move by a **`runtime_migration` epoch** (§7). Per-input jobs move at their next `key_period` rotation, whose epoch may be keyed on new-image replicas. |
| Retired `vulnerable` | **Never handed on** (P5). The notary card is dead; the operator redoes genesis on a new image, and policy holders reissue. Template key chains are re-seeded (`derived_card_revocation_propagation.md` §1). | Every job with a key that lived in the image moves by a **`key_exposure` epoch** (§7), with fresh keys on clean replicas |

**When old enclaves stop.** An old enclave is stopped once it holds no job that still needs it and every identity and template key it held has been handed on, or is exposed. Stopping it destroys its copies, because keys exist only in enclave memory.

---

## §4 Inputs across replicas

11. **Host → a replica holding the job** (the **receiver**). `submit_input`. The receiver runs input validation B1–B11 (`notary_lifecycle.md` Appendix B).
    - *Threat note:* the host can drop the input. The contributor still holds a host receipt, so the drop is attributable to that operator.
12. **Receiver → each live peer.** The receiver forwards the same `SealedInput` (`peer_send`). Each peer runs B1–B11 independently. It returns `input_ack { input_hash, status, revision, instance, instance_signature }` signed with its `K_inst`, and its host stores the ciphertext.
    - *Threat note:* the host can route every input to one replica, or block forwarding. The receipt then never issues, which is visible to the contributor.
13. **Receiver.** When q replicas, including itself, report the same status, it issues the `ValidationReceipt` with `acks` = that count, sealed to the contributor. If that doesn't happen within 60 s, it issues no receipt.
    - *Threat note:* the host cannot obtain a receipt for an input that fewer than q replicas hold. Every acknowledged input is stored by q operators' hosts.

---

## §5 Chain-anchored close by quorum

14. **Every replica.** Waits until it holds **both** a verified block header with timestamp ≥ `closes_at` **and** a fresh NSM attestation with `timestamp` ≥ `closes_at`.
    - *Threat note:* the host can withhold headers, which delays close. It cannot close early. A fabricated header passes only the hash-linkage check, but the NSM's clock is set by AWS hardware, not the host. This depends on assumption T9, which must be confirmed on real hardware before launch; if it fails, that is a CP9 stop.
15. **Each host → its own replica.** Streams every stored `SealedInput` for the final epoch.
16. **Job leader.** Runs the close computation (`notary_lifecycle.md` step 38) and produces the notarization **body**: everything except `cosignatures` and `notary_signature`.
17. **Job leader → every live peer.** Sends the body. Each peer recomputes from the ciphertexts **its own host** supplied:
    - its counted set equals the body's `counted_inputs`;
    - every `input_hash` in its own index appears either in `counted_inputs` or in the `dropped_after_acceptance` count;
    - its own run of the program gives the same `output_hash`. Floating point is banned and the fuel table is frozen in the ABI, so honest replicas get identical bytes.

    If all three hold, the peer signs `H(body)` with `K_inst` and returns `{ attestation, instance_signature }`. It records `job_hash → H(body)`, and **never co-signs a different body for that job**.
    - *Threat note:* a host can feed its own replica an incomplete set, so that replica disagrees and close stalls (step 19). A host cannot produce two valid results for one job, because two quorums share an honest replica. It cannot get a result computed by a different program, because every cosigner runs the admitted program itself.
18. **Job leader.** With q cosignatures, including its own, adds `cosignatures` and `close_quorum`, signs `notary_signature` with `K_id`, and finalizes (`notary_lifecycle.md` Phase 7).
    - *Threat note:* the host can withhold publication of the notarization or its anchor. It cannot forge cosignatures, because each is tied to an attested instance key.
19. **Disagreement.** A peer whose recomputation differs replies `close_mismatch` with its own counted-set hash. The job stays in `CLOSING` and every operator is alerted. A replica's host can resolve it by supplying the missing ciphertexts.

---

## §6 Heartbeats, re-replication and replica loss

20. **Every replica, every 30 s.** Sends a `Heartbeat` (`protocol-objects.md §30`) to every peer. It carries:
    - its jobs and their state versions;
    - its identity-state version;
    - the governance-list versions it has verified;
    - the peers it has heard from;
    - the newest chain head it has accepted;
    - a per-instance `seq`.

    A peer silent for more than 120 s counts as down.
    - *Threat note:* the host can delay or drop heartbeats, which makes peers look down and triggers re-replication. It cannot forge or replay heartbeats, because they are signed and `seq` increases.
21. **Job leader.** When the live count falls below `min_live` while at least one replica is alive, it writes `replica_lost` (naming the silent instance) and sends its host `alert need_replica`.
    - *Threat note:* the host can kill its own replicas or claim they died. That is visible: the record is anchored, and the job halts if the anchor is missing.
22. **That operator's host.** Starts a new enclave, preferably in another availability zone. A job-scope handoff (§3) follows, and the leader writes `replicated`.
    - *Threat note:* the host can refuse to start one, which stalls the job (L1).
23. **While fewer than q replicas are live:** no validation receipts are issued and close waits. Re-replication restores service.
24. **A replica that returns after being counted down** rejoins only through a fresh handoff. It discards its old keys and state.
    - *Threat note:* the host cannot slip a stale replica back into the set.

---

## §7 Epochs, total loss and resubmission

**Epoch changes** happen in four ways:
- **`key_period`** (per-input jobs): a scheduled rotation (`notary_lifecycle.md` step 40).
- **`total_loss`**: no live replica holds `K_job,e`.
- **`runtime_migration`** *(added 2026-11-12)*: the operator moves a job to replicas running a runtime with a different `close_compat` (§3, Runtime upgrades).
- **`key_exposure`** *(added 2026-11-12)*: a key of the job's current epoch has a lineage containing a runtime retired as `"vulnerable"`. The enclave that detects it alerts the operator. The job must move to fresh keys on clean replicas.

The steps below cover all three unscheduled kinds. For `runtime_migration` and `key_exposure`, old-epoch replicas may still be live:
- The new epoch's leader writes `epoch_started` with that reason.
- Old-epoch replicas stop issuing receipts as soon as they see that record anchored, and erase `K_job,e`.
- N13 rejects any notarization from the old epoch closed after that anchor.

25. **Operator's host → an enclave.** Sends `create_job` with `restart: { prev_epoch: e, last_log: <cid of the last job-log record it has>, reason }`, where `reason` is `total_loss`, `runtime_migration` or `key_exposure`. For `key_exposure` the enclave confirms the exposure from its own verified list. For `runtime_migration` it confirms that its own `close_compat` differs from the previous epoch's. The enclave checks that chain time is still before `closes_at`. It runs §2 for epoch `e + 1` with a fresh replica set and a fresh `K_job,e+1`.
    - *Threat note:* a `runtime_migration` costs offline contributors their inputs, just as total loss does. It is accepted only when the runtimes really differ in `close_compat`, so a host can't invoke it at will. Governance should give incompatible upgrades enough notice for most aggregate jobs to finish on the old image.
    - *Threat note:* a host can **force** total loss by killing all of its own enclaves. That can't be prevented, so it is made visible (step 26), and votes should use replicas from several operators so that no single host holds a quorum (L1, L2).
26. **New job leader.** Writes `epoch_started` with `epoch_reason` = `restart.reason` and `prev` = `last_log`. It **does not publish the announcement until that record is anchored.**
    - *Threat note:* the host can point `last_log` at an older record, forking the job log (`JOB_LOG_FORK`). It cannot hide the reset, because the record is anchored and wallets report it.
27. **Wallets that have submitted to the job.** Check the announcement every 6 hours, and immediately when a receipt is missing. On finding a higher epoch, the wallet:
    1. runs algorithm W on the new announcement;
    2. tells the user, by reason:
       - `total_loss`: their input was resent;
       - `runtime_migration`: nothing (the job moved to an updated runtime, and the input was resent);
       - `key_exposure`: their input was resent, and an earlier copy may have been readable because the runtime holding the job key was found vulnerable (`notary_lifecycle.md` L11);
    3. re-encrypts its **stored signed `NotaryInput`**, the latest `revision`, unchanged and without re-signing or a new prompt, to `K_job,e+1`;
    4. submits it as in `notary_lifecycle.md` Phase 5.

    If the wallet can't build or send the resubmission (for example it is offline until close), that contributor's input is lost (L2).
28. **Latest-ballot-wins across epochs.** The new epoch's dedupe index starts empty. Each wallet resubmits its latest signed revision, so B10 keeps the highest revision per root key in the final epoch. A voter's choice is never rolled back to an earlier revision.
    - *Threat note:* the host cannot revert a voter to an earlier ballot. The wallet resubmits the latest one, and the host can't create a higher-revision input without the contributor's key.
29. **Overlapping epochs (verifier rule N13).** A notarization for `final_epoch = e` is valid only if no `epoch_started` record for a higher epoch was anchored before its `closed_at`. Step 26's anchor-first rule is what makes this checkable when a partition leaves old-epoch replicas running.

---

## §8 The sealed-link state blob

Used by `sealed_link` revocation propagation (`derived_card_revocation_propagation.md`). The blob holds the sealed-link table and the `dup_tag` history, encrypted under a **state key** that exists only in the identity keyring.

30. **Identity leader**, after each issuance or propagation batch:
    - writes a new encrypted body;
    - writes a `StateBlobHeader` (`protocol-objects.md §31`) with `version` + 1 and `prev_hash`;
    - asks its host to store both (`publish`, `pin: false`).
31. **Identity leader → other identity holders.** The new `{ version, header_hash }` goes in the next heartbeat. Each holder fetches the blob from its own host, checks its hash, and replaces its copy. A holder never accepts a lower version.
    - *Threat note:* the host can lose or delete blobs. A live holder still has the state in memory and publishes it again. The host cannot roll a holder back.
32. **New identity holder.** Receives the state key, `state_version` and `state_hash` in an identity-scope handoff (§3). It loads only a blob whose header hash matches.
    - *Threat note:* a host that offers an old blob is caught by the hash.
33. **Total loss of every identity holder.** The state key is gone, so every blob is unreadable:
    - the links are lost, and derived cards fall back to lapsing at `expires_at`;
    - the `dup_tag` history is lost, and the template key restarts from the next period.

    The operator performs notary genesis again (`notary_lifecycle.md` Phase 0), and the identity log records it.

**No on-chain anchor.** On-chain anchoring is deliberately not used for blobs. In v1 the enclave can't authenticate chain reads, and a key that never exists outside live replicas makes anchoring unnecessary for rollback protection: any replica that can read a blob learned the current version from a live peer. An optional EAS audit anchor per version may be added for public timing evidence. It is not required for correctness.

---

## §9 Colluding operators

If the operators running a quorum of a job's replicas collude (T7 fails), together they can:
- stall the job;
- force total loss;
- stream incomplete sets to all of their replicas, so that the dropped inputs agree.

`dropped_after_acceptance` and contributors' receipts (`acks ≥ q`) still expose those drops.

Even colluding, they **cannot** read inputs or keys, forge or alter a result, or make a handoff happen without a public record, as long as T1–T6 hold.

---

## Postconditions

- Every input acknowledged to a contributor is held by at least q replicas and q operators' storage.
- Each job has at most one valid notarization: one quorum, in the newest anchored epoch.
- Every key handoff, replica loss, re-replication and epoch change is in the job log or identity log, anchored with EAS.
- Total loss is visible, and online contributors' latest inputs are carried into the new epoch.

---

## Error Paths

| Code / event | Raised by | Handling |
|---|---|---|
| `ATT_*` | P1 | Refuse the handoff |
| `HANDOFF_RUNTIME_NOT_ACCEPTED` | P2 | Refuse the handoff; the operator must run an accepted runtime |
| `HANDOFF_SCOPE_DENIED` | P3 | Refuse the handoff |
| `HANDOFF_PROGRAM_MISMATCH` | P4 | Refuse the handoff; the receiver must admit the same program under the same ABI |
| `HANDOFF_COMPAT_MISMATCH` | P4 | Refuse the handoff; move the job by a `runtime_migration` epoch instead |
| `HANDOFF_KEY_EXPOSED` | P5 | Refuse the handoff; the key is never used again (§3, Runtime upgrades) |
| `HANDOFF_OVER_CAPACITY` | Sender, step 7 | Refuse; the operator already runs its allowed instance count |
| State version regression | Receiver, step 9; holders, step 31 | Refuse the state; raise an alert |
| Fewer than q acknowledgments | Receiver, step 13 | No receipt; the wallet retries |
| `close_mismatch` | Peer, step 19 | Close stalls; operators are alerted |
| Fewer than q live replicas | Leader, step 23 | Stop receipts and close until re-replicated |
| Anchor missing | Every enclave | Don't sign the next record; the new replica doesn't serve; no announcement for a new epoch |
| `NOT_QUORUM_INSUFFICIENT`, `NOT_EPOCH_SUPERSEDED` | Verifier (algorithm N) | Reject the notarization |
| `JOB_LOG_FORK`, `JOB_LOG_GAP` | Verifier (algorithm N) | Warning |

---

## Related Specs

- `process_specs/notary_lifecycle.md`: phases, algorithms V, W, G, N, input checks B1–B11, threat model
- `process_specs/derived_card_revocation_propagation.md`: users of identity and template handoffs and the state blob
- `object_specs/notary_runtime.md`: broker messages for handoff, heartbeat and close; ABI and fuel table
- `object_specs/notary_host.md`: peer relay, enclave restarts, blob storage, EAS anchoring
- `protocol-objects.md` §26–§31, §33
- `ARCHITECTURE.md` ADR-013, ADR-008 (EAS)
