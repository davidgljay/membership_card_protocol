# Digital Notaries — Phase 7 Implementation Questions (step 7.0, CP5)

Implementation plan: [notary-implementation-plan.md](notary-implementation-plan.md) · Code plan: [notary-code-plan.md](notary-code-plan.md) (§7.4 CI, §8.3 landed modules) · Phase 6 summary: [milestones/notary-phase-6-summary.md](milestones/notary-phase-6-summary.md) · Phase 5 summary: [milestones/notary-phase-5-summary.md](milestones/notary-phase-5-summary.md) · Review decisions: [notary-questions-6.6.md](notary-questions-6.6.md) (Resolutions)

**Status:** Answered, "OK to all" (David, 2026-11-21). **No Phase 7 code had been written when this was answered.** Each question has a recommended answer. Reply "OK to all" or answer by number. Anything marked **[security]**, **[spec]** or **[CP7]**/**[CP8]** is asked now rather than guessed. Specs are approved text, so a **[spec]** item needs your approval before it is written or implemented.

**How answers are recorded:** write the answer under **Answer:** in each question. When every question has one, 7.0 is done.

**What Phase 7 starts from** (tip `af08acde`). The notary runtime, host, wallet SDK and verifier support are built, and all four use cases run in the simulator (`notary/e2e/run-local.sh`, `run-three.sh`). Three things are missing: (1) no CI workflow runs the notary tests; (2) the wallet has no derived-card code, and the read adapters the products would use are still the shortcuts in `notary/e2e/src/reads.ts`; (3) nothing runs against the real integration stack or a production chain, EAS, gas-wallet or IPFS client.

| Section | Questions |
|---|---|
| A. CI (R5, first task) | Q1, Q2, Q3 |
| B. Wallet and derived cards (R3, 6.5a wiring) | Q4, Q5 |
| C. Adapters and integration (7.1) | Q6, Q7, Q8 |
| D. Adversarial suite and docs (7.2, 7.3) | Q9, Q10 |
| E. Carried items and deployment | Q11, Q12, Q13 |

---

## A. CI (R5, first task of Phase 7)

### Q1. What does `notary-ci.yml` run on every push, and what runs elsewhere?

- **Facts.**
  - Today `.github/workflows/` has `notary-fuzz.yml` (nightly, not gating) and `wallet-sdk-ci.yml` (path-filtered, installs the `file:` dependency chain in order). Nothing runs `cargo test --workspace`, the host, attestation-ts, verifier, wallet, e2e vitest, or `check-aws-isolation.sh`.
  - Baseline: Rust 194, host 104, verifier 276, wallet 249 (1 todo), attestation-ts 95, vectors-tools 48 plus `pnpm run check`, e2e vitest 12.
  - `run-local.sh` takes about a minute. `run-three.sh` takes about seven minutes (the stopped replica counts as lost after the 120 s liveness window) and needs docker-compose.
- **Recommendation.** Three tiers, in one file with separate jobs:
  1. **Every push and PR, path-filtered** to `notary/**`, `wallet-sdk/**`, `membership_card_verifier/packages/verifier/**` and the workflow itself: jobs for Rust (`cargo test --workspace`, `cargo clippy` if it is clean today), TypeScript (host, attestation-ts, vectors-tools with `pnpm run check`, verifier, wallet, e2e vitest) and `check-aws-isolation.sh`.
  2. **Every push and PR, same filter:** `e2e/run-local.sh` (one minute, no compose).
  3. **Nightly and on demand, plus any PR labelled `notary-e2e`:** `run-three.sh` and the existing fuzz job. Reason: seven minutes of compose on every push costs minutes for little extra signal over tier 2.
- **Alternative.** Run `run-three.sh` on every PR to `main` only (not every push to a branch).

**Answer:** OK, as recommended (David, 2026-11-21).

### Q2. Runners, caching and toolchain

- **Facts.** `notary/rust-toolchain.toml` pins Rust 1.96.0; the fuzz workflow uses `dtolnay/rust-toolchain@master` with that version. `pnpm` is 9, Node 22 in the existing workflows. A cold `cargo test --workspace` builds wasmi, ML-DSA and X-Wing crates; the compose builds are larger.
- **Recommendation.** `ubuntu-latest` (x86_64) for everything: it is the platform E27 needs. Cache `~/.cargo` and `notary/target` with `Swatinem/rust-cache`, keyed by `Cargo.lock`; cache the pnpm store with `actions/setup-node`'s `cache: pnpm`. Reuse the file-link build order from `wallet-sdk-ci.yml`. For compose jobs, use the runner's Docker with no registry cache at first (measure before adding buildx caching). Pin third-party actions by version tag, as the existing workflows do.
- **Alternative.** A self-hosted or larger runner for the compose jobs, if the nightly run is too slow on the free tier.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q3. E27: does a green x86_64 run of the Linux isolation tests close it? **[security]**

- **Facts.** E27 is the worker sandbox (seccomp, `no_new_privs`, rlimits, UIDs) verified on Linux arm64 only. The GitHub `ubuntu-latest` runner is x86_64, but its container and seccomp environment can differ from a production host: containers may not allow the filter, and some tests skip when a capability is missing. Skipped tests are not passes.
- **Recommendation.** The workflow runs the isolation tests directly on the runner and **fails if any isolation test is skipped** (the job asserts the test count, or sets an environment variable that turns a skip into a failure). Close E27 only for "native x86_64 Linux on a GitHub-hosted runner", and say that in the summary. The production platform (Graviton, arm64, inside an enclave) is verified in Phase 8. Because arm64 is already verified, E27 then holds for both.
- **Alternative.** Keep E27 open until the runs are on the exact deployment image.

**Answer:** OK, as recommended (David, 2026-11-21).

---

## B. Wallet and derived cards (R3 and the 6.5a wiring)

### Q4. Wallet `derived.ts`: scope and order

- **Facts.** `wallet_sdk.md §7b.7` specifies `requestDerivedCard`, the holder countersign and `renewDerivedCards`. None is built. The derived-card flow is tested through the broker (18 + 7 tests), through the TypeScript verifier over a broker-written fixture, and through the host schedulers, but never through the wallet or in real processes. The wallet already has algorithm W, consent, submit and the field-control check (W6b).
- **Recommendation.** Build in this order, each step tested before the next: (1) `derived.ts` with the three functions, against the broker harness; (2) a real-process derived-card scenario in `notary/e2e` (`run-local.sh` extended, or a sibling `run-derived.sh`), covering issue, verify through the verifier, and a `sealed_link` source revocation reaching the derived card; (3) hold it all to the Phase 6 unlinkability result (the host's records never name a source card). The derive template is not registered on any chain, so the scenario uses the simulated chain and the test governance list, as `run-local.sh` does (CP7).
- **Open spec check.** If `wallet_sdk.md §7b.7` is ambiguous when I build it (for example, what the wallet does when the countersign is refused after the notary has already offered), I record an erratum and ask. I will not choose.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q5. 6.5a wiring: the production read of the source policy's `derivable` flags, and `CardVerifier` for Stage 5 step 3a

- **Facts.** Without a production `NotaryChainReads.nonDerivableFields`, the wallet warns `FIELD_CONTROL_UNCHECKED` and the user is told the check was not made. Stage 5 step 3a (derived-card shape and source kind) is called directly through `verifyNotaryIssuedCard` and is not yet reached from `CardVerifier`. The broker side (the oracle read with a 10-minute cache) is built, but the real `SnapshotOracle` read has no test against a simulated chain (the broker tests use a fixed-answer oracle).
- **Recommendation.**
  1. Implement `nonDerivableFields` in the wallet's production reads by reading the source policy's field list from the chain through the verifier (a policy card read with chain verification, not a bare fetch), with the same "not derivable if the policy says so" rule as the broker, and the shared vectors `vectors/field_control/cases.json` as the conformance check on both sides.
  2. Wire Stage 5 step 3a into `CardVerifier` as a call inside the verifier package. **This changes the verifier core**, which the rules say to leave alone beyond what the code plan lists. Code-plan §8.3 and the Phase 5 summary both list this wiring, so I read it as in scope; **confirm**. If you want it done differently (a separate wrapper in `verifier/notary`, no change to the core path), say so.
  3. Add the missing test: the real `SnapshotOracle` read and its cache against the simulated chain.
- **Not asked here:** registering the derive template on a chain is governance (CP7) and stays out.

**Answer:** OK, as recommended (David, 2026-11-21).

---

## C. Adapters and integration (7.1)

### Q6. Replace the e2e read adapters with `CardVerifier`-backed ones

- **Facts.** `notary/e2e/src/reads.ts` supplies `NotaryChainReads`, `NotarizationReads` and `ExposureReads` with three shortcuts: W5 `satisfies` is approximated, algorithm E's PCR0 comes from the test, and `chainValid: true` is assumed. The Phase 5 summary says the product adapters must (a) supply a real W5 `satisfies`, (b) parse the genesis PCR0 from the attestation (algorithm E), and (c) verify the policy and notary card chains. Nothing outside `notary/e2e` imports the shortcuts. **G5:** only `notary-attestation` may parse the attestation, so (b) calls it and does not parse.
- **Recommendation.** Put the adapters in the wallet SDK's notary subpath (they are the wallet's reads), built over `CardVerifier`, with the e2e shortcuts deleted and `reads.ts` rewritten on top of them. Test each one with a negative control: a policy card that fails chain verification must make `chainValid` false, and the real `satisfies` must reject a card the shortcut accepts. No new public API without listing it in the code plan first.
- **Alternative.** Keep the adapters in `notary/e2e` and publish them later. I recommend against: the point of 7.1 is that the suite uses the real thing.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q7. Production clients and the integration stack: what is in scope for 7.1?

- **Facts.** The host refuses to start without a chain, EAS and Kubo client (`CHAIN_PROVIDER=rpc`, `IPFS_PROVIDER=kubo`). The Phase 5 summary lists: production chain, EAS, gas-wallet and Kubo clients; header-stream, snapshot-refresh and close schedulers over a real RPC feed. The integration stack (`integration_tests/docker-compose.yml`) has a local devnode, IPFS, press, wallet-service and relay; `run.sh` is gating on deploy workflows.
- **Recommendation.**
  1. Write the four production clients in `notary/host`, tested against the devnode and the stack's Kubo (no Sepolia or mainnet: CP7).
  2. Add `integration_tests/suites/notary/` with **one test per acceptance criterion** in the `card_protocol_spec.md` Notaries section, following `integration-testing-strategic-plan.md`. I first list the criteria with a test name each and bring that list to you before writing the tests, since it is also the 7.1 "Done when".
  3. **EAS:** deploy it into the stack; if it will not deploy on the devnode, use the test-only mock anchor the plan allows (CP4). The mock lives in the test stack only.
  4. **Governance and EAS scripts** (code-plan §3.6): written, run against the devnode only.
  5. Whether the notary stack joins `run.sh` (and so the deploy gates of the other workflows) is a separate decision: the notary suite is slow. **Recommendation:** add it to `run.sh` behind a `--with-notary` flag and to the nightly tier of Q1, not to the deploy gates, until its run time is measured.
- **Alternative.** Make it gating on deploy from the start.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q8. The chain, headers and gas wallet in the integration stack **[CP7]**

- **Facts.** The notary host submits `RegisterCard`, `BatchUpdateCardHeads` and `AuthorizePress`-dependent calls as a press. On the devnode these are real transactions, but only on a chain that is created fresh per run and holds no value. The 6.4a and 6.4b contract changes are in the repository and on the devnode.
- **Recommendation.** Treat transactions on the **per-run devnode** as in scope (they are test infrastructure, like the existing suites), with the gas wallet a throwaway key generated by the stack. Anything on Sepolia, mainnet or a real governance list stays out (CP7). I stop and ask if a step cannot be done without one.

**Answer:** OK, as recommended (David, 2026-11-21).

---

## D. Adversarial suite and docs (7.2, 7.3)

### Q9. 7.2: how each attack is judged, and the ones the simulator cannot show

- **Facts.** The 7.2 list: wrong PCR0, debug attestation, mismatched program, replayed nonce; a non-allowlisted program asking for shared isolation; a leaky program; dropped inputs (detected via receipts); stale chain state; killing every replica; rollback of the sealed-link blob; timing correlation in derived-card issuance and revocation. Most already have a unit test somewhere. Timing correlation is a disclosed residue (L8): the specs say it exists. A real hostile operator and a real attestation document need hardware (Phase 8).
- **Recommendation.** The suite is end to end, through the real processes where Q4 and Q7 allow, and each attack gets: the attack, the expected refusal or detection **quoted from the spec** (code and clause), a **mutation check** (the test fails with the defence removed) and a **negative control** (the honest case passes). For timing correlation the test **measures and reports** what an operator can observe (batch size, the window, the successor rule's codes) against the L8 disclosure; it asserts the disclosed bound and does not claim unlinkability the spec does not. Where the simulator cannot show an attack (a forged real AWS document, a real hostile hypervisor), the suite says so and the item moves to Phase 8 in the summary. Any attack that is **not** refused or detected as the spec says is an erratum, asked immediately, not worked around.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q10. 7.3: docs, and how "a fresh reader can run it" is checked

- **Facts.** `notary/README.md` (what is in the directory, running it locally) and `notary/OPERATOR.md` (standing up a notary, sizing and cost, monitoring, upgrading when the PCR0 list changes), modeled on `press/OPERATOR.md`. The cost and sizing figures come from 5.6 (≈ 290 inputs/s per broker thread; one c6g.large per operator, about $35–40 a month); the enclave memory figure is unconfirmed until Phase 8.
- **Recommendation.** Write both. Check by following the docs literally in a clean checkout (`git clone` of the working tree into a scratch directory, or `git worktree`), and fix the docs, not the checkout, when a step fails. State in `OPERATOR.md` which parts are verified only in the simulator (real enclave steps, the reproducible image and `mlock`) and mark them "Phase 8". No AWS resources or costs (CP8). Terminology rules apply: "AWS Nitro Enclaves" or "the enclave", never bare "Nitro", and a terminology grep (code-plan §7.4) runs over the new docs.

**Answer:** OK, as recommended (David, 2026-11-21).

---

## E. Carried items and deployment

### Q11. Which carried items does Phase 7 take on, and which stay carried?

| Item | Phase 7? | Recommendation |
|---|---|---|
| **E27** worker sandbox on x86_64 | Yes, through Q1–Q3 | Close for x86_64 Linux if the CI isolation tests run unskipped. |
| **E33** `LogEntry` carrying its intent payload | No | A protocol-wide change with its own privacy review (and CP6 if it breaks `LogEntry`). Stays carried; I add it to the 7.4 list of open questions. |
| **E9** the signature libraries are unaudited | No | Belongs to the Phase 8 security review. Record in the final summary as open. |
| **CP10 press predicates report** (`press/src/functions/predicates.ts` treats unknown predicates as passing) | Reported, not fixed | It is a press change (CP10). I restate it in the 7.4 summary, and the adversarial suite (7.2) includes a test that shows the **notary's** own evaluator refuses what the press would let through, so the gap is visible. Tell me if you want to schedule the press fix. |
| **Host `fetch` kinds `press_auth:` and `events:`** (the host answers `null`) | Yes, if a 7.1 criterion needs them | Decided when the 7.1 criteria list is written (Q7.2). |
| **Host re-attestation** (`REATTEST_INTERVAL_SECONDS`) | Check | Listed as Phase 6.3 work in the Phase 5 summary; I check the Phase 6 summary and code at the start of 7.1 and report if it is still unused. |

**Answer:** OK, as recommended (David, 2026-11-21).

### Q12. Model and order

- **Recommendation.** Order: **7.0 → CI (Q1–Q3) → Q4/Q5 (wallet, wiring) → Q6 (adapters) → 7.1 → 7.2 → 7.3 → 7.4.** Sonnet for everything except 7.4 (Opus, as the plan says). I stop after the CI workflow design is built for you to look at it, after the 7.1 criteria list (Q7.2), and after each of 7.2, 7.3 and 7.4. Plan steps are ticked only when "Done when" is met and the tests pass.

**Answer:** OK, as recommended (David, 2026-11-21).

### Q13. W8: deploying the 6.4a and 6.4b contract changes beyond the devnode **[CP7]**

- **Facts.** The write-gate (6.4a) and the governance payload binding (6.4b) are on the devnode only. Deploying them to Sepolia and mainnet is one logic-contract upgrade each, through `ProposeLogicUpgrade` and its 7-day timelock, with the checklist in plan step 8.3 (rerun the item 7 path and domain scan, size check, audit DNS admin clients, redeploy the press with the W4 payload, update the dev-tests DNS suite, verify the pending address before confirming). You decided on 2026-11-21 that it comes once the rest of the work is complete.
- **Question.** Is W8 in scope for Phase 7? **Recommendation: no.** It stays step 8.3 with its own CP7 approval. **Either way I do not do it in this phase:** no change under `contracts/` and no transaction on a real chain. If you say yes, I would only prepare the checklist inputs (the rerun of the scan, the size check, the DNS-client audit as a report) and stop before any proposal.

**Answer:** OK, as recommended (David, 2026-11-21).

---

## Findings during Phase 7 (for David)

Recorded as they come up. None changes a spec; each needs a decision or a confirmation.

### F1. `wallet_sdk.md §7b.7` names types the SDK does not have (confirm)

The spec's signature is `requestDerivedCard({ announcement, sourceCard: HeldCard, targetPeriod, signer: SubCardSigner, transport, storage })`. The SDK has no `HeldCard` or `SubCardSigner` type, and the rest of the notary module (`submitNotaryInput`, `watchNotaryJobsOnce`) takes injected collaborators (`buildSignedInput`, `persist`, `send`) instead. `derived.ts` follows that convention, which the spec for §7b.4 already uses in practice. **Needed:** confirm this is acceptable, or tell me to add the spec's types. I have not edited spec text.

### F2. Wallet error codes with no spec row (same kind as R2)

`derived.ts` returns `DERIVE_OFFER_MISSING` (the validation receipt has no `derived_offer`) and `DERIVE_OFFER_INVALID` (the offer differs from what was consented to, or its signature fails). `wallet_sdk.md §7b.8` lists only the codes in the process specs. **Recommendation:** add both to §7b.8 and the propagation spec's error table, on your approval.

### F3. The spec is silent on how the wallet obtains a re-offer (confirm)

Propagation §3 step 8 says "the enclave issues a fresh offer with the next boundary, and the wallet countersigns again". Nothing says how the wallet learns of it. The broker (`derive_reoffer`) hands a new offer back when the **same input is resubmitted** after its boundary has passed. `advanceDerivedCard` therefore resubmits the stored, already-signed request once the boundary has passed and the card is not yet in the registry, and countersigns what comes back (after the same consent checks). **Needed:** confirm this reading, or tell me what the wallet should do instead.

**Resolved (David, 2026-11-21, "Confirm all"):** F1 confirmed (injected collaborators), F2 approved (rows added to `wallet_sdk.md §7b.8` and the propagation Error Paths table), F3 confirmed (resubmit the stored request).

### F4. Stage 5 step 3a in `CardVerifier` (Q5.2) and the adapters (Q6) need two decisions before I write them

What I found (read, not yet changed): `VerifierConfig.notary` is typed but nothing in `CardVerifier` reads it. Stage 5 takes an optional `notaryCheck` hook that `CardVerifier` never passes, and `verifyNotarization` is not a `CardVerifier` method. So Q5.2 and Q6 are one piece of work: a `CardVerifier`-backed adapter that reads the two governance list cards (algorithm L), the notary card, the template policy and the identity-log anchors. Two points the specs leave open:

**F4a. How does a verifier get a list card's public key?** `card_verifier.md §5` gives `acceptedRuntimesCard` and `programAllowlistCard` as **addresses** (`keccak256` of the key). Card content is encrypted under a key derived from the card's **public key** (ADR-006), and the registry entry holds no key, so an address alone cannot be decrypted. The e2e code today hard-codes the keys. Options: (a) add the list cards' public keys to `VerifierConfig.notary` (a **spec change**, and the same for `NotaryConfig` in `wallet_sdk.md`); (b) read each key from the list card's published genesis document, if a list card has one, which needs a spec statement that it does. **Recommendation:** (a): a pinned key in config is the same trust model as `trustedRoots` and `attestationRoots`.

**F4b. An unconfigured verifier meets a notary-issued card.** Without `config.notary`, a verifier cannot tell whether `press_card` is a notary card (that needs `notaryCardPolicy`), so today it silently skips step 3a, and a derived card passes Stage 5 with no notary checks. `card_verifier.md §7.5` and its error table mention `NOTARY_CONFIG_MISSING` ("a notary check was needed") but do not say how a verifier decides one was needed without the config. **Recommendation:** keep the skip for a card whose `press_card` it cannot identify, and return `NOTARY_CONFIG_MISSING` as a warning (not a failure) whenever the card's own shape says it is a derived card (`issuer_card == press_card` and a `dup_tag`). That needs your approval as spec wording.

Until you decide, I have not touched `CardVerifier`, and `nonDerivableFields` stays unwired in the e2e reads.

**Resolved (David, 2026-11-21, "Yes to F4a and F4b"):** both approved. Applied to `card_verifier.md §5` (pinned list-card keys `acceptedRuntimesCardPubkey` and `programAllowlistCardPubkey`), §7.5 step 3a (warning `NOTARY_CONFIG_MISSING`) and the error table, and to `wallet_sdk.md §7b.1`; the config types in the verifier and the wallet follow.

### F5. How `CardVerifier` receives the Stage 5 notary hook (needs your decision, spec-visible)

Built so far: `membership_card_verifier/packages/verifier/src/notary/cardVerifierAdapter.ts` (typechecks; **not yet tested**): `readVerifiedLists` (list cards from pinned keys, algorithm L, Stages 3–5 on the list card), `makeNotaryCheck` (the notary card, the template, the genesis PCR0 through the attestation module so no AWS format is parsed here, algorithm E over the EAS anchors, then `verifyNotaryIssuedCard`), and `looksDerived`.

The problem: `isolation.test.ts` and code-plan §3.1 say **the core `CardVerifier` never imports notary code at runtime**, so it cannot call `makeNotaryCheck` itself. It has to receive it. **Recommendation:** add one optional field to `VerifierConfig.notary`, `stage5Hook?: (ctx) => () => Promise<NotaryIssuedResult | null>`, typed in `types.ts` with no notary import, and supplied by a new function `notaryStage5Hook(config)` exported from `@membership-card-protocol/verifier/notary`. Core `CardVerifier` passes it to Stage 5 as the existing `notaryCheck` argument; when no hook is set and the card looks derived (a five-line check kept in core), Stage 5 adds the warning `NOTARY_CONFIG_MISSING` (F4b). The wallet and the e2e code call `notaryStage5Hook(...)` when they build a `CardVerifier`. This adds one optional field to the spec's `VerifierConfig` (§5). The alternative, a core import of notary code, is what the isolation test forbids.

### F6. Two limits in the adapter (recorded, not hidden)

1. **Operator card validity.** Algorithm G step 3 says the operator card "resolves and is not revoked". The adapter checks only that the operator card is **registered** (`getCardEntry(...).exists`): an operator card is known by address only, so its chain cannot be walked without its public key, and a revocation is not visible from the entry. A revoked operator card would pass. Closing it needs a spec statement of where a verifier gets the operator card's key (the same shape as F4a). **Recommendation:** leave as is for now and list it for the 7.4 review.
2. **List card key rotation.** The pinned list-card key is fixed in config. If governance rotates a list card's key, every verifier's config needs the new key. Same trust model as the pinned roots.

**Resolved (David, 2026-11-21, "Yes, add it"):** F5 approved. Built: `VerifierConfig.notary.stage5Hook`, `notaryStage5Hook(cfg)` in `@membership-card-protocol/verifier/notary`, a `notary` field on the signature result, and the F4b warning in the core. Spec text added to `card_verifier.md §5 and §7.5`.

### F7. Open points found while building the adapter (recorded; none changes a spec yet)

1. **(Resolved 2026-11-21, "Yes, as E11": done. `card_verifier.md §7.5` step 3a now says the policy document's key must hash to the notary card's `issuer_card`; the adapter checks it; the Rust test harness now creates a real notary-policy document, and the derived fixtures were regenerated. Two e2e tests, one a negative control, and a mutation check cover it.)** ~~The notary policy a derived card's notary serves.~~ `verifyNotaryIssuedCard` compares the genesis request's `policy_id` with "the notary policy the card serves". A verifier holding only the derived card has no independent source for that policy, so the adapter takes it **from the genesis request itself**. The check is then a tautology on that field. Algorithm G still binds the request to the notary card's fields and to the attestation, but nothing confirms the policy that approved the notary. The e2e fixture's `issuer_card` is a placeholder, so I could not add the "policy genesis document's key hashes to `issuer_card`" binding (lifecycle A.7 R1, E11). **Needed:** a statement in `card_verifier.md §7.5` of how a verifier resolves the notary policy. **Recommendation:** resolve it as E11 does, from the notary card's `issuer_card`, and fail with `NOTARY_GENESIS_INVALID` if the policy document's key does not hash to it.
2. **Stage 5 reaches a derived card only as the primary card of a signing sub-card.** `verifyCard(address, {pubkey})` runs Stages 3, 4 and 6 only, and `verifyEnvelope` takes sub-card signers. So "a derived card passes standard verification" means Stages 3–4 by address, and step 3a when the derived card is the primary card behind a sub-card signature. This was already true; it is stated here because the hook is now live on that path. No action needed unless you want a direct "verify this derived card" entry point.
3. **F6 stands** (operator-card revocation not checked; the pinned list-card keys do not rotate).
4. **Pre-existing, outside notary code (CP10, not changed):** in `CardVerifier`, Stage 5 is called with the *signer's* (sub-card's) `CardEntry` and the *primary card's* document. The hook receives the primary card's address (`startAddress`), which is what the document belongs to. The existing arguments are as they were.

### F8. What the real-process derived scenario showed (2026-11-22; recorded, no spec change)

1. **A notary card is issued under one policy** (W10: its `issuer_card` must be the job's policy). The derive template therefore needs its own notary card from its holder, with its own genesis. The scenario creates one (`genesisFor` in `driver.ts`) and approves it in the template. Nothing to change; it is how the specs read.
2. **A release is judged at the boundary the attested clock is in** (`derive_pool_tick`: `boundary_at(now)`). A clock that jumps more than one batch interval past the offered boundary makes the batch stale and the holders are re-offered. The scenario warps to one minute past the boundary. This is the behaviour `advanceDerivedCard` handles (`re_offered`); it is noted here so the 7.3 operator docs say that a long outage means a re-offer.
3. **Test-only time control** added to notary test code: `POST /warp` on the sim chain, and the fake enclave's `FAKE_ENCLAVE_OFFSET_FILE` (milliseconds added to its real clock; unset in every other run). Nothing in `contracts/`, the runtime or a spec changed.
4. **Done in this scenario:** the wallet's source-policy read (`nonDerivableFields`) over the real chain; `JOB_FIELD_NOT_DERIVABLE` refused at job open by the enclave; the full `requestDerivedCard` flow; batch release and registration through the write gate; `CardVerifier` Stages 3, 4, 6 and the Stage 5 step 3a hook accepting all three cards, **including algorithm E over the identity log anchored at genesis** (the positive case F5 lacked); a scan that no host registration names a source card, with a control.
5. **`sealed_link` revocation through real processes (added the same day):** done in the same `derive` phase, with a certified source press, the host's policy-update relay and the enclave's watch loop. An update signed by an unapproved press revokes nothing (E4); two certified revocations are propagated as one batch with the mapped codes 820 and 920; a verifier sees ordinary revocations. The template used is `sealed_link` with the broker tests' short timing, not the "member as of date" variant. The anonymity set is 3, not the default 10.
6. **Found while building it (not changed; for your decision at 7.4):**
   - **`approved_presses` entries.** `certified_press_keys` (`notary-cards/src/policy.rs`) accepts an entry that is either a *registered card pointer* or a *CID of a plain press document*. For a pointer it reads the card's **first registry event** as the plain document, but registry heads are encrypted under the card's content key, so that read returns ciphertext and the press is skipped. The scenario therefore lists the press by the CID of its published plain document, which works. If production presses are registered cards (encrypted), listing them by pointer would silently certify nobody. Worth a spec line or a code change; I have not touched either.
     - **Decided (option 1+3), outcome:** the premise of option 1 did not hold. `press.md` §2 says a press card is a `CardDocument` published on IPFS whose **CID** is the `press_card` identifier, issued externally; the real press never registers it as an encrypted pointer card. So the CID form is the production form and the pointer branch only works for a plain-published genesis. Done: a listed pointer that resolves to a registered card whose first event is not a readable press document now returns `PRESS_UNREADABLE` instead of being skipped (`policy.rs`, test `a_pointer_to_a_card_whose_genesis_is_encrypted_is_an_error_not_a_silent_skip`; Rust workspace 195). An unregistered name stays a skip. **Still open:** the spec says `approved_presses` is a `card-pointer-array` (`card_protocol_spec.md:409`, `protocol-objects.md:266`) while `press.md` §2 uses the CID; spec aligned (approved): `card_protocol_spec.md` §1 and `protocol-objects.md` now say entries are press card document CIDs.
   - **Source entries must be canonical JSON.** The enclave opens a source card's update with `parse_canonical`, so an entry encrypted from non-canonical JSON is ignored without any signal. Presses produce canonical entries today; recorded for the 7.3 operator docs.
   - **Verified after the press change:** run-local, run-three, e2e vitest (19), vectors, isolation all pass. One caveat: the derive phase failed twice (release never happened) when run at 23:50–23:55 UTC, with the offered boundary at 00:00Z, and passed at 00:01 UTC. Cause not isolated (likely the release boundary crossing the UTC day, e.g. the P1D period or `issued_at`). Run the e2e outside the hour before UTC midnight until this is looked at; it may also bite a nightly CI run scheduled near 00:00 UTC.
   - **`run-three.sh` flakiness (investigated):** two intermittent failures were seen on 2026-11-22. (1) *formation* (`opened,handoff`): the announcement is signed once a quorum is live, and the test read the job log before the second receiver's handoff record landed. A test race; `driver3.ts` now waits (30 s) for both handoff records. (2) `NOTARY_NO_RECEIPT` for contributor 0 right after the announcement: seen once, not reproduced, cause not found; the driver now prints the receipt failure's reason, so a recurrence says why. After the change `run-three.sh` passed 3 of 3 in series. Note: overlapping runs collide on Docker container names (`notary-three-*`); never run two at once.
