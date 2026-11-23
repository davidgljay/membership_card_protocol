You're starting Phase 7 (Integration, conformance and docs) of the Digital Notaries project, in the `card_protocol` repo on branch `notary`. Phases 5 and 6 are done and committed (tip `af08acde`: step 6.5a).

**Read first** (in this order):
1. `plans/notary-implementation-plan.md`: Phase 7 (steps 7.0 to 7.4), and the "Carried from the 6.6 review" notes under 7.0.
2. `plans/notary-code-plan.md`: §7.4 (CI) and §8.3 (what has landed, and its tests).
3. `plans/milestones/notary-phase-6-summary.md` and `plans/milestones/notary-phase-5-summary.md`.
4. `plans/notary-questions-6.6.md` (Resolutions at the end) and `plans/notary-spec-6.5a.md`.
5. `integration_tests/README.md`, and `plans/notary-strategic-plan.md` (Key Objectives).

**Do 7.0 first** (the Phase 7 questions), then STOP and wait for my answers (CP5). Write them to `plans/notary-questions-phase-7.md`, in the format of `notary-questions-phase-6.md`. Put these in it:
- **R5, first Phase 7 task:** a `notary-ci.yml` workflow (Linux; `cargo test --workspace`, host, attestation-ts, verifier, wallet and e2e tests, `check-aws-isolation.sh`; the Linux isolation tests, which close E27). Bring me a design first: runners, caching, whether the compose scenarios run on every push.
- **R3, a 7.1 dependency:** wallet `derived.ts` (`requestDerivedCard`, the holder countersign, `renewDerivedCards`) and a real-process derived-card scenario in `notary/e2e`.
- **6.5a wiring:** the wallet's production read of the source policy's `derivable` flags (`NotaryChainReads.nonDerivableFields`), and the `CardVerifier` wiring that 7.1 needs.
- The Phase 7 adapter work listed in the Phase 5 summary, and anything else the Phase 6 summary lists as carried (E27, E33, E9, the CP10 press-predicates report).
- **W8:** deploying the 6.4a and 6.4b contract changes beyond the devnode is a separate CP7 approval. Ask whether it is in scope for Phase 7. Don't do it either way.

**Hard rules (still in force):**
- **Terminology:** write "AWS Nitro Enclaves" or "the enclave" for the TEE, and "nitropack" for the web framework. Never write bare "Nitro". Say "primary card", never "master card" (identifiers keep their `master_` names).
- **Specs:** the specs are approved. Don't edit spec text. If the code can't match a spec, or the spec is ambiguous or wrong, record it as an erratum and ask me. Never deviate silently.
- **Security and specs:** ask me immediately, and don't guess, about anything that affects security or a spec.
- **G5:** only `notary-attest::aws`, `notary-attestation` and `notary/deploy` may parse the AWS attestation format.
- **Scope:** don't refactor press/, the verifier core or other existing code beyond what the code plan lists. Report bugs you find outside notary code rather than fixing them (CP10).
- **Chain and money:** no changes under `contracts/`, and no on-chain transactions or governance publication (CP7). No AWS resources and nothing that costs money (CP8).
- **Git:** don't commit or push unless I ask (CP11).
- **Done means tested:** tick a plan step only when its "Done when" is met and the tests pass. Run the tests; don't assume. Keep the traceability table (code-plan §8.3) accurate.
- **Reviews:** for 7.2 and the 7.4 review, use mutation checks (the test must fail without the fix) and negative controls, as in 6.6.

**Baseline to keep green** (as of `af08acde`): Rust workspace 194; host 104; verifier 276; wallet 249 (1 todo); attestation-ts 95; vectors-tools 48 (`pnpm run check`: 24 files); e2e vitest 12; `notary/scripts/check-aws-isolation.sh` OK; `notary/e2e/run-local.sh` and `run-three.sh` pass.

**Model note:** the plan marks 7.4 (the final milestone review) as Opus. Everything else in Phase 7 is Sonnet-sized.
