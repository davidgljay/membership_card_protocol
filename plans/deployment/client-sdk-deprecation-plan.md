# client-sdk Deprecation Plan

Related: [strategic-plan.md](./strategic-plan.md) · [phase-3-summary.md](./phase-3-summary.md)

## Where client-sdk is still a real dependency

Only one package still depends on it: `integration_tests/suites/package.json`
declares `"@membership-card-protocol/client-sdk": "file:../../client-sdk/packages/client-sdk"`
alongside `app-sdk` (no `wallet-sdk` dependency at all today). `dev-tests/`
is already fully migrated — it depends only on `app-sdk`/`verifier` and has
zero client-sdk references. A stale `.github/workflows/client-sdk-ci.yml`
and a few doc-comment mentions in `app-sdk` (`RealtimeTransportProvider.ts`,
`MultiInstanceLock.ts`, `testing/providerContracts.ts`) reference client-sdk
in prose only — not functional dependencies, but worth cleaning up in the
same pass since they'll actively mislead readers once client-sdk is gone.

Five spec files in `integration_tests/suites/` import from client-sdk:

| File | Imports | Target after migration |
|---|---|---|
| `extended/wallet_backup_and_recovery.spec.ts` | `setupWallet, recoverWallet, initiateRecovery, cancelRecovery, releaseRecoveryKey, fetchKeyringBlob, registerBackup, wrapDecryptionKey, deriveDecryptionKey, passkeyOutputFromPrf` + types (`PasskeyProvider`, `StorageProvider`, `WalletAppCardIdentity`, `RegisterSubCardFn`, `WalletSetupResult`) | **wallet-sdk** — direct 1:1 equivalents already exist, no code changes needed |
| `matrix-relay/matrix_join_attestation_and_revocation.spec.ts` | `mlDsa44GenerateKeypair, keccak256` (→ app-sdk today) + `deriveMatrixUserId, buildJoinAttestation` (matrix module — **gap**) | app-sdk for crypto; new `matrix` module for the rest |
| `matrix-relay/room_discovery.spec.ts` | `mlDsa44GenerateKeypair, mlDsa44GetPublicKey, keccak256` (→ app-sdk) + `buildRoomDiscoveryEnvelope` (**gap**) | same |
| `matrix-relay/matrix_room_membership.spec.ts` | `mlDsa44GenerateKeypair, keccak256` (→ app-sdk) + `deriveMatrixUserId, buildJoinAttestation, JOIN_ATTESTATION_EVENT_CONTENT_KEY` (**gap**) | same |
| `conformance/matrix_encryption.spec.ts` | `mlDsa44GenerateKeypair, mlDsa44Sign, keccak256, canonicalize` (→ app-sdk) + `deriveMatrixUserId, verifyMatrixUserIdBinding, shadowAccountCommitment` (**gap**) | same |

## The gap: client-sdk's `matrix/` module has no replacement yet

`client-sdk/packages/client-sdk/src/matrix/` (`account-id.ts`,
`attestation.ts`, `discovery.ts`, `crypto-provider.ts`, `session.ts`,
`signed-room-events.ts`) was never ported when app-sdk/wallet-sdk split off
client-sdk's other modules. This is the one piece of real porting work
required — 4 of 5 spec files block on it.

The module's functions split cleanly along the same key-custody line
app-sdk/wallet-sdk already use elsewhere:

- **Key-independent (→ app-sdk `matrix/`)**: `deriveMatrixUserId`,
  `verifyMatrixUserIdBinding`, `shadowAccountCommitment`,
  `evaluateRoomPredicate`, `hexToBytes`, plus the `discovery.ts`/
  `attestation.ts` types (`RoomIndexEntry`, `JoinAttestationPayload`, etc.)
  and `JOIN_ATTESTATION_EVENT_CONTENT_KEY`. None of these take a private
  key.
- **Key-custody (→ wallet-sdk `matrix/`)**: `buildJoinAttestation`,
  `buildRoomDiscoveryEnvelope`, `discoverRooms` — each takes
  `cardSecretKey: Uint8Array` directly and signs with it, matching how
  wallet-sdk already owns every other raw-private-key operation (wallet
  setup, offer countersigning, subcard consent). `crypto-provider.ts` and
  `session.ts` (Matrix client wiring) belong with wallet-sdk too, since they
  consume the signed envelopes these functions produce.

This mirrors the existing app-sdk/wallet-sdk split exactly (app-sdk =
construction/verification logic anyone can run, wallet-sdk = anything that
touches a secret key), so it's a port, not a new design.

## Steps

1. **Port `matrix/` into app-sdk and wallet-sdk.**
   - Create `app-sdk/packages/app-sdk/src/matrix/` with `account-id.ts`
     (`deriveMatrixUserId`, `verifyMatrixUserIdBinding`,
     `shadowAccountCommitment`, `hexToBytes`) and the predicate/type pieces
     of `discovery.ts` (`evaluateRoomPredicate`, `RoomIndexEntry`,
     `RoomIndexResponse`, `RoomPredicatePolicyEntry`, `RoomPredicateDocument`,
     `CardChainVerifier`). Export from app-sdk's `src/index.ts`.
   - Create `wallet-sdk/packages/wallet-sdk/src/matrix/` with
     `attestation.ts` (`buildJoinAttestation`,
     `JOIN_ATTESTATION_EVENT_CONTENT_KEY`, `JoinAttestationPayload`,
     `JoinAttestationEnvelope`), the signing half of `discovery.ts`
     (`buildRoomDiscoveryEnvelope`, `discoverRooms`, `DiscoverRoomsOptions`),
     `crypto-provider.ts`, and `session.ts`. Import
     `deriveMatrixUserId`/`evaluateRoomPredicate` from app-sdk rather than
     duplicating them (mirrors how wallet-sdk's `offers`/`subcards` already
     depend on app-sdk). Export from wallet-sdk's `src/index.ts`.
   - Port each module's existing unit tests (`client-sdk/.../matrix/*.test.ts`)
     alongside the code, split the same way.
   - Delete `client-sdk/packages/client-sdk/src/matrix/` once both halves
     are ported and passing.

2. **Migrate `wallet_backup_and_recovery.spec.ts`** — swap the
   `@membership-card-protocol/client-sdk` import for
   `@membership-card-protocol/wallet-sdk`. No logic changes; every symbol
   it uses already exists there under the same names.

3. **Migrate the 4 matrix specs** — split each spec's client-sdk import
   into an app-sdk import (crypto + key-independent matrix fns) and a
   wallet-sdk import (`buildJoinAttestation`/`buildRoomDiscoveryEnvelope`).
   Update doc-comments referencing `client-sdk`'s functions by name
   (each file has 1-3 such comments) to point at the new package.

4. **Update `integration_tests/suites/package.json`** — drop the
   client-sdk dependency, add
   `"@membership-card-protocol/wallet-sdk": "file:../../wallet-sdk/packages/wallet-sdk"`
   (app-sdk dependency already present).

5. **Clean up stale doc-comment references** — update the doc-comment
   mentions in `app-sdk/src/providers/RealtimeTransportProvider.ts`,
   `MultiInstanceLock.ts`, and `testing/providerContracts.ts`, which name
   long-renamed packages `client-sdk-web`/`client-sdk-rn`/
   `client-sdk/testing` (now `sdk-providers-web`/`sdk-providers-rn`/
   `app-sdk/testing`). `.github/workflows/client-sdk-ci.yml` stays — it
   CIs the `client-sdk` package itself, which still exists and isn't being
   deleted by this plan (only its `matrix/` module moves out, step 1).

6. **Delete `client-sdk/packages/client-sdk/src/matrix/`** (and its tests)
   once both halves are ported to app-sdk/wallet-sdk and passing, and
   `integration_tests` no longer imports it — it's now dead, duplicated
   code inside the client-sdk package itself. **Out of scope for this
   plan: deleting the rest of the `client-sdk` package.** Only
   `integration_tests` was found to depend on it (see above);
   `client-sdk`'s own CI (`.github/workflows/client-sdk-ci.yml`) still
   builds and tests it standalone, and this plan has no evidence on
   whether anything outside this repo (a published npm consumer) still
   depends on it. Retiring the package entirely is a separate, larger
   decision than redirecting this repo's own integration tests off it —
   flag it to David rather than deleting unilaterally.

## Ordering / risk notes

- Step 1 is the only step with real engineering risk (porting Matrix
  attestation/discovery crypto correctly); steps 2-4 are mechanical import
  swaps once step 1 lands.
- Step 2 can ship independently and immediately — it has no dependency on
  the matrix port.
- Do steps 3-4 together per spec file (or all at once) so
  `integration_tests` never sits with a half-migrated package.json.
- Step 6's matrix/ deletion is gated on a full green `integration_tests`
  run — don't delete even that much client-sdk source until nothing
  imports it. The rest of the package is not this plan's to remove.
