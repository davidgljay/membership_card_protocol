# Digital Notaries — Detailed Design Decisions (Phase 2)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Strategic plan: [notary-strategic-plan.md](notary-strategic-plan.md) · Phase 1 scan: [notary-spec-impact.md](notary-spec-impact.md)

**Status:** **Approved by David at CP2, 2026-11-11.** Every section is written. Decisions D1–D12 were made by David on 2026-11-11, D13–D15 at CP3 on 2026-11-12, and D16–D17 during the CP4 review, and D18 during Phase 5. All are listed in §0.3. Nothing here is spec text; Phase 3 turns the approved decisions into specs, using this document as its source of truth.

**Terminology.** "AWS Nitro Enclaves" or "the enclave" means the TEE. "nitropack" means the web framework. "Enclave attestation" (or "AWS Nitro Enclaves attestation document") means the signed document the AWS Nitro Enclaves security module (the NSM) returns; it is never the App Attest / Play Integrity "attestation" of `subcards.md` or the `DomainBindingAttestation` of `protocol-objects.md §17`. "Notary card" is what the plans call the "notary sub-card". It is an ordinary `CardDocument`, not a §16 `SubCardDocument`.

---

## §0 Overview

### 0.1 What this document settles

The 20 questions in `notary-spec-impact.md §F.2`, plus findings this phase turned up. The map from question to section is in §0.4.

### 0.2 New findings in Phase 2

These change the shape of the design. Each one is resolved below or put to David in §0.3.

1. **Every policy that cards are registered under needs a `RegisterPolicy` from `RootPolicyBody`.** `RegisterCard` requires `policy_address ∈ PolicyAuthorizerKeys` (`registry_contract.md §4.1` precondition 2; `policy_creation.md` Phase 0). So a notary policy that issues derived cards needs two governance acts before it can issue anything: `RegisterPolicy` (RootPolicyBody) and `AuthorizePress` (PressRegistryBody). Phase 1 found only the second. A notary policy that issues **nothing** (aggregation, voting) needs neither, as long as nothing is registered under it. That is why this document keeps notarization records and job logs off card logs under the notary policy (§2.1.10, decision D3). *Resolved by D1:* derived cards are issued only under a few governance-registered template policies, so communities never trigger these acts.

2. **With the write-gate gap open, an enclave-held on-chain key does not stop the host writing card heads.** The gate checks only `op` and `sequence` in the signed payload, not the calldata (`registry_contract.md §6.1` known gap; confirmed in `contracts/logic-contract/src/write_gate.rs` and `card_ops.rs`, which never compare payload fields with calldata). The host relays every payload the enclave signs. It can submit each signature once with any `card_address` and CID it likes. It cannot forge card *content* (verifiers check the ML-DSA-44 signatures inside the IPFS objects), but it can point any derived card's head at junk, so verifiers reject a valid card, or roll an on-chain anchor back to an old CID. Enclave custody of the on-chain key is still right. It limits the host to one write per signature it sees, and it becomes a full guarantee once the gate binds calldata. But the trust claim for derived cards and any on-chain rollback protection depend on that contract fix (decision D5).

3. **On-chain state-blob anchoring cannot give rollback protection in v1, and does not need to.** Without state proofs the enclave cannot authenticate what the host tells it about chain state, and by finding 2 the host can rewrite the anchor anyway. The blob key also never outlives the replicas: when every replica dies the key is gone and the blob is unreadable by design. So a replica only ever loads a blob after a handoff from a live replica, and that live replica can send the current blob hash and version over the attested channel. That gives rollback protection without the chain (decision D4; detail in §2.5).

4. **`latest_wins` has to be ordered by the contributor, not by arrival.** The host controls delivery order. If "latest" means "arrived last", the host chooses which of a voter's ballots counts. Inputs therefore carry a contributor-signed `revision` counter (§2.1.5).

5. **Deduplication keys on the master card, not the signing sub-card.** One holder can have several sub-cards. Keying dedupe on the signer would let one member vote once per device. The enclave resolves sub-card → master card and dedupes on the master card's address. Key rotation (`successor`) gives one holder a second master address; §2.6 handles this for derived cards, and §2.5 for ballots.

6. **The X-Wing job public key does not fit in the attestation's `public_key` field.** An X-Wing public key is 1,216 bytes (ML-KEM-768's 1,184 plus X25519's 32). The NSM API caps `public_key` at 1,024 bytes and `user_data` and `nonce` at 512 each. (These limits come from the NSM API documentation and are re-confirmed against the real device in step 5.2.) The attestation carries `SHA-256(job public key)`, and the full key travels in the announcement (§2.1.3).

7. **Heartbeats and handoffs need a per-instance key.** Replicas of one notary share its identity key, so a signature with that key cannot say which replica sent it. Each enclave boot generates an attested **instance key** (§1.2).

8. **The press sub-card's own `policy_id` is unspecified in the existing specs.** `press.md §2` says the press card "is issued externally". `card_protocol_spec.md §1` calls it "a sub-card of a specific policy card". Neither says which policy's `field_definitions` it satisfies. The notary card inherits the gap and has to close it (decision D6).

### 0.3 Decisions David needs to make

Each has options and a recommendation in the section named. Items marked *deviation* change a strategic-plan decision because a finding shows it can't work as written.

| # | Decision | Section | Recommendation |
|---|---|---|---|
| D1 | On-chain authorization of notaries (2.2) | §2.2.1 | **Decided 2026-11-11 (provisional; may be revisited):** shared derived-card template policies. Governance registers one policy per audited `derive` template and authorizes each operator once per template through `PressAuthorizations`. Communities never create derived-card policies. No contract change. |
| D2 | Owner and form of the accepted-runtime list, program allowlist and derived-card template policies (2.2) | §2.2.2 | **Decided 2026-11-11:** PressRegistryBody, as governance-held **list cards** updated with 3xx entries. No contract change. (Recommendation was AppCertificationBody.) |
| D3 | Where notarizations and job logs are recorded (*deviation* from "log entries on the notary sub-card's log") | §2.1.10 | **Decided 2026-11-11:** enclave-signed job log on IPFS, each record anchored by an EAS attestation. Not on the notary card's log. |
| D4 | State-blob anchoring (*deviation* from "anchored on-chain") | §2.1.13 | **Decided 2026-11-11:** no on-chain anchor. Rollback protection comes from the version and hash carried in the attested handoff and heartbeats. Optional EAS audit anchor. |
| D5 | Fix the write-gate calldata binding before derived cards launch (CP7) | §2.2.1 | **Decided 2026-11-11:** yes. A separate logic-contract change binding every signed field to calldata, done before Phase 6.4 ships. |
| D6 | Shape of the notary card | §1.3 | **Decided 2026-11-11:** one notary card per (policy, operator), issued by the policy holder, under a single governance-registered **NotaryCardPolicy** (held by PressRegistryBody) that defines its fields. |
| D7 | Differential privacy in v1 (2.4) | §2.4.1 | **Decided 2026-11-11:** specify and defer. A v1 runtime refuses policies that set a DP budget. |
| D8 | Derived-card expiry field (spec change, not CP6) | §2.1.1 | **Decided 2026-11-11:** a new optional, immutable, verifier-enforced `expires_at` on `CardDocument`. Renewal issues a fresh derived card, not code 301. |
| D10 | Detecting duplicate derived cards across operators | §2.6.0 | **Decided 2026-11-11:** a keyed, period-ratcheted `dup_tag` field on every derived card, with the key shared by all enclaves serving the template. |
| D11 | Code for a propagated revocation | §2.6.6 | **Decided 2026-11-11:** new codes 820 (quiet) and 920 (loud). 8xx maps to 820 and 9xx to 920 by default; a policy may fix one code. The exact subcode is never copied. |
| D12 | `PressIssuanceRecord`s for derived cards | §2.6.9 | **Decided 2026-11-11:** none. `protocol-objects.md §11` gains an exception; the job log carries issuance counts only. |
| D13 | Cards from verified HTTPS responses (zkTLS / Reclaim-style) | — | **Decided 2026-11-12 (CP3):** reserve `derived_card.source_kind: "web_evidence"` now, refused in v1; the feature is a P2 follow-on, with attestor trust an open security question. |
| D14 | Emergency retirement of runtimes and programs | §2.2.2 | **Decided 2026-11-12 (CP3):** adopted. 2 of 5 members, immediate, removal-only, ratified or reversed by the full body within 7 days. |
| D15 | Enforcing governance list thresholds | — | **Decided 2026-11-12 (CP3):** every list version carries PressRegistryBody member signatures (`list_approval`, algorithm L). Quorum for standard changes, 2 for removal-only emergency retirements. The list-holder key alone can no longer change acceptance. |
| D16 | Card checks inside the enclave | — | **Decided 2026-11-12 (CP4 review):** card checks are ported to Rust (`notary-cards`) and kept in step by TypeScript-generated vectors, CI regeneration, a coverage map and differential fuzzing (`notary-code-plan.md` §7.5). |
| D17 | Runtime upgrades and key exposure | — | **Decided 2026-11-12 (CP4 review):** work moves while running, by rolling handoff (same `close_compat`) or a `runtime_migration` epoch. Keys that lived in a runtime retired `"vulnerable"` are exposed (algorithm E) and never handed on. Retirement gains an expedited supersede path (quorum, 72-hour minimum deliberation and notice), approved by David. |
| D18 | Enclave card reads and single-operator jobs | — | **Decided 2026-11-12 (Phase 5):** policies, requesters and governance lists are read over vsock `fetch` only (algorithm R; no network connection from the enclave). A host running every replica of a job can forge eligible contributors (L4). Single-operator quorums are a disclosed **bootstrap allowance**, retired by PressRegistryBody through `single_operator_quorums` on the program allowlist once several operators are active. |
| D9 | Who may open a derived-card job for a given source policy | §2.1.1 | **Decided 2026-11-11:** anyone. (Recommendation was the source policy's holder.) Consequence for §2.6: nullifiers can't be scoped per job, or a holder could collect one derived card per job. |

### 0.4 Question map (`notary-spec-impact.md §F.2`)

| Q | Answered in | Q | Answered in |
|---|---|---|---|
| 1 names and predicates | §2.1.1 | 11 state-blob anchoring | §2.1.13, D4 |
| 2 one policy or two | §2.1.1 | 12 inner HPKE layout and suite binding | §2.1.5 (layout); §2.3 (checks) |
| 3 derived-card `valid_until` | §2.1.1, D8 | 13 `user_data` layout and freshness | §1.4 (layout); §2.3 (freshness) |
| 4 signature carrier and key binding | §1 | 14 runtime and DP | §2.4 |
| 5 notarization log entry | §2.1.10, D3 | 15 replication and recovery | §2.5 |
| 6 job log | §2.1.10, D3 | 16 nullifier, anonymity set, batching | §2.6 |
| 7 announcement hosting | §2.1.3 | 17 watch loop | §2.6 |
| 8 on-chain option | §2.2.1, D1, D5 | 18 code mapping | §2.6 (field reserved in §2.1.1) |
| 9 key custody | §1 | 19 `PressIssuanceRecord`s | §2.6 |
| 10 governance owner | §2.2.2, D2 | 20 terminology note | §2.7 (Phase 3 action) |

### 0.5 Conventions for every notary object

- **Serialization.** Canonical RFC 8785 JSON (`card_protocol_spec.md` Appendix A). Absent optional fields are omitted, never `null`.
- **Hashes.** `H(x) = SHA-256(JCS(x))`. Hashes and other bytes are base64url without padding, matching the rest of `protocol-objects.md`. SHA-256 matches the CID multihash the press already produces (`registry_contract.md §3.1`), so an object pinned to IPFS as raw JCS bytes (CIDv1, `raw` codec, sha2-256) has a CID whose digest equals `H(object)`. Notary objects that are public are pinned that way.
- **Domain separation.** Every signed notary object has a `type` field naming the object and its version, e.g. `"notary.job.v1"`. One key (the notary identity key) signs several kinds of object. The `type` field means a signature on one kind can never verify as another. Verifiers reject an object whose `type` is not the one they expect.
- **Signature carrier.** `SignatureEntry` (`protocol-objects.md`, Common Sub-Objects): ML-DSA-44 `public_key` plus `signature` over JCS of the object without that signature field. The signer's address is `keccak256(public_key)`, and the verifier binds it to the card pointer the object names. There is no new carrier. Enclave provenance is a separate check (§1.4).
- **Timestamps** are ISO 8601 UTC. Wherever a time decides an outcome (close, expiry, list acceptance), the enclave and verifiers use **chain time**, the timestamp of a block, not a clock the host controls.

---

## §1 Keys, identity and binding

Answers Q4 and Q9. Every schema in §2.1 depends on this section.

### 1.1 Decision

The notary card's key is born in an enclave, never leaves enclaves, and is handed between enclaves only by mutual-attestation handoff. The operator's host holds only its own receipt key and the gas wallet.

### 1.2 Key inventory

| Key | Algorithm | Born | Held by | Survives restart? | Used for |
|---|---|---|---|---|---|
| **Notary identity key** `K_id` | ML-DSA-44 | In an enclave, at notary genesis (§1.3) | Enclaves of this notary only | Yes, by handoff to live replicas. Lost if every enclave holding it dies at once. | `recipient_pubkey` and `holder_signature` of the notary card; `issuer_signature` and `press_signature` of derived cards; `press_signature` and `intent_signature` on derived-card log entries; signatures on announcements, validation receipts, notarizations, job log records |
| **Notary chain key** `K_chain` | secp256r1 | With `K_id`, in the same enclave | Same as `K_id` | Same as `K_id` | On-chain write payloads (`RegisterCard`, `UpdateCardHead`, `BatchUpdateCardHeads`) for derived cards. Unused by notaries that issue no cards. |
| **Instance key** `K_inst` | ML-DSA-44 | Fresh at every enclave boot | That one enclave | No | Heartbeats, the handoff protocol, saying which replica did what in job log records |
| **Job key** `K_job` | X-Wing (ML-KEM-768 + X25519), draft-06 | Per (job, epoch), after the program is loaded and hashed | The broker process, in every live replica of the job | Within an epoch, by handoff. A new epoch has a new key. | Decrypting `SealedInput`s |
| **Operator host key** `K_host` | ML-DSA-44 | On the operator's host | The host | Yes (the operator's own storage) | `HostReceipt`s. Its public key is a field on the notary card (§1.3). |
| **Host gateway key** | X25519 (existing OHTTP suite) | On the host | The host | Yes | Outer OHTTP envelope only (`oblivious_transport.md`) |
| **Gas wallet** | secp256k1 (Ethereum) | On the host | The host | Yes | Pays gas. Signs nothing the protocol checks. Same split as `PRESS_GAS_WALLET_PRIVATE_KEY` in `press.md §2`. |

A notary that serves several policies holds one `K_id`/`K_chain` pair per notary card (one card per policy, §1.3). The enclave keeps them in a keyring and hands the keyring over as a unit.

**Runtime invariants.** These are written into the runtime spec and covered by admission tests:
- (I1) The runtime never exports `K_id`, `K_chain`, `K_job` or `K_inst`, except to another enclave over the handoff protocol (§2.5).
- (I2) The runtime never imports a key except by that handoff protocol. In particular it never accepts a host-supplied identity key. This is what makes "an accepted runtime's attestation names `K_id`" imply "`K_id` was born in an accepted runtime".
- (I3) The runtime puts a key's hash in an attestation's `user_data` only if it holds that key.

### 1.3 The notary card and notary genesis (decision D6)

**What the card is.** One notary card per (notary policy, operator). Issued by the policy card's holder, as the strategic plan says (the "sub-card of the policy" pattern from `card_protocol_spec.md §1`). Its `recipient_pubkey` is `K_id`, and its `holder_signature` is made by `K_id` inside the enclave. That enclave countersignature is the operator's acceptance: the operator's host asks its enclave to countersign, and the enclave's attestation proves the countersigning key is enclave-held.

**Which policy it is issued under (finding 8).** Options:

| Option | How | Trade-off |
|---|---|---|
| **(a) A single notary card policy** *(recommended)* | Governance registers one `NotaryCardPolicy` once (`RegisterPolicy` by RootPolicyBody) and runs or approves one press for it. Its `field_definitions` define the notary card fields below. Its `requester_predicate` admits any policy card holder. Every notary card has `policy_id = NotaryCardPolicy` and `issuer_card = <the notary policy>`. | One-time governance act. Afterwards a community adds an operator with no governance step, which meets G3. Notary cards get a defined, verifier-checkable schema. Verifiers walk notary card → issuer (the notary policy) → that policy's chain. |
| (b) Issue under the notary policy itself | `policy_id = P` | The notary card would have to satisfy `P.field_definitions`, which describe the derived card. That breaks the "schema is a floor" rule. It also makes `P` need `RegisterPolicy` even for aggregation and voting. |
| (c) One governance-certified notary card per operator | Like login service cards: a certifier issues one card per operator, and many policies list it in `approved_notaries` | Lightest for communities. But it changes the fixed decision ("issued by the administrator"), moves operator vetting to governance, and the policy holder loses the card-level revocation lever. |

**Notary card fields** (the `field_definitions` of `NotaryCardPolicy` under option (a)):

| Field | Type | Required | Update policy | Notes |
|---|---|---|---|---|
| `operator_card` | `card-pointer` | Yes | immutable | The operator's own ordinary card. It is the accountable party and the messaging address for the policy holder. |
| `operator_host_pubkey` | `base64url` | Yes | `{ "is_issuer": true }` | `K_host` public key (ML-DSA-44). Rotated by the policy holder at the operator's request with code 300. |
| `chain_pubkey` | `base64url` | Yes | immutable | `K_chain` public key (secp256r1, 64 bytes x‖y). Must equal the key later registered in `PressAuthorizations` (D1). |
| `platform` | `text` | Yes | immutable | `"aws-nitro-enclaves"` or `"simulator"`. Verifiers in production reject `"simulator"`. |
| `genesis_attestation` | `cid` | Yes | immutable | The enclave attestation produced at genesis (layout §1.4, `purpose = genesis`). |

**Notary genesis.**
1. The operator's host asks a fresh enclave to create an identity. The enclave generates `K_id` and `K_chain`, then requests an attestation with `purpose = genesis` and `user_data` binding `keccak256(K_id_pub)` and `SHA-256(K_chain_pub)`.
2. The host sends the policy holder the two public keys, the attestation, `operator_card` and `operator_host_pubkey`.
3. The policy holder's wallet verifies the attestation (the §2.3 algorithm: AWS root, PCR0 on the accepted list, the key hashes). It then builds the notary card offer and signs `issuer_signature`.
4. The enclave checks that the offer's `recipient_pubkey` is its own `K_id`, that `chain_pubkey` is its own `K_chain`, and that `genesis_attestation` is its own. It then countersigns with `K_id`. The host never sees the private key.
5. A press for `NotaryCardPolicy` registers the card. The policy holder adds it to `approved_notaries`. For a derived-card template policy `T`, `AuthorizePress(T, notary_card_address, chain_pubkey, keccak256(K_id_pub))` follows (D1). This is once per (template, operator), not per community.

**Why the notary card holds the enclave key, not the operator's key.** Derived cards carry the notary card in `issuer_card` and `press_card`, and verifiers check `press_signature` against the press card's `recipient_pubkey` (Stage 5). If that key were the operator's, the operator could mint derived cards with no source card at all. That would break the derived-card trust claim.

**Alternatives considered.**
- *A per-boot instance card under an operator-held notary card.* Each restart would mint a new card. Under D1 that also means a new `AuthorizePress`, which is a governance act on every restart. Rejected.
- *An operator-held notary card plus enclave keys certified only by attestation.* Breaks the Stage 5 check, as above. Rejected.

**Consequence: total loss.** If every enclave holding a `K_id` dies at once, that notary card can no longer sign. The operator stands up a new identity (genesis again), and the policy holder issues a new notary card. For a derived-card policy this also needs a new `AuthorizePress`. Derived cards issued under the old card stay valid until `expires_at`. Their revocation permission names the operator, not the dead key (§2.1.1 `revocation_permissions`), so the new notary card can still revoke them under `sealed_link`, but only if the sealed links survived. They don't survive total loss, so those cards fall back to expiry. That is the designed behaviour.

### 1.4 Attestation binding (`user_data` layout)

Every enclave attestation the runtime requests has this fixed binary layout. JSON would make the size and the parsing ambiguous.

```
user_data (≤ 512 bytes) =
  "CARDNOTARY" (10 bytes, ASCII)          domain tag
  || layout_version   (1 byte)  = 0x01
  || purpose          (1 byte)  0x01 genesis | 0x02 job | 0x03 instance (boot)
                                 | 0x04 admitted (program admitted for a job, no job key yet; §2.3.7 P4)
  || id_key_hash      (32)      keccak256(K_id public key), i.e. the notary card address
                                 (0x01, 0x02, 0x04; zeros for 0x03)
  || chain_key_hash   (32)      SHA-256(K_chain public key)    (0x01 only; else zeros)
  || inst_key_hash    (32)      SHA-256(K_inst public key)     (all purposes)
  || program_hash     (32)      SHA-256 of the WASM module     (0x02, 0x04; else zeros)
  || job_hash         (32)      (0x02, 0x04; else zeros)
  || epoch            (8, big-endian uint64)                   (0x02, 0x04; else zeros)
  || isolation        (1 byte)  0x01 shared | 0x02 dedicated   (0x02, 0x04; else 0x00)
public_key = SHA-256(K_job public key) for purpose 0x02;
             SHA-256(ephemeral handoff key) for 0x03/0x04 made during a handoff (§2.5.3);
             absent otherwise (including the boot 0x03 at hello)
nonce      = job_hash for 0x02; H(genesis request) for 0x01 (§2.3.5);
             for 0x03 and 0x04, a fresh 32-byte challenge chosen by the enclave that will
             verify it (§2.3.7) and relayed by the host
```

The fixed size is 181 bytes. Because `user_data` binds `K_inst`, `K_id` and the job together, a wallet holding a job attestation knows that the enclave running this program for this job also holds the notary card's key and is a particular instance. The binding of `isolation` lets a wallet confirm the runtime actually ran the job in the mode the policy requires.

---

## §2.1 Object schemas

Answers Q1–Q7. Field tables give type, whether required, and notes. Every object has an example. The signature rule is §0.5 unless a table says otherwise.

### 2.1.1 Notary policy: `PolicyCardDocument` changes

**Decision (Q2).** One `PolicyCardDocument` carries both `field_definitions` and a new `notary` section. For a derived-card policy, `field_definitions` describe the derived card. For an aggregation or vote policy, `field_definitions` is `[]` (the field stays required, as today). No `notary.output_policy_id` is needed.

**Decision (Q1, naming).** The top-level `requester_predicate` and `recipient_predicate` keep their meaning: they govern who may *request issuance of* and *receive* a card under this policy. On a derived-card policy the recipient is the holder presenting a source card. The notary-specific predicates live inside `notary` with names that cannot be confused with them: `job_requester_predicate` (who may open a job) and `contributor_predicate` (whose cards may submit inputs). For a derived-card policy `contributor_predicate` is the *source-card* predicate, evaluated on the presented card's chain. The top-level `recipient_predicate`, if any, is evaluated on the holder's other credentials as usual. The two are independent.

**New top-level field.**

| Field | Type | Required | Default update policy | Notes |
|---|---|---|---|---|
| `approved_notaries` | `card-pointer-array` | No | `{ "is_holder": true }` | Notary cards that may serve jobs under this policy. Wallets read it from the policy's **current** head. Removing an entry stops new jobs and new inputs at once. For derived-card policies the on-chain `PressAuthorizations` entry is authoritative for writes, as for presses (ADR-011). |

**New `notary` section.** Default update policy for the whole section is `{ "is_issuer": true }`, so a change to what runs can never be made by the holder alone. Jobs pin the policy state they were opened against (§2.1.2), and wallets refuse a job whose pinned `notary` section differs from the current one.

| Field | Type | Required | Notes |
|---|---|---|---|
| `program_cid` | `cid` | Yes | CIDv1, `raw` codec, sha2-256. `program_hash` is its digest, which equals `SHA-256` of the module bytes. |
| `mode` | `text` | Yes | `"aggregate"` (one output per epoch's key, then the key is erased; votes are aggregate jobs with a close time) or `"per_input"` (standing job, one output per input, key rotated each `key_period`). |
| `input_schema` | `field-definition-array` | Yes | The contributor's `payload`, in the existing field type system (`card_protocol_spec.md` §The Field Type System) minus `update_policy`. One grammar for every schema in the protocol. |
| `input_replacement` | `text` | Yes | `"reject_duplicates"` (first valid input per contributor counts) or `"latest_wins"` (highest `revision` per contributor counts, finding 4). A contributor is identified by their master card's root key (§2.4.7 B10). |
| `contributor_predicate` | `card-predicate` | Yes | Evaluated on the contributor's **master** card chain (finding 5). |
| `job_requester_predicate` | `card-predicate` | No | Evaluated on the job requester's card chain. Absent means anyone may open a job (template policies, D9). `{ "is_holder": true }` means only the policy holder. |
| `parameter_bounds` | `field-definition-array` | No | Job parameters and their limits, in the same grammar (`min`, `max`, `regex`, `enum`). Absent means the job takes no parameters. |
| `output_schema` | `field-definition-array` | Yes | The program's output value. Must equal the module's `notary.output_schema` custom section byte for byte after JCS (§2.3). v1 field types are `integer`, `boolean` and `text` with a required `enum` (§2.4.9). Integer fields may carry the privacy transforms below. |
| `output_action` | `text` | Yes | `"statement"` or `"card"`. |
| `output_recipients` | object | If `statement` | `{ "public": bool, "job_requester": bool, "cards": card-pointer-array }`. If `public` is false, the output is encrypted to each listed party. Absent for `"card"`, where the derived card always goes to the presenting holder. |
| `retention` | `text` | Yes | `"none"`, the only v1 value. Stated so a future value can't be inferred from absence. |
| `platform` | `text` | Yes | `"aws-nitro-enclaves"`. `"simulator"` is valid only against a test attestation root. |
| `isolation` | `text` | Yes | `"shared"` or `"dedicated"`. `"shared"` is valid only if `program_cid` is on the allowlist (§2.2.2). |
| `privacy` | object | Yes | `{ "k_min": int ≥ 1 }`. If fewer than `k_min` distinct root keys (§2.4.7 B10) are counted, the output is the fixed value "insufficient participation". `"dp"` is reserved (D7). |
| `limits` | object | No | `{ "fuel": int, "memory_pages": int, "wall_ms": int, "max_inputs": int }`. Each value must be at or below the runtime's ceilings. Absent fields take the runtime defaults. |
| `derived_card` | object | If `card` | `{ "nullifier_period", "renewal_window", "issuance_batch_interval": duration, "min_batch_size", "min_anonymity_set": int }`. A card's validity equals its period. Semantics and defaults in §2.6.11. |
| `revocation_propagation` | object | If `card` | `{ "mode": "expiry_only" \| "sealed_link" \| "escrowed_link", "propagated_codes": [int or "8xx" or "9xx"], "derived_code": "range" or int, "batch_window": duration, "min_delay": duration, "min_revocation_batch": int }` (§2.6.11). `"escrowed_link"` is specified but refused by the v1 runtime. Default `propagated_codes` is `["8xx","9xx"]`. Whether `derived_code` is fixed or maps code for code is §2.6 (Q18); the field is reserved now. |

**Privacy transforms on `output_schema` fields** (numeric types only). Applied by the runtime, in this order, to whatever the program returns: `clamp: [min, max]`, then `round_to: number` or `buckets: [edge, …]` (mutually exclusive), then k-suppression of the whole output. A field may also set `suppress_cell_below_k: int` for histogram-style outputs, where each cell is suppressed separately. Details and the exact rounding rule are in §2.4.

**Derived-card expiry (Q3, decision D8).** `PolicyCardDocument.valid_until` already means "the press stops issuing under this policy", and a policy card is itself a `CardDocument`. So a card-level field cannot also be called `valid_until`. Options:

| Option | Trade-off |
|---|---|
| **(a) New optional protocol field `expires_at` on `CardDocument`** *(recommended)* | Set at genesis, immutable, covered by all three signatures. Verifiers treat the card as lapsed at `expires_at` (chain time), with the same "historical signatures valid before" semantics as an 8xx. Any policy may use it. It is optional and absent from existing cards, so existing tests and registered cards are unaffected and **CP6 is not triggered**. Verifiers must learn to enforce it, which is a `card_verifier.md` change. |
| (b) A policy-defined `timestamp` field named in `notary.derived_card` | No `CardDocument` change, but generic verifiers would not enforce it. Only notary-aware verifiers would. |
| (c) Mutable expiry renewed with code 301 | Keeps one derived card per holder for life, which links the holder's uses over time. Needs a mutable field and a write per renewal. |

**Renewal** under (a) is re-presenting the source card and receiving a **fresh** derived card with a new key. Code 301 is not used. Unlinkability across periods is better, and the cost is the same: one registry write per renewal.

**Derived-card template policies (follows from D1).** Derived cards are issued only under governance-registered template policies (§2.2.1). This changes what lives where:

| Item | Where it lives | Notes |
|---|---|---|
| Card shape | `T.field_definitions`, fixed per template: `source_policy` (`cid`), `projected` (`text` holding RFC 8785 JSON, because the field type system has no object type), `dup_tag` (`base64url`, §2.6.0); plus the protocol field `expires_at` (D8) | `projected` holds field values copied **verbatim, under their source-policy names**, from the presented card. There is no free-text claim label. A requester could otherwise write "Verified Meta executive" over a running-club card. A verifier reads `source_policy` (a CID it can resolve) and the projected values, never requester wording. |
| Which source cards are accepted | Job parameter `source_policy` | `T.notary.contributor_predicate` refers to the parameter: `{ "issued_under_template": { "param": "source_policy" } }`. This **parameter reference** is a new predicate form, allowed only inside a `notary` section and resolved against the job's signed `parameters` before evaluation. It is a spec addition to `card_protocol_spec.md` §The Predicate System (Phase 3). |
| Which fields are projected | Job parameter `projected_fields` (array of field names) | Bounded by `T.notary.parameter_bounds`, e.g. at most 3 fields, with types the template supports |
| Who may open a derived-card job | `T.notary.job_requester_predicate` | **Anyone (D9).** The predicate is absent, meaning unconstrained. A third party may open a derivation of a community's cards, and the community can't stop it. Harm is bounded because a derived card states only the `source_policy` CID and verbatim source values, with no requester wording. Consequence for §2.6: if nullifiers were scoped per job, a holder could collect one derived card per job opened against their source policy. Nullifiers are therefore scoped per (template `T`, `source_policy`, `nullifier_period`) within a notary card. Across *different* operators, which hold separate nullifier sets, §2.6 must either accept duplicates or require a shared nullifier. |
| Nullifier and anonymity set | Scoped per (`T`, `source_policy`, period), not per job (D9) | §2.6 |
| `approved_notaries`, `auditors`, `revocation_permissions` | On `T`, maintained by `T`'s holder (governance) | |

**Derived-card `revocation_permissions`.** `chain_includes: <operator_card>` would not work: the operator card is a *field* of the notary card, not an ancestor in its chain. The existing leaf that does work is `card_field_matches`: `{ "card_field_matches": { "template": "<NotaryCardPolicy CID>", "field": "operator_card", "regex": "^<operator card pointer>$" } }`, one alternative per approved operator inside `any_of`. This lets the operator's *current* notary card revoke cards an earlier notary card of the same operator issued (§1.3 total loss), and no new predicate leaf is needed. It assumes the subject's own card counts as part of "the subject's chain"; Phase 3 confirms that against `card_validation.md`. The 8xx predicate also keeps `{ "is_holder": true }` so holders can surrender. Exact predicate and update rule in §2.6.

**Example** (vote policy; ellipses are the ordinary `CardDocument` fields):

```json
{
  "allow_open_offers": false,
  "approved_notaries": ["<notary card pointer A>", "<notary card pointer B>"],
  "field_definitions": [],
  "notary": {
    "contributor_predicate": { "issued_under_template": "<club membership policy CID>" },
    "input_replacement": "latest_wins",
    "input_schema": [
      { "name": "choice", "type": "text", "required": true, "enum": ["yes", "no", "abstain"], "description": "Ballot choice" }
    ],
    "isolation": "shared",
    "job_requester_predicate": { "is_holder": true },
    "mode": "aggregate",
    "output_action": "statement",
    "output_recipients": { "cards": [], "job_requester": true, "public": true },
    "output_schema": [
      { "name": "yes", "type": "integer", "required": true, "description": "Yes votes" },
      { "name": "no", "type": "integer", "required": true, "description": "No votes" },
      { "name": "abstain", "type": "integer", "required": true, "description": "Abstentions" }
    ],
    "parameter_bounds": [
      { "name": "question", "type": "text", "required": true, "regex": "^.{1,280}$", "description": "Question shown to voters" }
    ],
    "platform": "aws-nitro-enclaves",
    "privacy": { "k_min": 5 },
    "program_cid": "<CID of vote template v1>",
    "retention": "none"
  },
  "policy_id": "<meta-policy CID>",
  "...": "..."
}
```

**Alternatives considered.** A separate `NotaryPolicyDocument` type was rejected. It would duplicate the chain walk, the predicates and the update machinery, and the strategic plan fixes the notary policy as a `PolicyCardDocument`. Prefixing the existing top-level predicates was rejected because existing policies would need migration.

### 2.1.2 NotaryJob

**Stored on:** IPFS (public, raw JCS), and inside every announcement.
**Signed by:** the job requester's card (`requester_signature`). For a standing derived-card job, this is the policy holder.
**Identity:** `job_hash = H(complete NotaryJob, including requester_signature)`, the same convention as the open-offer ID. It is the attestation nonce.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.job.v1"` |
| `policy_id` | `cid` | Yes | The notary policy's genesis CID, as in `CardDocument.policy_id` |
| `policy_state_cid` | `cid` | Yes | The policy's log head when the job was signed. Wallets check that its `notary` section and `approved_notaries` are unchanged at the current head. |
| `requester_card` | `card-pointer` | Yes | Must satisfy `notary.job_requester_predicate` |
| `requester_pubkey` | `base64url` | Yes | Untrusted hint. Binding check `keccak256(requester_pubkey) == requester_card`, as for `OpenCardOffer.issuer_pubkey`. |
| `replica_set` | array | Yes | `[{ "notary_card": card-pointer, "instances": int ≥ 1 }]`. Every `notary_card` must be in `approved_notaries`. One entry means one operator. Listing several operators makes cross-operator replicas, recommended for votes. |
| `min_live` | `integer` | Yes | q ≤ `min_live` ≤ N, where N is the total instances and q = ⌊N/2⌋ + 1 (§2.5.1). Default 2 of 3. |
| `kem` | `text` | Yes | `"x-wing-draft-06"`. The only v1 value. Binding the suite into `job_hash` means the attestation covers it (finding 6 of Phase 1). |
| `parameters` | object | Yes | Validated against `notary.parameter_bounds`. `{}` if none. |
| `opens_at` | `timestamp` | Yes | Chain time. Inputs earlier than this are rejected. |
| `closes_at` | `timestamp` | `aggregate` | Chain time. The enclave finalizes only when shown a block with timestamp ≥ `closes_at` (§2.5). |
| `key_period` | duration | `per_input` | How often the job key rotates (each rotation is a new epoch) |
| `ends_at` | `timestamp` | `per_input` | When the standing job stops. Maximum one year after `opens_at`. |
| `requester_text` | `text` | No | Shown only as labelled requester text, never as consent content (G2). At most 1,000 characters. |
| `created_at` | `timestamp` | Yes | |
| `nonce` | `base64url` | Yes | 16 random bytes, so two otherwise identical jobs have different hashes |
| `requester_signature` | `SignatureEntry` | Yes | Over JCS of all other fields |

```json
{
  "closes_at": "2026-12-01T00:00:00Z",
  "created_at": "2026-11-11T18:00:00Z",
  "kem": "x-wing-draft-06",
  "min_live": 2,
  "nonce": "<16 bytes>",
  "opens_at": "2026-11-15T00:00:00Z",
  "parameters": { "question": "Move Saturday runs to 8am?" },
  "policy_id": "<vote policy genesis CID>",
  "policy_state_cid": "<vote policy head CID>",
  "replica_set": [
    { "instances": 2, "notary_card": "<notary card A>" },
    { "instances": 1, "notary_card": "<notary card B>" }
  ],
  "requester_card": "<organizer card>",
  "requester_pubkey": "<ML-DSA-44 pubkey>",
  "requester_signature": { "public_key": "<organizer pubkey>", "signature": "<sig>" },
  "type": "notary.job.v1"
}
```

**Alternatives considered.** Reusing `OpenCardOffer` was rejected. Its `proposed_fields`, `max_acceptances` and `OpenOfferUseCounts` semantics are bound to press issuance (Phase 1 §A.1).

### 2.1.3 JobAnnouncement

**Hosted by (Q7):** the notary host, at `GET /jobs/{job_hash}/announcement`. The host is reachable through the relay's oblivious transport, so fetching an announcement doesn't reveal the wallet's IP. Every epoch's announcement is also pinned to IPFS. The shareable link is `mcard://notary-job?j=<job_hash>&h=<relay target_id>`. This closes the notary half of OQ-WALLET-6. Open-offer hosting stays open; the notary host does not host open offers.
**Signed by:** the notary card (`K_id`) of the instance that generated the epoch's key.
**At least one per epoch.** A new epoch publishes a new announcement, and wallets watching the job resubmit (§2.5). Within an epoch the announcement is re-issued about every 6 hours with fresh attestations: same `epoch`, later `issued_at` (§2.3.4 freshness model).

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.announcement.v1"` |
| `job` | NotaryJob | Yes | The complete job object |
| `epoch` | `integer` | Yes | Starts at 0. Strictly increasing. |
| `job_public_key` | `base64url` | Yes | X-Wing public key, 1,216 bytes. `SHA-256` of it must equal the attestation's `public_key` (finding 6). |
| `attestations` | array of `cid` | Yes | One purpose-`0x02` attestation per live replica instance for this epoch. The wallet needs to verify only one (§2.3). The full list shows the replica count. |
| `prev_announcement` | `cid` | If epoch > 0 | Links epochs |
| `epoch_reason` | `text` | If epoch > 0 | `"key_period"` or `"total_loss"`. Wallets tell users when ballots had to be resubmitted. |
| `issued_at` | `timestamp` | Yes | |
| `transport` | object | Yes | `{ "relay_target_id": text, "key_config_url": text }`. Untrusted: a wrong value can only cause denial of service, because inputs are sealed to `job_public_key`. |
| `notary_signature` | `SignatureEntry` | Yes | `K_id`. The address must equal one `replica_set[].notary_card`. |

```json
{
  "attestations": ["<CID att r1>", "<CID att r2>", "<CID att r3>"],
  "epoch": 0,
  "issued_at": "2026-11-14T12:00:00Z",
  "job": { "...": "NotaryJob above" },
  "job_public_key": "<1216 bytes>",
  "notary_signature": { "public_key": "<K_id pub>", "signature": "<sig>" },
  "transport": { "key_config_url": "https://notary.example/ohttp/key-config", "relay_target_id": "notary-example" },
  "type": "notary.announcement.v1"
}
```

### 2.1.4 NotaryInput (signed plaintext)

**Never stored in plaintext outside an enclave.** It is the HPKE plaintext of a `SealedInput`.
**Signed by:** the contributor's sub-card (`SignatureEntry`). The sub-card's `capabilities` must include the new message type `"notary_input"`. A wallet adds that capability to its own sub-card, so no app consent step is needed (`protocol-objects.md §16` wallet self-signing exception).
**Epoch-independent.** The signature covers `job_hash`, not the epoch. On resubmission the wallet re-encrypts the same signed input to the new epoch key without re-signing, so the contributor isn't prompted again.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.input.v1"` |
| `job_hash` | `base64url` | Yes | |
| `contributor_card` | `card-pointer` | Yes | The contributor's **master** card. `contributor_predicate` is evaluated on it. Dedupe keys on its **root key**, so a key rotation doesn't create a second identity (§2.4.7 B10). |
| `contributor_card_pubkey` | `base64url` | Yes | Binding hint, as `SubCardDocument.holder_primary_card_pubkey` |
| `payload` | object | Yes | Validated against `notary.input_schema` |
| `revision` | `integer` | Yes | ≥ 0. Under `latest_wins` the highest `revision` per master card counts; an equal `revision` with a different payload is rejected as `REVISION_CONFLICT`. Under `reject_duplicates` it must be 0. |
| `chain_ref` | object | Yes | `{ "block_number": int, "block_hash": base64url }`, a recent block the wallet saw. The enclave rejects processing against chain state older than the newest `chain_ref` it has accepted (strategic plan, chain state). |
| `signed_at` | `timestamp` | Yes | Informational. Ordering uses `revision`, not this field (finding 4). |
| `evidence` | array | Yes | `[{ "cid", "bytes" }]`: every IPFS object the broker needs to check the contributor, so it never fetches a card by address (§2.6.1) |
| `contributor_signature` | `SignatureEntry` | Yes | The sub-card key, over JCS of all other fields |

For `output_action: "card"`, `contributor_card` is the presented **source** card, and `payload` is `{ "derived_recipient_pubkey": base64url, "target_period": int }`. The source card's documents travel in `evidence`. A second message, `notary.countersign.v1` (`{ type, job_hash, offer_hash, holder_signature }`, sealed the same way), carries the holder's countersignature on the derived card (§2.6.4).

### 2.1.5 SealedInput (wire format) and the double envelope (Q12)

**Inner envelope** (to the enclave). HPKE (RFC 9180) base mode, KEM X-Wing draft-06, KDF HKDF-SHA256, AEAD ChaCha20-Poly1305. The suite IDs are bound as below, so a downgrade fails decryption.

```
info = "card-notary-input-v1" || 0x00 || job_hash (32 bytes) || epoch (8 bytes BE) || kem_label
       where kem_label = UTF-8 "x-wing-draft-06"
aad  = JCS({ "epoch": epoch, "job_hash": job_hash, "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1" })
pt   = JCS(NotaryInput)
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.sealed_input.v1"` |
| `job_hash` | `base64url` | Yes | |
| `epoch` | `integer` | Yes | |
| `kem` | `text` | Yes | Must equal `job.kem` |
| `enc` | `base64url` | Yes | X-Wing encapsulated key, 1,120 bytes |
| `ct` | `base64url` | Yes | AEAD ciphertext |

`input_hash = H(SealedInput)`. This is what both receipts and the input commitment use.

**Outer envelope** (to the host). The existing oblivious transport (`oblivious_transport.md`) with the host's X25519 gateway key and `{ "path": "/jobs/{job_hash}/inputs", "method": "POST", "body": SealedInput }`. The notary host becomes a third destination kind, registered with the relay by `target_id`. The relay sees the device's IP but not the job. The host sees the job and the ciphertext but not the IP or the content. The enclave sees the content but not the IP.

**Response path.** The host answers through the outer HPKE context with `{ host_receipt, validation_receipt_sealed }`. The validation receipt is sealed under a key exported from the **inner** HPKE context (`Export("card-notary-receipt-v1", 32)`, ChaCha20-Poly1305), so the host can't read whether an input was accepted.

**Cross-language interop (CP9 trigger).** Phase 5.1 must produce test vectors (fixed seeds → `enc`, `ct`, exported secret) from `@hpke/hybridkem-x-wing` 0.7.1 and the Rust `hpke` 0.15.1 `mlkem` feature, checked in both directions, before any other code depends on the suite. `rxwing` (draft-11) must not be used. If the vectors don't match, stop at CP9.

**Alternatives considered.** One envelope to the enclave, with the host as a dumb relay, would expose the device's IP to the host. Sealing directly to the host with the host forwarding plaintext to the enclave would let the host read inputs. Both rejected.

### 2.1.6 HostReceipt

**Signed by:** `K_host`. Its public key is `operator_host_pubkey` on the notary card.
**Purpose:** proves the host received the ciphertext. If the host later drops it, the contributor holds signed evidence, and the input's absence from `input_commitment` is attributable to that operator (G4).

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.host_receipt.v1"` |
| `job_hash`, `epoch`, `input_hash` | | Yes | |
| `notary_card` | `card-pointer` | Yes | Whose host this is |
| `received_at` | `timestamp` | Yes | |
| `host_signature` | `SignatureEntry` | Yes | |

### 2.1.7 ValidationReceipt

**Signed by:** `K_id`, after the broker decrypts and checks the input. **Delivered** sealed to the contributor (§2.1.5), so only the contributor can read it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.validation_receipt.v1"` |
| `job_hash`, `epoch`, `input_hash` | | Yes | |
| `status` | `text` | Yes | `"accepted"`, `"rejected"`, or `"superseded"` (a higher revision already exists) |
| `reject_reason` | `text` | If rejected | One of the reason codes in §2.3, §2.4 and §2.6 |
| `derived_offer` | object | Derived-card jobs, if accepted | The offer-phase derived `CardDocument` for the holder to countersign (§2.6.4 step 4) |
| `revision` | `integer` | Yes | Echoed from the input |
| `instance` | `base64url` | Yes | `SHA-256(K_inst pub)`. Says which replica validated. |
| `acks` | `integer` | Yes | Replicas that accepted the input before this receipt was issued. Always ≥ q (§2.5.4). |
| `processed_at` | `timestamp` | Yes | Chain time of the newest block the enclave has accepted |
| `notary_signature` | `SignatureEntry` | Yes | |

A validation receipt never contains the contributor's card address. If a contributor shares it, the receipt shows only that *some* input with that hash was accepted.

### 2.1.8 Input commitment

A Merkle tree over the `input_hash`es of **counted** inputs: after dedupe and replacement, in the final epoch. Leaves are sorted by byte value for determinism. Leaf `= SHA-256(0x00 ‖ input_hash)`, node `= SHA-256(0x01 ‖ left ‖ right)`, and an odd node is promoted unchanged (RFC 6962 style, domain-separated so a leaf can't pass as a node). The full sorted leaf list is pinned to IPFS as `counted_inputs` and referenced from the notarization. A contributor checks inclusion of the `input_hash` on their latest accepted receipt. A superseded input is not in the tree, and its receipt says so.

Alternative considered: committing to all received ciphertexts. Rejected because it would publish how many times each card revised, and that number is a weak signal about who changed their vote.

### 2.1.9 Notarization

**Stored on:** IPFS, public, as raw JCS. Output values are encrypted unless `output_recipients.public`.
**Signed by:** `K_id` of the closing instance.

One open point for §2.4: the enclave learns recipients' sub-card keys from card documents the host fetches. Card content is signature-checked, but the host could supply an older head with a stale sub-card list. The worst case is that a revoked device of a recipient can read the output. §2.4 decides whether to require a fresh `chain_ref` for recipient cards.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.notarization.v1"` |
| `job_hash` | `base64url` | Yes | |
| `job_cid` | `cid` | Yes | |
| `policy_id`, `policy_state_cid` | `cid` | Yes | Copied from the job |
| `notary_card` | `card-pointer` | Yes | |
| `program_cid` | `cid` | Yes | |
| `platform` | `text` | Yes | |
| `final_epoch` | `integer` | Yes | |
| `attestation` | `cid` | Yes | The closing instance's purpose-`0x02` attestation for `final_epoch` |
| `chain_state` | object | Yes | `{ "block_number", "block_hash", "block_timestamp", "state_root" }`. Host-supplied; recorded so verifiers can judge staleness (known limit). |
| `input_commitment` | `base64url` | Yes | Merkle root (§2.1.8) |
| `counted_inputs` | `cid` | Yes | Sorted leaf list |
| `accepted`, `rejected` | `integer` | Yes | `accepted` counts distinct root keys (§2.4.7 B10). `rejected` counts inputs rejected across all epochs, including inputs re-checked and excluded at close. |
| `dropped_after_acceptance` | `integer` | Yes | Accepted inputs whose ciphertext the host didn't supply at close (§2.4.8). Attributable to the operator through contributors' receipts. |
| `suppressed` | `boolean` | Yes | True if `accepted < k_min`. The output is then the fixed "insufficient participation" value. |
| `output` | object | Yes | `{ "public": <value> }` when `output_recipients.public`; otherwise `{ "recipients": card-pointer-array }`. A private output is not put in the notarization at all. The enclave encrypts it to each recipient's sub-card keys with the existing message encryption (ADR-007, `message_routing.md` §Sender-Side Fan-out) as a `notary_output` message signed by `K_id`, and the host only relays the ciphertext. Recipients need no new key, and there is no second ciphertext format. |
| `output_hash` | `base64url` | Yes | `H(output value)`. Lets a recipient show a third party that a plaintext they disclose is the notarized one. |
| `job_log_head` | `cid` | Yes | The last job log record before this one (§2.1.10) |
| `close_quorum` | `integer` | Yes | q for this job (§2.5.1) |
| `cosignatures` | array | Yes | ≥ q entries from distinct instances: `{ "attestation": cid, "instance_signature": SignatureEntry }`. Each signature is by a replica's `K_inst` over `H(body)`, where body is the notarization without `cosignatures` and `notary_signature` (§2.5.5). |
| `closed_at` | `timestamp` | Yes | `block_timestamp` of `chain_state` |
| `notary_signature` | `SignatureEntry` | Yes | |

A notarization is verified with only CIDs and chain data. The steps are numbered in §2.3: signature; `K_id` binding to an approved notary card; attestation PCR0 accepted *as of* `closes_at`; `program_hash`; `job_hash`; the commitment recomputed from `counted_inputs`.

### 2.1.10 Public record and job log (Q5, Q6; decision D3, *deviation*)

**The problem.** The strategic plan puts notarizations on the notary card's log. Phase 1 found that every `LogEntry` reposts `card_state` and the whole `history` array. Even with `card_state` left untouched, `history` grows by one CID per entry, so total bytes over the card's life are O(n²). Writing to that log also needs an authorized press under the notary card's policy. And "every handoff appears in the job log" has no home, because jobs aren't cards.

| Option | Public record | Job log | On-chain needs | Trade-off |
|---|---|---|---|---|
| (a) Notary card log, new 4xx code | Code 410 entry carrying the notarization CID in a new optional `LogEntry.annotation_cid` | Also 4xx entries, or none | A press for `NotaryCardPolicy` writes every entry | Matches the plan's words. History growth is O(n²) per notary card, and handoffs would flood it. Adding an optional `LogEntry` field is not CP6, but it is a shared-object change. |
| **(b) Job log on IPFS, anchored with EAS** *(recommended)* | The `notarized` record of the job log, anchored by an EAS attestation | Hash-chained `JobLogRecord`s on IPFS, each signed by the acting instance's `K_id` and `K_inst`, with key records anchored by EAS | EAS (ADR-008) is already on Arbitrum One. Anyone can attest, the host's gas wallet pays, and no `PressAuthorizations` entry is needed. | No card or contract change. Linear growth, one log per job. Keeps aggregation and voting free of on-chain authorization (finding 1). The EAS schema has to be registered once, and the integration stack has to deploy EAS. |
| (c) One card per job | The job card's log | Same | `RegisterPolicy` for a job-card policy plus a press | Clean, but a registration per job and a new card type, for no gain over (b) |

**Recommendation (b).** The strategic plan's wording changes from "log entries on the notary sub-card's log; EAS anchoring optional" to "an enclave-signed job log on IPFS, anchored with EAS". The public content is unchanged: only that the notary acted.

**JobLogRecord.**

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.job_log.v1"` |
| `job_hash` | `base64url` | Yes | |
| `seq` | `integer` | Yes | 0, 1, 2, … with no gaps |
| `prev` | `cid` | If `seq` > 0 | |
| `kind` | `text` | Yes | `"opened"`, `"epoch_started"`, `"handoff"`, `"replica_lost"`, `"replicated"`, `"closed"`, `"notarized"`, `"issued"` (derived-card batches: count only), `"aborted"` |
| `body` | object | Yes | Per kind. `handoff` is a `HandoffRecord` (§2.1.11). `notarized` is `{ "notarization": cid, "accepted", "rejected", "input_commitment" }`. |
| `at` | `timestamp` | Yes | Chain time |
| `instance` | `base64url` | Yes | `SHA-256(K_inst pub)` |
| `notary_signature` | `SignatureEntry` | Yes | `K_id` |
| `instance_signature` | `SignatureEntry` | Yes | `K_inst`. Its key is bound by the instance's attestation, whose CID appears in the `opened` or `replicated` record for that instance. |

**Anchoring.** The host submits an EAS attestation `{ job_hash, seq, record_cid }` for every record whose kind is `opened`, `epoch_started`, `handoff`, `replica_lost`, `notarized` or `aborted`. The enclave refuses to sign record `seq + 1` until the host shows it the anchor for record `seq`. That forces the host to anchor or stall the job; it can't skip a record without stopping. A gap is visible to anyone who reads the EAS index by `job_hash`. The enclave can't verify the anchor exists without state proofs. It checks the transaction receipt the host supplies, which is the same trust level as all v1 chain data.

**The identity log.** Handoffs of `K_id`/`K_chain` between an operator's enclaves aren't tied to one job. They go in a per-notary-card log with the same record shape, `type` `"notary.identity_log.v1"`, keyed by the notary card address instead of `job_hash`.

### 2.1.11 HandoffRecord

The body of a `handoff` record. The record is signed by both ends: the job log record carries the sender's signatures, and `receiver_signature` below is the receiver's.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.handoff.v1"` |
| `scope` | `text` | Yes | `"job"` (`K_job` for one epoch, plus job state), `"identity"` (the `K_id`/`K_chain` keyring and sealed-link state key), or `"template"` (the dup-tag key, §2.6.0) |
| `job_hash`, `epoch` | | If `job` | |
| `from_instance`, `to_instance` | `base64url` | Yes | `SHA-256(K_inst pub)` of each |
| `from_attestation`, `to_attestation` | `cid` | Yes | Each side's purpose-`0x03` attestation |
| `to_notary_card` | `card-pointer` | Yes | Must be in `replica_set` (job) or equal the notary card (identity) |
| `pcr0_from`, `pcr0_to` | `base64url` | Yes | Different values are allowed only if both are on the accepted list (runtime upgrade, §2.5) |
| `state_version` | `integer` | Yes | Version of the job state or sealed-link state handed over, so a receiver can't be given old state (finding 3) |
| `state_hash` | `base64url` | Yes | |
| `at` | `timestamp` | Yes | |
| `receiver_signature` | `SignatureEntry` | Yes | `K_inst` of the receiver, over the record without this field |

### 2.1.12 Heartbeat

**Off-chain, never published.** Sent enclave to enclave through the hosts.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.heartbeat.v1"` |
| `instance` | `base64url` | Yes | |
| `jobs` | array | Yes | `[{ "job_hash", "epoch", "state_version" }]` for every job this instance holds a key for |
| `identity_state_version` | `integer` | If identity-holding | |
| `list_versions` | object | Yes | `{ "accepted_runtimes": int, "program_allowlist": int }`, the highest list versions this instance has verified. Peers never accept lower ones (§2.3.9). |
| `peers_seen` | array of `base64url` | Yes | Instances heard from within the liveness window |
| `chain_head` | object | Yes | `{ "block_number", "block_hash" }`, the newest block accepted |
| `seq` | `integer` | Yes | Per-instance counter, so the host can't replay old heartbeats |
| `instance_signature` | `SignatureEntry` | Yes | `K_inst` |

The liveness window, re-replication trigger and leader choice are in §2.5.

### 2.1.13 Sealed-link state blob (Q11; decision D4, *deviation*)

**Format.** A `StateBlobHeader` (public) plus an AEAD-encrypted body (private), stored by the host on IPFS or local disk. The body is the sealed-link table, `{ derived_card_address → source_card_address, issued_at, expires_at }`, plus the nullifier table (§2.6), encrypted with ChaCha20-Poly1305 under a **state key** that lives only in the identity keyring.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.state_blob.v1"` |
| `notary_card` | `card-pointer` | Yes | |
| `version` | `integer` | Yes | Strictly increasing |
| `prev_hash` | `base64url` | If `version` > 0 | Hash of the previous header |
| `body_hash` | `base64url` | Yes | `SHA-256(ciphertext)` |
| `body_cid` | `cid` | Yes | |
| `at` | `timestamp` | Yes | |
| `notary_signature` | `SignatureEntry` | Yes | `K_id` |

**Anchoring options.**

| Option | Rollback protection | Cost and dependencies |
|---|---|---|
| (i) Head of a dedicated notary-state card (`UpdateCardHead`) | None in v1. The enclave can't authenticate chain reads, and the write-gate gap lets the host write an old CID (findings 2 and 3). | One write per version. Needs D5 fixed and state proofs before it means anything. |
| (ii) New contract field | Same as (i) | CP7 |
| **(iii) No chain anchor. Version and hash carried in the handoff and in heartbeats.** *(recommended)* | A replica loads a blob only after a handoff from a live replica, which names `state_version` and `state_hash`. Live replicas compare versions in heartbeats and refuse to go backwards. | None |
| (iii) + optional EAS audit anchor | Same as (iii), plus a public timestamped trail that state changed, without revealing what changed | One EAS attestation per version, rate-limited by the batching window |

**Why (iii) is enough.** The blob key is never written outside enclaves. If every replica dies, no enclave can read any blob, old or new. So the only way to load a blob is to receive the key from a live replica, and the live replica tells the receiver which version is current. A host that hands a joining replica an old blob is caught when the hashes differ. The strategic plan's phrase "anchored on-chain" becomes "versioned and carried in the attested handoff; optionally anchored with EAS for audit".

### 2.1.14 PropagationBatch

An instruction from the enclave to its own host. It is not published: the public effect is a `BatchUpdateCardHeads` transaction and the `LogEntry`s it points to.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `text` | Yes | `"notary.propagation_batch.v1"` |
| `notary_card` | `card-pointer` | Yes | |
| `policy_id` | `cid` | Yes | |
| `batch_seq` | `integer` | Yes | |
| `release_not_before` | `timestamp` | Yes | Chain time. The enclave signs the on-chain payload only after this time. |
| `entries` | array | Yes | `[{ "card_address", "log_entry_cid", "prev_log_cid" }]`, mixing propagated revocations with padding as defined in §2.6 |
| `chain_payload` | object | Yes | The `BatchUpdateCardHeadsPayload` the enclave signed with `K_chain` |
| `chain_signature` | `base64url` | Yes | secp256r1 r‖s |

Each revocation `LogEntry` is an ordinary 8xx or 9xx entry on the derived card. `intent_signature` and `press_signature` are both by `K_id`: the notary is both updater (the issuer, permitted by `revocation_permissions`) and press. `revocation.note` is omitted, so nothing about the source card is published.

### 2.1.15 Governance list cards

These are defined in §2.2.2 because their form depends on D2.

### 2.1.16 Serialization summary (for `protocol-objects.md` in Phase 3)

| Object | Storage | Signer | Signed bytes |
|---|---|---|---|
| `notary` section, `approved_notaries` | IPFS (policy card) | as `PolicyCardDocument` | as `PolicyCardDocument` |
| Notary card | IPFS (card) | issuer = policy holder; holder = `K_id`; press = `NotaryCardPolicy` press | as `CardDocument` |
| NotaryJob | IPFS | requester card | JCS without `requester_signature` |
| JobAnnouncement | host + IPFS | `K_id` | JCS without `notary_signature` |
| NotaryInput | inside HPKE only | contributor sub-card | JCS without `contributor_signature` |
| Countersign message (`notary.countersign.v1`) | inside HPKE only | derived key `D` (as `holder_signature` of the offer) | as `CardDocument` `holder_signature` |
| SealedInput | in transit; host storage | none (AEAD) | n/a |
| HostReceipt | to contributor | `K_host` | JCS without `host_signature` |
| ValidationReceipt | to contributor, sealed | `K_id` | JCS without `notary_signature` |
| Notarization | IPFS | `K_id`, plus ≥ q cosigners' `K_inst` | `notary_signature`: JCS without itself. Cosignatures: `H(body)`, where body excludes `cosignatures` and `notary_signature` (§2.5.5). |
| JobLogRecord / identity log | IPFS + EAS | `K_id` and `K_inst` | JCS without both signatures |
| HandoffRecord | inside a job log record | receiver `K_inst` (sender signs the enclosing record) | JCS without `receiver_signature` |
| Heartbeat | enclave to enclave | `K_inst` | JCS without `instance_signature` |
| StateBlobHeader | IPFS / host | `K_id` | JCS without `notary_signature` |
| PropagationBatch | enclave to host | `K_chain` over the chain payload only | as `BatchUpdateCardHeadsPayload` |
| Derived card | IPFS (card) | issuer = press = `K_id`; holder = derived key | as `CardDocument` |

---

## §2.2 On-chain authorization and governance ownership — David decides

### 2.2.1 On-chain authorization (D1, D5)

**What needs on-chain authority, given §1 and D3.** Only derived-card policies. Aggregation and vote notaries register nothing under their policy. Their notary card is registered once under `NotaryCardPolicy` by that policy's press, and their records go to IPFS and EAS. So the on-chain question is narrower than Phase 1 assumed: how `K_chain` gets authority to `RegisterCard` and `UpdateCardHead` under a derived-card policy `P`.

`P` needs `RegisterPolicy` (RootPolicyBody) in every option, because `RegisterCard` requires it (finding 1). Only option 4 below avoids that, and it doesn't work.

| Option | Contract change | Governance per derived-card policy | Blast radius of a compromised `K_chain` | Notes |
|---|---|---|---|---|
| **1. Reuse `PressAuthorizations`** *(recommended for v1)* | None | `RegisterPolicy` + `AuthorizePress(P, notary_card, chain_pubkey, keccak256(K_id))`: two quorum acts and up to 14 days of deliberation | Any write under `P`. On-chain the notary is just a press for `P`. | Verifier Stage 5 works unchanged. Minting credentials getting a governance review is defensible, unlike aggregation. `press-rules.md` needs a notary section. |
| 2. Role flag on `PressAuthEntry` | Storage layout + logic (CP7, touches the immutable storage contract) | Same two acts | Limited to derived-card ops | The expensive change: the storage contract layout. Buys little, since `P` only contains derived cards anyway. |
| 3. New `NotaryAuthorizations` table, authorized by `P`'s authorizer key | Storage + logic (CP7) | `RegisterPolicy` only; the policy authorizer adds notaries | Same as 1 | Lighter for G3, but removes PressRegistryBody's ethics review of who may mint cards. |
| 4. Route through an ordinary press | None | `RegisterPolicy` + an ordinary press | — | Doesn't work for derived cards. The press would have to sign `press_signature`, so the press, not the enclave, would vouch. Rejected. |

**The per-policy cost.** Options 1–3 all assume each community writes its own derived-card policy. Each such policy then needs `RegisterPolicy` (RootPolicyBody), and under option 1 an `AuthorizePress` per (policy, notary) pair as well. Ten communities and two operators would be 10 RootPolicyBody votes and 20 PressRegistryBody votes. That fails G3.

**Decision (David, 2026-11-11, provisional): shared derived-card template policies.** This is option 1 applied to a small, fixed set of policies:
- Governance registers one **derived-card template policy** `T` per audited `derive` program (`RegisterPolicy`, once). `T` is held by the body that owns the program allowlist (D2).
- Each notary operator that serves `T` gets one notary card for `T`, issued by `T`'s holder, and one `AuthorizePress(T, notary_card, chain_pubkey, keccak256(K_id))`. That is one PressRegistryBody act per (template, operator) pair, not per community.
- Communities never create a derived-card policy. A community (or anyone satisfying `T.notary.job_requester_predicate`) opens a standing `per_input` job under `T`. The job's `parameters` name the source policy and the fields to project, within `T.notary.parameter_bounds`.
- The specifics of each derived card live in its fields (§2.1.1, "Derived-card template policies").

Consequences, and why this may need revisiting:
- Verifiers trust "template `T` plus the notary that signed it" rather than a community-written policy. A community can't attach its own `field_definitions`, `auditors` or `recipient_predicate` to its derived cards.
- Every derived card from one template shares one `policy_id`, across all communities. That makes `policy_id` reveal less about which community a holder came from.
- If communities later need their own derived-card policies, the way forward is option 3 or delegated policy registration (a registered parent policy's authorizer registers children without a RootPolicyBody vote). The second changes ADR-011's governance model and would be its own decision.

**On-chain mechanics** (unchanged from option 1): one `K_chain` per notary card and a single writer per notary card. The replica holding the notary card's leadership (§2.5) signs all chain payloads, so replicas never collide on `next_sequence`. Per-replica on-chain addresses would need an `AuthorizePress` each, a governance act per replica. Revisit option 3 if derived-card adoption is held back by governance latency.

**D5: the write-gate fix.** Under the current gate a host can reuse any payload `K_chain` signs to write an arbitrary CID to an arbitrary card under `P`, once per signature (finding 2). It can't forge valid card content, but it can make valid derived cards fail verification. Options:
- **(a) Fix the gate before derived cards launch** *(recommended)*. Every signed field (`card_address`, CIDs, `policy_address`, batch `updates`) must equal the calldata. This is the pending item in `phase-3-consolidated-fixes.md` Tier 3 (a), done as its own CP7 change. It is a logic-contract upgrade only (7-day timelock); storage is unaffected.
- (b) Launch derived cards with the gap, and state in the spec that a host can deface derived-card heads once per signature.
- (c) Keep `K_chain` on the host. Rejected: the host could then write without limit.

### 2.2.2 Accepted-runtime list and program allowlist (D2)

**Owner options.**

| Owner | Fit | Concerns |
|---|---|---|
| **AppCertificationBody, third mandate ("notary runtimes")** *(recommended)* | It already certifies software (wallets, apps, login services) through branch cards, needs no on-chain power, and the login-service mandate (2026-11-08) is the exact precedent. Runtimes and WASM programs are software. | A new mandate and a new branch. Members need enclave and WASM audit capacity, or must commission audits. |
| PressRegistryBody | Notary operators resemble presses | Its mandate is operator conduct. A 14-day deliberation for each runtime release is too slow, and a 7-day emergency path is still slow for a security fix. |
| RootPolicyBody | Protocol-wide authority | Overloaded, and the two-body split is deliberate |

**Decision (David, 2026-11-11): PressRegistryBody owns both lists, `NotaryCardPolicy` and the derived-card template policies.** Notary runtimes, programs and operators then sit under one body, which also holds the `AuthorizePress` votes for template policies (D1) and adds notary operators to `press-rules.md`. In the list-card fields below, read "PressRegistryBody notary branch" wherever the recommendation said AppCertificationBody.

**Open point for the Phase 3 governance text.** PressRegistryBody's deliberation is 14 days, with a 7-day emergency path. A PCR0 or program found to be exploitable must be retirable faster than that. Proposal: a `retired_at` with `retire_reason: "vulnerable"` may be posted by a smaller emergency quorum and ratified, or reversed, by the full body afterwards. This is a governance-process change, so it goes to David with the Phase 3 governance text.

**Form options.**

| Form | History ("was this PCR0 accepted at `closes_at`?") | Distribution | Change cost |
|---|---|---|---|
| **Governance-held list cards** *(recommended)* | Each entry carries `accepted_from` and `retired_at` (chain time). A strict verifier can also replay the card's `history`. | Wallets, verifiers and hosts pin the two card addresses in config and read the current head like any card | No contract change. A 3xx entry per change; `card_state` reposts the whole list, which stays small. |
| On-chain table with a `SetProtocolVersion`-style op | Events | Contract reads | CP7 |
| Baked into the runtime image | n/a | Every change is a new PCR0 | Circular for the PCR0 list itself |

**List card fields** (both are cards under a PressRegistryBody "notary runtime list" policy, holder = the notary branch node, updates `{ "is_holder": true }`, code 300):

`accepted_runtimes`: array of
`{ "platform": text, "pcr0": base64url, "version": text, "source_commit": text, "build_recipe_cid": cid, "accepted_from": timestamp, "retired_at": timestamp (optional), "retire_reason": "superseded" | "vulnerable" (optional) }`

`program_allowlist`: array of
`{ "program_cid": cid, "name": text, "version": text, "source_commit": text, "toolchain": text, "audit_report_cid": cid, "accepted_from": timestamp, "retired_at": timestamp (optional), "retire_reason": … }`

Acceptance rule: an entry is accepted at time `t` iff `accepted_from ≤ t` and (`retired_at` is absent or `t < retired_at`). Retiring sets `retired_at`; entries are never deleted. A `"vulnerable"` retirement is meant to be read retroactively by cautious verifiers. A `"superseded"` one is not.

**How the runtime gets the allowlist (threat to settle in §2.3).** The runtime enforces `shared` isolation, so it needs the allowlist, and the only source it has is the host. A host could feed an older, validly signed list version that still includes a since-retired program. The proposed defense, detailed in §2.3: the runtime verifies the list card's signatures up to a governance key compiled into the image (so it's covered by PCR0), and it refuses list versions older than one compiled into the image and older than the newest it has seen. Wallets independently refuse `shared` jobs for a program that isn't on the current list.

---

## §2.3 Attestation and admission

Answers Q12 (checks) and Q13 (freshness). This section has six algorithms:

- **V** verifies one enclave attestation. All the others call it.
- **W** is the wallet's check of a job announcement, run before it encrypts any input.
- **G** checks a notary's genesis attestation (identity creation).
- **N** verifies a notarization.
- **P** checks a peer enclave before a handoff (used in §2.5).
- **A** is the runtime's program admission check.

Every check names the reject code it returns. Codes are grouped by prefix (`ATT_`, `ANN_`, `JOB_`, `NOT_`, `ADM_`) and join the `wallet_sdk.md §11` and `card_verifier.md §9` code lists in Phase 3.

### 2.3.1 The AWS Nitro Enclaves attestation document (facts relied on)

These are AWS's documented format, re-confirmed against real hardware in step 5.2 and Phase 8.

- The document is a COSE_Sign1 structure, algorithm ES384 (P-384 with SHA-384). Its payload is a CBOR map with `module_id`, `digest` (`"SHA384"`), `timestamp` (milliseconds since the Unix epoch, set by the NSM), `pcrs` (index → 48-byte value), `certificate` (the DER leaf), `cabundle` (DER certificates, root first), and the optional `public_key` (≤ 1,024 bytes), `user_data` (≤ 512) and `nonce` (≤ 512).
- The chain runs from the AWS Nitro Enclaves root certificate (P-384) through regional, zonal and instance certificates to a short-lived leaf.
- An enclave started in **debug mode** reports PCR0, PCR1 and PCR2 as all zeros. A PCR0 that matches a non-zero accepted value therefore also proves debug mode is off. The verifier still checks for zeros explicitly, so the reason it reports is right.
- PCR0 is the SHA-384 measurement of the whole enclave image file. PCR1 covers the kernel and boot ramdisk, and PCR2 the application. The accepted list pins PCR0 only, since it covers both.

### 2.3.2 Platform abstraction

```
interface AttestationVerifier {
  platform: "aws-nitro-enclaves" | "simulator"
  // Platform-specific: format, certificate chain, signature, debug detection.
  verifyEnvelope(doc: bytes, trustRoot: Certificate) -> ParsedAttestation | Reject
}

ParsedAttestation {
  platform, measurement /* PCR0 */, debug: bool, timestamp, user_data, nonce, public_key
}
```

Only `verifyEnvelope` (steps V1–V5 below) knows the AWS format. Steps V6–V12 are shared code that works on `ParsedAttestation`. The **simulator** backend emits the same COSE/CBOR format signed by a test root, so the same parser runs in CI and on real hardware, and only the root differs.

**Simulator gate.** Every verifier config has `allowSimulator` (default `false`). A document whose root is the simulator root, or a notary card whose `platform` is `"simulator"`, is rejected with `ATT_PLATFORM_NOT_ALLOWED` unless it is set. Production wallet builds hard-code it to `false`. Test builds set it and pin the test root.

This is the only module that names an AWS format (G5).

### 2.3.3 Algorithm V — verify one attestation

**Inputs:** `doc`, `expected` (purpose, plus whichever fields that purpose binds), `t_eval` (the chain time at which the measurement must have been accepted), `max_age` (optional), `now` (chain time), and the accepted-runtime list card read from chain.

| # | Check | Reject code |
|---|---|---|
| V1 | Decode COSE_Sign1. The protected header's algorithm is ES384. | `ATT_MALFORMED` |
| V2 | The payload has every required field with the right CBOR type, and `digest == "SHA384"`. | `ATT_MALFORMED` |
| V3 | `cabundle[0]` equals the pinned root for this platform, byte for byte. | `ATT_ROOT_MISMATCH` |
| V4 | The chain `cabundle[0] → … → certificate` verifies: signatures, CA basic constraints, key usage and path lengths, with every certificate valid **at `doc.timestamp`**. | `ATT_CHAIN_INVALID` |
| V5 | The COSE signature verifies with the leaf's public key. | `ATT_SIGNATURE_INVALID` |
| V6 | PCR0, PCR1 and PCR2 are not all zeros. | `ATT_DEBUG_MODE` |
| V7 | There is an `accepted_runtimes` entry with this `platform` and `pcr0 == measurement` that is accepted at `t_eval` (§2.2.2 rule). If the only match was retired with `"vulnerable"`, the verifier still returns success but sets `runtime_retired_vulnerable` (a warning callers must surface). | `ATT_RUNTIME_NOT_ACCEPTED` |
| V8 | `user_data` is exactly 181 bytes, starts with `"CARDNOTARY"`, and has `layout_version == 0x01` (§1.4). | `ATT_USER_DATA_MALFORMED` |
| V9 | `purpose == expected.purpose`. | `ATT_PURPOSE_MISMATCH` |
| V10 | Every field the purpose binds equals `expected`. Every field the purpose doesn't use is all zeros. | `ATT_BINDING_MISMATCH` |
| V11 | `nonce` and `public_key` are as §1.4 specifies for this purpose (present and equal to `expected`, or absent). | `ATT_NONCE_MISMATCH`, `ATT_KEY_MISMATCH` |
| V12 | If `max_age` is set: `now − max_age ≤ doc.timestamp ≤ now + 5 min`. The 5-minute allowance is for clock skew between the NSM and chain time. | `ATT_STALE` |

**Output:** the parsed attestation plus the warning flag.

Certificates are checked at the document's own timestamp, not at verification time (V4). The leaf certificates are short-lived, so old notarizations could never be verified otherwise. This is safe because the leaf private key never leaves AWS's hardware: no one can issue a document with a back-dated timestamp. V12 separately bounds how old a document may be when a decision depends on the enclave being live *now*.

### 2.3.4 Algorithm W — wallet check of a job announcement, before encrypting

**Inputs:** an announcement, the wallet's config (platform roots, `allowSimulator`, the list card addresses, the `NotaryCardPolicy` CID, accepted KEMs, `max_attestation_age` with default 24 h), and the wallet's own chain reads. The wallet never takes chain data from the notary host.

| # | Check | Reject code |
|---|---|---|
| W1 | `type == "notary.announcement.v1"`. Every required field is present. | `ANN_MALFORMED` |
| W2 | `job.type == "notary.job.v1"`. `keccak256(job.requester_pubkey) == job.requester_card`. `requester_signature` verifies. Compute `job_hash = H(job)`. | `JOB_SIGNATURE_INVALID` |
| W3 | Resolve the policy at `job.policy_id`. Walk its chain to a trusted root (`card_validation.md`). | `JOB_POLICY_UNTRUSTED` |
| W4 | `job.policy_state_cid` is the policy's current head, or is in its `history`. The `notary` section and `approved_notaries` at the current head equal those at `policy_state_cid`. | `JOB_POLICY_CHANGED` |
| W5 | The requester card's chain satisfies `notary.job_requester_predicate`. An absent predicate always passes (D9, template policies). | `JOB_REQUESTER_NOT_PERMITTED` |
| W6 | `job.parameters` validate against `notary.parameter_bounds`. | `JOB_PARAMETERS_OUT_OF_BOUNDS` |
| W7 | The mode-specific fields are present and consistent (`closes_at > opens_at`; `ends_at ≤ opens_at + 1 year`). q ≤ `min_live` ≤ N (§2.5.1). | `JOB_MALFORMED` |
| W8 | Chain now `< closes_at` (aggregate) or `< ends_at` (per_input). | `JOB_CLOSED` |
| W9 | `job.kem` is in the wallet's accepted KEMs (v1: only `"x-wing-draft-06"`). | `JOB_KEM_UNSUPPORTED` |
| W10 | For each `replica_set` entry: the notary card is in `approved_notaries` at the current head and not revoked; its `policy_id` is the configured `NotaryCardPolicy`; its `issuer_card` is the job's policy; its `platform` equals `notary.platform`. | `JOB_NOTARY_NOT_APPROVED` |
| W11 | `keccak256(notary_signature.public_key)` is one of the `replica_set` notary cards, and the signature verifies. | `ANN_SIGNATURE_INVALID` |
| W12 | If `epoch > 0`: `prev_announcement` resolves to an announcement for the same `job_hash` with `epoch − 1` (walking back to the oldest epoch the wallet has seen). The epoch is never lower than the highest the wallet has stored for this job. | `ANN_EPOCH_REGRESSION` |
| W13 | At least one CID in `attestations` passes **V** with: purpose `0x02`; `id_key_hash` equal to some `replica_set` notary card; `program_hash` the digest of `notary.program_cid`; `job_hash`; `epoch`; `isolation` matching `notary.isolation`; `public_key == SHA-256(job_public_key)`; `nonce == job_hash`; `t_eval = now`; `max_age = max_attestation_age`. If any of these fails, the matching `ATT_*` code is returned. | `ATT_*` |
| W14 | If `notary.isolation == "shared"`: `notary.program_cid` is on the current `program_allowlist`, accepted at `now`. | `JOB_PROGRAM_NOT_ALLOWLISTED` |
| W15 | If W13 raised `runtime_retired_vulnerable`: reject. A wallet never encrypts to a runtime that has been retired for a vulnerability. | `ATT_RUNTIME_NOT_ACCEPTED` |

Only after W1–W15 pass does the wallet build the consent screen. It is built from the policy at the current head and from the job's `parameters`, with `requester_text` shown only as labelled requester text (G2).

**Freshness model (Q13).** Every live replica re-attests about every 6 hours. It reuses the same keys, so the epoch doesn't change, but gets a new timestamp. The host then re-issues the epoch's announcement with the new attestation CIDs. The re-issued announcement has the same `epoch` and a later `issued_at`, and is signed again by `K_id`. A wallet uses the newest announcement it can find for the highest epoch. The 24-hour `max_attestation_age` means a wallet encrypts only to a key that an accepted runtime showed it held within the last day. That limits sealing to an enclave that has died since. It does not rule it out, so the wallet keeps every input it submits. If it gets no validation receipt within 10 minutes, it fetches the announcement again and resubmits; §2.5 covers what happens when the epoch has changed.

**What W does not catch.** A host can hide a newer epoch's announcement. The wallet then seals to a dead key, sees no receipt, and retries. That is denial of service, which falls under the known limit "the operator controls I/O". A host can also send the wallet to a different, equally valid replica. That is harmless, because every replica holds the same `K_job`.

### 2.3.5 Algorithm G — genesis attestation

The policy holder runs G before signing a notary card offer (§1.3 step 3). A derived-card verifier runs it on the notary card's `genesis_attestation` (§2.3.6).

**The genesis request** is the object the operator sends the policy holder at §1.3 step 2:
```
{ "type": "notary.genesis_request.v1", "policy_id": cid, "operator_card": card-pointer,
  "operator_host_pubkey": base64url, "platform": text, "id_pubkey": base64url,
  "chain_pubkey": base64url, "requested_at": timestamp, "nonce": base64url }
```

| # | Check | Reject code |
|---|---|---|
| G1 | **V** passes with: purpose `0x01`; `id_key_hash = keccak256(id_pubkey)`; `chain_key_hash = SHA-256(chain_pubkey)`; `nonce = H(genesis request)` (the request's own random `nonce` makes it unique). `t_eval` is `now` for the policy holder, or the notary card's `issued_at` for a later verifier. `max_age` is 7 days for the policy holder and none for a later verifier. | `ATT_*` |
| G2 | The offer's `recipient_pubkey == id_pubkey`, `chain_pubkey` field `== chain_pubkey`, and `genesis_attestation` is this document's CID. | `NOT_GENESIS_MISMATCH` |
| G3 | `operator_card` resolves and is not revoked. | `NOT_OPERATOR_INVALID` |

Binding the genesis request into the attestation's `nonce` means the attestation can't be reused to bind someone else's operator card or host key to these enclave keys.

### 2.3.6 Algorithm N — verify a notarization (historical)

**Inputs:** a notarization CID and chain reads. Nothing comes from the notary host, so anyone can run N (G1 objective). **Output:** `valid` or a reject code, with warnings for `runtime_retired_vulnerable`, the age of the chain state, `JOB_LOG_GAP`, and any `total_loss` epochs.

| # | Check | Reject code |
|---|---|---|
| N1 | `type == "notary.notarization.v1"`. Fetch `job_cid` and confirm `H(job) == job_hash`. Verify the job's `requester_signature` (W2). | `NOT_MALFORMED` |
| N2 | `keccak256(notary_signature.public_key) == notary_card`, and the signature verifies. | `NOT_SIGNATURE_INVALID` |
| N3 | `notary_card` is in the job's `replica_set`, and is in `approved_notaries` **at `policy_state_cid`** (historical, not current). Its chain is valid as in W10. | `NOT_NOTARY_NOT_APPROVED` |
| N4 | The notary card has no 8xx or 9xx revocation with `effective_date ≤ closed_at`. | `NOT_NOTARY_REVOKED` |
| N5 | `program_cid` and `platform` equal the policy's values at `policy_state_cid`. | `NOT_POLICY_MISMATCH` |
| N6 | `attestation` passes **V** with: purpose `0x02`; `job_hash`; `final_epoch`; `program_hash`; `id_key_hash == notary_card`; `t_eval = job.closes_at` for aggregate jobs, or `closed_at` for a per_input job's final output; no `max_age`. | `ATT_*` |
| N7 | The block named in `chain_state` exists on the verifier's own view of the chain with that hash and timestamp. `closed_at == block_timestamp`, and `closed_at ≥ job.closes_at` for aggregate jobs. | `NOT_CHAIN_MISMATCH` |
| N8 | Fetch `counted_inputs`. It is sorted with no duplicates, has exactly `accepted` leaves, and its Merkle root equals `input_commitment`. | `NOT_COMMITMENT_MISMATCH` |
| N9 | `suppressed == (accepted < privacy.k_min)`. If suppressed, the output is the fixed "insufficient participation" value. | `NOT_SUPPRESSION_INVALID` |
| N10 | A public output validates against `output_schema` with its transforms applied (clamped, rounded, bucketed), and `output_hash == H(output.public)`. A private output only lists recipients; each recipient checks the hash of what they received against `output_hash`. | `NOT_OUTPUT_INVALID` |
| N11 | Walk `job_log_head` back to `seq` 0. Each record's signatures verify, there are no gaps in `seq`, and every anchored kind has an EAS attestation indexed by `job_hash`. Two anchored records with the same `seq` give `JOB_LOG_FORK`. | warnings `JOB_LOG_GAP`, `JOB_LOG_FORK` (not fatal) |
| N12 | At least `close_quorum` cosignatures, from distinct instances, where `close_quorum` = ⌊N/2⌋ + 1 for the job's `replica_set`. Each one's attestation passes **V** with purpose `0x02`, this `job_hash`, `final_epoch` and `program_hash`, and an `id_key_hash` that is a `replica_set` card. Each one's `inst_key_hash` matches its signing key, and the signature covers `H(body)`. | `NOT_QUORUM_INSUFFICIENT` |
| N13 | No `epoch_started` record for an epoch greater than `final_epoch` was anchored before `closed_at` (§2.5.7) | `NOT_EPOCH_SUPERSEDED` |

N11 is a warning, not a rejection. A missing anchor shows that an operator withheld something, which is exactly what G4 wants made visible. It doesn't make the tally wrong.

### 2.3.7 Algorithm P — peer check before a handoff (used by §2.5)

The **sender** enclave runs this on the receiver, and the receiver runs it on the sender.

| # | Check | Reject code |
|---|---|---|
| P1 | The peer's purpose-`0x03` attestation passes **V** with: `inst_key_hash = SHA-256(peer K_inst)`; `nonce` = a fresh 32-byte challenge this enclave chose for this handoff; `t_eval = now`; `max_age = 5 min`. | `ATT_*` |
| P2 | The peer's PCR0 is accepted according to the runtime's own list copy (§2.3.9). An upgrade handoff between two different PCR0s is allowed only if both are accepted. | `HANDOFF_RUNTIME_NOT_ACCEPTED` |
| P3 | Job scope: the peer's notary card is in the job's `replica_set`, and the peer proved it holds that card's `K_id` with a signature over the challenge. Identity scope: the peer's notary card is this enclave's own. Template scope: the peer's notary card has `issuer_card == T` and is in `T.approved_notaries` (§2.5.3). | `HANDOFF_SCOPE_DENIED` |
| P4 | A peer that will receive a job key has passed program admission (**A**) for the same `program_cid` and `isolation`. It proves this with a purpose-`0x04` attestation for this job and epoch, with nonce = this handoff's challenge. Both sides must also report the same ABI string (`notary_v1`), so their fuel accounting matches (§2.7.1). | `HANDOFF_PROGRAM_MISMATCH` |

### 2.3.8 Algorithm A — program admission

The runtime runs A when it loads a program. The `notary-lint` CLI runs the identical code, from the same crate, at policy creation. **Ordering:** A runs to completion before the broker generates `K_job`. No job key ever exists for a program that wasn't admitted.

**Feature set allowed in v1.** WebAssembly 1.0 (MVP) plus `mutable-global`, `sign-extension`, `multi-value` and `bulk-memory`. Everything else is rejected:
- threads and atomics, shared memory
- SIMD and relaxed SIMD
- **all floating-point instructions and types**
- exceptions, tail calls, reference types beyond one `funcref` table, GC, `memory64`, multi-memory
- the component model
- a `start` function

**Why no floating point.** Votes are recomputed from all inputs at close, possibly on a different replica after a handoff. Integer-only programs give the same output on every replica with no NaN-canonicalization rules to audit. Templates use fixed-point arithmetic. The alternative was to allow floats with canonical NaNs; it was rejected because it adds an audit surface for no v1 template's benefit.

**Host functions (the complete import list).** Module `"notary_v1"`, all `i32`:

| Import | Signature | Behaviour |
|---|---|---|
| `input_count` | `() -> i32` | Number of inputs given to this run (always 1 in `per_input` mode) |
| `input_len` | `(i) -> i32` | Byte length of input `i`'s payload, as JCS |
| `input_read` | `(i, ptr, len) -> i32` | Copies the payload into guest memory. Returns the bytes copied, or traps on out-of-range. |
| `param_len` | `() -> i32` | Byte length of `job.parameters` as JCS |
| `param_read` | `(ptr, len) -> i32` | Copies the parameters |
| `output_write` | `(ptr, len) -> i32` | Submits the output as JCS bytes. Callable once; a second call traps. |
| `abort` | `(code) -> !` | Ends the run with a program error |

The ABI string `notary_v1` also fixes wasmi's **fuel cost table**. A runtime that changes fuel costs must use a new ABI string, so replicas recomputing at close always agree on fuel exhaustion (§2.7.1). There is no clock, randomness, I/O, key access, or access to other jobs. Payloads reach the program only after the broker has checked signatures, eligibility and dedupe (§2.4). The program never sees a card address. For a derived-card job the broker passes the source card's projected field values, not the card itself.

| # | Check | Reject code |
|---|---|---|
| A1 | `program_cid` is CIDv1 with the `raw` codec and sha2-256, and `SHA-256(module bytes)` equals its digest. | `ADM_HASH_MISMATCH` |
| A2 | Module size ≤ 4 MiB (runtime ceiling). | `ADM_TOO_LARGE` |
| A3 | The module validates under the allowed feature set above, with no start function. | `ADM_FEATURE_DISALLOWED` |
| A4 | Every import is one of the seven above, with that exact signature. There are no imported memories, tables or globals. | `ADM_IMPORT_DISALLOWED` |
| A5 | Exactly one defined memory, not shared, exported as `"memory"`, with a declared maximum of at most 256 pages (16 MiB) and at most `policy.notary.limits.memory_pages` if set. | `ADM_MEMORY_LIMIT` |
| A6 | At most one table, of type `funcref`, with a declared maximum of at most 1,024 entries. | `ADM_TABLE_LIMIT` |
| A7 | At most 10,000 functions, 1,000 locals per function, 1,000 globals, and 1 MiB of data segments in total. | `ADM_STRUCTURE_LIMIT` |
| A8 | Exactly two exports: `"memory"` and `"run": () -> i32`. | `ADM_EXPORTS_INVALID` |
| A9 | Custom section `"notary.abi"` contains exactly the UTF-8 bytes `notary_v1`. Custom section `"notary.output_schema"` contains UTF-8 JCS bytes equal to `JCS(policy.notary.output_schema)`. Each appears exactly once. Other custom sections, including `"name"`, are ignored but count toward A2. | `ADM_SCHEMA_MISMATCH` |
| A10 | `policy.notary.limits`, if set, are within the runtime ceilings: fuel 10⁹ per run, wall-clock 60 s per run, max inputs 100,000. | `ADM_LIMITS_EXCEED_CEILING` |
| A11 | If `isolation == "shared"`: `program_cid` is on the runtime's allowlist copy (§2.3.9), accepted now and not retired. If `"dedicated"`: the runtime is in dedicated mode and holds no other job. | `ADM_NOT_ALLOWLISTED_FOR_SHARED`, `ADM_DEDICATED_REQUIRED` |

The ceilings in A2, A5, A7 and A10 are first estimates. Step 5.6 measures real templates against them, and any change is recorded as spec errata.

The output's runtime checks (that it is JCS, validates against `output_schema`, and passes the privacy transforms) happen when the program runs, so they are in §2.4. An output that fails them ends the job with `OUTPUT_SCHEMA_VIOLATION`, and the runtime never releases unvalidated bytes.

### 2.3.9 How the runtime gets the governance lists (the threat from §2.2.2)

The runtime needs both lists: the PCR0 list for P2, and the allowlist for A11. Its only source is its host.

**Defense.**
1. **Pinned at build time.** The runtime image compiles in the two list card addresses, the ML-DSA-44 keys allowed to sign their updates (the list holder's key and the PressRegistryBody press key), and a **floor**: the lowest list version the image accepts. All of this is covered by PCR0.
2. **Signatures checked.** The host supplies the list card's genesis document and log entries. The runtime checks each `intent_signature` and `press_signature` against the pinned keys, checks the `prev_log_root` chain, and takes the `card_state` of the highest version it has verified.
3. **Never goes backwards.** The runtime refuses any version below the floor or below the highest it has already seen. The highest-seen version travels in heartbeats and handoffs (§2.1.11, §2.1.12), so a restarted replica inherits it from its peers.

**What remains.** A host can keep every replica it controls on the newest list it has already shown them, and withhold later updates. If a program is retired for a vulnerability, a hostile host could keep running it `shared` with other jobs, whose wallets can't see their co-tenants. The protocol's lever for this is to retire the runtime itself. Governance retires the PCR0 as `"vulnerable"` and publishes an image with a higher floor. Wallets then refuse every job on the old runtime at W15, and peers refuse it at P2, regardless of what list the host feeds it. The emergency-retirement path in §2.2.2 matters for this reason. Rotating a pinned key also means a new image; that is acceptable, since list-signing keys change rarely.

**Alternatives considered.**
- Trusting a host-supplied head with no floor: rejected, because the host could roll back to any list ever published.
- Compiling the allowlist into the image: rejected, because every new allowlisted program would then need a new PCR0.
- TLS from inside the enclave to several RPC providers, with a quorum on the answer: deferred. It replaces "trust the host" with "trust k of n providers", and is worth revisiting together with state proofs.

## §2.4 Runtime architecture and host protocol

### 2.4.1 Differential privacy in v1 (D7) — decided 2026-11-11: specify and defer

| Option | What ships | Risk |
|---|---|---|
| **(a) Specify and defer** *(recommended)* | v1 enforces `k_min`, clamping, rounding or bucketing, and per-cell suppression. `privacy.dp` is specified (mechanism, parameters, budget semantics) but a v1 runtime refuses any policy that sets it, so it fails closed. Wallets show "no differential privacy". | Organizers who need DP must wait. k-anonymity alone doesn't protect against differencing attacks across repeated jobs over the same members. The spec must say so plainly. |
| (b) Per-job DP in v1 | Discrete Laplace or discrete Gaussian noise, sampled with integer arithmetic from the enclave's RNG (floating-point samplers leak through rounding). `ε` per job, set by the policy. | No budget accounting across jobs. A requester who runs the same query weekly gets ε per week without limit, so the guarantee is weaker than it looks. Sampler code needs its own audit. |
| (c) DP with a cumulative budget per policy | (b) plus a budget ledger | The ledger is enclave state that dies with total loss. Losing it resets the budget, which is a privacy failure rather than an availability failure. Needs a design this plan hasn't done. |

### 2.4.2 Processes inside the enclave

```
 ┌──────────────────────── enclave (one PCR0) ─────────────────────────┐
 │  broker (1 process)                       workers (1 per job)       │
 │  • every key: K_id/K_chain keyring,  pipe  • wasmi interpreter      │
 │    K_inst, K_job per (job, epoch),  ◄────► • one job's payloads     │
 │    state key, dup-tag keys                   only                   │
 │  • /dev/nsm (attestation)                 • no keys, no NSM, no     │
 │  • HPKE decryption                          card addresses          │
 │  • signature and chain checks             • seccomp: read/write on  │
 │  • dedupe index, revision order             its two pipes, exit,    │
 │  • privacy transforms on output             memory; nothing else    │
 │  • vsock to host                                                    │
 └──────────────▲──────────────────────────────────────────────────────┘
                │ vsock (the only channel out)
             host (nitropack service)
```

**Decision.** There is one broker process and one worker process per job. A program runs in a fresh wasmi store and instance on every run. The worker for a `per_input` job lives as long as the job but gets a new instance for each input, so no program state carries from one input to the next. An aggregate job's worker is started at close and killed when the run ends.

**Why separate processes and not just separate wasmi stores.** A bug in wasmi that lets a program escape its sandbox would then land in a process with no keys, no NSM device and only its own job's payloads. Each worker runs under its own UID, with `/dev/nsm` readable only by the broker's UID. Workers have a seccomp filter, a read-only filesystem, and memory and CPU rlimits. The enclave has no network, so the vsock owned by the broker is the only channel out.

**Shared vs. dedicated.** In `shared` mode one enclave holds workers for many jobs, all running allowlisted programs (A11). In `dedicated` mode the enclave admits exactly one job and refuses `CreateJob` for any other. The `isolation` byte in every job attestation (§1.4) lets wallets check which mode was used.

**Alternative considered.** One process with stores only: simpler, but a single interpreter escape would expose every key in the enclave. Rejected. A separate enclave per job: AWS allows only four enclaves per instance, which is the reason the multi-job runtime exists. Rejected.

### 2.4.3 Framing

Both protocols use the same framing: a 4-byte big-endian length, then JCS JSON. That keeps one serialization in the whole design (§0.5). Bytes are base64url. Each frame is at most 16 MiB. Larger transfers, such as the ciphertexts sent at close, are split into numbered chunks. Every message has a `kind` and a `req_id`, and a response echoes the `req_id`.

### 2.4.4 Broker ↔ worker messages

| Direction | `kind` | Fields | Notes |
|---|---|---|---|
| B→W | `load` | `program` (bytes), `limits` | The worker hashes `program` itself and returns the hash. |
| W→B | `loaded` | `program_hash` | The broker checks it against the admitted hash and kills the worker on a mismatch. |
| B→W | `run` | `run_id`, `params` (JCS), `inputs` (array of JCS payloads, sorted by `input_hash`) | Inputs carry no card data. Sorting makes runs deterministic across replicas. |
| W→B | `output` | `run_id`, `bytes`, `fuel_used` | The raw program output. The broker applies the checks in §2.4.9. |
| W→B | `error` | `run_id`, `reason` ∈ `trap`, `fuel`, `memory`, `abort:<code>`, `output_twice`, `no_output` | |
| B→W | `terminate` | | The broker also kills the process when the wall-clock limit passes. |

The broker never sends a worker a key, a card address, another job's payloads, or anything else from the host. Wall-clock time is enforced by the broker killing the worker. Fuel is enforced by wasmi's fuel metering, and memory by wasmi's resource limiter plus the process rlimit.

### 2.4.5 Host ↔ enclave messages (vsock)

Every message from the host is untrusted. The broker validates each one, and the host may drop, delay, reorder or replay any of them. A replayed `submit_input` produces the same `input_hash`, so processing is idempotent and the same receipt comes back.

**Host → enclave**

| `kind` | Fields | Broker action | Response |
|---|---|---|---|
| `hello` | `challenge` | Generates `K_inst` on first boot. Attests with purpose `0x03`. | `hello_ack`: `inst_pubkey`, `attestation` |
| `chain_headers` | `[{ number, header_rlp }]` | Hashes each header with keccak and checks that it links by parent hash to the newest accepted header. Ignores anything older. | `chain_ack`: `newest` |
| `fetch_result` | `req_id`, `bytes` or `not_found` | Answers an enclave `fetch`. IPFS objects are checked against their CID. Registry reads can't be verified in v1 (§2.4.11). | |
| `genesis` | genesis request (§2.3.5) | Generates `K_id` and `K_chain`. Attests with purpose `0x01`. | `genesis_ready` |
| `countersign_notary_card` | offer | Checks G2 for its own keys, then signs `holder_signature`. | `countersigned` |
| `create_job` | `job`, `program` | Runs the job checks (§2.4.6), then admission **A**, then generates `K_job` and attests with purpose `0x02`. | `job_keyed`: `epoch`, `job_public_key`, `attestation`, signed announcement |
| `submit_input` | `job_hash`, `sealed_input` | Validates the input (§2.4.7). | `input_result`: `input_hash`, `receipt_sealed` |
| `close_chunk` | `job_hash`, `seq`, `sealed_inputs[]`, `last` | Collects every stored ciphertext for the final epoch, then runs the close computation (§2.4.8). | `job_closed`: notarization, job log record, output messages |
| `anchor_receipt` | `job_hash`, `seq`, `tx_receipt` | Lets the broker sign record `seq + 1` (§2.1.10). | |
| `chain_result` | `req_id`, `tx_receipt` or `failed` | Result of a chain submission | |
| `peer_message` | `from_instance`, `bytes` | Handoff and heartbeat traffic (§2.5) | |
| `abort_job` | `job_hash`, `reason` | The host may abort any job; that's the known "operator controls I/O" limit. The broker writes an `aborted` record and erases the job's keys. | `job_log_record` |

**Enclave → host**

| `kind` | Fields | Host action |
|---|---|---|
| `fetch` | `req_id`, `what` ∈ `policy_snapshot:<policy_address>`, `policy_updates:<policy_address,since_block>`, `ipfs:<cid>`, `card_head:<address>`, `press_auth:<policy,press>`, `subcard:<address>`, `events:<filter>` | Fetches it and answers with `fetch_result`. Per-card kinds are used only for ancestors outside snapshotted policies and the §2.6.1 fallback. |
| `publish` | `object` (JCS bytes), `pin` (bool) | Pins it to IPFS and serves it (announcements, notarizations, job log records, `counted_inputs`) |
| `announce` | the signed announcement | Serves it at `/jobs/{job_hash}/announcement`. Sent again roughly every 6 hours with fresh attestations (§2.3.4). |
| `chain_submit` | `op`, `payload`, `signature` | Submits the transaction from the gas wallet (derived-card writes) |
| `eas_anchor` | `record_cid`, `job_hash`, `seq` | Submits the EAS attestation |
| `deliver` | `routing_envelope` | Delivers an encrypted output or derived card through message routing |
| `peer_send` | `to_instance`, `bytes` | Relays to another replica's host |
| `alert` | `level`, `code` | Operator monitoring only. Never contains job data. |

### 2.4.6 Job checks at `create_job`

The broker repeats the wallet's checks W2–W10 (§2.3.4) using chain data fetched through the host. It adds one more: this enclave's own notary card must be in `job.replica_set`. Any failure answers `job_rejected` with the W code. The enclave checks these itself so a host can't make an enclave produce an attested key for a job that no wallet would accept. Such a key would be useless, but it would put misleading entries in the job log.

### 2.4.7 Input validation (broker, at `submit_input`)

B5–B8 read card documents from the input's `evidence` bundle and registry state from the policy snapshot (§2.6.1), never by fetching a single card. These steps run in order. The plaintext is zeroized as soon as the last step finishes, whatever the result. The reject codes are the `reject_reason` values of `ValidationReceipt` (§2.1.7).

| # | Check | Result if it fails |
|---|---|---|
| B1 | HPKE-open with `K_job` for (`job_hash`, `epoch`), using the `info` and `aad` from §2.1.5. If the epoch's key has already been erased, the input is refused. | `INPUT_UNDECRYPTABLE`. No sealed receipt is possible, so the host gets a plain error. |
| B2 | Parse `NotaryInput`. `type` is correct and `job_hash` matches. | `INPUT_MALFORMED`, `INPUT_WRONG_JOB` |
| B3 | `chain_ref` names a block on the broker's accepted header chain. If the block is newer, the broker asks for headers and waits up to 60 s. The newest `chain_ref` the broker has accepted becomes its floor: it never processes against chain state older than that. | `INPUT_CHAIN_REF_UNKNOWN`, `INPUT_CHAIN_REF_MISMATCH` |
| B4 | `chain_ref`'s timestamp is ≥ `opens_at` and, for aggregate jobs, < `closes_at`. | `INPUT_TOO_EARLY`, `INPUT_LATE` |
| B5 | The signer is a valid sub-card: binding check, `"notary_input"` in its `capabilities`, `valid_until`, and the full sub-card check in `protocol-objects.md §16` (it is in the master card's `active_subcards` and active on-chain). | `INPUT_SIGNER_INVALID` |
| B6 | `keccak256(contributor_card_pubkey) == contributor_card`, which equals the sub-card's `holder_primary_card`. | `INPUT_BINDING_MISMATCH` |
| B7 | The master card's chain reaches a trusted root, and the card isn't revoked at the broker's current chain state. | `INPUT_CARD_UNTRUSTED`, `INPUT_CARD_REVOKED` |
| B8 | The master card's chain satisfies `contributor_predicate`, with parameter references resolved (§2.1.1). | `INPUT_NOT_ELIGIBLE` |
| B9 | `payload` validates against `input_schema`. | `INPUT_SCHEMA_INVALID` |
| B10 | **Dedupe**, keyed on the master card's **root key**: `past_keys[0].pubkey` if present, otherwise `recipient_pubkey` (§2.6.0). A key rotation therefore doesn't give a holder a second vote. Under `reject_duplicates`, `revision` must be 0 and the root key must be new. Under `latest_wins`: a lower `revision` than the one held is marked `superseded`; the same `revision` with the same signed input (a resubmission in a new epoch) is accepted and replaces the stored `input_hash`; the same `revision` with a different input is rejected; a higher `revision` is accepted and the earlier input becomes `superseded`. | `INPUT_DUPLICATE`, `INPUT_REVISION_INVALID`, `REVISION_CONFLICT`; status `superseded` |
| B11 | The job holds fewer than `max_inputs` distinct root keys. | `INPUT_CAPACITY` |

**What the broker keeps.** For each accepted input it keeps one index entry: `root_key_hash → { revision, input_hash, epoch }`. This is not a running tally. It records who has a counted input, not what they chose. It never leaves the enclave except inside a handoff (§2.5). The ciphertexts themselves are stored by the host.

**Eligibility at close.** At close the broker re-runs B5–B9 against the chain state it closes on. A card revoked before close isn't counted, even if it was accepted earlier. Its contributor's receipt said "accepted", and the notarization's `rejected` count includes it.

### 2.4.8 Close computation (aggregate jobs)

1. The broker holds a verified header with timestamp ≥ `closes_at`, **and** a fresh NSM attestation with timestamp ≥ `closes_at` (§2.5.0 finding 2). Until then it rejects `close_chunk`, so a host can delay close but never bring it forward.
2. The host streams every stored `SealedInput` for the final epoch. The broker decrypts each one and re-runs B2–B10 against the closing chain state.
3. The counted set is the latest accepted input per root key. Any `input_hash` in the index that the host didn't supply is counted in a new notarization field, `dropped_after_acceptance`. That count is attributable: each affected contributor holds both a host receipt and a validation receipt (G4).
4. If fewer than `k_min` root keys are counted, the output is the fixed value `{ "insufficient_participation": true }` and no program runs.
5. Otherwise the broker runs the worker once, with the counted payloads sorted by `input_hash`.
6. The broker checks and transforms the output (§2.4.9), then builds the notarization body. It is finalized only through the quorum close of §2.5.5, after which the job log record and any `notary_output` messages are sent.
7. After finalization (§2.5.5 step 4) it erases `K_job`, the index, and every plaintext buffer. The worker is killed.

**Schema change, §2.1.9.** The notarization gains `dropped_after_acceptance` (integer, required). Notarization check N8 (§2.3.6) is unchanged, since the commitment covers only what was counted.

### 2.4.9 Output checks and privacy transforms

The broker applies these to whatever the program returns, in this order:

1. **Parse.** The bytes must be valid JCS for an object whose fields exactly match `output_schema`: no extra fields, and every required field present. Field types in v1 are `integer`, `boolean` and `text` (≤ 256 characters, `enum` required). There are no free-form strings, so a program can't use one to leak data. Failure: `OUTPUT_SCHEMA_VIOLATION`, and the job ends with no output.
2. **`clamp: [min, max]`** on integer fields: `v ← min(max(v, min), max)`.
3. **`round_to: r`** (a positive integer): round to the nearest multiple of `r`, ties to even, in exact integer arithmetic. **`buckets: [e0 < e1 < … < en]`**: requires `clamp` with `min = e0`; `v ← max{ eᵢ : eᵢ ≤ v }`. `round_to` and `buckets` can't both be set on one field.
4. **`suppress_cell_below_k: k`**: on integer fields that count people. If `0 < v < k`, the field is omitted from the output. The field must be declared `required: false`; lint and admission enforce this.
5. **Whole-output k:** already handled at close step 4.

**What these transforms guarantee, stated precisely for the spec.** The output always lies inside the ranges and granularity the policy declares, whatever the program does. That is the G2 objective "a leaky program cannot exceed the policy's privacy bounds". They do **not** make an arbitrary program private. A custom program whose output field is "the first voter's choice" stays within its declared range and passes. Protection against that comes from the allowlist audit and from the wallet showing "custom program, not independently audited". `notary-lint` warns about any integer output field that has neither `round_to` nor `buckets` when `k_min < 10`.

### 2.4.10 Job lifecycle

**Aggregate jobs (including votes)**

```
            create_job ok                  chain time ≥ opens_at
 (none) ───────────────► KEYED(e) ─────────────────────────────► OPEN(e)
   │ A or W fails           │                                     │  submit_input → B1–B11
   ▼                        │ abort_job                           │  (receipts; index updated)
 REJECTED                   ▼                                     │
                         ABORTED ◄──────────── abort_job ─────────┤
                            ▲                                     │ chain time ≥ closes_at
                            │ OUTPUT_SCHEMA_VIOLATION             ▼
                            └─────────────────────────────── CLOSING ──(all chunks)──► COMPUTING
                                                                                          │
                                       FINALIZED (notarized; K_job, index, buffers erased) ◄┘

 Epoch change (total loss of every replica, §2.5): a new enclave enters KEYED(e+1) for the
 same job_hash. The old epoch's state is gone, and wallets resubmit.
```

**Per-input jobs (derived cards)**

```
 (none) ──create_job──► KEYED(e) ──opens_at──► OPEN(e) ──key_period elapsed──► ROTATING(e→e+1)
                                                 │  each input: B1–B11 → run    │ K_job,e+1 made and attested;
                                                 │  → output queued for the     │ K_job,e kept for a 1 h grace
                                                 │  issuance batch (§2.6)       ▼ window, then erased
                                                 │                            OPEN(e+1)
                                                 └── chain time ≥ ends_at ──► ENDED (keys erased)
```

### 2.4.11 Chain data in the enclave (v1 trust level)

| Data | How the broker gets it | Verified? |
|---|---|---|
| Block headers | `chain_headers` | Hash linkage only (keccak of the RLP header, parent links). Not consensus or finality. A host could supply a fabricated chain. The notarization records `chain_state` so verifiers can check it against the real chain (N7). |
| IPFS objects (cards, log entries, policies) | `fetch ipfs:` | Yes, by CID hash and by the signatures inside. |
| Registry reads (card heads, `PressAuthorizations`, sub-card `active` flags) | Policy snapshots and updates (§2.6.1). Per-card `fetch` only for ancestors and the fallback. | **No.** Trusted from the host in v1. A hostile host can show a revoked card as live, or an old head. This is a known limit recorded in every notarization. Verifying these needs state proofs or TLS-to-RPC quorum (deferred, §2.3.9). |

**Consequence to state in the spec.** In v1 a hostile host can get the enclave to count an input from a card that was revoked shortly before. N7 catches a fabricated block, but nothing catches a stale registry read until state proofs exist. Each wallet's own `chain_ref` limits how far back the host can push this: the broker never uses chain state older than the newest `chain_ref` it has seen.

**Recipient keys for private outputs (open point from §2.1.9).** Recipients' sub-card lists come from the same chain state the close uses. A stale state can include a device the recipient has since removed, which could then read the output. This is accepted for v1 under the same limit.

### 2.4.12 Limits and zeroization

| Limit | Runtime ceiling | Policy may lower it? |
|---|---|---|
| Fuel per run | 10⁹ | Yes (`limits.fuel`) |
| Wall-clock per run | 60 s | Yes |
| Linear memory | 256 pages (16 MiB) | Yes |
| Inputs per job | 100,000 | Yes |
| `SealedInput` size | 256 KiB (fits the evidence bundle, §2.6.1) | No |
| Concurrent jobs per enclave | 256 in `shared` mode; 1 in `dedicated` | No |

The numbers are provisional until step 5.6 measures real templates.

**Zeroization.** Every secret lives in a buffer that is wiped when dropped (Rust `zeroize`) and locked into memory (`mlock`):

| What | Erased when |
|---|---|
| `K_job,e` | The job is finalized or aborted, or 1 hour after rotation in `per_input` jobs |
| Decrypted payloads | After B11, and after each run |
| A worker's whole address space | When the process exits at close; `per_input` workers recreate the store for every input |
| The dedupe index | At finalize |
| `K_inst` | Never persisted; dies with the enclave |

Zeroization is defence in depth. The host can't read enclave memory in any case, but wiping limits what a later in-enclave compromise could recover from earlier jobs.

## §2.5 Long-running jobs, replication and recovery

Answers Q15. Each protocol below is a set of numbered steps. After each protocol, a table shows what an attacker who controls one operator's host can and cannot do. "Host" always means a hostile host. Several hosts colluding are treated separately in §2.5.9.

### 2.5.0 Phase 2 findings in this section

These change earlier sections. The patches are listed in §2.5.10.

1. **A host could choose the vote result by splitting replicas.** Suppose one replica closes alone. A host can partition the replicas and stream a different set of ciphertexts to each, producing two valid notarizations with different tallies. **Fix:** closing needs a **quorum of co-signatures**, q = ⌊N/2⌋ + 1, where N is the total instances in `replica_set`. Every cosigner recomputes the result itself, and an instance never co-signs two different notarizations for one job. Any two quorums share an honest replica, so two conflicting notarizations can't both reach a quorum. This is the reason `min_live ≥ q` is required, and another payoff of the no-floating-point rule (A3): recomputation gives the same bytes on every replica.
2. **A host could close a vote early by feeding a fake block.** The enclave checks only that headers link by hash (§2.4.11). A host can mine nothing but still invent a child header with a timestamp past `closes_at`. **Fix:** close also requires the **NSM's own clock**. The broker asks the NSM for an attestation and reads its `timestamp`, which the AWS hardware signs and the host can't set. Both that time and the header time must be ≥ `closes_at`. This has to be confirmed on real hardware in step 5.2 and Phase 8. If the parent instance can influence NSM time, that is a **CP9** stop.
3. **An input acknowledged by only one replica dies with that replica.** **Fix:** the receiving replica forwards each input to its peers, and returns the validation receipt only once q replicas have accepted it. An acknowledged input survives the loss of any minority of replicas.
4. **A host can fake "total loss" by killing all of its own enclaves.** The new epoch it starts discards every stored ballot whose voter is offline. This can't be prevented, so §2.5.6 makes it *visible*. The strategic plan already recommends cross-operator replicas for votes; finding 4 is why. With cross-operator replicas, no single host can kill a quorum.

### 2.5.1 Roles and timing parameters

| Name | Meaning | Default |
|---|---|---|
| N | Total instances in `job.replica_set` | 3 |
| q | Close and acknowledgment quorum, ⌊N/2⌋ + 1 | 2 |
| `min_live` | Re-replication floor. Must satisfy q ≤ `min_live` ≤ N (W7). | q |
| Heartbeat interval | How often each replica sends a heartbeat to each peer | 30 s |
| Liveness window | A peer silent for longer than this counts as down | 120 s |
| Job leader | The live replica of the job with the lowest `instance` hash (`SHA-256(K_inst pub)`). It signs job log records and coordinates close. | |
| Identity leader | The live holder of a notary card's `K_id` with the lowest `instance` hash. It is the single writer for that card's chain payloads (D1). | |

Leadership comes from heartbeats, so a partition can produce two leaders. That is tolerated: two leaders can fork the job log, which is visible (N11 → `JOB_LOG_FORK`), but they can't both get a notarization accepted (finding 1).

### 2.5.2 Forming the replica set (new job, epoch 0)

1. The host sends `create_job` to one of its enclaves, the **originator**. It runs §2.4.6, admission **A**, generates `K_job,0`, and attests with purpose `0x02`.
2. For each other instance in `replica_set` (its own operator's, or another operator's through that operator's host), the originator runs a **job-scope handoff** (§2.5.3). Each receiver then attests with purpose `0x02`, using the same `job_public_key` hash.
3. Once q instances hold the key (originator included), the job leader writes the `opened` record. Each instance's `0x02` attestation CID is listed in it. The leader then waits for the record's EAS anchor.
4. The leader signs the announcement listing every `0x02` attestation it has, and the host publishes it. Inputs before this point are impossible, because no wallet has the key.

| A hostile host can | A hostile host cannot |
|---|---|
| Refuse to start replicas, or drop handoff traffic. The job never reaches q and never opens. | Open a job with fewer than q replicas. The leader won't sign `opened` or the announcement. |
| Delay the anchor, which delays opening | Make a non-enclave or non-accepted runtime hold `K_job` (P1–P4) |

### 2.5.3 Handoff protocol (job, identity and template scopes)

The **sender** S holds the keys; the **receiver** R is joining. The host relays every message.

**Scopes.**
- **Job:** `K_job` for one epoch, the dedupe index, and the job log head and sequence.
- **Identity:** the `K_id`/`K_chain` keyring, the sealed-link state key, and the highest list versions seen (§2.3.9). Between instances of the same notary card only.
- **Template:** the dup-tag ratchet key `k_T,p` (§2.6.0). Between instances of different notary cards that serve the same template `T`. P3 for this scope checks that the peer's notary card has `issuer_card == T` and is in `T.approved_notaries`.

**Steps.**
1. S and R each pick a fresh 32-byte challenge and send it to the other.
2. R generates an **ephemeral handoff key** (X-Wing). It attests with purpose `0x03` (and also `0x04` for job scope), with `nonce` = S's challenge and `public_key = SHA-256(ephemeral handoff key)`. S attests with purpose `0x03`, with `nonce` = R's challenge.
3. Each side runs **P** on the other (§2.3.7). S also checks it isn't over-replicating: if its heartbeats already show the number of instances `replica_set` allows for R's notary card, it refuses with `HANDOFF_OVER_CAPACITY`.
4. S builds the handoff payload: `{ scope, keys, state, state_version, state_hash, job_log_head, seq }`. It HPKE-seals the payload to R's ephemeral key with `info = "card-notary-handoff-v1" ‖ S challenge ‖ R challenge`. S signs the ciphertext hash with `K_inst`.
5. R checks S's signature against the `K_inst` bound in S's attestation, opens the payload, and installs the keys. It refuses a `state_version` lower than any it has seen in heartbeats (finding 3 of §0.2). It then erases the ephemeral key, and signs the `HandoffRecord` (§2.1.11) as `receiver_signature`.
6. The job leader (for identity or template scope, S) writes the `handoff` record to the job log or identity log. R starts serving (accepting inputs, co-signing, writing chain payloads) only after it has seen the record's EAS anchor. Every handoff therefore appears in the public log before the new replica can act (G4).

| Step | A hostile host can | A hostile host cannot |
|---|---|---|
| 1–3 | Drop or delay messages, so the handoff fails (denial of service). Start extra enclaves of its *own* operator up to the capacity cap. | Substitute its own key for R's ephemeral key: the key hash is in R's attestation. Get the keys sent to a non-accepted runtime, to the wrong notary card, or to an enclave without the program admitted (P1–P4). Replay an old attestation: the challenges are fresh. |
| 4–5 | See the ciphertext | Read the keys or the state. Hand R an older state, since `state_version` must not go backwards. |
| 6 | Withhold the anchor, so R never starts serving | Make R act without a public `handoff` record |

**Runtime upgrades.** A handoff where S's and R's PCR0 differ is how a running job moves to a new runtime. It is allowed when both PCR0s are accepted at the time (P2). If governance retires S's PCR0 as `"vulnerable"`, peers on the new runtime refuse to *receive* from it as well. Moving off a vulnerable runtime therefore has to happen before retirement takes effect, or by restarting the job in a new epoch.

### 2.5.4 Inputs across replicas

1. The host gives a `submit_input` to any of its enclaves holding the job (the **receiver**). The receiver runs B1–B11 (§2.4.7).
2. If the input passes, the receiver sends the same `SealedInput` to every live peer with `peer_send`. Each peer runs B1–B11 itself and replies `input_ack { input_hash, status, revision, instance, instance_signature }`.
3. Once q replicas, counting itself, report the same status, the receiver returns the `ValidationReceipt` with a new field `acks: q`. Each peer's host stores the ciphertext too, so it is held by q operators' storage, not one.
4. If q acknowledgments don't arrive within 60 s, the receiver returns no receipt. The wallet retries (§2.3.4).

| A hostile host can | A hostile host cannot |
|---|---|
| Drop or withhold an input, which shows as a missing receipt; the contributor holds the host receipt (G4) | Get a validation receipt issued for an input fewer than q replicas hold |
| Route all inputs to one replica | Cause replicas' indexes to disagree on an acknowledged input without that showing at close (§2.5.5) |

### 2.5.5 Chain-anchored close with a quorum

1. Each replica independently waits until **both** a verified header has timestamp ≥ `closes_at` **and** a fresh NSM attestation's timestamp is ≥ `closes_at` (finding 2).
2. The job leader runs the close computation (§2.4.8) on the ciphertexts its host streams. It produces the notarization body, everything except `notary_signature` and `cosignatures`.
3. The leader sends the body to every live peer. Each peer **recomputes** independently from the ciphertexts its *own* host supplies:
   - The peer's counted set must equal the body's `counted_inputs`. Every `input_hash` in its own index must appear either in `counted_inputs` or in the `dropped_after_acceptance` count. And its own program run must give the same `output_hash`.
   - If all of that holds, the peer signs `H(body)` with `K_inst` and returns `{ attestation: <its 0x02 attestation CID for the final epoch>, instance_signature }`.
   - Each peer records `job_hash → H(body)` and never co-signs a different body for that job.
4. Once q cosignatures are in, counting its own, the leader adds them as `cosignatures`, signs `notary_signature` with `K_id`, and finalizes. Every replica erases its keys when it sees the `notarized` record.
5. If a peer's recomputation differs, it refuses and sends `close_mismatch` with its own counted-set hash. The leader can't finalize without q agreeing replicas. The job stays in `CLOSING` and an alert goes to every operator. Persistent disagreement means some host withheld ciphertexts from its replica, and each host can fix it by supplying them.

| Step | A hostile host can | A hostile host cannot |
|---|---|---|
| 1 | Withhold headers, delaying close | Close early, since NSM time can't be forged (to be confirmed, CP9). Close on a fabricated header alone. |
| 2–3 | Stream an incomplete set to its own replica, which then disagrees with its peers and stalls close | Produce two different valid notarizations for one job: they would need two quorums sharing a replica, and that replica co-signs only once. Get an output computed by a modified program, because each cosigner runs the admitted program itself. |
| 4 | Withhold the notarization's publication or anchor | Forge cosignatures: each is bound to an instance key, which is bound to an attestation for this job |

**Schema changes.**
- §2.1.9 Notarization gains `cosignatures` (array of `{ attestation: cid, instance_signature: SignatureEntry }`, ≥ q entries, distinct instances) and `close_quorum` (integer q).
- §2.3.6 gains **N12**: at least q cosignatures. Each one's attestation passes **V** with purpose `0x02`, the same `job_hash`, `final_epoch` and `program_hash`, and an `id_key_hash` that is one of the job's `replica_set` cards. Each one's `inst_key_hash` matches its signing key, and the signature covers `H(body)`. Reject code `NOT_QUORUM_INSUFFICIENT`.

### 2.5.6 Heartbeats, re-replication and losing replicas

1. Every replica sends a `Heartbeat` (§2.1.12) to every peer at each heartbeat interval. A peer silent for longer than the liveness window is counted as down.
2. When the live count for a job falls below `min_live` but at least one replica is alive, the job leader writes `replica_lost` (naming the silent instance). It sends its host `alert need_replica` with the affected notary card. That operator's host starts a new enclave, ideally in another availability zone, and a job-scope handoff (§2.5.3) follows. A `replicated` record is written when it completes.
3. While fewer than q replicas are live, the job **stops issuing receipts**: an input can't be acknowledged by q replicas. Close also waits. Re-replication restores q.
4. A replica that comes back after being counted as down rejoins only by a fresh handoff, with its old keys discarded. Its heartbeat `seq` and `state_version` show peers whether it missed anything.

| A hostile host can | A hostile host cannot |
|---|---|
| Kill its own replicas, or claim they died | Hide that from the public log: the surviving leader writes `replica_lost`, and a missing anchor halts the job (§2.1.10) |
| Refuse to start a replacement, stalling the job | Bring a stale replica back into the set with old keys or state |

### 2.5.7 Epochs after total loss, and resubmission

**When.** No live replica holds `K_job,e`. For an aggregate job that only happens on total loss; a `per_input` job also changes epoch at every `key_period`.

1. The operator's host gives an enclave `create_job` with `restart: { prev_epoch: e, last_log: <cid of the last job log record the host has> }`. The enclave checks the job is still before `closes_at`. It then forms a new replica set (§2.5.2) and generates `K_job,e+1`.
2. The new leader's first record is `epoch_started`, with `epoch_reason: "total_loss"` and `prev` = `last_log`. It refuses to publish an announcement until that record is anchored.
3. The announcement for epoch e+1 is published. Wallets that have submitted to this job check it every 6 hours, and immediately when a receipt is missing.
4. A wallet that sees a higher epoch with reason `"total_loss"` tells the user their input had to be resent. It runs W1–W15 on the new announcement, re-encrypts its **stored signed `NotaryInput`** (latest `revision`, unchanged and not re-signed) to `K_job,e+1`, and submits it. The new epoch's dedupe index starts empty, so the latest revision each online voter resubmits is what counts (latest-ballot-wins across epochs, keyed per root key, B10).
5. Wallets keep each signed input until they have seen a valid notarization for the job, plus 7 days.

**Which notarization is valid when epochs overlap.** A partition can leave old-epoch replicas alive while a new epoch starts. New rule **N13**: a notarization for `final_epoch = e` is valid only if no `epoch_started` record for e+1 or higher was anchored **before** its `closed_at`. If both exist, the notarization from the highest epoch wins. Reject code `NOT_EPOCH_SUPERSEDED`. Step 2's anchoring requirement is what makes this checkable.

| A hostile host can | A hostile host cannot |
|---|---|
| Force total loss by killing all of its enclaves, so offline voters' ballots are lost. This is documented as a known limit, and the reason votes should use cross-operator replicas: a single host then can't kill a quorum. | Make a forced reset invisible: it is an anchored `epoch_started` record with reason `total_loss`, and wallets surface it to users |
| Point `last_log` at an older record, so the job log forks | Revert a voter to an earlier ballot: wallets resubmit their latest signed revision |
| | Get an old-epoch notarization accepted after a newer epoch was anchored (N13) |

### 2.5.8 The sealed-link state blob in operation (detail for D4)

1. The identity leader holds the sealed-link table and the nullifier/dup-tag table in memory. After each issuance batch or propagation batch (§2.6) it writes a new body, encrypted under the state key. It writes a `StateBlobHeader` with `version + 1` and `prev_hash`, then asks the host to store it (`publish`, `pin: false`; local disk or private storage, since the body is encrypted).
2. It sends the new `{ version, header_hash }` to the other identity holders in the next heartbeat. They fetch the blob from their own hosts, check its hash, and replace their copies. A holder never accepts a lower version.
3. A new identity holder gets the state key together with `state_version` and `state_hash` in the identity handoff (§2.5.3). It loads only a blob whose header hash matches.
4. If every identity holder dies, the state key is gone, so the links and the dup-tag history are gone too. Derived cards fall back to `expiry_only` behaviour, and the dup-tag key restarts with the next period (§2.6.0). The identity log records the loss when the operator performs genesis again.

| A hostile host can | A hostile host cannot |
|---|---|
| Lose or delete stored blobs; a live holder still has the state in memory and re-publishes | Roll a holder back to an old blob, because versions are carried in heartbeats and handoffs (D4) |
| Kill every identity holder, losing the links (documented fallback) | Read any link: the body is encrypted under a key that only exists inside enclaves |

### 2.5.9 Several colluding hosts

If the operators running a quorum of a job's replicas collude, they can do together what one host can do alone, applied to the whole job. They can stall it, force total loss, or stream incomplete sets to all of their replicas so that dropped inputs agree. In the last case `dropped_after_acceptance` still exposes them, because contributors hold receipts acknowledged by q replicas. Colluding hosts still **cannot** read inputs or keys, or forge or alter a result, as long as the enclave and the AWS root hold. These assumptions go into the single threat-model list in §2.7.

### 2.5.10 Patches to earlier sections

| Section | Change |
|---|---|
| §1.4 `public_key` | For purposes `0x03` and `0x04` made during a handoff: `SHA-256(ephemeral handoff key)`. Absent for the boot `0x03` (`hello`). |
| §2.1.2 NotaryJob | `min_live` must satisfy q ≤ `min_live` ≤ N, so the default is 2 of 3 |
| §2.1.7 ValidationReceipt | New field `acks` (integer, ≥ q) |
| §2.1.9 Notarization | New `cosignatures` and `close_quorum` |
| §2.1.10 JobLogRecord | `kind` adds `"replicated"` (already listed). Records are written by the job leader. |
| §2.1.11 HandoffRecord | `scope` adds `"template"` |
| §2.3.4 W7 | Check q ≤ `min_live` ≤ N |
| §2.3.6 | New N12 (quorum) and N13 (epoch supersession). N11 gains the `JOB_LOG_FORK` warning. |
| §2.3.7 P3 | Template scope, as defined in §2.5.3 |
| §2.4.8 step 1 | Also requires NSM time ≥ `closes_at`. Steps 5–7 become the quorum close of §2.5.5. |

## §2.6 Derived cards and revocation propagation

Answers Q16–Q19. §2.6.0 records decision D10. Each flow below is numbered, and the timing-linkage defenses are named parameters with defaults (§2.6.11).

### 2.6.0 Duplicate tag (D10, decided 2026-11-11)

Every derived card carries a signed field `dup_tag`:

```
dup_tag = HMAC-SHA256(k_T,p, root_source_key || source_policy || p)
  p               = the nullifier period index (from T.notary.derived_card.nullifier_period)
  root_source_key = source card's past_keys[0].pubkey if present, else its recipient_pubkey
                    (so rotating the source card's key doesn't produce a fresh tag; to confirm against key_rotation.md)
  k_T,p           = k_T,p-1 ratcheted forward: HKDF-SHA256(k_T,p-1, info = "card-notary-dup-tag-ratchet" || p)
```

- **Why keyed.** An unkeyed hash of the source address could be reversed by hashing every card listed under `source_policy` on-chain.
- **Who holds the key.** `k_T,p` is held only in enclaves serving template `T`, across all of `T`'s operators, and moves only by attested handoff. That gives every operator the same tag for the same source card. This answers the cross-operator duplicate gap from D9: duplicates are detected where the card is used.
- **Erasing old keys.** A period key is erased once its period plus a grace window has passed. The ratchet is one-way, so a key extracted later can't reproduce earlier tags. A break exposes at most the current period.
- **Enclave refusal.** The enclave also refuses to issue a second card with a tag it has already used.
- **Total loss.** If every enclave serving `T` dies, the key is lost, and new tags from then on can't be matched with earlier ones until the period rolls over. This is accepted.
- **Rejected alternatives.**
  - A one-time pad: no gain, see the note below.
  - A per-operator key: brings back the cross-operator gap.
  - A threshold or oblivious PRF: not post-quantum, and it needs several operators online for every issuance. Could be revisited later.
  - A holder-computed tag with a zero-knowledge proof: deferred with the other client-side ZK work.

*Note on a one-time pad.* The tag must be deterministic: every enclave must map the same source card to the same tag. So a shared pad would be a lookup table that every enclave holds in full. Extracting it gives the attacker everything, with nothing to test. A 256-bit HMAC key already can't be guessed. The real risk is extraction, which a bigger key doesn't change; what reduces it is how many periods one extraction exposes, which the ratchet addresses.

### 2.6.1 Phase 2 finding: the host learns which cards the enclave checks

Section 2.4 has the broker fetch every card it checks through its host: the IPFS documents and the registry reads (card heads, revocation status, sub-card `active` flags), all looked up by address (§2.4.5 `fetch`). The host therefore learns **which cards took part**.
- For a vote or aggregation, that means the operator learns who participated, though not their choices.
- For a derived card, it means the operator learns which source card was presented. That is exactly the link derived cards exist to hide.

The strategic plan's claim that a derived card "cannot be linked to the source card by the host's records" fails under §2.4 as written.

**Fix: evidence bundles and policy snapshots.**
1. **Evidence bundle.** Every `NotaryInput` carries an `evidence` field: the bytes of every IPFS object the broker needs to check the contributor. That is the master card's genesis document and current head, its sub-card document, and the documents and heads of its ancestors. The broker checks each object against its CID and the signatures inside, so the bundle is trustworthy whatever the wallet or host does. Nothing is fetched by CID.
2. **Policy snapshot.** Registry state can't come from the bundle; it has to come from the chain. So the host supplies, and keeps up to date, a **snapshot of every card registered under each policy the job depends on**: the source policy for derived cards, or each `issued_under_template` policy in `contributor_predicate`. A snapshot entry is `{ address, log_head_cid, last_press_address }`, plus the `SubCardRegistrations` entries whose master card is in the set, plus the IPFS bytes of each card's current head. The broker reads from its local copy and never asks for a single card. Snapshots are as trustworthy as any registry read in v1 (§2.4.11), and are recorded through `chain_state`.
3. **Ancestors outside snapshotted policies** (for example, a steward card that issued the source card) are still fetched by address. That reveals the issuer, which many cards share, not the holder. The spec states this.
4. **Fallback.** If a `contributor_predicate` names no policy that can be snapshotted (only `chain_includes`, for example), the broker falls back to fetching by address. The wallet's consent screen then says "the operator will learn that your card took part". `notary-lint` warns about such policies.

**Cost.** Snapshot size grows with the number of cards under the policy: roughly 150 bytes per card plus its head object. That is about 100 KB for a 1,000-member club, and roughly 10–30 MB for a 100,000-member source policy. Step 5.6 measures it. The `SealedInput` size limit rises from 64 KiB to 256 KiB to fit evidence bundles (patch §2.4.12).

**Bonus for sealed links.** Snapshot *updates* are what the `sealed_link` watch loop needs (§2.6.6), so the same mechanism answers Q17 with no extra leak.

### 2.6.2 The derived card

A `CardDocument` under the template policy `T` (§2.1.1, D1):

| Field | Value |
|---|---|
| `policy_id` | `T` |
| `issuer_card`, `press_card` | The notary card |
| `issuer_signature`, `press_signature` | `K_id` |
| `recipient_pubkey`, `holder_signature` | The holder's fresh derived key `D` |
| `ancestry_pubkeys` | `[K_id pub, T's pubkey]`. `T` is registered in `PolicyAuthorizerKeys`, so the chain walk ends at `T`. |
| `issued_at` | The batch boundary at which the card is released (§2.6.4), not when it was requested |
| `expires_at` (D8) | The end of the nullifier period the card belongs to (§2.6.3) |
| `source_policy` | `cid` |
| `projected` | The source card's values, under their source field names, as the `derive` program returned them |
| `dup_tag` | §2.6.0 |
| `protocol_version` | Read from the contract, as for presses |

Cards in the same period share `expires_at`, and cards in the same batch share `issued_at`, so neither timestamp distinguishes one holder from another.

**Verifying a derived card.** Ordinary verification, plus two notary-specific checks that join `card_verifier.md` Stage 5:
- **G** on the notary card's `genesis_attestation`, with `t_eval` = the notary card's `issued_at`. This shows the signing key was born in an accepted runtime.
- An `expires_at` check (D8).

A verifier that wants to check one person per period compares `dup_tag`s.

### 2.6.3 Periods, nullifiers and renewal (Q16)

- **Periods are aligned to fixed boundaries.** Period `p` covers `[p · P, (p + 1) · P)` in Unix seconds, where `P = nullifier_period`. Every derived card issued for period `p` expires at `(p + 1) · P`. The card's validity therefore equals the period, and the policy field `derived_card.validity` is dropped.
- **Nullifier** = `dup_tag` (§2.6.0). The broker keeps the set of tags it has used for each open period, in the identity state (§2.5.8). A second request with a used tag is refused with `DERIVE_DUPLICATE`.
- **Renewal.** During the last `renewal_window` of period `p`, a holder may present the source card again and receive a card for `p + 1`. It has a fresh key `D'`, the period `p + 1` tag, and expires at `(p + 2) · P`. The old card lapses at the end of `p`. There is no in-place update and no code 301 (D8).

### 2.6.4 Issuance flow

1. **The wallet** fetches the job's announcement and runs **W**. The consent screen comes from `T` and the job. It shows the source policy, the fields that will be copied, the notary, `expires_at`, and the propagation mode with its disclosure (§2.6.8).
2. **The wallet** generates the derived key `D`, then builds a `NotaryInput`:
   - `contributor_card` = the source master card.
   - `payload` = `{ "derived_recipient_pubkey": D_pub, "target_period": p }`.
   - `evidence` = the bundle (§2.6.1).
   It signs with the source card's sub-card and sends it over the double envelope (§2.1.5).
3. **The broker** runs B1–B11, with B7 against the source-policy snapshot. It then runs the derive checks:

   | # | Check | Reject |
   |---|---|---|
   | D1 | `target_period` is the current period, or the next one if inside `renewal_window` | `DERIVE_PERIOD_INVALID` |
   | D2 | `D_pub` has never appeared in any input this notary has accepted | `DERIVE_KEY_REUSED` |
   | D3 | `dup_tag` for (`root_source_key`, `source_policy`, `target_period`) is not in the used set | `DERIVE_DUPLICATE` |
   | D4 | The worker runs the `derive` program on the source card's fields listed in `job.parameters.projected_fields`, and the output passes §2.4.9 | `OUTPUT_SCHEMA_VIOLATION` |

4. **The broker** builds the offer. All fields are set except `recipient_pubkey`, `holder_signature` and `press_signature`, and `issued_at` = the next batch boundary. It signs `issuer_signature`, then returns the offer sealed inside the validation receipt.
5. **The wallet** checks the offer: `projected` matches its own source card's values, and `expires_at`, `source_policy` and `issuer_card` are as consented. It adds `D_pub` and signs `holder_signature` with `D`. It then sends a `notary.countersign.v1` message (`{ type, job_hash, offer_hash, holder_signature }`, sealed like an input) over the same double envelope.
6. **The broker** checks `holder_signature`, then puts the card in the **issuance pool** for the period. It also records the tag as used. For `sealed_link` only, it stores the link.
7. **At each batch boundary**, the broker releases every pooled card whose (notary card, `source_policy`, `projected` value, period) group has reached `min_anonymity_set` members in total (§2.6.5). The batch must have at least `min_batch_size` cards, or it waits for the next boundary. The broker then:
   - shuffles the order;
   - signs each `press_signature` and pins each card (encrypted under its content key);
   - emits one `RegisterCard` payload per card, signed with `K_chain` by the identity leader;
   - writes an `issued` job log record with only the count.
8. **The wallet** computes the card's address as `keccak256(D_pub)` and watches the registry for it. It reads the CID from the registry head when the card appears, so no delivery message is needed.
9. **Cards that never qualify.** A card still pooled at the end of its period was never released, so it is dropped. Its holder sees no registration, and the wallet shows "not issued: too few holders share this value".
10. **A missed boundary.** If a card's `issued_at` boundary passes without its group qualifying, the broker sends a fresh offer with the next boundary, and the wallet countersigns again (§2.1.4: countersigning needs no user prompt).

| Step | A hostile host can | A hostile host cannot |
|---|---|---|
| 2–3 | Drop the request, which shows as no receipt | Learn which source card was presented (§2.6.1) |
| 4–6 | Delay the offer or the countersignature | Read the offer, the projected values or `D_pub` |
| 7 | Withhold registrations, so cards never appear (denial of service, attributable through receipts) | Register a forged card: content needs `K_id`. Deface derived-card heads after D5 lands. Learn which registration belongs to which request beyond 1 in the batch size. |

### 2.6.5 The anonymity-set check (Q16)

**The problem.** The enclave can't count how many *source* cards share a projected value, because card contents are encrypted under keys derived from holders' public keys, which the enclave doesn't have. (`registry_contract.md §3.1`: addresses are hashes of those keys.)

**Decision.** Measure the anonymity set where it matters: among **derived-card holders**. A derived card shows its issuer (the notary card), `source_policy`, `projected` and the period. A verifier who sees one can narrow its holder down only to holders of derived cards with the same four values. So a card is released only once at least `min_anonymity_set` distinct `dup_tag`s share that group (notary card, `source_policy`, `projected`, period). Groups with rare values wait, and are dropped at period end if they never qualify (§2.6.4 step 9).

**Alternatives considered.**
- Counting all cards under `source_policy` from the snapshot gives an upper bound with no per-value information. It is kept as a second floor: at least `min_anonymity_set` cards under the source policy.
- Asking the source policy's issuer to publish statistics adds a party and a trust assumption. Rejected.

### 2.6.6 Revocation propagation (Q17, Q18)

**`expiry_only` (v1).** No link is kept, though dup tags still are (§2.6.3). A revoked source card simply can't be renewed, and its derived card lapses at the end of the period. The worst-case delay is one period plus `renewal_window`.

**`sealed_link` (v1).**

**Link entry**, kept in the identity state blob (§2.5.8): `{ derived_address, source_address, source_pubkey, expires_at }`. `source_pubkey` lets the broker decrypt the source card's future log entries. Entries are erased when the derived card expires.

**Watch loop (Q17).**
1. The host sends **snapshot updates** for each source policy with live links: every new `CardHeadUpdated` under that policy, with the new head's IPFS bytes.
2. For each update, the broker checks whether the address is a `source_address` in its links. If it is, it decrypts the entry with the stored `source_pubkey` and reads `code`. The broker does this for every update in the stream, linked or not, so nothing it requests depends on the links.
3. **Successor rule.** If the source card has an effective `successor` (a key rotation, codes 100–102) and the successor's chain is under the same source policy, the link moves to the successor. A revocation of the old card (typically 801) does **not** propagate.
4. Otherwise, if `code` matches `propagated_codes`, the broker queues a revocation for the derived card (§2.6.7).

**Privacy statement for the spec.** The host learns only which source policies have live derived-card jobs, which is public from the jobs themselves. It doesn't learn which source cards are linked, which source cards were ever presented, or which update caused a propagation. This replaces the option analysis in `notary-spec-impact.md §D.4`, which assumed per-card watching.

**Code mapping (Q18). Decided by David 2026-11-11 (D11).** Two new codes, added to `update_codes.md`:
- **820**: "propagated revocation: source credential ended (quiet)"
- **920**: "propagated revocation: source credential revoked (loud)"

`revocation_propagation.derived_code` is either `"range"` (8xx → 820, 9xx → 920, the default) or a fixed code such as `820`, for policies that want to hide severity. The exact source subcode is never copied, so the derived card never reveals more about the source revocation than whether it was quiet or loud. Copying code for code was rejected because 9xx subcodes say why someone was revoked, which the derived card was meant not to disclose. Always using one fixed code was rejected as the default because a loud revocation is a safety signal other communities rely on (`update_codes.md` 9xx). Policies can still choose it.

### 2.6.7 Releasing revocations: timing defenses

**The threat.** Source revocations are public events under the source policy, with timestamps. If a derived-card revocation under `T` followed soon after, and alone, an observer could match the two.

1. A queued revocation becomes **eligible** at `source_effective_time + revocation_min_delay`. `source_effective_time` is the block timestamp of the source update.
2. At each `revocation_batch_window` boundary, the broker releases every eligible revocation **if** at least `min_revocation_batch` are eligible. Otherwise it holds them all.
3. A held revocation whose derived card expires first is dropped, because expiry achieves the same result with no event. Holding is therefore bounded by the period.
4. A released batch is one `BatchUpdateCardHeads` transaction under `T`, with entries in shuffled order. Each `LogEntry` is a revocation coded per §2.6.6, signed by `K_id` as both updater and press, with `revocation.note` omitted and `effective_date` set to the release time. Its `notify_holder` is true.
5. `T` mixes derived cards from every source policy, so a batch also mixes revocations across communities.

**Residual linkage, stated plainly.** An observer who matches source-revocation events with derived-revocation batches can narrow a derived revocation down to the source revocations in the window. That is at least `min_revocation_batch` events, and more when the window is busy. Small communities with rare revocations get the weakest protection, and the consent disclosure says so.

### 2.6.8 Wallet disclosure (consent lines generated from the policy)

| Mode | Line shown |
|---|---|
| `expiry_only` | "This card lasts until {expires_at}. If your {source policy name} card is revoked, this card won't be renewed." |
| `sealed_link` | "The notary keeps a sealed link between this card and your {source policy name} card, so it can revoke this card if that one is revoked. The link is held only inside the secure enclave and is lost if every copy of the notary fails." |
| any, with the fallback from §2.6.1 | "The operator will learn that your card took part." |
| any | "Cards are issued in batches; yours may take up to {issuance_batch_interval} or longer if few people share your values." |

### 2.6.9 `PressIssuanceRecord`s (Q19). Decided by David 2026-11-11 (D12): no records

`protocol-objects.md §11` requires a record for every issuance, sent to the policy's auditors, to the issuer, and to the policy card's holder. Under D1 and D2 the policy holder for every template is PressRegistryBody. A record carries `recipient_pubkey`, which gives a card's messaging address and the key to its content. So these records would hand governance a complete, decryptable directory of every derived card across all communities, along with their projected values. They wouldn't reveal source cards.

**Recommendation.** Notary-issued derived cards send **no** `PressIssuanceRecord`s. The public `issued` count in the job log replaces them. `T` declares no `auditors`. §11 gains an exception for cards whose `press_card` is a notary card. Timing (Q19's second part) is moot without records. If records were kept, their `issued_at` would be the batch boundary, which adds no timing information.

**Alternative.** Keep the records for accountability, so governance could audit what a notary issues. This conflicts with the derived-card goal and with "retention: none".

### 2.6.10 `escrowed_link` (specified, not built in v1)

The link `{ derived_address, source_address }` is encrypted to a t-of-n threshold of `T`'s escrow holders and published with the issuance. It is opened only by a challenge process defined in governance text. v1 runtimes refuse it. It is documented so a policy can be written against it later.

### 2.6.11 Parameters and defaults

All of these are `T.notary` fields. A template policy may change the defaults within these bounds.

| Parameter | Field | Default | Bounds | Defends against |
|---|---|---|---|---|
| Period (also the card's validity) | `derived_card.nullifier_period` | 7 days | 1–90 days | Long-lived linkability. Also bounds how stale a card can be under `expiry_only`. |
| Renewal window | `derived_card.renewal_window` | 2 days | ≤ ½ period | Gaps at period boundaries |
| Issuance batch interval | `derived_card.issuance_batch_interval` | 6 h | 1–24 h | Linking request time to registration time |
| Minimum batch size | `derived_card.min_batch_size` | 5 | ≥ 2 | Same |
| Anonymity set | `derived_card.min_anonymity_set` | 10 | ≥ 2 | Rare projected values identifying a holder |
| Propagated codes | `revocation_propagation.propagated_codes` | `["8xx","9xx"]` | Any subset | |
| Derived code | `revocation_propagation.derived_code` | `"range"` | `"range"` or one 8xx/9xx code | Leaking the reason for revocation |
| Revocation minimum delay | `revocation_propagation.min_delay` | 24 h | ≥ 1 h | Matching revocation events by timing |
| Revocation batch window | `revocation_propagation.batch_window` | 24 h | 1 h – 7 days | Same |
| Minimum revocation batch | `revocation_propagation.min_revocation_batch` | 3 | ≥ 1 | Same |

### 2.6.12 Patches to earlier sections

| Section | Change |
|---|---|
| §2.1.1 `derived_card` | Fields become `nullifier_period`, `renewal_window`, `issuance_batch_interval`, `min_batch_size`, `min_anonymity_set`. `validity` is removed. |
| §2.1.1 `revocation_propagation` | Adds `min_revocation_batch`. `derived_code` may be `"range"`. |
| §2.1.4 NotaryInput | Adds required `evidence` (array of `{ cid, bytes }`). Derived-card payload shape is `{ derived_recipient_pubkey, target_period }`. New message `notary.countersign.v1`. |
| §2.1.10 JobLogRecord | `kind` adds `"issued"` (body: `{ count, period, batch_boundary }`) |
| §2.4.5 | `fetch` adds `policy_snapshot:<policy_address>` and `policy_updates:<policy_address, since_block>`. Per-card fetches are used only for ancestors outside snapshotted policies and for the §2.6.1 fallback. |
| §2.4.7 B5–B7 | Read from the evidence bundle and the policy snapshot |
| §2.4.12 | `SealedInput` limit 256 KiB |
| `update_codes.md` (Phase 3) | Codes 820 and 920 (D11) |
| `protocol-objects.md §11` (Phase 3) | Exception for notary-issued cards (D12) |
| `card_protocol_spec.md` (Phase 3) | Parameter references in predicates (§2.1.1) |

## §2.7 Milestone review

### 2.7.1 Consistency pass

**Checked.** Every field name used across §1–§2.6 against its defining table; that one serialization is used throughout (JCS, `H` = SHA-256, base64url); that the reject-code prefixes are consistent; that every "patch" table was applied; and that no protocol relies on a property another section removes. Terminology: the doc never uses bare "Nitro" except when quoting the term for the Q20 note.

**Fixed in this pass:**
- §2.1.1: `k_min` counted "master cards"; now root keys, matching B10.
- §0.2 finding 1 now notes that D1 resolves it.
- §1.3 genesis step 5 named a per-community `AuthorizePress`; now the template `T`, once per operator.
- §2.1.12 Heartbeat lacked the list versions that §2.3.9 says it carries; `list_versions` added.
- §2.1.7 ValidationReceipt lacked the derived-card offer that §2.6.4 returns in it; `derived_offer` added.
- §2.1.16 serialization table: added notarization cosignatures and the countersign message.

**Properties one protocol relies on, checked against the others:**

| Property | Relied on by | Could another section remove it? | Result |
|---|---|---|---|
| Programs are deterministic | Quorum close (§2.5.5), where each cosigner recomputes | Floats are banned (A3), and there is no clock or randomness import (A4). **But** fuel use could differ if a job moves to a runtime with a different fuel cost table, so one replica runs out of fuel and another doesn't. | **Added rule:** the fuel cost table is part of the `notary_v1` ABI and is frozen. A runtime that changes it must change the ABI string, and a handoff (P4) requires the same ABI. Close then can't disagree because of an upgrade. |
| Keys never leave enclaves | Every confidentiality claim | Handoff (§2.5.3) is the only export path, and it requires P1–P4 | Consistent |
| The host can't roll back state | D4, §2.3.9 lists | Both rely on versions in heartbeats and handoffs, which the host relays but can't forge (signed with `K_inst`) | Consistent |
| The host never learns which card took part | §2.6 unlinkability; vote privacy | §2.4.5 `fetch` by address originally broke it; fixed by §2.6.1 except ancestors and the fallback, both disclosed | Consistent, with stated exceptions |
| Close can't happen early | §2.5.5 | Relies on NSM time (§2.5.0 finding 2), which is not yet confirmed on hardware | **Open, CP9 if it fails** |
| Every handoff is logged before the receiver acts | G4 | The anchor-before-next-record rule (§2.1.10) and R waiting for the anchor (§2.5.3 step 6) | Consistent |
| One valid notarization per job | §2.5.5 quorum plus N13 | Overlapping epochs are handled by N13, which relies on `epoch_started` being anchored before any input (§2.5.7 step 2) | Consistent |
| Revoked cards can't contribute | B7 | Registry reads are unverified in v1 (§2.4.11) | A known limit (L4 below), not an inconsistency |
| Derived cards can't be forged by the host | §2.6 | Content needs `K_id`. Heads could be defaced while the write-gate gap is open. | D5 fixes the gap before Phase 6.4 |
| Duplicate detection across operators | D10 | Needs the template key `k_T,p` shared by template-scope handoff (§2.5.3) | Consistent. After total loss of every enclave serving `T`, tags can't match earlier ones until the next period (stated). |

### 2.7.2 Threat-model assumptions (the single list for the spec)

The spec's notary threat model states these and nothing beyond them. Each says what breaks if it fails.

| # | Assumption | If it fails |
|---|---|---|
| T1 | **AWS is trusted as the hardware root**: the AWS Nitro Enclaves root certificate, the NSM, and isolation of enclave memory from the parent instance | Everything: an attacker with AWS's signing keys or a hypervisor break can fake attestations or read keys |
| T2 | **Accepted runtimes are correct.** The audited runtime keeps invariants I1–I3 (§1.2) and the broker/worker isolation of §2.4.2. | Keys could be exported or imported. Governance retiring the PCR0 as `"vulnerable"` limits new damage but recalls nothing already leaked. |
| T3 | **Enclave side channels are out of scope** (cache timing, power, speculative execution against co-tenants on the same host) | Key or input leakage. Partly mitigated: `dedicated` isolation for custom programs, and constant-time crypto libraries. |
| T4 | **Allowlisted programs are what their audit says.** Reproducible builds tie `program_cid` to source. | A malicious allowlisted program could leak within its declared output ranges (§2.4.9). It can't escape them. |
| T5 | **Governance bodies act in good faith** (as in ADR-011's scope note) | A captured PressRegistryBody could accept a malicious runtime. Wallets would then trust it. |
| T6 | **Cryptography holds**: ML-DSA-44, X-Wing draft-06, ChaCha20-Poly1305, SHA-256, HMAC-SHA256, secp256r1 (on-chain only), and ES384 (AWS attestations) | A classical break of ES384 is the AWS root's problem (T1). X-Wing draft-06 is a hybrid, so both halves would have to fail to expose inputs. |
| T7 | **The hosts are adversarial for I/O but not colluding across a quorum** of a job's replicas | With quorum collusion: stalls, forced total loss, and drops that agree across replicas (still exposed by receipts). Never disclosure or forgery (§2.5.9). |
| T8 | **Chain data is honest only as far as the host feeds it** (v1 has no state proofs) | See L3 and L4 |
| T9 | **NSM time cannot be influenced by the parent instance** (§2.5.0 finding 2) | Early close becomes possible. To verify in 5.2 and Phase 8; a CP9 stop if false. |
| T10 | **The relay and the notary host are run by different parties** (`oblivious_transport.md`, Honest Caveat) | The operator learns contributors' IP addresses |

### 2.7.3 Known limits (stated in the spec as limits, not bugs)

| # | Limit | Where | Mitigation in v1 |
|---|---|---|---|
| L1 | The operator controls I/O. It can drop inputs, delay close, refuse handoffs, or force total loss. | §2.3.4, §2.5 | Receipts make drops attributable. The job log makes resets visible. Cross-operator replicas for votes. |
| L2 | Total loss of every replica loses the job key, and offline voters' ballots with it | §2.5.7 | Online wallets resubmit automatically. Defaults of 3 replicas across availability zones. |
| L3 | Block headers are checked only for hash linkage | §2.4.11 | N7 checks against the real chain. NSM time gates close. |
| L4 | Registry reads are unverified. A recently revoked card can be counted, and a recipient's removed device can read a private output. | §2.4.11 | Wallet `chain_ref` floors. `chain_state` recorded in every notarization. State proofs later. |
| L5 | The host can withhold governance list updates from its runtime | §2.3.9 | Image floors. Wallets enforce the current list. Retire the runtime PCR0 for serious issues. |
| L6 | k-anonymity and transforms don't stop differencing across repeated jobs | §2.4.1, §2.4.9 | DP specified for later (D7). Lint warnings. |
| L7 | Ancestor cards outside snapshotted policies, and fallback predicates, are fetched by address | §2.6.1 | Disclosed on the consent screen |
| L8 | Small communities get weak timing protection for revocations | §2.6.7 | `min_revocation_batch`; mixing across communities under `T`; disclosure |
| L9 | Derived cards from different operators are matched as duplicates only while the template key survives | §2.6.0 | A new key from the next period on |
| L10 | Anyone may open a derived-card job over any source policy (D9) | §2.1.1 | Derived cards state only the source CID and verbatim values |

### 2.7.4 Checkpoint status

| Checkpoint | Status |
|---|---|
| CP2 | **Now.** This document goes to David. |
| CP6 (breaking shared objects) | **Not triggered.** Every change to `CardDocument` (`expires_at`), `PolicyCardDocument` (`approved_notaries`, `notary`) and `LogEntry` (none; D3 avoids it) is a new optional field or new content. Existing cards and tests are unaffected. |
| CP7 (contracts) | **Triggered by D5**, the write-gate calldata binding: a logic-contract upgrade, needed before Phase 6.4. Also one-time governance actions before any testnet use: `RegisterPolicy` for `NotaryCardPolicy`, the list-card policy and each template `T`; `AuthorizePress` per (template, operator); the EAS schema registration. Each is a CP7 action when it happens. |
| CP9 (security deviations) | Three known triggers, each to be tested early: X-Wing draft-06 JS↔Rust interop (5.1); NSM time independence (T9; 5.2 and Phase 8); the NSM size limits on `user_data`, `nonce` and `public_key` (5.2). |

### 2.7.5 Changes to strategic-plan wording (for David to apply or approve)

| Strategic plan says | Becomes | Decision |
|---|---|---|
| "Notarizations are log entries on the notary sub-card's log; EAS anchoring is optional per policy." | An enclave-signed job log on IPFS, with each record anchored by EAS | D3 |
| "Links persist in an encrypted state blob anchored on-chain" | Versioned, and carried in attested handoffs and heartbeats; optional EAS audit anchor | D4 |
| "Runtime acceptance list: governance-signed protocol artifacts (ADR-011)" | PressRegistryBody-held list cards | D2 |
| "Short `valid_until` (renewed by re-presenting the source card)" | `expires_at` at the end of an aligned period; renewal issues a fresh card | D8, §2.6.3 |
| "the job public key in `public_key`" (attestation) | `SHA-256` of the job public key, since X-Wing keys exceed the field size | §0.2 finding 6 |
| "Notary operators hold a notary sub-card of the policy" | Unchanged for aggregation and vote policies. Derived cards use governance template policies. | D1, D6 |
| "the host feeds it registry updates" (sealed link) | Snapshots of whole policies, never per-card queries | §2.6.1 |
| "Default 3 replicas across availability zones" | Unchanged, plus a close quorum of ⌊N/2⌋ + 1 and `min_live ≥ q` | §2.5 |

### 2.7.6 Phase 3 actions this document creates

- **Q20 terminology note.** Add to `ARCHITECTURE.md` (and a one-line pointer in `press.md`): "Nitro" in existing specs means the unjs web framework, published as the `nitropack` package. "AWS Nitro Enclaves" is the TEE used by notaries. `nitro-devnode` is the Arbitrum local development node. New text uses "nitropack" and "AWS Nitro Enclaves" in full. Existing specs are not rewritten.
- `card_protocol_spec.md`: parameter references in predicates (§2.1.1). The Notaries feature section.
- `protocol-objects.md`: the new objects (§2.1). `expires_at` on `CardDocument`. `approved_notaries` and `notary` on `PolicyCardDocument`. The §11 exception (D12).
- `update_codes.md`: codes 820 and 920 (D11).
- `card_verifier.md`: `expires_at`; notarization verification (N1–N13); derived-card checks (genesis attestation **G**, `dup_tag` guidance).
- `wallet_sdk.md`: algorithm **W**, consent lines (§2.6.8), receipts, resubmission, countersigning, evidence bundles.
- `oblivious_transport.md`: the notary host as a third destination kind (§2.1.5).
- `press-rules.md` and a PressRegistryBody notary mandate, including the **emergency-retirement** proposal (§2.2.2), which is a governance-process decision for David.
- New specs: `notary_lifecycle.md`, `notary_replication_and_recovery.md`, `derived_card_revocation_propagation.md`, `notary_runtime.md`, `notary_host.md`.

### 2.7.7 Deferred (recorded, not designed further)

- Differential privacy (D7)
- `escrowed_link` (§2.6.10)
- Threshold or oblivious PRF for `dup_tag` (§2.6.0)
- Arbitrum state proofs, or TLS-to-RPC quorum, for verified chain reads (L3, L4, L5)
- Other TEEs (SEV-SNP, TDX)
- Delegated policy registration, if template policies prove too restrictive (D1)
- Client-side ZK alternatives
