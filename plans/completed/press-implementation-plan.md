# Press Implementation — Implementation Plan

**Date:** 2026-06-20
**Status:** Draft
**Companion document:** [press-strategic-plan.md](./press-strategic-plan.md)

Open questions OQ-A1 through OQ-A4 are all resolved. This plan proceeds from a complete spec.

---

## Clarification Checkpoints

Before reading further, note when Claude should stop and wait for your input:

- **CP-1:** Before creating any new directory or repository structure that doesn't already exist in `card_protocol/`.
- **CP-2:** Before writing any code that touches the Arbitrum One registry contract (contract calls, ABI definitions, secp256r1 signing). The contract address and ABI must be confirmed before implementation.
- **CP-3:** Before writing the `checkGasBalance` / `checkAppGasBalance` functions — confirm the gas estimation strategy (static estimates vs. `eth_estimateGas` per call).
- **CP-4:** Before writing the ETH transfer monitoring loop — confirm whether to use `eth_getLogs` polling or a WebSocket subscription.
- **CP-5:** Before running any integration test that posts to IPFS or submits a transaction on Arbitrum One — confirm test network targets (local anvil + IPFS mock, testnet, or other).

---

## Phase 1: Repository and Tooling Setup

### Step 1.1 — Scaffold the press package

**What:** Create `press/` under `card_protocol/` as a standalone Node.js package. Initialize `package.json`, `tsconfig.json`, `.eslintrc`, and the directory structure (`src/`, `src/handlers/`, `src/functions/`, `src/db/`, `src/chain/`, `src/ipfs/`, `dist/`, `tests/`).

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.1` (Dockerfile and image), `specs/ARCHITECTURE.md` (tech stack).

**Done when:** `npm install` succeeds; `tsc --noEmit` passes on an empty `src/index.ts`; `Dockerfile` builds cleanly.

---

### Step 1.2 — Implement environment validation

**What:** Write `src/config.ts`. On startup, validate all required env vars from the table in `specs/object_specs/press.md §3.2`. For each required variable: confirm it is present and non-empty; for key material (`PRESS_MLDSA44_PRIVATE_KEY`, `PRESS_SECP256R1_PRIVATE_KEY`, `W3UP_KEY`), confirm it decodes to the expected byte length. Exit with a human-readable error message naming the missing/malformed variable before opening the HTTP listener.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.2` (env var table and types).

**Done when:** A test that runs the process with a missing `PRESS_CARD_CID` env var confirms it exits with a non-zero code and prints the variable name.

---

### Step 1.3 — Implement SQLite schema and migrations

**What:** Write `src/db/schema.ts`. On startup, open `$DATA_DIR/press.db` in WAL mode and run the full schema from `specs/object_specs/press.md §3.3` (all six tables including `audit_epoch_aeks` and `app_gas_accounts`). Use a simple integer `schema_version` table to track migration state; run each migration in a transaction.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.3` (full SQL schema).

**Done when:** Starting the press with a fresh data directory creates all six tables; restarting does not re-run migrations; a schema version bump runs the new migration and increments the version.

---

### Step 1.4 — Wire up the HTTP server and health endpoint

**What:** Write `src/index.ts`. Start an Express (or Fastify) HTTP server on `$PORT` (default 3000). Register all route stubs (returning `501 Not Implemented` initially). Implement `GET /health`: return `200 { "status": "ok" }` only after SQLite migrations have run and the w3up space is reachable; return `503 { "status": "starting" }` otherwise.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §4` (HTTP endpoint table).

**Done when:** `GET /health` returns `503` during startup and `200` after both checks pass. All other endpoints return `501`.

---

### Phase 1 Milestone Review

**Context needed:** `press/src/config.ts`, `press/src/db/schema.ts`, `press/src/index.ts`, `specs/object_specs/press.md §3.1–3.4`.

**Done when:** All Phase 1 outputs reviewed for consistency (env var names match spec table, SQLite column names match spec, health check logic matches spec §3.4 startup sequence). A one-paragraph phase summary is written to `plans/milestones/press-phase-1-summary.md`. Proceed to Phase 2.

---

## Phase 2: Infrastructure Clients

### Step 2.1 — Implement the w3up / IPFS client

**What:** Write `src/ipfs/client.ts`. Implement `pinToIPFS(content: Uint8Array): Promise<string>` using `@web3-storage/w3up-client`. After upload, re-derive the expected CID from the content bytes and confirm it matches the returned CID. Return error `P-10` on mismatch. Implement `fetchFromIPFS(cid: string): Promise<Uint8Array>` via the w3up gateway.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.4` (w3up initialization and upload pattern), `§5.1 pinToIPFS`.

**Done when:** Unit test: upload known bytes, confirm returned CID matches expected; inject a mock that returns a wrong CID and confirm `P-10` is thrown.

---

### Step 2.2 — Implement the Arbitrum One registry client

**What:** Write `src/chain/registry.ts`. Implement wrappers for each contract call: `RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer`, `RegisterSubCard`, `DeregisterSubCard`, `BatchUpdateCardHeads`, `GetCardEntry`, `GetPressAuthorization`, `eth_estimateGas`. Each write call: build the payload, serialize as RFC 8785 JSON, sign `keccak256(payload_bytes)` with secp256r1, submit the transaction, wait for confirmation, return the tx hash. Handle `STALE_PREV_CID` (E-08) and `SEQUENCE_MISMATCH` (E-07) reverts with one retry each.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.8` (payload structures and signing), `specs/object_specs/registry_contract.md` (ABI and error codes). **Requires CP-2.**

**Done when:** Unit tests mock the ethers.js provider; test confirms secp256r1 signing and RFC 8785 serialization produce the expected bytes; revert simulation tests confirm retry logic on E-08 and surfaces `P-12` on second failure.

---

### Step 2.3 — Implement RFC 8785 canonical serialization

**What:** Write `src/serialization.ts`. Implement `canonicalize(obj: unknown): Uint8Array` following RFC 8785 rules (lexicographic key sort at all nesting levels, no whitespace, standard JSON escaping, UTF-8 output). Run against the conformance corpus at `specs/serialization-conformance.json` to confirm all 22 cases pass.

**Who:** Claude

**Context needed:** `specs/ARCHITECTURE.md ADR-010` (RFC 8785 rules and constraints), `specs/serialization-conformance.json`.

**Done when:** All 22 conformance cases pass. Test also confirms absent optional fields are omitted (not `null`) and binary fields use unpadded base64url.

---

### Step 2.4 — Implement `resolveCard` and content encryption/decryption

**What:** Write `src/functions/resolve.ts`. Implement `resolveCard(pointer: string): Promise<CardDocument>`: fetch the encrypted bytes from IPFS, identify `recipient_pubkey`, derive `content_key = HKDF-SHA3-256(recipient_pubkey, "card-content-v1")`, decrypt AES-256-GCM. Hard-reject on authentication failure. Implement the inverse: `encryptCard(cardDoc: CardDocument, recipientPubkey: Uint8Array): Uint8Array`.

**Who:** Claude

**Context needed:** `specs/ARCHITECTURE.md ADR-006` (content encryption scheme), `specs/object_specs/press.md §5.5 resolveCard`.

**Done when:** Round-trip test: encrypt a `CardDocument`, upload to mock IPFS, fetch and decrypt, confirm byte-for-byte equality with original.

---

### Step 2.5 — Implement AEK wrap/unwrap and audit_epoch_aeks persistence

**What:** Write `src/functions/aek.ts`. Implement `wrapAEK(aek: Uint8Array, mldsa44PrivKey: Uint8Array): { nonce: string, ciphertext: string }` and `unwrapAEK(nonce: string, ciphertext: string, mldsa44PrivKey: Uint8Array): Uint8Array`. Wrap key derivation: `HKDF-SHA3-256(mldsa44PrivKey, "aek-wrap-v1")`. Encryption: AES-256-GCM with 96-bit random nonce. Implement `persistAEK` (write to `audit_epoch_aeks`) and `recoverAEK` (read and unwrap on restart).

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.3 audit_epoch_aeks`, `§5.7 openAuditEpoch` steps 10–13.

**Done when:** Test: wrap an AEK, persist to SQLite, restart process (re-open DB), recover and unwrap, confirm equality with original AEK. Test also confirms the `audit_epoch_aeks` row is deleted after `closeAuditEpoch`.

---

### Step 2.6 — Implement ETH balance monitoring for app gas accounts

**What:** Write `src/chain/gas-monitor.ts`. On startup, subscribe to incoming ETH transfers to the press's Arbitrum address (via `eth_getLogs` polling or WebSocket, per CP-4). Parse `calldata` for a hex-encoded `app_card_address`. On confirmation, upsert the `app_gas_accounts` row. Implement `checkAppGasBalance(appCardAddress: string, operation: string): Promise<{ sufficient: boolean, sponsor: boolean }>`.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.3 app_gas_accounts`, `§5.10 checkAppGasBalance`. **Requires CP-4.**

**Done when:** Test simulates an incoming ETH transfer event with a valid `calldata` app card address and confirms the SQLite balance is updated; test also confirms a zero-balance app triggers `sponsor: true` for `DeregisterSubCard`.

---

### Phase 2 Milestone Review

**Context needed:** All `src/` files from Phase 2, `specs/object_specs/press.md §3.3–3.4, §5.5, §5.7–5.8, §5.10`.

**Done when:** All Phase 2 modules reviewed for consistency (RFC 8785 serialization used in all signing paths; AEK wrap/unwrap uses correct key derivation info string; app gas monitor reads `calldata` in the correct encoding). Any inconsistencies resolved in-place. One-paragraph summary to `plans/milestones/press-phase-2-summary.md`. Proceed to Phase 3.

---

## Phase 3: Core Press Functions

### Step 3.1 — Implement chain verification functions

**What:** Write `src/functions/verify.ts`. Implement:
- `checkRevocationStatus(cardPointerOrCid)` — walk log backward from head CID looking for 8xx–9xx codes; enforce staleness window with `P-17`.
- `verifyCardChain(cardPointer, trustedRoots)` — recursive chain walk using `ancestry_pubkeys`; confirm `keccak256(entry_pubkey)` matches on-chain address at each step; terminate at trusted root.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.5`, `specs/ARCHITECTURE.md ADR-006 §Ancestor Key Hint`.

**Done when:** Tests cover: valid chain reaching trusted root; revoked ancestor (P-04); forged `ancestry_pubkeys` entry (binding check fails → hard reject); stale revocation data (P-17 on mocked slow RPC call).

---

### Step 3.2 — Implement `evaluatePredicates` and rate limiting

**What:** Write `src/functions/predicates.ts` and `src/functions/rate-limit.ts`. 
- `evaluatePredicates`: check `requester_predicate` and `recipient_predicate` against resolved chains (P-02, P-03); call `checkRevocationStatus` for all chain links (P-04).
- `checkRateLimits` and `recordWrite`: 7-day rolling window logic per `specs/object_specs/press.md §5.9` and §6 rate limit table; `sendSuspiciousActivityAlert` on 80% threshold.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.9`, `§6` (rate limit table), `specs/process_specs/policy_creation.md` (predicate structure).

**Done when:** Tests: predicate satisfied (passes); predicate not satisfied (P-02 or P-03 returned); revoked ancestor mid-chain (P-04); rate limit at 100% of weekly limit (P-18); policy-level limit (P-19); 80% threshold triggers alert call.

---

### Step 3.3 — Implement card issuance functions

**What:** Write `src/functions/issuance.ts`. Implement the five functions in §5.1:
- `validateIssuanceRequest` — all pre-issuance checks in order.
- `assembleCardDocument` — build the complete unsigned card including `ancestry_pubkeys` population.
- `signCardDocument` — RFC 8785 canonicalize excluding `press_signature`, ML-DSA-44 sign, add signature.
- `publishCard` — derive content key, AES-256-GCM encrypt with fresh nonce, `pinToIPFS`, validate CID.
- `registerCardOnChain` — build and sign `RegisterCardPayload`, submit `RegisterCard`, await confirmation.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.1`, `specs/process_specs/card_offering_and_acceptance.md`, `specs/object_specs/protocol-objects.md §1` (CardDocument structure).

**Done when:** Integration test (against mock IPFS and mock contract): full targeted issuance flow produces a `CardDocument` with three valid ML-DSA-44 signatures; the press signature verifies against the assembled bytes; CID round-trips correctly.

---

### Step 3.4 — Implement SCIP issuance and log management

**What:** Write `src/functions/scip.ts` and `src/functions/log.ts`. Implement:
- `issueScip` — assemble, sign, and deliver SCIP to holder and optional admin wallet service endpoint.
- `getLogHead` — SQLite first, fallback to on-chain.
- `appendIssuanceRecord` — encrypt `PressIssuanceRecord` with epoch AEK, pin, append log entry, update on-chain head in a `BEGIN IMMEDIATE` transaction.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.1 issueScip`, `§5.6`, `specs/object_specs/protocol-objects.md §10 SCIP`, `§11 PressIssuanceRecord`.

**Done when:** Test confirms `appendIssuanceRecord` produces an AEK-encrypted outer envelope with `epoch_id` in plaintext; concurrent append test (two goroutines simultaneously) confirms only one wins per `BEGIN IMMEDIATE` and the other retries.

---

### Step 3.5 — Implement the `/issue` and `/issue/finalize` handlers

**What:** Wire up `src/handlers/issue.ts`. `POST /issue`: call `validateIssuanceRequest`; create and sign the offer-phase `CardDocument`; store in `offers_in_flight`. `POST /issue/finalize`: verify holder countersignature; call `assembleCardDocument`, `signCardDocument`, `publishCard`, `registerCardOnChain`, `appendIssuanceRecord`, `issueScip`, `recordWrite`.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.1`, `specs/process_specs/card_offering_and_acceptance.md`.

**Done when:** End-to-end handler test: POST `/issue` with a valid request returns a signed offer; POST `/issue/finalize` with a valid countersignature returns `{ card_cid, scip }` and mock IPFS has the encrypted card and SCIP; mock contract has the `RegisterCard` call recorded.

---

### Step 3.6 — Implement open offer processing

**What:** Write `src/handlers/open-offer.ts`. Implement `processOpenOfferClaim` per §5.2. This is the handler for `POST /open-offer/claim`. Key checks: verify offer issuer signature, verify recipient signature over `claim_payload`, pre-flight on-chain use count check (before any transaction), then assemble / sign / publish / register / log / SCIP.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.2`, `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md`.

**Done when:** Handler test: valid `OpenOfferClaimSubmission` returns `{ card_cid, scip }`; submitting the same claim twice returns P-07 or P-08 on the second request (not a duplicate registration); invalid issuer signature returns P-05.

---

### Step 3.7 — Implement update / revocation handler

**What:** Write `src/handlers/update.ts`. Implement `processUpdateIntent` per §5.3: verify intent signature (P-09); stale timestamp check; resolve target card and policy; evaluate update_policy predicate (P-11); rate limit check for 1xx codes; `appendLogEntry` → `updateCardHeadOnChain` with one retry on `STALE_PREV_CID`.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.3`, `specs/process_specs/card_updates.md`, `specs/specs/update_codes.md`.

**Done when:** Tests cover: valid 1xx field update succeeds; valid 9xx revocation creates a revocation log entry; invalid intent signature returns P-09; update_policy predicate not satisfied returns P-11; STALE_PREV_CID revert triggers one retry; second revert returns P-12.

---

### Step 3.8 — Implement sub-card registration/deregistration handlers

**What:** Write `src/handlers/sub-card.ts`. Implement `processSubCardRegistration` (§5.4): verify app signature, holder signature (P-13, P-14); `verifyAppCertificationChain` (P-15); rate limits (P-18); pin `SubCardDocument`; `registerSubCardOnChain`. Implement `processSubCardDeregistration`: verify holder master signature (P-14); gas check with sponsorship for zero-balance apps; `DeregisterSubCard`.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.4`, `specs/specs/subcards.md`, `specs/object_specs/protocol-objects.md §15`.

**Done when:** Registration test: valid `SubCardDocument` with T2 attestation succeeds; binding check failure (P-13); app chain not reaching governance root (P-15); rate limit hit (P-18). Deregistration test: zero-balance app triggers press sponsorship of gas.

---

### Step 3.9 — Implement audit epoch management

**What:** Write `src/functions/audit-epoch.ts`. Implement `openAuditEpoch`, `closeAuditEpoch`, `getOpenEpoch` per §5.7 — including: AEK generation, ML-KEM encapsulation to each auditor, `AuditEpochEntry` construction and signing, persistence to `audit_epoch_aeks`, on-chain head update, and the restart-recovery path in `getOpenEpoch` (step 3: unwrap AEK from SQLite).

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §5.7`, `specs/object_specs/protocol-objects.md §12 AuditEpochEntry`, `src/functions/aek.ts` (from Step 2.5).

**Done when:** Test: `openAuditEpoch` creates one `auditor_key_package` per auditor card; auditor can decapsulate the KEM ciphertext and decrypt the wrapped AEK; restart test (process killed mid-epoch) confirms `getOpenEpoch` recovers the AEK from SQLite without re-opening; `closeAuditEpoch` deletes the `audit_epoch_aeks` row.

---

### Phase 3 Milestone Review

**Context needed:** All `src/handlers/` and `src/functions/` files, `specs/object_specs/press.md §5`.

**Done when:** All 26 functions from the spec are implemented and findable in source. Every error code P-01 through P-24 appears in at least one test's expected output. Signing exclusion lists match the spec for `issuer_signature`, `holder_signature`, and `press_signature`. AEK deletion happens before memory zero (not after). Summary to `plans/milestones/press-phase-3-summary.md`. Proceed to Phase 4.

---

## Phase 4: Container, Operator UX, and Deployment

### Step 4.1 — Build the Docker image and operator startup validation

**What:** Finalize the `Dockerfile` (per `specs/object_specs/press.md §3.1`) and write a startup sequence in `src/index.ts` that validates in order: (1) all required env vars; (2) key material byte lengths; (3) SQLite migrations; (4) w3up space reachable; (5) Arbitrum One RPC responsive; (6) `getOpenEpoch` for each policy (recovering AEK if needed). Only after all six pass does the press open its HTTP listener. Failure at any step exits with a diagnostic message.

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.1, §3.2`, startup checklist from strategic plan Goal 4.

**Done when:** `docker build` succeeds; `docker run` with a bad `W3UP_SPACE` exits non-zero with "W3UP_SPACE: cannot reach configured space" before the port is bound; `GET /health` returns `503` until all six checks pass.

---

### Step 4.2 — Write operator documentation

**What:** Write `press/OPERATOR.md` covering: initial deployment (the `docker run` command from §3.1); env var reference; first-run checklist (keys, contract address, w3up credentials); SQLite backup (how and how often); key rotation for both key types (per §8); how to identify a failed audit epoch (symptoms, log messages, recovery steps).

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §3.1, §3.2, §8`, strategic plan Goal 4 objectives.

**Done when:** A reader who has never seen the press spec can follow the document from fresh host to running press in under 30 minutes. The key rotation section correctly describes both rotation types and references the governance steps.

---

### Step 4.3 — Integration test against local test stack

**What:** Write `tests/integration/` tests that run against: (a) a local `anvil` instance with the registry contract deployed; (b) a mocked w3up server that validates CID re-derivation; (c) a mocked wallet service endpoint to receive SCIPs. Run the full targeted issuance flow, open offer flow, and a 9xx revocation. Verify the on-chain state after each operation.

**Who:** Claude

**Context needed:** All handler implementations, `specs/object_specs/registry_contract.md` (ABI), `specs/process_specs/card_offering_and_acceptance.md`. **Requires CP-5.**

**Done when:** All three flows pass against the local stack; the revocation test confirms `checkRevocationStatus` returns `{ revoked: true }` after the 9xx log entry is written.

---

### Step 4.4 — Verify all P-01 through P-24 error codes are tested

**What:** Run a grep for each error code (P-01 through P-24 plus P-21 and P-22) across the test suite. For any code with no test, write one. Pay particular attention to: P-10 (CID mismatch after w3up upload), P-12 (concurrent log head), P-17 (stale revocation data), P-20 (insufficient ETH balance).

**Who:** Claude

**Context needed:** `specs/object_specs/press.md §7` (error code table), all test files.

**Done when:** Every error code from §7 appears in at least one test's expected output. The grep output showing all codes is included in `plans/milestones/press-phase-4-summary.md`.

---

### Phase 4 Milestone Review

**Context needed:** `press/OPERATOR.md`, `Dockerfile`, `tests/integration/`, `plans/milestones/press-phase-3-summary.md`, `specs/object_specs/press.md §7`.

**Done when:** Docker image builds and passes the integration test suite; all P-xx error codes covered; operator doc reviewed against actual startup behavior (no discrepancies between doc and code). Final summary to `plans/milestones/press-phase-4-summary.md`. Press is ready for deployment on a test network.

---

## Dependency Map

```
Phase 1 (scaffold) 
  → Phase 2 (infrastructure clients — can be parallelized across 2.1–2.6)
  → Phase 3 (core functions — Step 3.1 and 3.2 can start before Phase 2 finishes)
       3.3 depends on 3.1, 3.2
       3.4 depends on 3.3
       3.5 depends on 3.4
       3.6 and 3.7 depend on 3.2, 3.3, 3.4 (can run in parallel with 3.5)
       3.8 depends on 3.1, 3.2
       3.9 depends on 2.5, 3.4
  → Phase 4 (container + integration — all Phase 3 must complete first)
```

---

*Related specs: `specs/object_specs/press.md`, `specs/object_specs/protocol-objects.md`, `specs/object_specs/registry_contract.md`, `specs/process_specs/card_offering_and_acceptance.md`, `specs/process_specs/card_updates.md`, `specs/ARCHITECTURE.md`.*
