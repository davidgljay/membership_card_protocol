# Notary spec wording, batch 2 (for David's approval)

*Drafted 2026-11-12.* This document applies to the specs every erratum that is decided but not yet written, and puts the three still-open decisions to you with a recommendation each. No spec file has been edited. After you approve, I apply the wording exactly as written here, update `notary-questions-phase-5.md` and `notary-questions-5.3.md`, and update the code only where a decision differs from what is already implemented.

Group 1 holds your decisions. Group 2 holds wording for items you already decided. Group 3 holds two items I found already decided but never written into the spec (E6, E7). Group 4 holds E27, which is a test run, not a decision.

---

## Group 1: decisions

### 1.1 E26: the first identity-log record

**Problem.** Lifecycle step 9 says the enclave "Writes the first identity-log record", but no record `kind` exists for it. Algorithm E walks the identity log to `seq` 0. Today the code writes nothing at genesis, so the log starts with the first identity handoff (6.3).

**Options.**
- **A (recommended): `opened` at `seq` 0.** This reuses the existing `opened` kind, which is already anchored. Its body is `{ "attestations": [<genesis_attestation cid>] }`. Algorithm E then requires `seq` 0 to be this record and to name the card's own `genesis_attestation`.
  - *Gains:* every notary card has a log with an unambiguous start, anchored on-chain with a chain time. A card with no anchored `seq` 0 fails E, so a host can't leave a card without a log.
  - *Costs:* one EAS anchor per notary card. The enclave must not issue derived cards or open jobs for the card until it has seen the anchor (the same rule as every other anchored record).
- **B: no genesis record.** Delete the sentence from step 9. The log starts at the first `handoff`. An empty log is valid, and E uses only the genesis attestation's PCR0.
  - *Gains:* nothing more to build.
  - *Costs:* "no log yet" can't be told apart from "log withheld" until the first handoff.
- **C: a new kind, `genesis`.** This is A with its own kind name. It adds an enum value and gives nothing A doesn't.

**Related wording problem (same paragraph area).** Recovery step 33 says that after total loss "The operator performs notary genesis again ..., and the identity log records it." Genesis again makes a new `K_id`, so it makes a **new notary card with a new identity log**. The old log can't record anything, because no key for it survives. I propose to fix this with either option.

**Wording if A is chosen:**

- `notary_lifecycle.md` step 9, current:
  > 9. **Enclave.** Writes the first identity-log record (`protocol-objects.md §28`, `type: "notary.identity_log.v1"`). The operator then forms its identity replica set by identity-scope handoff (`notary_replication_and_recovery.md`).

  Proposed:
  > 9. **Enclave.** Writes the first identity-log record (`protocol-objects.md §28`, `type: "notary.identity_log.v1"`): `seq` 0, kind `opened`, body `{ "attestations": [<genesis_attestation>] }`. It opens no job and issues no derived card for this notary card until it has seen that record's anchor. The operator then forms its identity replica set by identity-scope handoff (`notary_replication_and_recovery.md`).

- `protocol-objects.md §28`, Bodies, current:
  > - `opened`: `{ "attestations": [cid] }`

  Proposed:
  > - `opened`: `{ "attestations": [cid] }`. In an identity log, this is `seq` 0 and holds exactly the notary card's `genesis_attestation`.

- `notary_lifecycle.md` A.6 step 1, current (end of the step):
  > Walk the log to `seq` 0 as in N11; a gap or fork → `NOTARY_LINEAGE_INCOMPLETE`.

  Proposed:
  > Walk the log to `seq` 0 as in N11. Record `seq` 0 must be `opened` and name the card's `genesis_attestation`. A gap, a fork, or a missing or different `seq` 0 → `NOTARY_LINEAGE_INCOMPLETE`.

- `notary_replication_and_recovery.md` step 33, current:
  > The operator performs notary genesis again (`notary_lifecycle.md` Phase 0), and the identity log records it.

  Proposed (for any option):
  > The operator performs notary genesis again (`notary_lifecycle.md` Phase 0). That produces a new `K_id`, so it produces a new notary card with its own identity log. The old card's log ends, because no key that could extend it survives.

**Code if A is chosen:** the broker writes and anchors `seq` 0 after countersigning; E (TypeScript `exposure.ts` and its Rust twin, if any) adds the `seq` 0 check; new tests. This is about half a day, inside 5.5.

### 1.2 E33: should a `LogEntry` carry its intent payload?

**Problem.** A `LogEntry` (§3–§4) carries `intent_signature` but not the `UpdateIntentPayload` it signs. `target_card`, `updater_card` and `timestamp` aren't in the entry, so no reader can verify the holder's intent signature from the log alone. That affects **every card in the protocol**, not only notary list cards.

**What the notary does today, and why it is safe.** For list cards, the enclave checks:
- the press signature over the whole entry, against the pinned press key;
- the `prev_log_root` chain;
- that the intent **signer** is the pinned holder key.

Algorithm L's member signatures carry the list's trust, so an unverifiable intent signature doesn't weaken the notary.

**Privacy and security, from our earlier discussion:**
- Adding the payload would expose `updater_card`, the card that made the update, in a log that today hides it inside the press's records. For delegated or sub-card updates, that is new linkable information.
- `timestamp` reveals when the holder signed, which the chain's block time already approximates.
- The gain is end-to-end verification of holder intent by any reader, without trusting the press.

**Options.**
- **A (recommended): a separate, protocol-wide decision, not part of the notary work.** I would record it as an open protocol question. When you take it up, start with an **optional** field: a `LogEntry` may carry the fields needed to rebuild the payload, and readers verify the intent signature when they're present. This change touches the press, the wallet and the verifier for all cards, so it belongs in its own plan with its own privacy review. The notary keeps its current checks.
- **B: decide now and require it** in `LogEntry` v1. This is a breaking change to a shared object (CP6), outside notary scope.
- **C: never add it.** State in §3 that the intent signature is verified by the press at write time, and that readers rely on the press signature.

**Wording if A is chosen:** none in the specs now. I add an entry to the open questions in `plans/notary-questions-5.3.md` and leave the comment in `lists_read.rs`.

### 1.3 E16: the EAS schema types for notary anchors

**Problem.** §28 gives the schema as `{ job_hash, seq, record_cid }` without ABI types. The host and the governance script that registers the schema must agree.

**Recommended (as implemented):** `bytes32 job_hash, uint64 seq, string record_cid`.
- `job_hash` is the raw 32 digest bytes. For an identity log it is the notary card address, which is also 32 bytes, so one schema serves both logs.
- `seq` as `uint64` is ample.
- `record_cid` as the CID's text form is easy to read in EAS explorers. A binary CID (`bytes`) would save about 30 bytes of calldata per anchor, which costs little on Arbitrum.

**Alternative:** `bytes record_cid` (the binary CID). This is cheaper but harder to read, and the host would need to decode it. I don't recommend it.

The wording is in item 2.3 below. It is the same edit as E3.

---

## Group 2: wording for decided items

Each item gives the file and the current text, then the proposed text.

### 2.1 E1: Merkle root of the empty set

`protocol-objects.md §27`, `input_commitment` row, current:
> Merkle root over the sorted counted `input_hash` values. Leaf = `SHA-256(0x00 ‖ input_hash)`, node = `SHA-256(0x01 ‖ left ‖ right)`, and an odd node is promoted unchanged.

Proposed:
> Merkle root over the sorted counted `input_hash` values, sorted by their raw bytes. Leaf = `SHA-256(0x00 ‖ input_hash)`, node = `SHA-256(0x01 ‖ left ‖ right)`, and an odd node is promoted unchanged. The root of an empty list is `SHA-256("")` (the RFC 6962 convention).

("sorted by their raw bytes" records what the code does after the base64url sort bug was fixed. A base64url text sort gives a different order.)

### 2.2 E2: unknown fields on notary objects

`protocol-objects.md`, notary conventions, insert after the **Serialization** bullet:
> - **Unknown fields.** A reader rejects a notary object (§21–§34) that has a field its `type` version doesn't define. A new field means a new `type` version. Card documents, including the notary card (§20), follow the CardDocument rules instead.

### 2.3 E3 and E16: how anchors are found, and the schema types

`protocol-objects.md §28`, **Stored on**, current:
> **Stored on:** IPFS. Each record of an anchored kind is also anchored by an EAS attestation on Arbitrum One (ADR-008), with schema `{ job_hash, seq, record_cid }` and indexed by `job_hash`.

Proposed:
> **Stored on:** IPFS. Each record of an anchored kind is also anchored by an EAS attestation on Arbitrum One (ADR-008), with schema `bytes32 job_hash, uint64 seq, string record_cid`. `job_hash` is the record's `job_hash` field as its raw 32 bytes. For an identity log, that is the notary card address. EAS doesn't index attestation data, so readers find a log's anchors by filtering the schema's attestations on `job_hash`, either themselves or through an EAS indexer. A missing anchor shows up as a `seq` gap.

`notary_host.md` §9, **Anchoring**, current:
> For every record of an anchored kind, the host submits an EAS attestation `{ job_hash, seq, record_cid }` under the notary schema from the gas wallet, ...

Proposed: replace `{ job_hash, seq, record_cid }` with `(job_hash, seq, record_cid)` encoded as in `protocol-objects.md §28`. The rest is unchanged.

### 2.4 E10 and E13: attestation fields no caller can predict

`notary_lifecycle.md` A.1 step 10, current:
> 10. Each bound field equals the expected value, and each unused field is zero → `ATT_BINDING_MISMATCH`.

Proposed:
> 10. Each bound field equals the expected value, and each unused field is zero → `ATT_BINDING_MISMATCH`. Where a caller gives no expected value for a bound field (W13 for `inst_key_hash`; N6 for `inst_key_hash` and `public_key`), the field must be present, 32 bytes and non-zero, and isn't compared.

A.2 step 13, current:
> ...`public_key = SHA-256(job_public_key)`; `nonce = job_hash`; `t_eval = now`; ...

Proposed: after `public_key = SHA-256(job_public_key)`, insert `; `inst_key_hash` not compared (a wallet can't know a replica's instance key)`. The rest is unchanged.

A.4 step 6, current:
> 6. `attestation` passes **V**: purpose `0x02`; `job_hash`, `final_epoch` and `program_hash`; `id_key_hash = notary_card`; `t_eval = closes_at` (aggregate) or `closed_at` (per-input); no `max_age` → `ATT_*`.

Proposed:
> 6. `attestation` passes **V**: purpose `0x02`; `job_hash`, `final_epoch` and `program_hash`; `id_key_hash = notary_card`; `nonce = job_hash`; `public_key` and `inst_key_hash` not compared (the notarization doesn't carry the final epoch's job key or the instance key); `t_eval = closes_at` (aggregate) or `closed_at` (per-input); no `max_age` → `ATT_*`.

### 2.5 E11: `issuer_card` = this policy

`notary_lifecycle.md` A.2 step 10, current:
> ...has `policy_id = NotaryCardPolicy` and `issuer_card` = this policy, and its `platform` equals `notary.platform` → `JOB_NOTARY_NOT_APPROVED`.

Proposed:
> ...has `policy_id = NotaryCardPolicy` and `issuer_card` = this policy's card (the address derived from the `recipient_pubkey` of the job's `policy_id` document, as in A.7 R1), and its `platform` equals `notary.platform` → `JOB_NOTARY_NOT_APPROVED`.

### 2.6 E12 and E6: what list-approval members sign

`protocol-objects.md §34`, current:
> - **What is signed.** Each member signs `H(JCS(list_approval without "signatures"))` with their governance key, using the keyset's `key_scheme`: ECDSA secp256r1 (raw 64-byte `r‖s`) for scheme 0, ML-DSA-44 for scheme 1. ...

Proposed:
> - **What is signed.** Each member signs the 32 raw digest bytes of `H(JCS(list_approval without "signatures"))`, not their base64url text, with their governance key, using the keyset's `key_scheme`:
>   - scheme 0, ECDSA secp256r1 (raw 64-byte `r‖s`): the 32 bytes are the ECDSA message hash and aren't hashed again. That equals ECDSA-SHA256 over the canonical JSON, and it is what an HSM that signs a digest produces.
>   - scheme 1, ML-DSA-44: the 32 bytes are the message.
>
>   The governance script shows each member the change from the previous list before they sign. ...

(The final sentence answers the blind-signing risk noted with E12. The rest of the bullet is unchanged.)

### 2.7 E14: the `counted_inputs` format

`protocol-objects.md §27`, `counted_inputs` row, current:
> The sorted leaf list, so contributors can check inclusion

Proposed:
> The counted `input_hash` values, in the same order as for `input_commitment`, as an RFC 8785 JSON array of base64url strings, pinned with the `raw` codec. Contributors use it to check inclusion.

(Today's text says "leaf list", but the object holds `input_hash` values, not the leaf hashes. The proposed text says what the code does.)

### 2.8 E15: `expires_at` in Stage 4

`card_verifier.md` Stage 4 step 5a, current:
> ... Record it under `revocation` with `reason: "expired"`. It enters steps 6–7 like an 8xx `effective_date`. If an 8xx or 9xx is also present, the earlier date governs.

Proposed:
> ... **Only once `expires_at` has passed**, record it under `revocation` (`status: "revoked"`, `code: null`, `reason: "expired"`), and it enters steps 6–7 like an 8xx `effective_date`. A future `expires_at` changes nothing. If an 8xx or 9xx is also present, the earlier date governs.

### 2.9 E17: the notary card names its genesis request

`protocol-objects.md §20`:
- Add a table row after `genesis_attestation`:
  > | `genesis_request` | `cid` | Yes | immutable | The genesis request below, pinned with the `raw` codec. Later verifiers fetch it to recompute the genesis attestation's nonce (`notary_lifecycle.md` A.3). |
- Add `"genesis_request": "<cid — the pinned genesis request>",` to the JSON example, in sorted order after `genesis_attestation`.
- In the **Genesis request** paragraph, add: "The enclave pins it (`notary_runtime.md §9`, `genesis_ready`), and the notary card names it in `genesis_request`."
- In the storage table, change the `Genesis request` row:
  - current: `| Genesis request | In transit (operator → policy holder) | Not signed; ... |`
  - proposed: `| Genesis request | IPFS (`raw`), named by the notary card's `genesis_request` | Not signed; `H(genesis request)` is the genesis attestation's nonce |`

`notary_lifecycle.md` step 5, the list of offer fields, current:
> - the fields `operator_card`, `operator_host_pubkey`, `chain_pubkey`, `platform` and `genesis_attestation`.

Proposed:
> - the fields `operator_card`, `operator_host_pubkey`, `chain_pubkey`, `platform`, `genesis_attestation` and `genesis_request` (the CID of the pinned request).

A.3, insert before step 1:
> 0. **Later verifiers only.** Fetch the request at the card's `genesis_request` and check it against its CID. It must equal the card's `id_pubkey` (= `recipient_pubkey`), `chain_pubkey`, `operator_card`, `operator_host_pubkey` and `platform`, and its `policy_id` must be the card's `issuer_card` policy → `NOT_GENESIS_MISMATCH`. `H(genesis request)` in step 1 is that request's hash. (The policy holder already holds the request.)

`card_verifier.md` step 3a, first bullet, current:
> - Run algorithm G (`notary_lifecycle.md` Appendix A.3) on the notary card's `genesis_attestation`, with `t_eval` = the notary card's `issued_at`. ...

Proposed:
> - Run algorithm G (`notary_lifecycle.md` Appendix A.3, including step 0) on the notary card's `genesis_attestation` and `genesis_request`, with `t_eval` = the notary card's `issued_at`. ...

### 2.10 E18: host configuration and errors

`notary_host.md` configuration table:
- Change the `NOTARY_HOST_MLDSA44_PRIVATE_KEY` description to:
  > `K_host`, for host receipts, as a 32-byte ML-DSA-44 seed (base64url). Its public key must equal `operator_host_pubkey` on each notary card.
- Add these rows after `ENCLAVE_CIDS`:
  > | `ENCLAVE_ENDPOINTS` | Yes | How to reach each `ENCLAVE_CIDS` entry, in the same order: the vsock proxy address in production, a local socket in the simulator |
  > | `NOTARY_ADMIN_TOKEN` | Yes | Bearer token for the operator-authenticated routes (§5). Compared in constant time. |
  > | `NOTARY_RELAY_TARGET_ID` | Yes | The `target_id` registered with the relay, put in announcement `transport` hints |
  > | `NOTARY_PUBLIC_BASE_URL` | Yes | This host's public URL, put in announcement `transport` hints |

Routes table, the `/genesis` and `/genesis/countersign` rows: replace "Direct, operator-authenticated" with "Direct, `NOTARY_ADMIN_TOKEN`".

§14 error codes, add:
> | `NH_UNAUTHORIZED` | An operator-authenticated route was called without a valid token (HTTP 401) |

---

## Group 3: decided but never written into the spec

I found these while collecting text. Both were decided before 5.3 (`notary-questions-phase-5.md`), and the code implements them, but the spec text was never changed.

### 3.1 E6: what cosignatures sign

`protocol-objects.md §27`, **Serialized for signing**, current:
> Each cosignature is over `H(body)`.

Proposed:
> Each cosignature is over the 32 raw digest bytes of `H(body)`, not their base64url text.

The §34 half of E6 is in item 2.6.

### 3.2 E7: receipt sealing nonce and aad

`protocol-objects.md` §24, **Response** bullet, current:
> ... encrypted with ChaCha20-Poly1305 under `Export("card-notary-receipt-v1", 32)` from the **inner** HPKE context, so the host can't read it.

Proposed:
> ... encrypted with ChaCha20-Poly1305 under `Export("card-notary-receipt-v1", 32)` from the **inner** HPKE context, so the host can't read it. The nonce is 12 zero bytes, which is safe because the key is used once per HPKE context. The aad is the RFC 8785 JSON of `{ "input_hash", "job_hash", "type": "notary.validation_receipt.sealed.v1" }`.

---

## Group 4: E27, a test run rather than a decision

The worker sandbox (seccomp, `no_new_privs`, rlimits) is verified on Linux arm64, which is Graviton, the production target. x86_64 has only been run under Docker's emulation on Apple Silicon, and that can't host seccomp filters. It needs one run on native x86_64 Linux, in CI or in Phase 8. It isn't claimed as verified, and no spec text changes.

---

## Your answers

| Item | Recommendation |
|---|---|
| E26 | A: `opened` at `seq` 0, checked by E; step 33 fixed either way |
| E33 | A: a separate protocol-wide decision, optional field first; no spec change now |
| E16 | `bytes32, uint64, string`, as implemented |
| Group 2 (E1, E2, E3, E10–E15, E17, E18) | Approve as written |
| Group 3 (E6, E7) | Approve as written |
