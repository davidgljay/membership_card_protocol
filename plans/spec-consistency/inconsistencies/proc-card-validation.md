# Inconsistency Log — `proc-card-validation` (`specs/process_specs/card_validation.md`)

Reviewed against: `card_verifier.md` (primary cross-check), `protocol-objects.md`, `press.md`, `registry_contract.md`, `ARCHITECTURE.md`, `card_protocol_spec.md`. Read-only review; no fixes applied.

---

## 1. [HIGH] Stage 2 omits the `capabilities` / `valid_until` / `attestation_level` checks required by `protocol-objects.md` §16

`protocol-objects.md` §16 ("Verifier chain walk (runtime)") is the authoritative 12-step procedure for verifying a sub-card signature and states it as a `must`:

> "(1) confirm the message type appears in the sub-card's `capabilities`; (2) confirm `valid_until` has not passed; ... (11) confirm `attestation_level` is `"T2"` unless the governing policy explicitly accepts `"T1"`"

`card_validation.md` Stage 2 (steps 5–13) has no equivalent check anywhere. It never reads or evaluates `capabilities`, `valid_until`, `attestation_level`, or `attestation_proof` — I grepped the whole file and none of these terms appear. A signature from a sub-card whose `capabilities` don't cover the message type being signed, or whose `valid_until` has passed, or whose `attestation_level` doesn't satisfy the governing policy, would pass Stage 2 as written even though `protocol-objects.md` §16 makes these hard requirements.

**This same gap exists in `card_verifier.md`** (§7.2, steps 1–14) — I grepped that file too and it also never mentions `capabilities`, `valid_until`, or `attestation_level`. So this isn't a one-sided miss in the process spec; both documents describing "the same verification pipeline from two angles" independently omit checks that the object-reference spec (`protocol-objects.md` §16) requires. This looks like a genuine spec gap, not just a documentation inconsistency — recommend flagging to David per the plan's "spec gap" clarification checkpoint rather than folding it silently into a routine fix list, since it's security-relevant (a message-type/expiry/attestation-level bypass).

**Recommended resolution:** Add explicit steps to `card_validation.md` Stage 2 (and `card_verifier.md` §7.2) for: (a) confirming the signed message's `type` is covered by the sub-card's `capabilities` (and evaluating any `limitations`/`field_requirements` per `subcards.md`), (b) confirming `valid_until` has not passed, (c) confirming `attestation_level` satisfies the governing policy. Cross-reference `protocol-objects.md` §16 steps 1, 2, 11 as the source of truth.

---

## 2. [MEDIUM] Non-compliance report schema differs between `card_validation.md` step 25 and `card_verifier.md` §7.8's `NonComplianceReport`

`card_validation.md` step 25 requires the report to include:
- The full `SignedMessageEnvelope`
- The `policy_id` CID
- The specific field(s)/press-authorization check that failed
- The `press_signature` / press card identifying the responsible press
- **"The verifier's own card mutable pointer (so the body can authenticate the report source)"**

`card_verifier.md` §7.8's `NonComplianceReport` TypeScript interface has: `card_address`, `press_address`, `ipfs_card_document` (raw base64url bytes, not the envelope), `ipfs_cid`, `failed_checks`, `verified_at`. It has **no field for the verifier's own identity**.

This is a direct contradiction, not just a naming difference:
- `card_validation.md` requires a verifier-identifying field "so the body can authenticate the report source"; `card_verifier.md` §13 Decision 5 explicitly states the report is "**Unauthenticated for v1**... Signed reports... deferred to v2, pending definition of the verifier card registration flow" — i.e., `card_verifier.md` deliberately decided *not* to include verifier identity/authentication in v1, while `card_validation.md` still describes it as a required field.
- `card_validation.md` says the evidence attached is "the full `SignedMessageEnvelope`"; `card_verifier.md` attaches the raw IPFS card document + CID instead. These are materially different artifacts (an envelope proves what was signed and by whom at the transport layer; the raw card document proves what the press posted to IPFS).

**Recommended resolution:** Reconcile which is authoritative. Given `card_verifier.md` was just updated in Phase 1 and represents the concrete npm implementation, likely `card_validation.md` step 25's bullet list is stale (predates the v1/v2 authentication decision) and should be updated to match `card_verifier.md`'s actual `NonComplianceReport` fields, dropping the "verifier's own card mutable pointer" requirement (or explicitly deferring it to v2, consistent with Decision 5).

---

## 3. [MEDIUM] `card_validation.md`'s Structured Result schema is missing several fields that `card_verifier.md`'s `SignatureVerificationResult` defines for the same pipeline

`card_validation.md`'s "Structured Result (Per Signature)" JSON block includes: `signer_card`, `signature_valid`, `chain_reaches_trusted_root`, `scope_clean`, `revocation{...}`, `was_valid_at_signing_time`, `is_currently_valid`, `policy_compliant`, `policy_match`, `non_compliance_reported`, `addressed_to_verifier`, `annotations`.

`card_verifier.md`'s `SignatureVerificationResult` (§8) has all of the above plus four fields with no counterpart in `card_validation.md`:
- `chain_card_addresses` (Stage 3 — full resolved chain, not just the boolean root-reached flag)
- `log_updates` (Stage 4 — all 1xx–7xx entries)
- `press_subsequently_revoked` (Stage 5 — explicit boolean; `card_validation.md` only describes this as prose "informational context" in step 25's paragraph, not as a result field)
- `errors` (cross-cutting — `VerificationError[]`)

Since the plan's stated purpose for this pair of specs is that they "describe the same verification pipeline from two angles," a reader comparing the two would reasonably expect the result schemas to match (with only naming-convention differences, as is explicitly promised for the Python port in `card_verifier.md` §2). Right now `card_validation.md`'s schema reads as either stale or intentionally partial, and it isn't stated which.

**Recommended resolution:** Either (a) update `card_validation.md`'s Structured Result to add `chain_card_addresses`, `log_updates`, `press_subsequently_revoked`, and `errors` to match `card_verifier.md`, or (b) if the process spec is deliberately meant to describe only the conceptual result and not the full implementation schema, add a note saying so and pointing to `card_verifier.md` §8 as the concrete schema.

---

## 4. [LOW] Stage 2 lacks explicit hard-reject error paths for two failure cases that `card_verifier.md` documents

- **Sub-card/leaf document decryption failure.** `card_validation.md` step 6: "Derive the leaf card's content key... and decrypt the leaf card document fetched from IPFS. The signer's public key is sufficient to decrypt the leaf card." No hard-rejection language is attached, and the Error Paths table has no row for this case. `card_verifier.md` §7.2 step 4 is explicit: "Fetch and decrypt the sub-card document from IPFS using the leaf content key (AES-256-GCM). If decryption fails, **hard reject** (`scope_clean: false`)."
- **Signer's `CardEntry` not found on-chain.** `card_validation.md` step 5 says only "resolve it on the Arbitrum One registry" with no statement of what happens if no entry exists. `card_verifier.md` §7.2 step 2 is explicit: "Fetch `CardEntry` from the registry. If `entry.exists == false`, **hard reject** (`scope_clean: false`)," and this has a dedicated error code `CARD_NOT_FOUND` in §9's error table.

**Recommended resolution:** Add both as explicit hard-rejection steps and Error Paths table rows in `card_validation.md`, matching `card_verifier.md`'s language and (informally) its `CARD_NOT_FOUND` / `DECRYPTION_FAILED` codes.

---

## 5. [LOW] `card_verifier.md`'s own Stage 2 step numbering (13 then 14) creates an internal sequencing wrinkle that `card_validation.md`'s single-step narrative avoids — worth reconciling

`card_verifier.md` §7.2 step 13 says "If all checks pass, record `scope_clean: true`," and only *after* that, step 14 performs the app-certification chain re-walk which can still hard-reject and set `scope_clean: false`. Taken literally, `scope_clean` is provisionally set `true` at step 13 and then potentially overwritten at step 14 — the text never says this overwrite happens, it's implied only by reading forward. `card_validation.md` avoids this ambiguity by folding the app-signature check and the chain re-walk into a single step 12, with step 13 ("If any link in Stage 2 cannot be confirmed, record `scope_clean: false`") as a general catch-all covering the whole stage, not a specific "already recorded true" step.

This isn't a contradiction in outcome (both specs intend the same final behavior: any failure including the app-cert chain walk causes `scope_clean: false`), but `card_verifier.md`'s ordering is a residue of Decision A's Stage 2 addition being appended after an already-numbered "all checks pass" step, and reads as if it could be a bug. Confirms the prompt's suspicion — the Phase 1 edit to `card_verifier.md` (Decision A) is functionally consistent with `card_validation.md` but introduced this step-ordering awkwardness within `card_verifier.md` itself.

**Recommended resolution:** In `card_verifier.md` §7.2, renumber so the "record `scope_clean: true`" step comes after the app-certification chain walk (i.e., swap steps 13 and 14, or merge them into one closing step), so `scope_clean: true` is never provisionally recorded before all Stage 2 checks — including the app-cert re-walk — have completed.

---

## 6. [LOW] "Cached chain array" parallelization hint used in Stage 3 of `card_validation.md` has no counterpart anywhere in `card_verifier.md`'s Stage 3 (§7.3)

`card_validation.md` step 15 and its Error Paths table both reference a "cached chain array" of version CIDs used to parallelize IPFS fetches during the chain walk, and an explicit rule for resolving discrepancies ("Per-link on-chain addresses are authoritative; use those and flag the discrepancy"). This concept is well-established elsewhere (`ARCHITECTURE.md` §Performance and OQ-8, `card_protocol_spec.md` §7/§Open Questions, `press.md` §5 "cached chain resolved during `evaluatePredicates`").

`card_verifier.md` §7.3 (Stage 3 — Chain Walk) never mentions a "chain array," a cached-CID-list input, or any discrepancy-resolution rule for it — it walks `ancestry_pubkeys` and fetches ancestors from IPFS with no mention of a parallelization hint or how to reconcile it against current on-chain state. Given `card_verifier.md` is presented as the concrete implementation spec for this exact stage, this looks like an omission rather than an intentional scope boundary (no "out of scope" note is given, unlike the explicit scope-boundary notes in §1 for replay/freshness and policy-creation-chain verification).

**Recommended resolution:** Either add the cached-chain-array parallelization behavior and its discrepancy-resolution rule to `card_verifier.md` §7.3 (to match `card_validation.md` step 15 / Error Paths), or, if the npm package intentionally doesn't expose this as a caller-visible input (e.g., it's purely an `IpfsProvider`-level optimization the package doesn't need to know about), add a short note saying so.

---

## Confirmed consistent (no action needed)

- `revocation.status` 4-valued enum (`"not_revoked" | "revoked" | "loud_revocation" | "unknown"`) matches exactly between `card_validation.md`'s Structured Result and `card_verifier.md`'s `SignatureVerificationResult.revocation.status` (Fix #22 landed correctly on both sides).
- Step 12's runtime app-certification re-walk language (Decision A) matches `card_verifier.md` §7.2 step 14 in substance: same `VerifierConfig.appCertificationRoot` / `config.appCertificationRoot` field name (module-qualified), same `APP_CARD_CHAIN_NOT_TRUSTED` error code, same "early gate, not a substitute" framing relative to the press's registration-time check, and matches `protocol-objects.md` §16 step 12 / "App-certification chain: verifier-enforced" section as well.
- Stage numbering 1–7 lines up between the two documents (`card_validation.md` Stages 1–4, 6–7 ↔ `card_verifier.md` §7.1–7.4, 7.6–7.7); `card_validation.md`'s Stage 5a (Policy Creation Compliance) and Stage 8 (Replay/Freshness) are both explicitly called out as out-of-scope for the npm package in `card_verifier.md` §1's "Scope boundary" notes — this is a deliberate, documented split, not a contradiction.
- Sub-card `active_subcards` binding check and the hardcoded 510/511/512 holder-only authorization rule (independent of `update_policy`) match word-for-word in substance between `card_validation.md` step 9 / Error Paths, `card_verifier.md` §7.2 step 9, and `protocol-objects.md` §1.1 and §16 step 8.
- Policy compliance / press-authorization logic (on-chain `PressAuthorizations` as authoritative, current revocation not retroactive) matches between `card_validation.md` Stage 5 (steps 23–24) and `card_verifier.md` §7.5.
