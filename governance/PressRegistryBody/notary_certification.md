# PressRegistryBody — Notary Runtimes, Programs and Operators

**Status:** Approved at notary checkpoint CP3 (2026-11-12), including the emergency-retirement rule. Publishing any list or registering any policy is still a CP7 action.
**Parent body:** PressRegistryBody (`mandate.md`)
**Context:**
- `specs/ARCHITECTURE.md` ADR-013;
- `specs/card_protocol_spec.md §9`;
- `specs/protocol-objects.md` §2.2, §20, §34;
- `specs/object_specs/notary_runtime.md`;
- `plans/notary-design-decisions.md` (decisions D1, D2 and D6).

> **Terminology.** "AWS Nitro Enclaves" and "the enclave" mean the trusted execution environment notaries run in. "PCR0" is the measurement of an enclave image. This is unrelated to the web framework the press is built on (nitropack). See `specs/ARCHITECTURE.md`, terminology note.

---

## Role and Mandate

A **notary** runs a declared program over members' signed inputs inside an enclave. Contributors' wallets check, before sending anything, that the enclave runs an accepted runtime and the expected program. The wallets and the runtimes themselves need a trustworthy answer to three questions:
- Which runtime images may hold notary keys?
- Which programs have been audited well enough to share an enclave with other communities' jobs?
- Which operators may issue derived cards?

This mandate gives the PressRegistryBody that role. It is a **second mandate**, alongside operator conduct for presses. Notary operators are operators in the same sense, and the derived-card authority below uses the same `AuthorizePress` power the body already holds.

The mandate is written as its own document so it can later move to a separate body without changing any card chain. Moving it means re-holding the cards listed below; the chains don't change.

---

## What the Body Holds

No new on-chain mechanism is needed. Everything is either a card or an existing on-chain power.

| Item | Form | Purpose |
|---|---|---|
| **Accepted-runtime list card** | A card whose `accepted_runtimes` field lists runtime PCR0s with `accepted_from` and `retired_at` dates (`protocol-objects.md §34`) | Wallets and verifiers refuse an enclave whose PCR0 isn't accepted. Runtimes refuse to hand keys to one. |
| **Program allowlist card** | A card whose `program_allowlist` field lists audited program CIDs with source, toolchain and audit report | Only allowlisted programs may run `shared`. Wallets label all others "custom program — not independently audited". |
| **Member approvals on both lists** | A `list_approval` field on each list card, signed with members' governance keys (`protocol-objects.md §34`) | Makes the quorum (and the 2-of-5 emergency rule) checkable by every runtime, wallet and verifier, so no single key controls what is accepted |
| **`NotaryCardPolicy`** | A policy card defining the fields of every notary card (`protocol-objects.md §20`) | A single schema for every operator's notary card, so adding an operator to a community needs no governance step |
| **Derived-card template policies** | One policy card per audited `derive` program (`protocol-objects.md §2.2`) | The only policies under which notaries issue derived cards |
| **`AuthorizePress(template, notary card, …)`** | The existing on-chain power (`registry_contract.md §4.7`) | Lets an operator's enclave-held chain key register and revoke derived cards under a template. Granted once per (template, operator). |

**Registration.** `NotaryCardPolicy`, the list cards' policy, and each template policy need a one-time `RegisterPolicy` by **RootPolicyBody**. The PressRegistryBody can't register policies (`mandate.md`, What PressRegistryBody Cannot Do), so it requests each one through the cross-body channel.

---

## Accepting a Runtime

Before adding a PCR0 to the accepted-runtime list, the body confirms:

- **Reproducible build.** Two independent builds of the named `source_commit`, using the pinned build recipe (`build_recipe_cid`), produce the same PCR0. At least one of the two builds is not by the runtime's authors.
- **Audit.** An independent audit of the runtime covers:
  - key custody (no export or import except by attested handoff);
  - broker/worker isolation;
  - program admission;
  - the privacy transforms;
  - zeroization;
  - the governance-list floors built into the image.
- **Pinned keys and floors.** The image's built-in list-signing keys are the current ones. Its version floors are at least the current list versions.
- **Platform.** The image targets a platform with an attestation verifier module, `aws-nitro-enclaves` in v1.
- **`close_compat`.** The body assigns the entry's `close_compat` (`protocol-objects.md §34`). The new runtime keeps its predecessor's value **only if** the audit confirms that all of these are unchanged:
  - the ABI;
  - the card-check vector set;
  - input checks B1–B11;
  - the output transforms;
  - the close computation.

  Otherwise it gets a new value. An unchanged value lets jobs move by rolling handoff. A new value means jobs either finish on the old runtime or move by a `runtime_migration` epoch.

**Retirement.** There are three paths (`notary_replication_and_recovery.md` §3, Runtime upgrades):

| Path | When | Approval | `retired_at` | Effect on keys |
|---|---|---|---|---|
| **Supersede** | A newer runtime replaces it | Standard (quorum, 14-day deliberation) | Normally 30 days after the decision; longer if the new runtime has a different `close_compat` and long votes are running | Handed on to the new runtime |
| **Expedited supersede** *(adopted 2026-11-12)* | A flaw that **didn't** expose keys or inputs, but needs fixing quickly, for example an eligibility-check bug | Quorum, with a **72-hour** minimum deliberation | At least 72 hours after the list update | Handed on to the new runtime |
| **Emergency retirement** (below) | A flaw that **could** expose keys or inputs | Any 2 of 5, ratified within 7 days | Immediate | Never handed on. Treated as exposed (algorithm E). |

The distinction matters because emergency retirement makes every key that lived in the runtime unusable. Notary cards then need new genesis, jobs re-key, and template chains re-seed. Use it only when keys or inputs may really have been exposed.

---

## Allowlisting a Program

Before adding a program to the allowlist, the body confirms:

- **Reproducible build.** The `program_cid` builds reproducibly from the named `source_commit` and `toolchain`.
- **Admission.** It passes `notary-lint` (algorithm A) with no warnings.
- **Audit.** An independent audit has checked that the program:
  - computes what its documentation says;
  - doesn't encode individual inputs into its output beyond what the declared output schema and transforms allow;
  - has no behaviour that depends on input order beyond the documented semantics.
- **Report.** The audit report is pinned (`audit_report_cid`).

Templates published with v1: **aggregate**, **vote** and **derive**.

---

## Operators

**Aggregation and vote notaries** need no action from the body. A community's policy holder issues a notary card to any operator under `NotaryCardPolicy` (`specs/process_specs/notary_lifecycle.md` Phase 0). The enclave attestation, not the operator's reputation, protects contributors.

**Derived-card operators** need `AuthorizePress` under each template they serve, because a derived card is a credential others will rely on. Before authorizing, the body confirms:
- The operator's notary card for the template verifies, including its genesis attestation (algorithm G).
- The operator has read and agreed to the obligations below.
- The template's `revocation_permissions` has been updated to name the operator's `operator_card`. The body is the template's holder, so it makes this update itself.

**Operator obligations.** These are added to `press-rules.md` as a notary section. A notary operator must:
- **Run only accepted runtimes**, and move running jobs by handoff before a runtime's `retired_at`.
- **Keep ciphertexts until close**, never filter policy snapshots, anchor every job-log record, and relay peer traffic promptly.
- **Run separate replicas.** Run replicas in separate availability zones, and never run the relay for jobs it serves (threat-model assumption T10).
- **Keep its host key and gas wallet secure,** and report a compromise of either.
- **Never try to read inputs or recover keys,** including by side channels, debug images or modified hosts.

**Revocation of operators.**
- *Derived cards:* `RevokePress(template, notary card)`.
- *Other notaries:* the body may ask policy holders to remove the operator from `approved_notaries`.

Violations follow the existing enforcement process in `mandate.md`. Evidence includes `dropped_after_acceptance`, missing anchors, and contributors' host receipts.

---

## Emergency Retirement

The body's fastest current path is a 7-day emergency deliberation (`mandate.md`, Off-Chain Governance Process). A runtime or program found to be **exploitable** must be retired faster, because wallets keep encrypting to it until it is retired.

**Rule (adopted 2026-11-12):**

1. **Who may act.** Any **2 of the 5** members may post a retirement with `retire_reason: "vulnerable"` to a list card, effective immediately, when there is credible evidence of an exploitable flaw.
2. **Ratification.** The full body deliberates within 7 days, then either ratifies the retirement or reverses it, by an ordinary update with a new `retired_at`. Either way, a public decision record is produced.
3. **Limits.** An emergency retirement can only **remove** acceptance. Adding a runtime or program always takes the standard 14-day process.
4. **Recovery.** A retired runtime is replaced by publishing a new image with a higher version floor. Wallets and peer enclaves refuse the retired runtime immediately (`notary_runtime.md §12`).
5. **Follow-up on affected cards** *(added 2026-11-12)*. Every key that lived in the retired runtime is exposed (`notary_lifecycle.md` Appendix A.6). Verifiers and wallets already reject anything those keys sign from `retired_at` on. The body also:
   - calls `RevokePress(template, notary card)` for each affected derived-card operator;
   - asks policy holders to remove affected notary cards from `approved_notaries`;
   - confirms that each template's `dup_tag` chain has been re-seeded;
   - publishes the list of affected notary cards with the decision record.

**Enforcement.** The thresholds are enforced cryptographically, not only by process. Every list version carries a `list_approval` signed by members with their governance keys (`protocol-objects.md §34`). Runtimes, wallets and verifiers check it with algorithm L (`specs/process_specs/notary_lifecycle.md` Appendix A.5):
- An `"emergency_retirement"` approval needs 2 member signatures. It is accepted only if the change is removal-only (rule E).
- Every other change needs the body's quorum (4 of 5), including ratifying by reaffirmation, reversing an emergency retirement, and adding anything.
- The list-holder key publishes updates but can't make one valid alone. It must be reachable at short notice so that an emergency retirement can be published within hours.

The exception to deliberation periods is also recorded in `mandate.md`, Off-Chain Governance Process.

**Key rotation.** When `RotateGovernanceKeys` changes the member keyset, the body:
- re-approves both lists under the new keyset version (signed in advance where possible), because readers fail closed until it does;
- publishes a runtime image that pins the new keyset;
- emergency-retires older images if a member was removed for key compromise.

---

## Accountability Model

- **List changes** are card updates. Their history is permanent in the card logs, and each change has a decision record.
- **Derived-card authorizations** are on-chain `AuthorizePress` and `RevokePress` events.
- **Operator conduct** is evidenced by public job logs and contributors' receipts.
- **The body is not trusted for confidentiality.** Its role ends at deciding which runtimes, programs and operators are acceptable. It never receives notary data. Derived cards send no issuance records (`protocol-objects.md §11` exception).
