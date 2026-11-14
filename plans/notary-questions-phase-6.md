# Digital Notaries — Phase 6 Implementation Questions (step 6.0, CP5)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Code plan: [notary-code-plan.md](notary-code-plan.md) · Phase 5 summary: [milestones/notary-phase-5-summary.md](milestones/notary-phase-5-summary.md) · Earlier errata: [notary-questions-5.7.md](notary-questions-5.7.md)

**Status:** Answered, "OK to all" (David, 2026-11-14): every recommendation is accepted, including the specific choices below. **No Phase 6 code has been written yet.** Each question has a recommended answer. Reply "OK to all" or answer by number. Anything marked **[security]** or **[spec]** is asked now rather than guessed (CP5, CP9). Specs are approved text, so every **[spec]** item needs your approval before it is written or implemented.

**How answers are recorded:** write the answer under **Answer:** in each question. Every question is answered, so 6.0 is done.

**What Phase 6 starts from.** Phase 5 left the broker as a single-replica runtime for aggregate jobs, with a test tally program (`notary/e2e/fixtures/tally.wasm`) and no real templates. It refuses, with `NH_UNSUPPORTED`: epoch restarts, replica sets larger than one, per-input jobs, and card output. The host schedulers cover headers, snapshots and close. The sealed-link and derived-card machinery (`dup_tag`, issuance pool, state blob, `derive`, `propagation`, `registry`, `output`) does not exist yet.

| Section | Questions |
|---|---|
| A. Plan and scope | Q1, Q2 |
| B. Templates and outputs (6.1, 6.2) | Q3, Q4 |
| C. Replication (6.3) | Q5, Q6, Q7, Q8, Q9 |
| D. Derived cards and propagation (6.4a, 6.4, 6.5) | Q10, Q11, Q12 |

---

## A. Plan and scope

### Q1. Order of work, models, and what this phase runs without a checkpoint

- **Facts.**
  - 6.1 and 6.2 (Sonnet) are small once the templates are settled (Q3, Q4). 6.3 and 6.5 are Opus. 6.4a needs CP7 before any code (`contracts/`).
  - 6.4's "Done when" is derived cards passing *standard verification*. That needs a chain that accepts `RegisterCard` from a notary acting as press, and `AuthorizePress` for the notary under the template (a governance action, CP7).
  - 6.0a (contributor-policy hardening) is meant to come first, so 6.1's notarization carries the new field from the start.
- **Recommendation.**
  1. Order: **6.0a → 6.1 → 6.2 → 6.3 → 6.4a → 6.4 → 6.5 → 6.6.** 6.3 comes before 6.4 because 6.4 and 6.5 need the identity and template handoff scopes.
  2. Build 6.4 and 6.5 against the **simulated chain** (`notary/e2e/src/sim-chain.ts`, extended with a write gate that checks the calldata binding). That chain stands in for the contract until 6.4a lands and CP7 approves any deployment. The simulated gate is test code, not a contract change.
  3. Write **no code under `contracts/` until you approve 6.4a at CP7** (Q10). 6.4's chain-side behaviour is tested on the simulated gate and re-run on the devnode after 6.4a.
  4. Sessions: Sonnet for 6.0a–6.2 and 6.4; Opus for 6.3 and 6.5; I stop after each milestone step for your review.
- **Alternative.** Do 6.4a immediately after CP7 and build 6.4 against the real devnode, which costs one checkpoint earlier but removes the simulated gate.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q2. 6.0a: exact spec wording **[spec]**

6.0a needs four pieces of approved text. Proposed wording (nothing is edited until you approve):

1. **`protocol-objects.md §27`, a new optional field:** `contributor_policies` | array | No | "The policies whose cards were counted, and the state each was read at: `[{ "policy_id": cid, "state_cid": cid, "snapshot_block": integer }]`, sorted by `policy_id`. Present whenever the job's `contributor_predicate` names a policy. `state_cid` is the policy card's head the enclave's snapshot was built against; `snapshot_block` is the block of the newest snapshot or update the enclave applied for that policy before it closed."
2. **Algorithm N (`notary_lifecycle.md` A.4), a new warning `NOTARIZATION_CONTRIBUTOR_POLICIES_UNVERIFIED`** when a listed `state_cid` is not a head of that policy at or before `snapshot_block` on the chain, and a new reject **`NOT_CONTRIBUTOR_POLICIES_MISMATCH`** when the set differs from the policies the notary policy's predicate names (after parameter references are resolved from `job.parameters`). Rationale: the first is a chain-read judgement (a warning, like the other chain-state checks, L4); the second is a pure comparison of signed data (a rejection).
3. **Admission rule (`notary_runtime.md §6`, new row A12):** "`contributor_predicate`, with parameter references resolved, reduces to a finite list of `issued_under_template` policies (`any_of` / `all_of` of those leaves), or the policy sets `participation_disclosure: true` (see below)." Code **`ADM_CONTRIBUTOR_SET_OPEN`**. `notary-lint` reports the same condition as an error.
4. **The fetch fallback:** `notary_runtime.md §9` `fetch`: "`card_head:` and `subcard:` are used only for ancestors of a contributor's chain. A contributor's own master card and sub-card must be present in a policy snapshot named in the notarization's `contributor_policies`, or the input is `INPUT_CARD_UNTRUSTED`."

- **Decision needed: refuse or warn when the set is open?** Today `LINT_NO_SNAPSHOT_POLICY` is a warning and wallets show a participation disclosure (lifecycle step 31). Recommendation: **refuse (A12) for `public: true` or `job_requester: true` outputs; allow with the existing disclosure only for jobs whose output goes to a fixed `cards` list.** Reason: an open set is the one case where per-card fetches reveal who contributed, and it matters most when the result is published. Alternative: keep it a warning everywhere and only add the notarization field.
- **Recommendation.** Approve the four pieces, with the refuse rule above. This needs a new policy field `participation_disclosure` only if you want the fixed-recipients exception; if not, drop the exception and refuse everywhere (simpler). **I recommend dropping it: refuse everywhere.**

**Answer:** OK, as recommended (David, 2026-11-14).

---

## B. Templates and outputs (6.1, 6.2)

### Q3. Template programs have fixed output schemas, so how do communities use them with no code? **[spec]**

- **Facts.**
  - Algorithm A9 requires the module's `notary.output_schema` custom section to equal the policy's `output_schema` **byte for byte** after canonicalization. The program allowlist (§34) lists program CIDs. So a template program has exactly one output schema, and each different schema is a different audited module.
  - The example vote policy (`protocol-objects.md §2.1`) uses `yes` / `no` / `abstain`. A community that wants four options, or different names, needs a different module, which is not on the allowlist, so it would run `dedicated` with the "custom program" label.
  - `param_read` gives the program `job.parameters`, which the requester signs per job, but the **output field names** must be declared by the policy.
  - "A community activates each with no code" (spec §9 G3) needs the template to cover real choices.
- **Recommendation.** Ship **slot-based template programs**, each with one fixed schema:
  1. **`vote`**: ballot `choice` is an integer enum `1..8`. Output fields `option_1 … option_8` (integers, `required: false` where unused) plus `abstain`. The job's `parameters.options` (text, bounded) gives the **labels**, shown to voters by the wallet and recorded in the signed job, and the program never reads them. A community with 3 options leaves slots 4–8 at zero and the policy sets `suppress_cell_below_k` or leaves them required `false` (omitted when 0). Three template variants are enough: `vote-4`, `vote-8` and the yes/no/abstain `vote-yna` of the existing example.
  2. **`aggregate`**: per-job `parameters.bucket_edges` is not allowed to shape the *output*, so v1 aggregate is a **fixed histogram**: one integer input field `value` (bounded range, policy-declared `clamp`), output `count`, `sum` and `bucket_1 … bucket_8`, with the bucket edges taken from the policy's `buckets` transform, not from the program. A second variant, `aggregate-counts`, counts an enum input field in up to 8 slots (the same slot idea as `vote`).
  3. Everything else is a **custom program** (`dedicated`, not allowlisted, labelled by the wallet), as the spec already describes.
- **Alternative.** Relax A9 so the program embeds the *shape* but not the *names* (output keys taken from `parameters`). That makes templates fully generic but changes approved text and lets a requester choose output field names per job, which weakens "the policy fixes what leaves the enclave". I recommend against it.
- **Build and publication.** Templates are Rust crates in `notary/templates/{vote,aggregate,derive}`, built to `wasm32-unknown-unknown` with the pinned toolchain, linted by `notary-lint`, and the built module and its CID are **committed** (`notary/templates/dist/`) with a CI check that two builds are byte-identical (code-plan §7.4). Allowlist publication is the governance script in 7.1 (CP7), not Phase 6.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q4. Private outputs: how does the enclave get the recipients' keys, and which ML-KEM code? **[security] [spec]**

- **Facts.**
  - `output_recipients.cards` holds card pointers, which are `keccak256(recipient_pubkey)`. A message is encrypted to each **sub-card's ML-KEM public key**, read from the recipient's current card head (`active_subcards`), and the head is decryptable only with a key derived from `recipient_pubkey` (ADR-006, `message_routing.md` "Sender-Side Fan-out").
  - So the enclave can't encrypt to a pointer: it needs `recipient_pubkey`, which neither the policy nor the job carries.
  - The host supplies card data. If it could choose the key, it could read every private output.
  - Rust has `hpke` with `mlkem` (X-Wing only). ML-KEM-768 for message envelopes needs another crate, and like `ml-dsa` the RustCrypto `ml-kem` crate is not independently audited (E9).
- **Recommendation.**
  1. **Carry the recipients' public keys in the signed job.** New `NotaryJob.output_recipient_keys`: `{ "<card pointer>": "<base64url recipient_pubkey>" }`, required when `output_recipients.cards` is non-empty, covering exactly those cards. The enclave checks `keccak256(pubkey) == pointer` for each, so **the host cannot substitute a key**: the pointer is the hash. The requester's wallet gets the keys from the recipients' cards. This is a new optional field on §21, so it is not a CP6 shared-object break.
  2. **Fetch each recipient's head with `fetch ipfs:` and verify it** (CID-checked, decrypted with the key derived from the verified pubkey, signatures and history checked with `notary-cards` as for any card). Read `active_subcards`; encrypt to each active sub-card's ML-KEM key. A stale head can only deliver to a sub-card that *was* active, and cannot add a recipient. State this limit in the spec (L4).
  3. **Use the RustCrypto `ml-kem` crate, pinned exactly,** with the message construction taken from the wallet SDK's existing message encryption, proven by cross-language vectors as X-Wing was (CP9 checkpoint 1 pattern): fixed seeds → ciphertext and shared secret, in both directions. If the vectors do not match, it is a **CP9 stop**.
  4. Record `ml-kem` next to E9 as unaudited, for the Phase 8 security review.
- **Needs your approval:** the `output_recipient_keys` field; the `ml-kem` dependency.

**Answer:** OK, as recommended (David, 2026-11-14).

---

## C. Replication (6.3, Opus)

### Q5. The peer wire format and instance discovery are not specified **[spec]**

- **Facts.**
  - Runtime §9 has one `peer_message { from_instance, bytes }` and one `peer_send { to_instance, bytes }`. `bytes` is opaque. The replication spec describes handoff challenges, the handoff payload, `input_ack`, the close body, cosignatures, `close_mismatch` and heartbeats, but **no byte format or message envelope** for them. Only the objects `HandoffRecord` (§29) and `Heartbeat` (§30) exist.
  - Nothing says how an enclave learns **which instances exist and which host serves them**. Step 2 says the originator hands off "to each other instance in `replica_set`", and `replica_set` names notary cards and an instance count, not instances.
- **Recommendation.**
  1. **A single peer envelope,** canonical JSON, `{ "type": "notary.peer.v1", "kind": "<kind>", "from": <instance id>, "to": <instance id>, "body": …, "instance_signature": SignatureEntry }`, signed by the sender's `K_inst`. Kinds: `hello` (challenge), `handoff_offer`, `handoff_payload`, `handoff_ack`, `input_forward`, `input_ack`, `close_body`, `close_cosign`, `close_mismatch`, `heartbeat`, `replica_gone`. The host relays bytes and never parses them. New objects are optional additions to §29–§31 and a new §35, so no existing object changes.
  2. **A host-supplied peer directory** as an *untrusted hint*: a new host→enclave message `peer_directory { peers: [{ instance, notary_card, inst_pubkey, attestation, host_url }] }`. The enclave never trusts it: every peer still passes algorithm P (purpose-`0x03` attestation, challenge, PCR0, scope). The directory only says where to send. `host_url` is what the host uses to route `peer_send`, so it is not sent into the enclave's trust.
  3. Instance id stays `SHA-256(K_inst)`, as in the spec.
- **Needs your approval:** the envelope, the new message kinds in runtime §9, and a new §35 in `protocol-objects.md`.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q6. Timers: what clock drives heartbeats, timeouts and issuance boundaries? **[spec] [security]**

- **Facts.**
  - The broker is a synchronous message handler with no timers. The spec has timed behaviour: heartbeat every 30 s, liveness window 120 s, acknowledgment timeout 60 s, handoff attestation age 5 min, per-input key grace 1 h, and (6.4) issuance batch boundaries and renewal windows.
  - The only unforgeable clock is the NSM time from an attestation. An attestation per message is expensive, and the host is untrusted: a host-supplied "now" could advance an epoch early or hold the enclave back.
- **Recommendation.**
  1. A new host→enclave message **`tick {}`**, sent about once a second per enclave. It carries **no time**. The enclave reads the attested clock **at most once per tick** and runs every due timer against that reading. A host that withholds ticks only slows timers (denial of service, L1); it cannot advance them.
  2. **All protocol time decisions use the attested clock,** never header or host time: heartbeats, liveness, ack timeouts, `key_period` rotation, issuance batch boundaries, renewal windows and the `D1` period check. Chain time stays for what the spec already assigns it (`closes_at`, together with the attested clock).
  3. The cost of one attestation per second per enclave is measured in Phase 8 on real hardware; in the simulator the clock is free. If it is too slow, the rate drops to once per 5 s with no spec change.
- **Needs your approval:** the `tick` message and the statement that periods and boundaries use attested time (a clarification to `derived_card_revocation_propagation.md §1` and `§3`).

**Answer:** OK, as recommended (David, 2026-11-14).

### Q7. Handoff capacity should be counted from the job log, not from heartbeats **[spec] [security]**

- **Facts.** Replication step 7: the sender refuses (`HANDOFF_OVER_CAPACITY`) "if its heartbeats show R's notary card already holds as many instances as `replica_set` allows". Heartbeats come through the host, which can withhold them.
- **Problem.** A hostile operator can run more instances of its own card than `replica_set` allows, holding more than its share of the quorum (T7, L1). It only needs the sender not to hear their heartbeats. The cap is the only thing separating "one operator" from "a quorum of operators", and it is also what the wallet's W7 and the verifiers' single-operator logic assume.
- **Recommendation.** The sender computes each card's live instance count from the **job log it holds** (anchored, hash-chained, and the receiver doesn't serve until its `handoff` record is anchored): instances named by `handoff` and `replicated` records for that card, minus those named by `replica_lost`. Heartbeats may only *lower* the count (a peer reports a stop). Verifiers can check the same rule from the public log: algorithm N warns **`NOTARIZATION_REPLICA_OVER_CAPACITY`** if any card appears with more live instances than `replica_set` allows. Spec change: replication step 7 and A.4 (one warning).
- **Needs your approval:** the wording in step 7 and the warning name.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q8. How does a newly started replica get the stored ciphertexts? **[spec]**

- **Facts.** At close, "each host streams every stored `SealedInput`" to *its own* replica, and each replica recomputes from the ciphertexts its own host supplied. A replica replaced by re-replication, or started on another operator's host, has a host that never stored the inputs received before the handoff. The spec does not say how it gets them. Without them the new replica cannot recompute, close stalls (`close_mismatch`), and "every acknowledged input is stored by q operators' hosts" no longer helps the replica that needs it.
- **Recommendation.** Hosts sync ciphertexts peer to peer. The handoff payload already carries the **dedupe index**, so it contains every `input_hash` the job counts. The receiving enclave tells its host `need_inputs { job_hash, hashes }` (a new enclave→host message). The host fetches each missing `SealedInput` from peer hosts through `/peer`, and **checks `H(sealed) == input_hash` itself** before storing it. This is self-authenticating, so a host can't inject a forged input, only withhold one (visible: `dropped_after_acceptance`, contributors' receipts). Spec addition: host §11–§12 and runtime §9.
- **Needs your approval:** the message and the host behaviour.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q9. What does 6.3 test, and against what? (scope)

- **Facts.** 6.3's "Done when" lists seven behaviours (kill one replica mid-vote, re-replication to `min_live`, a refused handoff per mismatch, handoffs in the log, rolling upgrade, migration epoch, emergency retirement). The code plan puts the multi-replica run in compose with three hosts and three Redis instances (7.1), and "separate simulated hosts" in 6.3.
- **Recommendation.**
  1. **6.3 uses an in-process, multi-broker harness** that connects several real `Broker`s through a controllable message bus (`HostBus`), standing in for hosts. The bus can **drop, delay, reorder, replay and rewrite** any message, and record what each "host" saw. That tests the threat notes in replication §2–§9 directly, which compose cannot. Each broker has its own simulated attested clock (Q6).
  2. **One compose scenario with three hosts** is added at the end of 6.3 and re-used as the base for 7.1: kill one replica mid-vote, re-replicate, close.
  3. Every refused-handoff case (P1–P5, `HANDOFF_OVER_CAPACITY`) and every anchored-record gate gets its own test.
  4. Runtime upgrades use the simulator's two builds with different PCR0s and `close_compat` (the sim already supports a different PCR0 per fake enclave).
- **Alternative.** Compose only, which is slower and cannot inject hostile-host behaviour.

**Answer:** OK, as recommended (David, 2026-11-14).

---

## D. Derived cards and propagation (6.4a, 6.4, 6.5)

### Q10. 6.4a: approval to write the registry write-gate change (CP7)

- **Facts.** `registry_contract.md §6.1` step 8 requires every signed field of a write payload to equal the calldata (`E-49 PAYLOAD_CALLDATA_MISMATCH`). The spec makes it a prerequisite for derived cards: without it a host could deface card heads. The work touches the logic contract and the verifier module in `contracts/` (Stylus Rust, with the ABI conventions recorded in memory) with unit tests and a devnode test. Deploying anywhere other than the local devnode is a separate approval.
- **Recommendation.** Approve 6.4a **for the local devnode only**, to start when 6.3 is done (Q1). I will bring the contract diff and its tests to you before any deployment, and make no on-chain action. If you want it sooner, say which step it should precede.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q11. The derived-card chain path: how far does "standard verification" go before Phase 7? **[spec]**

- **Facts.** 6.4's "Done when" says derived cards pass standard verification. That verification has two parts the notary can't satisfy alone: Stage 5 needs a `PressAuthorizations` entry for the notary card under the template `T` (an on-chain `AuthorizePress`, governance, CP7), and `CardVerifier` isn't yet wired to the notary pieces (Phase 7: the adapters, Stage 5 step 3a).
- **Recommendation.** In Phase 6, "standard verification" means **the TypeScript verifier's stages run over the simulated chain**, with the `AuthorizePress` entry created by the simulated registry in the test setup, and `verifyNotaryIssuedCard` (step 3a, already built) called directly. Wiring into `CardVerifier` and real `AuthorizePress` stay in 7.1. The 6.4 summary states this plainly so nobody reads it as the end-to-end claim.

**Answer:** OK, as recommended (David, 2026-11-14).

### Q12. Randomness, shuffling and issuance timing inside the enclave **[security]**

- **Facts.** The issuance pool releases cards at `issuance_batch_interval` boundaries, shuffled, with `issued_at` set to the boundary. The spec says randomness comes from the NSM's random source (runtime §4), but the simulator's fake enclave has no random-source call, and the production backend's `NsmBackend` is untested. A weak shuffle or a predictable release order would leak which request produced which card.
- **Recommendation.** Use one function in `notary-crypto`, **`fn random_bytes(n)`**, backed by `getrandom` (which on Linux reads the kernel RNG, and in the enclave the NSM-seeded RNG per runtime §4), and a Fisher–Yates shuffle that draws every index by rejection sampling (no modulo bias). Tests: a fixed-seed shuffle for determinism of the *algorithm*, and a statistical check that every permutation of a small set occurs. Add a `SimulatorBackend` random source only if the simulator needs to be deterministic. Confirm on real hardware in Phase 8 that `getrandom` is NSM-seeded (a CP9 item to add to the checkpoints).
- **Needs your approval:** adding "RNG is NSM-seeded" as CP9 checkpoint 5.

**Answer:** OK, as recommended (David, 2026-11-14).

---

## Items carried from Phase 5 that Phase 6 touches (no question)

- `NH_UNSUPPORTED` is removed as each refused feature lands (epoch restarts 6.2, replica sets 6.3, per-input and card output 6.4).
- The first-header anchor (runtime §13) needs the Phase 7 feed to start near the head; 6.3's multi-broker harness feeds each broker headers near its attested clock.
- The `ADM_RUNTIME_FULL` ceiling and the wallet retry on `INPUT_CHAIN_REF_UNKNOWN` apply to every template.
- E27 (x86_64 sandbox), E9 (unaudited ML-DSA; `ml-kem` added by Q4), E33 and the press predicate report stay open as listed in the Phase 5 summary.

## What I will do the moment the answers are in

1. 6.0a: the four spec pieces (after approval), `contributor_policies`, algorithm N, admission and lint, vectors in both languages.
2. 6.1, 6.2: the template crates and committed modules, aggregate and vote, `notary-messaging`, epochs and restart, wallet resubmission.
3. 6.3 (Opus): the peer envelope, the multi-broker harness, handoff P1–P5, heartbeats, quorum acks and close, re-replication, upgrades and exposure epochs.
4. Stop for CP7 before 6.4a; then 6.4 and 6.5 (Opus), then the 6.6 review and `milestones/notary-phase-6-summary.md`.
5. After each step: run its tests, report actual results, update code-plan §8.3, and tick only when "Done when" holds.

---

## Decisions made during 6.1 (2026-11-14)

- **Q4's recipient key home (asked and answered by David):** the recipients' ML-KEM-768 keys live in a new optional `SubCardDocument.kem_pubkey` (`protocol-objects.md §16`), read by the enclave from the verified sub-card document, plus `NotaryJob.output_recipient_keys` for each recipient's master public key (§21). The original Q4 text assumed the sub-card keys could be read from the card; they can't (`active_subcards` lists ML-DSA keys only, and `message_routing.md` says the KEM key is "derived from the registered public key via HKDF", which can't produce a KEM public key). Specs amended; the second reading of `message_routing.md` §Sender-Side Fan-out (the KEM key is *resolved separately*) is now: from `kem_pubkey`.
- **Q3 (templates):** 6.1 builds `aggregate` as a histogram. Its schema (with clamps and cell suppression below 5) is fixed in the module, so a community chooses who contributes, `k_min` and the edges. The vote template (slots) is 6.2.
- **Not asked, for your review:** `notarization.output` for a private job is `{ recipients }` and algorithm N step 10 now checks that the shape follows `output_recipients` (lifecycle A.4 amended). The wallet SDK gained `kemPublicKey` on `requestSubCard`; the wallet's device registration doesn't generate or pass one yet.

## Decisions made during 6.2 (2026-11-14), for your review

- **Epoch restart is single-replica only.** A restart is accepted for `total_loss` on a job the enclave holds. `runtime_migration`, `key_exposure` and a job the enclave doesn't hold answer `NH_UNSUPPORTED` until the identity handoff (6.3), because a new enclave needs `K_id` to extend the job log. In practice a single enclave "loses" a job's key only when its operator abandons it, so the enclave treats the operator's report as the spec does ("a host can force total loss; it is made visible"): the restart is public (`epoch_started`, anchored) and the old key is erased.
- **New operator route `POST /jobs/{hash}/restart`** (host §5) and the matching `create_job` `restart` behaviour (runtime §9), both flagged in the specs.
- **An input sealed to a past epoch is `INPUT_UNDECRYPTABLE` in every state of the new epoch** (it was `NH_JOB_CLOSED` while the new epoch was unannounced).
- **Templates:** `vote` (choice 0 to 8: 0 abstains) and `vote-yna` (yes/no/abstain). No small-cell suppression on a vote: a tally of one vote for an option must show it.
- **Host fix found by the e2e restart:** the host's job record didn't learn the log head, because the enclave publishes `opened` before it answers `create_job`; the restart route now reads the newest record from the host's log index.
