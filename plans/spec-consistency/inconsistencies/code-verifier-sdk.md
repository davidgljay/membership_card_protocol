# Spec vs Code: `card_verifier.md` vs `membership_card_verifier/`

**Unit:** `code-verifier-sdk`
**Spec:** `specs/object_specs/card_verifier.md` (includes Phase 1 and Phase 2 spec-consistency amendments, both dated today per the changelog at the top of the spec)
**Code:** `membership_card_verifier/packages/verifier` (`@membership-card-protocol/verifier`, TypeScript) and `membership_card_verifier/packages/verifier-py` (Python port)

Scope note: this is a spec-vs-code diff, not a spec-vs-spec diff. Recommended resolutions state which side is correct; per the task brief, "code needs to implement the new design" is the expected/default verdict for the two amendments below, since both are dated today and it's plausible the implementation hasn't caught up yet. Security-relevant divergences are called out for escalation.

---

## Summary of the two recent spec amendments' implementation status

- **Phase 1 amendment (app-certification chain re-walk — Decision A):** **Implemented in code**, in both TS and Python. `VerifierConfig.appCertificationRoot`, the Stage 2 chain re-walk, and error code `APP_CARD_CHAIN_NOT_TRUSTED` all exist and are exercised in both language ports. However, several details of the implementation diverge from the spec's description of this same feature (see findings 1–4 below) — this is not a clean "spec fully realized," it's "the feature exists but doesn't match spec in several particulars."
- **Phase 2 amendment (`capabilities`/`valid_until`/`attestation_level` checks, `chain_card_addresses`, `verifierCardAddress`, Stage 2 step-ordering fix):** **Not implemented at all**, in either language port. See findings 5–9.

---

## Findings

### 1. `VerifierConfig.appCertificationRoot` is required in code; spec says it's conditionally optional — ESCALATE TO DAVID

**Spec** (`card_verifier.md` §5): `appCertificationRoot?: string` — optional, with the doc comment "Required whenever the caller expects to verify signatures from sub-cards," implying callers who never verify sub-card signatures (e.g., a verifier only ever checking primary-card signatures) may omit it.

**Code:** `packages/verifier/src/types.ts` line 118 declares `appCertificationRoot: string` (no `?`) — a required field. `CardVerifier`'s constructor (`packages/verifier/src/CardVerifier.ts` lines 48–53) throws `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` if it's missing, unconditionally, for every `CardVerifier` instance regardless of whether that instance will ever see a sub-card signature. The Python port (`verifier-py/src/membership_card_verifier/types.py` `VerifierConfig.app_certification_root: str`, no default) mirrors this — also unconditionally required.

**Divergence:** Code is strictly stricter than spec — it forecloses the "verifier never handles sub-cards" use case the spec explicitly carves out. This is a security/availability-relevant divergence in the requirements boundary of a defense-in-depth check (Decision A), not just a naming nit — a legitimate integrator who only ever verifies primary-card signatures cannot construct a `CardVerifier` at all under current code, per spec they should be able to.

**Recommendation:** Flag to David — this could go either way. Making it always-required is arguably a *more conservative, safer* default (a caller can't forget to configure the anti-defense-in-depth root and unknowingly accept sub-card signatures with no chain check), but it's a deliberate behavioral choice that the spec doesn't currently describe, and it changes the public API contract (constructor now throws where the spec says it shouldn't). Needs a decision: relax code to match spec's optional-with-conditional-requirement design, or update spec to say it's unconditionally required (documenting the trade-off).

### 2. Code introduces an `app_card_chain_valid` result field that does not exist in the spec — ESCALATE TO DAVID

**Spec** (`card_verifier.md` §7.2, §8): The app-certification chain walk (Stage 2 step 16) is folded entirely into `scope_clean` — a chain-walk failure is a hard rejection that sets `scope_clean: false`. There is no separate result field for the app-cert chain outcome; `SignatureVerificationResult` in §8 lists only `scope_clean`, `chain_reaches_trusted_root`, `chain_card_addresses`, etc. — no `app_card_chain_valid`.

**Code:** Both `SignatureVerificationResult` (TS `types.ts` line 180, Python `types.py`) and `CardVerificationResult` add a field `app_card_chain_valid: boolean | "skipped"` not present in the spec's result shape at all. It's populated in `stages/stage2.ts`/`stage2.py` and threaded through `CardVerifier.ts`.

**Divergence:** This is undocumented behavior added on top of the spec's design — every consumer of this API today gets an extra field the spec doesn't promise, and (more importantly) the spec's model where a chain-walk failure is *entirely* subsumed by `scope_clean: false` is not quite what's implemented: the code surfaces the chain-walk outcome as its own independently-inspectable boolean, which is more granular than the spec intends. Since this is precisely the field tracking whether the defense-in-depth security check passed, the shape of how a caller can query it is worth getting deliberately right rather than leaving as an accidental implementation artifact.

**Recommendation:** Flag to David. Either (a) spec should be updated to add `app_card_chain_valid` to §8's result type, formalizing what's actually useful behavior (letting callers distinguish "app-cert chain failed" from other Stage 2 hard rejections), or (b) code should stop exposing it separately and rely purely on `scope_clean` + `errors[].code === "APP_CARD_CHAIN_NOT_TRUSTED"` as the spec describes. Recommend (a) — the extra granularity seems useful and low-risk — but this is a public API shape decision, not a mechanical fix.

### 3. `chain_card_addresses` is computed internally but never exposed on the public result — spec gap in implementation

**Spec** (`card_verifier.md` §7.3 step 1, §8): `chain_card_addresses: string[]` is a documented field on `SignatureVerificationResult`, populated during the Stage 3 walk.

**Code:** `packages/verifier/src/stages/stage3.ts` computes `chain_card_addresses` correctly (`Stage3Result.chain_card_addresses`, lines 14–122) and it's consumed internally by `CardVerifier.ts` (e.g. passed into Stage 4/6 calls at lines 280, 319). But `SignatureVerificationResult` in `types.ts` (lines 175–193) has **no `chain_card_addresses` field**, and `CardVerifier.ts`'s result-construction blocks (lines 326–345, 347–382, 389–413) never copy it onto the returned object. The only externally-visible chain data is the optional `chain: ChainLink[]` field, gated behind a `returnChain` config flag that doesn't exist in the spec at all (see finding 8).

Python port: same gap — `stage3.py`'s result carries `chain_card_addresses` but `SignatureVerificationResult`/`CardVerificationResult` in `types.py` (lines ~163–190) don't include it either.

**Recommendation:** Code needs to implement this — straightforward fix, not a design judgment call. Add `chain_card_addresses: string[]` (both langs) to the public result types and thread it through in `CardVerifier.ts`/`card_verifier.py`'s result-construction sites, matching the pattern already used for `log_updates`/`annotations`.

### 4. `scope_clean: true` timing relative to the app-cert chain walk — matches spec (Decision 7), confirmed correct

**Spec** (`card_verifier.md` §7.2 step 17, §13 Decision 7): `scope_clean: true` must be recorded only after the Stage 2 app-cert chain walk (step 16) completes without failure.

**Code:** `stages/stage2.ts` returns `scope_clean: true` only from the final `return` statement (lines 250–257), which is only reached after the chain-walk loop (lines 199–248) completes successfully; every chain-walk failure path returns `scope_clean: false` before reaching that point. This is correct and matches the spec's Decision 7 ordering requirement. No action needed — noted here only because Decision 7 was explicitly called out as something to check.

### 5. Missing entirely: capabilities check (`CAPABILITY_NOT_GRANTED`) — Phase 2 amendment not implemented

**Spec** (`card_verifier.md` §7.2 step 7, §9): Stage 2 must confirm `envelope.payload.message` appears in the sub-card's `capabilities` array when running `verifyEnvelope` (skipped for `verifyCard`), hard-rejecting with `CAPABILITY_NOT_GRANTED` otherwise.

**Code:** No such check exists anywhere in `stage2.ts`/`stage2.py`. `SubCardDocument.capabilities: string[]` is defined in the type (`types.ts` line 92, `types.py`) but never read by any stage. The error code `CAPABILITY_NOT_GRANTED` does not appear anywhere in `packages/verifier/src` or `packages/verifier-py/src` (confirmed via grep — zero matches). `verifyStage2` also isn't passed the message type at all (its signature takes `publicKeyBytes, rpc, ipfs, config` only — no payload/message parameter), so there's no plumbing in place to perform this check even if added superficially.

**Recommendation:** Code needs to implement this — it's a genuine new-design gap, not a spec error. Requires: (a) passing `envelope.payload.message` into `verifyStage2` (only for the `verifyEnvelope` path, per spec), (b) the array-membership check, (c) hard rejection wired the same way as the existing binding checks, (d) the new error code.

### 6. Missing entirely: expiry check (`SUBCARD_EXPIRED`) — Phase 2 amendment not implemented

**Spec** (`card_verifier.md` §7.2 step 8, §9): If `valid_until` is present on the sub-card document, Stage 2 must hard-reject with `SUBCARD_EXPIRED` once it has passed.

**Code:** `SubCardDocument.valid_until?: string` exists in the type (both langs) but is never read in `stage2.ts`/`stage2.py`. `SUBCARD_EXPIRED` does not appear anywhere in either package's source.

**Recommendation:** Code needs to implement this — straightforward addition to Stage 2 alongside finding 5.

### 7. Missing entirely: attestation-level check (`ATTESTATION_LEVEL_INSUFFICIENT`) and `acceptedAttestationLevels` config — Phase 2 amendment not implemented

**Spec** (`card_verifier.md` §5, §7.2 step 14, §9): `VerifierConfig.acceptedAttestationLevels?: ("T1"|"T2")[]` (default `["T2"]`), and Stage 2 must hard-reject `"T1"` sub-cards unless `"T1"` is in the accepted set, with error code `ATTESTATION_LEVEL_INSUFFICIENT`.

**Code:** `VerifierConfig` (`types.ts` lines 115–128, `types.py` `VerifierConfig` dataclass) has no `acceptedAttestationLevels`/`accepted_attestation_levels` field at all. `SubCardDocument.attestation_level: "T1"|"T2"` is defined but never inspected by any stage. `ATTESTATION_LEVEL_INSUFFICIENT` does not appear anywhere in either package.

**Recommendation:** Code needs to implement this — new config field, new Stage 2 check, new error code, in both language ports.

### 8. Missing entirely: `verifierCardAddress` config/option and the Stage 7 Recipient-Set Check — pre-dates Phase 2, but directly relevant to it

**Spec** (`card_verifier.md` §5, §6.1, §7.7, §8): `VerifierConfig.verifierCardAddress?: string`, a per-call `VerifyEnvelopeOptions.verifierCardAddress` override, and Stage 7 computing `addressed_to_verifier` from `payload.recipients`.

**Code:** No `VerifierConfig.verifierCardAddress` field in either `types.ts` or `types.py`. No `stage7.ts`/`stage7.py` file exists at all (confirmed — `find ... -iname "*stage7*"` returns nothing). `addressed_to_verifier` is hardcoded to `false` at every result-construction site in `CardVerifier.ts` (lines 98, 198, 340, 377, 408) and the Python equivalent — it is never computed from anything. `verifyEnvelope`'s TS signature (`CardVerifier.ts` line 71) doesn't even accept an `options` parameter, so there's no way to pass a per-call override even if the field existed.

**Note on scope:** this gap isn't new in the Phase 2 amendment — Stage 7 and `addressed_to_verifier` were already fully specified before today's changes. But the Phase 2 changelog adds `verifierCardAddress` to `VerifierConfig` specifically to serve this pre-existing, already-unimplemented stage, so it's included here as directly relevant to the unit under review.

**Recommendation:** Code needs to implement this — it's a full spec-described feature (config field, per-call override, entire pipeline stage) with zero code presence today. This is the largest single gap found in this unit and should be prioritized in the consolidated fix list, since `addressed_to_verifier` is a documented, non-trivial cross-cutting result field that currently always silently reports a wrong/default value rather than "not implemented."

### 9. Undocumented extra features in code not described anywhere in the spec

**Code-only additions with no spec counterpart:**
- `VerifierConfig.returnChain?: boolean` and the `chain?: ChainLink[]` result field (`ChainLink { card_address, public_key, card_content }`) — a whole extra chain-inspection feature.
- `VerifierConfig.conditions?: PolicyMatchConditions` (`{ policy_id, field_match }`) plus `evaluatePolicyMatch()`/`policy-match.ts` and the `policy_match: boolean | null` field at *both* the per-signature level (matches spec) and the top-level `EnvelopeVerificationResult.policy_match` (does not match spec — spec's §8 `EnvelopeVerificationResult` has only `envelope_id`, `verified_at`, `signatures`, no top-level `policy_match`).
- Placing `conditions` inside `VerifierConfig` directly contradicts an explicit spec statement: §7.5 step 4 says a relying party's `requiredPredicate`/`requiredPolicy` is "passed in as a call-site option — not part of `VerifierConfig`." Code does the opposite — it's construction-time config, not a per-call option, and neither `verifyEnvelope` nor `verifyCard`'s TS signatures accept any such per-call parameter.
- `protocol_version` field on both `EnvelopeVerificationResult` and `CardVerificationResult`, plus an entire `version.ts`/`extractProtocolVersion()`/`KNOWN_PROTOCOL_VERSIONS` protocol-version-extraction and validation mechanism, and a `SignedMessageEnvelope.payload.protocol_version` field — none of which appear in the spec's §6/§8 type definitions at all.
- `SignatureEntry.key_scheme?: "mldsa44" | "secp256r1_phase1"` — spec's `SignatureEntry` (§6.1) has only `public_key`/`signature`, no `key_scheme`.

**Recommendation:** Not necessarily bugs — these look like legitimate, deliberately-built features (protocol versioning, policy-match predicates, chain inspection) that the spec simply hasn't caught up to documenting, likely because they predate this initiative's Phase 1/2 spec passes. Flag as a **spec gap** rather than a code bug: the consolidated fix list should decide whether to document these in `card_verifier.md` (most likely correct, since they look intentional and tested) or whether any of them should be reconciled/removed. The one exception is the `conditions`-placement contradiction above, which is a real, already-stated inconsistency between the code's construction-time config and the spec's explicit call-site-option requirement for the same concept — that specific piece should be resolved, not merely documented.

### 10. Stage 2 step 15 (app_signature verification) does not hard-reject on failure — code correctness issue, security-relevant

**Spec** (`card_verifier.md` §7.2 step 15): "Verify `app_signature` using `app_card_pubkey`." The step isn't explicitly labeled "hard reject" in the same bullet-point style as steps 4/6/10, but every other signature/binding check in Stage 2 (holder signature, step 12; both binding checks, step 6) is a hard rejection, and an app card's authorization of a sub-card should logically gate the same way.

**Code:** `packages/verifier/src/stages/stage2.ts` lines 154–165 (mirrored in `stage2.py`):
```ts
if (!appSigValid) {
  errors.push({ stage: 2, code: "INVALID_APP_SIGNATURE", message: "App signature on sub-card document is invalid" });
}
```
No `return` statement — unlike every other failing check in this file, which returns `scope_clean: false` immediately. Execution falls through to the app-certification chain walk and can still end with `scope_clean: true` even when the app card's signature over the sub-card document doesn't verify.

**Divergence:** This looks like an oversight relative to the file's own pattern (every other check here does hard-reject), and it's security-relevant: it means a sub-card whose `app_signature` doesn't verify — i.e., isn't actually authorized by the app card it claims — could still pass Stage 2 and register as `scope_clean: true`, provided the rest of the checks pass, up to and including the app-cert chain re-walk (finding 4's Decision 7 feature) which is meant to be the strong defense-in-depth guarantee. An unauthenticated app_signature undermines the trust the chain walk is meant to establish.

**Recommendation:** ESCALATE TO DAVID. This is exactly the kind of security-relevant divergence the task brief calls for flagging — it sits right next to the app-cert chain re-walk (Decision A / Decision 7) that this initiative's Phase 1 amendment was specifically about hardening. Whichever party is "correct" here, the current code behavior (silently continuing past an invalid app_signature) should not ship as-is. Two paths: (a) spec should explicitly mark step 15 as a hard rejection (it clearly should be, given the surrounding pattern) and code should add the missing `return`; or (b) if there's a reason app_signature failure was deliberately made non-fatal (e.g., some legacy-migration tolerance), that reasoning needs to be made explicit in the spec, because as written today it reads as an accidental omission of one `return` statement rather than an intentional design choice.

---

## Language-binding parity (Python vs TypeScript)

Per the spec's §2 "Language bindings" requirement, the Python port (`verifier-py`) must track the TypeScript spec field-for-field, differing only in naming convention. Checked `types.py`, `stage2.py`, and `CardVerifier`-equivalent surface against `types.ts`/`stage2.ts`/`CardVerifier.ts`:

**Result: the two ports are in sync with each other.** Every gap and every extra feature found above in the TypeScript code (missing capabilities/valid_until/attestation_level checks, missing `chain_card_addresses` on the public result, missing `verifierCardAddress`/Stage 7, the extra `app_card_chain_valid`/`returnChain`/`conditions`/`protocol_version`/`key_scheme` additions, and the same non-hard-rejecting `app_signature` check) is mirrored identically in the Python port, with only the expected `snake_case` naming difference (e.g. `app_certification_root`, `chain_card_addresses` — same English name, just not present in either). No Python-only divergence from the TypeScript implementation was found; the two packages appear to have been built and are being maintained in lockstep. This satisfies the spec's stated parity requirement even though both together diverge from the spec itself in the ways detailed above.

---

## Priority ordering for the consolidated fix list

1. **Finding 10** (app_signature not hard-rejected) — security bug, small fix, should not wait on any design discussion.
2. **Findings 5–8** (Phase 2 checks + Stage 7, entirely missing) — largest scope of work; these are the "code needs to implement the new design" cases the task brief expected as the common outcome.
3. **Finding 3** (`chain_card_addresses` not surfaced) — small, mechanical fix.
4. **Findings 1, 2** — need David's decision before either side changes.
5. **Finding 9** — likely just needs spec documentation to catch up to existing code, except the `conditions` placement contradiction which needs a real decision.
