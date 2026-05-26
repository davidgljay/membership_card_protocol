# Mark Offering and Acceptance — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" to refer to what other docs call a "chitt," and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

Mark offering and acceptance is the process by which a press issues a targeted mark to a specific recipient. The press commits to the offer by signing it first; the recipient reviews, generates a fresh keypair, and countersigns to accept. Neither party can unilaterally forge the other's commitment. The process applies to all targeted marks including policy marks and press sub-marks.

---

## Actors

| Actor | Role |
|---|---|
| **Requester** | Initiates the issuance request (may be the administrator, the recipient, or a third party, depending on policy) |
| **Press** | Verifies predicates, signs the offer, posts to IPFS, registers on-chain |
| **Recipient** | Reviews the offer, generates a keypair, countersigns to accept ownership |
| **Administrator** | Receives SCIP courtesy copy; may be notified of issuance |

---

## Preconditions

- A valid policy mark is published on IPFS and registered on Arbitrum One with `valid_until` in the future (if set).
- The press has a press sub-mark whose pointer appears in the policy's `approved_presses`.
- The press's Arbitrum One wallet is funded for gas.
- An audit epoch is open for this policy, or the press is prepared to open one before logging the issuance.

---

## Steps

### Phase 1: Request

1. The requester submits an issuance request to the press. The request includes:
   - The target policy's mutable pointer or CID.
   - The requester's mark pointer (for predicate evaluation).
   - The intended recipient's identity (mark pointer, Nym gateway address, or invitation link delivery method).
   - Any issuer-specified field values allowed by the policy.

2. The press loads and validates the policy mark:
   - Confirms `field_definitions` is present and non-empty.
   - Confirms `valid_until` has not passed (if set).
   - Confirms the press's own sub-mark pointer appears in `approved_presses`.

### Phase 2: Predicate Evaluation

3. The press resolves the requester's mark chain and evaluates `requester_predicate` from the **policy snapshot at `policy_id` CID**. If the predicate is absent, this step passes automatically.

4. The press resolves the recipient's mark chain and evaluates `recipient_predicate` from the same policy snapshot. If the predicate is absent, this step passes automatically.

5. For every mark in both chains, the press checks for 8xx and 9xx revocation entries. For each:
   - Confirm `effective_date` is after the current time (the mark was valid at evaluation time).
   - If any ancestor is revoked with `effective_date` ≤ now, the press rejects the request with a specific error code and stops.

### Phase 3: Offer Assembly and Signing

6. The press assembles the proposed mark JSON (`MarkDocument`):
   - Populates all protocol-required fields: `policy_id`, `press_mark`, `issued_at`.
   - Leaves `recipient_pubkey` and `holder_signature` absent (offer phase).
   - Populates all required `field_definitions` fields per the policy.

7. The press canonically serializes the offer document (canonical CBOR per RFC 8949 §4.2 with protocol-specific overrides for binary fields and timestamps).

8. The press signs the canonical serialization with its press sub-mark private key → `offer_signature`.

### Phase 4: Offer Delivery

9. **First-time recipient (invitation link):** The offer is encoded as `mark://invite?o=<base64>` and delivered out of band (Nym, email, QR code, etc.).

10. **Existing recipient (Nym delivery):** The signed offer is sent directly to the recipient's registered Nym gateway.

### Phase 5: Recipient Review and Acceptance

11. The recipient's client receives the offer. If no keyring exists, the keyring setup flow runs first (see `wallet_backup_and_recovery.md`).

12. The client decodes the offer and walks the press sub-mark chain to a trusted root. If chain verification fails at any link, the offer is rejected before being shown to the recipient.

13. The client displays a review screen showing:
    - Press identity and chain summary.
    - Full field values from the offer.
    - The governing policy's mutable pointer and `valid_until` (if set).
    - What countersigning commits the recipient to.

14. If the policy mark or any ancestor is revoked with `effective_date` ≤ now, the offer is rejected with a reason shown to the recipient.

15. If the recipient accepts:
    - The client generates a fresh ML-DSA-44 keypair for this mark.
    - The private key is stored in the keyring before proceeding (ensuring recoverability).
    - The recipient's public key is added to the mark JSON as `recipient_pubkey`.
    - The client canonically serializes the complete mark document (including `recipient_pubkey`).
    - The client signs with the new private key → `holder_signature`.

### Phase 6: Completion and Registration

16. The completed mark — containing `offer_signature`, `recipient_pubkey`, and `holder_signature` — is posted to IPFS. Either the recipient's client or the press may post it.

17. The press creates a new Arbitrum One registry entry for the mark, with the genesis CID as the initial log head. This write is signed with the press sub-mark key and verified on-chain against `approved_presses`.

18. The press ensures an audit epoch is open for this policy. If not, it opens one first (see `log_auditing.md`).

19. The press constructs a `PressIssuanceRecord` containing:
    - `epoch_id` — identifier of the current open audit epoch.
    - `chitt_cid` — CID of the completed mark document.
    - `issued_at` — matching the mark's `issued_at` field.
    - `requester_mark` — mutable pointer of the requester (if present).
    - `offer_type: "targeted"`.

20. The press encrypts the record with the current epoch AEK (AES-GCM, fresh 96-bit nonce per entry) and appends it to the policy mark's IPFS log, then updates the policy mark's Arbitrum One registry pointer to the new log head.

21. The press produces a **Signed Mark Inclusion Proof (SCIP)**:
    - `mark_cid` — CID of the completed mark document.
    - `policy_log_entry_index` — position in the policy press log.
    - `policy_log_root_at_inclusion` — CID of the policy log head at time of issuance.
    - `issued_at` — matching the mark's `issued_at`.
    - `press_signature` — ML-DSA-44 signature over all above fields.

22. The press sends the SCIP and a confirmation to the recipient via Nym.

23. The press sends an audit record (mark CID + SCIP) to the administrator via Nym.

---

## Postconditions

- The completed mark is pinned on IPFS with a stable CID.
- The mark's Arbitrum One registry entry points to the genesis mark document.
- The recipient holds the private key for `recipient_pubkey` in their keyring.
- The recipient holds the SCIP as proof of issuance.
- The issuance is recorded in the policy's encrypted audit log.
- Any verifier can confirm: mark content conforms to the policy schema, the press sub-mark that signed it is in `approved_presses`, and the recipient's chain satisfied `recipient_predicate` — all from publicly available data.

---

## Error Paths

| Condition | Resolution |
|---|---|
| `requester_predicate` not satisfied | Press rejects with error; requester must resolve chain eligibility before retrying |
| `recipient_predicate` not satisfied | Press rejects with error; request cannot proceed until recipient's chain qualifies |
| Ancestor mark revoked with `effective_date` ≤ now | Press rejects; requester must use an eligible chain |
| Press chain verification fails at recipient's client | Offer rejected before display; recipient should contact press operator |
| Recipient declines offer | No action; the unsigned offer expires per press retention policy |
| IPFS post fails before on-chain write | Retry IPFS post; do not write on-chain until CID is confirmed pinned |
| Arbitrum transaction reverts | Press retries; if press sub-mark was revoked between steps, administrator must authorize a replacement press |

---

## Related Specs

- `policy_creation.md` — must be complete before issuance begins
- `open_offer_creation.md` — alternative issuance path for batch/open offers
- `open_offer_acceptance_new_wallet.md` — open offer path for first-time recipients
- `open_offer_acceptance_existing_wallet.md` — open offer path for existing holders
- `log_auditing.md` — audit epoch management
- `wallet_backup_and_recovery.md` — keyring setup for first-time recipients
- `chitt_protocol_spec.md §2` — full feature spec for pressing marks
- `chitt_protocol_spec.md §4` — full feature spec for receiving a mark as a user
- `protocol-objects.md §1` — `MarkDocument` object reference
- `protocol-objects.md §10` — SCIP object reference
- `protocol-objects.md §11` — `PressIssuanceRecord` object reference
