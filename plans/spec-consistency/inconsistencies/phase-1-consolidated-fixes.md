# Phase 1 Consolidated Fixes — Object Spec Consistency

Source: all 11 `plans/spec-consistency/inconsistencies/obj-*.md` Step A reviews.

---

## ⚠️ PROCESS PAUSE — finding count exceeds the ~15 threshold

After deduplication, this phase surfaced **~38 distinct findings** (37 routine + 1 requiring
David's direct decision per the task brief, plus a second finding the reviewers themselves
flagged as needing a design decision rather than a mechanical fix). That is more than double
the ~15-finding threshold the implementation plan sets for pausing before Step B mechanically
produces a fix list ("If any single phase's Step A run surfaces more than ~15 inconsistencies,
pause before Step B and let David know — that volume likely means the spec set has a
structural problem worth discussing").

**This list is provided in full below because the analysis is already done and the
individual entries are still useful groundwork for that discussion — but per the initiative's
own process, Step C (fix implementation) should not proceed against this list until David has
reviewed it and confirmed whether to (a) approve it as-is, (b) triage it down to a smaller
first batch, or (c) treat the volume itself as a signal that some upstream spec (particularly
`wallet.md`, `card_verifier.md`, and the Matrix cluster's cross-references) needs a heavier
rewrite rather than a patch-by-patch fix list.**

Rough shape of the 37 routine findings, by target file (a single fix often touches two files):
- `wallet.md`: 5 findings (mostly "this spec doesn't document behavior other specs assume it has" — Matrix endpoints, offer-hosting endpoints, migration behavior, backup-revoke endpoint)
- `card_verifier.md`: 9 findings (mostly "the concrete SDK spec is narrower than its process-spec counterpart `card_validation.md`" — missing stages, missing fields, enum mismatches)
- Matrix cluster (`matrix_room.md`, `matrix_synapse_module.md`, `matrix_encryption.md`): 6 findings (mostly documentation-hygiene: stale headers, missing power-level spec, stale citations)
- `registry_contract.md` / `protocol-objects.md`: 5 findings (mostly `protocol-objects.md` trailing behind `registry_contract.md` revisions)
- `press.md`: 4 findings (mostly other specs, esp. process specs, not tracking press.md's own already-corrected model)
- `wallet_sdk.md` / `app_sdk.md`: 5 findings (self-contradictions within a spec, or stale `client-sdk` references post-split)
- `relay` cluster: 2 findings (both isolated to `notification_relay.md` trailing `relay.md`/`relay_data_model.md` corrections)
- Misc cosmetic: 1 finding

A pattern worth naming explicitly for the discussion: a large fraction of these are not
disagreements *within* Phase 1's 11 object specs — they are Phase-1-object-specs having
already been quietly corrected, while process specs (`log_auditing.md`, `card_offering_and_acceptance.md`,
`notification_relay.md`, `dns_governance_verifier.md`) or the top-level `protocol-objects.md`
document didn't track the correction. Those are logged here (since Step A found them) but their
actual fix lands on Phase 2/out-of-scope files, not on the Phase 1 object spec itself.

---

## Consolidated Fix List

### 1. [HIGH] `protocol-objects.md` §14 `CardEntry` struct is missing the `forward_to` field
**Consolidates:** `obj-contracts.md` #1, `obj-card.md` Finding 1 (found independently by both reviews).
**File(s):** `specs/protocol-objects.md` §14; `specs/object_specs/registry_contract.md` §2 (self-inconsistent field count); `specs/object_specs/ipfs_card.md` §6 (incomplete table inherited from the same issue).
**Change:**
- In `protocol-objects.md` §14, add the fifth field to the `CardEntry` struct definition:
  - Old (4 fields): `log_head_cid`, `policy_address`, `last_press_address`, `exists`.
  - New (5 fields): add `forward_to bytes32 — set by RegisterAddressForward (§4.13); immutable once set` (copy the one-line description from `registry_contract.md` §3.1), and update the struct's changelog note.
- In `registry_contract.md` §2, change the sentence "`protocol-objects.md §14` has been updated (2026-06-14) to show the full **4-field** `CardEntry` struct" → "full **5-field** `CardEntry` struct" (or drop the specific count to avoid re-drifting).
- In `ipfs_card.md` §6, add `forward_to` as a row in the on-chain/IPFS-side mapping table (its own preamble already claims to cover the full struct).
**Soundness check:** sound — `registry_contract.md` is confirmed authoritative (its 5-field version is corroborated by `card_verifier.md` lines 137–143), so this is a one-directional sync, no new conflict created.

---

### 2. [HIGH] `press.md` §5.4 `registerSubCardOnChain` doesn't implement the DNS-admin-card secp256r1 authorization path `registry_contract.md` v0.6 requires
**Consolidates:** `obj-contracts.md` #2, `obj-press.md` #1 (found independently by both reviews).
**File(s):** `specs/object_specs/press.md` §5.4, §7; likely also `specs/process_specs/dns_governance_verifier.md` (Phase 2, currently silent on this).
**Change:**
- `press.md` §5.4 `processSubCardRegistration`: add a step to call/read `DnsAdminCardKeys[master_card_address]` before submission.
- If non-zero: obtain the domain admin card holder's `AdminAuthorizeSubCardPayload` + secp256r1 signature (this needs a new input field somewhere upstream — e.g. the `/sub-card/register` request body — since no current field carries this signature into the press).
- `registerSubCardOnChain`'s call: old (6 args) `RegisterSubCard(sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, master_sig_payload, master_signature)` → new (8 args, matching `registry_contract.md` §4.3): add `admin_secp_payload, admin_secp_signature` (explicit zero values when the master is not a DNS admin card).
- `press.md` §7: add `E-47` to the error table.
**Soundness check:** the recommendation is sound on the contract-call-signature side, but **not fully mechanical** — it requires a small design decision on where the admin's secp256r1 signature is collected/carried in the press's intake flow (both source reviews flag this explicitly). Recommend Step C treat this as "add the field/step; if the intake-flow design isn't obvious from `subcard_creation_policy.md`, escalate rather than invent an API shape." Also cross-check `dns_governance_verifier.md` (Phase 2) for the same gap since it currently doesn't mention `RegisterSubCard`/`admin_secp`/`DnsAdminCardKeys` at all.

---

### 3. [LOW] `open_offer_creation.md` cites the superseded name `RegistryEntry` for `protocol-objects.md` §14
**Consolidates:** `obj-contracts.md` #3.
**File(s):** `specs/process_specs/open_offer_creation.md` (line 146).
**Change:** old: `protocol-objects.md §14 — RegistryEntry (open offer counter) object reference` → new: `protocol-objects.md §14 — CardEntry (on-chain) object reference`.
**Soundness check:** sound, purely cosmetic, no side effects.

---

### 4. [LOW] `card_verifier.md`'s `PressAuthEntry` interface omits two fields present in `registry_contract.md`'s struct of the same name
**Consolidates:** `obj-contracts.md` #4.
**File(s):** `specs/object_specs/card_verifier.md` (line ~101, `PressAuthEntry` return type of `getPressAuthorization`).
**Change:** Add a one-line note above the interface: "This is a client-side projection of a subset of the on-chain `PressAuthEntry` struct (`registry_contract.md §3.3`) — `key_scheme` and `next_sequence` are omitted as not currently useful to a runtime verifier." (Alternative: add the two fields if a future consumer needs `key_scheme`; not recommended now since no in-scope consumer needs it.)
**Soundness check:** sound — documents intent rather than silently under-specifying; low risk either way since it's additive/clarifying only.

---

### 5. [LOW] Casing inconsistency: `OpenOfferUseCounts` (registry_contract.md) vs. `openOfferUseCounts` (open_offer_creation.md)
**Consolidates:** `obj-contracts.md` #5.
**File(s):** `specs/process_specs/open_offer_creation.md` (lines 86, 112, 120).
**Change:** Replace `openOfferUseCounts` → `OpenOfferUseCounts` in all three locations, matching `registry_contract.md` §3.5's PascalCase Solidity/Stylus identifier.
**Soundness check:** sound, cosmetic.

---

### 6. [LOW] `ipfs_card.md` §4 claims CID hash-algorithm flexibility (SHA2-256/SHA3-256/BLAKE3) that `press.md`'s actual `pinToIPFS` implementation doesn't support
**Consolidates:** `obj-card.md` Finding 2.
**File(s):** `specs/object_specs/press.md` §5.1 (`pinToIPFS`), or alternatively `specs/object_specs/registry_contract.md` §3.1 and `specs/object_specs/ipfs_card.md` §4.
**Change (pick one; flag for David which is intended):**
- (a) Generalize `press.md` §5.1's CID-rederivation step 3–4 to detect/support all three hash algorithms `registry_contract.md` accommodates, or
- (b) Narrow `registry_contract.md` §3.1's claim to "only SHA2-256 is currently produced/validated by the reference press implementation; SHA3-256/BLAKE3 reserved for future use," and update `ipfs_card.md` §4 to match.
**Soundness check:** needs a one-line decision (is multi-algorithm support intended now or later?) before Step C can pick a side — flagging as a small design call, not purely mechanical, but low severity/low risk either way.

---

### 7. [INFORMATIONAL] `protocol-objects.md` §3 `LogEntry` example has a stray `"version": 2` vs. its own table's "version 1 is first post-genesis entry" rule
**Consolidates:** `obj-card.md` Finding 3.
**File(s):** `specs/protocol-objects.md` §3.
**Change:** Fix the example's `"version": 2"` → `"version": 1` (or fix the accompanying comment) so the worked example matches the table's stated rule.
**Soundness check:** sound, cosmetic; `ipfs_card.md` already implements the correct rule and needs no change.

---

### 8. [MEDIUM] `press.md` §5.1 never sets `protocol_version`, which `protocol-objects.md` requires the press to add; and `registry_contract.md` §5 has no `GetProtocolVersion()` read op to source it from
**Consolidates:** `obj-press.md` #2.
**File(s):** `specs/object_specs/press.md` §5.1 (`assembleCardDocument`/`signCardDocument`); `specs/object_specs/registry_contract.md` §5 (Read Operations).
**Change:**
- `press.md` §5.1: add a step, immediately before serialization, calling `getProtocolVersion()` on the logic contract and setting `protocol_version` on the `CardDocument`, per `protocol-objects.md` §1's signing sequence step 5.
- `registry_contract.md` §5: add a `GetProtocolVersion()` entry to the Read Operations table (or confirm/cite where it actually lives if it's a logic-contract constant rather than the registry contract itself).
**Soundness check:** sound — this closes a genuine two-sided gap (press.md doesn't call it; registry_contract.md doesn't define it) without creating a new conflict, since `protocol-objects.md` already specifies the exact behavior both files need to converge on.

---

### 9. [MEDIUM] `log_auditing.md` and `card_offering_and_acceptance.md` (process specs) still describe the audit-epoch/AEK model that `press.md` §5.6 explicitly marks Removed
**Consolidates:** `obj-press.md` #3.
**File(s):** `specs/process_specs/log_auditing.md` (entire epoch/AEK/ML-KEM model); `specs/process_specs/card_offering_and_acceptance.md` (Preconditions + steps 19–21).
**Change:** Rewrite `log_auditing.md` to describe the direct-auditor-messaging model per `press.md` §5.5 (or mark it superseded/archived, analogous to `client_sdk.md`, if audit epochs are retired from the spec set entirely). Update `card_offering_and_acceptance.md`'s Preconditions and steps 19–21 to match `press.md` §5.5's `appendIssuanceRecord` flow (drop `epoch_id`/`requester_card` fields that no longer exist in `PressIssuanceRecord`).
**Soundness check:** sound in direction (press.md is confirmed authoritative — `protocol-objects.md` §12/§13 independently corroborate the removal). **Note:** this is a Phase 2 file change, not a Phase 1 object-spec change — flagged here because Phase 1's press.md review is what surfaced it. Recommend re-confirming scope with the `proc-log-auditing`/`proc-card-creation` Phase 2 units rather than fixing it now, unless David wants it pulled forward.

---

### 10. [LOW] `press.md` §5.4's subcard-sibling notifications (plaintext HTTP) aren't flagged as an exception to `messaging_protocol.md`'s signed/encrypted envelope model
**Consolidates:** `obj-press.md` #4.
**File(s):** `specs/process_specs/messaging_protocol.md` §9–11 (or a general caveat near the top of the message-type taxonomy).
**Change:** Add a note that `subcard_sibling_added`/`_removed`/`_rotated` notifications are currently delivered out-of-band as unsigned/unencrypted HTTP POSTs (pending a protocol field for subcard ML-KEM public keys), cross-referencing `press.md` §5.4's own note.
**Soundness check:** sound, additive documentation only; no behavior change implied.

---

### 11. [HIGH] `wallet.md` documents no Matrix endpoints, config, or data-model rows, though `matrix_room.md`/`room_discovery.md`/`matrix_synapse_module.md` describe them as already implemented on the wallet service
**Consolidates:** `obj-wallet.md` #1.
**File(s):** `specs/object_specs/wallet.md` §5 (Data Model), §7 (Endpoints), §2 (Relationship to Existing Specs).
**Change:** Add a §7.x "Matrix" endpoints subsection (`POST /matrix/rooms`, `GET /matrix/room-index`, `POST /matrix/discover-rooms`), a `matrix_credentials` row in §5, and Relationship-table entries for `matrix_room.md`, `matrix_synapse_module.md`, `matrix_encryption.md`, `room_discovery.md`, `matrix_join_attestation_and_revocation.md`. (Alternative if judged out of scope: add an explicit scope-exclusion note instead, so the gap doesn't read as an oversight.)
**Soundness check:** sound — this is documented, already-implemented behavior per the other three specs' own text; adding it doesn't create a new conflict.

---

### 12. [MEDIUM] No `wallet.md` endpoint is documented for open-offer hosting/claim-link serving, inbound targeted-offer delivery, or SCIP/audit-record delivery, though three process specs assume these exist
**Consolidates:** `obj-wallet.md` #2.
**File(s):** `specs/object_specs/wallet.md` §1 (Overview), §7 (Endpoints).
**Change:** Either add the offer-storage/hosting, claim-link-serving, and inbound-offer/SCIP/audit-receipt endpoints to `wallet.md` §7 (if implemented there), or add an explicit line to §1 naming which component actually hosts/receives these so `card_offering_and_acceptance.md`, `open_offer_creation.md`, and `open_offer_acceptance_new_wallet.md` can cite the correct source of truth.
**Soundness check:** needs a factual check (does wallet-service actually implement this?) before picking a side — flag for whoever has wallet-service repo access; not purely a documentation call.

---

### 13. [MEDIUM] `card_migration.md`'s "old wallet service" behavior (message forwarding, local-store removal) isn't confirmed anywhere in `wallet.md`
**Consolidates:** `obj-wallet.md` #3.
**File(s):** `specs/object_specs/wallet.md` §2 (Relationship table) or §7.5/§7.6.
**Change:** Add an explicit statement confirming whether the *old* wallet service's outbound message-forwarding-on-migration and local-card-removal behavior (per `card_migration.md` §6) is implemented; if not, add it as a new Open Question (parallel to OQ-WALLET-1–5) rather than a silent gap.
**Soundness check:** sound as a documentation completeness fix; the underlying factual question (is it implemented?) needs a real answer, not an assumption.

---

### 14. [MEDIUM] Card migration's client-side initiation (dual-signature construction, new-wallet-service challenge/response) has no implementing object spec
**Consolidates:** `obj-wallet.md` #4.
**File(s):** `specs/object_specs/wallet_sdk.md` (Related Specs / Implementation Status), or `specs/process_specs/card_migration.md` if ownership is genuinely unassigned.
**Change:** Add `card_migration.md` to `wallet_sdk.md`'s Related Specs / Implementation Status table (if the wallet SDK is meant to drive migration, analogous to recovery) — or, if not, add a note to `card_migration.md` itself flagging that client-side implementation ownership is unassigned.
**Soundness check:** needs a decision (is this wallet-sdk's job?) — low risk either way since it's additive.

---

### 15. [LOW] `wallet_backup_and_recovery.md`'s "revoke old backup registrations" step has no corresponding endpoint in `wallet.md` (already self-flagged as OQ-WALLET-2)
**Consolidates:** `obj-wallet.md` #5.
**File(s):** `specs/process_specs/wallet_backup_and_recovery.md` Process 3 Step 13, or `wallet.md` §7.4.
**Change:** Either implement a backup-registration-revoke endpoint and add it to `wallet.md` §7.4, or soften `wallet_backup_and_recovery.md` Process 3 Step 13's wording to match the weaker guarantee actually provided (old `keyring_id` deleted federation-wide; backup registration record/notification channels remain live).
**Soundness check:** sound; `wallet.md` already documents this as OQ-WALLET-2, so this just promotes an acknowledged gap into the fix list per the source review's recommendation.

---

### 16. [LOW] `notification_relay.md` uses the stale field name `wallet_ws_url` (and contradicts itself) where `relay.md`/`relay_data_model.md` corrected it to `wallet_base_url`
**Consolidates:** `obj-relay.md` Finding 1.
**File(s):** `specs/process_specs/notification_relay.md` (Process 1 steps 3–4; Process 6 "Properties").
**Change:** Replace `wallet_ws_url` → `wallet_base_url` in Process 1 step 4's UUID storage schema and Process 6's "Properties" bullet; drop "WebSocket" from Process 1 step 3's prose ("wallet WebSocket URL" → "wallet base URL").
**Soundness check:** sound, terminology-only fix; `relay.md`/`relay_data_model.md` need no change (confirmed correct/authoritative by their own changelog).

---

### 17. [MEDIUM — security-relevant] `notification_relay.md`'s Privacy Properties table and Process 2 still describe `push_token`-keyed lookups, which `relay_data_model.md` documents as a previously-fixed bug
**Consolidates:** `obj-relay.md` Finding 2.
**File(s):** `specs/process_specs/notification_relay.md` (Privacy Properties table; Process 2 steps 4–5).
**Change:** old: `"Relay service | Knows: UUID → push token; push token → pending message blobs"` → new: `"Relay service | Knows: UUID → device credential + push token; device credential → pending message blobs"` (matching `relay.md` §4 verbatim). Update Process 2 steps 4–5 to say the relay resolves the UUID's `device_credential` and checks SSE/WebSocket connection maps by that credential, not by `push_token`.
**Soundness check:** sound and important to prioritize — `relay_data_model.md` §8.1's isolation guarantee (an attacker who learns a push token can't drain the device's message store) depends on this being described correctly; leaving `notification_relay.md` stale actively misdescribes a security property.

---

### 18. [MEDIUM] `card_verifier.md`'s `SignatureVerificationResult` doesn't expose the resolved chain-address list that `matrix_synapse_module.md` needs and currently obtains via a private-API workaround
**Consolidates:** `obj-verifier-sdk.md` #2.
**File(s):** `specs/object_specs/card_verifier.md` §8.
**Change:** Add `chain_card_addresses: string[]` (or similar) to `SignatureVerificationResult`/`CardVerificationResult` (additive, non-breaking — already computed internally by Stage 3 per `matrix_synapse_module.md`'s own description).
**Soundness check:** sound — closes a documented private-API workaround without behavior change; `matrix_synapse_module.md` can then be updated (Phase 3/code-alignment concern) to use the public field once added.

---

### 19. [MEDIUM] `card_verifier.md` doesn't address the Python port (`membership_card_verifier/packages/verifier-py`) at all — no cross-language parity or authority statement
**Consolidates:** `obj-verifier-sdk.md` #3.
**File(s):** `specs/object_specs/card_verifier.md` (new subsection, e.g. §2 or a new "Language Bindings" section).
**Change:** Add a statement that the npm package (`@membership-card-protocol/verifier`) is the canonical source of truth and the Python port must track it field-for-field (or restructure so both bindings are covered by one authoritative description).
**Soundness check:** sound as a documentation fix; doesn't resolve whether the Python port has actually drifted (e.g., whether it already exposes `chain_card_addresses` from finding #18) — that's a Phase 3 code-alignment question, flagged for that phase.

---

### 20. [MEDIUM] `addressed_to_verifier` is declared in `card_verifier.md`'s result type but has no computing stage and no parameter to supply "the verifier's own card address"
**Consolidates:** `obj-verifier-sdk.md` #4.
**File(s):** `specs/object_specs/card_verifier.md` §5 (`VerifierConfig`), §6 (`verifyEnvelope`/`verifyCard`), §7 (Verification Pipeline).
**Change:** Add a `verifierCardAddress` (or similar) parameter to `VerifierConfig` or as a per-call option, and add a pipeline stage (matching `card_validation.md` Stage 7: "Recipient-Set Check") describing how `addressed_to_verifier` is computed from it.
**Soundness check:** sound — this is a genuine oversight (the field exists with no way to compute it), not a scope choice; the fix is additive and doesn't conflict with anything else in the spec.

---

### 21. [MEDIUM] `card_verifier.md` has no equivalent of `card_validation.md`'s mandatory Stage 8 (Replay and Freshness Check)
**Consolidates:** `obj-verifier-sdk.md` #5.
**File(s):** `specs/object_specs/card_verifier.md` §1 (Overview) or §7.
**Change:** Add a short note stating that replay/freshness checking (card_validation.md Stage 8) is explicitly out of scope for this package and left to the caller's `StorageProvider` (consistent with how `app_sdk.md` §9.2 already handles dedup) — if that is indeed the intended design. If not, add the stage.
**Soundness check:** the recommended resolution is a scope-clarification, which is sound *if* the out-of-scope framing is confirmed intentional; flag to whoever owns `card_verifier.md` to confirm before Step C picks the "just add a note" branch over "actually add the stage."

---

### 22. [LOW] `revocation.status` enum cardinality mismatch: `card_verifier.md` (4 values) vs. `card_validation.md` (2 values)
**Consolidates:** `obj-verifier-sdk.md` #6.
**File(s):** `specs/process_specs/card_validation.md` ("Structured Result" section).
**Change:** old: `"status": "none" | "revoked"` → new: `"status": "not_revoked" | "revoked" | "loud_revocation" | "unknown"`, matching `card_verifier.md` §8's four-value enum.
**Soundness check:** sound — `card_verifier.md` is the newer, more detailed concrete API spec; `card_validation.md`'s abbreviated JSON is confirmed stale/simplified, not an intentional narrowing.

---

### 23. [LOW] `non_compliance_reported` type mismatch: `card_verifier.md`'s `boolean` can't express `card_validation.md`'s `null` ("not applicable") state
**Consolidates:** `obj-verifier-sdk.md` #7.
**File(s):** `specs/object_specs/card_verifier.md` §8.
**Change:** Add a `null` variant to `non_compliance_reported`'s type (`boolean | null`), aligning with `card_validation.md`, and clarify in prose that `null` = "no report was needed," `false` = "report was needed but the POST failed," `true` = "reported successfully." (Alternative: explicitly document that `false` is currently overloaded and callers must check `policy_compliant` to disambiguate.)
**Soundness check:** sound; additive type change, no conflict created.

---

### 24. [LOW] `card_verifier.md` has no counterpart to `card_validation.md`/`card_protocol_spec.md`'s "Stage 5a" (Policy Creation Compliance)
**Consolidates:** `obj-verifier-sdk.md` #8.
**File(s):** `specs/object_specs/card_verifier.md` (§6/§7 or a scope note).
**Change:** Add an explicit note that policy-level verification (walking the policy-creation chain, collecting inherited `field_definitions` restrictions) is out of scope for this package and handled elsewhere — name where, if known — or add a Stage 5a / policy-verification mode if it's actually meant to be supported.
**Soundness check:** needs a scope confirmation before picking a side; low risk either way (additive note vs. additive mode).

---

### 25. [LOW] `card_verifier.md` Stage 2 is missing the 510/511/512 log-entry-signer check that `card_validation.md` step 9 requires as a MUST
**Consolidates:** `obj-verifier-sdk.md` #9.
**File(s):** `specs/object_specs/card_verifier.md` §7.2 (Stage 2).
**Change:** Add a check to Stage 2 confirming that any code-510/511/512 `LogEntry` on the master card's own log was signed (`intent_signature`) by the master card's own holder key, matching `card_validation.md` step 9's language — reject otherwise, regardless of the governing policy's `update_policy`.
**Soundness check:** sound and appears to be a genuine omission (not an intentional scope difference per the reviewer's read) — recommend including in the fix batch rather than treating as optional.

---

### 26. [MEDIUM — needs a design decision, see also "Needs David's Direct Decision" below] `app_sdk.md`'s OQ-SDK-4 ("not Tor") contradicts `notification_relay.md`'s mandatory-Tor requirement for the exact call it implements
**Consolidates:** `obj-app-sdk.md` Finding 1.
**File(s):** `specs/process_specs/notification_relay.md` (§Process 1 step 6, §Registration Privacy) and/or `specs/object_specs/app_sdk.md` (§9.3, §15 OQ-SDK-4), and possibly `specs/process_specs/oblivious_transport.md` (line 15's "complementary, not a substitute" framing).
**Change (two mutually exclusive options — do not implement either without confirming which was actually intended):**
1. If `ObliviousProtocolTransport` (HPKE/OHTTP) was meant to satisfy the "anonymizing transport" requirement for `registerCardUuids`: update `notification_relay.md` §Process 1 step 6 / §Registration Privacy to say so, **and** revise `oblivious_transport.md` line 15's "complementary, not a substitute" framing (it currently denies OHTTP alone is sufficient — leaving it as-is while also changing `notification_relay.md` would create a new three-way conflict).
2. If Tor is still required in addition to `ObliviousProtocolTransport` for this call: add that requirement explicitly to `app_sdk.md` §9.3/§4.7.
**Soundness check:** **not mechanical** — picking option 1 without also fixing `oblivious_transport.md` line 15 would simply relocate the contradiction rather than resolve it. Given the security framing (this governs the actual transport privacy guarantee for wallet UUID registration), recommend surfacing this to David alongside the verifier-sdk chain-walk question rather than letting Step C default to either branch.

---

### 27. [LOW] `oblivious_transport.md` still names `client-sdk` as one of "the same four-party system," predating the `app-sdk`/`wallet-sdk` split
**Consolidates:** `obj-app-sdk.md` Finding 2.
**File(s):** `specs/process_specs/oblivious_transport.md` (line 48).
**Change:** old: `"The wallet service, press, and client SDK are all parts of the same closed, four-party system (client-sdk, relay, wallet-service, press)"` → new: name it as a five-party system (`app-sdk`, `wallet-sdk`, `relay`, `wallet-service`, `press`), or say "the client SDKs" collectively without naming the retired package.
**Soundness check:** sound, cosmetic terminology fix.

---

### 28. [LOW] `matrix_encryption.md` §2 cites the superseded `client-sdk/packages/client-sdk/src/crypto/mldsa.ts` path for `mlDsa44Sign`, when `app_sdk.md` (dated earlier) already relocated it to `app-sdk/`
**Consolidates:** `obj-app-sdk.md` Finding 3, `obj-matrix-encryption.md` Finding 1 (found independently by both reviews).
**File(s):** `specs/object_specs/matrix_encryption.md` §2.
**Change:** old: `"mlDsa44Sign, client-sdk/packages/client-sdk/src/crypto/mldsa.ts"` and `"its client-sdk equivalent"` (for canonicalize) → new: cite `app-sdk/packages/app-sdk/src/crypto/mldsa.ts` (confirm the exact sending call-site package — app-sdk is key-independent, so confirm whether the actual outgoing-message signer sits in wallet-sdk's consumption of app-sdk's crypto module before finalizing the citation) and the corresponding `app-sdk`/`wallet-sdk` canonicalization reference.
**Soundness check:** sound — documentation-citation-only fix, no semantic change (same algorithm, same RFC 8785 canonicalization either way).

---

### 29. [LOW] `wallet.md` line 44 refers to "the client-sdk" talking to a press directly, predating the app-sdk/wallet-sdk split
**Consolidates:** `obj-app-sdk.md` Finding 4.
**File(s):** `specs/object_specs/wallet.md` (line 44).
**Change:** old: `"the client-sdk talks to a press directly"` → new: `"the app-sdk talks to a press directly"` (per `app_sdk.md` §4.7, §7.3, §8 owning press-facing offer/sub-card calls).
**Soundness check:** sound, cosmetic terminology fix.

---

### 30. [MEDIUM] `wallet_sdk.md` §4 misattributes `SecureKeyProvider` (master-key signing) and `RealtimeTransportProvider` (messaging delivery) to capabilities its own later sections say it doesn't use them for
**Consolidates:** `obj-wallet-sdk.md` Finding 1.
**File(s):** `specs/object_specs/wallet_sdk.md` §4.
**Change:** In the "Key providers for wallet-specific flows" bullets: drop or reword the `SecureKeyProvider` bullet (master key is handled outside any provider abstraction per §10 — every master-key-consuming function takes `masterSecretKey: Uint8Array` as a direct parameter, structurally incompatible with `SecureKeyProvider`'s opaque-`keyId` contract). Drop or reword the `RealtimeTransportProvider` bullet — Wallet SDK doesn't consume it directly; messaging delivery is implemented entirely in `app_sdk.md` §9.5 per Wallet SDK's own §12 Implementation Status table.
**Soundness check:** sound — this is an internal self-contradiction (§4 vs. §10/§12 of the same document), so the fix removes the contradiction without touching any other spec.

---

### 31. [MEDIUM] `wallet_sdk.md` §6.5 (`deregisterSubCard`) conflates its own on-chain, master-key-signed operation with `app_sdk.md`'s unrelated wallet-service-local UUID-pool deregistration
**Consolidates:** `obj-wallet-sdk.md` Finding 2.
**File(s):** `specs/object_specs/wallet_sdk.md` §6.5.
**Change:** Restore the `// POST /sub-card/deregister` endpoint annotation (present in the archived `client_sdk.md` §9.5, dropped here). Remove or rewrite the paragraph "Explicitly not sub-card revocation... wallet-service-local UUID pool... no impact on the sub-card's on-chain status" — that describes `app_sdk.md` §9.6's `deregisterCardUuids`, not this function. Replace with: "distinct from App SDK's §9.6 `deregisterCardUuids`, which empties only the wallet service's local UUID pool and has no on-chain effect and no relationship to sub-card revocation or to this on-chain deregistration," consistent with `press.md` §5.4's `processSubCardDeregistration` (master-key-signed, on-chain `DeregisterSubCard` call).
**Soundness check:** sound — cross-checked against three independent sources (`press.md` §5.4, `app_sdk.md` §9.6, archived `client_sdk.md` §9.5) that all agree on the corrected description; no new conflict introduced.

---

### 32. [LOW] `wallet_sdk.md` §5.3's `setupWallet` step ordering (backup registration before device sub-card setup) contradicts `wallet_backup_and_recovery.md` §Process 1's numbered steps (device sub-card first)
**Consolidates:** `obj-wallet-sdk.md` Finding 3.
**File(s):** `specs/object_specs/wallet_sdk.md` §5.3, or `specs/process_specs/wallet_backup_and_recovery.md` §Process 1 (whichever reflects the actual implementation).
**Change:** Correct `wallet_sdk.md` §5.3's prose to match the process spec's step order (device sub-card setup, Steps 7–10, before synced-passkey backup registration, Steps 11–13) — **unless** the implementation genuinely runs backup-before-sub-card, in which case update `wallet_backup_and_recovery.md`'s step numbering instead and note the change.
**Soundness check:** needs a factual check against the actual implementation (this predates the app-sdk/wallet-sdk split per the archived `client_sdk.md` §7.3 carrying the same ordering) before picking a side — flag for whoever has wallet-service/wallet-sdk repo access.

---

### 33. [HIGH — documentation gap, dup found from both sides] `matrix_room.md`'s Room Creation section is missing the `m.room.power_levels` (enforcement-account kick power) and `m.room.encryption` initial-state setup that two other specs cite it for
**Consolidates:** `obj-matrix-room.md` Finding 1, `obj-matrix-synapse.md` Finding 1 (found independently by both reviews).
**File(s):** `specs/object_specs/matrix_room.md` §"Room Creation: `POST /matrix/rooms`".
**Change:** Add to the Room Creation section: (a) that room creation sets an initial `m.room.encryption` state event (`algorithm: m.megolm.v1.aes-sha2`) alongside `m.room.name`/`m.room.topic`; (b) that room creation sets an initial `m.room.power_levels` state event granting kick-level (or higher) power to the Matrix user ID configured as `enforcement_matrix_user_id` (`matrix_synapse_module.md`'s config key).
**Soundness check:** sound — this is the room-creation endpoint's own spec catching up to behavior two dependent specs already assume is a hard requirement ("not something this watcher can retrofit after the fact"); no new conflict, just filling a real gap.

---

### 34. [LOW] `matrix_room.md` line 34 cites a nonexistent section "§71" in `card_protocol_spec.md` (actually a raw line number, not a section)
**Consolidates:** `obj-matrix-room.md` Finding 2.
**File(s):** `specs/object_specs/matrix_room.md` (line 34).
**Change:** old: `card_protocol_spec.md §71` → new: `card_protocol_spec.md §"Protocol-Required Fields"` (the actual heading the cited content falls under).
**Soundness check:** sound, cosmetic citation fix.

---

### 35. [LOW] `matrix_room.md`'s header metadata doesn't reflect the 2026-07-11 amendments its own body already incorporates
**Consolidates:** `obj-matrix-room.md` Finding 3.
**File(s):** `specs/object_specs/matrix_room.md` (header).
**Change:** Add "(amended 2026-07-11)" to the Date line and a short changelog note, matching the convention already used by `matrix_encryption.md` and `matrix_synapse_module.md`'s headers.
**Soundness check:** sound, no content change — the body's content is already correct, only the header lags.

---

### 36. [LOW] Terminology drift: `matrix_room.md`'s "mutable pointer registry address" vs. `registry_contract.md`'s literal `card_address`/`policy_address` naming
**Consolidates:** `obj-matrix-room.md` Finding 4.
**File(s):** `specs/object_specs/matrix_room.md` (or `registry_contract.md`, either works).
**Change:** Add a one-line gloss equating "mutable pointer" (the term `card_protocol_spec.md` and `matrix_room.md` use) with `registry_contract.md`'s `card_address`/`policy_address` + `log_head_cid`.
**Soundness check:** sound, additive clarification; not a factual contradiction to begin with (same underlying mechanism, different vocabulary).

---

### 37. [LOW] Stale/incomplete "Companion documents" headers across the three-file Matrix object-spec cluster
**Consolidates:** `obj-matrix-synapse.md` Finding 2.
**File(s):** `specs/object_specs/matrix_synapse_module.md`, `specs/object_specs/matrix_encryption.md`, `specs/object_specs/matrix_room.md` (all three headers).
**Change:**
- `matrix_synapse_module.md` header: add `specs/object_specs/matrix_encryption.md` (cited substantively in body, e.g. `verifyMatrixUserIdBinding`).
- `matrix_encryption.md` header: add `specs/object_specs/matrix_synapse_module.md` (cited in §3, §4).
- `matrix_room.md` header: add `specs/process_specs/matrix_join_attestation_and_revocation.md` and `specs/process_specs/room_discovery.md` (both cited by name/section in body).
**Soundness check:** sound, purely metadata-completeness; no content changes needed since the body text is already correct.

---

### 38. [LOW] `matrix_room_membership.md`'s "Summary: Deny-by-Default Coverage Checklist" still lists the wallet-service card-binding resolver as a live, checked failure mode, contradicting the same document's own superseding note
**Consolidates:** `obj-matrix-synapse.md` Finding 3.
**File(s):** `specs/process_specs/matrix_room_membership.md` (Summary checklist).
**Change:** old: `- [x] Wallet-service card-binding resolver unreachable, erroring, or not-found → deny` → new: strike it, matching the §4 table's treatment: `~~Wallet-service card-binding resolver unreachable...~~ Superseded — see matrix_join_attestation_and_revocation.md §3.3's attestation_invalid and membership_not_registered rows.`
**Soundness check:** sound — the document already made this correction in its §4 table and header note; this just propagates it to the one place it was missed.

---

## Needs David's Direct Decision — RESOLVED 2026-07-16

**A resolved: Position 2 (runtime re-walk).** `protocol-objects.md`'s "Verifier chain walk (runtime)" description is correct and needs no change. `card_verifier.md` gains a `VerifierConfig.appCertificationRoot` field, an `APP_CARD_CHAIN_NOT_TRUSTED` error code, and a new pipeline stage implementing the re-walk; `card_validation.md` step 12 is rewritten to match (runtime re-walk occurs, press's registration-time check is an early gate only, not the final word).

**B resolved: oblivious-relay alone is sufficient.** `app_sdk.md`'s existing design (OQ-SDK-4, `ObliviousProtocolTransport` for `registerCardUuids`) is correct and needs no change. `notification_relay.md`'s Tor-or-equivalent requirement is scoped down to say HPKE/OHTTP oblivious-relay forwarding satisfies it for this call. `oblivious_transport.md`'s "complementary to, and does not substitute for" framing is revised so it doesn't quietly re-open the same contradiction for this specific call.

The two subsections below are retained for the record of what was decided and why; both are now closed.

### A. App-certification chain re-walk at runtime — three-way contradiction (MANDATORY special handling per task brief)

**Source:** `obj-verifier-sdk.md` Finding #1 (HIGH).

**Position 1 — `card_verifier.md` §7.2/§11 + `card_validation.md` Stage 2 step 12 (these two agree with each other):**
The app-card's own certification chain is **not** re-walked at runtime by verifiers. The press validated it once, at `RegisterSubCard` time, and on-chain registration of the sub-card is treated as sufficient proof going forward. Runtime verifiers only check the app-card's *signature* on a given message, not its certification lineage.

**Position 2 — `protocol-objects.md`'s "Verifier chain walk (runtime)" section:**
Every runtime verifier independently re-walks the `app_card`'s `ancestry_pubkeys` chain up to a governance-configured `VerifierConfig.appCertificationRoot`, hard-rejecting with `APP_CARD_CHAIN_NOT_TRUSTED` if the chain doesn't reach that root — regardless of whether a press already accepted the card at registration. This is stated as *the* binding enforcement layer, with the press's own registration-time check explicitly described as merely an "early gate," not the final word.

**What's actually at stake:** whether the protocol has **defense-in-depth** against a compromised or careless press. If a press incorrectly (through bug or compromise) registers a sub-card whose `app_card` traces to an uncertified/wrong root, Position 1 means no runtime verifier will ever catch this after the fact — the bad registration stands as permanently trusted. Position 2 means every runtime verification independently re-checks this and would reject such a card even years after a compromised registration. This is a real, consequential difference in the security model, not a wording nuance.

**Additional evidence this is a genuine unresolved conflict, not stale text on one side:** `protocol-objects.md`'s version depends on two things that don't exist anywhere in `card_verifier.md`: the `VerifierConfig.appCertificationRoot` field, and the `APP_CARD_CHAIN_NOT_TRUSTED` error code. `press.md` and `client_sdk.md` describe achieving something in this space, but only via the general-purpose `trustedRoots` array, and only *at sub-card registration time* — not as an ongoing runtime re-check, which is short of what `protocol-objects.md` describes.

**Decision needed:** either (a) confirm the press-time-only model (Position 1) and have `protocol-objects.md`'s runtime-chain-walk section rewritten/removed to match, or (b) confirm the stronger runtime re-verification is actually intended (Position 2), in which case `card_verifier.md` needs a new config field, a new error code, and a new pipeline stage, and `card_validation.md` step 12 needs rewriting to match.

---

### B. Transport privacy for wallet UUID registration — Tor vs. oblivious-relay (secondary design-decision flag)

**Source:** `obj-app-sdk.md` Finding #1 (see fix-list entry #26 above for the mechanical detail).

**Position 1 — `notification_relay.md` §Process 1 step 6 / §Registration Privacy:**
Wallet-registration sessions (`registerCardUuids`) are required to run over Tor or another anonymizing transport "by default... not an opt-in reserved for users with strong privacy requirements." This was a deliberate recent tightening per the file's own changelog.

**Position 2 — `app_sdk.md` §4.7, §9.3, §15 OQ-SDK-4:**
The same call is implemented via `ObliviousProtocolTransport` (HPKE/OHTTP relay-forwarding, RFC 9180) instead of Tor — OQ-SDK-4 frames this explicitly as "oblivious-relay, not Tor," resolved independently of `notification_relay.md`'s requirement.

**Complicating factor:** `oblivious_transport.md` (the spec defining the HPKE mechanism) already states its own mechanism is "complementary to, and does not substitute for" the Tor-level unlinkability work in `notification_relay.md` — i.e., a third document has already taken a position that neither of the other two fully aligns with, and that framing itself would need revisiting under one resolution path.

**What's at stake:** whether wallet UUID registration sessions get IP-address-level anonymization (Tor-equivalent) at all, or only the narrower content/HPKE-relay privacy `ObliviousProtocolTransport` provides. This is a real privacy-guarantee gap for a specific, security/privacy-sensitive call, not a naming issue.

**Decision needed:** confirm whether `ObliviousProtocolTransport` alone is meant to satisfy `notification_relay.md`'s anonymizing-transport requirement for this call, or whether Tor (or equivalent) must be layered on top of it. Recommend raising alongside item A above since both are auth/privacy-boundary questions rather than editorial fixes.

---

## Changelog

- 2026-07-16: Fix #22 implemented — `card_validation.md`'s "Structured Result" section `revocation.status` enum updated from `"none" | "revoked"` to the 4-value `"not_revoked" | "revoked" | "loud_revocation" | "unknown"`, matching `card_verifier.md §8`'s current `SignatureVerificationResult.revocation.status` type.
- 2026-07-16: Decision A implemented — `card_validation.md` Stage 2 step 12 (and the related Stage 3 step 14 note and the Error Paths table) rewritten to state that runtime verifiers independently re-walk the `app_card`'s certification chain to `VerifierConfig.appCertificationRoot` on every verification, hard-rejecting with `APP_CARD_CHAIN_NOT_TRUSTED` if the chain doesn't reach that root, with the press's registration-time check described as an early gate rather than a substitute — matching `protocol-objects.md`'s "Verifier chain walk (runtime)" mechanics.
