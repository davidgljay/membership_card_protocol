# Phase 2 (Integration Testing) Milestone Summary — harnesses and fixtures

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

Both SDK harnesses (`integration_tests/harnesses/web/`, `.../rn/`) complete
the same scripted end-to-end smoke test against the live stack: create a
wallet, accept a targeted offer, register a device sub-card tied to a real
membership card, and validate the resulting card's chain and revocation
status. Each passes twice consecutively. The shared fixtures package
(`integration_tests/fixtures/`, Task 2.1) underpins both.

Getting there required moving the stack's chain component off Sepolia onto
a local `nitro-devnode` (Phase 1 had deferred this — see
`plans/milestones/integration-phase-1.md`'s Goal 1 checklist) and fixing
**ten confirmed, independent bugs** this surfaced across five packages
(press, the registry contract, the shared verifier, app-sdk, wallet-sdk's
consuming code) — none of which any existing unit test suite (all mocked)
could have caught, since every one of them only manifests when a real
client drives the real stack end-to-end. Full list below.

## Chain component: Sepolia → local nitro-devnode

Phase 1 deferred this after finding "every call into a locally-deployed
contract reverts" — root-caused this phase as a **testing bug, not an
environment bug**: the Stylus SDK dispatches on the camelCase-converted
function selector (`verifySecp256R1`, not Rust's `verify_secp256r1`), and
`Vec<u8>` is ABI-encoded as `uint8[]`, not `bytes`. The wrong-cased/typed
test calls were hitting Stylus's unrecognized-selector fallback — real gas
consumption before a revert, which looked exactly like a genuine
WASM-execution failure. Confirmed empirically by redeploying fresh and
calling correctly, against both the official `nitro-devnode` baseline and
this repo's own image, with zero manual ArbOS/cache-manager tuning.

The stack now runs fully offline against a local chain (`docker-compose.yml`,
new `entrypoint.sh` wrappers reading dynamically-deployed contract
addresses, `deploy-contracts`'s `bootstrap.sh` made idempotent — see bug 3
below) instead of depending on Sepolia's continued availability. Backlog
Task #17 ("revisit local devnode Stylus call bug") is resolved and closed.

## Bugs found and fixed this phase

Each was found by running a **real** client end-to-end against a **real**
stack — the exact failure mode integration testing exists to catch.

1. **Press's OHTTP routes lived under Nitro's `server/api/**`** (prefixed
   `/api`) instead of `server/routes/**` (unprefixed) — every press-facing
   oblivious call 404'd on its key-config fetch. `press/server/routes/
   ohttp/*`.
2. **Relay never registered press's OHTTP target**, and press had no TLS
   termination for it (relay's oblivious-forwarding hard-requires
   `https://`) — sub-card registration's press-facing call was unroutable.
   New `press-tls` service, `oblivious_targets.json` entry.
3. **`deploy-contracts` silently redeployed fresh contracts on every
   `docker compose up`** that touched a dependent service, desyncing
   already-running press/wallet-service from anything reading
   `local.json` fresh afterward — the root cause of an earlier
   "issuer_chain_not_trusted" false alarm. `bootstrap.sh` now skips
   redeployment when the chain already has live code at the recorded
   address.
4. **Sub-card registration's wire format didn't match between app-sdk and
   press.** app-sdk sent a flat `SignedSubCardDocument`; press expected a
   `{sub_card_document, holder_signature}` wrapper with `{public_key,
   signature}` objects. Traced to press's own types being the actual
   outlier — inconsistent with the flat-string convention every other
   signature in the protocol uses — and fixed there instead of adding a
   second convention to app-sdk.
5. **`membership_card_verifier`'s `RpcProvider.getCardEventLog`/
   `isPolicyAuthorizer` were unimplemented** in press's adapter
   (`getLogEntries` was dead code the verifier package no longer even
   declares; `isPolicyAuthorizer` was a permanent stub always returning
   `false`). Implemented both for real: on-chain `CardRegistered`/
   `CardHeadUpdated` event replay, and the real `PolicyAuthorizerKeys`
   check plus a KV-backed fallback (new `POST /api/admin/trusted-roots`)
   for addresses that are legitimately trusted anchors but were never
   themselves registered as an on-chain policy — e.g. a harness's
   synthetic per-run root card.
6. **The deployed `RegisterSubCard` contract rejected its own spec's
   documented calling convention.** The non-DNS-admin path checked
   `admin_secp_signature.is_empty()` (Rust `Vec` length-0), but the spec
   requires callers send exactly `bytes[64](0)` — never actually empty.
   Every non-admin sub-card registration reverted. Fixed the check to
   test the real zero-sentinel value.
7. **`handleIssueFinalize` hardcoded `ancestry_pubkeys: []`** on every
   issued card regardless of what the offer declared ("Phase 3: ancestry
   chain walk deferred to Phase 4"), discarding data the offerer already
   set and signed — every issued card looked like its own trusted root to
   any verifier. Fixed to propagate `offer.ancestry_pubkeys` through, per
   `card_protocol_spec.md` step 8; nothing further needed re-validating,
   since `verifyIssuerSignature` already binding-checks it and runtime
   verifiers walk the chain independently at read time regardless.
8. **`CardVerifier.verifyCard()`'s Stage 4 (revocation) ran before its own
   pubkey-based chain resolution**, always feeding revocation checks a
   hardcoded empty-content stub even when real content had just been
   decrypted moments later in the same call. `chain_reaches_trusted_root`
   came out correct; `is_currently_valid` was stuck on `"skipped"`
   regardless. Reordered so Stage 4 runs after the pubkey branch.
9. **`RegisterSubCard`'s calldata was oversized enough to hit tx-size
   limits.** `master_sig_payload`/`master_signature` carried the holder's
   ~2420-byte ML-DSA-44 `SubCardDocument` signature in calldata, ABI-encoded
   as `uint8[]` (32 bytes per raw byte — Stylus's function-dispatch
   requirement, unrelated to packing) for "auditability" — but were never
   verified on-chain, never referenced in storage or events, and
   duplicated data the content-addressed `sub_card_doc_cid` already
   commits to. Removed both fields from the contract, spec, and press's
   client — bringing `RegisterSubCard` in line with `RegisterCard`/
   `UpdateCardHead`/`ClaimOpenOffer`, none of which carry a holder/issuer
   signature on-chain either.
10. **Device sub-card registration was structurally guaranteed to fail.**
    `setupWallet`'s automatic sub-card registration (Steps 7-9) used its
    own freshly-generated, never-on-chain account identity (`cardHash`) as
    `holder_primary_card` — but `RegisterSubCard`'s on-chain "master must
    exist" check requires a real `CardEntry`, and no wallet-sdk code path
    ever registers `cardHash` as one. Per `protocol-objects.md`,
    `holder_primary_card` is meant to be the holder's actual primary
    membership card, not an internal account key. Both harnesses now mint
    a second, real, on-chain-registered card specifically for this role
    and call `registerDeviceSubCard` against it directly, reporting that
    outcome as `subCardRegistered` instead of the always-doomed automatic
    attempt.

Full narrative and additional smaller fixes (rate-limit false-alarms during
iteration, a `serve.mjs` gzip-decompression content-length bug, the
Workers `nodejs_compat` `crypto.timingSafeEqual` gap in the new admin-auth
endpoint) are in the commit history — see `git log` on `main` for the
session's ~15 commits under `press:`, `contracts:`, `membership_card_
verifier:`, and `integration_tests:`.

## Fixtures — documented

`integration_tests/fixtures/README.md` updated this phase: documents the
new `governanceBootstrap.ts` (`ensureGovernanceBootstrap`, idempotent
`RegisterPolicy`/`AuthorizePress` + press gas funding for a fresh local
chain) and the "Prerequisites" section now describes the local-devnode
governance story instead of the superseded one-time Sepolia `cast send`
commands (kept for reference, since pointing the fixtures at Sepolia or
another pre-governed deployment still works unchanged).

## API mismatches between web and RN SDK providers

One real, confirmed mismatch, not a harness-only workaround:

- **`sdk-providers-rn`'s `ReactNativePasskeyProvider` never requests or
  extracts the WebAuthn PRF extension** — its `register()`/`assert()`
  never populate `prfOutput`. `sdk-providers-web`'s `WebAuthnPasskeyProvider`
  does (`extensions: { prf: { eval: { first: PRF_SALT } } }`), and
  `setupWallet`/`recoverWallet` hard-require `prfOutput` on the
  device-bound passkey registration (throw otherwise — `kdf.ts`'s
  `passkeyOutputFromPrf` has no fallback derivation). **In its current
  state, `sdk-providers-rn`'s default `PasskeyProvider` cannot complete
  `setupWallet` against a real device** — a caller must supply their own
  implementation that actually requests PRF, same as `wallet_sdk.md`'s
  already-documented (but stale-dated) note about the web provider's
  identical gap before it was fixed there. The RN harness works around
  this with a hand-rolled fake (`mockPasskeyProvider.ts`) rather than
  `ReactNativePasskeyProvider`, appropriate for a no-emulator jest harness
  either way — but the underlying `sdk-providers-rn` gap is real and
  affects actual RN apps, not just this harness. Not fixed this phase
  (fixing it means confirming `react-native-passkey`'s library actually
  supports the PRF extension and wiring the request/extraction through,
  which needs a real device or emulator to verify — out of scope for a
  jest-only harness phase). Tracked as follow-up work.

No other API-shape mismatches found: `StorageProvider`/`SecureKeyProvider`
constructors are symmetric between the two packages (`IndexedDBStorageProvider(namespace)`
↔ `AsyncStorageProvider(namespace)`, `WebCryptoSecureKeyProvider()` ↔
`SecureEnclaveKeyProvider()`, both no-arg) — confirmed by direct source
inspection, not just the harness's own empirical drop-in success.

## What's next

Phase 3 (`plans/integration-testing-implementation-plan.md`'s next
section): Wave 1 core card lifecycle tests against `specs/process_specs/`,
starting with `suites/core/card_signing.spec.ts`. The chain-of-trust,
sub-card registration, and revocation-check machinery both harnesses now
exercise end-to-end is exactly what those suites will build on.

Also worth scoping separately, not blocking Phase 3: closing
`sdk-providers-rn`'s PRF gap (above) against a real device/emulator.
