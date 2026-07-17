# Inconsistency Findings — `proc-card-creation`

**Unit:** `card_offering_and_acceptance.md`, `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`, `card_signing.md`
**Reviewed against:** all Phase-1-fixed object specs (`press.md`, `protocol-objects.md`, `registry_contract.md`, `wallet.md`, `ipfs_card.md`, etc.) and other in-scope process specs.
**Review type:** read-only. No fixes applied.

---

## Finding 1 — `card_offering_and_acceptance.md` still describes the retired audit-epoch/AEK model (Preconditions, Steps 19–21)

**Severity:** High (protocol-breaking if implemented as written)

**Conflicting specs:** `card_offering_and_acceptance.md` (Preconditions; Steps 19–21) vs. `press.md §5.5/§5.6` and `protocol-objects.md §11–13`.

**Description:**

`press.md §5.6 Audit Epoch Management` states outright: *"Removed. Audit epochs and ML-KEM-based AEK distribution are replaced by direct auditor messaging (see §5.5). Auditors maintain their own records of issuance notifications received from the press."* `protocol-objects.md §12`/`§13` (`AuditEpochEntry`, `AuditEpochCommitment`) are likewise marked **Removed**, superseded by `PressIssuanceRecord` (§11), which is delivered as a **direct E2E-encrypted message to each card address in `policy.auditors`** — not written into an encrypted append-only log under an epoch key.

`card_offering_and_acceptance.md` never received this update:

- **Precondition:** *"An audit epoch is open for this policy, or the press is prepared to open one before logging the issuance."* — audit epochs no longer exist.
- **Step 19:** *"The press ensures an audit epoch is open for this policy. If not, it opens one first (see `log_auditing.md`)."* — no corresponding function exists in `press.md` (§5.6 is empty/removed).
- **Step 20:** Constructs a `PressIssuanceRecord` with fields `epoch_id`, `card_cid`, `issued_at`, `requester_card`, `offer_type: "targeted"`. Compare to the actual `PressIssuanceRecord` schema in `protocol-objects.md §11`:
  ```json
  { "card_cid": "...", "recipient_pubkey": "...", "scip_cid": "...", "issued_at": "...", "offer_type": "targeted | open" }
  ```
  `epoch_id` and `requester_card` do not exist on this object; `recipient_pubkey` and `scip_cid` (both required) are missing from the spec's version.
- **Step 21:** *"The press encrypts the record with the current epoch AEK (AES-GCM, fresh 96-bit nonce per entry) and appends it to the policy card's IPFS log, then updates the policy card's Arbitrum One registry pointer to the new log head."* — this entire mechanism (epoch AEK, append to policy's IPFS log, registry pointer update) no longer exists. The current flow (`press.md §5.5 appendIssuanceRecord`) resolves `policy.auditors`, and for each auditor address sends the plaintext-at-rest-but-E2E-encrypted-in-transit `PressIssuanceRecord` directly via the normal message routing layer, awaiting a best-effort confirmation per auditor (with a configurable timeout) rather than writing anything to IPFS or on-chain.
- **Step 24 / Actors table:** *"The press sends an audit record (card CID + SCIP) to the administrator via HTTPS to their wallet service endpoint."* This also misattributes the recipient: `PressIssuanceRecord` is sent to every card address in `policy.auditors`, a distinct actor/list from the "Administrator" who (per `issueScip` step 5 in `press.md`) receives only a **courtesy copy of the SCIP**, not the issuance record. The Actors table in `card_offering_and_acceptance.md` has no "Auditor" role at all — only "Administrator... may be notified of issuance" — conflating two distinct recipients (auditors vs. administrator) that `press.md` and `protocol-objects.md §2` (`policy.auditors`) keep separate.

**Recommendation:** Rewrite Preconditions and Steps 19–21 (and the Actors table, and step 24) to match `press.md §5.5`'s `appendIssuanceRecord` flow:
1. Drop the audit-epoch precondition entirely.
2. Replace steps 19–21 with: resolve `policy.auditors`; if empty, skip; otherwise assemble the `PressIssuanceRecord` (`card_cid`, `recipient_pubkey`, `scip_cid`, `issued_at`, `offer_type: "targeted"`) and deliver it via E2E-encrypted message to each auditor card address, awaiting (with timeout) a confirmation from each.
3. Add an "Auditor" row to the Actors table, distinct from "Administrator."
4. Correct step 24 (or fold it into the corrected 19–21) so it's clear the issuance record goes to auditors, and only the SCIP courtesy copy goes to the administrator.
5. Update the Postconditions bullet *"The issuance is recorded in the policy's encrypted audit log"* — there is no longer a policy-level encrypted audit log; replace with something like "each auditor listed in the policy has been notified of the issuance via a `PressIssuanceRecord`."

This mirrors the same stale audit-epoch language already corrected in `log_auditing.md`'s presumed Phase 2 pass (parallel unit `proc-log-auditing`) — worth cross-checking that unit's findings for overlap.

---

## Finding 2 — `openOfferUseCounts` casing inconsistency: two of five files never received the Phase-1 fix

**Severity:** Medium (cosmetic in prose, but creates ambiguity about the actual on-chain identifier)

**Conflicting specs:** `open_offer_acceptance_existing_wallet.md` (line ~109), `open_offer_acceptance_new_wallet.md` (line ~125) vs. `registry_contract.md §3.5` (`OpenOfferUseCounts`, PascalCase) and `open_offer_creation.md` (already fixed).

**Description:** `open_offer_creation.md`'s own changelog records: *"Fix #3 / Fix #5 ... corrected `openOfferUseCounts` to the PascalCase `OpenOfferUseCounts` used by `registry_contract.md §3.5`."* That fix was applied only to `open_offer_creation.md`. The two sibling acceptance specs still read:

> "Submit an atomic Arbitrum One transaction that: checks `block.timestamp < expires_at` (if set); checks `openOfferUseCounts[offer_id] < max_acceptances` (if set); ..."

in both `open_offer_acceptance_existing_wallet.md` and `open_offer_acceptance_new_wallet.md`, using the lowercase form the Phase 1 fix explicitly rejected elsewhere in this same cluster.

**Recommendation:** Apply the identical text fix to both acceptance specs: `openOfferUseCounts` → `OpenOfferUseCounts`, matching `registry_contract.md §3.5` and the already-fixed `open_offer_creation.md`.

---

## Finding 3 — `E-14` vs `P-05`: the "invalid issuer signature" rejection has two different names across specs

**Severity:** Medium

**Conflicting specs:** `open_offer_acceptance_existing_wallet.md` (step 11), `open_offer_acceptance_new_wallet.md` (step 16), and `protocol-objects.md §7` all cite error code **`E-14`** for "issuer_pubkey binding mismatch / invalid issuer_signature / AES-GCM decrypt failure on the issuer card" — and this is internally consistent with `registry_contract.md §8`'s error table (`E-14 = INVALID_ISSUER_SIGNATURE`, explicitly documented as a *press-side, non-on-chain* rejection) and `card_protocol_spec.md`.

However, `press.md §5.2 processOpenOfferClaim` (steps 4–5) and `press.md §7`'s own error-code table describe the **identical condition** — invalid/mismatched issuer signature on an open offer — under the code **`P-05`**: *"Invalid `issuer_signature` on open offer (binding check failed or ML-DSA-44 sig invalid)."* `press.md §7`'s "On-chain revert codes this spec surfaces" section (added by the Phase 1 Fix #2 changelog) lists only `E-47`, not `E-14` — meaning `press.md`, the object spec that owns the press's actual HTTP error responses, never adopted the `E-14` naming used everywhere else for this exact condition.

**Recommendation:** Not a fix confined to my cluster's files (the root cause is in `press.md`/`registry_contract.md`, both already "fixed" Phase 1 specs), but flagging here since two of my cluster's files (the acceptance specs) and `protocol-objects.md` all depend on `E-14` being the code the press actually returns. Recommend the Phase 2 consolidated fix either (a) have `press.md §7` add `E-14` as an explicit alias/cross-reference to `P-05` ("returned to callers as `E-14` per `registry_contract.md §8`'s naming, tracked internally as `P-05`"), or (b) pick one canonical name and update all citing specs (`protocol-objects.md §7`, both acceptance process specs, `card_protocol_spec.md`) to match. This should probably be escalated to whoever owns `press.md`/`registry_contract.md` reconciliation rather than fixed unilaterally in the process specs.

---

## Finding 4 — Open-offer hosting/claim-link serving has no confirmed home (cross-reference to `wallet.md` OQ-WALLET-6)

**Severity:** Medium (spec gap, already partially flagged elsewhere)

**Conflicting specs:** `open_offer_creation.md` (Phase 3, steps 7–9) and `open_offer_acceptance_new_wallet.md` (Precondition, step 1) vs. `wallet.md §1` and `wallet.md §2`.

**Description:** `open_offer_creation.md` states the issuer "submits the signed `OpenCardOffer` document to a wallet service via HTTPS POST," and the wallet service "stores the offer and generates a claim link" (short `mcard://claim?o=...` form or a "hosted form: a wallet-service URL that serves the offer JSON on demand"). `open_offer_acceptance_new_wallet.md`'s precondition describes "a valid claim link — a URL hosted by the wallet service (e.g., `https://<wallet-service>/claim/<offer-id>`)."

`wallet.md §1` (the actual wallet-service object spec, already fixed in Phase 1) explicitly calls this out as an open scope question:

> *"Open scope question — open-offer hosting/claim-link serving is not implemented here. `open_offer_creation.md` and `open_offer_acceptance_new_wallet.md` both describe the wallet service as hosting the signed open-offer document and serving a claim link ... no such route exists in `wallet-service/server/routes/` as of this review ... It is not yet determined whether this is a planned-but-unbuilt wallet-service feature or was intended to live on a different component (e.g. the press). ... See OQ-WALLET-6."*

Cross-checking `press.md §4` (HTTP Endpoints): the press has `POST /open-offer/claim` (claim submission) but no offer-hosting or claim-link-serving endpoint either. So as things stand, neither `wallet.md` nor `press.md` — the two object specs whose endpoints `open_offer_creation.md`/`open_offer_acceptance_new_wallet.md` depend on — actually define where an `OpenCardOffer` document is stored or how a claim link resolves to it.

**Recommendation:** This is a genuine spec gap per the "gap is itself a finding" instruction in the Phase 2 plan, not something my unit can resolve unilaterally (it requires a design decision: wallet service, press, or a new component hosts open offers). Recommend surfacing this explicitly in the Phase 2 consolidated fix list as a decision point for David, cross-referenced with `wallet.md`'s own `OQ-WALLET-6`, rather than having a fix-implementation agent invent an endpoint.

---

## Finding 5 — `requester_predicate` evaluated against a different card than the one that ends up in the signed `CardDocument`

**Severity:** Low–Medium (conceptual ambiguity, not a schema mismatch)

**Conflicting specs:** `card_offering_and_acceptance.md` (Actors table; Phase 1 step 1; Phase 2 step 3) vs. `protocol-objects.md §1` (`issuer_card` field notes) and `press.md §5.1` (`validateIssuanceRequest`, `evaluatePredicates`).

**Description:** `card_offering_and_acceptance.md`'s Actors table distinguishes a **Requester** ("may be the administrator, the recipient, or a third party, depending on policy") from the **Issuer (offerer)** ("constructs the card offer and signs it with the offerer's own card key"). Phase 1 step 1 has the requester submit "the requester's card pointer (for predicate evaluation)" as a field distinct from "the intended recipient's identity." Phase 2 step 3 has the press evaluate `requester_predicate` against "the requester's card chain." This models requester and issuer/offerer as potentially different cards — consistent with `press.md §5.1`'s `validateIssuanceRequest`, which takes a separate `requester_card_pointer` as request input.

But `protocol-objects.md §1`'s field table for `issuer_card` says: *"The offerer who constructed and first-signed the offer; used to evaluate `requester_predicate` and verify `issuer_signature`"* — i.e., it documents `requester_predicate` as being evaluated against `issuer_card` (the offerer), not a separately-tracked requester. There is no `requester_card` field anywhere in the `CardDocument` schema (§1) at all — only `issuer_card`. So if requester and offerer are genuinely different parties (as the Actors table allows), the final signed `CardDocument` has no field recording who the original requester was, and a verifier reconstructing the issuance later (per the Postconditions: *"Any verifier can confirm ... the recipient's chain satisfied `recipient_predicate` — all from publicly available data"*) has no way to re-check `requester_predicate` after the fact — notably, the Postconditions list only mentions `recipient_predicate` being independently re-checkable, silently omitting `requester_predicate`, which may be an intentional acknowledgment of this exact gap rather than an oversight.

**Recommendation:** Clarify in `card_offering_and_acceptance.md` (and cross-check `protocol-objects.md §1`) whether "requester" and "issuer/offerer" are actually meant to be the same card in the common case (with the Actors table's broader allowance for administrator/third-party requesters being a rare edge case not fully modeled elsewhere), or whether the schema needs an explicit `requester_card` field distinct from `issuer_card`. If they're intended to always be the same card, simplify the Actors table and Phase 1–2 language to stop implying otherwise. If not, note the `CardDocument` schema gap for whoever owns `protocol-objects.md`.

---

## Minor / informational notes (not logged as separate numbered findings)

- **Delivery-step ordering vs. `press.md`'s actual call order:** `card_offering_and_acceptance.md` steps 22–24 order SCIP issuance before the (to-be-corrected, see Finding 1) auditor notification. `press.md §5.2`'s `processOpenOfferClaim` calls `appendIssuanceRecord` (step 12) before `issueScip` (step 13) — the opposite order. Functionally immaterial (no ordering dependency), but worth aligning once Finding 1 is fixed so the process spec's step order matches the object spec's actual function-call order.
- **`card_signing.md`'s "Card lifecycle" message types (`card_offer`, `card_offer_accepted`, `card_offer_declined`) are never referenced by `card_offering_and_acceptance.md`'s actual delivery steps** (Phase 4, steps 9–10 describe raw offer delivery via `mcard://invite` URL or direct HTTPS POST of the offer document, not a `SignedMessageEnvelope` with `type: "card_offer"`). It's unclear whether these message types are meant to wrap the offer/acceptance transmissions described in `card_offering_and_acceptance.md`, or serve a separate notification purpose. Not a hard contradiction — the two mechanisms aren't mutually exclusive — but the connection is undocumented in both directions.
- **`messaging_protocol.md`** is cited extensively by `card_signing.md` (message type content schemas) but is not in this unit's assigned in-scope list (only `message_routing.md`, the process spec, was listed). It exists at `specs/messaging_protocol.md`. Flagging in case the Phase 2 scope list should have included it — `card_signing.md`'s Message Types table explicitly defers to it as "the canonical type definitions," making it a first-class dependency of this cluster that no other Phase 2 unit appears to own.
- **`max_acceptances`/`expires_at` null-to-sentinel encoding is undocumented in the process specs:** `registry_contract.md §4.5` requires the press to encode a document-level `null` `max_acceptances` as `type(uint64).max` and a `null` `expires_at` as `0` before calling `ClaimOpenOffer`. None of `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, or `open_offer_acceptance_new_wallet.md` mention this translation step; they describe the on-chain check only as "(if set)." Not a contradiction, just an implementation detail omitted from the process-level description — low priority.

---

## Internal consistency of the 5-file cluster itself

Aside from the issues above (all of which are cluster-vs-outside-spec conflicts), the five files agree with each other well:

- `OpenCardOffer` field names/shapes in `open_offer_creation.md` match `protocol-objects.md §6` and are used identically in both acceptance specs.
- `OpenOfferClaimSubmission` (`claim_payload` + `recipient_signature`) is assembled identically in both acceptance specs and matches `protocol-objects.md §7`.
- The "Difference from New Wallet Flow" table in `open_offer_acceptance_existing_wallet.md` accurately reflects the steps in `open_offer_acceptance_new_wallet.md`.
- `card_signing.md`'s `SignedMessageEnvelope`/`payload` schema matches `protocol-objects.md §5` field-for-field.
- Content-encryption timing language ("this is the first point at which content encryption applies...") is worded identically across `card_offering_and_acceptance.md` and both acceptance specs, and matches `protocol-objects.md §1`'s "Content encryption and the offer phase" note.
- Signing-sequence language (offerer assembles → offerer signs → recipient countersigns → offerer validates → forwards to press → press signs) in `card_offering_and_acceptance.md` matches `protocol-objects.md §1`'s "Signing sequence" exactly.
