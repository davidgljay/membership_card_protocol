# Acceptance of an Open Offer and Creation of a New Wallet — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-07-04  
**Status:** Draft  
**Changes from v0.1:** Corrected wallet creation (Step 7) and the keyring error path to describe the wallet service's keyring storage and federation replication, replacing an earlier IPFS-based description.

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

This spec covers the flow for a **first-time recipient** — a person who has no existing wallet or card identity — who follows an open offer claim link and sets up a wallet in the process of claiming their first card. Wallet creation and offer acceptance are combined into a single guided flow so the recipient does not need prior protocol knowledge.

For recipients who already have a wallet, see `open_offer_acceptance_existing_wallet.md`.

---

## Actors

| Actor | Role |
|---|---|
| **Recipient** | A first-time user with no existing wallet or cards |
| **Wallet service** | Hosts the offer; guides the recipient through wallet creation; submits the claim to the press |
| **Press** | Validates the claim and issues the card on-chain |
| **Issuer** | Created and signed the open offer (passive during acceptance) |

---

## Preconditions

> **Open architecture question.** Which component actually hosts the `OpenCardOffer` document and serves the claim link (wallet service, press, or a new component) is currently undecided — see `open_offer_creation.md` Phase 3 and `wallet.md`'s `OQ-WALLET-6`. The precondition and Step 1 below assume wallet-service hosting as a working placeholder.

- The recipient has followed a valid claim link — a URL hosted by the wallet service (e.g., `https://<wallet-service>/claim/<offer-id>`). This is the wallet service around which the new user's wallet will be initialized; in most cases it is the same service the issuer used to create the open offer.
- The open offer has not expired (`expires_at` is null or in the future).
- The open offer has not reached `max_acceptances` (or `max_acceptances` is null).
- The policy card has `allow_open_offers: true`.
- The recipient has no existing wallet or card identity on this device.

---

## Steps

### Phase 1: Offer Display and Verification

1. The recipient follows the claim link — a URL hosted by the wallet service (e.g., `https://<wallet-service>/claim/<offer-id>`). The wallet service resolves the offer by ID and decodes the `OpenCardOffer` document. Because the link is hosted by the wallet service, the service that serves this page is also the service around which the recipient's wallet will be created.

2. The wallet service verifies the offer before displaying it:
   - Confirm `keccak256(issuer_pubkey)` equals the `issuer_card` pointer address. A mismatch is a hard rejection — do not display the offer.
   - Verify `issuer_signature` over the canonical RFC 8785 JSON of all offer fields (excluding the signature itself) using `issuer_pubkey`.
   - Derive the issuer card's content key as `HKDF-SHA3-256(issuer_pubkey, info="card-content-v1")` and decrypt the issuer card. An AES-GCM authentication failure is a hard rejection.
   - Walk the issuer's card chain to a trusted root using the issuer card's `ancestry_pubkeys`. If chain verification fails, **reject the offer before displaying it** with a clear error: "This offer could not be verified. Do not proceed."
   - Confirm the named press sub-card is authorized for this policy by checking the **on-chain `PressAuthorizations` table** (`IsPressActive` for the policy's on-chain address). This is the authoritative check (see `ARCHITECTURE.md` ADR-011). The IPFS `approved_presses` array from the policy snapshot may be consulted as an advisory cross-check; where the two diverge, on-chain `PressAuthorizations` governs. If the press is not active in the on-chain table, reject the offer.

3. The wallet service displays the offer review screen:
   - **Issuer identity:** Card pointer, chain summary (who issued the issuer's card, tracing to a trusted root).
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

7. The client generates the recipient's **master card keypair** (ML-DSA-44):
   - The private key is stored in the keyring encrypted with the keyring decryption key.
   - The keyring blob (append-only encrypted store) is sent to the wallet service, which stores it and replicates it to every other wallet service in the federation (see `wallet_backup_and_recovery.md §Keyring Storage and Replication`).
   - The master private key is never stored in plaintext outside secure storage.

8. The client generates a **device sub-card keypair**:
   - The sub-card private key is stored in secure device storage (Secure Enclave on Apple devices, TPM on others), scoped to this application.
   - The master card key signs a sub-card registration, binding the sub-card to the master.
   - The sub-card registration is posted on Arbitrum One.

9. The wallet service prompts the recipient to optionally set up a YubiKey backup (see `wallet_backup_and_recovery.md`). This step is strongly recommended but may be deferred.

10. Wallet creation is complete. The recipient now has:
    - A master card keypair (private key in the keyring, stored with the wallet service and replicated across the wallet service federation).
    - A device sub-card keypair (private key in secure device storage).
    - A passkey for re-deriving the keyring decryption key.

### Phase 3: Claim Submission

11. The client generates a fresh ML-DSA-44 keypair specifically for this new card:
    - **Do not reuse** the master or sub-card keys for issued card ownership.
    - The private key is stored in the keyring before proceeding (ensuring recoverability).

12. The client assembles the `claim_payload`:
    ```json
    {
      "offer":            { <verbatim OpenCardOffer document including issuer_signature> },
      "recipient_pubkey": "<base64url — the freshly generated ML-DSA-44 public key>"
    }
    ```

13. The client canonically serializes `claim_payload` (canonical RFC 8785 JSON).

14. The client signs the canonical serialization with the new card's private key → `recipient_signature`.

    > Note: The recipient signs with the **new card's private key** (not the device sub-card key). This signature proves the recipient controls the key that will own the issued card.

15. The wallet service submits an `OpenOfferClaimSubmission` to the press via HTTPS POST:
    ```json
    {
      "claim_payload":        { <claim_payload from Step 12> },
      "recipient_signature":  "<base64url>"
    }
    ```

### Phase 4: Press Validation and Issuance

16. The press validates the submission:
    - Confirm `keccak256(claim_payload.offer.issuer_pubkey)` equals the `claim_payload.offer.issuer_card` pointer address. A mismatch is a hard press-side rejection (E-14).
    - Re-verify `claim_payload.offer.issuer_signature` over the canonical RFC 8785 JSON of all offer fields (excluding `issuer_signature`) using `issuer_pubkey`. An AES-GCM failure when decrypting the issuer card is also a hard rejection (E-14).
    - Verify `recipient_signature` over the canonical RFC 8785 JSON of `claim_payload`.
    - Confirm `claim_payload.offer.press_card` matches the receiving press's own sub-card pointer.
    - Confirm the policy has `allow_open_offers: true`.
    - Submit an atomic Arbitrum One transaction that: checks `block.timestamp < expires_at` (if set); checks `OpenOfferUseCounts[offer_id] < max_acceptances` (if set); atomically increments the counter and registers the card. (Issuer-signature verification is press-side only — the contract does not receive or re-verify it.) If any check fails, the transaction reverts.

17. If validation succeeds, the press assembles the `CardDocument` from `proposed_fields` plus `recipient_pubkey`, signs it with the press sub-card key (`press_signature`), and posts it to IPFS **encrypted** under the ADR-006 content key (`HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, AES-256-GCM). (The offerer's `issuer_signature` on the `OpenCardOffer` and the recipient's `holder_signature` are the other two signatures.) This is the first point at which content encryption applies — the open offer document was not content-encrypted because no `recipient_pubkey` was present at offer-creation time.

18. The press registers the card on Arbitrum One (included in the atomic transaction from Step 16).

19. The press logs the issuance in the policy's encrypted audit log (see `log_auditing.md`) with `offer_type: "open"`.

20. The press sends a confirmation to the wallet service.

### Phase 5: Completion

21. The wallet service receives the confirmation. It:
    - Updates the recipient's keyring to include the new card address and its associated private key.
    - Presents a confirmation screen: card details, issuer identity summary, and a link to view the card.

22. The wallet service displays the `redirect_url` to the recipient before navigating, and warns against known phishing domains.

23. The wallet service redirects the recipient to `redirect_url`.

---

## Postconditions

- The recipient holds a complete wallet: master keypair in the encrypted keyring, device sub-card for routine signing.
- The recipient holds the private key for the new card in their keyring.
- The card is pinned on IPFS and registered on Arbitrum One.
- The on-chain acceptance counter for the offer has been atomically incremented.
- The issuance is recorded in the policy's encrypted audit log.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Offer issuer chain cannot be verified | Offer rejected before display; recipient should not proceed |
| Press not active in on-chain `PressAuthorizations` for this policy | Offer rejected before display |
| `expires_at` has passed | Press rejects with "offer expired"; wallet service shows clear error to recipient |
| `max_acceptances` reached (race lost) | Press rejects with "offer full"; wallet service shows clear error to recipient |
| Passkey creation fails on device | Wallet creation cannot complete; recipient must use a supported device or browser |
| Keyring storage or federation replication fails | Retry; do not allow the recipient to proceed to claim until the keyring blob is stored and replicated |
| Arbitrum transaction reverts | Press surfaces specific rejection reason to wallet service; wallet service shows it to recipient |

---

## Related Specs

- `open_offer_acceptance_existing_wallet.md` — same flow for recipients with an existing wallet
- `open_offer_creation.md` — how the offer was created by the issuer
- `wallet_backup_and_recovery.md` — YubiKey backup setup (recommended after wallet creation)
- `card_offering_and_acceptance.md` — targeted issuance alternative
- `card_protocol_spec.md §3` — keyring setup feature spec
- `card_protocol_spec.md §4` — receiving a card feature spec
- `protocol-objects.md §6` — `OpenCardOffer` object reference
- `protocol-objects.md §7` — `OpenOfferClaimSubmission` object reference
- `specs/object_specs/wallet.md` — wallet service wire protocol for account creation and keyring storage

---

**Changelog:** Fix #12 (`plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`) — corrected `openOfferUseCounts` to the PascalCase `OpenOfferUseCounts` used by `registry_contract.md §3.5`. Fix #14 — flagged the Precondition/Step 1 claim-link hosting assumption as an open architecture question; cross-referenced `wallet.md`'s `OQ-WALLET-6`.
