# Creation of an Open Offer — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt" and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

An open offer is a pre-signed batch authorization allowing any bearer to claim a mark under a given policy, without requiring the issuer to be online or review individual requests at claim time. The issuer signs the offer document, which specifies the field values for all marks issued under it and the constraints on how many may be claimed and by when. The offer is hosted on a wallet service and distributed as a claim link.

Open offers are only permitted when the policy mark has `allow_open_offers: true`.

---

## Actors

| Actor | Role |
|---|---|
| **Issuer** | The mark holder creating and signing the open offer |
| **Wallet service** | Hosts the signed offer and generates the claim link; handles acceptance submissions |
| **Press** | Named in the offer; validates and issues marks at claim time |
| **Recipients** | Any bearer who follows the claim link and submits a claim |

---

## Preconditions

- The policy mark has `allow_open_offers: true`.
- The press sub-mark pointer named in the offer appears in the policy's `approved_presses`.
- The issuer's mark chain satisfies the policy's `requester_predicate` (if set).
- The issuer has a sub-mark signing key available on their device.
- The wallet service is running and accessible by recipients.

---

## Steps

### Phase 1: Offer Assembly

1. The issuer determines the offer parameters:
   - **Policy:** The policy mark CID (`policy_id`) under which marks will be issued.
   - **Press:** The mutable pointer of the approved press that will issue marks at claim time.
   - **max_acceptances:** Maximum number of claims allowed (null = unconstrained). An offer with both `max_acceptances` and `expires_at` null requires explicit issuer acknowledgment.
   - **expires_at:** Expiry timestamp after which no further claims are accepted (null = unconstrained).
   - **proposed_fields:** All issuer-populated field values for marks issued under this offer. These are the same for every recipient.
   - **display_message:** Optional human-readable context shown to recipients in the wallet UI.
   - **redirect_url:** URL to redirect recipients to after successful issuance (e.g., an onboarding page).

2. The issuer assembles the `OpenMarkOffer` document:
   ```json
   {
     "offer_type":       "open",
     "policy_id":        "<base64url — CID of the governing policy mark>",
     "press_mark":       "<base64url — mutable pointer of the approved press>",
     "issuer_mark":      "<base64url — mutable pointer of the issuer's mark>",
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

3. The issuer validates the offer locally:
   - Confirm all required fields in the policy's `field_definitions` are present in `proposed_fields`.
   - Confirm field values conform to their type and validation constraints (regex, min/max, etc.).
   - Confirm `expires_at` (if set) is in the future.
   - Confirm `redirect_url` is a trusted destination (not a known phishing domain).

### Phase 2: Signing

4. The issuer canonically serializes all fields of the `OpenMarkOffer` document except `issuer_signature` (canonical CBOR per RFC 8949 §4.2 with protocol-specific overrides).

5. The issuer signs the canonical serialization with their sub-mark private key → `issuer_signature`.

6. The **offer ID** is computed as: `hash(canonical CBOR of the complete document including issuer_signature)`. This is the key used in the Arbitrum One on-chain acceptance counter (`openOfferUseCounts`). It is unforgeable and unique per issuer.

### Phase 3: Publishing

7. The issuer submits the signed `OpenMarkOffer` document to a wallet service via HTTPS POST.

8. The wallet service stores the offer and generates a **claim link**:
   - Short form: `mark://claim?o=<base64url of offer>` (suitable for QR codes and deep links).
   - Hosted form: a wallet-service URL that serves the offer JSON on demand (suitable for long offers).

9. The wallet service returns the claim link to the issuer.

### Phase 4: Distribution

10. The issuer distributes the claim link via any channel appropriate to the use case:
    - Private message (targeted distribution; high trust)
    - QR code posted publicly (open distribution; lower trust per-recipient)
    - Email broadcast
    - Embedded in a web page

    **Security note:** The security of the resulting marks is bounded by the channel's trustworthiness. Anyone who obtains the claim link can claim a mark (subject to `max_acceptances` and `expires_at`). Issuers should set appropriate constraints for public distribution.

---

## On-Chain Counter Initialization

The Arbitrum One acceptance counter for this offer (`openOfferUseCounts[offer_id]`) is **lazily initialized** — no pre-registration transaction is required. The counter is created and atomically incremented on the first successful claim. The press includes the `offer_id`, `max_acceptances`, `expires_at`, and `issuer_signature` in calldata alongside each chitt registration so the contract can enforce constraints atomically.

---

## Postconditions

- A signed `OpenMarkOffer` document is stored on the wallet service.
- A claim link is available for distribution.
- The Arbitrum One counter for this offer is not yet initialized (lazy; created on first claim).
- Any recipient who follows the claim link and submits a valid claim will receive a mark, subject to the stated constraints.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Policy mark has `allow_open_offers: false` | The press will reject all claims; the issuer must update the policy to set `allow_open_offers: true` before creating the offer |
| `proposed_fields` missing a required field | Issuer must add the missing field before signing |
| Field value violates policy type or validation constraint | Issuer must correct the value before signing |
| `expires_at` is already in the past | Issuer must set a future expiry or set it to null |
| Both `max_acceptances` and `expires_at` are null | Wallet service requires explicit acknowledgment before publishing; issuer must confirm the unconstrained offer is intentional |
| Press sub-mark pointer not in `approved_presses` | Claims under this offer will be rejected by the press; issuer must use a valid press pointer |

---

## Related Specs

- `open_offer_acceptance_new_wallet.md` — acceptance flow for first-time recipients
- `open_offer_acceptance_existing_wallet.md` — acceptance flow for existing mark holders
- `mark_offering_and_acceptance.md` — the targeted issuance alternative
- `policy_creation.md` — where `allow_open_offers` is set
- `chitt_protocol_spec.md §2` — Open offer issuance flow section
- `protocol-objects.md §6` — `OpenMarkOffer` object reference
- `protocol-objects.md §14` — `RegistryEntry` (open offer counter) object reference
