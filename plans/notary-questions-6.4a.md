# Digital Notaries — Step 6.4a (Registry Write-Gate Calldata Binding): Decisions and Questions for David

**Date:** 2026-11-15 · **Branch:** `notary` · Approval: CP7 for the local devnode only (2026-11-15) · Spec: `registry_contract.md §6.1` step 8 · Decision: D5 in [notary-design-decisions.md](notary-design-decisions.md)

The change is under `contracts/`. It has been built and deployed only to the local `nitro-devnode` in the integration stack. Nothing went to Sepolia or mainnet. Items marked **[security]** change what a submitter can do with a signature it relays. Reply "OK to all" or answer by number.

| # | Topic | Kind |
|---|---|---|
| W1 | Governance-quorum operations don't bind their payloads to calldata | **[security]** report, mainnet |
| W2 | The payload parser now reads top-level members only | **[security]** done |
| W3 | `AdminAuthorizeSubCardPayload` (E-47) now checks equality and `op` | **[security]** done |
| W4 | `ClaimOpenOffer`: `max_acceptances` and `expires_at` are unsigned | **[security]** spec gap |
| W5 | `RemovePolicyAddress` press path: payload fields chosen | spec |
| W6 | DNS `domain` and `path` must be written without escapes | interface |
| W7 | Callers updated, and one left alone | report |
| W8 | Deploying beyond the devnode | CP7 |
| W9 | Observations outside 6.4a | report |

---

### What was built

- **`protocol_types::calldata_binding`** — one pure function per operation. Each returns true only if every operation-specific field is present once at the top level of the signed payload and equals the calldata:
  - `register_card`, `update_card_head`, `claim_open_offer` (adds `offer_id`), `batch_update_card_heads` (same length, same order, every field), `register_sub_card`, `deregister_sub_card`, `register_address_forward`, `set_policy_address`, `remove_policy_address`.
  - `bytes32` values and CIDs are compared by encoding the calldata as unpadded base64url, so exactly one string matches each value.
- **Logic contract.** Each operation calls `write_gate::require_bound(...)` right after the signature, `op` and sequence checks, and reverts with `PayloadCalldataMismatch()` (E-49). A revert rolls back the sequence increment, so a refused submission consumes nothing.
- **Tests.**
  - `contracts/protocol-types`: 10 Rust unit tests, covering every operation, one changed field at a time, batch reorder/shorten/lengthen, the base64url encoder for lengths 0–69, and the parser cases in W2.
  - `integration_tests/suites/core/registry_write_gate.spec.ts`: against the devnode. A valid signature with altered calldata reverts with E-49, and the same signature with the signed calldata succeeds. It covers `RegisterCard`, `UpdateCardHead` (a junk head and a rollback), and `BatchUpdateCardHeads` (reordered, shorter, one item changed). It also checks that an `op`-and-`sequence`-only payload, which the old gate accepted, is now refused.

---

### W1. Governance-quorum operations don't bind their payloads to calldata **[security]**

- **Finding.** `write_gate.rs::verify_governance_quorum` (§6.2) checks `governance_version`, the nonce, and the quorum signatures. It does not check `op`, and it does not compare any payload field with the calldata. This applies to every quorum-gated call: `RegisterPolicy`, `AuthorizePress`, `RevokePress`, `RotateAuthorizerKey`, the logic-upgrade proposals and confirmations, and the DNS governance operations.
- **Effect.** Anyone who obtains a quorum-signed payload before it is used can submit it with different calldata, and the contract accepts it once. That includes another operation (no `op` check) and other arguments: an `AuthorizePress` for a press key the signers never approved, or a logic-upgrade proposal pointing at a different contract. Sources include a co-signer, whoever collects the signatures, or a transaction seen before inclusion. The nonce limits it to one use per payload, which is the same shape as the gap step 8 closes for presses.
- **Why it isn't fixed here.** It is outside 6.4a (§6.1 is the press gate) and touches the governance payload formats, which aren't consistent today: `contracts/scripts/build_governance_payload.rs` writes hex addresses and fills missing fields with zeros, while `governance/scripts/registry.ts` writes base64url. The deployed mainnet logic contract has this gap. CP10 says to report rather than fix.
- **Planned as step 6.4b** in `plans/notary-implementation-plan.md` (David, 2026-11-15). It needs its own CP7 approval.
- **Recommendation.** Make it its own step with its own CP7 approval:
  1. Settle one payload format per governance operation in §4.6–4.10 and §4.16–4.24, and update both script families.
  2. Add `op` and field-equality checks to §6.2 the same way as step 8.
  3. Ship it with the step 8 upgrade, so mainnet takes one logic-contract upgrade, not two.

  Until then, treat collected governance signatures as secrets until they are on chain.

### W2. The payload parser now reads top-level members only **[security]**

- **Finding.** `payload_parser::find_field` used to return the first `"name":` anywhere in the bytes. A string value containing escaped key-shaped text could therefore shadow a later field. For example, a DNS `path` of `",\"policy_card_address\":\"X` would make the parser read `X` as the policy card address. With step 8 comparing fields, that would have let caller-chosen content satisfy the check with a different value.
- **Done.** The parser walks the object properly. It skips strings with their escapes and nested objects and arrays. It refuses duplicate keys, trailing bytes and non-objects. `op` must be a string and `sequence` must be a number. Whitespace between tokens is still tolerated, as before. This applies to every payload the contract reads, governance ones included.
- **Recommendation.** Keep it. Noted in §6.1 as an amendment.

### W3. `AdminAuthorizeSubCardPayload` (E-47) now checks equality and `op` **[security]**

- **Spec.** §4.3 says `sub_card_address` and `sub_card_doc_cid` "must match the corresponding calldata parameters exactly".
- **Before.** The code checked only that the two fields were present. Its comment assumed the signature would fail for a different sub-card, but the signature is over the payload, not the calldata. It also didn't check `op`.
- **Done.** It now requires `op == "admin_authorize_sub_card"` and checks that `sub_card_address`, `master_card_address` and `sub_card_doc_cid` equal the calldata. A failure is still E-47. `master_card_address` is in the spec's payload, so checking it refuses nothing a correct caller sends.

### W4. `ClaimOpenOffer`: `max_acceptances` and `expires_at` are unsigned **[security]**

- **Gap.** Both are calldata parameters, and the contract enforces them, but the press payload doesn't carry them. So the submitter can pass `max_acceptances = 2^64-1` and `expires_at = 0` and claim past an offer's limits. Step 8 binds `offer_id` (it names the counter written), the card, the CID, the policy and the press, but there is nothing to bind these two to.
- **Recommendation.** Add `max_acceptances` and `expires_at` to the `ClaimOpenOffer` payload, signed by the press (`press/src/chain/registry.ts`), and bind them. This changes the press and the payload, so it is not in this step. The notary does not use open offers in v1.

### W5. `RemovePolicyAddress` press path: payload fields chosen

- **Gap.** §4.20 path A says the press signs `press_sig_payload`, but the spec defines no payload for it, and nothing in the repository builds one.
- **Done.** It binds `domain`, `path`, `card_address` and `press_address` (the fields that name what is written), with `op = "remove_policy_address"`. Added to §4.20 as an amendment for your review.

### W6. DNS `domain` and `path` must be written without escapes

- They are plain JSON strings, compared byte for byte with the calldata. A value that RFC 8785 would escape (a quote, a backslash or a control character) is refused with E-49, rather than decoded on chain. `validate_domain` already restricts domains. A path with those characters can't be set through the press path. Is that acceptable? The alternative is an on-chain unescaper.

### W7. Callers updated, and one left alone

- `integration_tests/suites/extended/dns_governance_verifier.spec.ts` signed a `set_policy_address` payload with only `op`, `domain`, `path`, `sequence` and `timestamp`. It now signs the §4.19 payload.
- `contracts/scripts/test_dns.sh` (the manual Sepolia script) wrote hex addresses. It now writes base64url.
- `dev-tests/suites/extended/dns_governance_verifier.spec.ts` runs against the deployed Sepolia contract and has the same short payload. **Left unchanged**: it will start failing only when Sepolia gets this upgrade, and it should change in the same commit as that deployment.
- The press (`press/src/chain/registry.ts`) already signs every field step 8 checks, in base64url, so it needs no change.

### W8. Deploying beyond the devnode

- Sepolia and mainnet need a separate CP7 approval. On both, the logic contract is upgraded through the governance proposal with its 7-day timelock (§4.14). I recommend doing that together with W1.

### W9. Observations outside 6.4a

- **E-48 `SUB_CARD_ADDRESS_RETIRED` has no error of its own.** §4.3 step 2a (added 2026-07-16) refuses re-registering a deregistered sub-card address with E-48. `subcard_ops.rs::register_sub_card` only rejects an *active* entry. The write is still refused, by the storage contract's write-once `deregistered_at` invariant, but with the storage contract's error, not E-48. Reported, not fixed.
- **Contract size.** The logic contract WASM grows from 232,797 to 238,950 bytes (56,187 → 58,135 compressed). The devnode deploys it. Mainnet size limits should be checked at W8.

---

## Answers

- **2026-11-19, David:** **W5** approved (the `RemovePolicyAddress` press payload fields).
- **2026-11-19, David:** **W6**: restrict path characters. A path may not contain `"`, `\` or 0x00–0x1F. Setting such a path is refused with E-43; removal doesn't apply the rule. Built in 6.4b (item 6), with a read-only scan of Sepolia and mainnet for existing paths that break the rule before the upgrade (item 7). Spec amended in `registry_contract.md` and `dns_resolution.md`.
- **2026-11-20, David:** **W1**: 6.4b approved under CP7 for the local devnode only. Deploying elsewhere remains W8, a separate CP7 approval.
- **2026-11-20, David:** **W2** and **W3** ratified as built. The DNS-client `op` audit is added to the W8 checklist.
- **2026-11-20, David:** **W4** included in 6.4b (item 5): the press signs `max_acceptances` and `expires_at`, and the contract binds them.
- Still open: W7–W9 (reports, CP7).
