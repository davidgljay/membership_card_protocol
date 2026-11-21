# Derived cards: how much control the source issuer has

**Status:** an open question for David, written 2026-11-21. No spec or code changes yet.

**Question.** Should the holder of a source policy (an employer, say) be able to stop, restrict or detect derived cards made from the cards it issued? The current design says no (design decision D9, 2026-11-11). This note sets out what that means technically and the options for changing it.

**Context:**
- `plans/notary-design-decisions.md` §2.1.1 (D9, who may open a derived-card job) and limit L10;
- `specs/process_specs/derived_card_revocation_propagation.md`;
- `specs/protocol-objects.md` §2.2 (template policies, `derived_card`, `revocation_propagation`).

---

## 1. Where things stand

**Anyone may open a derived-card job over any source policy** (D9: `T.notary.job_requester_predicate` is absent). The source policy's holder is not asked and has no veto. **Each derived card needs its holder's consent**: the holder's wallet shows what the card will reveal, and the holder presents their own source card.

**Example.** Meta issues employee cards under policy `M`. A union, or anyone, opens a job under a derive template `T` naming `source_policy = M`. An employee who consents gets a card that proves "holds a card under `M`", plus any projected field values, under a new key.

**What Meta can learn**

| Meta learns | How |
|---|---|
| That a job over `M` exists, and which fields it projects | Jobs and announcements are public |
| How many derived cards were issued, by batch | The job log's `issued` records carry counts |
| **Not** which employees | See below |

Why Meta can't tell which employees:
- The source card goes only into the enclave, sealed. The host reads whole-policy snapshots, so it never learns which source card was presented.
- The derived card has a new key, with no link to the source card.
- The duplicate-check tag (`dup_tag`) is keyed with the template's secret key, so it can't be computed from the public list of `M`'s cards.
- Releases are batched and shuffled. No issuance record is sent to anyone.
- `min_anonymity_set` (default 10) means a projected value is released only if at least 10 holders share it.

**Residual leaks, already in the specs:**
- **Revocation timing.** Meta revokes a card, and a derived-card revocation follows in a later batch. Batching, delay and mixing across communities blur this, but don't remove it.
- **Network address.** If the relay and the notary host are run by the same party, they learn contributors' IP addresses (T10).
- **A broken runtime** would expose sealed inputs. That is the general trust in the enclave and the governance runtime list.

**What Meta can do without knowing who**

| Action | Effect on derived cards | Cost to Meta |
|---|---|---|
| Revoke an employee's card | Under `sealed_link`: the derived card is revoked in a later batch. Under `expiry_only`: it isn't renewed after the current period. | Ordinary |
| Make field values unique | `min_anonymity_set` refuses to project those fields. Doesn't block the bare membership claim. | Low |
| Move everyone to a new policy and revoke the old cards | Derived cards name the old `source_policy`, so they stop renewing. New jobs can be opened against the new policy. | High, and visible |
| Ask governance to exclude `M` | The PressRegistryBody holds each template and could bound `source_policy` in `parameter_bounds`. | A public governance act |

**What this means in practice.** The issuer can't prevent a derived card or find out who holds one, but it can end one by ending the source card. For organizing, that is the remaining risk: a fired organizer's derived card ends with their employee card.

---

## 2. The tension

**For open derivation (D9 as decided):**
- **Holders can speak about their own membership.** "I am a Meta employee" belongs to the employee, not the employer. Union organizing, whistleblowing and collective action are the clear cases.
- **No retaliation path.** The issuer can't make derivation itself a signal, because it can't see who derived.
- **Harm is bounded.** A derived card states only the source policy CID and verbatim values. A requester can't add wording.

**Against it (the ramifications you're exploring):**
- **Communities lose control of their own credential's reach.** A third party can open a derivation of a community's cards that the community doesn't want. Examples: a marketplace for "verified X members", or projecting a field the community considers internal.
- **Sensitive memberships.** For a support group or a health community, the holder still consents to each card. But the community can't set a norm that its membership never leaves the community.
- **Brand and trust dilution.** "Verified by Meta's cards" circulates in contexts Meta never agreed to, without Meta's wording.
- **Issuer power through revocation remains.** An issuer that can't veto derivation still decides whether derived cards survive (§1). So the current design is open for creating derived cards, but issuer-controlled for keeping them.

---

## 3. Options

### A. Keep D9 as is
- **Status quo.** Anyone may derive, and the issuer's only levers are those in §1.
- **Cost:** none.

### B. Issuer veto (reverses D9)
- **How it would work:** a new protocol field on the **source** policy card, `derivation`:
  - `"allow"` (any template);
  - `"deny"`;
  - or an array of template policy CIDs allowed.
- **Who checks it:**
  - the runtime, at job open (algorithm R reads the source policy's current head) and again for each input;
  - wallets, on the consent screen.
- **Default:** this is the real decision. With default `allow`, the union case works until Meta opts out, and Meta would. With default `deny`, the union case is gone unless the issuer opts in.
- **Changing the field later:** read at the current head, like `approved_notaries`. Changing it to `deny` stops new cards and renewals. Existing cards run to expiry.
- **Effect on organizing:** removes the feature you want.
- **Cost:** a `card_protocol_spec.md §1` protocol field, algorithm R and W changes, a runtime check, a wallet check, and the update policy for the field.

### C. Field-level control; membership always derivable (my lean)
- **How it would work:** a new `derivable` flag per field in the source policy's `field_definitions` (default `true`). A job may project only fields marked derivable at the source policy's current head.
- **What stays open:** the bare claim "holds a card under `M`" (no projected fields) can't be vetoed.
- **What the issuer gains:** it can keep internal fields from leaving (employee ID, clearance level, a diagnosis), but can't stop members proving membership.
- **Effect on organizing:** keeps "is a Meta employee" derivable, while answering the "internal field" harms in §2.
- **Cost:** smaller than B. A field-definition attribute, one check at job open and per input, and a consent-screen line.
- **Note:** it doesn't address "a community doesn't want its membership to leave at all" (sensitive memberships). For those communities, the holder's consent is the only protection.

### D. Reduce the issuer's power over existing cards
Independent of A–C. Make templates whose derived cards attest "held a card under `M` as of date D" and **don't follow source revocation**:
- `revocation_propagation.mode: "expiry_only"`, and a long `nullifier_period` or no renewal.
- A fired organizer keeps proof that they were an employee.
- **Cost:** none in the protocol; it's a template choice the PressRegistryBody would audit and register.
- **Tradeoff:** relying parties have to read the date, because the card doesn't say the person is still an employee. Revocation for fraud (9xx) arguably should still propagate. That would need `propagated_codes: ["9xx"]` only, which the spec already allows.

### E. Governance discretion only
- **How it would work:** the status quo, plus a written PressRegistryBody rule for when it would bound a template's `source_policy` (for example, at a community's documented request).
- **Effect:** public and slow, with no per-issuer lever.
- **Cost:** a governance document.

---

## 4. Questions for David

1. **Direction.** Keep open derivation (A), add field-level control (C), or an issuer veto (B)?
   - My lean is **C**, with D offered as a template. Together they keep the organizing case: membership can't be vetoed, and a "former employee" credential survives firing. They also answer the internal-field harm.
   - B with default `allow` sounds balanced, but in practice any issuer worried about organizing opts out, so it works like default `deny` for exactly the cases you care about.
2. **Sensitive communities.** Should any policy be able to declare its membership non-derivable, even as a bare claim? That reopens B for a class of policies. If so, who decides the class: the issuer itself, or governance?
3. **Revocation semantics.** Should "employment ended" (8xx) propagate to derived cards at all, or only fraud (9xx)? Today the default propagates both.
4. **Disclosure to holders.** Should the consent screen say plainly that the issuer can end this card by ending the source card, and that the issuer can see that a job over its policy exists, but not who joined? The current `sealed_link` wording covers the first point. Nothing covers the second.

**What changes if you choose C or D:**
- Specs: `card_protocol_spec.md §1` (`field_definitions` attribute), `protocol-objects.md §2.2` and §34 examples, `derived_card_revocation_propagation.md` (consent lines), `notary_lifecycle.md` Appendix A.7 (algorithm R).
- Code: the derive template's job checks, the broker's per-input check, the wallet consent screen, and conformance vectors.
- Placement: as a Phase 7 item, or before 6.6 if you want the milestone review to cover it.
