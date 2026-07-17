# Press Implementation — Strategic Plan

**Date:** 2026-06-20
**Status:** Draft — awaiting open question responses
**Companion document:** [press-implementation-plan.md](./press-implementation-plan.md) *(to be written after open questions resolved)*

---

## Goals

### 1. Resolve the four open spec questions before writing a line of code — **STALE, all four now closed differently in spec v0.3; see "Open Questions" section below**

The press spec (`specs/object_specs/press.md`) originally had four explicit open questions (OQ-A1 through OQ-A4) that blocked specific functions. As of spec v0.3, all four are closed — notably, the audit epoch management feature that OQ-A1 and OQ-A3 were about no longer exists (replaced by direct auditor messaging). This goal and its rationale below are left as historical context; do not implement against them. See the "Open Questions" section for the current state and `specs/object_specs/press.md §9` for the authoritative list.

### 2. Build a correct, self-contained press container

The press is the single most trusted component in the protocol. Every card that enters the system passes through it. It holds two active signing keys, submits all on-chain writes, and is the only service that can forge valid `press_signature` values over card documents. Getting the implementation right — cryptographic operations, signature verification order, CID validation, on-chain revert handling, staleness checks — is more important than getting it done fast.

### 3. Cover the press's own threat surface with tests before deployment

The red-team findings (`red_teaming/`) identified the press key as the highest-value target in the whole system. An implementation that passes the spec's happy paths but has no test coverage for adversarial inputs (malformed signatures, replayed offers, stale revocation data, concurrent log-head races) is not ready to run against real policies. The press needs a test suite that exercises its rejection paths as thoroughly as its acceptance paths.

### 4. Make the press operationally runnable by a non-cryptographer

The design goal (per the project context) is operator-friendly deployment, analogous to Mastodon or Synapse, adapted to the press's serverless architecture (`specs/object_specs/press.md §3.1`): the press is a [Nitro](https://nitro.unjs.io) application, built once and deployable to Cloudflare Workers (the default target), AWS Lambda, or a self-hosted Node process, with all durable state in an external KV store rather than a local database. A press operator should be able to configure the deployment via env vars and have it running with correct behavior — without needing to understand ML-DSA-44 or UMBRAL. This means clear startup validation, actionable error messages, and a deployment experience that fails loudly when misconfigured rather than silently producing bad state.

---

## Rationale

### Why resolve open questions first

OQ-A1 asks where auditor ML-KEM-768 public keys live. The `openAuditEpoch` function won't compile correctly without this — it has to encapsulate the AEK to auditor KEM keys it can't yet find. Building `openAuditEpoch` with a placeholder means testing a fictional interface and then rewriting when the answer lands.

OQ-A3 (AEK recovery on press restart) has operational consequences: if the preferred path is "close and open a new epoch," that's a simple implementation; if it requires auditor coordination, the press needs an out-of-band recovery flow that is substantially more complex to build and test. This choice affects the external KV store schema, startup/cold-start code, and operator documentation.

OQ-A2 (app gas ledger) affects three functions: `checkAppGasBalance`, `registerSubCardOnChain`, and `processSubCardDeregistration`. Without knowing the funding mechanism, the gas ledger table can't be finalized.

OQ-A4 (RFC 8785 vs. CBOR) is referenced in `ARCHITECTURE.md` ADR-010 as unresolved. Every `buildPressSignedPayload` call and every signature verification function depends on this. If CBOR is chosen after the canonical serialization code is written, it is a near-total rewrite of the signing layer.

### Why test adversarial paths before happy paths are complete

The red-team plan (`plans/subcard_redteam_plan.md`, `red_teaming/`) established that the press is the highest-blast-radius compromise in the protocol. The implementation should be built test-first for rejection logic: invalid issuer signatures, mismatched CIDs from web3.storage, stale revocation data, replayed offer timestamps, concurrent `UpdateCardHead` races. These aren't edge cases — they are the primary failure modes for an adversary trying to manipulate card state.

### Why operator experience is a first-class goal

The press will be deployed by community organizations, mutual aid groups, and journalism outfits — not professional infrastructure teams. If the startup sequence doesn't catch a missing `W3UP_KEY` before the press silently attempts issuance requests and fails mid-flow with a cryptic error, an operator will lose trust in the system and not debug it. Startup validation, `GET /health` semantics, and the external KV store configuration (default: Cloudflare KV on the default Cloudflare deployment; operator-selectable for other presets) need to be designed with the assumption that the operator has never read the spec.

---

## Key Objectives

### Goal 1: Spec open questions resolved — **STALE, see "Open Questions" section**

These four bullets describe a resolution path (auditor KEM keys, SQLite gas table, AEK recovery) that spec v0.3 made moot by removing the audit-epoch/AEK mechanism and the SQLite model entirely. Left unedited as historical record; do not use as an implementation checklist.

### Goal 2: Correct press deployment

- All 26 functions defined in the press spec are implemented and pass their unit tests before the first deployment build (Cloudflare, Lambda, or Node).
- The CID validation step (`pinToIPFS` → re-derive → compare) is tested with a deliberately wrong CID injected at the mock layer; the test confirms `P-10` is returned.
- `updateCardHeadOnChain` handles the `STALE_PREV_CID` revert with one retry and surfaces `P-12` on second failure; this is covered by a test with a simulated concurrent writer.
- All on-chain writes are signed with the secp256r1 key and verified to use the correct `sequence` value from the contract before submission.

### Goal 3: Adversarial test coverage

- Every error code P-01 through P-24 has at least one test case that triggers it.
- The `evaluatePredicates` rejection paths (P-02, P-03, P-04) are tested with fabricated card chains that should fail but superficially look valid.
- The open offer replay attack is tested: submitting the same `OpenOfferClaimSubmission` twice confirms the second returns P-07 or P-08 (depending on capacity vs. expiry), not a duplicate registration.
- The `checkRevocationStatus` staleness check (P-17) is tested by mocking the RPC call to return after the staleness window.

### Goal 4: Operational usability

- The press validates all required env vars at startup (cold start) and exits/fails loudly with a human-readable error if any are missing or malformed before serving requests.
- `GET /health` returns `200` only after the w3up space is confirmed reachable and the external KV store is responsive; otherwise `503`.
- The local dev workflow in the press spec's §3.1 (`nitro dev`, with `NITRO_PRESET` build variants for Cloudflare/Lambda/Node) works end-to-end against a local test network (anvil + IPFS mock) with no manual steps beyond filling `press.env`.
- Operator documentation covers: initial deployment (default Cloudflare target, plus Lambda/Node alternatives), key rotation (both key types), external KV store configuration and backup, and how to identify and recover from a failed audit epoch.

---

## Open Questions — STALE, see note

**This entire section predates `specs/object_specs/press.md` v0.3 (dated 2026-06-25; this plan is dated 2026-06-20) and no longer reflects the current spec.** All four original questions are closed in the spec, with answers that don't match what's drafted below:

- **OQ-A1** (auditor KEM key storage) — closed. Auditor key distribution via ML-KEM is gone entirely; auditors are listed in `policy.auditors` and the press messages each one directly at issuance time over the normal routing layer. No KEM key storage question remains.
- **OQ-A2** (app gas ledger mechanism) — closed. Apps pre-fund gas by sending ETH directly to the press's Arbitrum address with `app_card_address` in the transaction calldata (`§3.3`, `app_gas` KV namespace).
- **OQ-A3** (AEK recovery on restart) — closed, and moot: **the audit epoch / AEK mechanism this question is about no longer exists.** It was replaced by the direct auditor messaging in OQ-A1's resolution. There is no AEK to recover.
- **OQ-A4** (canonical serialization) — closed. ADR-010 is Accepted; RFC 8785 (JCS) is adopted.

The spec has also introduced three new open questions not reflected anywhere in this plan: **OQ-B1** (KV backend driver — operator-selected, storage-driver-agnostic), **OQ-B2** (reconciliation job catch-up scheduling for large deployments), and **OQ-B3** (verifier `RpcProvider` must walk the CID-linked log chain from the head, since the registry contract only stores the head CID).

See `specs/object_specs/press.md §9` for the authoritative, current open-question list. **This strategic plan needs a full resync against spec v0.3** — the deployment-target change made in this pass (Nitro/Cloudflare default) is a small piece of a much larger drift (audit-epoch removal, w3up→Piñata IPFS provider switch, SQLite→external-KV, verifier-package delegation). That resync is a separate, larger task from today's change.
