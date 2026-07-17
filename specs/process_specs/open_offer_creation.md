# Creation of an Open Offer — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

An open offer is a pre-signed batch authorization allowing any bearer to claim a card under a given policy, without requiring the issuer to be online or review individual requests at claim time. The issuer signs the offer document, which specifies the field values for all cards issued under it and the constraints on how many may be claimed and by when. The offer is hosted on a wallet service and distributed as a claim link.

Open offers are only permitted when the policy card has `allow_open_offers: true`.

---

## Actors

| Actor | Role |
|---|---|
| **Issuer** | The card holder creating and signing the open offer |
| **Wallet service** | Hosts the signed offer and generates the claim link; handles acceptance submissions |
| **Press** | Named in the offer; validates and issues cards at claim time |
| **Recipients** | Any bearer who follows the claim link and submits a claim |

---

## Preconditions

- The policy card has `allow_open_offers: true`.
- The press sub-card pointer named in the offer appears in the policy's `approved_presses`.
- The issuer's card chain satisfies the policy's `requester_predicate` (if set).
- The issuer has a sub-card signing key available on their device.
- The wallet service is running and accessible by recipients.

---

## Steps

### Phase 1: Offer Assembly

1. The issuer determines the offer parameters:
   - **Policy:** The policy card CID (`policy_id`) under which cards will be issued.
   - **Press:** The mutable pointer of the approved press that will issue cards at claim time.
   - **max_acceptances:** Maximum number of claims allowed (null = unconstrained). An offer with both `max_acceptances` and `expires_at` null requires explicit issuer acknowledgment.
   - **expires_at:** Expiry timestamp after which no further claims are accepted (null = unconstrained).
   - **proposed_fields:** All issuer-populated field values for cards issued under this offer. These are the same for every recipient.
   - **display_message:** Optional human-readable context shown to recipients in the wallet UI.
   - **redirect_url:** URL to redirect recipients to after successful issuance (e.g., an onboarding page).

2. The issuer assembles the `OpenCardOffer` document:
   ```json
   {
     "offer_type":       "open",
     "policy_id":        "<base64url — CID of the governing policy card>",
     "press_card":       "<base64url — mutable pointer of the approved press>",
     "issuer_card":      "<base64url — mutable pointer of the issuer's card>",
     "issuer_pubkey":    "<base64url — ML-DSA-44 public key of the issuer's card, 1312 bytes raw>",
     "max_acceptances":  <integer | null>,
     "expires_at":       "<ISO 8601 timestamp | null>",
     "display_message":  "<optional human-readable context>",
     "redirect_url":     "<URL>",
     "proposed_fields":  {
       "<field name>": "<issuer-populated value>",
       "...": "..."
     }
   }
   ```

   The `issuer_pubkey` field is the ML-DSA-44 public key of the card referenced by `issuer_card`. The issuer sets this at offer creation time; it is included in the canonical serialization that `issuer_signature` covers, so any tampering with `issuer_pubkey` invalidates the signature.

3. The issuer validates the offer locally:
   - Confirm all required fields in the policy's `field_definitions` are present in `proposed_fields`.
   - Confirm field values conform to their type and validation constraints (regex, min/max, etc.).
   - Confirm `expires_at` (if set) is in the future.
   - Confirm `redirect_url` is a trusted destination (not a known phishing domain).

### Phase 2: Signing

4. The issuer canonically serializes all fields of the `OpenCardOffer` document except `issuer_signature` (canonical RFC 8785 JSON). This includes `issuer_pubkey`, which is therefore covered by the signature.

5. The issuer signs the canonical serialization with their sub-card private key → `issuer_signature`.

6. The **offer ID** is computed as: `hash(canonical RFC 8785 JSON of the complete document including issuer_signature)`. This is the key used in the Arbitrum One on-chain acceptance counter (`OpenOfferUseCounts`). It is unforgeable and unique per issuer.

### Phase 3: Publishing

> **Open architecture question.** Steps 7–9 describe the wallet service as the component that stores the offer and serves the hosted-form claim link. Neither `wallet.md` nor `press.md` currently defines a hosting endpoint or claim-link-resolution mechanism for `OpenCardOffer` documents — which component (wallet service, press, or a new component) actually owns this is undecided. See `wallet.md`'s own `OQ-WALLET-6` for the same gap documented from the wallet-service side. This spec's use of "wallet service" below is the working assumption, not a settled design; once decided, the hosting/claim-link-serving endpoint should be added to whichever component owns it and these steps updated to cite it.

7. The issuer submits the signed `OpenCardOffer` document to a wallet service via HTTPS POST.

8. The wallet service stores the offer and generates a **claim link**:
   - Short form: `mcard://claim?o=<base64url of offer>` (suitable for QR codes and deep links).
   - Hosted form: a wallet-service URL that serves the offer JSON on demand (suitable for long offers).

9. The wallet service returns the claim link to the issuer.

### Phase 4: Distribution

10. The issuer distributes the claim link via any channel appropriate to the use case:
    - Private message (targeted distribution; high trust)
    - QR code posted publicly (open distribution; lower trust per-recipient)
    - Email broadcast
    - Embedded in a web page

    **Security note:** The security of the resulting cards is bounded by the channel's trustworthiness. Anyone who obtains the claim link can claim a card (subject to `max_acceptances` and `expires_at`). Issuers should set appropriate constraints for public distribution.

---

## On-Chain Counter Initialization

The Arbitrum One acceptance counter for this offer (`OpenOfferUseCounts[offer_id]`) is **lazily initialized** — no pre-registration transaction is required. The counter is created and atomically incremented on the first successful claim. The press verifies the issuer's ML-DSA-44 signature off-chain as part of its pre-flight validation before submitting any transaction. The press then includes the `offer_id`, `max_acceptances`, and `expires_at` in calldata alongside each card registration so the contract can enforce capacity and expiry constraints atomically. The `issuer_signature` is not passed to the contract.

---

## Postconditions

- A signed `OpenCardOffer` document is stored on the wallet service.
- A claim link is available for distribution.
- The Arbitrum One counter for this offer is not yet initialized (lazy; created on first claim).
- Any recipient who follows the claim link and submits a valid claim will receive a card, subject to the stated constraints.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Policy card has `allow_open_offers: false` | The press will reject all claims; the issuer must update the policy to set `allow_open_offers: true` before creating the offer |
| `proposed_fields` missing a required field | Issuer must add the missing field before signing |
| Field value violates policy type or validation constraint | Issuer must correct the value before signing |
| `expires_at` is already in the past | Issuer must set a future expiry or set it to null |
| Both `max_acceptances` and `expires_at` are null | Wallet service requires explicit acknowledgment before publishing; issuer must confirm the unconstrained offer is intentional |
| Press sub-card pointer not in `approved_presses` | Claims under this offer will be rejected by the press; issuer must use a valid press pointer |

---

## Related Specs

- `open_offer_acceptance_new_wallet.md` — acceptance flow for first-time recipients
- `open_offer_acceptance_existing_wallet.md` — acceptance flow for existing card holders
- `card_offering_and_acceptance.md` — the targeted issuance alternative
- `policy_creation.md` — where `allow_open_offers` is set
- `card_protocol_spec.md §2` — Open offer issuance flow section
- `protocol-objects.md §6` — `OpenCardOffer` object reference
- `protocol-objects.md §14` — CardEntry (on-chain) object reference

---

**Changelog:** Fix #3 / Fix #5 (`plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`) — updated the superseded `RegistryEntry` citation to `CardEntry (on-chain)` and corrected `openOfferUseCounts` to the PascalCase `OpenOfferUseCounts` used by `registry_contract.md §3.5`.

**Changelog:** Fix #14 (`plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`) — flagged Phase 3 steps 7–9 as depending on an undecided open-offer hosting/claim-link architecture question; cross-referenced `wallet.md`'s `OQ-WALLET-6`.
