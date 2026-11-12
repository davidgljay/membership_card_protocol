# Digital Notaries — Spec Impact Scan (Phase 1)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Strategic plan: [notary-strategic-plan.md](notary-strategic-plan.md)

Produced by Phase 1 (steps 1.1–1.6). Nothing in `specs/`, `governance/` or code is edited in this phase. This document lists what must change or be created in Phases 2–3 and why. Terminology: "AWS Nitro Enclaves" / "the enclave" for the TEE, "nitropack" for the web framework.

## §0 Headline findings

These are the places where the scan found that a strategic-plan statement does not match the repo as it stands. None invalidates a decision, but each needs an explicit answer in Phase 2 (all are listed again in §F).

1. **"Governance-signed protocol artifacts (ADR-011)" does not exist.** ADR-011 only defines on-chain tables (`PolicyAuthorizerKeys`, `PressAuthorizations`) and quorum-signed contract operations. There is no generic "signed, logged list" mechanism. The PCR0 list and program allowlist need one (§D).
2. **Notary authorization on-chain is not free.** The write gate keys everything on `(policy_address, press_address)` in `PressAuthorizations`, and `AuthorizePress` needs a 4-of-5 `PressRegistryBody` quorum after a 14-day deliberation. Reusing it as-is makes every new community's notary operators a governance event, which conflicts with G3 ("lightweight activation") (§B).
3. **Notarization log entries don't fit `LogEntry` as written.** A `LogEntry` reposts the card's whole `card_state` on every entry, all updates must go through an approved press, and codes 1xx–7xx carry `field_updates`. An append-only list of notarizations or handoffs on the notary sub-card would grow quadratically and has no existing update code (§A).
4. **Existing HPKE is X25519-only, not hybrid.** `press/src/ohttp-gateway.ts` and the wallet use `DhkemX25519HkdfSha256`. The plan's "ML-KEM-768 + X25519" is exactly **X-Wing**, available as `@hpke/hybridkem-x-wing` (JS) and the `hpke` crate's `mlkem` feature (Rust), but both implement **draft-06** of the X-Wing draft, which is not final (§E).
5. **Existing specs use bare "Nitro"** for the web framework (`press.md §3.1`, `OPERATOR.md`, ADR text). The plan's terminology rule applies to new text; Phase 3 should add a one-line terminology note rather than rewrite old specs (§F).
6. **Key custody of the notary sub-card is unspecified.** A sub-card is issued by the administrator and countersigned by the operator before any enclave exists, yet the enclave must sign notarizations and (for derived cards) `issuer_signature` / `press_signature` over `CardDocument`s, and something must hold a secp256r1 key for on-chain writes (§B).

## §A Objects and policy

Sources read: `protocol-objects.md` conventions, §1, §1.1, §2, §3, §6, §11, §14–16, Object Relationship Summary, Serialization Quick Reference; `card_protocol_spec.md` §The Press Model, §1 (policy fields, press authorization, policy creation flow).

### A.1 Existing objects to change

| Object / section | Change | Reason |
|---|---|---|
| `protocol-objects.md §2` PolicyCardDocument — field table and JSON example | Add `approved_notaries` (`card-pointer-array`) and the `notary` section (`program_cid`, `mode`, `input_schema`, `contributor_predicate`, `requester_predicate`, `parameter_bounds`, `output_schema`, `output_action`, `output_recipients`, `retention`, `platform`, `isolation`, `revocation_propagation`, privacy params). Policy cards with a `notary` section must still carry `field_definitions` (required today) | Notary policy is a `PolicyCardDocument` (strategic plan) |
| `card_protocol_spec.md §1` protocol-defined field table (line ~305) and default update policies | Add `approved_notaries` (default `{ "is_holder": true }`, like `approved_presses`) and `notary` (default `{ "is_issuer": true }` — a parameter change must not be silent) | The table is the list "all verifiers know to look for" |
| `card_protocol_spec.md §1` "Press authorization" paragraph | Add the parallel "Notary authorization" paragraph (notary sub-card issued by the policy holder, countersigned by the operator) | Same mechanism as press sub-card |
| `protocol-objects.md §2` — `requester_predicate` | Name clash to resolve: the policy already has top-level `requester_predicate` (who may ask the *press* to issue). `notary.requester_predicate` (who may open a *job*) must be named differently or scoped, e.g. `notary.job_requester_predicate` | Avoid two fields with different meanings sharing a name |
| `protocol-objects.md §3` LogEntry | Decide how a notarization / handoff / sealed-link anchor appears (see A.3) | Problem 3 in §0 |
| `protocol-objects.md §6` OpenCardOffer | Read-only reference. The job announcement copies its shape (signed, hosted, shared as link) but is a **new** object, not an `OpenCardOffer` variant: it has no `proposed_fields`, `max_acceptances` semantics differ (k-threshold vs. claims) | `OpenCardOffer` is bound to press issuance and `OpenOfferUseCounts` |
| `protocol-objects.md §11` PressIssuanceRecord | Derived-card issuance must decide whether the notary sends `PressIssuanceRecord`s to auditors. Doing so records `recipient_pubkey` of every derived card alongside `issuer_card` (the notary) at issuance time, which is the exact linkage the derived-card design avoids only if the *source* is absent. It is absent (record names only the derived card), so this is acceptable; but `issued_at` timing is a timing-linkage channel (see §F) | Reuse vs. new record |
| `protocol-objects.md §14` CardEntry / `registry_contract.md §3.1` | No struct change if notary reuses `policy_address` + `last_press_address`; see §B for the authorization options | Depends on 2.2 |
| `protocol-objects.md §15–16` sub-cards | Notary sub-card is a sub-card **of the policy card** (like the press sub-card). Check against `SubCardDocument`: that object is app-sub-card shaped (`app_card`, `capabilities`, `attestation_level`). Press sub-cards in practice are plain `CardDocument`s issued to the operator, not `SubCardDocument`s (`press.md §2`: "press card … issued externally"). The plan's "sub-card" wording means the press-card pattern, not §16 | Avoid building against the wrong object |
| `protocol-objects.md` Object Relationship Summary and Serialization Quick Reference | Add rows for each new object | Plan 3.2 |
| `protocol-objects.md` Common Sub-Objects | Notary objects signed by an enclave key need a new signature carrier (the `SignatureEntry` assumes ML-DSA-44 + `keccak256(public_key)` address; an enclave key may be ML-DSA-44 too but has no registry address). Decide in 2.1 | `SignatureEntry` semantics |

### A.2 New objects (all to be given field tables in 2.1)

| New object | Home (proposed) | Notes from the scan |
|---|---|---|
| `notary` policy section | `protocol-objects.md §2` | as above |
| NotaryJob | new numbered section | signed by requester card; `job_hash` is the attestation nonce; carries `policy_id`, parameters, `closes_at`, replica set, `min_live`, mode, epoch |
| Job announcement | new section | signed and hosted like `OpenCardOffer`, but **hosting has no home today** — `wallet.md` OQ-WALLET-6 records that open-offer hosting is not implemented anywhere. Notary announcements inherit that gap; the notary host (nitropack) is a candidate owner |
| NotaryInput | new section | contributor sub-card signs `{job_hash, payload}`, HPKE-sealed to the job key; reuse the oblivious-transport envelope shape (`path`/`method`/`body`) |
| Host receipt, enclave validation receipt | new sections | host receipt = signature over ciphertext hash; enclave receipt = signed per accepted input |
| Notarization | new section | the strategic plan's `{job, policy_id, notary_card, program_cid, attestation, chain_state_root, input_commitment, accepted, rejected, output, enclave_signature}` |
| Public notarization log entry | via `LogEntry` — see A.3 | |
| HandoffRecord, Heartbeat | new sections | Heartbeat stays off-chain; handoff must be logged |
| State-blob anchor | new section | needs an on-chain or log anchor with rollback protection — see §B.3 |
| Propagation batch | new section | `sealed_link` revocation release |

### A.3 Log entries for notarizations (finding 3)

Facts from `protocol-objects.md §3`:

- every `LogEntry` has `card_state`, the complete current field state, and a `history` array of all prior CIDs;
- all updates go through an approved press (`card_protocol_spec.md §5`: "Not: special direct-write paths");
- 1xx–7xx entries carry `field_updates` and are checked against the field's `update_policy`.

Consequences for "notarizations are log entries on the notary sub-card's log":

| Option | Consequence |
|---|---|
| (a) Notarizations as an `append-only-array` field on the notary card | Every entry reposts the whole array in `card_state`: O(n²) bytes over the card's life. Unworkable for votes at scale |
| (b) Notarization hash stored only in the entry (a new code, e.g. 4xx "neutral context", with the notarization CID in `updater_message` or a new `annotation` field) | No growth in `card_state`; needs a new code in `update_codes.md` and a small `LogEntry` field addition, which is a **CP6** event only if the change breaks existing tests (an optional new field should not) |
| (c) Use EAS (ADR-008) instead of the card log | EAS is already "optional per policy"; making it the primary record avoids the `LogEntry` problem but moves the public record off the card log the strategic plan names |
| (d) One notary-job card per job with its own short log | Clean, but a registry write per job and a new card type |

Also: the notary cannot write a log entry "directly". Either the notary operator's host submits an intent to an ordinary approved press (the enclave signing `intent_signature`), or the notary sub-card is itself an approved press for its own log. Phase 2 must choose.

### A.4 What a derived card is (`CardDocument` requirements)

A `CardDocument` needs `issuer_card` + `issuer_signature`, `holder_signature`, `press_card` + `press_signature`, `ancestry_pubkeys`, `policy_id`. For a derived card the notary is the vouching party, so it plausibly fills both the **issuer** and the **press** roles, signing both signatures with an enclave-held ML-DSA-44 key. That means:

- the notary sub-card's `recipient_pubkey` (what `ancestry_pubkeys` and the content-key derivation use) must be a key the **enclave** holds, not the operator;
- the derived card's `policy_id` points at a policy whose `field_definitions` describe the projected card — the strategic plan's `output_schema` is a program-output schema, not a policy. Simplest consistent reading: **one** `PolicyCardDocument` carries both `field_definitions` (the derived card's shape) and the `notary` section. Phase 2 must state this, and `notary.output_policy_id` is not needed under it;
- `recipient_predicate` / `requester_predicate` on the same policy then govern the derived card's *recipient*, which is the source-card holder — the same collision as A.1.

### A.5 Gaps to feed Phase 2

- No `notary.output_schema` ↔ `field_definitions` mapping is defined (A.4).
- `valid_until` on derived cards is a policy-level field today (`PolicyCardDocument.valid_until` is when the **press stops issuing**, not a card expiry). Short per-card expiry needs a `field_definitions` entry (a `timestamp` field) or a new card field. State which.
- Code 301 "Valid-until refresh" exists (`update_codes.md`), usable for renewal if `valid_until` is a card field. Confirm it applies.

## §B Press and on-chain authorization

Sources read: `press.md §1–3, §5.1`, `registry_contract.md §3.1, §3.3, §6.1`, ADR-005, ADR-011, ADR-012, `contracts/logic-contract/src/write_gate.rs`, `card_ops.rs`, `governance_ops.rs` (function inventory), `subcard_ops.rs`.

### B.1 What must be authorized

| Need | Today's mechanism |
|---|---|
| (a) Notary writes log entries (notarization records) | A press signs a secp256r1 payload; contract checks `PressAuthorizations[policy][press]`, active, signature (RIP-7212), `op`, `sequence`; `UpdateCardHead` also checks `prev_log_cid` |
| (b) Notary registers derived cards (`RegisterCard`) and revokes them (`UpdateCardHead` with an 8xx/9xx entry) | Same gate, keyed by the derived card's `policy_address` |

A notary needs **two** on-chain keys-worth of identity: ML-DSA-44 (IPFS identity, signs card documents) and secp256r1 (on-chain write key) plus a gas wallet (`press.md §2`). All three must live **inside the enclave** for the derived-card trust claim to hold. A secp256r1 key held by the operator's host would let the host write any card head under the derived policy (the write gate checks signature and sequence only; see the known gap below). Keys inside the enclave raise a question for AWS Nitro Enclaves, which have no network: gas must be paid by the host's wallet (as the press already separates signing from `PRESS_GAS_WALLET_PRIVATE_KEY`), and the enclave signs payloads the host submits. Persistence of the enclave's identity keys across restarts needs the same sealed-state and replica-handoff story as job keys; otherwise each restart changes the notary's on-chain address.

### B.2 Authorization options (not decided here)

| Option | How | Contract change? | Consequences |
|---|---|---|---|
| **1. Reuse `PressAuthorizations`** | Register each notary operator's key via `AuthorizePress(policy, notary_address, …)`; `approved_notaries` is an audit-surface twin of `approved_presses` | **None** | Works today. Authorization needs a `PressRegistryBody` 4-of-5 quorum, 14-day deliberation (7 emergency). Every community × operator pairing is a governance act. Verifier Stage 5 already accepts such a "press". Notaries are indistinguishable from presses on-chain: a notary could be used to issue ordinary cards under the policy, and a press could write notary-shaped entries. `press-rules.md` (which assumes policy-compliance duties) would need a notary section |
| **2. Reuse with a role flag** | Add `role: uint8` (press / notary) to `PressAuthEntry`; write gate checks the role against the operation (notary: only `RegisterCard` / `UpdateCardHead` on derived cards and its own log; press: all) | **Yes** — storage layout (`storage-contract` is immutable-address and has a layout), `AuthorizePress` signature, `get_press_authorization` tuple (7 fields, destructured in `write_gate.rs`), upgrade via `UpgradeLogic` 7-day timelock plus storage contract change | Restricts blast radius; still governance-gated; touches the immutable storage contract, which is the expensive change |
| **3. New `NotaryAuthorizations` table** | New table, new `AuthorizeNotary` / `RevokeNotary` ops, new write path in `card_ops` | **Yes** — storage + logic | Allows a different authorizer (e.g., policy authorizer key from `PolicyAuthorizerKeys`, no body quorum) → lightweight (G3). Loses the ethics review the press path provides |
| **4. No on-chain notary at all for log entries** | Notary log entries go through an ordinary approved press; only derived-card registration needs a press | None for logs | A press must be willing to post notary-intent entries; couples notary availability to press availability |

All options that touch `contracts/` are **CP7** (needs David's approval before any change).

### B.3 State-blob anchoring (sealed_link)

"Anchored on-chain" has no existing home: `CardEntry` stores only `log_head_cid`. Options: (i) anchor the blob hash as the head of a dedicated "notary-state" card (reuses `UpdateCardHead`, rollback-resistant because `prev_log_cid` must match and heads are monotonic; costs one write per anchor and one card per notary); (ii) a new contract field (**CP7**). Option (i) avoids contract changes but needs the same enclave-held write key as above.

### B.4 Known gap that matters here

`registry_contract.md §6.1` records that the write gate does **not** bind the signed payload to the written calldata (card address, CIDs). With the on-chain key inside the enclave this is tolerable, but anyone who can submit to the gate under the notary's `(policy, address)` with a captured valid signature and the current `next_sequence` could write other content. The one-sequence-counter-per-pair design also serializes all of one notary's writes across jobs and replicas; three replicas writing concurrently under one `(policy, address)` will collide on `SEQUENCE_MISMATCH`. Phase 2 should decide whether each replica/enclave has its own on-chain address.

### B.5 Contract functions affected (by option)

| Option | Functions |
|---|---|
| 1 | none (`authorize_press`, `revoke_press`, `run_write_gate` unchanged) |
| 2 | `authorize_press`, `revoke_press`, `run_write_gate`, `validate_write_gate_only`, `register_card`, `update_card_head`, `batch_update_card_heads`, storage-contract `get_press_authorization` |
| 3 | new `authorize_notary` / `revoke_notary`, gate variant, `register_card`, `update_card_head`, storage-contract layout, `verifier-module` unaffected |

**Answer to "is a contract change unavoidable":** no. Option 1 or 4 works with none; options 2–3 buy tighter scoping or lighter governance at the cost of a contract change.

## §C Wallet, verifier, transport

Sources read: `wallet_sdk.md`, `wallet.md`, `card_verifier.md`, `oblivious_transport.md`, `open_offer_creation.md`, acceptance and validation specs (headings plus the sections quoted), `press.md §5.1`.

| Addition | Spec and section to edit | Notes |
|---|---|---|
| Attestation verification (cert chain, debug flag, PCR0 in accepted list, `program_hash`, nonce = job hash) | `wallet_sdk.md` — new §7b "Notaries (wallet side)", module `notary/`; `card_verifier.md` §6 — new entry point | Wallet-owned per the "No independently re-derived trust logic" rule? The attestation verifier is **not** card-chain logic, so it need not go through `CardVerifier`; but notarization verification (below) does. State this boundary |
| Platform-pluggable verifier modules (simulator, AWS Nitro Enclaves) | `wallet_sdk.md` §4 provider interfaces (or a new `AttestationVerifier` interface) | Matches G5 "one verifier module per attestation format" |
| Consent screen built from policy only | `wallet_sdk.md` §6.2 "Consent Assembly" is the sub-card precedent; add a notary variant. `wallet.md` untouched | Test: requester text shown only as labelled requester text |
| Accepted-runtime list and program allowlist distribution to wallets | `wallet_sdk.md` config; see §D | |
| HPKE input submission over oblivious transport | `oblivious_transport.md`: add the notary host as a third destination kind (its key config, gateway, relay `target_id`); extend §Scope table with the notary endpoints (submit input, fetch announcement); `relay.md` target registry | **The existing envelope is for HTTP-shaped requests dispatched to route handlers.** Notary input is a sealed payload to an enclave key, not to the host's gateway key. Needs a double envelope: outer OHTTP to the host (hides IP), inner HPKE to the job key (hides content from the host). New text, not a reuse |
| HPKE KEM | `oblivious_transport.md` §Envelope Format, `wallet_sdk.md` crypto | Existing suite is `DhkemX25519HkdfSha256`; inner envelope needs X-Wing (§E). Key-config JSON needs a hybrid `kemId` |
| Receipt storage and inclusion check | `wallet_sdk.md` §7b; `card_verifier.md` new helper | Merkle inclusion against `input_commitment` |
| Automatic resubmission after a new epoch | `wallet_sdk.md` §7b; implies wallets persist their submitted inputs (storage provider) and watch job announcements | |
| Notarization verification | `card_verifier.md` §6.5 (new) plus §8 result types and §9 error codes; `card_validation.md` new Stage or companion process | Inputs: CIDs and chain data only (G1 objective). Checks: enclave signature, attestation (historical — PCR0 list as of `closes_at`), notary in `approved_notaries`/on-chain, `input_commitment` consistency |
| Derived-card verification | `card_verifier.md` Stage 5 (§7.5) and `card_validation.md` Stage 5 steps 24–25 | Stage 5 consults `PressAuthorizations` — satisfied only under B-option 1 (or an extended check under 2–3). Chain walk: derived card → notary sub-card → notary policy → root; the **source card is not in the chain** (by design). `ancestry_pubkeys` for the derived card must follow the notary chain |
| Sealed-link disclosure in wallet | `wallet_sdk.md` §7b consent model | Policy field `revocation_propagation` drives a disclosure line |
| Job announcement hosting and discovery | `wallet.md` / new host; OQ-WALLET-6 | No existing endpoint to extend (§A.2) |
| Derived-card acceptance | `wallet_sdk.md` §7.2–7.5 (countersigning) | Reuse countersign + "persist before sign": the holder generates a fresh key for the derived card. Issuance is notary-initiated in response to a presented source card, so §7.5 targeted acceptance is the closest path; confirm ordering (holder countersigns **before** the notary press-signs) |
| Error codes and result union | `wallet_sdk.md` §11 convention | New codes |
| Press: no change | `press.md` — cross-reference only | Per decision "press unchanged in v1" |

## §D Governance, updates and logs

Sources read: `governance/README.md`, `RootPolicyBody`, `PressRegistryBody`, `AppCertificationBody` mandates, ADR-011, `update_codes.md`, `card_updates.md` (events), `log_auditing.md`, `protocol-versioning.md`, `registry_contract.md §7` events.

### D.1 Who could own the PCR0 list and program allowlist

| Candidate | Fit | Concerns |
|---|---|---|
| `PressRegistryBody` (4-of-5; presses and conduct) | Notary operators are press-like operators; it already runs conduct rules and enforcement | Mandate is operator conduct, not software audit; list changes are frequent (every runtime release) against a 14-day minimum deliberation |
| `AppCertificationBody` | Already certifies **software** (wallets, apps, login services) through branch cards; accountability via auditor listing; no on-chain power needed | Mandate is certifying applications that hold sub-cards; runtimes and WASM programs are a third category. Its mandate amendment pattern (login services, 2026-11-08) is the exact precedent |
| `RootPolicyBody` | Only body with protocol-wide authority | Overloaded; two-body split is deliberate |
| New body | Clean ownership | Heavy; contradicts the existing three-body structure |

Scan view (not a decision): `AppCertificationBody` third mandate is the lightest fit for the allowlist and the PCR0 list (software certification, no new on-chain power), with `PressRegistryBody` retaining operator-conduct enforcement. 2.2 decides.

### D.2 How a governance artifact is published today

- On-chain governance operations are quorum-signed payloads with a keyset version and nonce (`registry_contract.md §6.2`). The only governance-set **value** is `SetProtocolVersion` (§4.25), the precedent for "governance writes a small value on-chain". A PCR0 list could be an on-chain table written by a similar op (**CP7**), at a cost per update.
- Off-chain, bodies publish documents in the repo (`press-rules.md`) with decision records and public summaries. These are not machine-signed.
- Cards give a signed, logged, versioned object for free: a "runtime list" **card** held by a body, whose log (code 3xx, `field_updates`) is the history and whose head CID the registry records. This reuses code and verifier paths, adds no contract change, and wallets resolve it by registry address. Cost: `LogEntry` `card_state` reposts the whole list per update (small for PCR0s).
- `AppCertificationBody` already uses card-based trust (branch cards under a root).

**Recommended shape for 2.2 to evaluate:** (i) list = governance-held card(s) with 3xx updates, wallet and runtime config pin the card address; (ii) historical acceptance — notarization verification must evaluate "was this PCR0 accepted when the job ran?", which the card log supports via `history`; (iii) revocation of a PCR0 = a log update, with effective date.

### D.3 Update codes

| Use | Code | Status |
|---|---|---|
| Derived-card revocation propagation | 8xx/9xx entries on the derived card, posted by the notary under `revocation_permissions` | Existing (§`update_codes.md` 8xx/9xx; policy field `revocation_permissions` defaults: 8xx holder-or-issuer, 9xx issuer-only). The notary must be the "issuer" for the derived card (it is `issuer_card`), which is why A.4 has it fill that role |
| Which source codes propagate | Default 8xx/9xx only (strategic plan); the policy lists them | Needs a policy field, `notary.propagated_codes` |
| Source code semantics through propagation | An 8xx source revocation ("role ended", "voluntary surrender") and a 9xx ("loud") carry different community meanings. Propagating verbatim would reveal source severity in the derived card; propagating a fixed code loses it | 2.6 decides; leaning: derived code is policy-set |
| Notarization entry | New code needed (A.3(b)), candidates 4xx neutral context | Add to `update_codes.md` |
| Runtime/program list updates | 3xx "neutral update" (D.2) | Existing |
| Derived-card renewal | 301 (valid-until refresh) | Existing, if `valid_until` becomes a card field (A.5) |

### D.4 Detecting source revocation (sealed_link watch loop)

- The registry emits `CardHeadUpdated(card_address, prev_log_cid, new_log_cid, press_address, timestamp)` for every update. The **event does not say it was a revocation**: the new head is an IPFS log entry encrypted under the card's content key (ADR-006).
- Therefore a host cannot filter "revocation events" itself. Either (a) the enclave gives the host a **watch list** of source card addresses (leaks to the host *which source cards were presented to this notary*, even without links to derived cards), or (b) the host forwards **every** `CardHeadUpdated` and the enclave filters by its sealed link set (no leak; heavy volume), or (c) the host forwards updates for addresses matching a Bloom-like or hashed-prefix filter (partial leak, tunable). 2.6 must choose; the strategic plan's claim that the host's records cannot match source to derived card holds under (a), but set membership leaks. This is a privacy claim to restate precisely in the spec.
- Press `reconcile-cids` task and verifier `head.ts` already read the registry; reusable for the host.

### D.5 Logs and auditing

- `log_auditing.md` is the direct-messaging model (`PressIssuanceRecord` to auditors; issuer; policy holder). Notaries **can** reuse it for derived-card issuance (A.1). Notarizations of aggregation and votes have no equivalent audience; the notary policy's `auditors` could receive notarization records the same way. Optional.
- "Every handoff appears in the job log" — jobs are not cards and have no log. See A.3 (d) and §F.

## §E Reusable code

### E.1 Inventory

| Area | Reuse candidate | Reuse for |
|---|---|---|
| `press/` (nitropack, `viem`, `hpke-js`, `@noble/*`) | `package.json`, `nitro.config.ts`, `server/{api,routes,plugins,tasks}`, `src/config.ts` env loading, `src/chain/registry.ts` and `gas.ts` (write payload signing, sequence handling), `src/ipfs/{provider,filebase,kubo,mock}.ts`, `src/kv.ts`, `src/ohttp-gateway.ts` and `ohttp-router.ts` (gateway pattern), `src/serialization.ts` (RFC 8785), `src/functions/{crypto,log,notifications}.ts` | Notary host: layout, IPFS, registry writes, gateway, log entries, auditor messaging |
| `membership_card_verifier/packages/verifier` | `CardVerifier`, `canonicalize.ts`, `crypto.ts`, `head.ts`, `stages/` | Notary host validates source cards; wallet validates notary chains; add notarization verification as a new entry point |
| `membership_card_verifier/packages/verifier-py` | — | Possibly a Python notarization verifier later; not v1 |
| `contracts/protocol-types` | Rust types (payload parser, constants) | Rust enclave runtime could share canonical payload constants; cross-language conformance via `specs/serialization-conformance.json` |
| `integration_tests/` | `docker-compose.yml` services (`ipfs`, `relay`, `wallet-service`, `press`, `redis`, `nitro-devnode`, `deploy-contracts`), `run.sh`, `stack-ready.sh`, `suites/support/{liveCard,registryContract}.ts`, harnesses (web, rn), `suites/core/*.spec.ts` as templates | New `suites/notary/` plus a `notary-host` and `notary-sim` compose service. The compose stack uses `nitro-devnode`: that is the Arbitrum **dev node**, unrelated to AWS Nitro Enclaves, and a third "Nitro" in this repo — the terminology note in §F should cover it |
| `wallet-sdk` / `app-sdk` | offers/, verification/, oblivious transport, `StorageProvider` | Consent, countersign, resubmission storage |
| `relay/` | oblivious target registry (`oblivious-targets.ts`) | Register notary host `target_id` |
| `wallet-service/` | OHTTP gateway implementation (reference) | The notary gateway follows it |
| `governance/scripts` | TypeScript scripts for list publication | Pattern for list-publication scripts (D.2) |
| `plans/spec-consistency/` | consistency-pass method | Plan 3.9 |

### E.2 Hybrid KEM (ML-KEM-768 + X25519)

| Side | Library | Finding |
|---|---|---|
| TypeScript (wallet, host) | `hpke-js` 1.8.0 (present in `press/node_modules`); `@hpke/hybridkem-x-wing` 0.7.1 (npm) | The extension exists and plugs into `hpke-js` `CipherSuite` as a KEM. **Not currently installed** in any package (app-sdk has `@hpke/dhkem-x25519`, `dhkem-x448`, `chacha20poly1305`, `core`, `common`). It implements X-Wing **draft-06** |
| Rust (enclave) | `hpke` 0.15.1 with feature `mlkem` (depends on `ml-kem` and `x-wing`); `x-wing` 0.1.1 ("draft 06"); `ml-kem` 0.3.4 | Same draft-06. `rxwing` 0.1.0 is draft-11 — **do not mix**; X-Wing's draft revisions changed the combiner |
| Interop | JS draft-06 ↔ Rust `x-wing` 0.1.1 draft-06 | Plausible; **must be proven with cross-language test vectors** in 5.1/5.2 before relying on it |

Risk to note (CP9 trigger if it proves unworkable): X-Wing is an IETF draft; the hybrid is X25519 + ML-KEM-768, matching the strategic plan exactly, but draft-06 may be superseded and a wire-incompatible later draft would force a re-key of long-lived job announcements. Mitigation: bind the KEM id and draft version into the job announcement and key config, so a verifier can reject unknown suites.

Other crypto on the enclave side: ML-DSA-44 verification for card chain checks (Rust crates for FIPS 204 — to be chosen in 5.0; the existing JS side uses `@noble/post-quantum`), SHA3/keccak (`sha3` crate), RFC 8785 JCS in Rust (needs a crate or hand implementation; conformance via `serialization-conformance.json`), AES-256-GCM, wasmi.

### E.3 Rust and WASM toolchain

The repo's Rust today is the Stylus contracts (`contracts/`, `rust-toolchain.toml`). The notary runtime is a **second, std-enabled Rust workspace**; no existing code is reusable beyond `protocol-types` constants. Contracts' `rust-toolchain.toml` should not be shared.

## §F Cross-cutting issues and Phase 2 question list

### F.1 Consistency checks run at 1.6

- **Names/fields.** Grepped `specs/` and `governance/` (whole-word, case-insensitive) for `notary`, `notaries`, `approved_notaries`, `PCR` and `Nitro Enclave`: **no matches**, so no name collisions and no existing reference to AWS Nitro Enclaves. Overloaded terms: `attestation` appears in 24 files (App Attest / Play Integrity, `DomainBindingAttestation`, Matrix join attestation) and `enclave` in 10 (device secure enclaves); notary text must say "enclave attestation" / "AWS Nitro Enclaves attestation document" on first use to avoid confusion. `TEE` / "Trusted Execution Environment" appears in 4 files; two are P2 aspirations in `card_protocol_spec.md` (lines 499 and 672: TEE-hardened press), which the Notaries work partially fulfils; Phase 3.7 should cross-reference them (the other two files, `subcards.md` and `key_rotation.md`, were not inspected and should be checked in 3.9). "Nitro" (bare) was scanned in the specs read for this step (`press.md`, `OPERATOR.md`, ADR text) and refers to the unjs web framework; a repo-wide count was not taken.
- **Contradictions between sections of this document:** none remaining. The only tension found within the scan itself — §D.4(a) vs. the "host cannot match" claim — is stated precisely above.
- **Strategic-plan statements that don't match the repo:** §0 items 1, 3, 6 (and 2 as a design tension with G3).

### F.2 Questions Phase 2 must answer (with the section that raises them)

Object schemas (2.1):
1. How are the `notary` policy section, `approved_notaries` and top-level predicates named without colliding with press-oriented fields? (A.1)
2. One `PolicyCardDocument` with `field_definitions` + `notary`, or separate policies for the notary and the derived card? (A.4)
3. How is `valid_until` on derived cards represented? (A.5)
4. What signature carrier does the enclave use, and which key does an `enclave_signature` verify against (key binding between notary sub-card pubkey, attestation `public_key`/`user_data`, and the enclave)? (A.4, B.1)
5. What does a notarization log entry look like — `LogEntry` change, new code, EAS, or per-job card? (A.3)
6. Where does the "job log" (handoff records) live? (A.3, D.5)
7. Where are job announcements hosted and discovered? (A.2, §C)

On-chain authorization and governance (2.2):
8. Which B-option? Contract change acceptable (CP7)? Own on-chain address per enclave/replica? (B.2, B.4)
9. Does the notary hold ML-DSA and secp256r1 keys inside the enclave, and how do they survive restarts and replicate? (B.1)
10. Which body owns the PCR0 list and program allowlist; card-based list vs. on-chain table; how is historical acceptance evaluated? (D.1, D.2)
11. How is the state-blob anchored with rollback protection (card head, new contract field)? (B.3)

Attestation and admission (2.3):
12. Inner HPKE with X-Wing draft-06 inside the outer OHTTP envelope: exact layout and suite-version binding. (§C, E.2)
13. Attestation `user_data` layout and freshness model; one verifier abstraction for simulator and AWS backends. (plan 2.3)

Runtime (2.4):
14. Broker/worker, vsock protocol, lifecycle, limits, zeroization, privacy transforms; DP in v1 or specified-and-deferred (**David decides**). (plan 2.4)

Replication and recovery (2.5):
15. Handoff, heartbeats, epoch resubmission, latest-ballot-wins keyed per card across epochs, chain-anchored close, state-blob format. (plan 2.5)

Derived cards and propagation (2.6):
16. Nullifier inputs and period; anonymity-set counting given host-supplied chain data; batching parameters. (plan 2.6)
17. Watch-list vs. full-stream vs. filtered feed for source-card revocation, and the exact privacy statement. (D.4)
18. Do propagated revocations map code-for-code or via a policy-set code? (D.3)
19. Do derived-card issuances emit `PressIssuanceRecord`s to the policy's auditors, and does `issued_at` leak timing? (A.1)

Terminology and process:
20. Add a terminology note to `ARCHITECTURE.md` (and optionally `press.md`) clarifying "Nitro" (unjs web framework) vs. "nitropack" (the package, same project) vs. AWS Nitro Enclaves vs. `nitro-devnode` (Arbitrum). Existing specs are not rewritten. (§0 item 5, §E)

### F.3 Checkpoint status

No strategic decision is invalidated, so **CP1 is not triggered**. Items 4, 5, 8, 9 and 10 are the ones most likely to change the shape of the design; David should expect them as explicit decision points at CP2. Any contract change will separately require **CP7**, and a change to `LogEntry` that breaks existing tests **CP6**.
