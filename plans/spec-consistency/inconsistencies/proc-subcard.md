# Inconsistencies: `proc-subcard` (`specs/process_specs/subcard_creation_policy.md`)

Reviewed against all Phase-1-fixed object specs, all other in-scope Phase-2 process specs, and the two non-in-scope but directly-referenced legacy specs `specs/subcards.md` and `specs/update_codes.md` (both root-level, outside `process_specs/`).

Severity key: **MAJOR** (load-bearing / security-relevant contradiction), **GAP** (missing coverage, not itself a contradiction), **MINOR** (wording/cosmetic).

---

## Finding 1 — MAJOR: The policy's entire enforcement model has no attachment point in the authoritative object/press specs

`subcard_creation_policy.md` presents itself as a governing policy card whose `revocation_permissions` (8xx/9xx) and `field_definitions` (`notes`) predicates are evaluated by the press against update intents targeting **the sub-card itself** (§"Enforcement": "The press enforces this policy mechanically at update time... An 8xx revocation intent signed by either the user's active sub-card or the app's installation card... is accepted... A `notes` append intent... is accepted.").

This model cannot attach to the actual sub-card object model as fixed in Phase 1:

- `SubCardDocument` (`protocol-objects.md §16`) has **no `policy_id` field at all**. Every other card type (`CardDocument` §1, `PolicyCardDocument` §2) carries `policy_id` pinning it to a governing policy; `SubCardDocument`'s field list (`holder_primary_card`, `holder_primary_card_pubkey`, `app_card`, `app_card_pubkey`, `capabilities`, `limitations`, `recipient_pubkey`, `issued_at`, `valid_until`, `attestation_level`, `attestation_proof`, `app_signature`, `holder_signature`) has nothing that could point at `subcard_creation_policy.md`'s own `policy_id` CID.
- Sub-cards are registered on-chain as `SubCardRegistrations[sub_card_address] → SubCardEntry` (`registry_contract.md §3.4`), a **separate mapping** from `CardEntry` (`registry_contract.md §3.1`) that normal policy-governed cards use. `SubCardEntry` has no policy pointer either (`master_card_address`, `registration_log_head`, `sub_card_doc_cid`, `active`, `registered_at`, `deregistered_at`).
- The generic update pathway that `subcard_creation_policy.md` implicitly relies on — `press.md §5.3 processUpdateIntent`, step 3: *"Resolve the target card's policy from the on-chain `CardEntry`"* — cannot resolve a policy for a sub-card as `target_card`, because a sub-card has no `CardEntry`, only a `SubCardEntry`.
- Verifier-side, `protocol-objects.md §16` "Verifier chain walk" and `card_validation.md` Stage 2 never read a sub-card's own append-only log for 8xx/9xx entries or `notes` at all. The only two mechanisms verifiers actually consult for sub-card state are (a) the on-chain `SubCardEntry.active` flag and (b) the master card's `active_subcards` directory. A `notes`/8xx/9xx `LogEntry` "posted to the sub-card's own log" (as this policy assumes exists) has no defined verifier-facing effect anywhere in the fixed object specs.

**Net effect:** as currently written, `subcard_creation_policy.md` describes a policy-card enforcement mechanism for an object (`SubCardDocument`/`SubCardEntry`) that the Phase-1-fixed specs establish is not a policy-governed `CardEntry` and has no `policy_id`. Either (a) this spec needs to be rewritten to describe something other than a standard policy-card attached via the generic `/update` flow, or (b) `SubCardDocument`/`SubCardEntry`/`press.md §5.3` need a policy-attachment mechanism added for sub-cards, or (c) this document is describing an aspirational/future mechanism and should say so explicitly. Recommend surfacing to David per the plan's Clarification Checkpoint ("If Step A finds that a 'spec gap' is actually a missing spec entirely... stop and ask") — this isn't a small wording fix.

---

## Finding 2 — MAJOR: Revocation-authority contradiction (who may actually revoke a sub-card)

`subcard_creation_policy.md` §"Revocation — 8xx (Quiet)" and §"Enforcement" state:

> "Both the **user** and the **application** have 8xx (quiet) revocation privileges on the sub-card... An 8xx revocation intent signed by either the user's active sub-card or the app's installation card satisfies the `revocation_permissions.8xx` predicate and is accepted."

This directly contradicts the authoritative on-chain/off-chain revocation mechanism for sub-cards:

- `registry_contract.md §4.4 DeregisterSubCard`: the call requires `signature bytes[2420] — ML-DSA-44 (master card holder key; verified off-chain by press)`. It is explicitly the **master (primary) card's** key, not the sub-card's own key and not the app card's key.
- `specs/subcards.md §Authorization for Deregistration`: "Sub-card deregistration... requires a signature from the holder's **primary card key** — not from the sub-card key itself, and **not from the app**... This means sub-card keys cannot unilaterally deregister themselves. An app that wants to revoke its own sub-card... must request deregistration through the press, which requires the holder's primary key to be available."
- `card_validation.md` / `protocol-objects.md §16` verifier logic only trusts the on-chain `SubCardEntry.active` flag (set exclusively via `DeregisterSubCard`, master-key-only) and the master card's `active_subcards` directory (set exclusively via code-510/511/512, also hardcoded holder-only per `protocol-objects.md §1.1` and `card_updates.md`).

So per the authoritative specs, an app can never itself produce a signature with real revocation effect, and "the user's active sub-card" (a sub-card's own key) likewise cannot self-revoke. Only the holder's **primary/master** card key can. `subcard_creation_policy.md`'s predicate mapping (`is_holder` = the user's wallet, `is_issuer` = the application, `any_of` grants either full 8xx authority) grants the app a revocation capability that the rest of the protocol explicitly denies it.

Note this same claim ("The user or application (8xx)... per `subcard_creation_policy.md`") is echoed in `notification_relay.md`'s comparison table of wallet-service-local vs. on-chain revocation — so the inconsistency isn't isolated to this file, but `subcard_creation_policy.md` is the root source both cite.

**Recommendation:** Either narrow `subcard_creation_policy.md`'s 8xx grant so that "the application may revoke" is described accurately as *"the application may request/trigger revocation, which the wallet (holding the primary key) must countersign and submit"* — matching `subcards.md`'s actual flow — or, if a genuinely independent app-initiated revocation path is intended, that needs to be added to `registry_contract.md §4.4` and `subcards.md` as a new authorization path, not asserted only here.

---

## Finding 3 — MAJOR/MEDIUM: `is_issuer` redefinition conflicts with the canonical predicate definition

`subcard_creation_policy.md` (Formal Policy Expression notes) states:

> `"is_issuer": true` matches **the application** (which signed the sub-card acceptance and submitted it to the press, and is therefore the issuance-time signatory for the sub-card's lifecycle operations).

But the canonical predicate definitions in `card_protocol_spec.md` (§The Predicate System) define:

```
{ "is_issuer": true }
// The subject is the issuer (press) of the card being updated
```

i.e. `is_issuer` canonically means the **press**, not the application/offerer. `subcard_creation_policy.md` repurposes the same predicate name to mean a third, different party (the app that first-signs a `SubCardDocument`, analogous to an offerer/issuer_card role, but explicitly not the press). This is a naming collision: a verifier or press implementing the generic predicate evaluator (`card_protocol_spec.md`'s definition) would resolve `is_issuer` against "the press," while this policy's own worked semantics assume it resolves against "the application." Whichever meaning is intended, the two documents currently disagree on what `is_issuer` means, which is significant because `is_issuer` also appears with the standard (press) meaning in every other policy's `field_definitions`/`revocation_permissions` defaults (`protocol-objects.md §2`).

**Recommendation:** flag to whoever resolves Phase 2 fixes — this may also indicate `card_protocol_spec.md`'s "(press)" parenthetical is itself an error (perhaps it should read "(offerer)"), which would be a Phase 1 object-spec issue reopened, not something this unit can silently resolve.

---

## Finding 4 — GAP: The "creation, acceptance" two-thirds of the requested mapped process live entirely outside the in-scope Phase 2 file, in a file that isn't part of this review

The requested mapped process is "Subcard creation, acceptance, and revocation," but `subcard_creation_policy.md` covers **only post-issuance policy** (note-writing and revocation privileges) — it explicitly says so in its own Purpose section ("This policy complements `specs/subcards.md`, which defines the sub-card creation flow. The creation flow specifies *how* sub-cards are established; this policy specifies *what may be done with them afterward*.").

The actual creation/acceptance flow (keypair generation, `SubCardDocument` assembly, app-card-chain validation, user consent, countersigning, on-chain registration, `active_subcards` posting) is fully specified in `specs/subcards.md` — a **root-level spec file, not inside `process_specs/`, and not in the Phase 2 in-scope list at all**. This means:

- The bulk of the "creation and acceptance" process was not reviewed by any Phase 2 unit (unless another unit happens to pick it up incidentally — check with whoever ran Phase 2 kickoff).
- `specs/subcards.md` is also not in the Phase 1 in-scope object-spec list, despite defining `SubCardDocument` alongside `protocol-objects.md §16` (duplicated, thankfully-consistent-on-the-points-checked-here schema/flow narrative) — it's effectively an unreviewed shadow of the object spec.

This is itself a finding per the plan's own instruction ("A gap is itself an inconsistency-log entry... not a silent pass"). Recommend: either add `specs/subcards.md` to the in-scope list for a follow-up Step A pass, or explicitly note in the Phase 2 milestone that "creation/acceptance" was reviewed via `specs/subcards.md` outside the formal unit list and record why.

---

## Finding 5 — GAP: DNS-admin-card secp256r1 authorization path not mentioned

Phase 1 added an `AdminAuthorizeSubCardPayload`/`admin_secp_payload`/`admin_secp_signature` path (`registry_contract.md §4.3`, `press.md §5.4`) required when `RegisterSubCard`'s master card is a DNS admin card (`DnsAdminCardKeys[master_card_address]` non-zero) — an 8-argument `RegisterSubCard` call, with a new error code `E-47` (`INVALID_ADMIN_CARD_SIGNATURE`).

Neither `subcard_creation_policy.md` nor `specs/subcards.md` (§Step 5, which still narrates a pre-Fix-#2, non-DNS-admin-aware registration flow) mentions this path at all. `specs/subcards.md §Step 5` reads: "The press then calls `RegisterSubCard` on the Arbitrum One registry contract, creating a `SubCardEntry`..." with no reference to the admin secp256r1 co-signature that is now, per `registry_contract.md`, a hard precondition when the master is a DNS admin card. This is a stale/incomplete description of the registration call for that case — `subcards.md` should be updated to mention the DNS-admin path (or explicitly note it is out of scope and point to `press.md §5.4`/`registry_contract.md §4.3`). `subcard_creation_policy.md` itself doesn't need to describe the registration mechanics (that's `subcards.md`'s job per Finding 4's division of labor), but per the explicit ask in this review's brief, flagging that neither document currently covers it.

---

## Finding 6 — MINOR: 8xx code descriptions in `subcard_creation_policy.md` vs. the canonical `update_codes.md` registry

`subcard_creation_policy.md`'s table:

| Code | Meaning in sub-card context (this spec) | `update_codes.md` canonical meaning |
|---|---|---|
| 800 | "Sub-card authorization ended; app departed in good standing" | "Quiet revocation — role ended; departed in good standing" |
| 801 | "Voluntary surrender by holder (user revoked the app's authorization)" | "Quiet revocation — voluntary surrender by holder" |
| 810 | "Sub-card's signing key compromised" | "Quiet revocation — this card's signing key compromised" |
| 811 | "App installation lost or uninstalled; this sub-card only" | "Quiet revocation — sub-card lost or stolen (this card only)" |

These are contextual restatements, not hard contradictions, and are close enough in meaning that they likely don't need reconciliation — flagging only because `update_codes.md §Adding New Codes` step 3 says "Update any specification documents that use the new code to reference this document," and `subcard_creation_policy.md`'s code table doesn't cite `update_codes.md` as its source (it should, both for traceability and so future code-table edits propagate here).

---

## Finding 7 — MINOR: `limitations`/`capabilities` mechanism absent from this policy's scope

`protocol-objects.md §16` and `specs/subcards.md §Limitations`/`§Capabilities` define a whole content-constraint mechanism (`capabilities` whitelist, `limitations` predicate-based field constraints) that governs what a sub-card may sign — arguably as central to "what may be done with [a sub-card] afterward" as the note-writing and revocation privileges this policy does cover. `subcard_creation_policy.md` doesn't mention `capabilities`/`limitations` at all, or clarify that they're out of scope because they're set at issuance and are immutable (which would be consistent with this policy's own "Update Card Content" section barring 1xx–7xx post-issuance field changes — `capabilities`/`limitations` would fall under that same immutability by extension, but the spec never says so explicitly for these two specific fields). Not a contradiction, but a completeness gap worth a one-line cross-reference.

---

## Summary of what's NOT a problem (checked, consistent)

- `SubCardDocument` field names/types used implicitly in this policy's rationale (`notes` field, `active_subcards`) match `protocol-objects.md §16` and `§1.1`.
- The 5xx/510/511/512 disambiguation section (subcard's own log vs. master card's log) matches `protocol-objects.md §1.1`, `update_codes.md §5xx`, and `card_updates.md` exactly — this part is well cross-referenced and internally consistent across all four documents.
- The distinction this policy draws between sub-card-log 5xx prohibition and master-card-log 510/511/512 hardcoding is correctly stated and matches `card_validation.md`'s verifier requirements.
