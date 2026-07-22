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

### Established in Step 4.1 (`matrix-relay/matrix_room_membership.spec.ts`)

Matrix suites need real Matrix accounts and a real card-gated room, but
have their own wrinkle `core/` doesn't: this stack's Synapse has no
Application Service registered (a known, documented gap — see
`env/synapse/homeserver.yaml.template`'s own header comment), so
`wallet-service`'s `POST /matrix/token`/`POST /matrix/rooms` (the
"normal" way a client gets a shadow Matrix account and creates a
card-gated room) don't work here. Matrix suites bypass wallet-service
entirely rather than wire that gap closed:

- **`../support/matrixAdmin.ts`** — `registerMatrixUserViaSharedSecret(localpart)`
  registers a Matrix user directly via Synapse's admin shared-secret HMAC
  flow (`enable_registration`/`registration_shared_secret`, already wired
  in this stack for exactly this purpose). `createCardGatedRoom(...)`
  mirrors `wallet-service/src/matrix/room-creation.ts`'s
  `createMatrixRoomViaSynapse` byte-for-byte (same `initial_state` array:
  `m.room.join_rules: "public"`, `m.room.encryption` Megolm,
  `m.card.policy`, `m.room.power_levels` granting the enforcement account
  kick-level) — duplicated rather than imported, since wallet-service has
  no build output making it usable as a library dependency.
- **Why the bypass is a full substitute, not a partial one**: a card's
  shadow-account Matrix ID (`deriveMatrixUserId`/`verifyMatrixUserIdBinding`,
  `matrix_encryption.md §3`) is a pure function of the card's own keypair
  and the server name — nothing about it depends on *how* the account was
  provisioned. A user registered directly at the right `@card_<hex>:server`
  localpart is indistinguishable, from the policy module's point of view,
  from one wallet-service would have provisioned via its AS bridge.
- **Env vars** (all default to the local compose stack): `SUITE_SYNAPSE_URL`
  (`http://localhost:8008`), `SUITE_MATRIX_SERVER_NAME`
  (`matrix.integration-tests.local`), `SUITE_MATRIX_ENFORCEMENT_USER_ID`,
  `SUITE_MATRIX_REGISTRATION_SHARED_SECRET` (must match
  `docker-compose.yml`'s `synapse-init` service — a fixed, non-random dev
  value for exactly this reason; see `env/synapse/init.sh`'s comment on
  why it isn't randomly generated per stack start like Synapse's other
  secrets).
- **What's out of scope, and why, carried over from a direct precedent**:
  `wallet-service/test/integration/matrix-room-lifecycle.test.ts` (a
  near-identical suite run against wallet-service's own separate compose
  stack) already investigated — not assumed — that no scenario requiring a
  *satisfying* card (a join that succeeds because the card's chain
  genuinely resolves and matches a policy) is reachable in this
  environment: this stack's Synapse points its policy module at real
  Arbitrum Sepolia (`docker-compose.yml`'s `synapse-init` — deliberately
  not part of this stack's local-nitro-devnode migration, since matrix
  chain data was out of that migration's scope), and this repo has no IPFS
  pinning capability at all. What Step 4.1 tests instead: room
  creation/state (no chain dependency), and every join-deny path that
  doesn't need a real chain to resolve — including a **validly-signed,
  correctly-bound attestation for a card that doesn't exist on-chain**,
  which reaches further into the module's real logic than a
  malformed-attestation deny does. That scenario found a real, previously
  unknown bug (see the suite file's own comment and the Wave-2 report):
  the module's chain-walk path crashes with a Python
  `RuntimeError: await wasn't used with future` and the exception escapes
  as a raw `500` rather than the deny-by-default `403` the spec promises —
  logged as an `it.todo` plus a regression trip-wire test asserting the
  current (buggy) behavior, not silently worked around.

### Running

```sh
cd integration_tests
docker compose up -d --wait ipfs press synapse   # or the full stack
cd suites
npm install
npm test
```
