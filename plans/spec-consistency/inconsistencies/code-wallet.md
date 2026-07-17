# code-wallet: `specs/object_specs/wallet.md` vs. `wallet-service/` (excl. `matrix-policy-module/`)

Phase 3 Step A, spec-vs-code diff. Read-only review. Scope: `wallet-service/server/` and `wallet-service/src/` (including `src/matrix*`, `server/routes/matrix/*`), excluding `wallet-service/matrix-policy-module/`.

Overall: the spec is unusually well-verified — its own header is accurate that most of it traces directly to code. The pre-existing sections (§1–§6.5, §7.1–§7.9, §8, OQ-WALLET-1 through -5) check out against current code with only one trivial numeric slip. The two additions made *during this initiative* (§7.10 Matrix endpoints, §6.5.1 cardholder-signature verification) are where real divergences were found — one of them security-relevant.

---

## Finding 1 (ESCALATE TO DAVID — security-relevant): §6.5.1's sub-card-chain cardholder verification is not implemented

**Spec says** (§6.5.1, added today in this initiative):

> Verification confirms the `cardholder` entry's `public_key` resolves to the payload's `card_hash`, either directly or via a sub-card:
> - **Direct (master key):** `keccak256(public_key)` must equal `card_hash`.
> - **Sub-card chain:** if `public_key` is a device sub-card key rather than the master key, the verifying wallet service follows the sub-card chain (per `process_specs/card_migration.md §3` and `subcards.md`) to confirm it resolves to `card_hash`, then verifies the ML-DSA-44 signature against that sub-card key.

**Code has only the direct path.** `wallet-service/src/federation/binding.ts`'s `verifyAnnouncementEnvelope` (lines 91–104):

```ts
if (payload.type === 'card_migration') {
  const cardholderSig = signatures.find((s) => s.role === 'cardholder');
  if (!cardholderSig) { return { ok: false, reason: '...' }; }
  // cardholder signer is verified by keccak256(public_key) === card_hash
  if (keccak256OfBase64Url(cardholderSig.public_key).toLowerCase() !== payload.card_hash.toLowerCase()) {
    return { ok: false, reason: 'cardholder public key does not match card_hash' };
  }
  const cardholderValid = verifyMasterCardSignature(message, cardholderSig.signature, cardholderSig.public_key);
  ...
}
```

This unconditionally requires `keccak256(public_key) === card_hash` — i.e., only a direct master-key signature is ever accepted. There is no branch that resolves a sub-card key through the registry/IPFS chain (`getSubCardEntry` → `fetchSubCardDocument` → `recipient_pubkey`) the way §6.4's sub-card UUID registration path does. Confirmed by:
- `src/federation/binding.ts` and `src/federation/keyring-sync.ts` have zero references to `getSubCardEntry`, `fetchSubCardDocument`, or any sub-card chain-walk utility — those only appear in `src/auth/subcard-uuid-signature.ts`, `src/auth/subcard-deregistration-signature.ts`, `src/matrix/card-chain-verifier.ts` (a different, Matrix-only verifier), and `src/chain/subcard-registry.ts` itself.
- `test/binding.test.ts` only has two cardholder-signature tests (`requires a cardholder signature for card_migration, matching keccak256(pubkey) == card_hash` and `rejects a card_migration where the cardholder pubkey does not match card_hash`) — both exercise only the direct-master-key path. No test constructs a sub-card-signed migration announcement.

**Which side is correct:** Code is the actual, current behavior; the spec's sub-card-chain clause describes a capability that does not exist. This matters because `process_specs/card_migration.md §3` (which §6.5.1 itself cites as the source of the sub-card-chain requirement) apparently intends sub-card-initiated migration announcements to be valid — if so, any such migration announcement will be rejected by the current code with `401 Invalid announcement: cardholder public key does not match card_hash`, a functional gap, not just a documentation gap. Alternatively, if sub-card-initiated migration was never actually meant to work this way, then §6.5.1 (written today) overclaims and needs to be walked back to match the direct-only implementation.

Recommend: confirm with `card_migration.md §3` owner whether sub-card-initiated migration is a required capability. If yes, file a code bug (implement the chain-walk in `verifyAnnouncementEnvelope`, mirroring `src/auth/subcard-uuid-signature.ts`'s pattern) — auth-boundary code, do not silently patch as part of a spec-consistency pass. If no, the spec's sub-card-chain clause should be removed/corrected. Either way this is exactly the kind of auth-boundary divergence the Phase 3 instructions call out for direct escalation rather than folding into the routine fix list.

---

## Finding 2 (spec incomplete, not code-verified at write time): §7.10 omits two Matrix endpoints that exist in code

The spec's §7.10 documents exactly three endpoints: `POST /matrix/rooms`, `GET /matrix/room-index`, `POST /matrix/discover-rooms`. Code has two more under `server/routes/matrix/`:

- **`POST /matrix/token`** (`server/routes/matrix/token.post.ts`) — session-token-authenticated; provisions the caller's own shadow Matrix account and mints/returns a cached Matrix access token scoped to it (`{ matrix_access_token, matrix_user_id }`). Referenced by name in the spec's own §7.10 intro ("provisions shadow Matrix accounts... via the Application Service bridge") and by `rooms/index.post.ts`'s doc comment, but never given its own subsection or documented request/response shape.
- **`PUT /matrix/transactions/{txnId}`** (`server/routes/matrix/transactions/[txnId].put.ts`) — the Matrix Application Service transaction-push endpoint Synapse calls, authenticated via a bearer `hs_token` (`src/matrix/appservice-auth.ts`), currently a stub that just acknowledges receipt (`{}`, 200) without acting on the pushed events.

**Which side is correct:** Code is correct/intentional (both are real, deployed routes with their own doc-comments citing `matrix-implementation-plan.md` Phase 4 Steps 15a/15c); the spec is simply incomplete. This isn't a contradiction (nothing in the spec says these don't exist) but it is undocumented behavior per the Phase 3 charter ("extra undocumented behavior" is an explicit category to log). Not security-relevant by itself — `/matrix/token` only mints tokens for the caller's own already-authenticated shadow account, and `/matrix/transactions` is a stub gated by a bearer secret — but recommend adding both as §7.10 entries so the spec's "hosts a public room index... provisions shadow Matrix accounts" framing has endpoint-level backing like every other section.

---

## Finding 3 (trivial, confirmed): §5's migration count is stale

Spec §5 header: "PostgreSQL, schema managed via `node-pg-migrate` (`server/db/migrations/`), 8 migrations applied in sequence." Actual count in `wallet-service/server/db/migrations/`: **10** migrations — the original 8 plus `1772400800000_matrix-credentials.cjs` and `1772400900000_matrix-room-index.cjs`, both added for the §7.10/§5 `matrix_credentials` additions in this initiative's Phase 1. The `matrix_credentials` table description itself (added in Phase 1) is otherwise fully accurate against the migration file's actual columns (`credential_name` PK, `ciphertext`, `dek_enc`, `key_file_path`, `description`, `created_at`, `rotated_at` — exact match). Just the leading "8 migrations" count wasn't bumped when the two new migration files were added.

**Which side is correct:** Code. Trivial one-word fix (8 → 10).

---

## Open questions (OQ-WALLET-1 through -7): all re-verified against current code, all still accurate as written

No open question's stated gap has been silently resolved:

- **OQ-WALLET-1** (`POST /messages` has no sender auth) — confirmed. `server/routes/messages/index.post.ts` → `src/routes/messages-create.ts`'s `handleMessagesCreate` never calls any signature-verification function; it only validates presence of `to`/`subcard_hash`/`payload` and does a routing-table lookup. Still an open trust-boundary question, not a bug — code matches spec's description exactly.
- **OQ-WALLET-2** (old backup registrations not revoked on rotation) — confirmed. `server/routes/accounts/[card_hash]/keyring.put.ts` replicates the new blob and instructs peer deletion of the old `keyring_id` (`replicateKeyringBlob`/`replicateKeyringDelete`), but never touches `backup_registrations` rows at all — no revocation call exists.
- **OQ-WALLET-3** (no reconciliation sweep) — confirmed. `server/tasks/` contains only `prune-expired-uuids.ts`, `prune-routing-nonces.ts`, `prune-subcard-uuid-registration-nonces.ts`, `sweep-notification-retries.ts` — no keyring-blob reconciliation task.
- **OQ-WALLET-4** (audit-log test scan roots) — confirmed. `test/audit-log-schema.test.ts`'s `DEVICE_IO_ROOTS = ['server/routes/messages', 'server/routes/cards']` still excludes `src/routes/`, where `messages-create.ts`, `subcard-uuid-registration.ts`, `subcard-deregistration.ts` actually do their `console.info` logging. Manually re-checked all three `console.info` call sites: all log only `card_hash` (or aggregate counts) — no `subcard_hash`, IP, or session data — so the invariant still holds, exactly as the spec states.
- **OQ-WALLET-5** (KMS IAM policy is out-of-repo) — not independently verifiable from this repo, as the spec itself acknowledges; no change.
- **OQ-WALLET-6** (no offer/claim routes) — confirmed. No `offer`/`claim` route files anywhere under `server/routes/`. The only "offer"/"claim" string hits in `server/routes/**/*.ts` are unrelated (`auth/passkey/login.post.ts`'s WebAuthn "claim" wording context, `accounts/index.post.ts`, `bindings/announce.post.ts` — none are offer-hosting endpoints).
- **OQ-WALLET-7** (no migration-side message forwarding) — confirmed. `POST /bindings/announce` (`server/routes/bindings/announce.post.ts`) only calls `upsertRoutingEntry` on acceptance; no forwarding of `message_queue` rows to a new wallet service, and repo-wide search for forwarding logic near migration handling turns up nothing (`ohttp-gateway.ts`/`ohttp-router.ts` hits are unrelated OHTTP-forwarding, not migration message forwarding).

---

## Summary for the consolidated fix list

| # | Finding | Which side is right | Action |
|---|---|---|---|
| 1 | §6.5.1 sub-card-chain cardholder verification not implemented in `binding.ts` | Needs a decision — auth-boundary, security-relevant | **ESCALATE TO DAVID** — do not fold into routine fix list |
| 2 | §7.10 missing `POST /matrix/token` and `PUT /matrix/transactions/{txnId}` | Code (spec incomplete) | Add two subsections to §7.10 |
| 3 | §5 "8 migrations" is now 10 | Code | One-word fix in §5 header |
| — | OQ-WALLET-1 through -7 | All still accurate, no update needed | No action |
