# Notary Phase 1 Summary — Scan Specs and Code

Date: 2026-11-11 · Output: [notary-spec-impact.md](../notary-spec-impact.md)

## What was done

Steps 1.1–1.6 of the implementation plan. Read-only scan; no spec, contract or code files were edited.

| Step | Result |
|---|---|
| 1.1 Objects and policy | §A: 9 existing objects/sections to change, 9 new objects, derived-card requirements |
| 1.2 Press, registry, contract | §B: four authorization options, affected functions, contract change not unavoidable |
| 1.3 Wallet, verifier, transport | §C: 14 additions with target specs |
| 1.4 Governance, updates, logs | §D: candidate owners, publishing mechanisms, update codes, watch-loop analysis |
| 1.5 Reusable code | §E: reuse inventory; hybrid KEM available (X-Wing draft-06) on both sides |
| 1.6 Review | §F: consistency grep, 20 Phase 2 questions |

## Findings that change the plan's assumptions

1. ADR-011 has no "governance-signed artifact" mechanism; one must be designed (card-based list is the cheapest option).
2. Reusing `PressAuthorizations` works with no contract change but makes each notary operator a 4-of-5 governance act (conflicts with G3).
3. Notarization entries don't fit `LogEntry`'s full-`card_state` model.
4. Existing HPKE is X25519-only; X-Wing (ML-KEM-768 + X25519) exists but only at draft-06.
5. Existing specs use bare "Nitro" for the web framework; the plan's terminology rule applies to new text only.
6. Key custody of the notary identity (ML-DSA, secp256r1) inside the enclave is unspecified and drives the whole derived-card trust claim.

## Checkpoints

- **CP1:** not triggered; no strategic decision is invalidated.
- **CP2 (next required):** after Phase 2, David reviews `notary-design-decisions.md`.
- Future flags: CP6 if `LogEntry` changes break tests; CP7 for any contract change; CP9 if X-Wing draft-06 interop fails.

## Not done

- No tests were run (none apply). Library findings come from `npm view`, `cargo search/info` and `node_modules` inspection; interop between JS and Rust X-Wing is **unverified**.
- Nothing committed (CP11).
