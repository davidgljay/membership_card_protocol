# Card Validation from a Signed Statement — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-06-09  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

Card validation is the process by which a recipient or service verifies a `SignedMessageEnvelope` produced by the card signing process. Validation answers four questions per signature: Is the signature cryptographically valid? Was the signing card valid at the time of signing? Is the signing card currently valid? Does the signed statement meet the relying party's policy requirements?

The process is fully independent — any party with access to IPFS and the Arbitrum One registry can perform it without contacting the signer, press, or any intermediary.

---

## Actors

| Actor | Role |
|---|---|
| **Verifier** | The recipient or service evaluating the signed statement |
| **Signer** | The card holder who produced the envelope (passive — no action required during verification) |

---

## Preconditions

- The verifier holds the `SignedMessageEnvelope` to be verified.
- The verifier has connectivity to IPFS (for chain and policy document fetches) and the Arbitrum One RPC (for current registry state and revocation data).
- The verifier has a configured list of trusted roots.

---

## Stages

Verification is executed per `SignatureEntry` in the envelope's `signatures` array. All stages should be run; the structured result is assembled from the outcomes of all stages.

### Stage 1: Signature Validity

1. Extract the `public_key` from the `SignatureEntry`.
2. Canonically serialize the `payload` object per the same rules used during signing (canonical CBOR, RFC 8949 §4.2 with protocol-specific overrides).
3. Verify the `signature` field against the canonical serialization using the `public_key`. **No network call is required for this stage.**
4. If verification fails, record `signature_valid: false` and proceed to next stages (the chain may still be informative).

### Stage 2: Sub-Card to Master Link

5. Resolve the `signer_card` pointer from the `SignatureEntry` using the Arbitrum One registry.
6. Fetch the sub-card's registration: confirm the sub-card appears in the active sub-card list of its claimed master card's current metadata.
7. Verify the master card's ML-DSA-44 signature on the sub-card registration.
8. If the link cannot be confirmed, record `scope_clean: false`.

### Stage 3: Chain Walk (Historical Validity)

9. Fetch the master card document from IPFS using the CID registered on Arbitrum One.
10. Walk the issuer chain to a trusted root using the **cached chain array** in the card's signed metadata (enables parallel IPFS fetches). For each link:
    - Verify the issuer's ML-DSA-44 signature.
    - Confirm scope attenuation: the sub-card's registered scope does not exceed the master card's scope at time of registration (using `registrationLogHeadCid` from the `SubCardRegistration`).
    - Confirm the chain array entry matches the per-link issuer reference (array is a hint; per-link references are authoritative).
11. If the chain reaches a trusted root, record `chain_reaches_trusted_root: true`.
12. If any link fails verification or the chain terminates without reaching a trusted root, record `chain_reaches_trusted_root: false`.

### Stage 4: Revocation Check (Current Validity)

13. Resolve all mutable pointers in the chain on Arbitrum One **in parallel**.
14. For each card in the chain, read the append-only log for any 8xx or 9xx entries. Apply revocation semantics:
    - **1xx–7xx entries:** Not revocations; do not affect validity status.
    - **8xx (quiet revocation):** Things before `effective_date` remain trusted; the card is not currently valid.
    - **9xx (loud revocation):** Things on or after `effective_date` are suspect or invalid; things before are trusted. Verifiers should note the 9xx signal may warrant notifying issuers of other cards held by the same holder.
    - If multiple 8xx or 9xx entries exist, the one with the earliest `effective_date` governs.
15. Determine `was_valid_at_signing_time`:
    - Check whether any revocation entry has `effective_date` ≤ the envelope's `payload.timestamp`.
    - If no such entry exists, `was_valid_at_signing_time: true`.
16. Determine `is_currently_valid`:
    - Check whether any revocation entry has `effective_date` ≤ now.
    - If no such entry exists, `is_currently_valid: true`.
17. If revocation data is stale beyond the configured freshness window, flag `revocation.data_freshness_seconds` accordingly and — per default policy — treat as rejection.

### Stage 5: Policy Compliance Check

18. Resolve the card's governing policy using the `policy_id` CID **embedded in the CardDocument** (not the policy's current mutable pointer head). The policy snapshot at issuance governs.
19. **Always** evaluate the card's field values against the `field_definitions` in the policy snapshot. Confirm the signing press sub-card appears in the `approved_presses` array from the same `policy_id` snapshot. This check runs for every verified card regardless of flow type — presses are trusted to issue compliant cards, but that trust is audited here.
    - If any field value violates a `field_definitions` constraint, record `policy_compliant: false`.
    - If the signing press is not in `approved_presses`, record `policy_compliant: false`.
    - If both pass, record `policy_compliant: true`.
20. **Non-compliance reporting:** If `policy_compliant: false`, the verifier MUST submit a non-compliance report to the press certification authority identified in the policy snapshot's `certification_authority` field. The report MUST include:
    - The full `SignedMessageEnvelope` (as evidence of the issued card).
    - The `policy_id` CID used for evaluation.
    - The specific field(s) or press approval check that failed.
    - The verifier's own card mutable pointer (so the authority can authenticate the report source).
21. If the verifier additionally requires a specific `required_predicate` or `required_policy` (e.g., in an authentication flow), evaluate those predicates against the signer's chain. Predicate failure is a separate `policy_match` result and does not affect `policy_compliant` (a card can be policy-compliant but not match a relying party's specific predicate requirements).

### Stage 5a: Policy Creation Compliance (For Policy-Level Verification)

20. When verifying a policy card itself (rather than an ordinary issued card):
    - Walk the policy creation chain — alternating between the policy card's holder card and that card's own policy — collecting all `policy_creation` field restrictions. At each step, use the `policy_id` CID from the card under evaluation to fetch the policy snapshot in effect at issuance.
    - Confirm the policy's `field_definitions` satisfy every collected restriction.
    - If any restriction is violated, flag as non-compliant. Cards issued under a non-compliant policy inherit this flag.

### Stage 6: Annotation Lookup (Optional)

21. Query EAS (Ethereum Attestation Service) on Arbitrum One for third-party annotations on cards in the chain.
22. Filter annotations by whether the annotation signer's chain validates to a trusted root.
23. Assemble annotation context for inclusion in the result.

### Stage 7: Recipient-Set Check

24. Confirm the verifier's card mutable pointer appears in the `payload.recipients` array.
25. If absent, flag as `addressed_to_verifier: false` (the message is valid but was forwarded to this party rather than addressed directly).

### Stage 8: Replay and Freshness Check

26. Compute the message ID: `SHA3-256(canonical CBOR of payload)`.
27. Confirm the `payload.timestamp` is within the verifier's acceptable freshness window.
28. Confirm this message ID has not been seen before (replay prevention). If the ID has been seen, flag as replay.

---

## Structured Result (Per Signature)

```json
{
  "signer_card":              "<mutable pointer>",
  "signature_valid":          true | false,
  "chain_reaches_trusted_root": true | false,
  "scope_clean":              true | false,
  "revocation": {
    "status":                 "none" | "revoked",
    "code":                   <integer | null>,
    "effective_date":         "<ISO 8601 | null>",
    "data_freshness_seconds": <integer>
  },
  "was_valid_at_signing_time": true | false,
  "is_currently_valid":        true | false,
  "policy_compliant":          true | false | null,
  "policy_match":              true | false | null,
  "non_compliance_reported":   true | false | null,
  "addressed_to_verifier":     true | false,
  "annotations":               [ ... ]
}
```

`policy_compliant` is `null` if the policy snapshot could not be fetched (see Error Paths). `policy_match` is `null` when no relying-party predicate was specified. `non_compliance_reported` is `true` if a report was submitted to the press certification authority, `false` if submission failed, and `null` if no non-compliance was detected.

---

## Common Result Interpretations

| Scenario | `was_valid_at_signing_time` | `is_currently_valid` |
|---|---|---|
| Card has no revocation entries | true | true |
| 8xx revocation, `effective_date` after signing timestamp | true | false |
| 8xx revocation, `effective_date` before signing timestamp | false | false |
| 9xx revocation, `effective_date` after signing timestamp | true | false |
| 9xx revocation, `effective_date` before signing timestamp | false | false |
| 1xx–7xx entry only (no revocation) | true | true |

---

## Postconditions

- A structured result is produced per signature in the envelope.
- The verifier has not contacted the signer or any intermediary other than the press certification authority (in the event of non-compliance).
- If any card was found `policy_compliant: false`, a non-compliance report has been submitted to the press certification authority identified in that card's policy snapshot.
- The verifier retains the result for application-layer decision-making. Validation returns facts; the application acts on them.

---

## Error Paths

| Condition | Resolution |
|---|---|
| IPFS fetch for a chain link times out | Retry; if persistent, flag chain as unverifiable and record in result |
| Arbitrum RPC unavailable (revocation data) | Flag `data_freshness_seconds` as exceeding the freshness window; per default policy, treat as rejection |
| Cached chain array version CIDs differ from current link state | Per-link issuer references are authoritative; use those and flag the discrepancy |
| Policy snapshot at `policy_id` CID unavailable on IPFS | Policy compliance check cannot complete; set `policy_compliant: null` and treat as policy match failure. Non-compliance reporting is skipped (cannot determine authority). |
| Non-compliance report submission to certification authority fails | Set `non_compliance_reported: false` in result; verifier SHOULD retry. The card's `policy_compliant: false` status stands regardless. |
| Message ID seen before (replay) | Flag as replay; reject for authentication flows |

---

## npm API Reference

```javascript
// Message verification
CardAuth.verifyEnvelope(signedEnvelope, trustedRoots, freshnessPolicy)
  // → Array<SignatureVerificationResult> (one per signatures entry)

// Authentication request lifecycle
CardAuth.createRequest({ requesterMark, policyCid, purpose, callback, sessionId })
CardAuth.verifyResponse(request, response, policy)
  // → SignatureVerificationResult

// Keyring integration
CardAuth.parseRequest(deepLinkOrQrPayload)
CardAuth.findMatchingMarks(request, localKeyring)
CardAuth.signResponse(request, chosenMark, subMarkKey)
CardAuth.deliverResponse(request, signedResponse)
```

---

## Related Specs

- `card_signing.md` — how the envelope being validated was produced
- `card_protocol_spec.md §7` — full feature spec for validating a signed statement
- `card_protocol_spec.md §8` — authentication flow (uses this validation process)
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
- `protocol-objects.md §8` — `AuthenticationRequest` object reference
- `protocol-objects.md §9` — `AuthenticationResponse` object reference
