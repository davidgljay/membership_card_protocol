# Acceptance of an Open Offer and Addition to an Existing Wallet — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-07-04  
**Status:** Draft  
**Changes from v0.1:** Corrected the keyring update step (Step 6) to describe the wallet service's keyring storage and federation replication, replacing an earlier IPFS-based description.

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

This spec covers the flow for an **existing card holder** who follows an open offer claim link and adds the resulting card to their existing wallet. Because the recipient already has a wallet and signing keys, wallet setup is skipped. The claim is submitted using a freshly generated keypair for the new card.

For first-time recipients who need to create a wallet, see `open_offer_acceptance_new_wallet.md`.

---

## Actors

| Actor | Role |
|---|---|
| **Recipient** | An existing card holder with an active wallet and device sub-card |
| **Wallet service** | Hosts the offer; handles claim submission to the press; updates the keyring on completion |
| **Press** | Validates the claim and issues the card on-chain |
| **Issuer** | Created and signed the open offer (passive during acceptance) |

---

## Preconditions

- The recipient has followed a valid claim link.
- The recipient has an existing wallet with at least one active card, a device sub-card private key in secure storage, and a passkey for keyring access.
- The open offer has not expired and has not reached `max_acceptances`.
- The policy card has `allow_open_offers: true`.

---

## Steps

### Phase 1: Offer Display and Verification

1. The recipient follows the claim link. The wallet service fetches and decodes the `OpenCardOffer` document.

2. The wallet service — or the recipient's existing wallet client — verifies the offer before displaying it:
   - Confirm `keccak256(issuer_pubkey)` equals the `issuer_card` pointer address. A mismatch is a hard rejection — do not display the offer.
   - Verify `issuer_signature` over the canonical RFC 8785 JSON of all offer fields (excluding the signature itself) using `issuer_pubkey`.
   - Derive the issuer card's content key as `HKDF-SHA3-256(issuer_pubkey, info="card-content-v1")` and decrypt the issuer card. An AES-GCM authentication failure is a hard rejection.
   - Walk the issuer's card chain to a trusted root using the issuer card's `ancestry_pubkeys`. If chain verification fails, **reject the offer before displaying it**.
   - Confirm the named press sub-card is authorized for this policy by checking the **on-chain `PressAuthorizations` table** (`IsPressActive` for the policy's on-chain address). This is the authoritative check (see `ARCHITECTURE.md` ADR-011). The IPFS `approved_presses` array from the policy snapshot may be consulted as an advisory cross-check; where the two diverge, on-chain `PressAuthorizations` governs. If the press is not active in the on-chain table, reject the offer.

3. The wallet service displays the offer review screen:
   - **Issuer identity:** Card pointer, chain summary.
   - **What you'll receive:** Proposed field values from `proposed_fields`, rendered with human-readable field names.
   - **Which wallet:** Confirm which of the recipient's existing wallets/cards will hold the new card (if the recipient holds multiple).
   - **Constraints:** Slots remaining (if `max_acceptances` is set), expiry countdown (if `expires_at` is set).
   - **Redirect destination:** The `redirect_url`, displayed before navigation.
   - **Display message:** The issuer's `display_message` (if set).

4. The recipient reviews the offer. If they choose not to accept, the flow ends with no action.

### Phase 2: Key Generation for the New Card

5. The client generates a fresh ML-DSA-44 keypair specifically for this new card:
   - **Do not reuse** any existing card keypair, sub-card key, or master key.
   - Each card owns a distinct keypair.

6. The client stores the new private key in the existing keyring before proceeding:
   - Decrypt the keyring (using `KDF(passkey_output, service_secret)`).
   - Append the new keypair entry (card address → private key) to the keyring blob.
   - Re-encrypt the keyring blob and send it to the wallet service, which stores it under a new `keyring_id` and replicates it to every other wallet service in the federation (see `wallet_backup_and_recovery.md §Keyring Storage and Replication`).
   - Wait for the wallet service to confirm the updated keyring is stored before proceeding to claim submission.

   The private key must be in the keyring before countersigning so that it is recoverable via the YubiKey backup flow even if the device is lost after signing but before the card is received.

### Phase 3: Claim Submission

7. The client assembles the `claim_payload`:
   ```json
   {
     "offer":            { <verbatim OpenCardOffer document including issuer_signature> },
     "recipient_pubkey": "<base64url — the freshly generated ML-DSA-44 public key>"
   }
   ```

8. The client canonically serializes `claim_payload` (canonical RFC 8785 JSON).

9. The client signs the canonical serialization with the **new card's private key** → `recipient_signature`.

   This signature proves the recipient controls the key that will own the issued card. The device sub-card key is not used here.

10. The wallet service submits an `OpenOfferClaimSubmission` to the press via HTTPS POST:
    ```json
    {
      "claim_payload":       { <claim_payload from Step 7> },
      "recipient_signature": "<base64url>"
    }
    ```

### Phase 4: Press Validation and Issuance

11. The press validates the submission:
    - Confirm `keccak256(claim_payload.offer.issuer_pubkey)` equals the `claim_payload.offer.issuer_card` pointer address. A mismatch is a hard press-side rejection (E-14).
    - Re-verify `claim_payload.offer.issuer_signature` over the canonical RFC 8785 JSON of all offer fields (excluding `issuer_signature`) using `issuer_pubkey`. An AES-GCM failure when decrypting the issuer card is also a hard rejection (E-14).
    - Verify `recipient_signature` over the canonical RFC 8785 JSON of `claim_payload`.
    - Confirm `claim_payload.offer.press_card` matches the receiving press's own sub-card pointer.
    - Confirm the policy has `allow_open_offers: true`.
    - Submit an atomic Arbitrum One transaction that: checks `block.timestamp < expires_at` (if set); checks `openOfferUseCounts[offer_id] < max_acceptances` (if set); atomically increments the counter and registers the card. (Issuer-signature verification is press-side only — the contract does not receive or re-verify it.) If any check fails, the transaction reverts.

12. If validation succeeds, the press assembles the `CardDocument` from `proposed_fields` plus `recipient_pubkey`, signs it with the press sub-card key (`press_signature`), and posts it to IPFS **encrypted** under the ADR-006 content key (`HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, AES-256-GCM). (The offerer's `issuer_signature` on the `OpenCardOffer` and the recipient's `holder_signature` are the other two signatures.) This is the first point at which content encryption applies — the open offer document was not content-encrypted because no `recipient_pubkey` was present at offer-creation time.

13. The press registers the card on Arbitrum One (included in the atomic transaction from Step 11).

14. The press logs the issuance in the policy's encrypted audit log (see `log_auditing.md`) with `offer_type: "open"`.

15. The press sends a confirmation to the wallet service. Optionally, the press sends a courtesy notification to the issuer via HTTPS to their wallet service endpoint.

### Phase 5: Completion

16. The wallet service receives the confirmation and verifies the new card CID matches what was registered.

17. The wallet service updates the recipient's local card list to include the new card address and presents a confirmation screen:
    - Card details (policy, field values, issuer).
    - Option to view the card.

18. The wallet service displays the `redirect_url` to the recipient before navigating, warns against known phishing domains, and redirects.

---

## Postconditions

- The recipient's existing wallet now includes the new card's private key in the keyring.
- The new card is pinned on IPFS and registered on Arbitrum One.
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
| Device sub-card | Generated and registered | Already registered |
| Keyring for new card key | Initialized, then updated | Updated only |
| Claim submission | Identical | Identical |
| Press validation | Identical | Identical |

---

## Error Paths

| Condition | Resolution |
|---|---|
| Offer issuer chain cannot be verified | Offer rejected before display |
| Press not active in on-chain `PressAuthorizations` for this policy | Offer rejected before display |
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
- `card_offering_and_acceptance.md` — targeted issuance alternative
- `card_protocol_spec.md §4` — receiving a card feature spec (open offer receipt flow)
- `protocol-objects.md §6` — `OpenCardOffer` object reference
- `protocol-objects.md §7` — `OpenOfferClaimSubmission` object reference
- `specs/object_specs/wallet.md` — wallet service wire protocol for keyring updates and WebAuthn passkey login
