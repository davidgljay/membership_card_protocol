# Proposed Spec Wording: E31 Reads, the B3 Disclosure, and Related Errata

**Status:** **Approved by David (2026-11-12, "Approve all") and applied** to the spec files below, each with a changelog line. Each edit gives the file, the current text and the proposed text. Once approved, they are applied exactly as written, with a changelog line in each touched spec.

**Covers:**
- **B3** (E32): disclose and allow single-operator quorums;
- **Part A** of [notary-e31-proposal.md](notary-e31-proposal.md): the policy, requester and list reads, all over vsock `fetch` with no network connection from the enclave;
- the errata Part A depends on: **E20** (list read path), **E21** (policy read path), **E30** (snapshot and per-card fetch shapes);
- two small 5.3 errata, **E24** and **E25**.

Not covered: **E26** (the first identity-log record), which is still your question.

**Framing (David, 2026-11-12).** Single-operator quorums are a **bootstrap allowance**. They matter while the protocol is first deployed and few operators are active. As more operators join, communities are expected to move to multi-operator replica sets, and single-operator use is expected to stop being necessary. The wording below states this, and keeps the disclosure for as long as single-operator jobs exist.

**Term used throughout.** A job has a **single-operator quorum** when the replicas whose notary cards share one `operator_card` number at least q = ⌊N/2⌋ + 1. Such an operator alone can close the job, and so alone controls the registry state its replicas check cards against.

---

## Part 1 — B3: disclose and allow (E32)

### 1.1 `process_specs/notary_lifecycle.md` §Threat Model, limit L4

**Current:**
> | L4 | Registry reads are unverified. A recently revoked card can be counted, and a recipient's removed device may read a private output. | Wallet `chain_ref` floors. `chain_state` recorded in every notarization. |

**Proposed:**
> | L4 | Registry reads are unverified, and card checks trust the registry to say which document is a card's head. The registry state comes from each replica's own host. So a host can count a recently revoked card, let a recipient's removed device read a private output, and **forge eligible contributors**: it can fabricate cards whose chains reach a trusted root's address, because no card signature binds a card to its key without the registry (`notary-e31-proposal.md` Part B). With a **single-operator quorum**, that operator can add forged inputs to a job's count undetected. With replicas from several operators, a forged input fails at every honest operator's replica, and close stalls. | Wallet `chain_ref` floors. `chain_state` recorded in every notarization. Single-operator quorums are a **bootstrap allowance** for early deployment, while few operators are active; they are disclosed to contributors (consent) and to verifiers (warning `SINGLE_OPERATOR_QUORUM`). Once several operators are active, jobs are expected to use replicas from several operators. Verified chain reads (`card_protocol_spec.md §9`, P2) close this. |

### 1.2 `process_specs/notary_lifecycle.md` §Threat Model, assumption T7

**Current (consequence column):**
> With collusion: stalls, forced resets, and drops that agree across replicas (still exposed by receipts). Never disclosure or forgery.

**Proposed:**
> With collusion: stalls, forced resets, and drops that agree across replicas (still exposed by receipts), and forged contributors (L4). Never disclosure, and never a forged result over the inputs counted. **A single-operator quorum is collusion by construction**, so T7 holds for such a job only if that operator is honest.

### 1.3 `process_specs/notary_lifecycle.md` step 25 (consent), new bullet

**Insert after** "the notary operators and their platform;":
> - if the job has a single-operator quorum: "One operator runs enough of this job's notaries to close it alone. The count can include contributors that operator invents. Your own input stays private either way."

### 1.4 `object_specs/wallet_sdk.md` §7b.3, `NotaryConsent`

**Current:**
> `  disclosures: string[];                             // derived_card_revocation_propagation.md §8;`
> `                                                     // participation disclosure (lifecycle step 31)`

**Proposed:**
> `  disclosures: string[];                             // derived_card_revocation_propagation.md §8;`
> `                                                     // participation disclosure (lifecycle step 31);`
> `                                                     // single-operator quorum disclosure (lifecycle step 25)`
> `  singleOperatorQuorum: boolean;                     // L4: one operator's replicas reach q`

### 1.5 `process_specs/notary_lifecycle.md` Appendix A.4, algorithm N result

**Current:**
> **Result:** valid, or the first reject code. Warnings are returned with the result: `runtime_retired_vulnerable`, `notary_key_exposed_later`, the chain-state age, `JOB_LOG_GAP` / `JOB_LOG_FORK`, and any `total_loss` epochs.

**Proposed:**
> **Result:** valid, or the first reject code. Warnings are returned with the result: `runtime_retired_vulnerable`, `notary_key_exposed_later`, the chain-state age, `JOB_LOG_GAP` / `JOB_LOG_FORK`, any `total_loss` epochs, and `SINGLE_OPERATOR_QUORUM` when the replicas whose notary cards share one `operator_card` number at least `close_quorum` (L4: the count may include contributors that operator invented).

### 1.6 `object_specs/card_verifier.md` §6.5, `NotarizationVerificationResult`

**Current:**
> `      warnings: ("runtime_retired_vulnerable" | "JOB_LOG_GAP" | "JOB_LOG_FORK" | "EPOCH_TOTAL_LOSS")[] }`

**Proposed:**
> `      warnings: ("runtime_retired_vulnerable" | "notary_key_exposed_later" | "JOB_LOG_GAP" | "JOB_LOG_FORK" | "EPOCH_TOTAL_LOSS" | "SINGLE_OPERATOR_QUORUM")[] }`

(`notary_key_exposed_later` was missing from this union. Algorithm N already returns it.)

### 1.7 `card_protocol_spec.md §9`, Requirements, Replication and close

**Insert after** "a result needs a cosigning majority quorum;":
> - a job whose quorum one operator can reach alone (a single-operator quorum) is allowed as a **bootstrap allowance**, for early deployment while few operators are active, and is disclosed: on the consent screen, and as the verifier warning `SINGLE_OPERATOR_QUORUM`. Such an operator could count contributors it invents (`notary_lifecycle.md` L4). As operators join, jobs are expected to use replicas from several operators, and single-operator use should no longer be needed.

---

## Part 2 — Part A: reading policies, requesters and lists (E31, E20, E21)

### 2.1 `process_specs/notary_lifecycle.md` step 17

**Current:**
> 17. **Enclave (originator).** Repeats the wallet's job checks W2–W10 (Appendix A.2), plus a check that its own notary card is in `replica_set`. Runs program admission (algorithm A). **Only then** …

**Proposed:**
> 17. **Enclave (originator).** Repeats the wallet's job checks W2–W10 (Appendix A.2), plus a check that its own notary card is in `replica_set`. It reads the policy with **algorithm R** (Appendix A.7) and, when `job_requester_predicate` is present, the requester's chain the same way. Everything comes over vsock (`fetch`), checked by CID, and the enclave makes no network connection. Runs program admission (algorithm A). **Only then** …

### 2.2 `process_specs/notary_lifecycle.md` Appendix A.2, steps W3–W5

**Current:**
> 3. The policy chain reaches a trusted root → `JOB_POLICY_UNTRUSTED`.
> 4. `policy_state_cid` is the current head or in its history, and `notary` and `approved_notaries` are unchanged at the current head → `JOB_POLICY_CHANGED`.
> 5. The requester satisfies `job_requester_predicate` (absent means anyone) → `JOB_REQUESTER_NOT_PERMITTED`.

**Proposed:**
> 3. The policy chain reaches a trusted root → `JOB_POLICY_UNTRUSTED`. (Algorithm R, A.7, step R3.)
> 4. `policy_state_cid` is the current head or in its history, and `notary` and `approved_notaries` are unchanged at the current head → `JOB_POLICY_CHANGED`. (Algorithm R, step R2.)
> 5. The requester satisfies `job_requester_predicate` (absent means anyone) → `JOB_REQUESTER_NOT_PERMITTED`. The requester's chain is read as in algorithm R, step R5. `is_holder` holds iff `requester_card` is the policy card's holder (`keccak256` of the policy's `recipient_pubkey`).

### 2.3 `process_specs/notary_lifecycle.md`, new Appendix A.7 (after A.6)

> ### A.7 Algorithm R: reading a policy and a requester
>
> Used by the enclave at step 17, and by wallets and verifiers through the same logic. Wallets read the registry over their own chain connection. The enclave reads everything through the host over vsock (`fetch`, `notary_runtime.md` §9) and makes no network connection. Content is checked against its CID. Trust comes from the trusted roots pinned in the reader (in the enclave: the runtime image), never from where the bytes came from.
>
> **Inputs:** `policy_id`, `policy_state_cid`, the job, and the reader's trusted roots.
>
> 1. **R1. Documents.** Fetch the documents at `policy_id` and `policy_state_cid` and check each against its CID. A document is accepted as plain RFC 8785 JSON, or as AES-256-GCM ciphertext under `HKDF-SHA3-256(recipient_pubkey, "card-content-v1")`, with `recipient_pubkey` read from the `policy_id` document. The policy's registry address is `keccak256(recipient_pubkey)`. → `JOB_POLICY_UNTRUSTED`.
> 2. **R2. State.** The policy's registry entry (a `card_head:` read) lists `policy_state_cid` among its head events. The `notary` section and `approved_notaries` of the current head (decrypted as any card head, `card_verifier.md` Stage 3) equal those at `policy_state_cid`. → `JOB_POLICY_CHANGED`.
> 3. **R3. Chain.** The policy card's chain reaches a trusted root and no card on it is revoked at chain time (`card_verifier.md` Stages 3–4). → `JOB_POLICY_UNTRUSTED`.
> 4. **R4. Notaries.** Every `replica_set` card is in `approved_notaries` at the current head. → `JOB_NOTARY_NOT_APPROVED`.
> 5. **R5. Requester** (only with `job_requester_predicate`). Read `requester_card`'s head from its registry entry, decrypted under `HKDF-SHA3-256(requester_pubkey, "card-content-v1")`. The binding is already checked in W2. Run Stages 3–4 on its chain, then the predicate with the parameters resolved, with `is_holder` as in W5. → `JOB_REQUESTER_NOT_PERMITTED`.
>
> Registry reads are unverified in the enclave (L4). Wallets check R2–R4 with their own chain reads before contributing, so a host that misreports policy state can stop a job but can't mislead a contributor.

### 2.4 `object_specs/notary_runtime.md` §9, `create_job` row (E21)

**Current (broker action):**
> Job checks (`notary_lifecycle.md` step 17), then algorithm A, then `K_job` and attestation (`0x02`)

**Proposed:**
> Job checks (`notary_lifecycle.md` step 17), reading the policy and any requester chain with algorithm R (Appendix A.7) through `fetch`. Then algorithm A, then `K_job` and attestation (`0x02`).

### 2.5 `object_specs/notary_runtime.md` §12, list reads (E20)

**Current, step 1, first bullet:**
> - the two list-card addresses;

**Proposed:**
> - the two list-card addresses and their **public keys** (each address is `keccak256` of its key; the key gives the list card's content key);

**Current, step 2:**
> 2. **Signatures checked.** The host supplies each list card's genesis document and log entries. The broker checks every `intent_signature` and `press_signature` against the pinned keys, checks the `prev_log_root` chain, and runs algorithm L (`notary_lifecycle.md` Appendix A.5) against the pinned member keyset. It uses the `card_state` of the highest version that passes both.

**Proposed:**
> 2. **Read and checked.** The broker reads each list card's history through `fetch`, with no network connection: `card_head:<list card>` gives the head events in order (`notary_host.md` §8 shape), and `ipfs:<cid>` gives each version, checked against its CID and decrypted with the pinned list-card key (`decryptCardHead`). It checks every `intent_signature` and `press_signature` against the pinned keys, checks the `prev_log_root` chain, and runs algorithm L (`notary_lifecycle.md` Appendix A.5) against the pinned member keyset. A host that omits or reorders versions breaks L's `list_version` and `prev_list_hash` continuity, and a host that withholds the newest version is limit L5. The broker uses the `card_state` of the highest version that passes all checks.

### 2.6 `object_specs/notary_host.md` §8 (E30)

**Current, the snapshot contents:**
> - every `CardRegistered` and `CardHeadUpdated` under the policy, giving each card's address, current head CID and last press address;
> - the `SubCardRegistrations` entries whose master card is in the set;

**Proposed:**
> - every `CardRegistered` and `CardHeadUpdated` under the policy, giving each card's address, current head CID and last press address, and its head-event history `events: [{ cid, timestamp }]` (the block timestamp of each event, oldest first). Card checks use it for provenance and for authoritative revocation dates;
> - the `SubCardRegistrations` entries whose master card is in the set, each with `master_card`, `sub_card`, `sub_card_doc_cid` and `active`;

`policy_updates` entries also carry `timestamp`.

**Current, the per-card fetches bullet:**
> - **Per-card fetches.** These are answered only for ancestors outside snapshotted policies, and for the disclosed fallback. The host can log them; they reveal issuers, not holders.

**Proposed:**
> - **Per-card fetches.** These are answered for ancestors outside snapshotted policies, for the disclosed fallback, for policy and requester reads (algorithm R; jobs are public), and for list cards. The host can log them; they reveal issuers, policies and requesters, not contributors. Shapes: `card_head:<address>` → RFC 8785 JSON `{ "head_cid", "events": [{ "cid", "timestamp" }] }`; `subcard:<address>` → `{ "master_card_address", "sub_card_doc_cid", "active" }`.

**Current, the list cards bullet:**
> - **List cards.** The host also supplies the two governance list cards' documents and log entries, which the runtime verifies against its pinned keys, including each version's member `list_approval` (algorithm L).

**Proposed:**
> - **List cards.** The runtime reads the two governance list cards through per-card fetches (`notary_runtime.md` §12) and verifies them against its pinned keys, including each version's member `list_approval` (algorithm L).

---

## Part 3 — small 5.3 errata

### 3.1 E24: `object_specs/notary_runtime.md` §9, `genesis` row

**Current (response):**
> `genesis_ready { id_pubkey, chain_pubkey, attestation }`

**Proposed:**
> `genesis_ready { id_pubkey, chain_pubkey, attestation, request, notary_card }`. `request` is the completed genesis request whose hash is the attestation `nonce`; the enclave also `publish`es it, so the notary card can carry its CID (`genesis_request`, E17). `notary_card` is `keccak256(K_id)`.

### 3.2 E25: `object_specs/notary_runtime.md` §16, new row

> | `CLOSE_NOT_DUE` | §9 `close_chunk` | Chain time or the attested time is still before `closes_at`; nothing closed, and the host retries later (`notary_replication_and_recovery.md` §5) |

---

## Part 1b — the switch that retires the allowance (David, 2026-11-12: include)

**Design.** The switch must be protected by the member signatures, as the lists are. A field beside the list on the card wouldn't be, because `list_approval` signs only the list's hash. So it lives **inside** `list_approval` for the program allowlist, which the members sign in full. Changing it is a new list version under a **standard** approval (the quorum). The emergency path can't flip it, because rule E requires an emergency version to change nothing but retirements.

### 1b.1 `protocol-objects.md` §34, `list_approval` object

**Insert in the JSON block, after `"signatures": [ … ],`:**
> `  "single_operator_quorums": "<allowed | refused — program_allowlist only; optional, absent = allowed>",`

**Insert after the bullet "Rule E (removal only)":**
> - **`single_operator_quorums`** *(program allowlist only; added 2026-11-12)*. Whether jobs whose quorum one operator can reach alone (`notary_lifecycle.md` L4) may run. Absent means `"allowed"`, the bootstrap allowance for early deployment. When enough operators are active, the body sets it to `"refused"` by a standard update. An emergency update must carry the same value as the version it follows (rule E). Readers take the value from the verified head.

### 1b.2 `protocol-objects.md` §34, rule E

**Current (first sentence):**
> **Rule E (removal only).** Compared with the previous list, an emergency update has the same entries in the same order.

**Proposed:**
> **Rule E (removal only).** Compared with the previous list, an emergency update has the same entries in the same order, and (for the program allowlist) the same `single_operator_quorums` value.

### 1b.3 `process_specs/notary_lifecycle.md` Appendix A.2, step W7

**Current:**
> 7. The mode-specific fields are consistent, and q ≤ `min_live` ≤ N → `JOB_MALFORMED`.

**Proposed:**
> 7. The mode-specific fields are consistent, and q ≤ `min_live` ≤ N → `JOB_MALFORMED`. If the verified program allowlist's `single_operator_quorums` is `"refused"`, the replicas whose notary cards share one `operator_card` number fewer than q → `JOB_SINGLE_OPERATOR_REFUSED`.

### 1b.4 `process_specs/notary_lifecycle.md` §Error Paths, new row

*Superseded 2026-11-12 (E34, David: "drop it"): enclaves don't enforce the switch. The row now names W only; verifiers reject after the switch with `NOT_SINGLE_OPERATOR_REFUSED`. See `notary-questions-5.3.md` E34.*

> | `JOB_SINGLE_OPERATOR_REFUSED` | W (step 7), enclave (step 17) | One operator's replicas reach the quorum, and governance has retired single-operator quorums (`protocol-objects.md §34`) | Reject; the requester re-issues the job with replicas from several operators |

### 1b.5 `governance/PressRegistryBody/notary_certification.md`, new section after "Emergency Retirement"

> ## Retiring Single-Operator Quorums
>
> While few operators are active, jobs may be served by replicas of a single operator: a bootstrap allowance, disclosed to contributors and verifiers (`specs/process_specs/notary_lifecycle.md` L4). Once enough independent operators are active for communities to form multi-operator replica sets, the body retires the allowance. It sets `single_operator_quorums: "refused"` on the program allowlist's `list_approval` by a standard (quorum) update, with the usual deliberation period and a decision record. Wallets and runtimes then refuse new single-operator jobs. Jobs already running are unaffected. The body may restore `"allowed"` the same way.

### 1b.6 Verifier and SDK types

- `card_verifier.md` / `verifier/src/notary/types.ts`: `ListApproval` gains the optional `single_operator_quorums`.
- `wallet_sdk.md` §7b.2: W7 as above, with `JOB_SINGLE_OPERATOR_REFUSED` among the W codes (§7b.8 already refers to the lifecycle table).
- Algorithm L is otherwise unchanged. The value is part of the signed approval digest automatically.

## Decisions for David

1. Approve **Part 1** (the B3 disclosure: L4, T7, consent, the `SINGLE_OPERATOR_QUORUM` warning, §9) and **Part 1b** (the governance switch that retires single-operator quorums).
2. Approve **Part 2** (algorithm R; runtime §9 and §12; host §8).
3. Approve **Part 3** (E24, E25).

Any part can be approved with changes. Once approved, the edits are applied as written, the design-doc and spec-change records are updated, and implementation follows. Algorithm R and the list reads follow the 5.3a pattern (TypeScript reference, vectors, Rust port). The `SINGLE_OPERATOR_QUORUM` warning goes in the verifier and the wallet consent.
