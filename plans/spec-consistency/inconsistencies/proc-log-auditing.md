# `proc-log-auditing` — Inconsistency Findings

**Unit:** `specs/process_specs/log_auditing.md`
**Reviewed against:** `press.md` (§5.5, §5.6, §9 Open Questions), `protocol-objects.md` (§11 PressIssuanceRecord, §12 AuditEpochEntry, §13 AuditEpochCommitment), `card_protocol_spec.md`, `ARCHITECTURE.md`, `policy_creation.md`, `card_updates.md`, `card_offering_and_acceptance.md`, `message_routing.md`.

---

## Finding 1 [PRIMARY / HIGH] — `log_auditing.md` describes an entirely superseded model and needs a full rewrite or archival, not a patch

**Confirmed.** `log_auditing.md` (all of it — Overview, Actors, Preconditions, Process 1 "Opening an Epoch", Process 2 "Auditing and Closing an Epoch", Process 3 "Special Close Triggers", Postconditions, Acceptance Criteria, Forward Secrecy Boundary, Error Paths) describes the old **audit-epoch / Audit Encryption Key (AEK) / ML-KEM key-wrapping** model in full mechanical detail: epoch open/close lifecycle, `AuditEpochEntry`, `AuditEpochCommitment`, `ML-KEM.Encaps`/`Decaps`, per-epoch AES-GCM encryption of `PressIssuanceRecord`, AEK destruction for forward secrecy, epoch-close triggers on auditor key rotation/add/remove.

This model is explicitly retired:
- `press.md` §5.6 "Audit Epoch Management": **"Removed. Audit epochs and ML-KEM-based AEK distribution are replaced by direct auditor messaging (see §5.5). Auditors maintain their own records of issuance notifications received from the press."**
- `press.md` §5.5 `appendIssuanceRecord` now defines the actual current flow: the press assembles a `PressIssuanceRecord` and, "For each card address in `policy.auditors`, send[s] the `PressIssuanceRecord` as an E2E encrypted message via the normal message routing layer (HTTPS to the auditor's wallet service endpoint, encrypted to the auditor card's public key)," awaits per-auditor confirmations (default 30s timeout), and records confirmed/timed-out auditors in local KV state only (not IPFS). No epoch, no AEK, no shared-secret wrapping.
- `press.md` §9 Open Questions, OQ-A1: **"Closed. Auditor key distribution via ML-KEM is replaced by direct E2E messaging... the press messages each auditor at issuance time using the normal routing layer."** OQ-A3: **"Closed (no longer applicable). AEK recovery is not needed — there is no AEK. The press does not hold any epoch key material."**
- `protocol-objects.md` §11 `PressIssuanceRecord`: "Delivered by: Press, via E2E encrypted message to each card address in `policy.auditors`... The `PressIssuanceRecord` is delivered directly to each auditor card address listed in `policy.auditors` via E2E encrypted message using the normal message routing layer. Auditors maintain their own local records of issuance notifications received from the press." The object itself is a flat, unencrypted-at-rest plaintext record (`card_cid`, `recipient_pubkey`, `scip_cid`, `issued_at`, `offer_type`) with no `epoch_id` field at all.
- `protocol-objects.md` §12 `AuditEpochEntry`: **"Removed. Audit epoch key distribution via ML-KEM is replaced by direct auditor messaging. See press spec §5.6 for the current auditor notification model."**
- `protocol-objects.md` §13 `AuditEpochCommitment`: **"Removed."** (same note).

So `log_auditing.md` is not merely out of date on a few fields — its entire subject matter (the epoch/AEK lifecycle) is the thing that was removed. Every process it documents (opening an epoch, closing an epoch, epoch-triggered key rotation/add/remove handling) has no counterpart to update to; there is no "epoch" anymore in the current model at all.

**Recommendation:** I recommend a **full rewrite**, not archival, for these reasons:
1. Auditing as a *concept* is still very much alive in the new model — auditors still exist, are still listed in `policy.auditors`, still receive issuance notifications, still decrypt+inspect issued cards, and there is still real process content worth specifying: how the press sends the `PressIssuanceRecord` message (already spec'd at a high level in `press.md` §5.5, but the *auditor-side* receive/confirm/record/inspect flow, predicate-compliance checking against `field_definitions`/`recipient_predicate`/`requester_predicate`, the `keccak256(recipient_pubkey)` binding check, confirmation-message semantics, and what an auditor does with an unresponsive-press or malformed-record condition are process-level detail that press.md and protocol-objects.md don't fully own).
2. Unlike `client_sdk.md` (archived because its functionality was absorbed wholesale into `app_sdk.md`/`wallet_sdk.md` with no remaining independent surface), the auditor side of this flow has no other process spec that owns it. `press.md` documents the press's outbound half (`appendIssuanceRecord`); nothing documents the auditor's inbound half (receive → confirm → locally record → later inspect/verify). That's a real process-spec gap, and `log_auditing.md` is the natural home for it — it just needs to be rewritten from scratch around the new model rather than patched.
3. A useful amount of existing content survives with modification: Process 2 steps 2b–3f (decrypting/fetching the issued `CardDocument`, deriving `content_key`, verifying predicate compliance, verifying `keccak256(recipient_pubkey)` binding, walking `ancestry_pubkeys`) describes auditor-side *card inspection* logic that is orthogonal to the epoch/AEK removal — it's about what an auditor does with a `PressIssuanceRecord` once it has one, not about the epoch key-wrapping/distribution mechanism itself. This logic still applies almost verbatim under the new model (an auditor still needs to fetch `card_cid`, decrypt with `content_key`, check predicates, check the recipient-pubkey binding) — it just needs to be re-anchored to "records received via direct E2E message" instead of "records decrypted from a closed epoch."

**Suggested new structure**, for Step C's benefit (not to be acted on yet): Overview (auditors as `policy.auditors` entries receiving direct issuance notifications); Preconditions (auditor holds a card in `policy.auditors`, resolvable via `message_routing.md`); Process 1: Press sends `PressIssuanceRecord` (cite `press.md §5.5` as authoritative, don't re-derive); Process 2: Auditor receives, confirms, and locally records a `PressIssuanceRecord` (the currently-undocumented half); Process 3: Auditor inspects/verifies an issued card against policy predicates (salvage from current Process 2 steps 2b–3f); Process 4: auditor added/removed via policy update (no epoch to close now — just: new auditor gets no retroactive access to past `PressIssuanceRecord`s since nothing is escrowed for them; removed auditor stops receiving new ones). Drop epoch, AEK, ML-KEM key-wrapping, and forward-secrecy-boundary sections entirely — there is no key material to compromise or destroy under the new model (nothing is encrypted "at rest" between press and auditor beyond the transport-layer E2E encryption already specified in `message_routing.md`).

---

## Finding 2 [HIGH] — `card_protocol_spec.md` still contains the full old epoch/AEK model in extensive detail and contradicts `press.md`/`protocol-objects.md`

`card_protocol_spec.md` was listed to me as an in-scope, "already fixed" object/overview spec, but it still describes the retired model at length and was evidently never touched by the Phase 1 fix pass (Phase 1's 11 units did not include `card_protocol_spec.md` or `ARCHITECTURE.md` as their own units — see `implementation-plan.md` Phase 1 table, which lists only `registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`+`relay_data_model.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`). Specific stale passages, all contradicting the removal:

- Line 378: "`auditors`... Audit log access is organized into **epochs**... At the start of each epoch, the press generates a fresh random AEK and wraps it under each auditor's current ML-KEM (FIPS 203) public key, posting the resulting key packages as an `AuditEpochEntry`..."
- Lines 380–382: epoch-close/AEK-destruction/forward-secrecy narrative, auditor-removal epoch-close narrative.
- Line 257: "Logs each issuance in the policy card's audit log, encrypted to each auditor card's public key" — this line is actually vestigially closer to the *new* model's spirit (per-auditor encryption rather than shared-epoch-key encryption) but still says "audit log" (an appended encrypted IPFS log) rather than "direct E2E message," which is also wrong under the new model — the press does not maintain an encrypted IPFS issuance log at all (confirmed explicitly by `ARCHITECTURE.md` line 153: "The press does not maintain an encrypted IPFS issuance log").
- Lines 607–647: an entire subsection ("Audit Log Entries" / epoch mechanics with numbered steps 1–5, plus 5 Acceptance Criteria bullets) walking through the AEK wrap/unwrap, `AuditEpochEntry`/`AuditEpochCommitment` posting, and forward-secrecy guarantees — this is the largest single block of stale content found anywhere in this review.
- Line 613, 627: direct citations to `protocol-objects.md §12` and `§13`, both of which are now marked **Removed**.

**Recommendation:** Flag for the Step B consolidator as a scope note: `card_protocol_spec.md` needs the same category of fix as `log_auditing.md` (full rewrite of its audit section to match direct-auditor-messaging), but since it wasn't one of the original 11 Phase 1 units, it may have fallen through a scope gap between "object specs" and "process specs." Recommend either pulling it into Phase 2 (since it's an overview spec, not tied to one process) or opening a dedicated fix-list entry now rather than assuming it was already handled — my re-check shows it was not.

---

## Finding 3 [MEDIUM] — `policy_creation.md` and `card_offering_and_acceptance.md` also carry stale audit-epoch references (already partially flagged in Phase 1, re-confirmed here)

- `policy_creation.md` line 120 (Related Specs): "`log_auditing.md` — audit epoch lifecycle for cards issued under this policy" — stale description; once `log_auditing.md` is rewritten this line's gloss needs to change too (e.g., "direct auditor-notification flow for cards issued under this policy").
- `card_offering_and_acceptance.md` lines 34, 109–118, 165 describe the press opening/using an audit epoch and an `epoch_id` field inside the issuance record, and cite `log_auditing.md` for epoch management. This exact issue was already logged in Phase 1's `phase-1-consolidated-fixes.md` entry #9, which explicitly notes it's a Phase 2 fix (owned by `proc-card-creation`/`proc-log-auditing`) rather than something to silently fix now. I'm re-confirming it here since it's the same underlying defect as Finding 1, and recommend the Step B consolidator treat `log_auditing.md`'s rewrite and `card_offering_and_acceptance.md`'s steps 19–21 rewrite as one coordinated fix (both need to agree on the same "no epoch_id, no epoch" shape) — not something the `proc-log-auditing` unit should implement unilaterally, per my instructions.

---

## Finding 4 [LOW] — `log_auditing.md`'s own "Related Specs" section cites now-removed/renamed sections

- `log_auditing.md` line 218: "`card_protocol_spec.md §2` — Audit Epoch Lifecycle section" — stale; that section, if renamed/rewritten per Finding 2, needs this cross-reference updated too.
- `log_auditing.md` lines 220–221: "`protocol-objects.md §12` — `AuditEpochEntry` object reference" and "`protocol-objects.md §13` — `AuditEpochCommitment` object reference" — both objects are marked **Removed** in `protocol-objects.md`; these citations should be replaced with `protocol-objects.md §11 — PressIssuanceRecord object reference`.
- `log_auditing.md` line 219 ("`protocol-objects.md §11` — `PressIssuanceRecord` object reference") is the one correct/current citation in that list — worth keeping in the rewrite.

---

## Finding 5 [LOW] — `ARCHITECTURE.md` line 204 lists "audit epoch entries" among ML-DSA-44-signed IPFS artifact types

`ARCHITECTURE.md` line 204: "Used for all content signed to IPFS — card documents, log entries, SCIPs, message envelopes, **audit epoch entries**, and all other IPFS-stored artifacts." Minor/stale — `AuditEpochEntry` no longer exists and is not IPFS-stored content under the new model (the `PressIssuanceRecord` is delivered via E2E message, not posted to IPFS). Low severity since the rest of `ARCHITECTURE.md`'s auditor-related content (lines 151, 153, 271, 273, 341, 572) is already fully consistent with the new direct-messaging model — this appears to be a single missed word in an enumerated list, not a substantive contradiction.

---

## Non-findings (checked, consistent)

- `press.md` §5.5's phrase "via the normal message routing layer" correctly refers to `message_routing.md`'s wallet-service-to-wallet-service E2E encrypted delivery model (card address as stable messaging address, ML-KEM-encrypted `SignedMessageEnvelope`, no fan-out primitive at the routing layer beyond per-recipient envelopes) — no contradiction between `press.md` and `message_routing.md` on how the `PressIssuanceRecord` message is actually transported.
- `protocol-objects.md` §11's field list (`card_cid`, `recipient_pubkey`, `scip_cid`, `issued_at`, `offer_type`) matches `press.md` §5.5 step 3's `PressIssuanceRecord` JSON exactly — no field/type drift between the two authoritative sources for the new model.
- `ARCHITECTURE.md`'s auditor-notification narrative (§"Press log" table row, line 153, lines 271/273, line 572 sequence diagram) is internally consistent with `press.md` §5.5/§9 and `protocol-objects.md` §11 — this is the one file, besides `press.md` and `protocol-objects.md` themselves, that already correctly reflects the new model.
- No conflicting field/type names were found between `press.md` §5.5 and `protocol-objects.md` §11 for `PressIssuanceRecord` itself (only the *surrounding* documents — `log_auditing.md`, `card_protocol_spec.md`, `card_offering_and_acceptance.md`, `policy_creation.md` — still reference the removed `epoch_id`/`AuditEpochEntry`/`AuditEpochCommitment` machinery).

---

## Summary of recommended actions for Step B

1. **[HIGH]** Full rewrite of `log_auditing.md` around direct-auditor-messaging (Finding 1) — not archival; auditor-side receive/confirm/inspect logic has no other home.
2. **[HIGH]** `card_protocol_spec.md` §"Audit Log Entries" (lines ~378–382, ~607–647) needs the same rewrite treatment; this fell outside the original Phase 1 unit list and appears to have been missed rather than deliberately deferred (Finding 2).
3. **[MEDIUM]** Coordinate `log_auditing.md`'s rewrite with `card_offering_and_acceptance.md` steps 19–21 and `policy_creation.md` line 120 so all three agree on the no-epoch shape (Finding 3; overlaps Phase 1 fix-list entry #9 — dedupe against that entry in Step B).
4. **[LOW]** Update `log_auditing.md`'s own Related Specs citations to `protocol-objects.md` §12/§13 (Finding 4) as part of the same rewrite.
5. **[LOW]** Drop "audit epoch entries" from `ARCHITECTURE.md` line 204's artifact-type list (Finding 5).
