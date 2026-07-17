# Card Validation from a Signed Statement — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-06-09  
**Status:** Draft  

**Changelog (spec-consistency Phase 2):** Fixes #22, #26, #27, #28, and Decision (a) — added Stage 2 capability/expiry/attestation-level checks (matching `card_verifier.md`'s `CAPABILITY_NOT_GRANTED`/`SUBCARD_EXPIRED`/`ATTESTATION_LEVEL_INSUFFICIENT`), `revocation.status` enum alignment, non-compliance report field alignment, and explicit hard-reject language for `CARD_NOT_FOUND`/`DECRYPTION_FAILED`. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

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
2. Canonically serialize the `payload` object per the same rules used during signing (RFC 8785 JSON Canonicalization Scheme — see `card_protocol_spec.md` Appendix A).
3. Verify the `signature` field against the canonical serialization using the `public_key`. **No network call is required for this stage.**
4. If verification fails, record `signature_valid: false` and proceed to next stages (the chain may still be informative).

### Stage 2: Sub-Card to Master Link

5. Derive the signer's registry address as `keccak256(public_key)` from the `SignatureEntry`, and resolve it on the Arbitrum One registry. **If no `CardEntry` exists for the derived address, this is a hard rejection — record `scope_clean: false` and abort Stage 2** (matching `card_verifier.md §7.2` step 2, error code `CARD_NOT_FOUND`).
6. Derive the leaf card's content key as `HKDF-SHA3-256(public_key, info="card-content-v1")` (where `public_key` is from the `SignatureEntry`) and decrypt the leaf card document fetched from IPFS. The signer's public key is sufficient to decrypt the leaf card. **If AES-GCM authentication fails, this is a hard rejection — record `scope_clean: false` and abort Stage 2** (matching `card_verifier.md §7.2` step 4, error code `DECRYPTION_FAILED`).
   a. **Capability check** (`protocol-objects.md §16` step 1): confirm the message type being verified (`payload.message`) appears in the decrypted `SubCardDocument`'s `capabilities` array. **If it does not, this is a hard rejection — record `scope_clean: false` and abort Stage 2.** This check applies only when validating a `SignedMessageEnvelope`; it does not apply to a bare card-status check with no message to check against.
   b. **Expiry check** (`protocol-objects.md §16` step 2): if `valid_until` is present on the `SubCardDocument`, confirm it has not passed as of now. **If it has, this is a hard rejection — record `scope_clean: false` and abort Stage 2.** Absent `valid_until` means no expiry.
7. Read `holder_primary_card_pubkey` and `app_card_pubkey` from the decrypted `SubCardDocument`. These are untrusted hints; apply the binding checks before use:
   a. Confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address stored in the sub-card document. **If the addresses do not match, this is a hard rejection — record `scope_clean: false` and abort Stage 2.**
   b. Confirm `keccak256(app_card_pubkey)` equals the `app_card` pointer address stored in the sub-card document. **If the addresses do not match, this is a hard rejection — record `scope_clean: false` and abort Stage 2.**
8. Derive the master card's content key as `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")` and decrypt the master card document from IPFS. **If AES-GCM authentication fails, this is a hard rejection — record `scope_clean: false` and abort Stage 2.**
9. Confirm the sub-card appears in the master card's `active_subcards` field (`protocol-objects.md §1.1`): derive `keccak256(entry_pubkey)` for each entry in `active_subcards` and confirm one of them equals the sub-card's own registry address (from step 5). **If the sub-card's address is not present, this is a hard rejection — record `scope_clean: false` and abort Stage 2**, independent of the on-chain `SubCardEntry.active` flag checked in step 11 (a sub-card could in principle be on-chain-active but absent from the directory if the two ever desync; absence from `active_subcards` is treated as a hard rejection regardless of the on-chain flag's value). If `active_subcards` is absent from the master card entirely, treat it as an empty directory — no sub-card can pass this check.

   **Verifiers MUST also confirm, whenever they encounter a code-510/511/512 `LogEntry` on the master card's own log (e.g., when auditing how `active_subcards` reached its current state), that the entry's `intent_signature` was produced by the master card's own holder key.** A 510/511/512 entry signed by any other party (including the card's own issuer) MUST be rejected — this authorization is hardcoded per `protocol-objects.md §1.1` and is not subject to the governing policy's `update_policy`. This is a MUST, not a SHOULD: no relying-party configuration can relax it.
10. Verify the master card holder's ML-DSA-44 signature on the sub-card registration using `holder_primary_card_pubkey`.
11. Confirm the sub-card is currently active in the on-chain registry: look up `SubCardRegistrations[sub_card_address].active`. If `active == false`, record `scope_clean: false`.
11a. **Attestation-level check** (`protocol-objects.md §16` step 11): confirm `attestation_level` is `"T2"`, unless it is `"T1"` and `"T1"` is accepted by the verifier's configuration for the governing policy (default: only `"T2"` is accepted). **If neither condition holds, this is a hard rejection — record `scope_clean: false`.**
12. Verify `app_signature` is valid (using `app_card_pubkey` already in hand from step 7b). The runtime verifier then **independently re-walks the `app_card`'s own certification chain on every verification** — this is not a one-time check performed only at registration: derive the app card's content key as `HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")`, fetch and decrypt the app card document from IPFS, and walk its `ancestry_pubkeys` hop by hop (the same per-hop address-binding, decryption, and signature checks used in the Stage 3 master-card chain walk) until the chain reaches the governance authority's app-certification policy root configured as `VerifierConfig.appCertificationRoot`. **Hard-reject with `APP_CARD_CHAIN_NOT_TRUSTED`** — record `scope_clean: false` and abort Stage 2 — if the chain exhausts without reaching the configured root, or exceeds `maxChainDepth`. The press also performs an equivalent check before submitting `RegisterSubCard` (see `press.md §5.4`), but that registration-time check is an **early gate, not a substitute** for this runtime re-walk: on-chain registration of the sub-card (`sub_card_doc_cid` on the `SubCardEntry`) is not treated as sufficient proof on its own, so a sub-card whose `app_card` traces to an uncertified or wrong root is rejected here even if a press incorrectly (through bug or compromise) already registered it.
13. If any link in Stage 2 cannot be confirmed, record `scope_clean: false`.

### Stage 3: Chain Walk (Historical Validity)

14. Read `ancestry_pubkeys` from the now-decrypted master card (obtained in Stage 2 step 8). This array is set at master card issuance, covered by all three of the master card's signatures, and ordered from immediate parent up toward root. The walk from the master card to the trusted root proceeds entirely via the master card's own `ancestry_pubkeys` — the sub-card's `holder_primary_card_pubkey` field (§16) served to unlock the master card at the sub-card boundary; subsequent ancestor hops use those cards' own `ancestry_pubkeys` fields. Note: the `app_card_pubkey` field in `SubCardDocument` is NOT used in the Stage 3 walk — the app-certification chain is a separate chain, walked independently in Stage 2 step 12 up to `VerifierConfig.appCertificationRoot`, using the app card's own `ancestry_pubkeys` rather than the master card's.
15. Walk the issuer chain from the master card to a trusted root using both `ancestry_pubkeys` (for pubkey/content-key derivation) and the **cached chain array** of version CIDs (for parallel IPFS fetches). **Termination condition:** before processing each iteration, check whether the next on-chain address to resolve is present in the `PolicyAuthorizerKeys` table. If it is, the chain has reached a registered trusted root — stop the loop and proceed to step 16. Equivalently, when the current card's `ancestry_pubkeys` is `[]` (the root base case): check whether the current card's own on-chain address is registered in `PolicyAuthorizerKeys`. If yes, the walk terminates successfully at this card. If `ancestry_pubkeys` is `[]` and the card is **not** in `PolicyAuthorizerKeys`, the chain is exhausted without reaching a trusted root — proceed to step 17. For each non-empty ancestor entry:
    a. Take the next entry from `ancestry_pubkeys` (the ancestor's ML-DSA-44 public key hint).
    b. Derive the expected on-chain address as `keccak256(entry_pubkey)` and confirm it equals the on-chain address being resolved (the mutable pointer from the prior link). **If the address does not match, the array entry is forged or incorrect — reject and abort the chain walk.**
    c. Derive the ancestor's content key as `HKDF-SHA3-256(entry_pubkey, info="card-content-v1")` and decrypt the ancestor card document from IPFS. **If AES-GCM authentication fails, reject and abort.**
    d. Verify the issuer's ML-DSA-44 signature on the decrypted ancestor document using `entry_pubkey`.
    e. Confirm scope attenuation: the sub-card's registered scope does not exceed the master card's scope at time of registration (using `registration_log_head` from the on-chain `SubCardEntry`).
    f. Confirm the chain array entry matches the per-link issuer reference (chain array is a hint; per-link on-chain addresses are authoritative).
16. If the chain reaches a trusted root (a card whose on-chain address is in `PolicyAuthorizerKeys`), record `chain_reaches_trusted_root: true`.
17. If any link fails verification (address mismatch, decryption failure, invalid signature, or scope violation), or if `ancestry_pubkeys` is exhausted (including the `[]` case) and the terminal card's address is **not** in `PolicyAuthorizerKeys`, record `chain_reaches_trusted_root: false`.

### Stage 4: Revocation Check (Current Validity)

18. Resolve all mutable pointers in the chain on Arbitrum One **in parallel**.
19. For each card in the chain, read the append-only log for any 8xx or 9xx entries. Apply revocation semantics:
    - **1xx–7xx entries:** Not revocations; do not affect validity status.
    - **8xx (quiet revocation):** Things before `effective_date` remain trusted; the card is not currently valid.
    - **9xx (loud revocation):** Things on or after `effective_date` are suspect or invalid; things before are trusted. Verifiers should note the 9xx signal may warrant notifying issuers of other cards held by the same holder.
    - If multiple 8xx or 9xx entries exist, the one with the earliest `effective_date` governs.
20. Determine `was_valid_at_signing_time`:
    - Check whether any revocation entry has `effective_date` ≤ the envelope's `payload.timestamp`.
    - If no such entry exists, `was_valid_at_signing_time: true`.
21. Determine `is_currently_valid`:
    - Check whether any revocation entry has `effective_date` ≤ now.
    - If no such entry exists, `is_currently_valid: true`.
22. If revocation data is stale beyond the configured freshness window, flag `revocation.data_freshness_seconds` accordingly and — per default policy — treat as rejection.

### Stage 5: Policy Compliance Check

23. Resolve the card's governing policy using the `policy_id` CID **embedded in the CardDocument** (not the policy's current mutable pointer head). The policy snapshot at issuance governs.
24. **Always** evaluate the card's field values against the `field_definitions` in the policy snapshot. Confirm the issuing/signing press's authorization by consulting the **on-chain `PressAuthorizations` table** (via `GetPressAuthorization` / `IsPressActive` on the registry contract) for the card's `policy_id` address. On-chain `PressAuthorizations` is **authoritative** for press authorization — this is the normative check (see `ARCHITECTURE.md` ADR-011). The IPFS `approved_presses` array from the policy snapshot may be consulted as an advisory cross-check (a point-in-time hint): where the two sources diverge, **on-chain `PressAuthorizations` governs**. This check runs for every verified card regardless of flow type — presses are trusted to issue compliant cards, but that trust is audited here.

    **Authorization-at-write-time is proven by on-chain registration.** The registry contract's write gate (`registry_contract.md §6.1`) rejects any `RegisterCard`, `UpdateCardHead`, or `ClaimOpenOffer` call whose press is not `active` in `PressAuthorizations` at write time. The card's existence in `CardEntries` (and each log-head update recorded there) is therefore proof that the writing press was authorized when it wrote. The verifier does not need to — and cannot, from stored `PressAuthEntry` state — reconstruct a historical authorization window.

    **Current revocation is contextual, not retroactively invalidating.** The verifier MAY read the current `PressAuthorizations` entry (`GetPressAuthorization`) to determine whether the press has since been revoked (`active = false`, `revoked_at` set). Consistent with revocation semantics (see `card_updates.md §Revocation Semantics`), a press that is currently revoked does **not** retroactively invalidate cards it correctly registered while it was active — those cards remain valid. The verifier MAY surface "issuing press subsequently revoked" as informational context, but MUST NOT treat it as cause to set `policy_compliant: false` for a card that was properly on-chain registered.

    - If any field value violates a `field_definitions` constraint, record `policy_compliant: false`.
    - If the on-chain `PressAuthorizations` table has **no entry** for this `(policy_id, press_address)` pair, record `policy_compliant: false`. (No entry means the press was never authorized; the card could not have been validly registered.)
    - If both pass, record `policy_compliant: true`. A currently-revoked press (`active = false` with an entry present) does not itself cause `policy_compliant: false` — on-chain registration is the proof of write-time authorization.
25. **Non-compliance reporting:** If `policy_compliant: false`, the verifier MUST submit a non-compliance report to the **Press Registry Body** (the governance body that authorizes and revokes presses — see `ARCHITECTURE.md` ADR-011). A press is required to verify content before posting it, so non-compliant content on-chain means the responsible press failed that duty and should be held accountable (up to `RevokePress`). The report MUST include:
    - The full `SignedMessageEnvelope` (as evidence of the issued card).
    - The `policy_id` CID used for evaluation.
    - The specific field(s) or press authorization check that failed.
    - The `press_signature` / press card identifying the responsible press.
    - The verifier's own card mutable pointer (so the body can authenticate the report source).
26. If the verifier additionally requires a specific `required_predicate` or `required_policy` (e.g., in an authentication flow), evaluate those predicates against the signer's chain. Predicate failure is a separate `policy_match` result and does not affect `policy_compliant` (a card can be policy-compliant but not match a relying party's specific predicate requirements).

### Stage 5a: Policy Creation Compliance (For Policy-Level Verification)

27. When verifying a policy card itself (rather than an ordinary issued card):
    - Walk the policy creation chain — alternating between the policy card's holder card and that card's own policy — collecting all `policy_creation` field restrictions. At each step, use the `policy_id` CID from the card under evaluation to fetch the policy snapshot in effect at issuance. Use `ancestry_pubkeys` from each policy card to decrypt ancestor cards and verify issuer signatures, applying the same binding check (`keccak256(entry_pubkey)` must equal the on-chain address being resolved).
    - Confirm the policy's `field_definitions` satisfy every collected restriction.
    - If any restriction is violated, flag as non-compliant. Cards issued under a non-compliant policy inherit this flag.

### Stage 6: Annotation Lookup (Optional)

28. Query EAS (Ethereum Attestation Service) on Arbitrum One for third-party annotations on cards in the chain.
29. Filter annotations by whether the annotation signer's chain validates to a trusted root. To walk an annotator's chain, read `ancestry_pubkeys` from the annotator's decrypted card and apply the same binding check and content-key derivation as in Stage 3.
30. Assemble annotation context for inclusion in the result.

### Stage 7: Recipient-Set Check

31. Confirm the verifier's card mutable pointer appears in the `payload.recipients` array.
32. If absent, flag as `addressed_to_verifier: false` (the message is valid but was forwarded to this party rather than addressed directly).

### Stage 8: Replay and Freshness Check

33. Compute the message ID: `SHA3-256(canonical RFC 8785 JSON of payload)`.
34. Confirm the `payload.timestamp` is within the verifier's acceptable freshness window.
35. Confirm this message ID has not been seen before (replay prevention). If the ID has been seen, flag as replay.

---

## Structured Result (Per Signature)

```json
{
  "signer_card":              "<mutable pointer>",
  "signature_valid":          true | false,
  "chain_reaches_trusted_root": true | false,
  "scope_clean":              true | false,
  "revocation": {
    "status":                 "not_revoked" | "revoked" | "loud_revocation" | "unknown",
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

`policy_compliant` is `null` if the policy snapshot could not be fetched (see Error Paths). `policy_match` is `null` when no relying-party predicate was specified. `non_compliance_reported` is `true` if a report was submitted to the Press Registry Body, `false` if submission failed, and `null` if no non-compliance was detected.

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
- The verifier has not contacted the signer or any intermediary other than the Press Registry Body (in the event of non-compliance).
- If any card was found `policy_compliant: false`, a non-compliance report has been submitted to the Press Registry Body.
- The verifier retains the result for application-layer decision-making. Validation returns facts; the application acts on them.

---

## Error Paths

| Condition | Resolution |
|---|---|
| IPFS fetch for a chain link times out | Retry; if persistent, flag chain as unverifiable and record in result |
| Arbitrum RPC unavailable (revocation data) | Flag `data_freshness_seconds` as exceeding the freshness window; per default policy, treat as rejection |
| `holder_primary_card_pubkey` binding check fails (`keccak256(holder_primary_card_pubkey)` ≠ `holder_primary_card` address) | Hard rejection — record `scope_clean: false` and abort Stage 2. The hint is forged or incorrect. |
| AES-GCM authentication failure when decrypting master card using `holder_primary_card_pubkey` | Hard rejection — record `scope_clean: false` and abort Stage 2. The key does not match the master card ciphertext. |
| `app_card_pubkey` binding check fails (`keccak256(app_card_pubkey)` ≠ `app_card` address) | Hard rejection — record `scope_clean: false` and abort Stage 2. The hint is forged or incorrect. (Note: after this binding check passes, the runtime verifier also uses `app_card_pubkey` at step 12 to decrypt the app card and re-walk its certification chain — see the `APP_CARD_CHAIN_NOT_TRUSTED` row below.) |
| `app_signature` verification fails (using `app_card_pubkey`) | Hard rejection — record `scope_clean: false` and abort Stage 2. |
| `app_card` certification chain does not reach `VerifierConfig.appCertificationRoot` (chain exhausted or exceeds `maxChainDepth`) | Hard rejection — record `scope_clean: false` and abort Stage 2 with error code `APP_CARD_CHAIN_NOT_TRUSTED`. Applies regardless of whether the press already accepted this `app_card` at `RegisterSubCard` time. |
| Sub-card found inactive in on-chain registry (`active == false`) | Record `scope_clean: false`. The sub-card has been deregistered. |
| Sub-card's address absent from master card's `active_subcards` | Hard rejection — record `scope_clean: false` and abort Stage 2, independent of the on-chain `active` flag. |
| A 510/511/512 log entry on the master card's log is not signed by the master card's own holder key | Hard rejection of that log entry — MUST reject regardless of the governing policy's `update_policy`. |
| `ancestry_pubkeys` entry address mismatch (`keccak256(entry_pubkey)` ≠ on-chain address) | Hard rejection — abort chain walk and record `chain_reaches_trusted_root: false`. The array entry is forged or incorrect. |
| `ancestry_pubkeys` entry yields AES-GCM decryption failure on ancestor ciphertext | Hard rejection — abort chain walk and record `chain_reaches_trusted_root: false`. The key does not match the ancestor card. |
| `ancestry_pubkeys` is `[]` and the card's own address is **not** in `PolicyAuthorizerKeys` | Record `chain_reaches_trusted_root: false`. The chain is exhausted without reaching a trusted root; the `[]` value is valid but the terminal card is not a registered trusted root. |
| Cached chain array version CIDs differ from current link state | Per-link on-chain addresses are authoritative; use those and flag the discrepancy |
| Policy snapshot at `policy_id` CID unavailable on IPFS | Policy compliance check cannot complete; set `policy_compliant: null` and treat as policy match failure. Non-compliance reporting is skipped (cannot determine authority). |
| Non-compliance report submission to the Press Registry Body fails | Set `non_compliance_reported: false` in result; verifier SHOULD retry. The card's `policy_compliant: false` status stands regardless. |
| Message ID seen before (replay) | Flag as replay; reject for authentication flows |

---

## npm API Reference

The concrete npm package API (function names and signatures) is out of scope for this process spec and will be defined in a dedicated npm-package specification. This document specifies the *verification procedure* (the stages above); the package surface that implements it is deferred.

---

## Related Specs

- `card_signing.md` — how the envelope being validated was produced
- `card_protocol_spec.md §7` — full feature spec for validating a signed statement
- `card_protocol_spec.md §8` — authentication flow (uses this validation process)
- `protocol-objects.md §5` — `SignedMessageEnvelope` object reference
- `protocol-objects.md §8` — `AuthenticationRequest` object reference
- `protocol-objects.md §9` — `AuthenticationResponse` object reference
