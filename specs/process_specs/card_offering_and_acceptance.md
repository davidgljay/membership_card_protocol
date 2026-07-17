# Card Offering and Acceptance — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

**Amended 2026-07-16 (spec-consistency Phase 2, Fix #11):** dropped the stale audit-epoch/AEK precondition and rewrote steps 19–21 (issuance-notification assembly and delivery), step 24 (administrator courtesy copy), the Actors table, and the Postconditions bullet on audit recording — all to match the direct E2E-encrypted `PressIssuanceRecord`-to-`policy.auditors` model in `press.md §5.5` and `protocol-objects.md §11`. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md` Fix #11.

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

Card offering and acceptance is the process by which a press issues a targeted card to a specific recipient. The issuer's wallet service assembles and signs the offer blob and delivers it to the recipient; the recipient generates a fresh keypair and countersigns to accept; the press then validates the completed card and posts it as the final step. Neither party can unilaterally forge the other's commitment. The process applies to all targeted cards including policy cards and press sub-cards.

---

## Actors

| Actor | Role |
|---|---|
| **Requester** | Initiates the issuance request (may be the administrator, the recipient, or a third party, depending on policy) |
| **Issuer (offerer) / their wallet service** | Constructs the card offer and signs it with the **offerer's own card key** (`issuer_signature`); presents it to the recipient for countersignature; validates the countersigned result before forwarding it to the press |
| **Press** | Verifies predicates and policy compliance; signs the completed, countersigned card with the **press sub-card key** (`press_signature`); posts to IPFS and registers on-chain |
| **Recipient** | Reviews the offer, generates a keypair, countersigns to accept ownership (`holder_signature`) |
| **Administrator** | Receives the SCIP courtesy copy; does not receive the `PressIssuanceRecord` itself (that goes to auditors, see below) |
| **Auditor** | A card address listed in the policy's `auditors` array; receives a `PressIssuanceRecord` via E2E-encrypted message for every issuance under the policy, confirms receipt, and locally records it (see `log_auditing.md`) |

---

## Preconditions

- A valid policy card is published on IPFS and registered on Arbitrum One with `valid_until` in the future (if set).
- The press has a press sub-card whose pointer appears in the policy's `approved_presses`.
- The press's Arbitrum One wallet is funded for gas.

---

## Steps

### Phase 1: Request

1. The requester submits an issuance request to the press. The request includes:
   - The target policy's mutable pointer or CID.
   - The requester's card pointer (for predicate evaluation).
   - The intended recipient's identity (card pointer or invitation link delivery method).
   - Any issuer-specified field values allowed by the policy.

2. The press loads and validates the policy card:
   - Confirms `field_definitions` is present and non-empty.
   - Confirms `valid_until` has not passed (if set).
   - Confirms the press's own sub-card pointer appears in `approved_presses`.

### Phase 2: Predicate Evaluation

3. The press resolves the requester's card chain and evaluates `requester_predicate` from the **policy snapshot at `policy_id` CID**. If the predicate is absent, this step passes automatically.

4. The press resolves the recipient's card chain and evaluates `recipient_predicate` from the same policy snapshot. If the predicate is absent, this step passes automatically.

5. For every card in both chains, the press checks for 8xx and 9xx revocation entries. For each:
   - Confirm `effective_date` is after the current time (the card was valid at evaluation time).
   - If any ancestor is revoked with `effective_date` ≤ now, the press rejects the request with a specific error code and stops.

### Phase 3: Offer Assembly and Signing

6. The **issuer's wallet service** assembles the proposed card JSON (`CardDocument`):
   - Populates protocol-required fields: `policy_id`, `issuer_card` (the offerer's own card), `press_card` (the press that will validate and register), `issued_at`.
   - Leaves `recipient_pubkey`, `holder_signature`, and `press_signature` absent (offer phase).
   - Populates all required `field_definitions` fields per the policy.

7. The **issuer's wallet service** canonically serializes the offer (canonical RFC 8785 JSON).

8. The **issuer** signs the canonical serialization with the **offerer's own card key** → `issuer_signature`. (The offerer does not hold the press key; the press signs separately in Phase 6.)

### Phase 4: Offer Delivery

9. **First-time recipient (invitation link):** The **issuer's wallet service** encodes the offer as `mcard://invite?o=<base64>` and delivers it out of band (email, QR code, etc.).

10. **Existing recipient (HTTPS delivery):** The **issuer's wallet service** POSTs the signed offer directly to the recipient's wallet service endpoint.

### Phase 5: Recipient Review and Acceptance

11. The recipient's client receives the offer. If no keyring exists, the keyring setup flow runs first (see `wallet_backup_and_recovery.md`).

12. The client decodes the offer, verifies `issuer_signature` against the offerer's card key, and walks the offerer's (`issuer_card`) chain to a trusted root. If signature or chain verification fails at any link, the offer is rejected before being shown to the recipient.

13. The client displays a review screen showing:
    - Offerer identity and chain summary.
    - Full field values from the offer.
    - The governing policy's mutable pointer and `valid_until` (if set).
    - What countersigning commits the recipient to.

14. If the policy card or any ancestor is revoked with `effective_date` ≤ now, the offer is rejected with a reason shown to the recipient.

15. If the recipient accepts:
    - The client generates a fresh ML-DSA-44 keypair for this card.
    - The private key is stored in the keyring before proceeding (ensuring recoverability).
    - The recipient's public key is added to the card JSON as `recipient_pubkey`.
    - The client canonically serializes the offer including `recipient_pubkey` (excluding `holder_signature` and `press_signature`).
    - The client signs with the new private key → `holder_signature`, and returns the countersigned card to the offerer.

### Phase 6: Validation and Registration

16. The **offerer** validates the countersigned card — confirms `holder_signature` verifies against `recipient_pubkey` and covers the offer the offerer issued — then forwards it to the **press**.

17. The **press** validates the completed card: confirms `issuer_signature` and `holder_signature` verify against their respective keys, the offerer satisfies `requester_predicate`, all required fields are present, and field values conform to the policy schema. If validation passes, the press signs the complete document with its **press sub-card key** → `press_signature`, and posts the card to IPFS **encrypted** under the ADR-006 content key (`HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, AES-256-GCM). This is the first point at which content encryption applies — the offer-phase document (steps 6–8) was not content-encrypted because `recipient_pubkey` was not yet present.

18. The press creates a new Arbitrum One registry entry for the card, with the genesis CID as the initial log head. This write is authorized on-chain by the press's secp256r1 key registered in `PressAuthorizations` (see `ARCHITECTURE.md` ADR-011).

19. The press produces a **Signed Card Inclusion Proof (SCIP)**:
    - `card_cid` — CID of the completed card document.
    - `policy_log_entry_index` — position in the policy press log.
    - `policy_log_root_at_inclusion` — CID of the policy log head at time of issuance.
    - `issued_at` — matching the card's `issued_at`.
    - `press_signature` — ML-DSA-44 signature over all above fields.

20. The press resolves `policy.auditors` from the policy card (fetched via its own IPFS gateway; the policy card is a public document). If `policy.auditors` is empty or absent, the press skips steps 21–23 below — there are no auditors to notify.

21. For each auditor listed in `policy.auditors`, the press assembles a `PressIssuanceRecord`:
    - `card_cid` — CID of the completed card document.
    - `recipient_pubkey` — the recipient's ML-DSA-44 public key from the completed card.
    - `scip_cid` — CID of the SCIP posted to IPFS.
    - `issued_at` — matching the card's `issued_at` field.
    - `offer_type: "targeted"`.

    (See `protocol-objects.md §11` for the full schema.)

22. The press delivers the `PressIssuanceRecord` to each auditor as an E2E-encrypted message via the normal message routing layer (HTTPS to the auditor's wallet service endpoint, encrypted to the auditor card's public key), per `press.md §5.5`'s `appendIssuanceRecord`. The press awaits a confirmation message from each auditor acknowledging receipt and local recording, applying a configurable timeout (default: 30 seconds per auditor). An auditor that does not confirm within the timeout does not block issuance — the press logs a warning, alerts the policy administrator, and continues; which auditors confirmed and which timed out is recorded in the press's local state (not on IPFS).

23. The press sends the SCIP and a confirmation to the recipient via HTTPS to their wallet service endpoint.

24. The press sends the SCIP as a courtesy copy to the administrator via HTTPS to their wallet service endpoint (if configured in the policy). The `PressIssuanceRecord` itself is not sent to the administrator — it goes only to the addresses in `policy.auditors` per steps 20–22 above.

---

## Postconditions

- The completed card is pinned on IPFS with a stable CID.
- The card's Arbitrum One registry entry points to the genesis card document.
- The recipient holds the private key for `recipient_pubkey` in their keyring.
- The recipient holds the SCIP as proof of issuance.
- Every card address in `policy.auditors` (if any) has received a `PressIssuanceRecord` for this issuance via E2E-encrypted message and has (or, for a timed-out auditor, has not yet) confirmed receipt; confirmations are tracked in the press's local state.
- The completed card carries all three signatures: `issuer_signature` (offerer), `holder_signature` (recipient), and `press_signature` (press).
- Any verifier can confirm: all three signatures verify, card content conforms to the policy schema, the press that signed it is registered in `PressAuthorizations` for the policy, and the recipient's chain satisfied `recipient_predicate` — all from publicly available data.

---

## Error Paths

| Condition | Resolution |
|---|---|
| `requester_predicate` not satisfied | Press rejects with error; requester must resolve chain eligibility before retrying |
| `recipient_predicate` not satisfied | Press rejects with error; request cannot proceed until recipient's chain qualifies |
| Ancestor card revoked with `effective_date` ≤ now | Press rejects; requester must use an eligible chain |
| Press chain verification fails at recipient's client | Offer rejected before display; recipient should contact press operator |
| Recipient declines offer | No action; the unsigned offer expires per press retention policy |
| IPFS post fails before on-chain write | Retry IPFS post; do not write on-chain until CID is confirmed pinned |
| Arbitrum transaction reverts | Press retries; if press sub-card was revoked between steps, administrator must authorize a replacement press |
| Auditor does not confirm `PressIssuanceRecord` receipt within timeout | Issuance is not blocked; press logs a warning and alerts the policy administrator; unresponsive auditor is tracked in press local state |

---

## Related Specs

- `policy_creation.md` — must be complete before issuance begins
- `open_offer_creation.md` — alternative issuance path for batch/open offers
- `open_offer_acceptance_new_wallet.md` — open offer path for first-time recipients
- `open_offer_acceptance_existing_wallet.md` — open offer path for existing holders
- `log_auditing.md` — auditor-side receipt, confirmation, and inspection of `PressIssuanceRecord`s
- `wallet_backup_and_recovery.md` — keyring setup for first-time recipients
- `card_protocol_spec.md §2` — full feature spec for pressing cards
- `card_protocol_spec.md §4` — full feature spec for receiving a card as a user
- `protocol-objects.md §1` — `CardDocument` object reference
- `protocol-objects.md §10` — SCIP object reference
- `protocol-objects.md §11` — `PressIssuanceRecord` object reference
