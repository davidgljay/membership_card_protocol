# Digital Notaries — Step 6.5 (Revocation Propagation): Decisions and Questions for David

**Date:** 2026-11-19 · **Branch:** `notary` · Specs amended "Amended 2026-11-19 (6.5), for David's review": `derived_card_revocation_propagation.md`, `notary_replication_and_recovery.md`, `protocol-objects.md`, `notary_runtime.md`, `notary_host.md`. Items marked **[security]** change what an untrusted host or holder can do. Reply "OK to all" or answer by number.

| # | Topic | Kind |
|---|---|---|
| E1 | Which holder is the identity leader | **[security]** spec ambiguity |
| E2 | The successor rule, when the enclave can't read the successor | **[security]** spec gap |
| E3 | When a queued revocation becomes eligible | **[security]** spec detail |
| E4 | What makes a source update count | **[security]** spec gap |
| E5 | The state blob: who writes, who loads, and no on-chain anchor | **[security]** plan vs spec |
| E6 | Holders learn about each other | **[security]** |
| E7 | Links are made at release, not at countersign | spec detail |
| E8 | The host keeps blobs and keeps watching after the job ends | spec gap |
| E9 | New fields and codes | interface |
| E10 | The revocation `LogEntry` the notary writes | interface |
| E11 | Scope: still one replica per derived-card job | scope |

---

### E1. Which holder is the identity leader **[security]**

- **Spec.** Replication §1: "The live holder of a notary card's `K_id` with the lowest `instance`. It is the only writer of that card's on-chain payloads."
- **Problem.** Instance ids are random. Handing the identity to a standby (for resilience) can make the standby the leader, while the derived-card jobs, their pool, the tag history and the registrations live on the original enclave. The standby holds none of that state, and two enclaves would then write the card's chain payloads.
- **Code** (`propagation.rs::is_identity_leader`). Among live holders, those serving a derived-card job of the card come first, and the lowest instance id among them leads. If none serves one, the lowest id among all holders leads. Each holder says in its heartbeat whether it serves one (`identity_states[].serving`). An enclave refuses to open a derived-card job while another live holder serves one (`NH_NOT_IDENTITY_LEADER`), so there is one writer. When the serving holder dies, a standby that loaded the blob leads and keeps the watch loop running. The test kills the leader and checks that exactly one of two standbys releases the next batch.
- **Recommendation.** Amend replication §1 to say this.

### E2. The successor rule, when the enclave can't read the successor **[security]**

- **Spec.** §6 step 3: if the source card names a `successor` under the same source policy, "the link moves to the successor and is checked there", and the old card's revocation (typically 801) isn't propagated.
- **Problem 1.** The successor's entries are encrypted under the successor's key, and the enclave only has the old card's key. The link can't be checked there.
- **Problem 2.** `successor` is holder-editable (`{ "is_holder": true }`). A holder who expects to be revoked could point `successor` at any card under the policy and so escape propagation.
- **Code.** A successor is noted from a 100–102 entry. A later **8xx** of that card is not propagated if the successor is registered under the same source policy (read from the snapshot). The link then ends, and the derived card lapses at its expiry, as under `expiry_only`. A **9xx** is always propagated, successor or not.
- **Effect.** The dodge is limited to quiet revocations, and even then the card still lapses at the end of its period. Loud (safety) revocations always propagate.
- **Recommendation.** Keep, and amend §6 step 3. A real fix would have the holder's rotation statement (`key_rotation.md` §2.4, signed by both keys) given to the enclave. That needs a wallet flow, which is out of scope here.

### E3. When a queued revocation becomes eligible **[security]**

- **Spec.** §7 step 1: eligible at `source_effective_time + min_delay`, where `source_effective_time` is the block timestamp of the source update.
- **Problem.** The block timestamp comes from the host. A host that backdates it would make revocations eligible early, which weakens the timing defence.
- **Code.** Eligible at `max(block timestamp, time the enclave received the update) + min_delay`, with the receipt time taken from the attested clock (the latest tick). A host can delay a revocation (L1, bounded by expiry), but can't bring one forward.
- **Recommendation.** Amend §7 step 1.

### E4. What makes a source update count **[security]**

- **Gap.** The spec doesn't say how the enclave knows a source update is genuine. The enclave can't verify chain reads (L4), and the source card's update permissions (the source policy's `revocation_permissions`) aren't checked by the watch loop.
- **Code.** A linked update counts if its head bytes decrypt (AES-GCM) under the source card's content key and give a `code`. The content key comes from the source card's `recipient_pubkey`, which the host never sees (it's inside the encrypted card), so the host can't forge an entry. The source card's own press could, as it could revoke the source card anyway.
- **Not checked:** the entry's signatures and the source policy's revocation permissions.
- **Recommendation.** Keep for v1 and record it under L4. Checking signatures and permissions in the watch loop means running the full card checks on every linked update. That's possible (`notary-cards` has them), but it is a larger change.

### E5. The state blob: who writes, who loads, and no on-chain anchor **[security]**

- **Plan vs spec.** The implementation plan's 6.5 entry says "the state blob with on-chain anchoring". The approved spec (replication §8, protocol-objects §31) says "No on-chain anchor" and refuses rollback through versions carried in heartbeats and handoffs. I followed the spec, and changed the plan text.
- **Code.**
  - The identity leader (E1) writes a blob after each issuance or propagation batch. The body (tag history, derived keys seen, released groups, links, queue, parameters) is encrypted under the state key. The `StateBlobHeader` (`version` + 1, `prev_hash`) is signed by `K_id`, and both are published `pin: false`.
  - **Heartbeat route (step 31).** A holder loads a newer version named in a known holder's heartbeat. It accepts only bytes that hash to the named CID and a header signed by `K_id`, and never a version at or below its own.
  - **Handoff route (step 32).** A holder that received the identity at version > 0 loads only the header its handoff named (exact version and header hash). Until it has, it may not write, lead or open a derived-card job.
- **Tests.** A host that serves the old header in place of the new one leaves the new holder with no state, and it then refuses a derived-card job. When the right bytes arrive, it loads exactly that version. As a control, removing the checks lets the holder load the old version, and the test fails.
- **Not built.** Step 31's "a live holder still has the state in memory and publishes it again" (republishing a lost blob) isn't built. A blob lost by every host before a heartbeat delivers it means a standby falls behind until the next batch writes a new one.

### E6. Holders learn about each other **[security]**

- **Problem.** Holders were known only from identity handoffs each enclave took part in. If A hands the identity to B and then to C, B and C don't know each other. When A dies, both think they lead, so there are two writers. The test found this.
- **Code.** The identity handoff payload carries the sender's known holders (`holders`), and heartbeats from a known holder carry them too. A holder adds instances only from those trusted sources, never from the host's directory.
- **Recommendation.** Amend replication §3 (identity scope payload) and protocol-objects §30.

### E7. Links are made at release, not at countersign

- **Spec.** §3 step 6 records the link at countersign.
- **Code.** The link is made when the card is released and registered. A pooled card that is never released (its group never fills, or the period ends) has no on-chain presence and needs no link. Before release, a `sealed_link` input keeps only the source pointer and key. An `expiry_only` input keeps neither, not even while it waits (§5 step 1).
- **Recommendation.** Amend §3 step 6.

### E8. The host keeps blobs and keeps watching after the job ends

- **Blobs.** `pin: false` objects were held only in the host's memory, so another host could never fetch a blob. Hosts now serve unpinned objects to peer hosts (`POST /peer { kind: "object", cid }`). A `fetch ipfs:` the host can't answer asks its peers, and keeps only bytes that hash to the CID. A host restart still loses its unpinned blobs (they are in memory).
- **Watching.** Links outlive the job that issued their cards. The host keeps sending a `sealed_link` job's source-policy snapshots and updates until `ends_at` + 2 × `nullifier_period` (the latest expiry of a card that job can issue).
- **Snapshots.** A snapshot of a source policy also goes through the watch loop, so a revocation that happened while no holder was watching (a restart, a new leader) is found again.
- **Recommendation.** Amend host §8 and §11.

### E9. New fields and codes

- **Heartbeat** (§30): `identity_states: [{ notary_card, version, header_cid?, serving, holders }]`.
- **Identity handoff payload:** `state_header_cid`, `holders`.
- **`chain_submit`:** `op: "batch_update_card_heads"`, with `calldata.updates` and the `propagation_batch` (§32).
- **New code** `NH_NOT_IDENTITY_LEADER` (a derived-card job on a holder that isn't the writer).
- **Internal results, not on the wire:** `STATE_ROLLBACK`, `STATE_BLOB_INVALID`, `STATE_BLOB_UNAVAILABLE`.

### E10. The revocation `LogEntry` the notary writes

- **Fields:**
  - `version: 1`, `prev_log_root` and `history` naming the derived card's genesis CID;
  - `card_state` = the derived card's policy fields (`dup_tag`, `projected`, `source_policy`);
  - `revocation: { effective_date }` (the release time, no note), `notify_holder: true`.
- **Signatures.** `intent_signature` is by `K_id` over `{ code, notify_holder, revocation, target_card, timestamp, updater_card }` (`updater_card` = the notary card). `press_signature` is by `K_id`.
- **Encryption.** The entry is encrypted under the derived card's content key.
- **Verification.** The TypeScript verifier reads 820 as `revoked` and 920 as `loud_revocation`, and both as no longer valid (`notary/e2e/test/derived-revoked.test.ts`). It doesn't check `T.revocation_permissions` for the notary card in that test. Whether a template's `revocation_permissions` matches the notary card (`card_field_matches` on `operator_card`) is for 7.1, with the real Stage 5 wiring.

### E11. Scope: still one replica per derived-card job

- A derived-card job still runs one replica (6.4 D3). The blob lets the links and the tag history survive the enclave, and lets a standby take over propagation. It doesn't let issuance continue elsewhere: a new job is needed. Replicating the pool itself isn't specified.
