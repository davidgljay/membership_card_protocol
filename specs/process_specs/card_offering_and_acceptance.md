# Card Offering and Acceptance — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

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
| **Administrator** | Receives SCIP courtesy copy; may be notified of issuance |

---

## Preconditions

- A valid policy card is published on IPFS and registered on Arbitrum One with `valid_until` in the future (if set).
- The press has a press sub-card whose pointer appears in the policy's `approved_presses`.
- The press's Arbitrum One wallet is funded for gas.
- An audit epoch is open for this policy, or the press is prepared to open one before logging the issuance.

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

19. The press ensures an audit epoch is open for this policy. If not, it opens one first (see `log_auditing.md`).

20. The press constructs a `PressIssuanceRecord` containing:
    - `epoch_id` — identifier of the current open audit epoch.
    - `card_cid` — CID of the completed card document.
    - `issued_at` — matching the card's `issued_at` field.
    - `requester_card` — mutable pointer of the requester (if present).
    - `offer_type: "targeted"`.

21. The press encrypts the record with the current epoch AEK (AES-GCM, fresh 96-bit nonce per entry) and appends it to the policy card's IPFS log, then updates the policy card's Arbitrum One registry pointer to the new log head.

22. The press produces a **Signed Card Inclusion Proof (SCIP)**:
    - `card_cid` — CID of the completed card document.
    - `policy_log_entry_index` — position in the policy press log.
    - `policy_log_root_at_inclusion` — CID of the policy log head at time of issuance.
    - `issued_at` — matching the card's `issued_at`.
    - `press_signature` — ML-DSA-44 signature over all above fields.

23. The press sends the SCIP and a confirmation to the recipient via HTTPS to their wallet service endpoint.

24. The press sends an audit record (card CID + SCIP) to the administrator via HTTPS to their wallet service endpoint.

---

## Postconditions

- The completed card is pinned on IPFS with a stable CID.
- The card's Arbitrum One registry entry points to the genesis card document.
- The recipient holds the private key for `recipient_pubkey` in their keyring.
- The recipient holds the SCIP as proof of issuance.
- The issuance is recorded in the policy's encrypted audit log.
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

---

## Related Specs

- `policy_creation.md` — must be complete before issuance begins
- `open_offer_creation.md` — alternative issuance path for batch/open offers
- `open_offer_acceptance_new_wallet.md` — open offer path for first-time recipients
- `open_offer_acceptance_existing_wallet.md` — open offer path for existing holders
- `log_auditing.md` — audit epoch management
- `wallet_backup_and_recovery.md` — keyring setup for first-time recipients
- `card_protocol_spec.md §2` — full feature spec for pressing cards
- `card_protocol_spec.md §4` — full feature spec for receiving a card as a user
- `protocol-objects.md §1` — `CardDocument` object reference
- `protocol-objects.md §10` — SCIP object reference
- `protocol-objects.md §11` — `PressIssuanceRecord` object reference
