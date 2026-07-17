# Wallet Service Spec — Discrepancy Log

**Correction style (David's guidance, applies to D-4, D-5, D-6, D-8 and any future direct-edit resolution):** when fixing these in Phase 4, rewrite the passage to state current, accurate behavior plainly. Do not narrate the historical change inline in the corrected spec text (no "this used to say X, changed to Y because..."). The rationale stays here in this log; the spec body should just read as if it were correct all along.

Working log for Phase 2 (cross-spec verification) of the wallet service object-spec initiative. Each entry: spec section, the discrepancy, the code/plan evidence, and the proposed resolution. Entries are resolved in Phase 4; this file is finalized (all entries closed) at the end of Phase 5.

---

## Step 2.1 — Process specs deep check

### `specs/process_specs/wallet_backup_and_recovery.md` (v0.3)

**D-1. Backup registration wire format field names don't match the implemented API.**
- Spec (Process 1, Step 13): `{ type: "synced_passkey", wrapped_decryption_key, keyring_id, notification_channels, cancellation_credentials }`
- Code (`POST /accounts/{card_hash}/backups`, `server/routes/accounts/[card_hash]/backups/index.post.ts`): `{ type, wrapped_blob, keyring_id, notification_channels, cancellation_pubkey }`
- Field name mismatches: `wrapped_decryption_key` → `wrapped_blob`; `cancellation_credentials` → `cancellation_pubkey` (also plural→singular, reflecting one credential, not a list).
- **Resolution:** Update the wire-format examples in Steps 13 and 14 (YubiKey variant has the same mismatch) to match the implemented field names. Low risk — naming only, no behavioral change.

**D-2. "Any registered cancellation credential" doesn't state what credential type is actually implemented.**
- Spec (Process 2a Step 4, Process 2b Step 3): "A cancellation is valid if it is signed by any registered cancellation credential" — doesn't specify what a cancellation credential *is*.
- Code/plan (OQ-WS-6, resolved): the cancellation credential is specifically the holder's master card key; `cancellation_pubkey` stored at backup-registration time is the master card's ML-DSA-44 public key.
- **Resolution:** Add a clarifying sentence naming the master card key as the (currently sole) cancellation credential type, cross-referencing the backup registration field. Not a behavior change — a clarity gap. Low risk.

**D-3 (minor).** "Related Specs" omits `open_offer_acceptance_existing_wallet.md`, which also drives keyring-update/service-secret interactions with this spec's model. Optional addition, not required.

### `specs/process_specs/message_routing.md` (v0.4)

**D-4. Relay delivery failure-handling text contradicts implemented (and deliberately decided) behavior.**
- Spec (§Message Delivery, Relay Delivery and Multi-Device Fan-out, point 5): "On 5xx or network error: retry with exponential backoff using the same UUID."
- Code (`wallet-service/server/utils/message-delivery.ts`): both `'uuid_invalid'` (404/410) and `'server_error'` (5xx/network) advance to the *next* UUID in the pool, bounded by `MAX_UUID_ATTEMPTS = 5`. No same-UUID retry-with-backoff path exists.
- Plan evidence: `implementation-plan.md` §Step 4.4 documents this as a deliberate decision — "a fresh UUID is cheap and plentiful; Phase 5's re-registration/retransmission path is the better fit for a sustained relay outage than burning through one sub-card's pool on retries."
- **Resolution:** This is a case where the code is correct and intentional, and the process spec is stale (predates the Phase 4/5 decision, or was never updated after it). Correct the process spec's text to describe the advance-to-next-UUID behavior, citing the rationale. Not a CP-SPEC-1 case — no invariant is violated, this is a delivery-reliability strategy choice already made and shipped.

Everything else in `message_routing.md` v0.4 (routing envelope shape, sender-side fan-out, `410 Gone` handling, DELETE /messages/{uuid}, UUID re-registration/retransmission, multi-recipient handling, `What Wallet Services Observe` table) matches the code exactly — this is the most current and accurate of the three process specs checked in this step. Its `transport_flags 0x02 OHTTP relay` entry also correctly anticipates the OHTTP subsystem found in Phase 1 (cross-reference to `oblivious_transport.md`) — the OHTTP gateway is not undocumented at the process-spec layer, only absent from the wallet-service build plans (see note under Step 2.2/Phase 1 finding #3).

### `specs/process_specs/notification_relay.md` (v0.9)

**D-5. Failure Handling table has the identical stale "retry same UUID" language as D-4.**
- Spec (§Failure Handling table, row 2): "Relay unreachable for `POST /deliver/{uuid}` | Wallet retries with exponential backoff using the same UUID; UUID not consumed until relay accepts."
- Same code evidence as D-4 — the wallet service does not do this; it advances to the next UUID.
- **Resolution:** Same fix as D-4, applied to this table row.

**Note — Phase 1 finding #2 (sub-card signed-envelope tightening) is already correctly documented here.** `notification_relay.md` v0.9's Process 1 Step 6/7 and the Deregistration section already describe the signed-envelope requirement precisely, including the on-chain-registry → IPFS → `recipient_pubkey` resolution chain (citing `specs/subcards.md §Step 5` directly) and the explicit non-dependence on `SubCardEntry.active`. **This process spec is not stale on this point.** The only documents that describe the old, pre-tightening design are `plans/wallet-service/strategic-plan.md`/`implementation-plan.md` (Steps 5.1/5.2), which are outside this initiative's correction scope (plans are consulted, not corrected) — the object spec itself (Phase 3) should simply describe current behavior and can note the plan's original design was superseded, without needing a Phase 4 edit to any spec file for this point.

**Confirms Phase 1 finding #7**: `specs/subcards.md §Step 5` is directly cited here as the on-chain/IPFS pubkey-resolution mechanism. Confirmed as a required addition to this initiative's spec list (already flagged; carrying forward).

Everything else in `notification_relay.md` (UUID pool model, device credential, multi-device/subcard model, registration privacy/staggering, relay processes 2-6, relay trust model) matches the code and `message_routing.md` consistently — no further discrepancies found in this file.

---

---

## Step 2.2 — Acceptance-flow and migration specs check

### `specs/process_specs/open_offer_acceptance_new_wallet.md` (v0.1, 2026-05-25) and `specs/process_specs/open_offer_acceptance_existing_wallet.md` (v0.1, 2026-05-25)

Both predate all wallet-service code (first wallet-service commit is 2026-06-29) and both are stale on the same point:

**D-6a/D-6b — RESOLVED**, plus one additional occurrence found and fixed during Phase 5's consistency pass: `open_offer_acceptance_new_wallet.md` Step 10's wallet-creation summary ("A master card keypair (private key in the keyring on IPFS)") repeated the same stale claim outside the originally-flagged Step 7 — corrected in the same pass, no new checkpoint needed (already in this initiative's direct-edit scope). Original finding:

**Both specs describe the keyring blob as posted to IPFS — contradicts `ARCHITECTURE.md` ADR-009-AMEND and the entire wallet-service implementation.**
- `open_offer_acceptance_new_wallet.md` Step 7: "The keyring blob is posted to IPFS (append-only encrypted blob)."
- `open_offer_acceptance_existing_wallet.md` Step 6: "Re-encrypt and post the updated keyring blob to IPFS. Wait for IPFS confirmation before proceeding to claim submission."
- Both specs' Error Paths tables list "Keyring IPFS post fails" as a condition.
- Code/architecture evidence: `ARCHITECTURE.md` ADR-009-AMEND (per `wallet_backup_and_recovery.md`'s own changelog and `implementation-plan.md` OQ-WS-3) moved keyring storage off IPFS entirely — it's now traditional storage (`keyring_blobs` table) replicated via wallet-service federation broadcast, confirmed against the actual schema and `POST /accounts`/`PUT /accounts/{card_hash}/keyring` endpoints in Phase 1.
- **Resolution:** Update both specs' wallet-creation/keyring-update steps and error-path tables to describe keyring replication via the wallet service federation (per `wallet_backup_and_recovery.md §Keyring Storage and Replication`), not an IPFS post/confirmation step. This is the most significant correction found so far — these two specs are the most out of date of any checked, consistent with predating the wallet-service build entirely.

**D-7 (minor).** Neither spec cross-references the actual wallet-service wire protocol (challenge/response account creation, session tokens) now that `specs/object_specs/wallet.md` will exist — recommend adding it to both specs' "Related Specs" once Phase 3 produces the object spec. Not a contradiction (these process specs intentionally operate at a higher abstraction level than wire format), just an opportunity to link forward. Low priority, can be done in Phase 4 alongside D-6.

### `specs/process_specs/open_offer_creation.md`, `card_migration.md`, `card_offering_and_acceptance.md`, `card_updates.md`

Grep-scoped check (lighter budget, per strategic plan OQ-WS-SPEC-2 — the wallet service is a secondary actor in all four): no contradictions found.

- `open_offer_creation.md` only describes the wallet service as offer host/claim-link generator — no internal wallet-service behavior asserted that Phase 1 contradicts.
- `card_migration.md` matches Phase 1/code closely: dual-signature announcement, `/bindings/announce` broadcast, `410 Gone` retry with forwarding hint, conflict resolution deferring to `message_routing.md` (already checked, consistent). No discrepancy.
- `card_offering_and_acceptance.md` and `card_updates.md` reference the wallet service only as a notification endpoint for the holder (HTTPS notification on update/issuance) — generic enough that nothing in Phase 1's inventories contradicts it. No discrepancy found.

### `specs/process_specs/oblivious_transport.md`

**Revises Phase 1 finding #3.** This spec fully documents the OHTTP subsystem found in Phase 1 — `GET /ohttp/key-config`, the destination gateway's decapsulate/dispatch-in-process/encapsulate pattern, the relay's `POST /ohttp/{target_id}` forwarding role, and the four-party closed-system rationale for not implementing full RFC 9458 Binary HTTP. It explicitly cites `plans/wallet-service/strategic-plan.md` and cross-references `message_routing.md §Transport Extensibility`'s `transport_flags 0x02`. **The OHTTP subsystem is not undocumented at the process-spec layer — it is well-specified here.** The only real gap is that `plans/wallet-service/strategic-plan.md`/`implementation-plan.md` (the build plan, not a spec) never mention it, which is outside this initiative's spec-correction scope (plans are consulted, not corrected) — the object spec (Phase 3) should simply include `/ohttp/gateway` and `/ohttp/key-config` in its endpoint list, cross-referencing this spec. No discrepancy requiring a spec edit.

---

---

## Step 2.3 — Other object specs check (lighter pass)

### `specs/object_specs/relay.md` (v0.8) and `specs/object_specs/relay_data_model.md`

Checked in full against the wallet-service-facing surface: `POST /deliver/{uuid}` wire format, `DELETE {wallet_base_url}/messages/{uuid}` staggered clearance, UUID lifecycle/error codes (404/410/5xx).

**No discrepancy found — fully consistent.** `wallet-service/src/relay-client.ts`'s `deliverToRelay` sends exactly `{ blob }` as `relay.md §7.2` specifies, and its code comment explicitly cites `relay.md §7.2` for treating 404/410 as "advance to next UUID" — which independently corroborates D-4/D-5's proposed resolution (the relay's own spec has always described 404/410 as terminal-for-that-UUID conditions; the process specs' stale "retry with backoff" language was inconsistent with the relay side too, not just the wallet-service code). `relay_data_model.md`'s `wallet_base_url`/staggered-delete sections are likewise consistent with the wallet service's `DELETE /messages/{uuid}` implementation.

### `specs/object_specs/registry_contract.md`

One passing mention of "wallet service" (line ~1012, suspicious-activity alerts sent "via HTTPS to their wallet service endpoint"). Generic, notification-endpoint-only reference — consistent with every other spec's treatment of the wallet service as a notification target. No discrepancy.

### `specs/object_specs/card_verifier.md`

**No mentions of "wallet" found on direct grep** (case-insensitive, both "wallet service" and "wallet"). The strategic plan's original file list (broad `grep -rl "wallet service" specs/`) appears to have been a false positive for this file — re-verified with a targeted grep in this step and found nothing to check. No action needed; noting this so Phase 4/5 doesn't waste time looking for a correction that isn't there.

---

*(Step 2.4 entries below.)*

---

## Step 2.4 — Protocol-wide specs check (flag-first, no edits made in this step)

### `specs/ARCHITECTURE.md`

**No discrepancy found.** Fully up to date: documents ADR-009-AMEND (keyring off IPFS, traditional storage replicated across the wallet-service federation) in detail (§117, §464-484), the UMBRAL removal and sender-side per-subcard encryption (§375), the wallet-service registry/binding-announcement model (§365-384), and the OHTTP/oblivious-transport design (§357-359) — all consistent with Phase 1's code findings and the other (already-current) process specs. No proposed correction.

### `specs/card_protocol_spec.md`

**D-8 — RESOLVED (CP-SPEC-2 approved, two passages).** §3 (keychain setup and backup) repeats the same stale IPFS-keyring claim as D-6, and Phase 5's consistency pass found a second, separate occurrence in the same section's "Keyring structure" requirement ("The keyring is an append-only encrypted blob stored on IPFS"), presented and approved as a second CP-SPEC-2 item and corrected identically.
- Spec, line 715 (YubiKey recovery flow, §3): "If no cancellation after 72 hours: the service releases the CID of the encrypted keyring blob plus the wrapped decryption key blob. The holder's device presents the wrapped blob to the YubiKey (PIN required); the YubiKey unwraps it locally; the resulting key fetches and decrypts the keyring from IPFS."
- Same evidence as D-6: `ARCHITECTURE.md` ADR-009-AMEND and the wallet-service's actual `GET /recovery/{recovery_id}/release` (returns `keyring_id`, not a CID) and `GET /keyrings/{keyring_id}` (federation replica lookup, not IPFS) contradict "CID"/"IPFS" here.
- **Proposed correction (pending CP-SPEC-2 approval):** Replace "releases the CID of the encrypted keyring blob" → "releases the `keyring_id` of the encrypted keyring blob"; replace "fetches and decrypts the keyring from IPFS" → "fetches the keyring blob by `keyring_id` from any reachable wallet service in the federation and decrypts it." This mirrors the correction already planned for `wallet_backup_and_recovery.md` (which this section is presumably meant to summarize) and the two acceptance-flow specs (D-6).
- CP-SPEC-2 was presented and approved; the correction has been applied (`card_protocol_spec.md` v0.4, line ~715), with a version bump and changelog note matching the other corrected specs' convention.

Everything else in `card_protocol_spec.md`'s wallet-service mentions (offer assembly, claim submission, CHAPI/wallet-discovery sections, notification endpoints) is generic and consistent with Phase 1/the other specs — no further discrepancies found.

### `specs/protocol-objects.md`

No discrepancy found. Wallet-service mentions are limited to "stored on wallet service," "sent by wallet service," and "transmitted to press via HTTPS POST from wallet service" — describing object flow at a level generic enough that nothing in Phase 1 contradicts it. `protocol-objects.md:387` ("Stored on: Wallet service (HTTPS); may also be pinned to IPFS") refers to the `OpenCardOffer` document's own storage (not the keyring), which is a different object — checked, no conflation with the keyring-blob IPFS issue.

### `specs/messaging_protocol.md`

No discrepancy found. Wallet-service mentions are limited to the routing/observability boundary ("wallet services see only the recipient hash... not sender identity or message content") — consistent with `message_routing.md §What Wallet Services Observe`, already verified in Step 2.1. The one open question referencing wallet services (`MSG-OQ-3a`, one-time prekeys) is a forward-looking design question, not a claim about current behavior — no action needed.

**No edits made during Step 2.4 itself**, per the strategic plan's flag-first scope decision (OQ-WS-SPEC-3). D-8 was the only proposed correction; it was routed through Clarification Checkpoint CP-SPEC-2 in Phase 4, approved, and applied there.

---

## Closeout — Final Record (end of Phase 5)

All entries below are resolved. This section is the permanent audit trail: original text, corrected text, and the justification for each, in one place, rather than scattered across the phase-by-phase notes above.

| ID | File | Original text | Corrected text | Justification |
|---|---|---|---|---|
| D-1 | `wallet_backup_and_recovery.md` Steps 13-14 | `{ type, wrapped_decryption_key, keyring_id, notification_channels, cancellation_credentials }` | `{ type, wrapped_blob, keyring_id, notification_channels, cancellation_pubkey }` | Matches `POST /accounts/{card_hash}/backups`'s actual implemented field names (`server/routes/accounts/[card_hash]/backups/index.post.ts`). |
| D-2 | `wallet_backup_and_recovery.md` Process 2a/2b | "signed by any registered cancellation credential" | "signed by the registered cancellation credential — the holder's master card key (`cancellation_pubkey`...)" | OQ-WS-6 resolved the cancellation credential as specifically the master card key; only one type is implemented. |
| D-3 | `wallet_backup_and_recovery.md` Related Specs | Omitted `open_offer_acceptance_existing_wallet.md` and `specs/object_specs/wallet.md` | Both added | Both specs interact directly with this one's keyring/recovery model. |
| D-4 | `message_routing.md` §Message Delivery point 5 | "On 5xx or network error: retry with exponential backoff using the same UUID." | "On 5xx or network error: advance to the next UUID in the pool and retry, the same as step 4... bounded (5 attempts per delivery pass)..." | `server/utils/message-delivery.ts` advances to the next UUID on `server_error`, never retries the same one; `implementation-plan.md §Step 4.4` documents this as deliberate. Independently corroborated by `relay.md §7.2`'s own error-code semantics. |
| D-5 | `notification_relay.md` §Failure Handling table | "Wallet retries with exponential backoff using the same UUID; UUID not consumed until relay accepts." | "Wallet advances to the next UUID in the subcard's pool and retries (bounded, 5 attempts per delivery pass)..." | Same evidence as D-4. |
| D-6a | `open_offer_acceptance_new_wallet.md` Step 7 + Step 10 + Error Paths | "The keyring blob is posted to IPFS"; "(private key in the keyring on IPFS)"; "Keyring IPFS post fails" | Keyring stored with the wallet service and replicated across the federation; error path renamed to "Keyring storage or federation replication fails" | Contradicts `ARCHITECTURE.md` ADR-009-AMEND and the actual `POST /accounts` implementation (`keyring_blobs` table, federation broadcast, no IPFS). Spec predates all wallet-service code (2026-05-25 vs. first commit 2026-06-29). |
| D-6b | `open_offer_acceptance_existing_wallet.md` Step 6 | "Re-encrypt and post the updated keyring blob to IPFS. Wait for IPFS confirmation..." | "Re-encrypt the keyring blob and send it to the wallet service, which stores it under a new `keyring_id` and replicates it..." | Same evidence as D-6a. |
| D-7 | Both acceptance-flow specs' Related Specs | No reference to `specs/object_specs/wallet.md` | Added | The object spec now exists (Phase 3) and documents the wire protocol these process specs describe at a higher level. |
| D-8 | `card_protocol_spec.md` §3, two passages (line ~705 "Keyring structure," line ~715 YubiKey recovery flow) | "stored on IPFS" / "releases the CID... fetches and decrypts the keyring from IPFS" | "stored by the wallet service and replicated across the wallet service federation" / "releases the `keyring_id`... fetches the keyring blob by `keyring_id` from any reachable wallet service in the federation" | Same evidence as D-6; protocol-wide document, corrected only after explicit approval (CP-SPEC-2, both passages approved separately — the second found during Phase 5's consistency pass). |

**Findings that required no spec correction** (confirmed accurate, or the discrepancy was in scope elsewhere): `notification_relay.md`'s sub-card signed-envelope documentation (already correct — only the wallet-service *build plans* were stale, out of this initiative's scope); `oblivious_transport.md`'s OHTTP documentation (already correct, same reason); `relay.md`, `relay_data_model.md`, `registry_contract.md`, `ARCHITECTURE.md`, `protocol-objects.md`, `messaging_protocol.md`, `card_migration.md`, `card_offering_and_acceptance.md`, `card_updates.md`, `open_offer_creation.md` (all checked, no discrepancy); `card_verifier.md` (no wallet-service content at all — original scoping grep was a false positive).

**CP-SPEC-1 (invariant-violation checkpoint):** never triggered. Every finding across all five phases was either stale documentation of a superseded design, a wire-format naming mismatch, or a genuine implementation gap already mitigated in practice (carried to `specs/object_specs/wallet.md §9` as open questions, not treated as spec discrepancies to fix here).

**CP-SPEC-2 (protocol-wide correction checkpoint):** triggered twice, both for `card_protocol_spec.md`; both approved and applied.

This log is now closed. Any future drift between `specs/object_specs/wallet.md` and the wallet-service code should start a new discrepancy log rather than reopening this one.
