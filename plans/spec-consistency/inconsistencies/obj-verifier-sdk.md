# Inconsistencies: `obj-verifier-sdk` (`specs/object_specs/card_verifier.md`)

Step A review. Unit reviewed in full against all other in-scope object specs, protocol-objects.md, card_protocol_spec.md, ARCHITECTURE.md, protocol-versioning.md, and the process specs (card_validation.md read in full; others grepped for verifier-API references).

---

## 1. [HIGH — security-relevant, load-bearing] App-certification chain re-walk at runtime: direct three-way contradiction

**Conflicting specs:** `card_verifier.md` §7.2 (Stage 2) + §11, `process_specs/card_validation.md` Stage 2 step 12, vs. `protocol-objects.md` (Sub-Card Document section, "Verifier chain walk (runtime)" step 12 and the following "App-certification chain: verifier-enforced" paragraph).

**`card_verifier.md` §7.2 step 12:**
> "Verify `app_signature` using `app_card_pubkey`. The app-card's own certification chain is **not** re-walked at runtime — the press validated this at `RegisterSubCard` time, and on-chain registration is the proof."

Reinforced in §11: "The verifier reads on-chain state; it does not re-verify the write authorization signatures."

**`card_validation.md` step 12 (Stage 2), same package's process-level twin, agrees:**
> "The runtime verifier does **not** re-walk the `app_card` certification chain to the governance root — that walk was performed by the **press at registration time** before `RegisterSubCard` was submitted... runtime verifiers rely on the press's app-chain validation."

**`protocol-objects.md`, however, explicitly requires the opposite:**
> "(12) walk the `app_card` chain: derive `app_card` content key via `HKDF-SHA3-256(app_card_pubkey_bytes, "card-content-v1")`; fetch and decrypt the app card document from IPFS; walk `ancestry_pubkeys` hop by hop until the chain reaches `VerifierConfig.appCertificationRoot`. Hard-reject with `APP_CARD_CHAIN_NOT_TRUSTED` and `scope_clean: false` if the chain exhausts without reaching the configured root or exceeds `maxChainDepth`."
>
> "**App-certification chain: verifier-enforced.** Runtime verifiers independently walk the `app_card` chain from `app_card_pubkey` up to the governance authority's app-certification policy root configured as `appCertificationRoot` in `VerifierConfig`. A sub-card whose `app_card` does not reach that root is rejected at Stage 2 (`APP_CARD_CHAIN_NOT_TRUSTED`) regardless of whether a press accepted it at registration time. The press also performs this check as an early gate before submitting `RegisterSubCard`... but the verifier's check is the binding enforcement layer."

This is not a wording nuance — it is a flat disagreement about whether trust in the app card's certification is delegated entirely to the press (card_verifier.md / card_validation.md's position) or independently re-enforced by every runtime verifier (protocol-objects.md's position), and it is exactly the kind of auth-boundary question the initiative's checkpoints call out for a real look rather than a routine fix.

Compounding evidence this isn't just stale text: protocol-objects.md's version depends on two things that don't exist anywhere in `card_verifier.md`:
- `VerifierConfig.appCertificationRoot` — `card_verifier.md` §5's `VerifierConfig` has no such field (only `trustedRoots`, `revocationFreshnessWindowSeconds`, `rejectStaleRevocation`, `maxChainDepth`, `registryEndpoint`, `fetchAnnotations`, `additionalAnnotators`).
- `APP_CARD_CHAIN_NOT_TRUSTED` — not present in `card_verifier.md` §9's error code table.

Notably, `press.md` §5.4 and `client_sdk.md` §9.2 both describe achieving the *same* app-certification check by configuring the general-purpose `trustedRoots` array with the governance app-cert root and calling ordinary `verifier.verifyCard(appCardAddress)` — i.e., they implement protocol-objects.md's intent (an app-cert-root check happens somewhere) but via `card_verifier.md`'s actual mechanism (`trustedRoots`, not a dedicated `appCertificationRoot` field), and they only apply it when *registering* a sub-card app, not on every subsequent runtime signature verification.

**Recommended resolution:** This needs an explicit decision, not a mechanical fix. Two consistent options:
- (a) Confirm card_verifier.md/card_validation.md's position is correct (press-time-only, on-chain registration is the proof) and rewrite protocol-objects.md's "Verifier chain walk (runtime)" step 12 and the "App-certification chain: verifier-enforced" paragraph to match — dropping `VerifierConfig.appCertificationRoot`/`APP_CARD_CHAIN_NOT_TRUSTED` or reclassifying that walk as something the *press* does at registration (as press.md/client_sdk.md already show), not something a generic runtime verifier does per-message.
- (b) Confirm protocol-objects.md's stronger runtime re-verification is actually intended, in which case `card_verifier.md` needs a new config field (`appCertificationRoot`), a new error code (`APP_CARD_CHAIN_NOT_TRUSTED`), and Stage 2 (§7.2) needs a new step describing the app-card chain walk — and card_validation.md's step 12 needs to be rewritten to match.

Flag to David directly per the initiative's own checkpoint rule for security-relevant auth-boundary findings.

---

## 2. [MEDIUM] `chain_reaches_trusted_root` result doesn't expose the resolved chain address list — consumer works around it via a private API

**Conflicting specs:** `card_verifier.md` §8 (`SignatureVerificationResult`) vs. `matrix_synapse_module.md` (predicates.py / chain_context.py description).

`card_verifier.md`'s result type exposes only `chain_reaches_trusted_root: boolean | "skipped"` — a single boolean, no list of the addresses visited during the Stage 3 walk.

`matrix_synapse_module.md` explicitly documents needing that list and not having it:
> "the verifier package's public result types expose `chain_reaches_trusted_root` (a bool) but not the underlying `chain_card_addresses` list — needed here for `chain_includes`/`card_field_matches` (which must check every card in the chain, not just whether it reaches a root)... Until/unless the verifier package exposes this on its public result types (it's already computed internally by Stage 3 — an additive change, not a redesign), this module has to reach into `membership_card_verifier.stages.stage3` directly, which isn't part of the package's documented public API."

This is a genuine spec gap in `card_verifier.md`: at least one real, spec'd consumer needs a field the result type doesn't expose, and is documented as reaching past the package's public API boundary to get it. `card_verifier.md` should either add a `chain_card_addresses: string[]` (or similar) field to the result types, or the gap should be logged as an accepted limitation rather than silently left for a downstream module to route around via a private import.

**Recommended resolution:** Add the chain address list to `SignatureVerificationResult`/`CardVerificationResult` in `card_verifier.md` §8 (additive, non-breaking, as matrix_synapse_module.md itself notes), and remove matrix_synapse_module.md's private-API workaround once available.

---

## 3. [MEDIUM] Python implementation of the verifier package is entirely unaddressed by `card_verifier.md`

**Conflicting specs:** `card_verifier.md` (npm-only) vs. `matrix_synapse_module.md`.

`card_verifier.md`'s title and entire body describe only `@membership-card-protocol/verifier`, a Node.js/TypeScript ESM package (§3: "Runtime: Node.js ≥ 22... Package name: `@membership-card-protocol/verifier`").

`matrix_synapse_module.md`, however, depends on and describes a Python package with an equivalent API used as authoritative:
> "deps: `membership-card-verifier` (path or git dependency until PyPI publish approval lands)..."
> "`rpc_provider.py` — implements `membership_card_verifier.RpcProvider`'s async methods..."
> "`chain_context.py`... builds a `VerifierConfig`... calls `CardVerifier.verify_envelope()`... or `verify_card()`..."
> "evaluated against the verifier package's result types (`CardVerificationResult`/`SignatureVerificationResult` — real field names: `chain_reaches_trusted_root`, `revocation.status`, etc.)"

This Python package (`membership_card_verifier/packages/verifier-py` in the repo) mirrors the npm package's class/method/field names (snake_case `verify_envelope`/`verify_card` vs. the npm spec's camelCase `verifyEnvelope`/`verifyCard`, but otherwise the same shape: `RpcProvider`, `IpfsProvider`, `VerifierConfig`, `CardVerificationResult`, `SignatureVerificationResult`, `chain_reaches_trusted_root`, `revocation.status`). None of this is mentioned in `card_verifier.md` — there is no cross-language parity guarantee, no note that a Python port exists or is in scope, and no statement of which package is authoritative if the two drift (e.g., finding #2 above — does the Python port already expose `chain_card_addresses` that the npm spec doesn't?).

**Recommended resolution:** `card_verifier.md` should at minimum note the existence of the Python port and either (a) state the npm spec is the canonical source of truth and the Python package must track it, or (b) be restructured/cross-referenced so both language bindings are covered by one authoritative API description. This is squarely a Phase 3 (`code-verifier-sdk`) concern too, since a real Python package already exists in the repo — flagging here because the spec-level omission is itself the Phase 1 issue.

---

## 4. [MEDIUM] `addressed_to_verifier` is declared in the result type but has no defined computation, no config input, and no method parameter to support it

**Conflicting specs:** `card_verifier.md` §8 vs. `card_validation.md` Stage 7.

`card_verifier.md`'s `SignatureVerificationResult` (§8) declares:
```
addressed_to_verifier: boolean;   // true if the envelope names the verifier's card
```
...but nowhere in the Verification Pipeline (§7.1–§7.7) is there a stage that computes this field. Critically, there is also no parameter anywhere in `VerifierConfig` (§5), `verifyEnvelope()`, or `verifyCard()` (§6) that tells the package what "the verifier's card" address actually is — the package literally has no input from which to derive this value.

`card_validation.md` defines the corresponding logic explicitly as its own pipeline stage:
> "### Stage 7: Recipient-Set Check
> 31. Confirm the verifier's card mutable pointer appears in the `payload.recipients` array.
> 32. If absent, flag as `addressed_to_verifier: false`..."

`card_validation.md` at least implies the verifier's own card address is available context for this stage, but `card_verifier.md` — the concrete npm API that (per press.md, app_sdk.md, wallet_sdk.md) is supposed to be *the* implementation of this validation process — never threads that input through and never describes Stage 7's logic at all. This looks like a genuine oversight: the result field exists, the stage number it corresponds to (7) is skipped entirely in `card_verifier.md`'s pipeline section, and the API surface has no parameter to support computing it.

**Recommended resolution:** Add a stage (or extend an existing one) to `card_verifier.md` §7 describing the recipient-set check, and add a `verifierCardAddress` (or similar) parameter — either to `VerifierConfig` or as a per-call option on `verifyEnvelope`/`verifyCard` — so the field is actually computable as specified.

---

## 5. [MEDIUM] Stage 8 (Replay and Freshness Check) is entirely absent from `card_verifier.md`

**Conflicting specs:** `card_verifier.md` (whole document) vs. `card_validation.md` Stage 8.

`card_validation.md` defines an eighth, mandatory stage:
> "### Stage 8: Replay and Freshness Check
> 33. Compute the message ID: `SHA3-256(canonical RFC 8785 JSON of payload)`.
> 34. Confirm the `payload.timestamp` is within the verifier's acceptable freshness window.
> 35. Confirm this message ID has not been seen before (replay prevention)..."

`card_verifier.md` has no equivalent stage, no message-ID field in its result types (§8), and no replay-flag field. This may be an intentional scope boundary (a "thin," stateless, purely-functional verification package plausibly shouldn't own a replay-history store — that's naturally a caller/`StorageProvider` concern, as `app_sdk.md` §9.2 confirms by handling dedup itself via a `StorageProvider`-backed history rather than delegating it to `CardVerifier`). But `card_verifier.md` never states this exclusion explicitly — it silently drops a stage that its own process-spec counterpart calls mandatory, without a note explaining the scope boundary.

**Recommended resolution:** Add a short note to `card_verifier.md` (e.g. in §1 Overview or §7) stating that replay/freshness (card_validation.md Stage 8) and recipient-set addressing (Stage 7, see #4 above) are explicitly out of scope for this package and left to the caller, if that is indeed the intended design — otherwise reconcile as in #4.

---

## 6. [LOW] `revocation.status` enum values differ between the two specs

**Conflicting specs:** `card_verifier.md` §8 vs. `card_validation.md` "Structured Result" section.

`card_verifier.md`:
```
status: "not_revoked" | "revoked" | "loud_revocation" | "unknown";
```

`card_validation.md`:
```
"status":  "none" | "revoked",
```

Different cardinality (2 vs. 4 values) and different naming for the non-revoked case (`"none"` vs. `"not_revoked"`). Since `card_verifier.md` is the newer, more detailed, concrete API spec and `card_validation.md` states its own npm API section is deferred to the package spec, `card_validation.md`'s abbreviated result JSON is likely just stale/simplified — but the two should use identical vocabulary since they describe the same field.

**Recommended resolution:** Update `card_validation.md`'s structured-result example to match `card_verifier.md`'s four-value enum (or otherwise state that `card_validation.md`'s JSON is illustrative/non-normative and defers to `card_verifier.md`).

---

## 7. [LOW] `non_compliance_reported` type/semantics mismatch

**Conflicting specs:** `card_verifier.md` §8 vs. `card_validation.md` "Structured Result" section.

`card_validation.md`:
> `"non_compliance_reported": true | false | null` ... "`null` if no non-compliance was detected."

`card_verifier.md`:
```
non_compliance_reported: boolean;  // true if POST to Registry Body succeeded
```
No `null` state — `card_verifier.md`'s type can only be `true` or `false`, so it's ambiguous from the type alone whether `false` means "report was needed but the POST failed" or "no report was needed at all." (The prose in §7.7 clarifies via the error-handling text, but the type itself doesn't carry the distinction card_validation.md's `null` state makes explicit.)

**Recommended resolution:** Either add a `null` variant to `card_verifier.md`'s `non_compliance_reported` type (aligning with card_validation.md) to distinguish "not applicable" from "attempted and failed," or explicitly document in `card_verifier.md` that `false` is overloaded to cover both cases and that callers must check `policy_compliant` to disambiguate.

---

## 8. [LOW] Stage 5a (Policy Creation Compliance, for policy-level verification) has no counterpart in `card_verifier.md`

**Conflicting specs:** `card_verifier.md` (Stages 1–6 only) vs. `card_validation.md` Stage 5a and `card_protocol_spec.md` §5a.

Both `card_validation.md` and `card_protocol_spec.md` define a "Stage 5a" / "policy creation compliance check" for verifying a *policy card itself* (walking the policy-creation chain, collecting inherited `field_definitions` restrictions from ancestor policies). `card_verifier.md`'s pipeline (§7.1–§7.7) has no equivalent stage, and neither `verifyCard()` nor `verifyEnvelope()` (§6) documents a mode for policy-level verification as opposed to ordinary card verification.

This may be an intentional scope decision (the npm package might only ever be used against ordinary issued cards, with policy-chain compliance evaluated separately, e.g. at policy creation time by governance tooling) — but it isn't stated as such anywhere in `card_verifier.md`.

**Recommended resolution:** Either add a Stage 5a / policy-verification mode to `card_verifier.md`, or add an explicit note that policy-level verification is out of scope for this package and handled elsewhere (naming where).

---

## 9. [LOW] Missing 510/511/512 log-entry-signer check in `card_verifier.md` Stage 2

**Conflicting specs:** `card_verifier.md` §7.2 (Stage 2, steps 1–13) vs. `card_validation.md` Stage 2 step 9 and its Error Paths table.

`card_validation.md` step 9 includes a MUST-level requirement not present anywhere in `card_verifier.md`'s Stage 2:
> "Verifiers MUST also confirm, whenever they encounter a code-510/511/512 `LogEntry` on the master card's own log..., that the entry's `intent_signature` was produced by the master card's own holder key. A 510/511/512 entry signed by any other party... MUST be rejected — this authorization is hardcoded... and is not subject to the governing policy's `update_policy`."

`card_verifier.md`'s Stage 2 (§7.2, steps 1–13) walks `active_subcards` membership (step 9) but never mentions verifying who signed the 510/511/512 log entries that produced the current `active_subcards` state. This looks like a real omission in the npm package spec relative to its own process-spec counterpart, not an intentional scope difference (there's no stated reason auditing this signer check would be out of scope for a general-purpose verifier).

**Recommended resolution:** Add this check to `card_verifier.md` §7.2 (Stage 2), matching `card_validation.md` step 9's language, or explain why it's intentionally excluded from the package (e.g., if `active_subcards`' correctness is assumed to already be enforced elsewhere and the package trusts the current directory snapshot without auditing its log history).

---

## 10. [INFORMATIONAL] `wallet.md` does not delegate to `CardVerifier` at all — narrower scope than assumed

Worth recording since the review brief assumed `wallet.md` delegates chain-walking/revocation-checking to `CardVerifier` like press.md/app_sdk.md/wallet_sdk.md do. It does not: `wallet.md` never mentions `CardVerifier` or `@membership-card-protocol/verifier` anywhere, and explicitly states:

> "**What this service does not do:** ... chain verification at the routing layer..."

`wallet.md` §6.6 instead implements its own narrow, local ML-DSA-44 "proof of key control" check for sub-card message routing (resolving the sub-card's public key via `getSubCardEntry` → IPFS, confirming `keccak256(pubkey) == subcard_hash`, verifying a signature over the payload) — deliberately not a full chain walk, and deliberately not consulting `SubCardEntry.active`/on-chain revocation at all (by design, per its own text, so a merely-deregistered sub-card can resume delivery without being conflated with a revoked one).

This isn't a contradiction with `card_verifier.md` itself (wallet.md never claims to use it, so there's no mismatched API-surface claim to reconcile), but it's a divergence from the broader "no independently re-derived trust logic — always go through `CardVerifier`" design principle stated identically in `app_sdk.md` §2 and `wallet_sdk.md` §2. Given `wallet.md`'s check is intentionally narrower than full chain verification (proof-of-key-control only, not trust/revocation), this is likely fine as designed, but is flagged here in case the "no independently re-derived trust logic" principle was meant to apply repo-wide rather than just within the two SDK packages.

**Recommended resolution:** No spec change needed unless the design principle in app_sdk.md/wallet_sdk.md §2 was intended to bind wallet.md too — in which case that principle statement should be scoped explicitly to "this package" rather than read as a repo-wide invariant, to avoid the appearance of a violation.

---

## Stale reference to `client_sdk.md` check

`client_sdk.md` (superseded, archived per Phase 0) is not cited as authoritative by any *other* in-scope spec examined here — `app_sdk.md` and `wallet_sdk.md` are the only successor specs that reference the shared `CardVerifier`, and neither cites `client_sdk.md`. No stale-authority issue found for this unit.

Note in passing: `client_sdk.md` itself (§9.2, its own text) describes `verifyStage1` as an internal function name and documents the envelope payload shape as including a `protocol_version` field alongside `message`/`timestamp` — neither appears in `card_verifier.md`'s current `SignedMessageEnvelope.payload` type, though `card_verifier.md`'s `[key: string]: unknown` index signature technically permits it. Since `client_sdk.md` is archived, this is not logged as an active inconsistency, only noted in case it's useful context if `app_sdk.md`/`wallet_sdk.md` are found (in their own Step A reviews) to rely on a `protocol_version` field that `card_verifier.md` should document explicitly.
