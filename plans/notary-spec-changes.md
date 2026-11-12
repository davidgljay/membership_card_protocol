# Digital Notaries — Spec Change Summary (Phase 3)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Design record: [notary-design-decisions.md](notary-design-decisions.md) (approved at CP2, 2026-11-11) · Milestone: [milestones/notary-phase-3-summary.md](milestones/notary-phase-3-summary.md)

This lists every file changed or created in Phase 3 (steps 3.1–3.8), for David's review at **CP3**. No code was written and nothing is committed.

**Size of the change** (before the CP3 web-evidence hook): 6 new files (about 1,800 lines), and 15 changed files (+1,501 / −11 lines).

**Terminology:**
- New text writes "AWS Nitro Enclaves", "the enclave", "enclave attestation" and "nitropack" in full.
- Existing specs keep bare "Nitro" for the unjs framework. A key to the four meanings is in `ARCHITECTURE.md`.

---

## New files

| File | Step | Contents |
|---|---|---|
| `specs/process_specs/notary_lifecycle.md` | 3.3 | The notary process end to end, in eight phases:<br>• operator setup and genesis<br>• policy creation<br>• job activation<br>• sharing<br>• consent<br>• submission and receipts<br>• processing and close<br>• output and notarization<br>It also covers:<br>• the three job modes and the aggregation, vote and derived-card flows<br>• all error codes<br>• **the notary threat model**: assumptions T1–T10 and known limits L1–L10<br>• Appendix A, algorithms V, W, G and N<br>• Appendix B, input checks B1–B11 and output checks |
| `specs/process_specs/notary_replication_and_recovery.md` | 3.4 | Parameters and why the quorum is a majority; forming a replica set; the handoff protocol with peer check P1–P4; quorum acknowledgment of inputs; close by chain time plus NSM time with a cosigning quorum; heartbeats and re-replication; epochs after total loss, wallet resubmission and latest-ballot-wins; the state blob; colluding operators. Every step has a hostile-host threat note. |
| `specs/process_specs/derived_card_revocation_propagation.md` | 3.5 | Periods, `dup_tag` and renewal; evidence bundles and policy snapshots; the two-round issuance flow (derive checks D1–D4); the anonymity-set rule; the `expiry_only` and `sealed_link` modes (watch loop, successor rule, codes 820/920); release timing; wallet disclosures; `escrowed_link` (specified, not implemented); all parameters with defaults and bounds |
| `specs/object_specs/notary_runtime.md` | 3.6 | The enclave image and its measurement; the broker/worker processes and their isolation; keys and invariants I1–I3; attestation backends and the verifier interface; program admission (algorithm A); the program interface `notary_v1` with its frozen fuel table; both message protocols; lifecycle state diagrams; output transforms; governance lists inside the runtime; chain-data trust; limits; zeroization; error codes; the four implementation checkpoints that trigger CP9 if they fail |
| `specs/object_specs/notary_host.md` | 3.6 | The nitropack host: what it is trusted for and accountable for, deployment, configuration, endpoints, oblivious ingress, storage, the chain feed and whole-policy snapshots, IPFS and EAS publishing, registry writes, enclave management and peer relay, output delivery, monitoring, error codes |
| `governance/PressRegistryBody/notary_certification.md` | 3.7 | PressRegistryBody's second mandate:<br>• what it holds (two list cards, `NotaryCardPolicy`, the template policies, `AuthorizePress` per template and operator)<br>• criteria for accepting a runtime and allowlisting a program<br>• operator obligations and revocation<br>• **a proposed emergency-retirement rule, for David's decision**<br>• accountability |

## Changed files

| File | Step | Change |
|---|---|---|
| `specs/ARCHITECTURE.md` | 3.1 | **ADR-013 "Notaries — Attested Computation over Signed Inputs"** covers:<br>• context, decision, platform choice and how to swap it<br>• trust assumptions and limits<br>• alternatives (other TEEs, Prio/MPC, zkVM, client-side proofs, plus the internal options rejected) and consequences<br>Also:<br>• a notary block in the Component Map, and Key Data Flow 5<br>• the "Nitro" terminology note in System Overview<br>• an amendment note in ADR-011 (PressRegistryBody's wider remit)<br>• a cross-reference at OQ-12<br>• table-of-contents entries for ADR-012 (previously missing) and ADR-013<br>• version 1.3 |
| `specs/protocol-objects.md` | 3.2 | §1: optional `expires_at`.<br>§2: `approved_notaries` and `notary`, new **§2.1 Notary Section** (fields, privacy transforms, parameter references, derived-card and propagation parameters, worked example) and **§2.2 Derived-Card Template Policies**.<br>§11: no `PressIssuanceRecord` for notary-issued cards.<br>New conventions block and **§20–§34**: notary card and genesis request, job, announcement, input and countersign, sealed input, host receipt, validation receipt, notarization, job log, handoff, heartbeat, state-blob header, propagation batch, attestation binding, governance lists.<br>Contents, Object Relationship Summary and Serialization Quick Reference updated. |
| `specs/card_protocol_spec.md` | 3.7 | New **§9 Notaries**: problem, goals, non-goals, 8 user stories, P0/P1/P2 requirements, **18 acceptance criteria mapped one to one onto the strategic plan's Key Objectives**, open questions.<br>`approved_notaries` and `notary` added to the protocol-defined policy fields.<br>Parameter references added to the Predicate System.<br>`expires_at` added to Protocol-Required Fields.<br>The P2 TEE items in §1 and §2 point to §9.<br>Feature count goes from eight to nine. |
| `specs/update_codes.md` | 3.7 | Codes **820** (propagated, quiet) and **920** (propagated, loud), with notes and a cross-reference |
| `specs/object_specs/wallet_sdk.md` | 3.6 | New **§7b Notaries (wallet-side)**: configuration, `verifyNotaryJob` (algorithm W), consent model, `submitNotaryInput`, job watching and resubmission, inclusion checks, `requestDerivedCard`, error codes. §10 gains a stated exception to the `CardVerifier`-only rule, for attestation checks. Contents, status and related specs updated, plus a changelog line. |
| `specs/object_specs/card_verifier.md` | 3.6 | `VerifierConfig.notary`; new **§6.5 `verifyNotarization`**; Stage 4 step 5a enforces `expires_at`; Stage 5 step 3a adds the derived-card checks (genesis attestation G, card shape, `dup_tag` returned); codes `NOTARY_GENESIS_INVALID`, `NOTARY_DERIVED_SHAPE`, `NOTARY_CONFIG_MISSING`; changelog |
| `specs/object_specs/registry_contract.md` | 3.6 | §6.1 write gate gains **required step 8**: every signed field must equal the calldata (D5), with error E-49 `PAYLOAD_CALLDATA_MISMATCH`. A status note says it must be implemented before derived cards ship. The contract change itself is **CP7**. Changelog. |
| `specs/process_specs/oblivious_transport.md` | 3.6 | New §Notary Host Destination: the notary host as a third destination, its oblivious-only routes, and the double envelope. Changelog. |
| `specs/messaging_protocol.md` | 3.6 | New **§24 `notary_output`**; the `"notary_input"` sub-card capability string; summary-table row; amendment line |
| `specs/object_specs/press.md` | 3.6 | Cross-reference only: a notary card acts as `press_card` under template policies, and "Nitro" in this spec means nitropack |
| `specs/object_specs/wallet.md` | 3.6 | OQ-WALLET-6: notary announcements are hosted by the notary host. Open-offer hosting is still open. Changelog. |
| `governance/PressRegistryBody/mandate.md` | 3.7 | Second-mandate paragraph and an amendment line |
| `governance/PressRegistryBody/press-rules.md` | 3.7 | Draft Section 6, Notary Operators, plus an amendment-history row |
| `governance/README.md` | 3.7 | PressRegistryBody's mandate row mentions notaries |
| `README.md` | 3.8 | Notaries under Core Flows (club health check, vote, "anonymous member" card); a Notary entry under Protocol Components; notary spec links under Specification |

## Added at CP3 review (2026-11-12): web-evidence hook

David asked whether notaries could issue cards from validated HTTPS responses, as Reclaim Protocol does. He chose to **reserve a hook now and defer the feature**. No feature behaviour was specified.

| File | Change |
|---|---|
| `specs/protocol-objects.md` | §2.1 `derived_card` gains `source_kind` (default `"card"`; `"web_evidence"` reserved, refused by v1 runtimes and unverifiable to v1 verifiers). §2.2 gains a "Source kinds" note. |
| `specs/object_specs/notary_runtime.md` | §11 "Other deferred features" paragraph, and a new error code `ADM_FEATURE_UNSUPPORTED`. It also gives the existing `escrowed_link` refusal a named code, which it lacked. |
| `specs/process_specs/derived_card_revocation_propagation.md` | Parameter table row for `source_kind` |
| `specs/object_specs/card_verifier.md` | Stage 5 step 3a rejects a derived card whose template `source_kind` isn't `"card"` (`NOTARY_DERIVED_SHAPE`) |
| `specs/card_protocol_spec.md` | §9 P2 entry "Web-evidence derived cards" (zkTLS attestor claim preferred; enclave as TLS client as the alternative). Open question for David on attestor-set trust and governance. |

## Plans updated during Phase 3

| File | Change |
|---|---|
| `plans/notary-design-decisions.md` | Synced with corrections made while writing specs: the genesis nonce now hashes the complete request; `job_requester_predicate` is optional; dedupe wording uses "contributor / root key"; `projected` is `text` holding canonical JSON |
| `plans/notary-implementation-plan.md` | Steps 3.1–3.8 ticked; 3.9 ticked with this document |

---

## Consistency pass (step 3.9)

| Check | Method | Result |
|---|---|---|
| Terminology | Searched the new files and the added lines of changed files for "Nitro" not followed by "Enclaves" | Clean. Two intentional quoted uses: in the `ARCHITECTURE.md` key, and in `notary_host.md` explaining what `press.md` calls "Nitro". |
| Stale names from the design phase | `validity`, `64 KiB`, "without nonce", "per master card", "distinct master", "notary sub-card" | None remain in specs |
| Object numbers | Every `protocol-objects.md §N` reference in the touched files, checked against the object it should name | All 2.1, 2.2 and 20–34 references are correct |
| Cross-spec section links | Every `<notary or changed spec>.md §N` reference, checked against headings | All resolve |
| File links | Every spec path in the README and the notary specs | All exist |
| Error codes | Every `ATT_/ANN_/JOB_/NOT_/ADM_/INPUT_/DERIVE_/HANDOFF_/NH_/NOTARY_/LIST_/LINT_/OUTPUT_/REVISION_` code, checked for a defining table row | **Fixed:** the eleven `NOT_*` notarization codes had been listed only as a wildcard in `notary_lifecycle.md` §Error Paths, so they are now named. `NOTARY_NO_RECEIPT` is defined in prose (`wallet_sdk.md §7b.8`), which is acceptable. |
| Field names | Every underscored identifier in the notary specs, checked against `protocol-objects.md` and the contract and code specs | The only identifiers not in `protocol-objects.md` are message kinds, local algorithm terms, and existing verifier result fields. No misspelled protocol fields. |
| Acceptance criteria and objectives | Counted §9 criteria against the strategic plan | 18 = 18, grouped G1–G5 |

**Known limits of the pass.** Anchor fragments inside existing specs (e.g. `#7b-notaries-wallet-side-not-implemented`) follow the house convention but weren't checked with a renderer. The pass covered the files listed above, not every spec in the repository.

---

## CP3 outcome

**Approved by David, 2026-11-12.** The spec text was approved as written, including the web-evidence hook. Status of the other items:
- **Emergency retirement:** **adopted** by David on 2026-11-12. `notary_certification.md` now states it as a rule, `mandate.md` records the exception to deliberation periods, `ARCHITECTURE.md` ADR-013 describes it, and the open question is removed from `card_protocol_spec.md §9`. The thresholds are enforced by member multi-signatures (next section).
- **`projected`:** stays `text` holding RFC 8785 canonical JSON, as the specs say (confirmed by David).
- **Strategic-plan wording (§2.7.5):** not applied (confirmed by David). The strategic plan remains the original record, and the design doc carries the corrections.

## Added after CP3 (2026-11-12): member multi-signatures on governance lists

**The gap.** List updates had been signed only by the list-holder key, so neither the 2-of-5 emergency rule nor the 4-of-5 quorum could be enforced, and one key could add an unaudited runtime. David chose to close it now.

**The design.** Every list version carries a `list_approval` signed by PressRegistryBody members with their existing governance keys (`GovernanceKeysets[PressRegistryBody]`):
- a standard change needs the keyset quorum (4 of 5);
- `emergency_retirement` needs 2 and must be removal-only (rule E);
- readers verify the head, plus any emergency chain back to the last standard version (algorithm L);
- approvals are valid only under the current keyset version, so a rotation requires re-approval, and readers fail closed until it is published.

| File | Change |
|---|---|
| `specs/protocol-objects.md` §34 | `list_approval` field and signed payload, thresholds and `EMERGENCY_RETIREMENT_THRESHOLD`, rule E, verification and key-rotation rules |
| `specs/process_specs/notary_lifecycle.md` | New Appendix A.5 **algorithm L**; V's input is a list verified by L; `LIST_APPROVAL_*` codes in §Error Paths; assumption T5 restated as member-collusion thresholds |
| `specs/object_specs/notary_runtime.md` §12 | Image pins the member keyset; the broker runs L; member key rotation means a new image; `LIST_APPROVAL_*` error row |
| `specs/object_specs/card_verifier.md` | `RpcProvider.getGovernanceKeyset` (backed by the existing `GetGovernanceKeyset` read); config note; changelog |
| `specs/object_specs/wallet_sdk.md` | Config note and changelog line: lists must pass L against the on-chain keyset |
| `specs/object_specs/notary_host.md` | Notes that runtimes check `list_approval` |
| `specs/card_protocol_spec.md §9` | P0 requirement states the member signatures; the open question is removed |
| `specs/ARCHITECTURE.md` ADR-013 | Consequences note on cryptographic enforcement |
| `governance/PressRegistryBody/notary_certification.md`, `mandate.md` | Holdings table row; Enforcement and Key rotation paragraphs; mandate exception wording |

**Not a CP6 or CP7 trigger.** No contract change: members sign off-chain with their existing keys, and readers use the existing `GetGovernanceKeyset` view. The list cards are new, so there are no existing objects to break.

## Decisions for David at CP3

1. **Approve the spec text** (CP3).
2. **The emergency-retirement rule** for vulnerable runtimes and programs: any 2 of 5 members, effective immediately, ratified or reversed within 7 days, and only able to remove acceptance (`governance/PressRegistryBody/notary_certification.md`).
3. **Strategic-plan wording.** Apply the eight changes in `notary-design-decisions.md §2.7.5` now, or leave the strategic plan as the original record.
4. **The `projected` field type.** v1 uses `text` holding canonical JSON. The alternative is a new `object` field type in the field type system, which every verifier would need to support.

## Checkpoints ahead

- **CP4:** the Phase 4 code plan.
- **CP7:**
  - the write-gate calldata binding (`registry_contract.md §6.1` step 8);
  - one-time `RegisterPolicy` for `NotaryCardPolicy`, the list-card policy and each template;
  - `AuthorizePress` per (template, operator);
  - registering the EAS schema.
- **CP9 (to test early):**
  - X-Wing JS↔Rust interop;
  - NSM field limits;
  - NSM time independence (T9);
  - wasmi determinism.
