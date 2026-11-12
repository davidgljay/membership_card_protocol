# Notary Phase 2 Summary — Detailed Design Decisions

Date: 2026-11-11 · Output: [notary-design-decisions.md](../notary-design-decisions.md) · **CP2 approved 2026-11-11**

## What was done

Steps 2.1–2.7 of the implementation plan. Only `plans/` files changed: no spec, governance, contract or code file was edited. All 20 Phase 1 questions (`notary-spec-impact.md §F.2`) are answered; the map is in §0.4 of the design document.

| Step | Result |
|---|---|
| 2.1 Object schemas | Key custody and the attestation binding (§1). Field tables, signers and examples for 15 objects, plus a serialization summary (§2.1). |
| 2.2 On-chain and governance | D1, D2 and D5 decided by David (below) |
| 2.3 Attestation and admission | Six numbered algorithms with a reject code per check: **V**, **W**, **G**, **N**, **P**, **A**. The platform abstraction. The list-freshness defense. |
| 2.4 Runtime | The broker/worker split, both message tables, input validation, the close computation, output transforms, lifecycle diagrams, limits and zeroization. D7 decided. |
| 2.5 Replication and recovery | Forming replica sets, handoff, inputs acknowledged by a quorum, close by quorum, heartbeats, epochs, and the state blob, each with a hostile-host analysis |
| 2.6 Derived cards and propagation | Issuance flow, periods and nullifiers, the anonymity set, the watch loop, code mapping and timing defenses as parameters. D10–D12 decided. |
| 2.7 Review | Consistency pass, 10 threat-model assumptions, 10 known limits, checkpoint status, strategic-plan wording changes, and the Phase 3 action list |

## Decisions (David, 2026-11-11)

| # | Decision |
|---|---|
| D1 | Shared derived-card **template policies** registered by governance. One `AuthorizePress` per (template, operator), not per community. Provisional; may be revisited. |
| D2 | **PressRegistryBody** owns the runtime list, the program allowlist, `NotaryCardPolicy` and the template policies, all as cards |
| D3 | Job log on IPFS, anchored with EAS, not on the notary card's log (*deviation*) |
| D4 | No on-chain state-blob anchor. Rollback protection comes from the handoff and heartbeats (*deviation*). |
| D5 | Fix the write-gate calldata binding (CP7) before derived cards ship |
| D6 | One `NotaryCardPolicy` for all notary cards |
| D7 | Differential privacy specified but deferred. v1 refuses DP budgets. |
| D8 | New optional `expires_at` on `CardDocument`. Renewal issues a fresh card. |
| D9 | Anyone may open a derived-card job |
| D10 | A keyed, period-ratcheted `dup_tag` shared across a template's operators |
| D11 | Propagated revocations use new codes 820 and 920 |
| D12 | No `PressIssuanceRecord`s for derived cards (a §11 exception) |

## Findings during Phase 2 that changed the design

1. Every policy that cards are registered under needs `RegisterPolicy`. This led to D1.
2. The write-gate gap lets a host reuse enclave-signed payloads with different calldata. This led to D5.
3. On-chain anchoring can't give rollback protection in v1, and isn't needed. This led to D4.
4. "Latest ballot wins" must be ordered by a contributor-signed `revision`, not by arrival.
5. Dedupe must key on the master card's original key, not on the signing sub-card or a rotated address.
6. The X-Wing public key (1,216 bytes) doesn't fit the attestation's `public_key` field, so the field carries its hash.
7. Replicas need per-instance keys to sign heartbeats and handoffs.
8. A replica closing alone lets a partitioning host choose the result. Close now needs a quorum of cosigners who each recompute.
9. A fabricated block could close a vote early. Close now also needs NSM time.
10. Fetching cards by address told the host who took part, and which source card was presented. Fixed with evidence bundles and policy snapshots.
11. Fuel accounting must be frozen in the ABI so that recomputation agrees.

## Checkpoints

- **CP2:** **approved by David, 2026-11-11.** The §2.7.5 strategic-plan wording changes are still to be applied (timing is an open item below).
- **CP6:** not triggered. All shared-object changes are new optional fields.
- **CP7:** the D5 contract fix, plus one-time governance registrations before any testnet use.
- **CP9 triggers to test early:** X-Wing JS↔Rust interop (5.1); NSM time independence and NSM field-size limits (5.2, Phase 8).

## Open items for David (not blocking CP2)

- The **emergency-retirement** path for vulnerable runtimes and programs under PressRegistryBody (§2.2.2). It's a governance-process change, going in with the Phase 3 governance text.
- Whether the strategic plan should be updated now with the §2.7.5 wording, or at the end of Phase 3.

## Not done

- No tests run (none apply). The figures for snapshot size, admission ceilings and limits are estimates, to be measured in 5.6.
- AWS facts relied on (attestation format, NSM field limits, debug-mode PCRs, NSM time) come from AWS documentation, not hardware.
- Nothing committed (CP11).
