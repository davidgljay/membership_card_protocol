# suites/

Integration test suites, one file per process spec in `specs/process_specs/`,
organized by wave:

- `core/` — Wave 1: card lifecycle (card signing, offering/acceptance,
  validation, updates, open offers)
- `matrix-relay/` — Wave 2: matrix room membership/attestation, message
  routing, notification relay, room discovery
- `extended/` — Wave 3: remaining process specs (migration, backup/recovery,
  log auditing, oblivious transport, policy/subcard specs, DNS governance)
- `conformance/` — object-spec conformance checks not already covered by a
  named process suite

## Conventions

Established in Phase 3 Step 3.1 (first lifecycle test) and Phase 4 Step 4.1
(first matrix flow test). Documented here as each pattern-setting suite
lands.

### Established in Step 3.1 (`core/card_signing.spec.ts`)

- **One package for all of `suites/`** (this directory's `package.json`),
  not one per subdirectory — `npm test` here runs every suite via vitest.
  Each spec file is still one-file-per-process-spec; only the tooling is
  shared.
- **File naming**: `<process_spec_filename>.spec.ts`, e.g.
  `specs/process_specs/card_signing.md` → `core/card_signing.spec.ts`.
- **Spec traceability**: each `it(...)` name is prefixed with the spec
  phase/section it verifies (e.g. `'Phase 4: parallel co-signing — ...'`,
  `'Error path: rejects ...'`), so a failing test maps directly back to a
  spec paragraph without needing to read the test body first.
- **Live identities, not bare keypairs.** Suites needing a signed-in
  identity use `../support/liveCard.ts`'s `mintLiveCard(labelPrefix,
  fieldValues?)`, which mints a real, on-chain-registered card against the
  live press (governance bootstrap + policy pinning done once per process
  and memoized — see `ensureLiveGovernance`). This is what makes these
  tests *integration* tests rather than duplicates of each package's own
  unit tests: e.g. `card_signing.spec.ts` verifies signatures using
  `@membership-card-protocol/verifier`'s own vendored `canonicalize`/
  `mlDsa44Verify`, not `app-sdk`'s copies of the same code, to catch any
  drift between the two independently-vendored implementations.
- **Env vars** (all default to the local compose stack):
  `SUITE_PRESS_URL` (`http://localhost:3001`), `SUITE_KUBO_API_URL`
  (`http://localhost:5001`), `SUITE_ARBITRUM_RPC_URL`
  (`http://localhost:8547`).
- **Only pull in what the spec actually requires.** `card_signing.md`'s own
  postconditions only require signature verification "without a network
  call" — the suite therefore does *not* route through
  `CardVerifier.verifyEnvelope()` (which needs an `rpc`/`ipfs`-configured
  verifier and walks the full chain-of-trust/revocation machinery,
  Stages 2-6 — out of this spec's scope), only through the package's
  exported `canonicalize`/`mlDsa44Verify` primitives. A later suite
  covering chain-of-trust or revocation is the right place for
  `verifyEnvelope`/`verifyCard`.
- **Known gap logged, not fixed here**: `app-sdk`'s `MessageType` union
  (`messaging/envelope.ts`) doesn't yet cover `card_signing.md`'s full
  message-type taxonomy (`announcement`, `introduction`, `delete`, `flag`,
  the `api.*`/`mcp.*` machine types, `error`) — only `text`, `reply`,
  `edit`, `reaction`, `read_receipt`, and the card-lifecycle/auth types.
  The suite uses `text`/`edit` (already implemented) to exercise
  co-signing/edit/retract/forward mechanics independent of that gap. See
  the Phase 3 Wave-1 report for triage.

### Running

```sh
cd integration_tests
docker compose up -d --wait ipfs press   # or the full stack
cd suites
npm install
npm test
```
