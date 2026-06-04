# Acceptance of an Open Offer and Addition to an Existing Wallet — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt," "wallet" for "keyring," and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

This spec covers the flow for an **existing mark holder** who follows an open offer claim link and adds the resulting mark to their existing wallet. Because the recipient already has a wallet and signing keys, wallet setup is skipped. The claim is submitted using a freshly generated keypair for the new mark.

For first-time recipients who need to create a wallet, see `open_offer_acceptance_new_wallet.md`.

---

## Actors

| Actor | Role |
|---|---|
| **Recipient** | An existing mark holder with an active wallet and device sub-mark |
| **Wallet service** | Hosts the offer; handles claim submission to the press; updates the keyring on completion |
| **Press** | Validates the claim and issues the mark on-chain |
| **Issuer** | Created and signed the open offer (passive during acceptance) |

---

## Preconditions

- The recipient has followed a valid claim link.
- The recipient has an existing wallet with at least one active mark, a device sub-mark private key in secure storage, and a passkey for keyring access.
- The open offer has not expired and has not reached `max_acceptances`.
- The policy mark has `allow_open_offers: true`.

---

## Steps

### Phase 1: Offer Display and Verification

1. The recipient follows the claim link. The wallet service fetches and decodes the `OpenMarkOffer` document.

2. The wallet service — or the recipient's existing wallet client — verifies the offer before displaying it:
   - Verify `issuer_signature` over the canonical CBOR of all offer fields (excluding the signature itself).
   - Resolve the issuer's mark chain to a trusted root. If chain verification fails, **reject the offer before displaying it**.
   - Confirm the named press sub-mark pointer appears in the policy's `approved_presses`. If not, reject.

3. The wallet service displays the offer review screen:
   - **Issuer identity:** Mark pointer, chain summary.
   - **What you'll receive:** Proposed field values from `proposed_fields`, rendered with human-readable field names.
   - **Which wallet:** Confirm which of the recipient's existing wallets/marks will hold the new mark (if the recipient holds multiple).
   - **Constraints:** Slots remaining (if `max_acceptances` is set), expiry countdown (if `expires_at` is set).
   - **Redirect destination:** The `redirect_url`, displayed before navigation.
   - **Display message:** The issuer's `display_message` (if set).

4. The recipient reviews the offer. If they choose not to accept, the flow ends with no action.

### Phase 2: Key Generation for the New Mark

5. The client generates a fresh ML-DSA-44 keypair specifically for this new mark:
   - **Do not reuse** any existing mark keypair, sub-mark key, or master key.
   - Each mark owns a distinct keypair.

6. The client stores the new private key in the existing keyring before proceeding:
   - Decrypt the keyring (using `KDF(passkey_output, service_secret)`).
   - Append the new keypair entry (mark address → private key) to the keyring blob.
   - Re-encrypt and post the updated keyring blob to IPFS.
   - Wait for IPFS confirmation before proceeding to claim submission.

   The private key must be in the keyring before countersigning so that it is recoverable via the YubiKey backup flow even if the device is lost after signing but before the mark is received.

### Phase 3: Claim Submission

7. The client assembles the `claim_payload`:
   ```json
   {
     "offer":            { <verbatim OpenMarkOffer document including issuer_signature> },
     "recipient_pubkey": "<base64url — the freshly generated ML-DSA-44 public key>"
   }
   ```

8. The client canonically serializes `claim_payload` (canonical CBOR per RFC 8949 §4.2 with protocol-specific overrides).

9. The client signs the canonical serialization with the **new mark's private key** → `recipient_signature`.

   This signature proves the recipient controls the key that will own the issued mark. The device sub-mark key is not used here.

10. The wallet service submits an `OpenOfferClaimSubmission` to the press via HTTPS POST:
    ```json
    {
      "claim_payload":       { <claim_payload from Step 7> },
      "recipient_signature": "<base64url>"
    }
    ```

### Phase 4: Press Validation and Issuance

11. The press validates the submission:
    - Re-verify `claim_payload.offer.issuer_signature` over the offer document.
    - Verify `recipient_signature` over the canonical CBOR of `claim_payload`.
    - Confirm `claim_payload.offer.press_mark` matches the receiving press's own sub-mark pointer.
    - Confirm the policy has `allow_open_offers: true`.
    - Submit an atomic Arbitrum One transaction that: verifies the issuer's ML-DSA-44 signature over the offer payload; checks `block.timestamp < expires_at` (if set); checks `openOfferUseCounts[offer_id] < max_acceptances` (if set); atomically increments the counter and registers the mark. If any check fails, the transaction reverts.

12. If validation succeeds, the press assembles the `MarkDocument` from `proposed_fields` plus `recipient_pubkey`, signs it with the press sub-mark key (`offer_signature`), and posts it to IPFS.

13. The press registers the mark on Arbitrum One (included in the atomic transaction from Step 11).

14. The press logs the issuance in the policy's encrypted audit log (see `log_auditing.md`) with `offer_type: "open"`.

15. The press sends a confirmation to the wallet service. Optionally, the press sends a courtesy notification to the issuer via HTTPS to their wallet service endpoint.

### Phase 5: Completion

16. The wallet service receives the confirmation and verifies the new mark CID matches what was registered.

17. The wallet service updates the recipient's local mark list to include the new mark address and presents a confirmation screen:
    - Mark details (policy, field values, issuer).
    - Option to view the mark.

18. The wallet service displays the `redirect_url` to the recipient before navigating, warns against known phishing domains, and redirects.

---

## Postconditions

- The recipient's existing wallet now includes the new mark's private key in the keyring.
- The new mark is pinned on IPFS and registered on Arbitrum One.
- The on-chain acceptance counter for the offer has been atomically incremented.
- The issuance is recorded in the policy's encrypted audit log.
- The recipient did not need to set up a new passkey or re-derive the keyring decryption key (the existing credential was used).

---

## Difference from New Wallet Flow

| Step | New wallet | Existing wallet |
|---|---|---|
| Wallet setup | Required (Steps 5–9 of that spec) | Skipped entirely |
| Passkey | Created fresh | Already exists |
| Master keypair | Generated fresh | Already exists |
| Device sub-mark | Generated and registered | Already registered |
| Keyring for new mark key | Initialized, then updated | Updated only |
| Claim submission | Identical | Identical |
| Press validation | Identical | Identical |

---

## Error Paths

| Condition | Resolution |
|---|---|
| Offer issuer chain cannot be verified | Offer rejected before display |
| Press not in `approved_presses` | Offer rejected before display |
| `expires_at` has passed | Press rejects with "offer expired"; wallet service shows clear error |
| `max_acceptances` reached (race lost) | Press rejects with "offer full"; wallet service shows clear error |
| Keyring update fails before claim submission | Do not proceed to claim; retry keyring update; new private key must be safely stored before signing |
| Arbitrum transaction reverts | Press surfaces specific rejection reason to wallet service |
| Recipient's passkey unavailable (device change) | Recipient must complete YubiKey recovery first before keyring can be updated; see `wallet_backup_and_recovery.md` |

---

## Related Specs

- `open_offer_acceptance_new_wallet.md` — same flow for recipients without an existing wallet
- `open_offer_creation.md` — how the offer was created by the issuer
- `wallet_backup_and_recovery.md` — recovery path when the passkey is unavailable
- `mark_offering_and_acceptance.md` — targeted issuance alternative
- `chitt_protocol_spec.md §4` — receiving a mark feature spec (open offer receipt flow)
- `protocol-objects.md §6` — `OpenMarkOffer` object reference
- `protocol-objects.md §7` — `OpenOfferClaimSubmission` object reference
