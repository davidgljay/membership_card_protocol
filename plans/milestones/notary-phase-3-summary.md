# Notary Phase 3 Summary — Write Specs

Dates: 2026-11-11 to 2026-11-12 · Change summary: [notary-spec-changes.md](../notary-spec-changes.md) · **CP3 approved by David, 2026-11-12**

## What was done

Steps 3.1–3.9 of the implementation plan. All design came from [notary-design-decisions.md](../notary-design-decisions.md), approved at CP2.

| Step | Result |
|---|---|
| 3.1 ADR | `ARCHITECTURE.md` gains ADR-013, the Component Map block, Key Data Flow 5, and the "Nitro" terminology note (Q20) |
| 3.2 Objects | `protocol-objects.md`: `expires_at`; §2.1 and §2.2; the §11 exception; §20–§34 |
| 3.3 Lifecycle | `notary_lifecycle.md`: phases 0–7, flows, error paths, threat model (T1–T10, L1–L10), algorithms V, W, G and N, input checks B1–B11 |
| 3.4 Replication | `notary_replication_and_recovery.md`: handoff and P1–P4, quorum acknowledgment and close, epochs, state blob. A threat note on every step. |
| 3.5 Propagation | `derived_card_revocation_propagation.md`: issuance, `dup_tag`, anonymity set, `expiry_only` / `sealed_link` / `escrowed_link`, parameters |
| 3.6 Object specs | New `notary_runtime.md` and `notary_host.md`. Updates to `wallet_sdk.md`, `card_verifier.md`, `registry_contract.md`, `oblivious_transport.md`, `messaging_protocol.md`, `press.md`, `wallet.md`. |
| 3.7 Feature and governance | `card_protocol_spec.md §9` (18 acceptance criteria, one per Key Objective); codes 820 and 920; PressRegistryBody notary mandate; draft section in `press-rules.md` |
| 3.8 README | Notaries flow, Notary component, spec links |
| 3.9 Review | Consistency pass, results in `notary-spec-changes.md`. One fix: the eleven `NOT_*` codes are now named in the lifecycle error table. |

## Corrections made while writing specs (synced back to the design doc)

1. The genesis attestation nonce now hashes the **complete** genesis request. Leaving out its random nonce had made that nonce pointless.
2. `job_requester_predicate` is optional, as D9 implies.
3. Dedupe is defined by contributor root key throughout.
4. The derived card's `projected` field is `text` holding canonical JSON, because the field type system has no object type.

## Added at CP3 review

At David's request, `derived_card.source_kind` was added with `"web_evidence"` **reserved** for cards derived from verified HTTPS responses (zkTLS / Reclaim-style attestor claims). v1 refuses it (`ADM_FEATURE_UNSUPPORTED`). The feature is a §9 P2 item with an open security question on attestor trust. Details are in `notary-spec-changes.md`.

## Added after CP3 approval

Governance list updates now need PressRegistryBody **member multi-signatures** (`list_approval`, algorithm L): the quorum for any change, 2 of 5 for removal-only emergency retirements. Previously the list-holder key alone could change what runtimes and programs were accepted. Details are in `notary-spec-changes.md`.

## Checkpoints

- **CP3:** approved by David on 2026-11-12, including the web-evidence hook added during review.
- **CP6:** not triggered. Every shared-object change is a new optional field.
- **CP7 ahead:** the write-gate calldata binding (now required in `registry_contract.md §6.1`) and the one-time governance registrations.
- **CP9 ahead:** X-Wing interop, NSM limits, NSM time (T9), and wasmi determinism.

## Open items for David

All resolved on 2026-11-12:
- **Emergency-retirement rule:** adopted (`governance/PressRegistryBody/notary_certification.md`, `mandate.md`).
- **Strategic-plan wording changes:** not applied. The strategic plan stays the original record.
- **`projected` field type:** stays `text`.

## Not done

- No code and no tests (Phase 3 is specs only).
- Anchor fragments weren't checked with a renderer.
- `subcards.md` and `key_rotation.md`, which Phase 1 flagged for TEE mentions, weren't re-read. Their existing TEE text isn't contradicted by any new spec text.
- Nothing committed (CP11).
