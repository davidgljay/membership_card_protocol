# Phase 3, Step A — `code-contracts`

**Spec:** `specs/object_specs/registry_contract.md` (v0.6, §§3–8)
**Code:** `contracts/` — `storage-contract/src/lib.rs`, `logic-contract/src/{lib,card_ops,subcard_ops,governance_ops,dns_ops,upgrade_ops,key_scheme_ops,write_gate}.rs`, `protocol-types/src/lib.rs`, `verifier-module/src/lib.rs`

Read-only review. No spec or code file was modified. For each finding, a recommendation states which side is correct per the phase-3 instructions: "code is correct → update spec" or "code is wrong/incomplete → file as a bug" — fixes are not applied here.

---

## Overall assessment

Storage layout (§3), most write-operation preconditions/state-changes (§4), the governance quorum model (§6.2), events (§7), and error codes (§8) are implemented with unusually high fidelity to the spec — including Phase-1-vs-Phase-2/3 notes that are explicitly called out as such in code comments (e.g. `RotateGovernanceKeys` hardcoding `key_scheme = 0`, `RotateOnChainKeyScheme` always reverting E-24 in Phase 1). The DNS admin secp256r1 co-authorization path from Phase 1/2 fixes (`DnsAdminCardKeys`, `AdminAuthorizeSubCardPayload`, E-47) **is implemented**, but with a security-relevant gap (Finding 1 below). The three-signer `DeregisterSubCard` authorization model from Phase 2 is correctly treated as entirely off-chain/press-side in the contract, matching the spec.

However, this review surfaced two systemic, security-relevant gaps (Findings 1–2) and one governance-capability gap (Finding 3) that go beyond routine spec-wording drift. These are flagged prominently below per the escalation instructions.

---

## HIGH SEVERITY — flag prominently (not a routine spec-wording fix)

### Finding 1 — Signed payload content is not cross-checked against calldata on any write operation

**Where:** `contracts/logic-contract/src/write_gate.rs` (`run_write_gate`, `validate_write_gate_only`), used by every write op in `card_ops.rs`, `subcard_ops.rs`, and `dns_ops.rs` (`register_card`, `update_card_head`, `claim_open_offer`, `batch_update_card_heads`, `register_sub_card`, `deregister_sub_card`, `set_policy_address`, `remove_policy_address`).

**Spec says:** Every write operation's `*_sig_payload` is defined as a JSON document containing the operation's full set of state-changing fields (e.g. `RegisterCardPayload` includes `card_address`, `initial_log_cid`, `policy_address`, `press_address`, `sequence`, `timestamp`). §4.15 is explicit: *"The `updates` array in the signed payload must match the calldata `updates` array exactly (same order, same values). The contract verifies the signature over the payload before processing any individual item."* The implication throughout §4 is that the press's signature authenticates the specific values being written, not merely "a press with this sequence number authorized some write of this type."

**What the code does:** `run_write_gate` / `validate_write_gate_only` verify the secp256r1 signature over the raw `press_sig_payload` bytes, then extract and check only two fields from that payload via `payload_parser::find_field`: `"op"` (cross-operation replay guard) and `"sequence"` (replay-counter guard). **No other field of the signed payload — `card_address`, `policy_address`, `initial_log_cid`, `new_log_cid`, `prev_log_cid`, the `updates` array in `BatchUpdateCardHeads`, `domain`/`path`/`policy_card_address` in `SetPolicyAddress`, etc. — is ever compared against the corresponding calldata parameter that the contract actually writes.**

Concretely, in `register_card` (`card_ops.rs`), `card_address`, `initial_log_cid`, and `policy_address` are ordinary function parameters, completely independent of what is encoded inside `press_sig_payload`. The contract signs off on "this press, this sequence number, this operation type" and then blindly writes whatever calldata the caller supplied for the state-changing fields — regardless of what the press actually signed.

**Impact:** A signature+payload pair, once observable (e.g. in a mempool, or if a press's client logs/retries payloads), does not cryptographically bind the press to a specific `card_address`/CID/policy. Anyone able to submit a transaction with that payload+signature and the still-valid `next_sequence` can pair it with **arbitrary calldata** for the state-changing fields and have it accepted — e.g. front-running a pending `RegisterCard`/`UpdateCardHead`/`BatchUpdateCardHeads` transaction with the same signature but a different `card_address`/CID, consuming the legitimate press's sequence number and writing attacker-chosen content under a validly-signed, validly-sequenced transaction. This defeats the core stated purpose of the payload/signature scheme ("without on-chain signature verification, the contract would be a passive log; with it, it is an enforced authorization boundary" — spec §1).

**Recommendation:** This is a code bug relative to a clear (if implicit) spec design intent, not a spec/code disagreement — **file as a bug**, do not silently patch here. It is severe enough (front-running / write-integrity bypass on the core write gate) that it warrants review outside the routine spec-consistency fix list — recommend treating it with the rigor of a security-critical finding (dedicated code review / test coverage) before mainnet deployment, not folding it into the mechanical Phase 3 fix batch.

### Finding 2 — `AdminAuthorizeSubCardPayload` field values are checked for presence only, not for equality with calldata (E-47 gap)

**Where:** `contracts/logic-contract/src/subcard_ops.rs`, `register_sub_card`, lines ~124–136.

**Spec says (§4.3 precondition 5, and acceptance criteria):** *"`admin_secp_payload` must encode `sub_card_address` and `sub_card_doc_cid` matching the calldata values. Error: E-47."* And explicitly in §8: E-47 covers *"payload field mismatch (`sub_card_address` or `sub_card_doc_cid` inconsistent with calldata)."*

**What the code does:**
```rust
let payload_sub = payload_parser::find_field(&admin_secp_payload, b"sub_card_address");
let payload_doc = payload_parser::find_field(&admin_secp_payload, b"sub_card_doc_cid");
if payload_sub.is_none() || payload_doc.is_none() {
    return Err(errors::make_error(errors::INVALID_ADMIN_CARD_SIGNATURE));
}
```
The code checks only that the two fields are *present* in the payload — it never compares `payload_sub`/`payload_doc` against the actual `sub_card_address` (bytes32) / `sub_card_doc_cid` (bytes) calldata parameters. The code comment even acknowledges the gap and rationalizes it incorrectly: *"exact value matching is done by verifying the signature covers the same payload the press constructed — if the admin signed a different sub_card_address the sig will fail RIP-7212."* This reasoning is false: the RIP-7212 check only proves the admin signed *some* payload with *some* `sub_card_address`/`sub_card_doc_cid` value — it says nothing about whether those signed values equal the calldata's `sub_card_address`/`sub_card_doc_cid` (which is what actually gets written to `SubCardRegistrations` and, via the write gate, associated with the press's registration).

**Impact:** A press could take a validly-signed `admin_secp_payload` authorizing sub-card X (signed once, legitimately, by the DNS admin) and submit it in a `RegisterSubCard` call for a *different* `sub_card_address` Y (attacker/press-chosen), as long as `admin_secp_payload` parses as non-empty and the RIP-7212 signature verifies against the admin's key over that same payload bytes. This is the same class of bug as Finding 1, specific to the one place the spec calls out an explicit equality check by name — making it a clear, unambiguous code gap versus a documented precondition.

**Recommendation:** Code is wrong relative to an explicit, unambiguous spec precondition — **file as a bug**. Same escalation note as Finding 1: this is on the auth boundary the v0.6 amendment was specifically written to harden (compromised-press protection for DNS admin sub-card registration), so the gap materially undermines that hardening. Recommend treating as security-critical, not a routine fix-batch item.

---

## ESCALATE TO DAVID

### Finding 3 — `DeregisterPolicy` is fully implemented and callable despite spec's OQ-20 being unresolved

**Where:** `contracts/logic-contract/src/governance_ops.rs` (`deregister_policy`), wired up as a public entry point in `lib.rs` (`LogicContract::deregister_policy`); storage-side `delete_policy_authorizer_key` setter in `storage-contract/src/lib.rs`.

**Spec status:** §3.2 states *"There is no delete — once registered, a policy address remains in the table permanently, with key rotation as the replacement mechanism."* §9 Open Questions, **OQ-20 (still open, Medium priority, not struck through/resolved like the other OQs)**: *"Policy deregistration. ... This may be a desired kill-switch capability for compromised or abandoned policies, but it must be governed carefully."* The only settled part of OQ-20 is that `DisablePolicyDeletePermanently` (§4.16, implemented) gives governance the option to permanently foreclose deregistration — the question of whether deregistration itself should exist is explicitly left for a future governance charter decision.

**What the code does:** `deregister_policy` is a complete, callable, `RootPolicyBody`-quorum-gated operation that calls the storage contract's `delete_policy_authorizer_key` setter, permanently removing a policy's authorizer key (and — per the storage contract's own docs — the only storage-level protection against this is `PolicyDeleteDisabled`, which defaults to `false`). The code's own doc comments show clear awareness that this is exactly the unresolved OQ-20 capability: *"OPEN QUESTION OQ-20: Whether policy deregistration should even be supported is still under discussion. This stub exists per the implementation plan but may be disabled in production pending governance charter resolution."*

**Why this needs your judgment, not a routine fix:** This is a load-bearing governance/kill-switch capability — deregistering a policy makes every press and every card issued under it permanently non-writable — on which the spec explicitly says the design question is still open. The code has already made the "yes, support it" decision and shipped a working, callable path, ahead of (and potentially preempting) the governance charter discussion the spec says must precede that decision. Per the phase-3 escalation guidance, this isn't a case where I can default to "spec is outdated, update it" or "code is a bug, revert it" — it's a substantive product/governance decision that was made in code without a corresponding spec resolution. Recommend you decide explicitly whether to (a) formally resolve OQ-20 in the spec to match what's shipped, or (b) gate/disable `deregister_policy` in code until the governance charter question is actually settled.

---

## Other findings (routine — code or spec, not both correct)

### Finding 4 — `SetProtocolVersion` / `get_protocol_version` / `ProtocolVersionUpdated` are undocumented in the spec

**Where:** `contracts/logic-contract/src/governance_ops.rs::set_protocol_version`, `lib.rs::get_protocol_version` / `set_protocol_version`, event `ProtocolVersionUpdated`.

The code labels this "§4.17 SetProtocolVersion," but the spec's actual §4.17 is `RegisterDomain` — there is no `SetProtocolVersion` operation, `protocol_version` storage field, or `ProtocolVersionUpdated` event anywhere in `registry_contract.md`. This is a fully-implemented, `RootPolicyBody`-gated write operation plus a public getter, entirely absent from the spec's §3/§4/§5/§7.

**Recommendation:** The feature (an on-chain protocol version string presses/verifiers can query) seems reasonable and low-risk — **code is likely correct; update the spec** to document the storage field, the write operation (with a real section number, not a collision with §4.17), the read operation, and the event. Flagging here rather than assuming it's fine, since it's an addition outside the documented authorization surface and should be reviewed for whether it needs its own preconditions/error codes documented.

### Finding 5 — `BatchUpdateCardHeadsPayload.updates` field is never parsed or compared (subset of Finding 1, called out separately because the spec is explicit about it)

Already covered under Finding 1, but worth noting standalone: `batch_update_card_heads` never calls anything to parse the `updates` array out of `press_sig_payload` at all — the JSON payload parser (`protocol_types::payload_parser`) only supports scalar field extraction (`find_field`, `extract_sequence`, etc.), not array parsing. Implementing the spec's requirement ("must match the calldata `updates` array exactly") would require a real JSON array parser that doesn't currently exist in `protocol-types`. Filed as a bug (see Finding 1); noting the missing parser capability as the likely root cause / scope of the fix.

### Finding 6 — Re-registering a previously-deregistered `sub_card_address` fails with an undocumented error code

**Where:** `contracts/storage-contract/src/lib.rs::set_sub_card_entry` (the `deregistered_at` write-once-non-zero invariant) vs. `contracts/logic-contract/src/subcard_ops.rs::register_sub_card` (which only checks `sub_active`, not `deregistered_at`).

**Spec says:** E-11 `SUB_CARD_ALREADY_ACTIVE` is described as triggering on `RegisterSubCard` for "an address already registered and active" — implying (by omission) that registering a formerly-active-but-now-deregistered address is not itself an error case the spec anticipates rejecting via a documented code.

**What the code does:** `register_sub_card`'s own precondition check (`if sub_active { return SUB_CARD_ALREADY_ACTIVE }`) would *allow* re-registration attempts on a deregistered address to proceed to the storage write. But the storage contract's unconditional invariant (§3.7, correctly implemented: *"`SubCardRegistrations[addr].deregistered_at` is write-once-non-zero"*) then rejects the write with a different, storage-level error (`E_DEREGISTERED_AT_IMMUTABLE`, selector `\x7a\x1f\x2c\x99`) that **does not appear anywhere in the spec's §8 error table** and is not one of `protocol_types::ContractError`'s documented variants either.

**Recommendation:** The underlying behavior (a sub-card address can never be reused once deregistered, preserving the audit trail) looks like a reasonable, probably-intentional consequence of the §3.7 invariant — **likely code is correct; spec is incomplete.** Recommend adding this as an explicit precondition/error code in §4.3 and §8 (e.g., a new `E-48 SUB_CARD_ADDRESS_RETIRED` or similar), since right now a caller hitting this path gets an error selector with no spec-documented meaning.

### Finding 7 — Storage contract's E-35/E-36 (and internal domain-invariant) error selectors are literal placeholder bytes, not real keccak256 selectors

**Where:** `contracts/storage-contract/src/lib.rs`, constants `E_POLICY_DELETE_DISABLED = \x00\x00\x00\x01`, `E_POLICY_DELETE_ALREADY_DISABLED = \x00\x00\x00\x02`, `E_DOMAIN_EXISTS_IMMUTABLE = \x00\x00\x00\x03`, each with a `// TODO: Replace with keccak256(...) before deployment` comment.

Every other error in the storage contract and all logic-contract errors (`errors::make_error`) use a real `keccak256(name)[0..4]` selector. These three are hardcoded sequential placeholders. Functionally this doesn't cause a spec mismatch in terms of *when* the error fires, but the revert data an off-chain caller receives for these three cases is non-conformant with the rest of the ABI-selector scheme and will not match what `errors::POLICY_DELETE_DISABLED` / `errors::POLICY_DELETE_ALREADY_DISABLED` compute in `logic-contract/src/lib.rs` (which do use real keccak256 selectors for the same error names). A tool decoding reverts by selector would see two different selectors for "the same" E-35/E-36 depending on which contract emitted the revert.

**Recommendation:** Not a spec-vs-code divergence per se (the spec doesn't mandate selector encoding), but a pre-deployment implementation gap the code's own TODO already flags — **file as a bug** (implementation task, already tracked by the inline TODO; surfacing here so it isn't lost before mainnet deployment).

### Finding 8 — `protocol_types::ContractError` enum and its doc-comment table omit E-35/E-36

**Where:** `contracts/protocol-types/src/lib.rs`, the module-level doc comment table (jumps from E-34 straight to E-37) and the `ContractError` enum itself (no `PolicyDeleteDisabled` / `PolicyDeleteAlreadyDisabled` variants, unlike every other spec error code which has a corresponding variant).

Minor internal-consistency gap: the shared no_std type crate is meant to mirror all spec error codes (per its own doc comment, "§8 of registry_contract.md v0.6"), and does so for every code except E-35/E-36, which are only realized as ad hoc byte-string constants in `logic-contract/src/lib.rs::errors` and `storage-contract/src/lib.rs`. Functionally harmless today (nothing in the codebase currently matches on the `ContractError` enum for these two codes) but inconsistent with the crate's stated purpose.

**Recommendation:** Code is incomplete relative to its own documented intent — **file as a low-priority cleanup bug**, not a spec issue.

---

## Confirmed correct / no divergence found

- **§3.1 `CardEntry`** (5-field struct with `forward_to`) — storage struct and getters match exactly, including the write-once `exists` invariant and write-once-non-zero `forward_to` invariant (§3.7), both enforced in `storage-contract/src/lib.rs`.
- **§3.11 `DnsAdminCardKeys`** — table, `RegisterDomain`/`DeregisterDomain` write/clear wiring, and the `RegisterSubCard` on-chain RIP-7212 check are all present and structurally match the spec (see Finding 2 for the one gap within this feature).
- **§4.4 `DeregisterSubCard` three-signer model** — correctly implemented as entirely off-chain/press-side (the contract only takes one payload/signature pair and does not attempt to distinguish or verify which of the three signer paths was used on-chain), matching the Phase 2 decision that this is a press-verification concern, not a contract concern.
- **§6.1 Card Write Gate** steps 1–4 and 6 (policy existence, press existence/active, RIP-7212 signature, sequence check+increment) — implemented faithfully in `write_gate.rs`, including the `op`-field cross-operation-replay guard which is a reasonable code addition consistent with (and not contradicting) the spec's intent.
- **§6.2 Governance Quorum Verification** — version check, nonce-reuse check, per-signature distinct-key verification, duplicate-signer detection, and quorum threshold are all implemented exactly as specified in `write_gate.rs::verify_governance_quorum`.
- **§6.3 Three-contract upgrade model** — `UpgradeLogic` (7-day timelock) and `UpgradeVerifier` (48-hour timelock) both implement the propose/confirm/cancel lifecycle, fresh-signature-at-confirmation, and governance-version-staleness detection exactly as specified, in `upgrade_ops.rs`.
- **§4.10 note on Phase 1 `key_scheme` hardcoding** and **§4.11 `RotateOnChainKeyScheme` always reverting E-24 in Phase 1** — both intentional Phase 1 behaviors called out in the spec are implemented and self-documented in code exactly as described.
- **§7 Events** — every event in the spec has a corresponding `sol!` event definition in `lib.rs` with matching field sets (spot-checked `PolicyAddressSet`, `PolicyAddressGovernanceSet`, `DomainFraudRiskUpdated`, `DnsGovernancePolicyAddressUpdated`, `AddressTransition`, all `LogicUpgrade*`/`VerifierUpgrade*` events).
- **§8 Error codes E-01 through E-34, E-37 through E-47** — all present as named constants in `logic-contract/src/lib.rs::errors` with correct trigger conditions, cross-checked against every write operation's precondition list.
- **Verifier module (RIP-7212)** — precompile address, 160-byte input encoding, fail-safe-on-call-failure behavior, and the "false does not revert, caller reverts" contract are all implemented exactly as the spec's §1 and §6.3 describe.

---

## Summary for the consolidated fix list

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | Signed payload fields not cross-checked against calldata (all write ops) | **High — security** | File as bug; recommend dedicated security review, not routine batch fix |
| 2 | `AdminAuthorizeSubCardPayload` fields checked for presence only, not equality (E-47) | **High — security** | File as bug; same as above |
| 3 | `DeregisterPolicy` implemented despite unresolved OQ-20 | **Escalate** | David to decide: resolve OQ-20 in spec, or gate the code |
| 4 | `SetProtocolVersion` undocumented in spec | Low | Code likely fine; update spec |
| 5 | No JSON array parser to support Finding 1's batch case | Medium (scoping note) | Rolled into Finding 1's bug |
| 6 | Sub-card re-registration after deregistration hits undocumented error code | Low | Code likely fine; update spec (§4.3/§8) |
| 7 | Storage contract E-35/E-36 use placeholder (non-keccak256) selectors | Medium (pre-deploy) | File as bug (already TODO'd in code) |
| 8 | `ContractError` enum/doc table omit E-35/E-36 | Low | File as cleanup bug |
