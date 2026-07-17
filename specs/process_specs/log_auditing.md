# Log Auditing — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

**Amended 2026-07-16 (spec-consistency Phase 2, Fix #11):** full rewrite. The audit-epoch / Audit Encryption Key (AEK) / ML-KEM key-wrapping model this document previously described has been **removed** from the protocol (`press.md §5.6`, `protocol-objects.md §12–13`) and replaced by direct E2E-encrypted `PressIssuanceRecord` messaging to each address in `policy.auditors` (`press.md §5.5` `appendIssuanceRecord`, `protocol-objects.md §11`). This document now describes that direct-messaging model: how an auditor receives a `PressIssuanceRecord`, confirms receipt, locally records it, and later inspects the referenced issued card for policy compliance. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md` Fix #11.

---

## Overview

Every targeted or open-offer card issuance under a policy is reported directly to the policy's auditors. Immediately after a press assembles and signs the completed `CardDocument`, it sends a `PressIssuanceRecord` — an E2E-encrypted message, not an IPFS-posted artifact — to each card address listed in the policy's `auditors` array. There is no epoch structure, no shared symmetric key, and no key-wrapping step: each auditor receives their own independently-encrypted copy of each record via the normal message routing layer, encrypted directly to that auditor card's public key.

Auditors maintain their own local records of the issuance notifications they receive. There is no press-side audit log artifact posted to IPFS under this model — auditing is a point-to-point notification relationship between the press and each auditor, not a shared encrypted ledger.

This spec covers two processes: the press delivering a `PressIssuanceRecord` and the auditor confirming receipt (Process 1), and the auditor's later inspection of an issued card for policy compliance (Process 2).

---

## Actors

| Actor | Role |
|---|---|
| **Press** | Assembles and delivers a `PressIssuanceRecord` to each active auditor immediately after signing a completed `CardDocument`; tracks per-auditor confirmation state locally |
| **Auditor** | Holds a card whose pointer appears in the policy's `auditors` array; receives each `PressIssuanceRecord` via E2E-encrypted message, confirms receipt back to the press, records it locally, and inspects the referenced issued card for policy compliance |
| **Administrator** | Manages auditor membership in the policy's `auditors` field; is alerted if an auditor fails to confirm receipt within the press's timeout |

---

## Preconditions

- A valid policy card is live with zero or more entries in its `auditors` array. If `auditors` is empty or absent, no auditor notifications are sent for issuances under this policy.
- Each auditor holds an active card whose public key is resolvable from their card (used both for message routing and for the press to encrypt to).

---

## Process 1: Issuance Notification, Delivery, and Confirmation

This process runs once per card issuance under a policy with a non-empty `auditors` array — for both targeted issuance (`card_offering_and_acceptance.md` steps 20–22) and open-offer issuance (`open_offer_creation.md`/`open_offer_acceptance_*.md`).

### Steps

**Press side:**

1. Immediately after assembling, signing, and publishing the completed `CardDocument` (and producing its SCIP), the press resolves `policy.auditors` from the policy card. If the array is empty or absent, the press skips the remaining steps — there is nothing to notify.

2. For each active auditor card address in `policy.auditors`, the press assembles a `PressIssuanceRecord` plaintext:
   ```json
   {
     "card_cid":         "<base64url — CID of the issued CardDocument>",
     "recipient_pubkey": "<base64url — ML-DSA-44 public key of the issued CardDocument, 1312 bytes raw>",
     "scip_cid":         "<base64url — CID of the SCIP posted to IPFS>",
     "issued_at":        "<ISO 8601 timestamp>",
     "offer_type":       "targeted | open"
   }
   ```
   The press already holds every one of these values at this point — no additional lookups are required (`protocol-objects.md §11`).

3. The press sends the `PressIssuanceRecord` to each auditor as an E2E-encrypted message via the normal message routing layer (HTTPS to the auditor's wallet service endpoint, encrypted to that auditor card's public key). Each auditor receives their own independently-encrypted copy — there is no shared symmetric key and no key-wrapping step.

4. The press awaits a confirmation message from each auditor acknowledging receipt and local recording, applying a configurable timeout (default: 30 seconds per auditor).

5. If an auditor confirms within the timeout, the press records the confirmation locally (KV store or equivalent — not on IPFS).

6. If an auditor does not confirm within the timeout, the press logs a warning and alerts the policy administrator, but does not block or retry the issuance — an unresponsive auditor never blocks card issuance. The press records the timeout locally alongside which auditors did confirm.

**Auditor side:**

7. The auditor's wallet service receives the E2E-encrypted `PressIssuanceRecord` message and decrypts it using the auditor card's private key.

8. The auditor locally records the decrypted `PressIssuanceRecord` (e.g., appended to a local database or log keyed by policy and `card_cid`). This local record is the auditor's own durable copy — there is no shared, press-hosted, or IPFS-hosted audit log the auditor depends on.

9. The auditor sends a confirmation message back to the press acknowledging receipt and recording.

---

## Process 2: Inspecting an Issued Card for Compliance

An auditor may inspect any `PressIssuanceRecord` they have recorded — immediately upon receipt, or at any later time — to verify the referenced card complies with the policy. This is the same card-inspection logic the prior epoch-based model used at epoch close; under the direct-messaging model it runs per-record, whenever the auditor chooses to review it, with no epoch boundary gating access.

### Steps

1. Derive the issued card's content key: `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, using the `recipient_pubkey` field from the `PressIssuanceRecord`.

2. Fetch the issued `CardDocument` at `card_cid` from IPFS and decrypt it using `content_key`. An AES-GCM authentication failure is a hard rejection — flag the record in the auditor's findings and do not treat it as a valid issuance.

3. **Binding and consistency check.** Confirm `keccak256(recipient_pubkey)` equals the card's on-chain registry address (the card's mutable pointer). A mismatch indicates a malformed or forged record and MUST be flagged (`protocol-objects.md §11`, "Binding and consistency check").

4. Inspect the decrypted card's field values against the policy's `field_definitions`, `recipient_predicate`, and `requester_predicate` (from the policy snapshot at `policy_id` CID) to verify predicate compliance.

5. If further chain verification is needed, the decrypted card's `ancestry_pubkeys` array provides the ordered ancestor public keys for walking the issuer and press chains to a trusted root — the same binding check applies at each link (`keccak256(entry_pubkey)` must equal the on-chain address being resolved).

6. Verify that no unauthorized press wrote to the card (the `press_card` pointer resolves to a press listed in the policy's `approved_presses` at the time of issuance).

7. The auditor records any findings (anomalies, non-compliance, or "no issues found") in their local records alongside the stored `PressIssuanceRecord`. There is no protocol-defined signed commitment object for this inspection — findings remain local to the auditor unless the auditor's own operational practice requires publishing them elsewhere.

---

## Postconditions

- Every active auditor listed in `policy.auditors` at issuance time has received (or, for a timed-out auditor, has been attempted delivery of) a `PressIssuanceRecord` for the issuance, encrypted to their own card's public key.
- Each confirming auditor holds a local record of the `PressIssuanceRecord`, independent of any press-hosted or IPFS-hosted artifact.
- An auditor who inspects a `PressIssuanceRecord`'s referenced card can independently confirm content decryption, the `keccak256(recipient_pubkey)` binding, and predicate compliance, using only publicly resolvable IPFS and on-chain data plus their own card's private key.
- Auditor access to a `PressIssuanceRecord` is not time-bounded or epoch-scoped — an auditor may inspect any record they have received and recorded at any later time, so long as they retain their own local copy (there is no protocol mechanism for re-fetching a `PressIssuanceRecord` from the press after initial delivery).

## Acceptance Criteria

- [ ] An auditor listed in `policy.auditors` receives a `PressIssuanceRecord` via E2E-encrypted message for every card issued under the policy while they are an active auditor.
- [ ] The auditor can decrypt the message using only their own card's private key — no shared or wrapped key material is involved.
- [ ] The auditor can derive `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")` from the record, fetch the issued card at `card_cid`, and successfully decrypt it (AES-GCM tag must pass).
- [ ] The auditor can inspect the issued card's field values and verify they satisfy the policy's `field_definitions`, `recipient_predicate`, and `requester_predicate`.
- [ ] A `PressIssuanceRecord` whose `keccak256(recipient_pubkey)` does not match the card's on-chain registry address, or whose issued card fails AES-GCM decryption, is flagged in the auditor's local findings and not counted as a valid issuance.
- [ ] The press does not block or retry issuance when an auditor fails to confirm receipt within the timeout; the administrator is alerted instead.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Auditor's wallet service unreachable or message delivery fails | Press logs a warning, alerts the administrator, and continues — issuance is never blocked by auditor delivery failure |
| Auditor does not send a confirmation within the timeout (default 30s) | Press records the timeout locally and alerts the administrator; the press does not retry indefinitely, and issuance proceeds regardless |
| Auditor cannot decrypt the received message (corrupted transport payload, stale keyring state) | Auditor requests redelivery from the press out of band; the press has no protocol-defined re-send mechanism beyond the original delivery attempt, so this is an operational/administrator-mediated recovery |
| Auditor finds `keccak256(recipient_pubkey)` mismatch or issued-card decryption failure during inspection | Auditor flags the record in local findings; notifies the administrator per the auditor's own operational practice |
| Auditor removed from `policy.auditors` | The press stops sending them future `PressIssuanceRecord`s (resolved from the updated policy snapshot on the next issuance); no retroactive access change to records already delivered to them |

---

## Related Specs

- `card_offering_and_acceptance.md` — where issuance records are generated and delivered (steps 20–22)
- `open_offer_creation.md` / `open_offer_acceptance_new_wallet.md` / `open_offer_acceptance_existing_wallet.md` — open-offer issuance paths that also trigger auditor notification
- `policy_creation.md` — where auditors are defined in the policy
- `card_updates.md` — used to add/remove auditors from the policy's `auditors` array
- `press.md §5.5` — `appendIssuanceRecord`, the press-side implementation of Process 1
- `protocol-objects.md §11` — `PressIssuanceRecord` object reference
