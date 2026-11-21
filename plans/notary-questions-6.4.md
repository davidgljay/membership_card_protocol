# Digital Notaries — Step 6.4 (Derived-Card Template): Decisions and Questions for David

**Date:** 2026-11-16 · **Branch:** `notary` · Specs amended "Amended 2026-11-15 (6.4), for David's review": `notary_runtime.md`, `derived_card_revocation_propagation.md`, `notary_host.md`, `protocol-objects.md`. Items marked **[security]** change what an untrusted host or holder can do. Reply "OK to all" or answer by number.

| # | Topic | Kind |
|---|---|---|
| D1 | The `derive` output check (D4) compares the output with the projected values | **[security]** spec gap |
| D2 | `projected_fields` can never name a protocol field | **[security]** |
| D3 | Derived-card jobs run one replica and `expiry_only` until 6.5 | scope |
| D4 | The template key is seeded by an explicit operator action, once | **[security]** spec gap |
| D5 | A stale offer is replaced when the holder resubmits the same signed input; the header stays pinned | spec gap |
| D6 | Countersign and offer failure codes | interface |
| D7 | `dup_tag` encodings: CID bytes, ratchet info, the key's period | spec ambiguity |
| D8 | Release needs the protocol version and the press sequence from the host; failed registrations are re-signed | **[security]** spec gap |
| D9 | Template-scope handoff check P3 (`serves_template`) is not implemented | gap |
| D10 | Observations outside 6.4 (verifier Stage 5, notary card ancestry) | report |
| D11 | What "standard verification" covered | scope (Q11) |

---

### D1. The `derive` output check (D4) compares the output with the projected values **[security]**

- **Facts.** Spec §11 says output must match `output_schema`, whose v1 types are `integer`, `boolean` and `text` with a fixed `enum`. A derived card's `projected` holds arbitrary source values, so no enum can describe it.
- **Code.** The template's `output_schema` is `[]`. The broker builds the program's input from the verified source card (only the requested fields, scalars only) and accepts the output only if it equals that object exactly (`derive.rs::check_projection`). A faulty or hostile `derive` program can therefore not add, drop or alter a value.
- **Recommendation.** Keep. Amended in runtime §11 and propagation §3.

### D2. `projected_fields` can never name a protocol field **[security]**

- **Facts.** Anyone may open a derived-card job (D9) and names the fields. `recipient_pubkey`, signatures, `past_keys`, `active_subcards` would hand the holder's key to every verifier.
- **Code.** `create_job` refuses the reserved names (`derive.rs::RESERVED_FIELDS`) with `JOB_PARAMETERS_OUT_OF_BOUNDS`; the anonymity-set rule would also hold back a unique value, but this stops it at the door. It does not read the source policy's `field_definitions`, so a policy-defined field that is unique per holder (an employee number) is held back only by the anonymity set.
- **Recommendation.** Keep. If you want the declared-field check as well, the enclave must fetch the source policy document.

### D3. One replica and `expiry_only` until 6.5

- **Facts.** The pool and the tag history are state a second identity holder must share; the spec puts them in the state blob (6.5). `sealed_link` is 6.5.
- **Code.** `create_job` answers `NH_UNSUPPORTED` for N > 1 and for `sealed_link`; an epoch restart of a derived-card job answers `NH_UNSUPPORTED` too. A host restart of the enclave loses the pool and tag history until 6.5 (spec §8 step 33 says the same for total loss).
- **Recommendation.** Keep for 6.4.

### D4. The template key is seeded by an explicit operator action, once **[security]**

- **Facts.** Spec: the first enclave serving `T` seeds `k_T`; the others get it by handoff. Nothing says how the first one knows it is first. An automatic seed would let a host that withholds the handoff give its operator its own chain, and so a second card per person per period.
- **Code.** New host message `seed_template` and route `POST /operator/template-seed`; the enclave refuses if it holds a key (`TEMPLATE_KEY_EXISTS`). A derived-card job needs the key (`TEMPLATE_KEY_MISSING`). If two clean enclaves each seed, the lower SHA-256 wins at the next handoff (both brought to the same period first). Re-seeding after exposure is automatic, by the enclave on a clean runtime, on the next tick.
- **Limit (unchanged from spec L11).** An operator can still seed separately and issue its own duplicates until the chains meet; a verifier comparing `dup_tag`s sees equal tags only for equal chains.
- **Recommendation.** Keep.

### D5. A stale offer is replaced when the holder resubmits the same signed input

- **Facts.** §3 step 8 says the enclave "issues a fresh offer with the next boundary" but no message carries it to the wallet; receipts answer only submissions.
- **Code.** A resubmission with the same signed input (the same digest, re-sealed to any epoch) returns the current offer, or a new one for the next boundary if the old one's boundary passed; the wallet countersigns again. Headers named by waiting cards are pinned until the period ends (R3 again), so the same input stays valid. D2 stays strict (a derived key appears in one signed input only). The wallet side (`derived.ts`) is not built; a wallet must poll by resubmitting.
- **Recommendation.** Keep, and specify the polling in the wallet SDK when it is built.

### D6. Codes

New receipt `reject_reason`s for countersign: `DERIVE_OFFER_UNKNOWN`, `DERIVE_OFFER_STALE` (boundary passed or already replaced), `DERIVE_COUNTERSIGN_INVALID` (not the derived key's signature over the offer plus `D`). A source card that is of another policy, or lacks a projected field, is `INPUT_NOT_ELIGIBLE`. `max_inputs` (B11) bounds the tags held in open periods. A job ending has no log record (the spec has none).

### D7. `dup_tag` encodings

- `source_policy` is the policy CID's UTF-8 bytes (the press writes registry CIDs that way: `TextEncoder().encode(cid)`); the spec says "CID bytes".
- The ratchet `info` is the label followed by `p` as 8 bytes big-endian; no salt.
- The template handoff payload now carries the key's `period` (a key without its period can't be ratcheted).
- Vector: `notary/vectors/dup_tag/cases.json`, written by Rust, reproduced by `vectors-tools`.
- **Recommendation.** Confirm before any other implementation computes tags.

### D8. Release inputs from the host, and re-signing **[security]**

- **Facts.** A `RegisterCard` payload needs `sequence` (`next_sequence`) and cards need `protocol_version`; the enclave cannot read the chain.
- **Code.** Read through `fetch press_auth:` and `fetch protocol_version`, untrusted: a wrong value only makes a registration fail or a card unverifiable (denial of service). If either read fails, nothing is released at that boundary. A failed `chain_result` is signed again with a fresh sequence, three tries, then an alert. The host cannot change what is registered: the calldata is bound by the write gate (6.4a), and the test registry enforces that.
- **Recommendation.** Keep.

### D9. `serves_template` is not implemented

P3 for template-scope handoff says the peer's card "has `issuer_card == T`", which cannot hold for a notary card (its issuer is the notary policy holder). The default still fails closed, so a handoff is refused in production until this is settled. I suggest: the card is in `T.approved_notaries` and has an `AuthorizePress(T, card)` entry. Needed before any real template handoff; tests use an oracle that answers.

### D10. Observations outside 6.4 (reported, not fixed, CP10)

- **Verifier Stage 5** reads `field_definitions` as an object keyed by field name; the spec and every template policy use an array, so a policy in the specified form fails every required field ("0", "1", ...). The 6.4 test policy document uses the object form for that reason.
- **Verifier stages** reach Stage 5 only for sub-card signers; a card signed by its own primary card key (a derived card) gets Stages 3, 4 and 6 through `verifyCard` and Stage 5 only by calling it directly.
- **Notary card ancestry.** A stage-3 walk goes derived card, notary card, then the notary card's own `ancestry_pubkeys`; the spec's `[K_id, T]` list is read only from the derived card. The test notary card lists `T` so the walk ends there.

### D11. What "standard verification" covered (Q11)

The TypeScript verifier's Stages 3, 4 and 6 (`CardVerifier.verifyCard`) and Stage 5 (called directly, with `verifyNotaryIssuedCard` as its step 3a hook) ran over the **simulated chain**, with the `AuthorizePress` entry created by the simulated registry in test setup and its write gate enforcing the step 8 binding. The cards were issued by the real broker in `notary-broker/tests/derive.rs` and replayed from `notary/vectors/derived/issued.json`; **no real-process end-to-end run with a derive job (host, runtime process) was built**, and `CardVerifier` is not wired to step 3a, nor is a real `AuthorizePress` used: both stay in 7.1.

---

## Answers

- **2026-11-19, David:** the security recommendations are approved: **D1** (the output equals the projected values), **D2** (protocol fields refused; a unique policy field held back only by the anonymity set), **D4** (the template key is seeded once by an explicit operator action), **D8** (protocol version and press sequence are untrusted host reads; re-signing up to three times).
- **2026-11-19, David:** the interface items are approved: **D5** (a stale offer is replaced on resubmission; wallet polling to be specified with the wallet SDK), **D6** (the countersign codes), **D7** (the `dup_tag` encodings as written and in `vectors/dup_tag/cases.json`).
- Still open: D3 (scope), D9 (what P3 checks for a template-scope handoff), D10 (report), D11 (scope).
