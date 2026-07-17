# Spec-Consistency Findings: `obj-card` (`specs/object_specs/ipfs_card.md`)

**Reviewer:** Step A review subagent
**Scope reviewed:** `ipfs_card.md` in full, cross-checked against `protocol-objects.md` (§1, §3, §4, §14), `registry_contract.md` (§2, §3.1, §4.2, §4.13), `press.md` (§3.4, §3.5, §5.1, Open Questions), `card_protocol_spec.md` (Appendix A), `ARCHITECTURE.md` (ADR-006, ADR-007, ADR-010, ADR-012), `key_rotation.md` (§2.2–§2.6, §7.1), `subcards.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `wallet.md`, and a representative sample of process specs.

## Summary

`ipfs_card.md` is unusually well-sourced — nearly every specific claim (the content-encryption formula, CID validation steps, on-chain field names, versioning semantics, the `key_rotation.md` citation) was checked against the cited section of the source spec and found to match verbatim or near-verbatim. No high-severity contradictions were found. Three lower-severity findings are below; all three trace back to a pre-existing issue in an upstream spec (`registry_contract.md` or `protocol-objects.md`) that `ipfs_card.md` inherited or left unaddressed rather than a new error it introduced. None of them requires a fix to `ipfs_card.md`'s *content* — they mostly require a fix upstream, plus one clarifying addition to `ipfs_card.md`'s CardEntry table.

`key_rotation.md` **does exist** at `specs/key_rotation.md` (not under `process_specs/` — see Finding 4), so the `key_rotation.md` citation in `ipfs_card.md` §7/§8 is not a dangling reference to a missing spec. It does cover the `successor`/`forward_to` ordering question that `ipfs_card.md` §7 explicitly flags as open (`key_rotation.md` §2.4, steps 3→4→4a→5), so that citation is sound and the "review key_rotation.md to confirm sync" hedge in `ipfs_card.md` §7 turns out to be already answered by the source it points to.

---

## Finding 1 (Low): `ipfs_card.md` §6's CardEntry table omits `forward_to`, inheriting an internal field-count inconsistency from `registry_contract.md`

**Specs involved:** `ipfs_card.md` §6 ("Relationship to the On-Chain Anchor") vs. `registry_contract.md` §2 and §3.1.

**The conflict:**

`registry_contract.md` §2 states:

> "This spec extends and supersedes the `RegistryEntry` description in `protocol-objects.md §14`. The per-card entry structure defined there — `(address, log_head_cid)` — is expanded here with two additional on-chain fields: `policy_address` and `last_press_address` (§3.1). **`protocol-objects.md §14` has been updated (2026-06-14) to show the full 4-field `CardEntry` struct** and reference this spec as authoritative."

But `registry_contract.md` §3.1's own `CardEntry` struct definition has **five** fields, not four: `log_head_cid`, `policy_address`, `last_press_address`, `forward_to`, and `exists`. The `forward_to` field is fully specified there ("If non-zero, the registry address of the card that supersedes this one following a key rotation. Set by `RegisterAddressForward` (§4.13); immutable once set.").

`ipfs_card.md` §6 reproduces exactly the same "4-field" framing: its on-chain/IPFS-side mapping table lists only `log_head_cid`, `policy_address`, `last_press_address`, and `exists` — `forward_to` is absent from that table. `ipfs_card.md` then discusses `forward_to` separately in §7 ("On-chain, an analogous mechanism exists at the `CardEntry` level via `forward_to` (`registry_contract.md §3.1`)..."), correctly treating it as part of `CardEntry`. So `ipfs_card.md` itself is internally split: §6 presents `CardEntry` as if it has four fields (matching `registry_contract.md`'s own mistaken self-description), while §7 correctly treats `forward_to` as a fifth field of the same struct.

**Recommended resolution:**
- In `registry_contract.md` §2, correct "full 4-field `CardEntry` struct" to "full 5-field `CardEntry` struct" (or otherwise stop asserting a specific field count that will drift again).
- In `ipfs_card.md` §6, either add `forward_to` as a row in the on-chain/IPFS-side mapping table (for completeness, since the table's own preamble says "This spec adds no new fields to `CardEntry` — it only clarifies the IPFS-side half of the relationship," which should logically cover all five stored fields, not four), or add an explicit forward-reference from §6 to §7's `forward_to` treatment so a reader of §6 alone isn't left with an incomplete picture of the struct.

---

## Finding 2 (Low): CID hash-algorithm scope claimed in `ipfs_card.md` §4 is broader than what `press.md`'s actual pinning implementation validates

**Specs involved:** `ipfs_card.md` §4 vs. `registry_contract.md` §3.1 vs. `press.md` §5.1 (`pinToIPFS`).

**The conflict:**

`ipfs_card.md` §4 states, quoting `registry_contract.md §3.1`:

> "`registry_contract.md §3.1` notes the on-chain `log_head_cid` field accommodates SHA2-256, SHA3-256, or BLAKE3 CIDs (34 bytes each, within a 64-byte maximum)..."

This is an accurate quote of `registry_contract.md` §3.1 ("Maximum length is 64 bytes, which accommodates SHA2-256 (34 bytes), SHA3-256 (34 bytes), and BLAKE3 (34 bytes) CIDs"). However, `press.md`'s actual `pinToIPFS` implementation (§5.1) — the only concrete CID-validation logic in scope, and the one `ipfs_card.md` §4 cites in the very next paragraph for the press's CID-validation obligation — only re-derives the CID using one specific algorithm:

> "3. Re-derive the expected CID from `content` using the same hash function (SHA2-256 / multihash). 4. Confirm the derived CID equals the returned CID. If they differ, abort and return error `P-10`."

`ipfs_card.md` presents the three-algorithm on-chain flexibility and the press's CID-validation duty back-to-back, in a way that implies presses can and do validate any of the three formats, but the only implementation described in `press.md` handles just SHA2-256. Neither `ipfs_card.md` nor `press.md` reconciles this, and `ipfs_card.md` doesn't flag it as an open question.

**Recommended resolution:** Either (a) generalize `press.md` §5.1's `pinToIPFS` CID-rederivation step to detect/support all three algorithms the registry contract accommodates (if that's the intent — e.g. Piñata may return SHA3-256 or BLAKE3 CIDs in some configurations), or (b) narrow `registry_contract.md` §3.1's claim to note that only SHA2-256 is currently produced/validated by the reference press implementation, with SHA3-256/BLAKE3 reserved for future use. `ipfs_card.md` §4 should then be updated to match whichever side is corrected, since right now it's a faithful summary of a discrepancy rather than a resolved consistent picture.

---

## Finding 3 (Informational, no action needed on `ipfs_card.md`): `protocol-objects.md` §3 `LogEntry` example has a stray version-numbering artifact that `ipfs_card.md` silently resolves correctly

**Specs involved:** `protocol-objects.md` §3 (internal) — `ipfs_card.md` §5/§7 is consistent with the correct reading, not the erroneous one.

**The detail:** `protocol-objects.md` §3's `LogEntry` JSON template shows `"version": 2` with the field comment "CID of the prior log entry (or genesis CardDocument for version 2)" — but the table below it says "`version` ... Monotonically increasing; **version 1** is the first post-genesis entry," and by that rule it's version 1 (not 2) whose `prev_log_root` should equal the genesis CID. This is a pre-existing internal inconsistency in `protocol-objects.md`'s own example vs. its own table, not something `ipfs_card.md` introduced.

`ipfs_card.md` §5 states: "each `LogEntry.prev_log_root` points to the prior head (the genesis `CardDocument`'s CID, for the first post-genesis entry)" and §7 states versioning is "monotonically increasing from `1` for the first post-genesis entry" — both consistent with `protocol-objects.md`'s table (the correct rule), not its buggy example. No fix needed in `ipfs_card.md`; flagging only so the `protocol-objects.md` example gets corrected during that spec's own consistency pass (out of scope for this unit).

---

## Non-findings (explicitly checked, no contradiction)

- **Content encryption formula** — `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, `AES-256-GCM` with 96-bit nonce: verified byte-for-byte identical across `ipfs_card.md` §3, `protocol-objects.md` §1, `press.md` §5.1 (`publishCard`), `card_verifier.md` §Verification steps and its algorithm table, `ARCHITECTURE.md` ADR-006. Consistent.
- **Address derivation** (`keccak256(recipient_pubkey)`, single public derivation, no secret-derived addresses): consistent across `ipfs_card.md` §2/§6, `protocol-objects.md` §1/§14, `registry_contract.md` §3.1, `ARCHITECTURE.md` ADR-006.
- **CardDocument required-field list** in `ipfs_card.md` §2 matches the "Required: Yes" rows of `protocol-objects.md` §1's field table exactly (`policy_id`, `issuer_card`, `press_card`, `protocol_version`, `recipient_pubkey`, `issued_at`, `ancestry_pubkeys`, `issuer_signature`, `holder_signature`, `press_signature`).
- **`active_subcards` semantics** (never present at genesis, added only by code-510, hardcoded holder-only authorization for 510/511/512): consistent between `ipfs_card.md` §2 and `protocol-objects.md` §1/§1.1.
- **Signing sequence** (offerer → holder countersignature → press, with `protocol_version` added by the press in the final step): consistent between `ipfs_card.md` §2 and `protocol-objects.md` §1's five-step sequence.
- **Offer-phase vs. registered-card distinction**, and that offer-phase documents are never content-encrypted under ADR-006: consistent between `ipfs_card.md` §2/§3 and `protocol-objects.md` §1 ("Content encryption and the offer phase") and `ARCHITECTURE.md` ADR-006's "Offer-phase exemption."
- **`UpdateCardHead` optimistic concurrency** (`prev_log_cid` must match current `log_head_cid`): field name and mechanism match exactly between `ipfs_card.md` §6 and `registry_contract.md` §4.2.
- **`forward_to` / `RegisterAddressForward`** mechanics (set once, immutable, `registry_contract.md §4.13`): consistent between `ipfs_card.md` §7 and `registry_contract.md` §3.1, and further corroborated by `key_rotation.md` §2.3/§2.4 (which also resolves the ordering question `ipfs_card.md` §7 flags as open, via its "Steps 3 → 4 → 4a → 5 must be executed in order" note).
- **`key_rotation.md` codes 100–103 and the 72-hour pending window**: matches `ipfs_card.md` §7's citation exactly (`key_rotation.md` §2.6, §7.1).
- **CID reconciliation job** (`nitro/tasks/reconcile-cids.ts`, `pinata.pinByHash`, idempotent, reads `CardRegistered`/`CardHeadUpdated` events): matches `press.md` §3.5 exactly; section-number citations in `ipfs_card.md` (§3.4, §5.1, §3.5) all resolve to the correct sections of `press.md`.
- **OQ-B3 citation** (verifier `RpcProvider.getLogEntries()` walks the CID chain because the contract stores only the head): matches `press.md`'s Open Questions table exactly.
- **"Presses are the only parties that post card content to IPFS"** (`ipfs_card.md` §4): no contradicting evidence found — `wallet_sdk.md`, `app_sdk.md`, and `card_verifier.md` contain no client-side IPFS-posting/pinning logic; all IPFS writes in scope are performed by the press via `pinToIPFS`.
- **No CBOR anywhere** (`ipfs_card.md` §1's "Format: JSON, not CBOR"): consistent with `ARCHITECTURE.md` ADR-010 (CBOR explicitly reversed in favor of RFC 8785 JSON) and `serialization-conformance.json`'s own comment contrasting itself with CBOR. No other in-scope spec still treats CBOR as current.
- **`client_sdk.md`**: not cited anywhere in `ipfs_card.md`, so the "stale reference to a superseded spec" risk named in the task brief does not apply here.

---

## Overall assessment

`ipfs_card.md` does what its provenance note claims: it consolidates `protocol-objects.md` §1/§3/§14, `press.md`, and `registry_contract.md` without introducing new, conflicting claims. The three findings above are minor and mostly point back at a pre-existing wrinkle in `registry_contract.md` (Findings 1–2) or `protocol-objects.md` (Finding 3) that this new document happened to surface by cross-referencing carefully. Recommend folding Findings 1 and 2 into the Phase 1 consolidated fix list (touching `registry_contract.md` primarily, with a small clarifying addition to `ipfs_card.md` §6); Finding 3 can be deferred to whichever unit reviews `protocol-objects.md` directly.
