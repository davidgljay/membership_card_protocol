# Policy Creation — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

Policy creation is the process by which an authorizer defines and publishes the rules governing a class of cards. A policy is itself a card — it is issued by the authorizer to an administrator (who may be the same person), stored on IPFS, and registered on Arbitrum One. Once live, the policy constrains what presses may issue, who may receive cards, what fields those cards may contain, and how they may be updated or revoked.

---

## Actors

| Actor | Role |
|---|---|
| **Drafter** | Assembles the policy JSON (often the administrator) |
| **Authorizer** | Reviews and signs the policy card; establishes the root of trust |
| **Administrator** | Holds the policy card; manages auditors and approved presses |
| **Press** | Performs a pre-flight compliance check before operating under the policy |

---

## Preconditions

- The authorizer holds a card (or is a trusted root) whose key will be used to sign the policy.
- The drafter has identified the desired field schema, predicates, auditors, and press(es).
- At least one press sub-card key is available to be added to `approved_presses`.

---

## Steps

### Phase 1: Draft

1. The drafter assembles the policy JSON object (`PolicyCardDocument`), populating:
   - `field_definitions` — the field schema for cards issued under this policy (required)
   - `recipient_predicate` — who may receive cards (optional; absent = unconstrained)
   - `requester_predicate` — who may request cards (optional; absent = unconstrained)
   - `auditors` — array of card pointers for parties that receive encrypted audit access (optional)
   - `approved_presses` — array of press sub-card pointers authorized to issue (optional at draft time; must be populated before the policy is live)
   - `valid_until` — expiry timestamp (optional)
   - `allow_open_offers` — set `true` to permit open-offer issuance under this policy (default `false`)
   - `revocation_permissions` — who may post 8xx and 9xx entries (optional; defaults apply if absent)
   - `policy_creation` — constraints on policies that holders of this policy's cards may create (optional)

2. The drafter validates the policy JSON against the protocol schema (CLI tool recommended). Confirm:
   - `field_definitions` is present and non-empty.
   - All `update_policy` predicates use valid predicate syntax.
   - No field name collides with protocol-required fields (`policy_id`, `issuer_card`, `press_card`, `recipient_pubkey`, `issued_at`, `issuer_signature`, `holder_signature`, `press_signature`).

3. The drafter delivers the proposed policy JSON to the authorizer out of band (e.g., via email, secure file transfer, or in-person review).

### Phase 2: Authorize

4. The authorizer reviews the policy JSON. Specifically:
   - Verify `field_definitions` matches the intended schema.
   - Verify predicates correctly express the intended issuance constraints.
   - Verify `revocation_permissions` grants the right parties revocation authority.
   - Verify `policy_creation` constraints (if present) are correctly scoped.

5. If the authorizer approves, they issue the policy card to the administrator using the standard targeted issuance flow (see `card_offering_and_acceptance.md`). The policy JSON is the card's IPFS content.

   The policy card's `policy_id` field points to the **meta-policy** that governs what policy cards the authorizer is permitted to create. If the authorizer is a trusted root, this is a self-referential or well-known root CID.

6. The administrator countersigns the policy card, completing it.

### Phase 3: Publish

7. The completed policy card is posted to IPFS. Pin to at least the minimum required replication count before proceeding.

8. A new Arbitrum One registry entry is created for the policy card, with the genesis card CID as the initial log head. This write is signed by the press sub-card key acting on behalf of the authorizer (or directly by the authorizer if self-issuing).

9. The CID of the published policy card is shared with any presses that will operate under it, and with downstream parties who will need to verify cards issued under this policy.

### Phase 4: Press Registration

10. Each press performs a **policy pre-flight check** before accepting issuance requests:
    1. Resolve the policy card's holder (the administrator) and their card.
    2. Walk the policy creation chain: administrator's card → its policy → that policy's holder → their card → ... collecting all `policy_creation` field restrictions at each step.
    3. Confirm that the new policy's `field_definitions` satisfy all collected restrictions (required fields present, prohibited fields absent, text regex at least as restrictive as inherited constraint).
    4. If any restriction is violated, the press refuses to register and reports the violation to the administrator. The administrator must amend the policy (requires a new issuance or an authorized field update) before the press will proceed.

11. The administrator issues a **press sub-card** — a sub-card of the policy card — to each press operator. The press operator countersigns.

12. Each press sub-card's mutable pointer is added to `approved_presses` via an authorized field update to the policy card (see `card_updates.md`).

13. The policy is live. The press begins accepting issuance requests.

---

## Postconditions

- The policy card is pinned on IPFS and registered on Arbitrum One.
- At least one press sub-card pointer appears in `approved_presses`.
- Any verifier can fetch the policy card by CID, confirm the authorizer's signature, and walk the chain to a trusted root without contacting the authorizer.

---

## Error Paths

| Condition | Resolution |
|---|---|
| `field_definitions` is absent or empty | Press refuses to load policy; drafter must add valid field definitions |
| `valid_until` has already passed | Press refuses to load policy; administrator must update `valid_until` or reissue |
| Policy `field_definitions` violate an ancestor `policy_creation` constraint | Press refuses to register; drafter must amend the field schema to satisfy the constraint |
| Press sub-card pointer not yet in `approved_presses` | Press cannot write to the Arbitrum One registry; administrator must add the pointer via a field update |
| IPFS replication count below minimum before on-chain write | Defer registry write until replication threshold is met |

---

## Related Specs

- `card_offering_and_acceptance.md` — the issuance flow used to issue the policy card itself
- `card_updates.md` — used to add/remove auditors, presses, and update policy fields after publication
- `log_auditing.md` — audit epoch lifecycle for cards issued under this policy
- `card_protocol_spec.md §1` — full feature spec for policy creation
- `protocol-objects.md §2` — `PolicyCardDocument` object reference
