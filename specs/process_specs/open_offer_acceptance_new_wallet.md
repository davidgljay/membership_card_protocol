# Acceptance of an Open Offer and Creation of a New Wallet — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt," "wallet" for "keyring," and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

This spec covers the flow for a **first-time recipient** — a person who has no existing wallet or mark identity — who follows an open offer claim link and sets up a wallet in the process of claiming their first mark. Wallet creation and offer acceptance are combined into a single guided flow so the recipient does not need prior protocol knowledge.

For recipients who already have a wallet, see `open_offer_acceptance_existing_wallet.md`.

---

## Actors

| Actor | Role |
|---|---|
| **Recipient** | A first-time user with no existing wallet or marks |
| **Wallet service** | Hosts the offer; guides the recipient through wallet creation; submits the claim to the press |
| **Press** | Validates the claim and issues the mark on-chain |
| **Issuer** | Created and signed the open offer (passive during acceptance) |

---

## Preconditions

- The recipient has followed a valid claim link (`mark://claim?o=<base64>` or hosted URL).
- The open offer has not expired (`expires_at` is null or in the future).
- The open offer has not reached `max_acceptances` (or `max_acceptances` is null).
- The policy mark has `allow_open_offers: true`.
- The recipient has no existing wallet or mark identity on this device.

---

## Steps

### Phase 1: Offer Display and Verification

1. The recipient follows the claim link. The wallet service fetches and decodes the `OpenMarkOffer` document.

2. The wallet service verifies the offer before displaying it:
   - Verify `issuer_signature` over the canonical CBOR of all offer fields (excluding the signature itself).
   - Resolve the issuer's mark chain to a trusted root. If chain verification fails, **reject the offer before displaying it** with a clear error: "This offer could not be verified. Do not proceed."
   - Confirm the named press sub-mark pointer appears in the policy's `approved_presses`. If not, reject.

3. The wallet service displays the offer review screen:
   - **Issuer identity:** Mark pointer, chain summary (who issued the issuer's mark, tracing to a trusted root).
   - **What you'll receive:** The proposed field values from `proposed_fields`, rendered with human-readable field names from `field_definitions`.
   - **Constraints:** Slots remaining (if `max_acceptances` is set), expiry countdown (if `expires_at` is set).
   - **Redirect destination:** The `redirect_url`, displayed so the recipient can evaluate it before deciding.
   - **Display message:** The issuer's `display_message` (if set).

4. The recipient reviews the offer. If they choose not to accept, the flow ends with no action.

### Phase 2: Wallet Creation

5. Since the recipient has no existing wallet, the wallet service presents the **wallet setup flow** before allowing acceptance. The recipient must complete this before countersigning.

6. The wallet service guides the recipient through passkey creation:
   - The client generates a platform-bound passkey (WebAuthn, using the device's authenticator — Face ID, Touch ID, Windows Hello, etc.).
   - The wallet service generates a `service_secret` — a random value retained by the service.
   - The **keyring decryption key** is derived as: `KDF(passkey_output, service_secret)`. Neither alone is sufficient to decrypt the keyring.

7. The client generates the recipient's **master mark keypair** (ML-DSA-44):
   - The private key is stored in the keyring encrypted with the keyring decryption key.
   - The keyring blob is posted to IPFS (append-only encrypted blob).
   - The master private key is never stored in plaintext outside secure storage.

8. The client generates a **device sub-mark keypair**:
   - The sub-mark private key is stored in secure device storage (Secure Enclave on Apple devices, TPM on others), scoped to this application.
   - The master mark key signs a sub-mark registration, binding the sub-mark to the master.
   - The sub-mark registration is posted on Arbitrum One.

9. The wallet service prompts the recipient to optionally set up a YubiKey backup (see `wallet_backup_and_recovery.md`). This step is strongly recommended but may be deferred.

10. Wallet creation is complete. The recipient now has:
    - A master mark keypair (private key in the keyring on IPFS).
    - A device sub-mark keypair (private key in secure device storage).
    - A passkey for re-deriving the keyring decryption key.

### Phase 3: Claim Submission

11. The client generates a fresh ML-DSA-44 keypair specifically for this new mark:
    - **Do not reuse** the master or sub-mark keys for issued mark ownership.
    - The private key is stored in the keyring before proceeding (ensuring recoverability).

12. The client assembles the `claim_payload`:
    ```json
    {
      "offer":            { <verbatim OpenMarkOffer document including issuer_signature> },
      "recipient_pubkey": "<base64url — the freshly generated ML-DSA-44 public key>"
    }
    ```

13. The client canonically serializes `claim_payload` (canonical CBOR).

14. The client signs the canonical serialization with the new mark's private key → `recipient_signature`.

    > Note: The recipient signs with the **new mark's private key** (not the device sub-mark key). This signature proves the recipient controls the key that will own the issued mark.

15. The wallet service submits an `OpenOfferClaimSubmission` to the press via HTTPS POST:
    ```json
    {
      "claim_payload":        { <claim_payload from Step 12> },
      "recipient_signature":  "<base64url>"
    }
    ```

### Phase 4: Press Validation and Issuance

16. The press validates the submission:
    - Re-verify `claim_payload.offer.issuer_signature` over the offer document.
    - Verify `recipient_signature` over the canonical CBOR of `claim_payload`.
    - Confirm `claim_payload.offer.press_mark` matches the receiving press's own sub-mark pointer.
    - Confirm the policy has `allow_open_offers: true`.
    - Submit an atomic Arbitrum One transaction that: verifies the issuer's ML-DSA-44 signature over the offer payload; checks `block.timestamp < expires_at` (if set); checks `openOfferUseCounts[offer_id] < max_acceptances` (if set); atomically increments the counter and registers the mark. If any check fails, the transaction reverts.

17. If validation succeeds, the press assembles the `MarkDocument` from `proposed_fields` plus `recipient_pubkey`, signs it with the press sub-mark key (`offer_signature`), and posts it to IPFS.

18. The press registers the mark on Arbitrum One (included in the atomic transaction from Step 16).

19. The press logs the issuance in the policy's encrypted audit log (see `log_auditing.md`) with `offer_type: "open"`.

20. The press sends a confirmation to the wallet service.

### Phase 5: Completion

21. The wallet service receives the confirmation. It:
    - Updates the recipient's keyring to include the new mark address and its associated private key.
    - Presents a confirmation screen: mark details, issuer identity summary, and a link to view the mark.

22. The wallet service displays the `redirect_url` to the recipient before navigating, and warns against known phishing domains.

23. The wallet service redirects the recipient to `redirect_url`.

---

## Postconditions

- The recipient holds a complete wallet: master keypair in the encrypted keyring, device sub-mark for routine signing.
- The recipient holds the private key for the new mark in their keyring.
- The mark is pinned on IPFS and registered on Arbitrum One.
- The on-chain acceptance counter for the offer has been atomically incremented.
- The issuance is recorded in the policy's encrypted audit log.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Offer issuer chain cannot be verified | Offer rejected before display; recipient should not proceed |
| Press not in `approved_presses` | Offer rejected before display |
| `expires_at` has passed | Press rejects with "offer expired"; wallet service shows clear error to recipient |
| `max_acceptances` reached (race lost) | Press rejects with "offer full"; wallet service shows clear error to recipient |
| Passkey creation fails on device | Wallet creation cannot complete; recipient must use a supported device or browser |
| Keyring IPFS post fails | Retry; do not allow the recipient to proceed to claim until keyring is posted |
| Arbitrum transaction reverts | Press surfaces specific rejection reason to wallet service; wallet service shows it to recipient |

---

## Related Specs

- `open_offer_acceptance_existing_wallet.md` — same flow for recipients with an existing wallet
- `open_offer_creation.md` — how the offer was created by the issuer
- `wallet_backup_and_recovery.md` — YubiKey backup setup (recommended after wallet creation)
- `mark_offering_and_acceptance.md` — targeted issuance alternative
- `chitt_protocol_spec.md §3` — keyring setup feature spec
- `chitt_protocol_spec.md §4` — receiving a mark feature spec
- `protocol-objects.md §6` — `OpenMarkOffer` object reference
- `protocol-objects.md §7` — `OpenOfferClaimSubmission` object reference
