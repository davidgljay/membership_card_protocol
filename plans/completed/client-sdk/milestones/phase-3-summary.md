# Phase 3 Milestone Review — Card Offer Creation, Acceptance, and Press Submission

**Date:** 2026-07-04
**Scope:** `client-sdk/packages/client-sdk/src/offers/` — offer construction and signing (Step 3.1), pre-display verification (Step 3.2), countersigning with the "persist before sign" invariant (Step 3.3), and all three acceptance paths (new-wallet open-offer, existing-wallet open-offer, targeted — Steps 3.4–3.6).

## Summary

`assembleAndSignTargetedOffer`/`assembleAndSignOpenOffer` produce offer-phase documents matching `protocol-objects.md`'s exact JSON shape, fixture-tested field-for-field, with the open-offer path additionally computing `offer_id` (`keccak256` of the complete signed document) and the short-form claim link. `reviewTargetedOffer`/`reviewOpenOffer` gate both offer types on binding checks, signature verification, chain/revocation status via the shared `CardVerifier`, and authoritative on-chain press authorization — always returning a typed `{ approved: false, code, reason }` rejection rather than a partial offer object on any hard-rejection condition, confirmed by fixture tests for every condition the spec calls out (binding mismatch, empty `ancestry_pubkeys`, invalid signature, chain not reaching a trusted root, press not authorized, a `CardVerifier` error surfacing as a rejection rather than an uncaught exception).

`acceptTargetedOfferAndCountersign`/`acceptOpenOfferAndCountersign` enforce "persist before sign" structurally: the internal keypair-generation-plus-keyring-write helper is not exported, so the only way anything in this SDK can reach a new card's secret key is by first awaiting a successful `StorageProvider.set` — confirmed by a test that mocks the write to fail and asserts no signature is ever produced (call-order assertions, not just final-state checks).

All three acceptance paths pass end-to-end against stub wallet-service/press instances reached through `ObliviousProtocolTransport`:
- **New wallet** (`acceptOpenOfferForNewWallet`): offer review → full Phase 2 wallet setup (via `setupWallet`'s new optional `postSetupHook<T>`, run once, inside `setupWallet`'s own scope, while `decryption_key` is still valid — no duplication of Phase 2's ~300-line body) → countersign → claim submission → SCIP. Confirms the keyring ends up holding both the wallet's master key and the new card's key, and that a rejected offer produces zero wallet-service or press calls.
- **Existing wallet** (`acceptOpenOfferForExistingWallet`): a much smaller function — no `setupWallet` call at all, per the spec's own "wallet setup skipped entirely" framing. Tested against a *real* existing wallet from an actual `setupWallet()` call (not a synthetic fixture), confirming the new card is added alongside the pre-existing master key without a second passkey (no `passkeyProvider` field exists on this function's option surface at all) and without this module ever deriving `decryption_key` itself (no `kdf.ts` import).
- **Targeted** (`acceptTargetedOffer` + `forwardCountersignedTargetedOffer`): the one path where the recipient never talks to the press directly — the countersigned card is returned for out-of-band delivery back to the offerer, who verifies `holder_signature` (reconstructing the signed payload from the offer *it* issued, plus only `recipient_pubkey`/`holder_signature` from what the recipient sent back, so a tampered echoed-back field can't reach the press even via an untrusted intermediary) before forwarding to `POST /issue/finalize`. End-to-end test confirms the completed card carries all three verifiable signatures (issuer, holder, press) and the finalization call only ever goes through the destination-parameterized oblivious transport.

178 tests pass in the `client-sdk` package (up from 146 at the end of Phase 2), 32 of them new in `test/offers/`; build/typecheck/lint are clean across the whole `client-sdk` workspace.

## "Done when" checklist

- All three acceptance paths pass end-to-end: yes (above).
- Step 3.3's "persist before sign" invariant test passes: yes (`test/offers/countersign.test.ts`).
- Code-search confirms no chain-walking logic exists outside calls into the shared `CardVerifier`: confirmed — `grep`ing `src/` for `isPolicyAuthorizer`/`trustedRoots`/`chain_reaches_trusted_root` shows the only production usage is reading `chain_reaches_trusted_root` off `CardVerifier.verifyCard()`'s own result in `offerVerification.ts`; nothing in this package calls the verifier package's on-chain trusted-root checks directly or walks an ancestry array beyond reading its own single `[0]` element (the issuer's own pubkey, for a binding check and signature verification — not a multi-hop chain walk). The direct `mlDsa44Verify` calls this package makes throughout (`issuer_signature`, `holder_signature`, `recipient_signature`) are single-payload protocol signature checks, not chain-walking, and mirror the same pattern already established in Phase 2 (`recovery.ts`'s cancellation signature, `subCardDeregistration.ts`'s master signature) — `CardVerifier`'s own public API has no primitive for "verify this arbitrary signature over this arbitrary payload" to delegate to.

## Notable design decisions this phase made

- **`setupWallet`'s `postSetupHook<T>`** (added for Step 3.4): a purely additive, generic hook run inside `setupWallet`'s existing try block, before `decryption_key` goes out of scope. Chosen over duplicating `setupWallet`'s body for the new-wallet acceptance flow, and over adding an ad hoc "unlock the wallet again" primitive (a materially larger feature this phase didn't need). Every pre-existing call site is unaffected (`T` defaults to `void`).
- **Caller-supplied `decryptionKey`** for the existing-wallet and targeted-recipient paths, and caller-supplied `policyAddress`/`ancestryPubkeys`/`previouslyActiveSubCards`-style inputs throughout this phase (consistent with Phase 2's own precedent): this SDK still has no general "unlock the wallet again after initial setup" primitive, nor a CID-to-policy-address resolver. Both remain open, tracked gaps rather than solved here — flagged again since Phase 3 leaned on them repeatedly.
- **Reconstructing signed payloads from trusted local state rather than trusting echoed-back objects** (`forwardCountersignedTargetedOffer`): a deliberate hardening beyond the letter of the spec's own wording, applied because the offerer is exactly the party positioned to hold the trusted original.

## What was **not** built in this phase (explicitly out of scope, not gaps)

- `POST /issue` (the initial targeted-issuance *request*, `card_offering_and_acceptance.md §Phase 1–2`) — Step 3.6 scopes explicitly to §Phase 5–6 (review/countersign/finalize); the request-and-predicate-evaluation phases are the press's own job, not something this client-sdk step needed to submit.
- SCIP `press_signature` verification — this phase parses and returns the SCIP; verifying it against a trusted press key is not exercised by any "Done when" criterion here and would need its own trusted-root resolution the same way offer verification does.
- Real recipient-to-offerer / offerer-to-press delivery channels for the countersigned card or claim link — out of scope throughout this phase, consistent with how offer *distribution* (Step 3.1's claim link, the invitation-link delivery in `open_offer_acceptance_new_wallet.md`) was already left to the host app.

## Next

Phase 4 (sub-card request, consent, countersigning, and revocation) proceeds next.
