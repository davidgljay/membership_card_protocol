# Phase 1, Step 1.3 — Auth and Crypto Inventory (from code, 2026-07-04)

Source: `wallet-service/src/auth/*.ts`, `wallet-service/src/secrets/*.ts`.

## Auth mechanisms

| Mechanism | File | Used by (cross-ref Step 1.1) | Notes |
|---|---|---|---|
| Master-card-key signature (`verifyMasterCardSignature`) | `src/auth/master-card-signature.ts` | `POST /accounts`, `PUT /accounts/{card_hash}/keyring`, `POST /recovery/{recovery_id}/cancel` | ML-DSA-44 verify over a server-issued challenge (or, for cancellation, the `recovery_id`'s own bytes). Explicit code comment: `@noble/post-quantum` has no independent security audit — accepted here because only ephemeral challenges are signed, no long-lived key material derived. |
| Session token (`issueSessionToken`/`verifySessionToken`) | `src/auth/session-token.ts` | `GET /accounts/{card_hash}/service-secret`, `POST /accounts/{card_hash}/backups`, `GET /accounts/{card_hash}/backups/{backup_id}` | HMAC-SHA256 over `{card_hash, issued_at, expires_at}`, 15-min TTL, `base64url(payload).base64url(hmac)`. Revocation via KV: single-token revoke (`sessionRevoked`) and a per-card-hash bulk cutoff (`sessionMinIssuedAt`, used by keyring rotation to invalidate every session issued before rotation without enumerating them). |
| WebAuthn passkey login (`verifyWebAuthnLogin`) | `src/auth/webauthn.ts` | `POST /auth/passkey/login` | Wraps `@simplewebauthn/server`'s `verifyAuthenticationResponse`; enforces monotonic sign-count (allows a counter of exactly 0 as a one-time exception for authenticators that never increment). |
| Peer wallet-service signature (`verifyPeerWalletSignature`) | `src/auth/peer-wallet-signature.ts` | Not directly called by any route file found in Step 1.1 — **`bindings/announce.post.ts` uses `verifyAnnouncementEnvelope` from `src/federation/binding.ts` instead**, and `federation/keyrings/*.post.ts` use `verifySignedKeyringMessage` from `src/federation/keyring-sync.ts`. Need to confirm in Phase 2 whether `peer-wallet-signature.ts` is dead code, used internally by those two modules, or superseded. |
| Sub-card signed envelope, registration (`verifyUuidRegistrationEnvelope`) | `src/auth/subcard-uuid-signature.ts` | `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` | Resolves the sub-card's public key via **on-chain registry (`SubcardRegistryClient.getSubCardEntry`) → IPFS fetch (`fetchSubCardDocument`) → `recipient_pubkey` field** (per `specs/subcards.md §Step 5` — a new spec reference to add to the object spec's relationship table). Confirms `keccak256(pubkey) == subcard_hash`, then ML-DSA-44 verifies over `canonicalize(payload)`. Explicitly does NOT check `SubCardEntry.active` — a deregistered-then-reregistering device must work identically to a never-registered one; on-chain revocation and wallet-local deregistration are independent by design (see doc comment, and `specs/process_specs/subcard_creation_policy.md`). |
| Sub-card signed envelope, deregistration (`verifySubcardDeregistrationEnvelope`) | `src/auth/subcard-deregistration-signature.ts` | `DELETE /cards/{card_hash}/subcards/{subcard_hash}` | Same resolution chain, reusing `resolveSubcardPubkey` from the registration module; payload omits `uuids`. |
| Admin bearer token | `server/utils/admin-auth.ts` (not yet read in this pass — file exists per Step 1.1's endpoint table) | All three `/admin/*` routes | Timing-safe compare per `phase-6-summary.md`; confirm implementation in Phase 2 if needed for the object spec's Authentication section. |

**Important note on `specs/subcards.md`**: this file was not in the strategic plan's original "Related Specs"/"Specs to verify and correct" list. It should be added — the sub-card pubkey resolution chain (on-chain registry + IPFS) is load-bearing for two endpoints' auth and isn't mentioned in any of the process specs originally scoped for Phase 2.

## Replay protection layers (separate from the auth mechanisms above, but load-bearing for the same endpoints)

- **Timestamp window**: ±5 minutes (`TIMESTAMP_WINDOW_MS`), applied to both sub-card envelope endpoints, checked in the route-logic modules (`src/routes/subcard-uuid-registration.ts`, `src/routes/subcard-deregistration.ts`), not in the signature-verification modules themselves.
- **Nonce**: `subcard_action_nonces` table, scoped `(subcard_hash, action, nonce)` — checked only after signature verification succeeds (so an unauthenticated caller can't burn a legitimate future nonce by probing).
- **Path/payload param matching**: the envelope's `payload.card_hash`/`payload.subcard_hash` must match the route's URL params — prevents replaying a validly-signed envelope for one subcard against a different subcard's URL.

None of this replay-protection layer is mentioned in `strategic-plan.md`/`implementation-plan.md`'s original Steps 5.1/5.2 — consistent with endpoint-inventory finding #2 (this whole auth tightening postdates the original plan).

## SecretsBackend (Goal 1 / OQ-WS-1 area)

Confirmed exactly as documented in `strategic-plan.md §Secret Storage: Two Different Trust Levels`:

- **Interface** (`src/secrets/backend.ts`): `wrapDek(dek): Promise<string>`, `unwrapDek(dekEnc): Promise<Buffer>`.
- **`SecretsService`** (`src/secrets/secrets-service.ts`): generates a random 256-bit DEK per `encryptSecret` call, AES-256-GCM-encrypts the plaintext under the DEK (12-byte IV prepended to ciphertext, wire format `base64url(iv || ciphertext+tag)`), wraps the DEK via the configured backend. `decryptSecret` unwraps (with a 10-minute in-memory DEK cache, `DEK_CACHE_TTL_MS`) and decrypts.
- **`WebCryptoBackend`** (default): 32-byte master key from config (`WEBCRYPTO_MASTER_KEY`), native Web Crypto AES-256-GCM, no external call.
- **`KmsBackend`** (opt-in, `SECRETS_BACKEND=kms`): AWS KMS `Encrypt`/`Decrypt` via `@aws-sdk/client-kms`, keyed by `KMS_KEY_ID`/`AWS_REGION`.
- **Selection** (`src/secrets/index.ts`): `createSecretsService(config)` throws if the selected backend's required config (`WEBCRYPTO_MASTER_KEY` or `KMS_KEY_ID`) is missing — fails closed, not silently defaulting.

No discrepancy found here — this matches the strategic plan precisely and can be documented in the object spec largely as already written there.
