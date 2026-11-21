# Step 6.5a — Proposed spec text and questions for David

**Status:** proposal only. No spec, code or plan file has been changed for 6.5a. Per the plan, spec text comes to you first. Decisions behind it: `plans/notary-derived-card-issuer-control.md` (options C and D, answers of 2026-11-21).

Two things I found in the specs while drafting, which the plan did not anticipate (Q1 and Q2). Q3–Q6 are smaller choices with a recommendation each.

## Questions

| # | Question | Recommendation |
|---|---|---|
| **Q1** | The derive template requires `projected_fields` to have at least one name (`min_count: 1`, `templates/derive/policy.json`). So a **bare-membership job** (no projected fields), which 6.5a says the source issuer can never veto, cannot exist today. | Lower `min_count` to **0** in the derive template. A bare job's `projected` is `"{}"`. The anonymity-set group is then the whole policy (all holders), which only helps the min-set rule. |
| **Q2** | Derived cards last at most one period, and a period is at most 90 days (§9). So the "member as of date" card (option D) lapses within 90 days of the holder being fired. "A fired organizer keeps proof of past membership" then holds for at most 90 days, not indefinitely. | Accept the 90-day limit for v1 and say so in the template's description and the consent line. The alternative (a longer period bound, or a card with no `expires_at`) changes §1 and the verifier's expiry rule, so I would leave it for a later decision. |
| **Q3** | How often is `derivable` re-read? You said "at job open and per input". Per input means one extra `fetch` of the source policy head per input, unless cached. | Per input, **with a cache of at most 10 minutes** per source policy (the same rule as the certified-press read, 6.5 E4). A change then takes effect within 10 minutes, not at the very next input. If you want strict per-input, say so; it costs one host read per input. |
| **Q4** | A field becomes non-derivable while a card is pooled (offered or countersigned, not yet released). | Only **new inputs** are refused (renewals are inputs). Pooled and released cards are not recalled: they run to their expiry, as under option B. |
| **Q5** | Which mode does the "member as of date" template use? | `sealed_link` with `propagated_codes: ["9xx"]`, period `P90D`, renewal window `P30D`. Fraud (9xx) revokes the derived card; an 8xx (fired, surrendered) does not. (`expiry_only` would never revoke, even for fraud.) The template is a new governance-registered policy over the same `derive.wasm`, so the program hash does not change. |
| **Q6** | New error codes. | `JOB_FIELD_NOT_DERIVABLE` (W step 6b, enclave step 17) and `DERIVE_FIELD_NOT_DERIVABLE` (D5, per input). |

## Spec text, by file

Nothing below applies until you approve it. "Amended" lines follow the existing style.

### 1. `specs/card_protocol_spec.md` §1, field definition object

Add to the field-definition object and the list of type-independent options:

> `"derivable": true | false` *(optional; default `true`; added 2026-11-21, notary step 6.5a)*. Whether a notary may copy this field's value into a **derived card** (`protocol-objects.md §2.2`). Unlike the rest of a policy, which is anchored to the `policy_id` snapshot, `derivable` is read from the policy's **current head** (like `approved_notaries`), so an issuer can change it later with a `field_definitions` update (default update policy: `{ "is_issuer": true }`). It limits only what a job may *project*. It never limits the bare claim "holds a card under this policy", which no policy can prevent a holder from deriving. Cards already derived are not affected. Protocol-reserved fields cannot be projected whatever this says.

### 2. `specs/protocol-objects.md`

- **§2.2**, after the `projected` row, add: "`projected_fields` may be empty (a bare membership claim); then `projected` is `"{}"`. Every other name must be a field of the source policy that is `derivable` at the source policy's current head (`derived_card_revocation_propagation.md` §3, D5)."
- **§2.2** `parameter_bounds` / template text: `projected_fields` `min_count` is 0 (Q1).
- Header: an "Amended 2026-11-21 (6.5a)" line.

### 3. `specs/process_specs/notary_lifecycle.md`

- **A.2, new step 6b** (after step 6): "For a derived-card job (`output_action: "card"`), every name in `parameters.projected_fields` is a field of the source policy with `derivable` not `false` at the source policy's **current head**. The wallet reads the head over its own chain connection, as algorithm R does → `JOB_FIELD_NOT_DERIVABLE`. An empty `projected_fields` always passes."
- **Step 17** (enclave, job open): add the same check, "read with algorithm R step R6".
- **A.7, new step R6.** "**R6. Source policy fields** (derived-card jobs only). Fetch the head of `parameters.source_policy` as in R1–R2, and check its chain as in R3. Return each field definition's `derivable` (default `true`). The enclave reads this over vsock, so it is unverified (L4): a host can hide a change, which delays a veto but never invents one. Cached for at most 10 minutes per source policy."
- **Appendix B**, after B11 (derived-card jobs only): "**D5** `projected_fields` is derivable at the source policy's current head (R6) → `DERIVE_FIELD_NOT_DERIVABLE`." (D-checks are listed in `derived_card_revocation_propagation.md` §3.)
- **Error Paths:** add both new codes.

### 4. `specs/process_specs/derived_card_revocation_propagation.md`

- **§3 step 3 table:** new row "D5 | Every projected field is `derivable` at the source policy's current head | `DERIVE_FIELD_NOT_DERIVABLE`".
- **§3 step 1 consent** and **§8 disclosures**, two new lines:

| Mode | Line |
|---|---|
| `expiry_only`, `sealed_link` with the default propagated codes | "{source policy name} can end this card by ending your {source policy name} card. It can see that this job exists, but not who took part." |
| `sealed_link` with `propagated_codes` of 9xx only | "{source policy name} cannot end this card by ending your card (leaving, being let go). It can end it only by revoking your card for fraud or compromise. It can see that this job exists, but not who took part." |

  The existing mode lines stay. The wallet picks the first line when `propagated_codes` includes an 8xx code, the second when it names 9xx codes only.
- **§9:** note in the Period row that a card of the "member as of date" kind survives a source 8xx only until its `expires_at` (Q2).
- **Error Paths:** `DERIVE_FIELD_NOT_DERIVABLE`.
- **New §10, "Member as of date" template (option D):** "A governance-registered template whose derived card states that the holder held a card under the source policy *as of the card's `issued_at`*, and that the source issuer cannot end by ending the card for a reason other than fraud. Parameters: `revocation_propagation.mode: "sealed_link"`, `propagated_codes: ["9xx"]`, `derived_code: "range"`, `nullifier_period: "P90D"`, `renewal_window: "P30D"`; the other fields as the default template. A relying party reads `issued_at` and `expires_at`: the card shows past membership, not current membership, and lapses at `expires_at` whatever happens to the source card."

### 5. `specs/object_specs/wallet_sdk.md`

- The consent-screen section: the two lines above, chosen by `propagated_codes`. The wallet reads `derivable` for W step 6b.

## Code and tests, once the spec is approved

(Not started.)

- **Broker** (`derive.rs`, `cards_oracle.rs`, `params.rs`): R6 read and 10-minute cache; job-open check; D5 per input; `min_count` 0 and the empty projection.
- **Template:** `templates/derive/policy.json` (`min_count: 0`) and a new `templates/derive-member-as-of/policy.json`; module unchanged.
- **Wallet:** W step 6b; the two consent lines in `consent.ts`; tests for each.
- **Verifier / vectors:** a conformance vector with a `derivable: false` field definition; no verifier rule changes (cards already issued are not rechecked).
- **Tests for the Done-when list:**
  - a job projecting a non-derivable field is refused at job open and, after a head change, at the next input;
  - a bare-membership job is accepted whatever `derivable` says;
  - the "member as of date" card survives a source 801 and is revoked by a source 9xx;
  - each consent line appears under its mode;
  - all suites pass.

Estimated size: about 300 lines of Rust and TypeScript, 8 to 10 tests, and the spec edits above.
