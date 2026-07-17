# Phase 2 Consolidated Fix List — Process Spec Consistency

**Source:** All 15 `plans/spec-consistency/inconsistencies/proc-*.md` Step A review files.
**Process:** Deduplicated overlapping findings (same conflict logged from multiple angles), checked each recommended resolution for a specific file + specific change (no hand-waving), and merged the audit-epoch staleness reports (found independently by 3 of the 15 units) into one entry.

> **Volume flag (per Phase 2 plan, same threshold used in Phase 1):** this list contains **62 distinct routine fix entries** plus **5 items requiring David's direct decision** (67 total post-dedup) — well above the ~15-item pause threshold. Per the Phase 1 precedent, this is being presented in full for David's review/approval rather than blocked on volume alone. The high count is structural, not padding: 15 independent reviewers each cross-checked against ~25 other specs, and most entries are small, mechanical corrections (stale cross-references, step-numbering, field-list omissions) rather than deep design problems — the substantive design-level issues are concentrated in the 5 "Needs Decision" items below plus the merged audit-epoch entry (#11).

---

## Numbered Fix List

1. **`specs/process_specs/message_routing.md`** — Sender-Side Fan-out section and the v0.4 changelog line (four occurrences) state the sender resolves a recipient's sub-card list "from the storage contract." `registry_contract.md` has no such read operation (`active_subcards` lives only in the card's off-chain IPFS log per §2). Change: rewrite these passages to say the sender fetches/decrypts the recipient's current card head from IPFS (via the on-chain `log_head_cid` pointer) and reads `active_subcards` from it.
   *Consolidates: proc-message-routing Finding 1.*

2. **`specs/process_specs/wallet_backup_and_recovery.md`** §Keyring Storage and Replication — claims keyring blobs are broadcast "using the same broadcast channel already used for `CardBindingAnnouncement` fanout." `message_routing.md`'s Wallet Service Registry section never mentions keyring blobs; `wallet.md` §7.5 documents keyring replication as structurally separate endpoints (`POST /federation/keyrings`, `/keyrings/delete`) with their own message shape/verification function. Change: reword to say the keyring broadcast reuses the same **peer list**, not the same channel/endpoint, and cite `wallet.md §7.5` as the actual mechanism.
   *Consolidates: proc-message-routing Finding 2.*

3. **`specs/process_specs/message_routing.md`** §Local Routing Tables, items 1–3 — parenthetical "(design deferred to the wallet service spec)" is stale; the Wallet Service Registry mechanism is fully specified earlier in the same document. Change: remove the parenthetical and cross-reference the §Wallet Service Registry section by name instead of describing it as external/deferred.
   *Consolidates: proc-message-routing Finding 3.*

4. **`specs/process_specs/message_routing.md`** — Peer List table's `endpoint` field description omits that the same base URL is also used for keyring-federation calls (`POST /federation/keyrings`, `/keyrings/delete` per `wallet.md §7.5`). Change: expand the field description to note this additional use.
   *Consolidates: proc-message-routing Finding 4.*

5. **`specs/process_specs/message_routing.md`** — lifecycle gap: no spec'd removal/deregistration of a card's wallet-service binding (only creation and migration exist), and peer-list add/remove has no protocol mechanism at all (signed/broadcast/conflict-resolved), unlike every other state transition in the document. Change: add an explicit sentence stating card bindings are never "removed" outright (only migrated, with card-level revocation handled elsewhere), or specify a removal case if one is intended; note the peer-list-change gap as a known manual/out-of-protocol operational limitation.
   *Consolidates: proc-message-routing Finding 5.*

6. **`specs/object_specs/relay.md`** §7 (and `relay_data_model.md`'s config section) — no `POST /ohttp/{target_id}` endpoint is documented, though `oblivious_transport.md` and `app_sdk.md §4.7` both assume it exists (citing `relay/server/utils/oblivious-targets.ts`, `relay/server/api/ohttp/[target_id].post.ts`). These paths also use the Nitro-style `server/...` convention that `relay.md`'s own v0.9 changelog says was explicitly abandoned in favor of a plain Express app (`relay/src/...`). Change: add the oblivious-forwarding endpoint to `relay.md §7`'s endpoint table and `relay_data_model.md`'s config section using the `relay/src/...` convention; correct the file-path references in `oblivious_transport.md` and `app_sdk.md §4.7` to match. If the endpoint doesn't actually exist yet in the real implementation, flag as a build gap, not just a rename.
   *Consolidates: proc-oblivious-transport Finding 1.*

7. **`specs/object_specs/press.md`** §4 HTTP Endpoints table — missing `GET /ohttp/key-config` and the OHTTP gateway/dispatch endpoint that `oblivious_transport.md` and `app_sdk.md §4.7` (`press/server/api/ohttp/{key-config,gateway}.*.ts`) assume exist. Change: add both endpoints to the table, consistent with press's existing Nitro `server/api/` convention.
   *Consolidates: proc-oblivious-transport Finding 2.*

8. **`specs/process_specs/oblivious_transport.md`** §Overview — lists "sub-card registration/deregistration" and "UUID pool registration/deregistration" as two separate wallet-service categories; per `wallet.md §7.7` they're the same endpoint pair. Change: merge the bullet or explicitly note it's the wallet-service's local UUID-pool bookkeeping, not a separate endpoint.
   *Consolidates: proc-oblivious-transport Finding 3 (minor).*

9. **`specs/process_specs/oblivious_transport.md`** §Request Path — wire format uses `Content-Type: message/ohttp-req`, the RFC 9458 media type reserved for Binary HTTP, despite the same document explicitly rejecting RFC 9458 Binary HTTP encoding two sections earlier. Change: use a custom content-type (e.g. `application/x-card-protocol-ohttp+hpke`) or add a note explaining the non-conformant reuse.
   *Consolidates: proc-oblivious-transport Finding 4 (minor).*

10. **`specs/process_specs/oblivious_transport.md`** §Related Specs — no cross-reference disambiguating this document's OHTTP usage (device↔wallet-service/press) from `card_protocol_spec.md`'s unrelated OHTTP usage (wallet↔requesting-site CHAPI auth flow). Change: add a one-line disambiguating note.
    *Consolidates: proc-oblivious-transport Finding 5 (minor/informational).*

11. **[Merged — audit-epoch/AEK model removal never propagated]** `specs/process_specs/card_offering_and_acceptance.md` (Preconditions; Steps 19–21; Actors table; step 24), `specs/process_specs/log_auditing.md` (entire document), `specs/card_protocol_spec.md` (§"Audit Log Entries", lines ~257, ~378–382, ~607–647), `specs/process_specs/policy_creation.md` (Related Specs line ~120), and `specs/ARCHITECTURE.md` (line 204 artifact-type list) all still describe or reference the retired audit-epoch / Audit Encryption Key (AEK) / ML-KEM key-wrapping model. `press.md §5.6` and `protocol-objects.md §12–13` (Phase-1-fixed) mark this model **Removed**, replaced by direct E2E-encrypted `PressIssuanceRecord` messaging to each `policy.auditors` address (`press.md §5.5`, `protocol-objects.md §11`).
    Change (coordinated, single pass):
    - `card_offering_and_acceptance.md`: drop the audit-epoch precondition; rewrite steps 19–21 to resolve `policy.auditors`, assemble the current `PressIssuanceRecord` shape (`card_cid`, `recipient_pubkey`, `scip_cid`, `issued_at`, `offer_type`), and deliver via E2E message per auditor with timeout/confirmation; add an "Auditor" row to the Actors table distinct from "Administrator"; correct step 24 so only the SCIP courtesy copy goes to the administrator; replace the Postconditions bullet about "the policy's encrypted audit log" with per-auditor notification language.
    - `log_auditing.md`: full rewrite (not archival — the auditor-side receive/confirm/record/inspect flow has no other home). Drop epoch/AEK/ML-KEM/forward-secrecy sections entirely; keep and re-anchor the still-valid card-inspection logic (decrypt, verify predicate compliance, verify `keccak256(recipient_pubkey)` binding, walk `ancestry_pubkeys`); update Related Specs citations from `protocol-objects.md §12/§13` (Removed) to `§11`.
    - `card_protocol_spec.md`: rewrite the "Audit Log Entries" section and line 257 to match the direct-messaging model; this file was not one of Phase 1's 11 units and appears to have been missed rather than deliberately deferred.
    - `policy_creation.md` line ~120: update the `log_auditing.md` gloss from "audit epoch lifecycle" to "direct auditor-notification flow."
    - `ARCHITECTURE.md` line 204: drop "audit epoch entries" from the list of ML-DSA-44-signed IPFS artifact types (`AuditEpochEntry` no longer exists and nothing is posted to IPFS under the new model).
    *Consolidates: proc-card-creation Finding 1; proc-log-auditing Findings 1, 2, 3, 4, 5.*

12. **`specs/process_specs/open_offer_acceptance_existing_wallet.md`** (line ~109) and **`open_offer_acceptance_new_wallet.md`** (line ~125) — still use lowercase `openOfferUseCounts`; `registry_contract.md §3.5` uses PascalCase `OpenOfferUseCounts`, and `open_offer_creation.md` was already fixed (Fix #3/#5) but the two acceptance specs were missed. Change: apply the identical casing fix to both files.
    *Consolidates: proc-card-creation Finding 2.*

13. **`press.md §7`** error table / **`registry_contract.md §8`** / **`protocol-objects.md §7`** / **`open_offer_acceptance_existing_wallet.md`** (step 11) / **`open_offer_acceptance_new_wallet.md`** (step 16) — the same "invalid issuer signature" condition is named `E-14` everywhere except `press.md`, which returns/documents it as `P-05` and never adopted the `E-14` alias in its §7 error table. Change: have `press.md §7` add `E-14` as an explicit alias/cross-reference to `P-05` (returned to callers as `E-14` per `registry_contract.md §8`), rather than editing the process specs to match an internal-only code name.
    *Consolidates: proc-card-creation Finding 3.*

14. **`specs/process_specs/open_offer_creation.md`** (Phase 3, steps 7–9) / **`open_offer_acceptance_new_wallet.md`** (Precondition, step 1) vs. **`wallet.md §1`** (OQ-WALLET-6) and **`press.md §4`** — neither wallet-service nor press defines where an `OpenCardOffer` document is hosted or how a claim link resolves to it, despite both process specs assuming a wallet-service-hosted claim link exists. This is a genuine, currently-undecided design gap (wallet service vs. press vs. new component) — flagging for a decision rather than prescribing an endpoint, but keeping in the routine list (not the "Needs Decision" section below) since it's an architecture placement question, not a security-model question. Change: once decided, add the hosting/claim-link-serving endpoint to whichever component owns it (`wallet.md` or `press.md`), and update both process specs' citations accordingly.
    *Consolidates: proc-card-creation Finding 4 (cross-references wallet.md's own OQ-WALLET-6).*

15. **`specs/process_specs/card_offering_and_acceptance.md`** (Actors table; Phase 1 step 1; Phase 2 step 3) vs. **`protocol-objects.md §1`** (`issuer_card` field notes) — the process spec models "requester" and "issuer/offerer" as potentially different cards (`requester_predicate` evaluated against "the requester's card chain"), but `CardDocument` has no `requester_card` field — only `issuer_card`, which `protocol-objects.md §1` says is what `requester_predicate` is evaluated against. Change: clarify whether requester and offerer are meant to always be the same card (simplify the Actors table's language if so) or whether `protocol-objects.md §1` needs an explicit `requester_card` field; either way, make the Postconditions' silence on re-checking `requester_predicate` an explicit, intentional statement rather than an omission.
    *Consolidates: proc-card-creation Finding 5.*

16. **Minor cluster notes, `proc-card-creation`** (bundle, lower priority): (a) align `card_offering_and_acceptance.md` steps 22–24's ordering with `press.md §5.2`'s actual call order (issuance record before SCIP) once #11 lands; (b) clarify whether `card_signing.md`'s `card_offer`/`card_offer_accepted`/`card_offer_declined` message types are meant to wrap the raw offer/acceptance transmissions in `card_offering_and_acceptance.md` Phase 4, or document them as serving a separate purpose; (c) `specs/messaging_protocol.md` is a first-class dependency of this cluster (`card_signing.md` defers to it for message-type schemas) but isn't in the Phase 2 in-scope list — consider adding it to a future review pass; (d) document the `max_acceptances`/`expires_at` null-to-sentinel encoding (`registry_contract.md §4.5`: null → `type(uint64).max` / `0`) in the process specs, currently only described as "(if set)."
    *Consolidates: proc-card-creation minor/informational notes.*

17. **`specs/process_specs/card_updates.md`** Postconditions — claims "the complete current state of the card" requires a full genesis-to-head walk; `protocol-objects.md §3`'s `card_state` field exists specifically so current field state is obtainable from the head alone. Change: rewrite to state current field state comes from the head `LogEntry`'s `card_state`, while the notes array still requires visiting every entry (via `history`, in parallel — see #20).
    *Consolidates: proc-card-updates Finding 1.*

18. **`specs/process_specs/card_updates.md`** step 9 — `LogEntry` assembly steps omit `entry_type`, `card_state`, and `history` (all Required per `protocol-objects.md §3`) and the precondition of fetching/decrypting the current head first. Change: rewrite step 9 to mirror `press.md §5.3`'s already-updated `appendLogEntry`: fetch+decrypt current head → assemble `version`, `code`, `entry_type` (derived from code range), `prev_log_root`, `history` (prior head's `history` + its own CID), `card_state` (prior field state with `field_updates` applied), `field_updates`/`revocation`, `notify_holder`, `updater_message`, `intent_signature` → `press_signature`.
    *Consolidates: proc-card-updates Finding 2.*

19. **`specs/process_specs/card_updates.md`** step 11 — "signed with the press sub-card key" conflates the press's two distinct keys (ML-DSA-44 IPFS identity key used for the `LogEntry`'s `press_signature` in step 9, vs. the separate secp256r1 on-chain write-authorization key used for `UpdateCardHead`, per `protocol-objects.md §1`'s "Press dual-key model" and `registry_contract.md §4.2`). Change: split step 11 into two named operations — posting the (already ML-DSA-44-signed) `LogEntry` CID to IPFS, and calling `UpdateCardHead` authorized by the separate secp256r1 key.
    *Consolidates: proc-card-updates Finding 3.*

20. **`specs/process_specs/card_updates.md`** §Notes Array — describes a sequential genesis-to-head walk; with `history` now on the head (per `protocol-objects.md §3`), a reader fetches the head once and can fetch all predecessor CIDs in parallel. Change: update the mechanism description accordingly (the notes array still requires visiting every entry — that part of the claim stands — only the "sequential walk" framing is stale).
    *Consolidates: proc-card-updates Finding 4.*

21. **`specs/process_specs/card_updates.md`** §Sub-Card Directory Updates (Codes 510/511/512) — omits `press.md §5.3`'s `subcard_sibling_added`/`subcard_sibling_removed`/`subcard_sibling_rotated` notification behavior to the holder's other active sub-cards. Change: add a cross-referencing note so the process spec for these codes is complete on its own.
    *Consolidates: proc-card-updates Finding 5.*

22. **`specs/process_specs/card_updates.md`** §Concurrency and Error Paths table — describes the race as "the intent will reference a stale `prev_log_root`," but `UpdateIntentPayload` never carries `prev_log_root` (confirmed by the document's own Phase 1 step 2 example and `protocol-objects.md §4`). Change: reword to describe the actual race — the press re-fetches a now-stale head at validation time, or the on-chain `prev_log_cid` check in `UpdateCardHead` (`registry_contract.md §4.2` step 5) fails — not the updater's intent going stale.
    *Consolidates: proc-card-updates Finding 6.*

23. **`specs/process_specs/policy_creation.md`** (Error Paths/Postconditions) or **`card_updates.md`** (Revocation Semantics) — neither spec, nor `card_validation.md`, states what happens to already-issued cards when the *policy card itself* is later revoked via 8xx/9xx (as distinct from a policy being found non-compliant, which `card_validation.md` Stage 5a does cover). Change: add an explicit statement that a revoked policy card (a) blocks new issuance under it — the press must check for policy-card revocation during the pre-flight/issuance steps already listed — and (b) does not retroactively invalidate already-issued cards, mirroring the `PressAuthorizations`-revocation treatment in `card_validation.md` lines 99–103.
    *Consolidates: proc-policy Finding 1.*

24. **`specs/process_specs/policy_creation.md`** step 2 AND **`specs/process_specs/card_updates.md`** step 7 — both field-name-collision/"immutable fields" lists are missing several protocol-required/reserved fields from `protocol-objects.md §1`/§1.1 (`ancestry_pubkeys`, `protocol_version` missing from both lists; `past_keys`, `active_subcards`, `successor`, `supersedes`, `supersession_note` missing from `policy_creation.md`'s list). Change: update both lists to the complete set: `policy_id, issuer_card, press_card, recipient_pubkey, issued_at, issuer_signature, holder_signature, press_signature, ancestry_pubkeys, past_keys, protocol_version, active_subcards, successor, supersedes, supersession_note`.
    *Consolidates: proc-policy Finding 4.*

25. **`specs/process_specs/policy_creation.md`** steps 6–7 — narrative skips directly from "administrator countersigns" to "posted to IPFS," omitting the press's mandatory validation/`press_signature` step that `card_offering_and_acceptance.md` step 17 (the flow `policy_creation.md` step 5 cites as authoritative) places between them. Change: inline a one-line summary of the press validation/signing step, or make the deferral to `card_offering_and_acceptance.md` step 17 explicit.
    *Consolidates: proc-policy Finding 5.*

26. **`specs/process_specs/card_validation.md`** step 25 vs. **`card_verifier.md §7.8`**'s `NonComplianceReport` — the two specs require materially different report contents: `card_validation.md` requires the full `SignedMessageEnvelope` plus a verifier-identity field "so the body can authenticate the report source"; `card_verifier.md` attaches the raw IPFS card document + CID instead and, per its §13 Decision 5, deliberately left the report unauthenticated for v1 (signed reports deferred to v2). Change: update `card_validation.md` step 25 to match `card_verifier.md`'s actual v1 `NonComplianceReport` fields, dropping the verifier-identity requirement (or explicitly deferring it to v2, consistent with Decision 5) — `card_verifier.md` is the more recent, concrete implementation spec.
    *Consolidates: proc-card-validation Finding 2.*

27. **`specs/process_specs/card_validation.md`** "Structured Result (Per Signature)" schema — missing `chain_card_addresses`, `log_updates`, `press_subsequently_revoked`, and `errors`, all present in `card_verifier.md §8`'s `SignatureVerificationResult` for the same pipeline. Change: add these four fields to `card_validation.md`'s schema, or add a note that the process spec is deliberately conceptual/partial and point to `card_verifier.md §8` as the concrete schema.
    *Consolidates: proc-card-validation Finding 3.*

28. **`specs/process_specs/card_validation.md`** Stage 2 (steps 5–6) — lacks explicit hard-reject language and Error Paths rows for (a) sub-card/leaf document decryption failure and (b) signer's `CardEntry` not found on-chain, both of which `card_verifier.md §7.2` documents as explicit hard-rejects (`DECRYPTION_FAILED`, `CARD_NOT_FOUND`). Change: add both as explicit hard-rejection steps and Error Paths rows in `card_validation.md`.
    *Consolidates: proc-card-validation Finding 4.*

29. **`specs/object_specs/card_verifier.md §7.2`** — steps 13/14 record `scope_clean: true` *before* the app-certification chain re-walk (step 14) runs, which can still hard-reject; the overwrite-on-failure behavior is only implied, never stated. Change: renumber so `scope_clean: true` is recorded only after the app-cert chain walk (step 14) completes — swap or merge steps 13/14.
    *Consolidates: proc-card-validation Finding 5.*

30. **`specs/object_specs/card_verifier.md §7.3`** — no counterpart to `card_validation.md` step 15's "cached chain array" parallelization hint and its discrepancy-resolution rule ("per-link on-chain addresses are authoritative"). Change: add the cached-chain-array behavior and discrepancy rule to `card_verifier.md §7.3`, or add a note that it's an `IpfsProvider`-level optimization intentionally not exposed as a caller-visible input.
    *Consolidates: proc-card-validation Finding 6.*

31. **`specs/process_specs/subcard_creation_policy.md`** (Formal Policy Expression notes) — defines `is_issuer` as matching "the application," conflicting with `card_protocol_spec.md`'s canonical predicate definition ("`is_issuer` = the issuer (press) of the card being updated"). This collides with every other policy's default `field_definitions`/`revocation_permissions` use of the standard (press) meaning. Change: resolve which meaning is correct — if `subcard_creation_policy.md`'s app-centric meaning is intended, it needs a distinct predicate name (not a reuse of `is_issuer`); if `card_protocol_spec.md`'s "(press)" parenthetical is itself the error (should read "(offerer)"), that's a Phase-1 object-spec correction reopened. Flag to whoever owns `card_protocol_spec.md`'s predicate-system section for the final call, since it affects predicate resolution protocol-wide.
    *Consolidates: proc-subcard Finding 3.*

32. **`specs/subcards.md`** — scope gap: the actual sub-card creation/acceptance flow lives entirely in this root-level file, which is outside both the Phase 1 object-spec list and the Phase 2 process-spec list, meaning it received no formal Step A review despite `subcard_creation_policy.md` deferring to it explicitly for "how sub-cards are established." Change: add `specs/subcards.md` to the in-scope list for a follow-up review pass (Phase 3 or a supplemental pass), and record in the Phase 2 milestone summary why it fell outside formal scope.
    *Consolidates: proc-subcard Finding 4.*

33. **[Merged]** `specs/process_specs/dns_governance_verifier.md` (entire file) and `specs/subcards.md §Step 5` are both silent on the DNS-admin-card secp256r1 sub-card authorization mechanism (`AdminAuthorizeSubCardPayload`/`admin_secp_payload`/`admin_secp_signature`, `DnsAdminCardKeys`, error `E-47`) that `registry_contract.md §3.11/§4.3` and `press.md §5.4` require whenever a sub-card's master is a DNS admin card. Change:
    - `dns_governance_verifier.md`: add cross-reference in Script A that the collected `secp256r1_pubkey` is written to `DnsAdminCardKeys` via `RegisterDomain` and later checked by `RegisterSubCard`'s RIP-7212 verification; add a subsection documenting the operational flow for a domain admin delegating a sub-path-scoped sub-card (who produces `AdminAuthorizeSubCardPayload`, how it reaches the press per `press.md §5.4`, what happens on `E-47`); note in Script B that deactivating a domain admin card also zeroes its `DnsAdminCardKeys` entry.
    - `specs/subcards.md §Step 5`: update the still pre-Fix-#2 registration-call narrative to mention the admin secp256r1 co-signature path (or explicitly scope it out and point to `press.md §5.4`/`registry_contract.md §4.3`).
    *Consolidates: proc-dns Finding 1; proc-subcard Finding 5.*

34. **`specs/object_specs/protocol-objects.md §16`** — `SubCardDocument`'s field table has no `dns_path_scope` field, though `registry_contract.md §4.19` and `dns_governance_verifier.md` Script C both treat it as an established field. Change: add `dns_path_scope` (optional regex string, present only for DNS-admin-delegated sub-cards) to the `SubCardDocument` schema, or define a DNS-specific extension object if `SubCardDocument` should stay DNS-agnostic.
    *Consolidates: proc-dns Finding 2.*

35. **`specs/process_specs/dns_governance_verifier.md`** — Script B's precondition ("the requester has completed TXT verification... generating their new domain admin card," implying Script A's `RegisterDomain` has already succeeded) contradicts `registry_contract.md §4.17` precondition 4, which blocks `RegisterDomain` while the domain still has an active (old) admin — and contradicts Script B's own closing note that Script A's `RegisterDomain` runs *after* Script B. Change: split Script A into two callable stages — card issuance (`RegisterCard`, no dependency on domain state) and `RegisterDomain` (must run after Script B's `DeregisterDomain`) — and correct Script B's precondition to say only "the new admin card has been issued," not "domain registered."
    *Consolidates: proc-dns Finding 3.*

36. **`specs/process_specs/dns_governance_verifier.md`** shared environment variables — defines a single `DNS_GOV_PRIVATE_KEY` and signs with it singularly, but `registry_contract.md §3.6` describes `DnsGovernanceBody` as designed to grow past 1-of-1 via `RotateGovernanceKeys`, with every write op accepting a `governance_sigs[]` array sized to quorum. Change: either scope this spec explicitly to the 1-of-1 bootstrap phase (noting multi-key quorum submission as a follow-up), or add a mechanism for assembling `governance_sigs` from multiple operators.
    *Consolidates: proc-dns Finding 4.*

37. **`specs/process_specs/dns_governance_verifier.md`** Script C — alternates between `GovernanceSetPolicyAddress` (step 2) and `RemovePolicyAddress` (steps 4/5) for what `registry_contract.md §4.23` states is an equivalent clearing operation. Change: standardize on one call (likely `RemovePolicyAddress`'s governance path) across all of Script C's clearing actions.
    *Consolidates: proc-dns Finding 5 (low).*

38. **`specs/process_specs/dns_governance_verifier.md`** Script C step 5 (line ~263) — names the parameter `suspension_expiry`; `registry_contract.md §3.8/§4.22` uses `suspension_expires_at` throughout. Change: align the naming.
    *Consolidates: proc-dns Finding 6 (low).*

39. **`specs/process_specs/subcard_creation_policy.md`** 8xx code table — restates `update_codes.md`'s canonical descriptions in different words without citing it as the source, contrary to `update_codes.md §Adding New Codes` step 3's instruction that referencing specs cite it for traceability. Change: add the citation.
    *Consolidates: proc-subcard Finding 6 (minor).*

40. **`specs/process_specs/subcard_creation_policy.md`** — never mentions `capabilities`/`limitations` (defined in `protocol-objects.md §16`/`specs/subcards.md`) or clarifies they're immutable post-issuance by the same logic that bars 1xx–7xx field changes. Change: add a one-line cross-reference/clarification.
    *Consolidates: proc-subcard Finding 7 (minor).*

41. **[Merged]** `specs/process_specs/matrix_join_attestation_and_revocation.md §2`'s header still says the join sequence is "Triggered the same way as before — Synapse's `user_may_join_room` callback," contradicting the same document's own §1 "Wire transport — resolved 2026-07-12" note and `matrix_synapse_module.md`'s explicit description that `user_may_join_room` is now a permissive no-op and real authorization runs in `check_event_for_spam`. Change: reword §2's opening line to name `check_event_for_spam` (observing an `m.room.member` join event) as the triggering callback, and update the "Creator auto-join" paragraph immediately below to reference the same callback.
    *Consolidates: proc-matrix-join Finding 1; proc-matrix-membership Finding 3 (independently found from the companion-document side).*

42. **`specs/process_specs/matrix_join_attestation_and_revocation.md`** §2/§2a — gap: no rule for server-administrator joins (distinct from room-creator auto-join, which §2 does cover). Per `matrix_synapse_module.md`'s "Known limitation" note, neither Synapse callback fires for admin-forced joins, so such a join would produce no membership-registry entry and every subsequent post would be denied (`membership_not_registered`) — but the spec never says whether that's intended. Change: add an explicit rule — either disallow admin-forced joins into card-gated rooms operationally, or state plainly that the resulting denial-on-next-post is accepted, deliberate behavior.
    *Consolidates: proc-matrix-join Finding 2.*

43. **`specs/object_specs/matrix_synapse_module.md`** §"check_event_for_spam" — cites `matrix_room_membership.md §2` for the post-time `card_hash`-from-registry-lookup behavior; that behavior is actually defined by `matrix_join_attestation_and_revocation.md §2a`, and `matrix_room_membership.md §2` is the superseded section describing the old mechanism. Change: update the citation to point to `§2a` (directly, or alongside `matrix_room_membership.md §2` labeled as superseded structure).
    *Consolidates: proc-matrix-join Finding 3.*

44. **`specs/process_specs/matrix_join_attestation_and_revocation.md`** header — still reads `Version: 0.1 (draft)` / `Date: 2026-07-11` despite containing content explicitly dated/resolved 2026-07-12 (wire transport, force-part mechanism). Change: bump to `0.2 (draft, amended 2026-07-12)` with a summary note, matching the convention in `matrix_room.md`/`matrix_synapse_module.md`.
    *Consolidates: proc-matrix-join Finding 4 (minor).*

45. **`specs/process_specs/matrix_room_membership.md §2`** "Post Sequence" step 1 — the document's own 2026-07-11 amendment note flags this text as stale ("Steps 1–6 above, identical" no longer holds), but the body text itself was never edited and still instructs re-running the now-defunct wallet-service resolver step. Change: edit step 1's body text directly to say steps 3–6 (not 1–6) are re-run for posts, and that step 2 (`card_hash` resolution) is replaced by a membership-registry lookup keyed by `(room_id, event.sender)` per `matrix_join_attestation_and_revocation.md §2a` — don't rely solely on the header caveat.
    *Consolidates: proc-matrix-membership Finding 1.*

46. **`specs/process_specs/matrix_room_membership.md §1` step 2 and §3** — superseded content is marked with a bold `**[Superseded 2026-07-11]**` tag followed by full un-struck prose that reads as normative on a skim, unlike §4/the Summary checklist which use `~~strikethrough~~`. Change: apply one consistent convention (strikethrough, or a short "see companion doc" pointer replacing the body) across all four superseded locations.
    *Consolidates: proc-matrix-membership Finding 2.*

47. **`specs/process_specs/matrix_room_membership.md`** "Summary: Deny-by-Default Coverage Checklist" — doesn't enumerate the new failure modes introduced by `matrix_join_attestation_and_revocation.md §3.3` (`attestation_invalid`, `membership_not_registered`, encrypted-registry-unreadable-at-startup), only points to §3.3 generically for the superseded row. Change: either add the new failure-mode bullets, or replace the checklist with a note that the current authoritative deny-by-default list is `matrix_join_attestation_and_revocation.md §3.3` plus this document's non-superseded rows.
    *Consolidates: proc-matrix-membership Finding 4.*

48. **`specs/process_specs/room_discovery.md`** Overview — claims "room membership" itself is meant to be private, attributing this to `card_protocol_spec.md`'s general stance; `matrix_room.md §What the Synapse Operator Can See` cites the identical source but states the narrower claim ("only message content is private") and its own visibility table lists room membership as **visible** to the operator — only the `card_hash`↔Matrix-user-ID binding is protected. Change: reword `room_discovery.md`'s Overview to match `matrix_room.md`'s exact framing, or if the intent was the binding specifically, say so explicitly.
    *Consolidates: proc-room-discovery Finding 1.*

49. **`specs/object_specs/wallet_sdk.md`** and/or **`app_sdk.md`** — gap: `room_discovery.md §2`/§3 repeatedly assigns `discoverRooms()` and local-first/server-fallback responsibility to "client SDKs," but neither SDK spec defines any such function, endpoint client, or fallback-detection logic. Change: add a short subsection to one or both SDK specs defining the `discoverRooms`-equivalent API surface, or add a line to `room_discovery.md` clarifying it's a reference algorithm apps may implement directly rather than a guaranteed SDK primitive.
    *Consolidates: proc-room-discovery Finding 2.*

50. **`specs/object_specs/matrix_synapse_module.md`** companion-document list — omits `room_discovery.md` despite `room_discovery.md §2` step 3b depending substantively on `predicates.py`'s exact evaluation semantics staying in sync with a client-side reimplementation. Change: add `room_discovery.md` to the companion list and note near the `predicates.py` entry that its semantics are also relied on client-side.
    *Consolidates: proc-room-discovery Finding 3 (minor).*

51. **`specs/process_specs/card_migration.md`** §In-Flight Messages During Migration — the "410 Gone with no forwarding hint" branch doesn't follow from the document's own model (§6 says the old wallet service only starts rejecting traffic *after* processing the announcement, so pre-processing it should just accept normally) and is unimplemented (`wallet.md §7.6/§8` document only the one `410` shape, always with a hint). Change: remove the unsupported branch, or if a genuine hint-less scenario is intended, specify it explicitly and add a matching response shape to `wallet.md §7.6/§8`.
    *Consolidates: proc-card-migration Finding 1.*

52. **`specs/object_specs/wallet.md §6.5/§7.5`** — documents verification of only the `wallet_service`-role signer for `card_migration`-type `CardBindingAnnouncement`s; `card_migration.md §3/§5` requires peers to verify **two** signatures (`wallet_service` and `cardholder`, the latter possibly via sub-card-chain resolution), but `wallet.md` never describes verifying the cardholder signature or resolving a sub-card chain. Change: add cardholder-signature verification (including the sub-card-chain case) to `wallet.md §6.5` or a new subsection, and update §7.5's endpoint description to cite it.
    *Consolidates: proc-card-migration Finding 2.*

53. **`specs/process_specs/message_routing.md §Binding Announcements`** — its cardholder-signer verification rule only covers the direct-master-key case (`keccak256(public_key) == card_hash`); `card_migration.md §3/§5.3` treats sub-card-chain-resolution as a first-class alternative for the `cardholder` signer, but `message_routing.md` (the sole normative definition of this verification) doesn't acknowledge it. Change: update `message_routing.md`'s rule to explicitly allow the sub-card-chain case (mirroring `card_migration.md §5.3`'s wording), or have `card_migration.md` state plainly that it extends `message_routing.md`'s rule rather than assuming it's already covered.
    *Consolidates: proc-card-migration Finding 3.*

54. **`specs/process_specs/notification_relay.md`** — three stale `(Process 5)` cross-references (lines ~200, ~205, ~301) should read `(Process 6)`, since "Staggered Wallet Clearance" was renumbered to Process 6 when Process 4 (Device-Level SSE) was inserted; one reference (line 336) already correctly says Process 6. Change: fix the three stale references.
    *Consolidates: proc-notification-relay Finding 1.*

55. **`specs/process_specs/notification_relay.md §"UUID Pools and Device Credential"`** (line ~66) — states the device credential authenticates only `GET /sse` and `GET /pending`; `relay.md §6.1` and this same document's own Process 4/5 steps also show it authenticating `POST /ack`. Change: expand the sentence to list all three endpoints.
    *Consolidates: proc-notification-relay Finding 2.*

56. **`specs/process_specs/wallet_backup_and_recovery.md`** §Process 3 "Post-Recovery Re-registration" (steps 10–13) — never mentions the device performing `notification_relay.md §Process 1` (UUID registration) for newly-registered device sub-cards; without it, a device completing recovery would have an active on-chain sub-card but no UUID pool at any wallet service and wouldn't receive messages. Change: add a step directing the device to run UUID registration for each new sub-card, or add a note explicitly deferring to `notification_relay.md §Process 1` if considered implicit.
    *Consolidates: proc-notification-relay Finding 4.*

57. **`specs/object_specs/relay.md §2`** Relationship to Existing Specs table — credits `wallet_backup_and_recovery.md` with "UUID pool replenishment lifecycle" coverage; that document contains no mention of UUID pools, `push_token`, or `device_credential` (confirmed by grep). Change: remove that clause from the table row, or (paired with #56's fix) make it true by adding the missing cross-reference to `wallet_backup_and_recovery.md`.
    *Consolidates: proc-notification-relay Finding 5 (low).*

58. **`specs/object_specs/wallet_sdk.md §5.3`** — Fix #32's reordering is correct, but the prose still cites "(Steps 11–13)" for the optional YubiKey backup step; per `wallet_backup_and_recovery.md`, Steps 11–13 are synced-passkey backup registration and Steps 14–15 are YubiKey. Change: correct the citation to "(Steps 14–15)".
    *Consolidates: proc-wallet-backup Finding 1.*

59. **`specs/process_specs/wallet_backup_and_recovery.md`** — Process 3 restarts its step numbering at 10, duplicating Process 2a's own step 10 (a different step, same number, same document) — a latent citation hazard given Finding 58 already shows one such citation slipping through. Change: renumber Process 3 to start at 1 (or otherwise make clear its numbering is independent of Process 2a/2b's).
    *Consolidates: proc-wallet-backup Finding 2.*

60. **`specs/process_specs/wallet_backup_and_recovery.md`** Process 1 (Steps 3–6) and Process 3 (Step 10) — describe wallet/keyring bootstrap and re-registration as a single linear pass; `wallet.md §7.2–7.3` and `wallet_sdk.md §5.3/§5.6` describe an actual two-call sequence (initial call with a provisional keyring blob → derive real `decryption_key` → re-encrypt → second call with `rotate_service_secret: false` to install the final blob), needed specifically to avoid an unwanted second `service_secret` rotation. Change: update both process-spec sections to describe the real two-call bootstrap/re-registration sequence.
    *Consolidates: proc-wallet-backup Finding 4.*

61. **`specs/process_specs/wallet_backup_and_recovery.md`** Error Paths table, "Recovery completed by attacker before holder notices" row — says "Holder must issue 910... revocations," but `card_updates.md §Phase 3 Step 7`'s default authorization rule is 9xx-by-issuer-only absent a policy override; a holder cannot unilaterally post a 910 revocation under the default model. Change: reword to say the holder must *request* a 910 revocation from each policy's issuer under the default model, or note this depends on the specific policy's `revocation_permissions`.
    *Consolidates: proc-wallet-backup Finding 5.*

62. **`specs/process_specs/wallet_backup_and_recovery.md`** Process 3 Step 12 — labels sub-card revocation for a lost device as code "811 — lost or stolen," but `subcard_creation_policy.md`/`wallet_sdk.md §6.4` define 811 as the benign/cooperative code (app uninstalled/device retired) and 810 as the suspected-key-compromise code, which is the more likely scenario motivating a recovery flow. Change: select the code based on actual scenario (811 if no suspicion of key extraction, 810 if compromise is suspected), or split Step 12 into two cases; at minimum drop "or stolen" from the 811 label.
    *Consolidates: proc-wallet-backup Finding 6.*

---

## Needs David's Direct Decision

These five findings are not routine fixes — each requires a decision about the intended design or security model before any file gets edited, per the Phase 2 plan's caution for security-relevant or trust-boundary-affecting gaps.

### (a) Does sub-card verification actually need to check `capabilities`, `valid_until`, and `attestation_level`, or is this an intentional scope boundary?

`protocol-objects.md §16` (the authoritative 12-step runtime verifier-chain-walk procedure) lists confirming a sub-card's `capabilities` covers the signed message type (step 1), confirming `valid_until` hasn't passed (step 2), and confirming `attestation_level` satisfies the governing policy (step 11) as `must`-level requirements. **Neither `card_validation.md` Stage 2 nor `card_verifier.md §7.2`** implements any of these three checks — confirmed by grepping both files for `capabilities`, `valid_until`, and `attestation_level`, with zero matches in either. This was found independently by the `proc-card-validation` review (which cross-checked both process- and object-level verification specs against `protocol-objects.md §16` directly) — a check Phase 1's `card_verifier.md`-only review didn't catch, since it wasn't cross-referenced against §16 for this specific point at that time.

**What's at stake:** if this is a real gap, a sub-card whose `capabilities` don't cover the message type it signed, or whose `valid_until` has passed, or whose `attestation_level` is below what the governing policy requires, would currently pass verification in both the reference process spec and the concrete npm implementation spec — a message-type/expiry/attestation-level bypass. If some other layer is intended to catch this (e.g., a policy-evaluation stage not modeled in either document), that needs to be named explicitly; otherwise both `card_validation.md` Stage 2 and `card_verifier.md §7.2` need a new pipeline stage added, matching `protocol-objects.md §16` steps 1, 2, and 11.

*Source: proc-card-validation Finding 1.*

### (b) Who is actually authorized to revoke a sub-card — the app/sub-card itself, or only the holder's master key?

`subcard_creation_policy.md` (§Revocation — 8xx) and `notification_relay.md`'s comparison table both state that **either** the user's active sub-card **or** the application's installation card can sign an 8xx revocation directly. But `registry_contract.md §4.4 DeregisterSubCard` requires an ML-DSA-44 signature from the **master card holder key specifically** (verified off-chain by the press), and `specs/subcards.md §Authorization for Deregistration` states explicitly that sub-card keys "cannot unilaterally deregister themselves" and that an app wanting to revoke its own sub-card "must request deregistration through the press, which requires the holder's primary key to be available" — excluding both the app and the sub-card's own key. Verifier-side, `card_validation.md`/`protocol-objects.md §16` only trust the on-chain `SubCardEntry.active` flag (settable only via master-key-authorized `DeregisterSubCard`).

**What's at stake:** if the weaker model (app or sub-card can self-revoke) is actually implemented anywhere in the codebase, that is a privilege-escalation-shaped bug — it would let a compromised or malicious app terminate a user's sub-card, or let a sub-card revoke itself, in ways the on-chain contract is specifically designed to prevent. If the master-key-only model is the correct one (as `registry_contract.md` and `subcards.md` state), then `subcard_creation_policy.md` and `notification_relay.md` need their revocation-authority language corrected to describe the app's role as *requesting/triggering* revocation (which the wallet, holding the primary key, must countersign and submit) rather than granting the app or sub-card independent revocation authority.

*Source: proc-subcard Finding 2 (echoed in notification_relay.md's comparison table).*

### (c) Does a policy-authorizer self-issuance path (bypassing the press) actually exist, and how is the trust-root policy bootstrap supposed to work?

`policy_creation.md` step 8 states the genesis on-chain registration for a policy card is "signed by the press sub-card key acting on behalf of the authorizer (**or directly by the authorizer if self-issuing**)." This carve-out has no basis anywhere else in the Phase-1-fixed specs: `protocol-objects.md §1` lists `press_card`/`press_signature` as Required on every `CardDocument` including policy cards (§2), `card_offering_and_acceptance.md` states its flow applies to "all targeted cards including policy cards" with no self-issuance branch, and `registry_contract.md §4.1 RegisterCard`'s only caller is a press authorized under `PressAuthorizations` — there is no contract path for an authorizer to submit `RegisterCard` directly.

Separately, and closely related: `registry_contract.md §4.1` precondition 2 requires `policy_address` to already exist in `PolicyAuthorizerKeys`, populated only by `RegisterPolicy` (§4.6) — a **governance-quorum operation** performed by a Root Policy Governance Body using secp256r1 signatures, entirely distinct from the press-mediated "Draft → Authorize → Publish → Press Registration" flow `policy_creation.md` describes. `policy_creation.md` never mentions this precondition, never identifies who the "Root Policy Governance Body" is or how it relates to the "authorizer" role in its own Actors table, and never mentions the authorizer needing a second, distinct on-chain secp256r1 key (the "dual-key model" `protocol-objects.md §1` currently documents only for presses).

**What's at stake:** either (1) a genuine self-issuance path for root/bootstrap policies is intended, in which case it needs a full mechanism specified end-to-end — a contract entry point and an explicit, scoped exception to the 3-signature `CardDocument` requirement — not a single unsupported sentence in `policy_creation.md`; or (2) the self-issuance clause is simply wrong and every policy card, including the very first root policy, must be issued through a press already authorized under some pre-existing meta-policy, with the first root policy's bootstrap handled as a one-time governance/deployment step that `policy_creation.md` currently doesn't describe at all. Either resolution touches the trust-root bootstrap security model and shouldn't be decided by a fix-implementation agent.

*Source: proc-policy Findings 2 and 3 (the reviewing agent explicitly recommended treating these as one cross-referenced decision).*

### (d) Do sub-cards need a policy-attachment mechanism that doesn't currently exist, or does `subcard_creation_policy.md` need to be rewritten to describe something other than a standard policy card?

`subcard_creation_policy.md` presents itself as a governing policy card whose `revocation_permissions` and `field_definitions` predicates are enforced by the press "mechanically at update time" against intents targeting the sub-card itself. But `SubCardDocument` (`protocol-objects.md §16`) has **no `policy_id` field** — unlike every other card type — and sub-cards are registered on-chain as `SubCardRegistrations[sub_card_address] → SubCardEntry` (`registry_contract.md §3.4`), a mapping structurally separate from the `CardEntry` mapping that policy-governed cards use. The generic update pathway `subcard_creation_policy.md` implicitly relies on (`press.md §5.3`'s "resolve the target card's policy from the on-chain `CardEntry`") literally cannot run for a sub-card, since a sub-card has no `CardEntry`. Verifier-side, neither `protocol-objects.md §16` nor `card_validation.md` Stage 2 reads a sub-card's own append-only log for 8xx/9xx or `notes` entries at all — the only verifier-facing sub-card state is the on-chain `SubCardEntry.active` flag and the master card's `active_subcards` directory.

**What's at stake:** either (1) `SubCardDocument`/`SubCardEntry`/`press.md §5.3` need a policy-attachment mechanism added for sub-cards (a `policy_id`-equivalent field, a resolution path, and a verifier-facing effect for sub-card-log entries) so the enforcement model `subcard_creation_policy.md` describes can actually attach to something; or (2) the "policy enforcement" framing in `subcard_creation_policy.md` needs to be rewritten to describe what actually governs sub-cards today — purely the app-certification chain plus `capabilities`/`limitations` set at issuance, with no separate policy object in the loop. This is a structural question about whether a described mechanism exists at all, not a wording fix.

*Source: proc-subcard Finding 1.*

### (e) Confirming the object specs are authoritative for push-token-rotation recovery (flagged for visibility, not because the answer is unclear)

`notification_relay.md`'s Failure Handling table, "Push token rotated by platform" row, states the relay "issues new device credential" on rotation. `relay.md §6.3`'s Credential Lifecycle table and `relay_data_model.md §8.3` (both Phase-1-fixed and authoritative) are explicit and mutually consistent that replenishment (`POST /register` with the existing credential) keeps the same credential and only updates the `push_token` field in place — no new credential is issued, and nothing about a push-token rotation invalidates already-registered UUIDs.

**What's at stake:** an implementer following only `notification_relay.md`'s Failure Handling table would build a more disruptive, security-relevant recovery flow (full re-bootstrap with a new credential) than the object specs actually call for. Per the same caution used for the analogous Phase 1 item, this is flagged for explicit sign-off even though the correct answer is reasonably clear (the more-recently-fixed object specs should win): update `notification_relay.md`'s row to describe replenishment-in-place under the existing credential, dropping the "new credential"/"fresh UUIDs to all wallet services" language.

*Source: proc-notification-relay Finding 3.*
