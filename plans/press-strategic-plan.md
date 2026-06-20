# Press Implementation — Strategic Plan

**Date:** 2026-06-20
**Status:** Draft — awaiting open question responses
**Companion document:** [press-implementation-plan.md](./press-implementation-plan.md) *(to be written after open questions resolved)*

---

## Goals

### 1. Resolve the four open spec questions before writing a line of code

The press spec (`specs/object_specs/press.md`) has four explicit open questions (OQ-A1 through OQ-A4) that block specific functions. Two of them (OQ-A1, OQ-A3) block correct implementation of audit epoch management — a feature whose correctness matters for long-term auditability. The other two (OQ-A2, OQ-A4) affect the gas ledger and the serialization format used in every signed payload. Proceeding without resolving these risks building the wrong thing and having to rewrite significant sections.

### 2. Build a correct, self-contained press container

The press is the single most trusted component in the protocol. Every card that enters the system passes through it. It holds two active signing keys, submits all on-chain writes, and is the only service that can forge valid `press_signature` values over card documents. Getting the implementation right — cryptographic operations, signature verification order, CID validation, on-chain revert handling, staleness checks — is more important than getting it done fast.

### 3. Cover the press's own threat surface with tests before deployment

The red-team findings (`red_teaming/`) identified the press key as the highest-value target in the whole system. An implementation that passes the spec's happy paths but has no test coverage for adversarial inputs (malformed signatures, replayed offers, stale revocation data, concurrent log-head races) is not ready to run against real policies. The press needs a test suite that exercises its rejection paths as thoroughly as its acceptance paths.

### 4. Make the press operationally runnable by a non-cryptographer

The design goal (per the project context) is operator-friendly self-hosted deployment, analogous to Mastodon or Synapse. A press operator should be able to deploy the container, configure it via env vars, and have it running with correct behavior — without needing to understand ML-DSA-44 or UMBRAL. This means clear startup validation, actionable error messages, and a `docker run` experience that fails loudly when misconfigured rather than silently producing bad state.

---

## Rationale

### Why resolve open questions first

OQ-A1 asks where auditor ML-KEM-768 public keys live. The `openAuditEpoch` function won't compile correctly without this — it has to encapsulate the AEK to auditor KEM keys it can't yet find. Building `openAuditEpoch` with a placeholder means testing a fictional interface and then rewriting when the answer lands.

OQ-A3 (AEK recovery on press restart) has operational consequences: if the preferred path is "close and open a new epoch," that's a simple implementation; if it requires auditor coordination, the press needs an out-of-band recovery flow that is substantially more complex to build and test. This choice affects the SQLite schema, startup code, and operator documentation.

OQ-A2 (app gas ledger) affects three functions: `checkAppGasBalance`, `registerSubCardOnChain`, and `processSubCardDeregistration`. Without knowing the funding mechanism, the gas ledger table can't be finalized.

OQ-A4 (RFC 8785 vs. CBOR) is referenced in `ARCHITECTURE.md` ADR-010 as unresolved. Every `buildPressSignedPayload` call and every signature verification function depends on this. If CBOR is chosen after the canonical serialization code is written, it is a near-total rewrite of the signing layer.

### Why test adversarial paths before happy paths are complete

The red-team plan (`plans/subcard_redteam_plan.md`, `red_teaming/`) established that the press is the highest-blast-radius compromise in the protocol. The implementation should be built test-first for rejection logic: invalid issuer signatures, mismatched CIDs from web3.storage, stale revocation data, replayed offer timestamps, concurrent `UpdateCardHead` races. These aren't edge cases — they are the primary failure modes for an adversary trying to manipulate card state.

### Why operator experience is a first-class goal

The press will be deployed by community organizations, mutual aid groups, and journalism outfits — not professional infrastructure teams. If the startup sequence doesn't catch a missing `W3UP_KEY` before the press silently attempts issuance requests and fails mid-flow with a cryptic error, an operator will lose trust in the system and not debug it. Startup validation, `GET /health` semantics, and the SQLite backup story need to be designed with the assumption that the operator has never read the spec.

---

## Key Objectives

### Goal 1: Spec open questions resolved

- OQ-A1 answered: auditor KEM key storage location is specified in `protocol-objects.md` or as a new ADR; the press spec's `openAuditEpoch` function is updated with the definitive approach.
- OQ-A2 answered: the app gas ledger mechanism (direct ETH transfer, signed credit request, or other) is specified; the SQLite schema gains the `app_gas_accounts` table.
- OQ-A3 answered: the preferred AEK recovery path on press restart is documented in the spec; startup code implements it.
- OQ-A4 answered: either RFC 8785 is confirmed (an ADR is created or ADR-010 is updated to "resolved: RFC 8785") or CBOR is chosen and the spec's serialization references are updated before implementation begins.

### Goal 2: Correct press container

- All 26 functions defined in the press spec are implemented and pass their unit tests before the first container build.
- The CID validation step (`pinToIPFS` → re-derive → compare) is tested with a deliberately wrong CID injected at the mock layer; the test confirms `P-10` is returned.
- `updateCardHeadOnChain` handles the `STALE_PREV_CID` revert with one retry and surfaces `P-12` on second failure; this is covered by a test with a simulated concurrent writer.
- All on-chain writes are signed with the secp256r1 key and verified to use the correct `sequence` value from the contract before submission.

### Goal 3: Adversarial test coverage

- Every error code P-01 through P-24 has at least one test case that triggers it.
- The `evaluatePredicates` rejection paths (P-02, P-03, P-04) are tested with fabricated card chains that should fail but superficially look valid.
- The open offer replay attack is tested: submitting the same `OpenOfferClaimSubmission` twice confirms the second returns P-07 or P-08 (depending on capacity vs. expiry), not a duplicate registration.
- The `checkRevocationStatus` staleness check (P-17) is tested by mocking the RPC call to return after the staleness window.

### Goal 4: Operational usability

- The press validates all required env vars at startup and exits with a human-readable error if any are missing or malformed before opening the HTTP listener.
- `GET /health` returns `200` only after the w3up space is confirmed reachable and the SQLite database has migrated successfully; otherwise `503`.
- The `docker run` example in the press spec's §3.1 works end-to-end against a local test network (anvil + IPFS mock) with no manual steps beyond filling `press.env`.
- Operator documentation covers: initial deployment, key rotation (both key types), SQLite backup and restore, and how to identify and recover from a failed audit epoch.

---

## Open Questions

These must be answered before the implementation plan is finalized and before code is written.

**OQ-A1 — Auditor KEM key storage**
Where does the auditor's ML-KEM-768 public key live? Options:
- A dedicated `kem_pubkey` field in the auditor's `CardDocument` (requires protocol-objects spec update)
- A separate KEM key document on IPFS, referenced from the auditor's card (requires resolver logic)
- Derived from the ML-DSA-44 key (not recommended — different security properties)

This determines what `openAuditEpoch` fetches and how it identifies the auditor's encapsulation key.

**OQ-A2 — App gas ledger mechanism**
How do apps pre-fund their gas balance with the press? Options:
- Direct ETH transfer to the press's Arbitrum address, with the press tracking balances by `app_card_address` in SQLite
- A signed credit request (the governance body authorizes a credit; the press records it)
- The press sponsors all sub-card operations and bills out-of-band

This determines the `app_gas_accounts` SQLite table structure and whether the press needs an inbound ETH-tracking flow.

**OQ-A3 — AEK recovery on press restart**
If the press restarts unexpectedly during an open epoch, the AEK is lost from memory. Preferred recovery path:
- Option A: Close the interrupted epoch immediately on restart and open a new one (simpler, loses some audit continuity for entries in the interrupted epoch that can't be re-encrypted)
- Option B: Require auditor coordination to re-supply the AEK via decapsulation (operationally complex; needs a recovery endpoint and a ceremony)

This affects startup code, the SQLite `audit_epochs` schema, and operator documentation.

**OQ-A4 — Canonical serialization format**
ADR-010 in `ARCHITECTURE.md` is listed as unresolved. This spec proceeds assuming RFC 8785 (JCS). Is RFC 8785 confirmed, or is CBOR still under consideration? This affects every signing function in the press and must be settled before implementation begins.
