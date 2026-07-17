# Inconsistency Log — `proc-dns` (`specs/process_specs/dns_governance_verifier.md`)

Reviewer: Step A subagent, Phase 2. Read-only review; no fixes applied.

Cross-checked against (as authoritative, Phase-1-fixed): `registry_contract.md` (esp. §3.8–3.11, §4.3, §4.17–4.24, §5, §6.2), `press.md` (esp. §5.4, HTTP endpoint table), `protocol-objects.md` §15–16 (`SubCardRegistration`/`SubCardDocument`), `ipfs_card.md`, `card_verifier.md`.

---

## Finding 1 (HIGH — the flagged gap): `dns_governance_verifier.md` is completely silent on the DNS-admin-card secp256r1 sub-card authorization mechanism

**Specs in conflict:** `dns_governance_verifier.md` (entire file) vs. `registry_contract.md` §3.11 (`DnsAdminCardKeys`), §4.3 (`RegisterSubCard`, `AdminAuthorizeSubCardPayload`, `admin_secp_payload`/`admin_secp_signature`, error `E-47`), §5 (`GetDnsAdminCardKey`); and `press.md` §5.4 (`processSubCardRegistration`/`registerSubCardOnChain`, `/sub-card/register` endpoint's `adminSecpPayload`/`adminSecpSignature` fields).

**Confirmed by direct search:** grepping `dns_governance_verifier.md` for `RegisterSubCard`, `admin_secp`, `DnsAdminCardKeys`, `AdminAuthorizeSubCardPayload`, and `GetDnsAdminCardKey` returns zero matches. The only "sub-card" references in the file are Script C's scope-violation check (fetching `sub_card_doc_cid` and testing `dns_path_scope` against `path`) — nothing about how or by whom those DNS-admin-delegated sub-cards get registered in the first place, or the on-chain secp256r1 authorization gate that now exists specifically to protect that registration path.

**Why this matters:** this file's entire purpose is DNS governance operations, and the `DnsAdminCardKeys` mechanism exists specifically to protect DNS admin cards' sub-card delegation from a compromised press (per `registry_contract.md` §4.3's security note: "A compromised press cannot register fraudulent sub-cards of a domain admin card... without possession of the admin holder's secp256r1 private key"). A DNS governance operations spec that never mentions this is a real coverage gap, not a cosmetic one — an operator reading only this file would have no idea that:
- registering a sub-path-scoped sub-card under a domain admin card requires the admin holder to also produce a secp256r1 signature (`AdminAuthorizeSubCardPayload`), separate from their ML-DSA-44 holder signature;
- the DNS admin's secp256r1 keypair (stored in `DnsAdminCardKeys`, distinct from the governance body's own quorum key and distinct from the admin's ML-DSA-44 IPFS identity key) is generated and held by the domain admin card holder, not by the DNS Governance Authority operating these scripts;
- `RegisterDomain` (Script A step 6) is the operation that writes this key into `DnsAdminCardKeys` in the first place — Script A's request already collects `secp256r1_pubkey` from the applicant (line 69), so the file is *one step away* from documenting the mechanism but never closes the loop to explain what that key is subsequently used for;
- key rotation for this secp256r1 key (per `registry_contract.md` §3.11 "Key management": "requires re-registration: the governance authority calls `DeregisterDomain` then `RegisterDomain` with the new secp256r1 key") is never described as an operational scenario distinct from full domain handoff (see Finding 3 below — this actually surfaces a deeper problem with the two-script design).

**Recommendation:** Add explicit coverage to `dns_governance_verifier.md`. Concretely:
1. In Script A's Overview/Steps, cross-reference that the `secp256r1_pubkey` collected from the applicant is written to `DnsAdminCardKeys[admin_card_address]` via `RegisterDomain` (§4.17) and is the same key later checked by `RegisterSubCard`'s on-chain RIP-7212 verification (§4.3) whenever this card acts as a master for sub-card delegation.
2. Add a subsection (new Script, or an addendum to Script A/B) documenting the *operational* flow for a domain admin delegating a sub-path-scoped sub-card: who produces `AdminAuthorizeSubCardPayload`, how it and the secp256r1 signature reach the press (per `press.md` §5.4, these arrive via the same `/sub-card/register` request as the holder's countersignature — this file's governance scripts don't submit this themselves, but should say so explicitly rather than leaving it a total blank), and what happens on an `E-47` revert.
3. In Script B, note that deactivating a domain admin card also zeroes its `DnsAdminCardKeys` entry (§4.18), which immediately disables that card's ability to authorize new sub-card registrations even before its 9xx revocation entry is posted.

---

## Finding 2 (HIGH): `dns_path_scope` is referenced by two specs but defined in neither

**Specs in conflict:** `registry_contract.md` §4.19 (press-side precondition: "the `dns_path_scope` regex in the sub-card's IPFS document matches `path`") and `dns_governance_verifier.md` Script C step 4 ("Extract the `dns_path_scope` regex from the document... Test the regex against `path`") both treat `dns_path_scope` as an established field of the `SubCardDocument`. But `protocol-objects.md` §16 — the canonical `SubCardDocument` schema (fields table, lines 818–832) — has no `dns_path_scope` field, and neither `ipfs_card.md` nor `card_verifier.md` defines it either (confirmed via grep across all three files: zero matches for `dns_path_scope`).

**Recommendation:** Add `dns_path_scope` to `protocol-objects.md` §16's `SubCardDocument` field table as an optional field (regex string; present only for sub-cards delegated under a DNS admin master card; used by press-side and DNS-governance-authority scope checks). Alternatively, if `SubCardDocument` intentionally stays DNS-agnostic, define a DNS-specific extension/wrapper object and have both `registry_contract.md` and `dns_governance_verifier.md` reference that instead of an undefined bare field on the general document.

---

## Finding 3 (MEDIUM–HIGH): Internal ordering contradiction between Script A and Script B for domain handoff

**Location:** entirely within `dns_governance_verifier.md`, but the contradiction is only resolvable by looking at `registry_contract.md` §4.17's on-chain precondition — flagging here since it affects whether the documented DNS governance process is actually executable.

Script B's Preconditions (line 135) state: *"The requester has completed TXT verification for their own key (Script A), generating their new domain admin card."* This implies Script A's full flow — including its step 6, `RegisterDomain` — has already succeeded for the new admin **before** Script B (deactivation of the old admin) runs.

But `registry_contract.md` §4.17 precondition 4 (mirrored in Script A's own step 3, HTTP 409 check) blocks `RegisterDomain` from succeeding whenever the domain **already has an active admin card** — which, at the moment the new admin is trying to complete verification, is still the *old* admin (not yet deactivated). Error `E-38` would be returned. So Script A's `RegisterDomain` call cannot actually complete before Script B has run.

This is confirmed by Script B's own closing note (line 185): *"The new admin registration (calling `RegisterDomain` with the new card) is handled separately by Script A after this operation completes."* — which directly contradicts the precondition on line 135.

**Recommendation:** Script A currently bundles two logically separable actions in one HTTP handler: (a) issuing the domain admin **card** via `RegisterCard` (step 5), which has no dependency on the domain's current registration state, and (b) calling `RegisterDomain` (step 6), which does. For the handoff flow to be executable as described, Script A needs to either split these into two callable stages (card issuance can run anytime; `RegisterDomain` can only run after Script B's `DeregisterDomain` clears the old admin), or the precondition language in Script B needs to be corrected to say only "the new admin card has been *issued*" (not "domain registered") as the precondition, with `RegisterDomain` for the new admin explicitly sequenced after Script B completes.

---

## Finding 4 (MEDIUM): Single governance private key env var doesn't match the quorum model it's meant to satisfy

**Specs in conflict:** `registry_contract.md` §3.6 (`GovernanceKeysets`) explicitly describes `DnsGovernanceBody` as bootstrapped 1-of-1 but designed to grow ("As additional governance members are invited in, the deployer calls `RotateGovernanceKeys` to expand `keys[]` and raise `quorum`... all further additions and removals require a quorum vote"). Every governance-body write operation in §4.17–4.24 accepts `governance_sigs bytes[]` — an array of potentially multiple signatures — sized to the current quorum.

`dns_governance_verifier.md`'s shared environment variables (lines 22–32) define a single `DNS_GOV_PRIVATE_KEY`, and every script step describes signing "with the governance private key" (singular) and submitting a single-element array (e.g. Script A step 6: `[governance_sig]`). There is no described mechanism for collecting, combining, or submitting signatures from multiple `DnsGovernanceBody` quorum members once the body grows past 1-of-1.

**Recommendation:** Either scope this spec explicitly to the 1-of-1 bootstrap phase (with a note that multi-key quorum submission is out of scope / a follow-up), or add a mechanism (e.g., an out-of-band signature-collection step before each script's on-chain call) for assembling `governance_sigs` from multiple operators once `DnsGovernanceBody`'s keyset expands. As written, the two specs describe incompatible operational models for the same governance body.

---

## Finding 5 (LOW): Two different contract calls used interchangeably for clearing a `PolicyAddresses` entry

**Location:** `dns_governance_verifier.md` Script C, Verification Pipeline steps 2 vs. 4/5.

Step 2 (stale policy card) calls `GovernanceSetPolicyAddress(domain, path, bytes32(0), ...)`. Steps 4 (scope violation) and 5 (brand-name impersonation) call `RemovePolicyAddress(domain, path, bytes32(0), ...)` (governance path). Per `registry_contract.md` §4.23, these are stated to be equivalent when clearing an entry ("Can clear an entry by setting `policy_card_address = bytes32(0)` (equivalent to `RemovePolicyAddress` governance path)"), so this isn't a functional bug, but the script spec should pick one canonical call for "governance clears a stale/fraudulent entry" rather than alternating between two different contract functions for what is described as the same effect — this reads as unintentional inconsistency rather than a deliberate choice.

**Recommendation:** Standardize on one operation (likely `RemovePolicyAddress`'s governance path, since it's the more semantically named operation for a full removal) across all of Script C's clearing actions, or explain why `GovernanceSetPolicyAddress` specifically is used for the stale-policy-card case.

---

## Finding 6 (LOW — naming): `suspension_expiry` vs. `suspension_expires_at`

`registry_contract.md` §3.8/§4.22 names the field/parameter `suspension_expires_at` throughout (`DomainEntry.suspension_expires_at`, `FlagDomainFraudRisk(domain, fraud_risk, suspension_expires_at, ...)`). `dns_governance_verifier.md` Script C step 5 (line 263) refers to it as `suspension_expiry` when describing the escalation call (`FlagDomainFraudRisk(domain, 2, suspension_expiry)`). Trivial drift, but worth aligning since it's a parameter name in a function call description.

---

## Non-findings (checked, consistent)

- Script A's `RegisterDomain` call (step 6) and request/payload shape align with `registry_contract.md` §4.17 (`RegisterDomainPayload`, preconditions, error E-38/E-02/E-40/E-18 acceptance criteria) once the ordering issue in Finding 3 is set aside.
- Script B's `ClearDomainEntries`/`DeregisterDomain`/9xx-revocation sequence aligns with `registry_contract.md` §4.18 and §4.21, and with `press.md`'s `UpdateCardHead`/revocation-code handling.
- Script C's `fraud_risk` levels (0/1/2) and their semantics (normal / monitored+brand-scan / suspended) match `registry_contract.md` §3.8 `DomainEntry.fraud_risk` exactly.
- Script C's admin-card and policy-card-existence checks align with `GetDomainRegistration`, `CardExists`, and `GetCardEntry` as defined in `registry_contract.md` §5.
- The `PressRegistryBody`-reporting note (DNS governance authority cannot call `RevokePress` directly) is consistent with `registry_contract.md` §3.6's governing-body table, which lists `RevokePress` under `PressRegistryBody` only.
