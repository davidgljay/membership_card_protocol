# Strategic Plan: Verifier-Side app_card Chain Walk

**Date:** 2026-06-28  
**Status:** Approved — open questions resolved 2026-06-28

---

## Goals

### 1. Close the compromised-press attack vector on sub-card verification

A compromised press can currently register sub-cards with uncertified `app_card`s because the contract does not verify the `app_card` chain on-chain, and runtime verifiers explicitly trust that the press completed this check at registration time. A message signed by such a sub-card passes all current verifier stages. This goal eliminates that gap.

### 2. Make verifiers cryptographically self-sufficient on app_card certification

The verifier package (`@membership-card-protocol/verifier`) should be able to confirm — independently of any press — that the wallet app holding a sub-card is authorized by the governance authority. Relying on the press creates a single point of trust that contradicts the protocol's broader posture of independent verifiability.

### 3. Align the spec with the new verification requirement

Two spec documents currently describe the `app_card` chain check as press-side only. The press spec should be updated to reflect that the press's check is no longer the sole line of defense but remains a useful early gate; the press is no longer solely accountable for catching uncertified apps. A new result field surfaces the check outcome to verifier consumers.

---

## Rationale

### Goal 1
The attack was identified during threat modeling: an attacker with both a fake wallet service and a compromised press can register sub-cards whose `app_card` does not chain to the governance authority's app-certification policy root. Because `protocol-objects.md §16` explicitly says "runtime verifiers do NOT independently walk the `app_card` chain," those sub-cards produce signatures that pass all eight verifier stages. The attacker gains the ability to send messages or authenticate as a card holder within whatever policy the compromised press manages. The press being the sole gatekeeper is a structural single point of failure.

### Goal 2
The verifier's design philosophy throughout the rest of the spec is to independently re-derive trust from cryptographic evidence — it re-walks the holder's full card chain, re-checks revocation, re-validates policy compliance. Delegating `app_card` certification to the press is an inconsistency. The `app_card_pubkey` and `app_card` pointer are already in the `SubCardDocument`, covered by both `app_signature` and `holder_signature`, and the content key derivation pattern (HKDF-SHA3-256) is already implemented in `crypto.ts`. The chain walk infrastructure in Stage 3 is directly reusable. The cost of adding the walk is low; the benefit is eliminating a class of press-compromise attacks.

### Goal 3
`protocol-objects.md §16` contains a paragraph that explicitly instructs verifiers not to re-walk the `app_card` chain. `card_protocol_spec.md §7 Step 2` omits `app_card` chain verification from the verification stages. `press.md §5.4` describes `verifyAppCertificationChain` as the authoritative gate. All three need updating to reflect the new model: press checks first as an early gate; verifiers check independently as the binding enforcement layer. The `SignatureVerificationResult` type needs `app_card_chain_valid` so downstream consumers can reason about sub-card certification without re-implementing the check.

---

## Key Objectives

### Goal 1 — Close the attack vector
- A message signed by a sub-card whose `app_card` does not chain to the governance authority's app-certification policy root is rejected by `verifyStage2` with a new `APP_CARD_CHAIN_NOT_TRUSTED` error.
- A compromised press that registers a sub-card with an uncertified `app_card` produces signatures that fail verification, even if all on-chain registry entries are present and the holder signature is valid.
- Existing tests continue to pass when `app_card` chains to the trusted root (no regression on valid sub-cards).

### Goal 2 — Verifier self-sufficiency
- `verifyStage2` in `stage2.ts` walks the `app_card` chain using the same IPFS + RPC infrastructure used by Stage 3 for the master card chain walk.
- The `app_card` trusted root is configurable in `VerifierConfig` (separate field from `trustedRoots`, which governs the holder card chain), allowing operators to point verifiers at the governance authority's app-certification policy without conflating it with holder-chain trust roots.
- `SignatureVerificationResult` includes `app_card_chain_valid: boolean | "skipped"` (skipped for non-sub-card signatures, i.e. direct master card signatures).

### Goal 4 — Document the AppCertificationBody governance structure

The AppCertificationBody is the governance body that certifies wallet applications. Its existence and accountability model are implied by the app-certification policy root mechanism, but are not yet documented. A governance document is needed so that implementors, auditors, and policy authors understand who controls app certification, how that authority is structured, and what obligations app certification carries. This goal adds `governance/app_certification_body.md`.

---

### Goal 3 — Spec alignment
- `protocol-objects.md §16` "App-certification chain: press-side, not runtime" paragraph removed and replaced with a description of the verifier chain walk.
- `card_protocol_spec.md §7 Step 2` updated to include `app_card` chain walk as an explicit sub-step (alongside existing binding check).
- `press.md §5.4` `verifyAppCertificationChain` retained but reframed as an early gate (fail-fast before on-chain submission) rather than the authoritative check.

### Goal 4 — AppCertificationBody documentation
- New `governance/app_certification_body.md` describing the body's mandate, trust chain structure (Root Policy Body → app-cert policy root → AppCertificationBody members → wallet app cards), accountability model (members are auditors on issued cards), and core obligations (preventing app abuse or leakage of sub-cards).
- No new on-chain governance is required: Root Policy Body creates app-cert roots via the existing `PolicyAuthorizerKeys` mechanism; the body operates through the existing card issuance and auditor model.

---

## Resolved Open Questions

**OQ-1 — Trusted root configuration**  
→ New `VerifierConfig.appCertificationRoot: string` field, required, separate from `trustedRoots`. A consumer trusting a different holder root vs. app cert root can configure them independently. Also add `governance/app_certification_body.md` (see Goal 4).

**OQ-2 — Hard-reject vs. surface-as-field**  
→ Hard reject. If the app_card chain does not reach `appCertificationRoot`, `verifyStage2` returns `scope_clean: false` immediately, aborting stages 3–6. Error code: `APP_CARD_CHAIN_NOT_TRUSTED`. `app_card_chain_valid: false` is set on the result.

**OQ-3 — Handling missing app-certification root config**  
→ Config error. No old deployments exist, so `CardVerifier` constructor throws `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` if `appCertificationRoot` is absent. No silent skip.

**OQ-4 — Result type versioning**  
→ Deferred. No versioning system exists yet; that will be addressed in a separate plan. `app_card_chain_valid` is added as an additive field for now.
