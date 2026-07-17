# obj-contracts — Inconsistency Findings

**Unit:** `registry_contract.md` (v0.6, 2026-06-25)
**Reviewed against:** every other in-scope object spec, `protocol-objects.md` §14/§15, `card_protocol_spec.md`, `ARCHITECTURE.md` (ADR-006, ADR-011, ADR-012), and all in-scope process specs (full read where they touch on-chain writes/reads; skim + grep otherwise).

Five findings, ranked by severity. None are catastrophic, but #2 is a real functional gap that would cause on-chain reverts if implemented as currently spec'd elsewhere.

---

## 1. `protocol-objects.md` §14 `CardEntry` struct is missing the `forward_to` field (stale vs. `registry_contract.md` §3.1)

**Specs in conflict:** `specs/protocol-objects.md` §14 (lines 675–724) vs. `specs/object_specs/registry_contract.md` §3.1 (lines 97–134).

`registry_contract.md` §3.1 defines `CardEntry` with **five** fields:
```
CardEntry {
    log_head_cid       bytes
    policy_address     bytes32
    last_press_address bytes32
    forward_to         bytes32   — set by RegisterAddressForward (§4.13); immutable once set
    exists             bool
}
```

`protocol-objects.md` §14 defines `CardEntry` with only **four** fields:
```
CardEntry {
    log_head_cid       bytes
    policy_address     bytes32
    last_press_address bytes32
    exists             bool
}
```
— `forward_to` is absent entirely. The section header there even claims: "**`protocol-objects.md §14` has been updated (2026-06-14) to show the full 4-field `CardEntry` struct**" (from `registry_contract.md` §2, line 87) — but that "full" struct is no longer full now that `RegisterAddressForward`/`forward_to` (§4.13, §3.1) exists in the contract spec. `protocol-objects.md` is dated 2026-06-14, i.e. it predates whatever revision of `registry_contract.md` added `forward_to`.

This isn't just theoretical drift — `specs/object_specs/card_verifier.md` (dated 2026-06-20, lines 137–143) already carries the correct 5-field version including `forward_to`, confirming `registry_contract.md` is the authoritative/current side and `protocol-objects.md` is the one that's behind.

**Recommendation:** Update `protocol-objects.md` §14 to add the `forward_to bytes32` field (with the same one-line description used in `registry_contract.md` §3.1), and update the "has been updated (2026-06-14)" changelog note to reflect the new sync date. `registry_contract.md` should not change — it's already correct and is explicitly the authoritative side per its own §2 note.

---

## 2. `press.md`'s `RegisterSubCard` on-chain call is missing the DNS-admin-card secp256r1 parameters required by `registry_contract.md` v0.6

**Specs in conflict:** `specs/object_specs/press.md` §5.4 (lines 611–622) vs. `specs/object_specs/registry_contract.md` §4.3 (lines 589–681).

`registry_contract.md` §4.3 (current v0.6, dated 2026-06-25 — the same date as `press.md`'s own header) defines `RegisterSubCard` with **eight** parameters:
```
RegisterSubCard(
    sub_card_address, master_card_address, registration_log_head,
    sub_card_doc_cid, master_sig_payload, master_signature,
    admin_secp_payload, admin_secp_signature
)
```
Precondition 5 requires: if `DnsAdminCardKeys[master_card_address]` is non-zero (the master is a DNS admin card), `admin_secp_signature`/`admin_secp_payload` must be present and verify via RIP-7212, or the call reverts with `E-47`. If the master is *not* a DNS admin card, `admin_secp_signature` must still be explicitly supplied as `bytes[64](0)` — omitting it is also an `E-47` per the acceptance criteria ("returns E-47 if ... admin_secp_signature is non-zero" only covers one direction, but the payload/signature slots are calldata-required either way).

`press.md` §5.4 `registerSubCardOnChain` (line 620) calls:
```
RegisterSubCard(sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, master_sig_payload, master_signature)
```
— only **six** parameters. There is no mention anywhere in `press.md` of `DnsAdminCardKeys`, `admin_secp_payload`, `admin_secp_signature`, or error `E-47`. The press's `RegisterSubCard`-processing steps (§5.4, steps 1–11) never look up whether the master card is a DNS admin card, and never obtain a secp256r1 signature from the admin card holder.

This is more than a naming/field mismatch: as written, `press.md` describes no mechanism at all for the press to *obtain* the admin card holder's secp256r1 signature (that signature has to come from the domain admin card holder specifically, not the press) — so this may be a genuine process gap in `press.md`'s sub-card registration flow, not just a call-signature typo. Concretely, if a press implemented exactly what `press.md` §5.4 describes, `RegisterSubCard` calls against any DNS-admin-card master would revert with `E-47` on the registry, and calls against ordinary masters would be missing calldata slots the contract's signature expects.

**Recommendation:** Update `press.md` §5.4 to: (a) call `GetDnsAdminCardKey(master_card_address)` (or read `DnsAdminCardKeys`) before submitting; (b) if non-zero, obtain/verify the domain admin holder's `AdminAuthorizeSubCardPayload` + secp256r1 signature as an input to the sub-card registration request (this likely requires a new field somewhere upstream — e.g. in the `/sub-card/register` request body — since nothing currently carries this signature into the press); (c) pass `admin_secp_payload`/`admin_secp_signature` (explicit zero values when the master is not a DNS admin card) in the `RegisterSubCard` call; (d) add `E-47` to the press's error-handling table alongside `P-16` etc. Flag this to Step B as possibly needing more than a mechanical fix — the "where does the admin's secp256r1 signature come from in the press's intake flow" question may need a small design decision, not just a spec edit.

---

## 3. `open_offer_creation.md` cites the superseded name `RegistryEntry` for `protocol-objects.md` §14

**Specs in conflict:** `specs/process_specs/open_offer_creation.md` (line 146) vs. `specs/protocol-objects.md` §14 (current section title: "CardEntry (on-chain)").

`open_offer_creation.md`'s "Related specs" footer reads:
> - `protocol-objects.md §14` — `RegistryEntry` (open offer counter) object reference

But `protocol-objects.md` §14 was renamed to "CardEntry (on-chain)" per `registry_contract.md` §2's own note: "This spec extends and supersedes the `RegistryEntry` description in `protocol-objects.md §14`... `protocol-objects.md §14` has been updated (2026-06-14) to show the full 4-field `CardEntry` struct." `RegistryEntry` is stale terminology that no longer appears as a section name anywhere except in this one citation.

**Recommendation:** Low severity, cosmetic. Update the citation in `open_offer_creation.md` to read "`CardEntry` (on-chain)" instead of "`RegistryEntry`".

---

## 4. `card_verifier.md`'s `PressAuthEntry` read-side interface omits fields present in `registry_contract.md`'s `PressAuthEntry` struct

**Specs in conflict:** `specs/object_specs/card_verifier.md` (lines 145–151) vs. `specs/object_specs/registry_contract.md` §3.3 (lines 163–202) and §5 (`GetPressAuthorization`).

`registry_contract.md` §3.3 defines `PressAuthEntry` with seven fields: `press_public_key`, `mldsa44_key_hash`, `key_scheme`, `active`, `next_sequence`, `authorized_at`, `revoked_at`. §5 states `GetPressAuthorization(...)` returns the full `PressAuthEntry` struct.

`card_verifier.md`'s same-named `PressAuthEntry` interface (used as the return type of its own `getPressAuthorization`, line 101) only declares five fields — `press_public_key`, `mldsa44_key_hash`, `active`, `authorized_at`, `revoked_at` — omitting `key_scheme` and `next_sequence`.

This is plausibly intentional (a runtime verifier has no obvious use for `next_sequence`, a write-replay-prevention counter, and `key_scheme` only matters once the Phase 2/3 ML-DSA-44 on-chain upgrade is live), but as written it's a same-named-type field mismatch between two specs describing the same on-chain read operation, which could confuse an implementer about what the RPC actually returns.

**Recommendation:** Either (a) have `card_verifier.md` note explicitly that its `PressAuthEntry` TypeScript interface is a client-side projection of a subset of the on-chain struct's fields (and ideally rename it, e.g. `PressAuthEntryView`, to avoid implying full parity with `registry_contract.md`'s type of the same name), or (b) add the two missing fields if the verifier SDK is expected to expose `key_scheme` (useful context: whether a press's writes are already using the post-upgrade signature scheme).

---

## 5. Minor: casing inconsistency for `OpenOfferUseCounts` between specs

**Specs in conflict:** `specs/process_specs/open_offer_creation.md` (lines 86, 112, 120) vs. `specs/object_specs/registry_contract.md` §3.5.

`registry_contract.md` names the on-chain mapping `OpenOfferUseCounts` (PascalCase, matching its other storage-table naming convention). `open_offer_creation.md` refers to the same table/counter as `openOfferUseCounts` (camelCase) in three places.

**Recommendation:** Cosmetic only — low priority. Align `open_offer_creation.md`'s prose to the PascalCase `OpenOfferUseCounts` used by `registry_contract.md`, or note if camelCase is an intentional stylistic choice for describing conceptual/JS-side naming vs. the literal Solidity/Stylus identifier.

---

## Areas checked with no inconsistency found

- `protocol-objects.md` §15 (`SubCardRegistration`) matches `registry_contract.md` §3.4/§4.3/§4.4 field-for-field (including the note that the app card address lives off-chain in the `SubCardDocument`, not on-chain).
- `press.md`'s `RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer`, `BatchUpdateCardHeads` on-chain call signatures (lines 409, 477, 553, 739) all match `registry_contract.md` §4.1, §4.2, §4.5, §4.15 exactly.
- `ARCHITECTURE.md` ADR-006, ADR-011, ADR-012 are consistent with `registry_contract.md`'s address derivation, `PressAuthorizations`/`PolicyAuthorizerKeys` write-gate model, and the secp256r1-now/ML-DSA-44-upgrade-path story.
- `dns_governance_verifier.md` (process spec) matches `registry_contract.md` §4.17–§4.24 call signatures, error codes (E-37, E-38, E-39, E-40, E-43), and the `forward_to`/`DnsAdminCardKeys` model — this process spec is up to date even where `protocol-objects.md` is not (finding #1).
- `card_validation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`, `card_offering_and_acceptance.md`, `matrix_join_attestation_and_revocation.md`, `matrix_synapse_module.md`, `notification_relay.md`, `message_routing.md`, `card_protocol_spec.md` — all references to `PressAuthorizations`, `SubCardEntry.active`, `CardEntry`, error codes, and event names (`CardHeadUpdated`, etc.) are consistent with `registry_contract.md`'s current authorization model, error-code table, and events section (§6, §7, §8).
- `ipfs_card.md` (drafted in Phase 0) explicitly defers to `registry_contract.md` for `CardEntry` schema and correctly describes the `log_head_cid`/`policy_address`/`last_press_address`/`exists`/`forward_to` relationship; no contradiction found (it also proactively flags the `forward_to`-vs-`successor` sync question as a `key_rotation.md` concern rather than a `registry_contract.md` one).
- No stale references to `client_sdk.md` were found as authoritative anywhere in specs touching the registry contract; `client_sdk.md`'s own mentions of `RegisterSubCardFn` are correctly marked as stub/injected-dependency placeholders, not claims about the registry contract itself.
- Governance body enum ordering (`RootPolicyBody`, `PressRegistryBody`, `DnsGovernanceBody`) is consistent between `registry_contract.md` §3.6 and the `GovernanceKeysRotated` event's `body_id` numbering (§7).
