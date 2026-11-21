# Notary step 6.4b — governance payload binding: inventory, draft payloads, questions

Step 6.4b items 1 (inventory) and 2 (spec), brought to David before any code, as the plan requires. CP7 is approved for the local devnode only (David, 2026-11-20). Nothing in `contracts/` has changed yet.

---

## 1. Inventory

`verify_governance_quorum` (`write_gate.rs`) is called by 22 operations. `RotateOnChainKeyScheme` is press-signed, not quorum-gated, and is out of scope.

| Operation | Body | Calldata (action parameters) | Spec payload | Builders today |
|---|---|---|---|---|
| `RegisterPolicy` §4.6 | Root | `policy_address`, `authorizer_pubkey` | defined | Rust builder (`op`, version, nonce only); Foundry tests |
| `DeregisterPolicy` | Root | `policy_address` | **no section at all** (§9 OQ-20 only) | Rust builder (no fields) |
| `AuthorizePress` §4.7 | PressRegistry | `policy_address`, `press_address`, `press_pubkey`, `mldsa44_key_hash` | defined | Rust builder (hex, wrong names `policy`/`press`, no `mldsa44_key_hash`, zero defaults); `governanceBootstrap.ts` |
| `RevokePress` §4.8 | PressRegistry | `policy_address`, `press_address` | **missing** | Rust builder (hex, `policy`/`press`) |
| `RotateAuthorizerKey` §4.9 | Root | `policy_address`, `new_authorizer_key` | defined | Rust builder (hex, `policy`/`new_key`) |
| `RotateGovernanceKeys` §4.10 | the body rotated | `body_id`, `new_keys_flat`, `new_key_count`, `new_quorum` | **missing** (and the §4.10 signature shows `new_keys` as an array, while the contract takes flat bytes plus a count) | Rust builder (`body`, `keys` hex, `key_count`, `quorum`) |
| `SetProtocolVersion` §4.25 | Root | `new_version` | **missing** | Foundry tests only |
| `DisablePolicyDeletePermanently` §4.16 | Root | none | **missing** | Rust builder |
| `ProposeLogicUpgrade` §4.14 | Root | `new_logic_address` | defined | Rust builder (`address`, hex) |
| `ConfirmLogicUpgrade` §4.14 | Root | `proposed_logic_address` | defined | none (only Foundry tests) |
| `CancelLogicUpgrade` §4.14 | Root | none | **missing** | Rust builder (`address`, hex) |
| `ProposeVerifierUpgrade` | Root | `new_verifier_address` | **no section** (§6.3 names "UpgradeVerifier" only) | Rust builder (`address`, hex) |
| `ConfirmVerifierUpgrade` | Root | `proposed_verifier_address` | **no section** | none |
| `CancelVerifierUpgrade` | Root | none | **no section** | Rust builder |
| `RegisterDomain` §4.17 | DNS | `domain`, `admin_card_address`, `admin_secp256r1_key` | defined | `registry.ts` (spec format); Rust builder (hex); `test_dns.sh` |
| `DeregisterDomain` §4.18 | DNS | `domain` | defined | `registry.ts` |
| `RemovePolicyAddress` path B §4.20 | DNS | `domain`, `path` (`card_address` must be zero) | **missing** (path A only) | `registry.ts` (`domain`, `path`); `test_dns.sh` |
| `ClearDomainEntries` §4.21 | DNS | `domain`, `paths[]` | defined | `registry.ts` |
| `FlagDomainFraudRisk` §4.22 | DNS | `domain`, `fraud_risk`, `suspension_expires_at` | defined | `registry.ts` (escalation payload, not submitted) |
| `GovernanceSetPolicyAddress` §4.23 | DNS | `domain`, `path`, `policy_card_address` | defined | `registry.ts` |
| `SetDnsGovernancePolicyAddress` §4.24 | DNS | `new_policy_address` | defined | Rust builder via `setup_dns.sh`; `registry.ts` escalation |

**Other callers to update:**
- The shell scripts that call the Rust builder: `authorize_dev_press.sh`, `register_dev_policy.sh`, `rotate_governance_body.sh`, `setup_dns.sh`, `test_dns.sh`, `setup_dev.sh`, `test_02_create_policy.sh`, `test_03_create_card.sh`.
- `integration_tests/fixtures/src/governanceBootstrap.ts`. Its header says the contract never cross-checks payload fields; that stops being true.
- `dev-tests/support/governance.ts`, which runs against Sepolia. Like the 6.4a `dev-tests` change, it is left until the W8 deploy.
- The Foundry tests `GovernanceOps.t.sol`, `UpgradeOps.t.sol` and `ProtocolVersion.t.sol`, which sign placeholder payloads.

**One related observation.** With no `op` check, a payload signed for one body is valid for every operation of that body. The keysets are separate, so it doesn't cross bodies, but nothing in the payload names the body. Binding `op` names the body, since each operation belongs to exactly one body, with one exception: `RotateGovernanceKeys`, whose payload must carry `body_id` (Q3).

---

## 2. Proposed §6.2 step (for David's review)

Add a new step 0 to §6.2, before the version check:

```
0. Confirm the payload binds the call (amended 2026-11-2x, notary step 6.4b, for David's review):
   - payload "op" equals the operation's name (the "op" values below);
   - every action-parameter field in the operation's payload equals the calldata,
     using the 6.4a encoding (§6.1 step 8): bytes32, EVM addresses, keys and CIDs as
     unpadded base64url; integers as JSON numbers; domain and path as JSON strings
     compared byte for byte; arrays element by element, same length and order;
   - a field the operation's payload defines must be present.
   Fields outside the operation's definition (timestamp, and governance_version and nonce,
   checked by steps 1–2) are not compared.
   → Error: PAYLOAD_CALLDATA_MISMATCH (E-49), or a new code (Q1)
```

The parser is the one 6.4a hardened (W2): top-level members only, duplicate keys refused.

---

## 3. Draft payloads for the operations that have none

All of them carry `governance_version`, `nonce` and `timestamp` exactly as the defined payloads do. Only the other fields are shown.

| Operation | `op` | Action fields |
|---|---|---|
| `DeregisterPolicy` (new §4.6a) | `deregister_policy` | `policy_address` |
| `RevokePress` §4.8 | `revoke_press` | `policy_address`, `press_address` |
| `RotateGovernanceKeys` §4.10 | `rotate_governance_keys` | `body_id` (number), `new_keys` (array of base64url, 64 bytes each; compared with `new_keys_flat` split into `new_key_count` keys), `new_quorum` (number) |
| `SetProtocolVersion` §4.25 | `set_protocol_version` | `new_version` (string, byte for byte) |
| `DisablePolicyDeletePermanently` §4.16 | `disable_policy_delete_permanently` | none (the `op` is the binding) |
| `CancelLogicUpgrade` §4.14 | `cancel_logic_upgrade` | `proposed_logic_address`, which must equal the pending proposal (Q2) |
| `ProposeVerifierUpgrade` (new §4.14a) | `propose_verifier_upgrade` | `new_verifier_address` |
| `ConfirmVerifierUpgrade` (new §4.14a) | `confirm_verifier_upgrade` | `proposed_verifier_address` |
| `CancelVerifierUpgrade` (new §4.14a) | `cancel_verifier_upgrade` | `proposed_verifier_address`, which must equal the pending proposal (Q2) |
| `RemovePolicyAddress` path B §4.20 | `governance_remove_policy_address` (Q6) | `domain`, `path` |

New §4.14a documents the verifier upgrade as built: one pending proposal at a time, a 48-hour timelock, the same governance-version staleness rule as the logic upgrade, and the same errors.

**Spec signature fix.** The §4.10 signature becomes `new_keys_flat bytes, new_key_count uint8, new_quorum uint8`, matching the deployed ABI. Changing the ABI is out of scope.

---

## 4. W4: `ClaimOpenOffer` limits (included by David, 2026-11-20)

The press signs `max_acceptances` and `expires_at`, and step 8 binds them.

**Encoding problem.** The unconstrained value of `max_acceptances` is `type(uint64).max` = 18446744073709551615. The press is TypeScript, and a JSON number that large loses precision in JavaScript, so the press can't write it exactly as a number. See Q4.

---

## Questions for David

- **Q1. Error code.** Should governance mismatches reuse E-49 `PAYLOAD_CALLDATA_MISMATCH`, or get a new E-50 `GOVERNANCE_PAYLOAD_MISMATCH`?
  - *Recommend E-49*, with its description widened to "a signed payload". The meaning is the same, and one code is simpler for every client.
  - A separate code would only tell an operator which gate refused, and they already know that from the operation they called.

- **Q2. Bind cancellations to the pending proposal?** Cancel takes no calldata, so a quorum-signed cancel payload that isn't submitted stays valid. It would cancel whatever proposal is pending when it's finally used, including a later one.
  - *Recommend* adding `proposed_logic_address` / `proposed_verifier_address` to the cancel payloads and requiring them to equal the pending address.
  - Tradeoff: signers must name the proposal they're cancelling. They know it, since it's on chain.

- **Q3. `RotateGovernanceKeys` payload.** It would carry `body_id`, `new_keys` as an array and `new_quorum`, as drafted above.
  - *Recommend* yes, and not adding `key_scheme`: the contract hardcodes 0 today (§4.10 Phase 1 note), and Phase 2 will define the field.

- **Q4. W4 unconstrained values.** How should the press sign "no limit"?
  - **(a)** Sign `null` for an unconstrained `max_acceptances` and `expires_at`, as `OpenCardOffer` itself does. The contract accepts `null` only when the calldata holds the sentinel (`type(uint64).max` or 0), and otherwise requires a number equal to the calldata. Any number above 2^53−1 is refused. *Recommended:* the payload says what the offer says, and no number is ever unsafe in JavaScript.
  - **(b)** Sign decimal strings for both fields. That works but breaks the "integers are JSON numbers" rule.
  - **(c)** Sign numbers and cap `max_acceptances` at 2^53−1, using 2^53−1 as the sentinel. That changes the calldata meaning, so I'd avoid it.

- **Q5. `timestamp`.** Should it stay signed but unchecked? It is informational today, and the nonce does the replay work. *Recommend* leaving it as is. Checking freshness on chain would make slow multi-party signing fail.

- **Q6. Name of `RemovePolicyAddress` path B's `op`.**
  - Path A (press) uses `remove_policy_address`.
  - `registry.ts` uses the same name for path B today, so path A and path B payloads differ only in their fields and signer.
  - *Recommend* `governance_remove_policy_address` for path B, matching `governance_set_policy_address`. Distinct names keep one signed payload from ever satisfying both checks.
  - The cost is a change to `registry.ts`, which changes anyway.

- **Q7. Signatures already collected.** Are there governance payloads on Sepolia or mainnet that are signed but not yet submitted?
  - After the upgrade they'd be refused if they don't match the new format. That covers every builder except `registry.ts`'s DNS ones, which already write the spec format.
  - If any exist, submit them before the upgrade or re-sign them after.

- **Q8. The upgrade proposal itself (note for W8).** The mainnet `ProposeLogicUpgrade` that installs 6.4b runs under the old, unbound logic.
  - Anyone who intercepts that signed proposal could submit it pointing at their own contract.
  - The 7-day timelock and the `LogicUpgradeProposed` event make that visible, and `CancelLogicUpgrade` can stop it.
  - So W8 should include checking that the pending address equals the audited build before confirming. No decision is needed now unless you want a different procedure.

**Next, once these are answered:** I'll write the amendments into `registry_contract.md` (marked as decided), then build items 3–6 and the tests on the devnode. Item 7, the Sepolia and mainnet scan, still needs your go-ahead to read those chains.

---

## Answers

- **2026-11-20, David:** **Q1–Q6** approved as recommended:
  - E-49 is reused, with its description widened.
  - Cancel payloads name the pending proposal.
  - `RotateGovernanceKeys` carries `body_id`, `new_keys` and `new_quorum`, with no `key_scheme`.
  - W4 signs `null` for an unconstrained value.
  - `timestamp` stays unchecked.
  - Path B of `RemovePolicyAddress` uses `governance_remove_policy_address`.
- **2026-11-20, David:** **Q7**: there are no signed but unsubmitted governance payloads.
- **2026-11-20, David:** **Q8**: accepted. W8 checks that the pending address equals the audited build before confirming.

---

## Build results (2026-11-20; items 1–6, devnode only)

**Built**
- **Spec.** The amendments are in `registry_contract.md`, marked as decided by David:
  - §4.5 W4, §4.6a `DeregisterPolicy`, §4.8, §4.10 (signature plus payload), §4.14 cancel, §4.14a `UpgradeVerifier`, §4.16, §4.20 path B, §4.25;
  - §6.2 step 0, §6.1 step 8 `ClaimOpenOffer`, and E-49.
  - `press.md` §5 covers the W4 `null` rule.
- **Contract.**
  - `protocol_types::calldata_binding` has one `gov_*` function per quorum-gated operation (21; path A of `RemovePolicyAddress` is 6.4a's), plus `claim_open_offer_with_limits` and `dns_path_chars_ok`.
  - The logic contract calls `require_bound(bind::gov_*(…))` before `verify_governance_quorum` in all 22 call sites. The cancels compare against the pending address.
  - The path rule runs in `SetPolicyAddress` and in a non-clearing `GovernanceSetPolicyAddress`.
  - The WASM is 245,329 bytes (238,950 after 6.4a). The devnode deploys it.
- **Builders.**
  - `build_governance_payload.rs` is rewritten. It requires every action field, has no zero defaults, converts hex to base64url and refuses strings that would need escapes.
  - Updated callers: the 8 shell scripts, `governanceBootstrap.ts`, `registry.ts` (path B op), and the integration `dns_governance_verifier` suite.
  - The dev-tests Sepolia helpers also moved to the new builder flags, because its CLI changed. Their payloads stay valid under the current Sepolia contract, which doesn't check fields.
- **Press (W4).** The press signs `max_acceptances` and `expires_at`, writing `null` for "no limit", and refuses a limit above 2^53−1.

**Tests**
- **`protocol-types` (Rust): 17 tests pass**, 10 existing and 7 new in `tests/governance_binding.rs`.
  - Every operation is covered: the spec payload is accepted, and a wrong `op`, another operation's `op`, and each field changed, missing or duplicated are refused.
  - W4 limits, number forms, the key split, the path list, and the path rule are also covered.
  - **Negative controls:** I disabled the `op` check, one field check, the key-count check, the path comparison, and both halves of the null/number rule, one at a time. Each made a test fail.
  - The first run of two controls passed, which exposed missing cases (a shorter key list, a changed path element). I added those cases, and the controls now fail as they should.
- **Devnode: new suite `core/governance_payload_binding.spec.ts`, 5 of 5 pass.**
  - Swapped calldata reverts with E-49 for `AuthorizePress`, `RevokePress`, `RotateGovernanceKeys`, `ProposeLogicUpgrade`, `GovernanceSetPolicyAddress` and `ClaimOpenOffer`, and the signed calls go through.
  - A path containing `"`, `\` or a newline is refused with E-43.
  - The first run happened to deploy the pre-6.4b logic (see the report on the `deploy-contracts` image below). Against it, every refusal assertion failed, which serves as a negative control on the devnode.
- **All integration suites pass on the devnode:** 26 files, 226 tests plus this suite's 5, after rebuilding the `deploy-contracts` image. Press unit tests: 203 pass. Foundry: 158 pass, 3 skipped. Those tests run against Solidity mocks, which don't model step 0.

**One consequence for removal (Done-when wording).**
- Removal doesn't apply the path rule.
- But step 0 and step 8 compare `path` byte for byte without escapes, so a path that contains an escaped character can't be bound at all. The devnode suite shows such a clear is refused with E-49.
- So an entry with such a path can't be removed after the upgrade. That is the case item 7 handles: find such entries and remove them before W8.

**Not done:** item 7, the read-only scan of Sepolia and mainnet `PolicyAddressSet` and `PolicyAddressGovernanceSet` events. It needs your go-ahead to read those chains. Until the scan result is recorded here, 6.4b's Done-when isn't met, so the step isn't ticked.

**Reports (not part of 6.4b)**
- **`run.sh` doesn't rebuild the `deploy-contracts` image**, which copies `contracts/` at build time. After a contract change, a run silently deploys the previous logic. I ran `docker compose build deploy-contracts` by hand. A `--build` for that one service in `run.sh` would prevent this.
- **`contracts/scripts/test_03_create_card.sh`** still signed an op-and-sequence-only `register_card` payload, which 6.4a's step 8 refuses. I fixed it here, since it's the same script family.
- **`registry_write_gate.spec.ts` (6.4a)** failed the suites' strict typecheck step. I fixed its types.

---

## Item 7: pre-upgrade scan (2026-11-21, read-only, approved by David)

**Method**
- **Read only.** I made `cast` reads against the public RPCs in `contracts/deployments/{sepolia,mainnet}.json`. No transactions were sent.
- **Wiring checked first.** On each chain the storage contract's `getLogicContract()` equals the logic contract in the deployment record, and the logic contract points back at that storage. That logic contract is therefore the only emitter of the events below.
- **Events read.** `PolicyAddressSet`, `PolicyAddressGovernanceSet` and `DomainRegistered`, from the logic contract's deployment block to the latest block, in 10M-block chunks (the RPCs' limit).
- **Check applied.** Every `path` (and every registered `domain`) was checked for `"`, `\` or 0x00–0x1F.

| Chain | Logic contract | Blocks | `PolicyAddressSet` | `PolicyAddressGovernanceSet` | `DomainRegistered` | Breaking the rule |
|---|---|---|---|---|---|---|
| Arbitrum Sepolia | `0xb3a55cbc…6c6b05` | 295,927,992 – 331,423,318 | 27 | 0 | 28 | **none** |
| Arbitrum One (mainnet) | `0x91fe18c3…34b325` | 496,670,298 – 526,293,740 | 0 | 0 | 0 | **none** |

**Sepolia contents.** All 27 Sepolia entries are the path `staff/reporter` under `dns-gov-test-<timestamp>.example` domains, written by the dev-tests DNS suite.

**Result.** No live or historical entry, and no registered domain, contains a character the path rule forbids. No removal is needed before the W8 upgrade.

**Scope.** The superseded Sepolia deployments (`sepolia-2026-06-28/07-20-superseded.json`) use other storage contracts, which the current logic doesn't write. They weren't scanned.

**Rerun before W8.** Domains and paths written between this scan and the W8 upgrade aren't covered, so the scan should be rerun immediately before proposing the upgrade.
