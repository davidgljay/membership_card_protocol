# membership-card-verifier — Deferred TODOs

Non-urgent improvements to the verifier package (TS + Python), noted while
building consumers against it rather than acted on immediately, since fixing
them now would mean refactoring an already-shipped, tested package for a
distinction no current caller actually needs yet.

---

## 1. `evaluate_policy_match` collapses distinct failure reasons into one `False`

**Where:** `evaluate_policy_match(chain, conditions) -> Optional[bool]` (`policy_match.py` / TS equivalent), and by extension every field that surfaces its result (`policy_match` on `EnvelopeVerificationResult`/`SignatureVerificationResult`/`CardVerificationResult`).

**The problem:** a caller gets `True`, `False`, or `None` (conditions not supplied) — nothing else. `False` is returned for at least two meaningfully different situations that a caller currently cannot distinguish from the return value alone:

1. **No card in the chain was issued under the requested `policy_id` at all** — the chain simply doesn't include that policy anywhere.
2. **A card in the chain *was* issued under the requested `policy_id`, but its fields don't satisfy the supplied `field_match` conditions** — the policy matched, the field check didn't.

These are different failure modes with different operational meaning (one says "wrong credential entirely," the other says "right credential, doesn't currently qualify") but today's boolean return makes them indistinguishable to any caller — including `matrix-policy-module`'s `predicates.py`, which currently just treats any `False` as "this policy entry didn't match" without being able to say *why*, and can't surface a more specific deny reason in its own logs as a result.

**Why this hasn't been fixed:** distinguishing these would mean changing `evaluate_policy_match`'s return shape (e.g. a small result type or reason enum instead of a bare `bool`) across a package that's already shipped with 101 TS tests / 130 Python tests built against the current boolean contract, for a distinction no current consumer (`matrix-policy-module`, `client-sdk`'s `discoverRooms`) actually needs today — every current call site only needs "did it match," not "why didn't it."

**Recommendation for whenever this is revisited:** replace the bare `bool` with a small tagged result (e.g. `{ matched: bool, reason?: "no_policy_match" | "field_mismatch" }`, or an equivalent discriminated type per language), keep a boolean-coercion path for existing callers that don't care, and add reason-specific test cases to both language's suites plus the cross-language interop vectors. Not blocking anything today — revisit if/when a caller (e.g. richer audit logging, or a future UI surfacing *why* a card doesn't qualify for a room) actually needs the distinction.

**Raised:** 2026-07-12, during Phase 3 (`matrix-policy-module`) build-out.

---

## 2. `verifyCard`/`verify_card` can never return chain data — even with `returnChain: true` — and this caused a real, shipped bug

**Where:** `CardVerifier.verifyCard()` (TS, `packages/verifier/src/CardVerifier.ts`) / `CardVerifier.verify_card()` (Python, `packages/verifier-py/.../card_verifier.py`). Both are intentionally, correctly identical: given a bare card address with no known public key, neither can decrypt that card's `CardDocument` (decryption requires the pubkey), so `chain: ChainLink[]` is hardcoded to `[]` unconditionally — `returnChain: true` has no effect on this path at all, unlike `verifyEnvelope`/`verify_envelope`, which does populate a real chain from Stage 3 when a full signed envelope (carrying the pubkey via its signature) is available.

**This is not, by itself, a bug** — it's a correct consequence of the address-only input `verifyCard` accepts. `matrix-policy-module`'s `chain_context.py` documents this exact limitation and correctly avoids relying on `verify_card`'s chain for anything (its use there — the watcher's post-time revocation re-check — only ever needs `revocation`/`is_currently_valid`, never `chain`, since chain topology was already captured once at join time via `verify_envelope`).

**What went wrong (confirmed 2026-07-12, during Phase 4 milestone review, flagged by David):** Phase 4 Step 16b (`client-sdk`'s `discoverRooms`) and Step 16c (`wallet-service`'s server-side mirror) both called `cardVerifier.verifyCard(cardHash)` expecting a populated `chain`, on the mistaken assumption that `returnChain`/the verifier's own config would make this work the same way it does for `verifyEnvelope`. It doesn't and structurally can't. The result: both discovery functions **always received an empty chain**, meaning `evaluateRoomPredicate` **always evaluated false**, meaning **both discovery paths reported zero eligible rooms for every card, unconditionally** — a total functional failure, not a partial gap. It shipped with passing tests because both test suites mocked `verifyCard` to directly return a fabricated `chain`, never exercising the real `CardVerifier.verifyCard()` implementation this bug lived in.

**Fixed same-day, but the two call sites needed genuinely different fixes, not one shared patch:**
- **Step 16b (`client-sdk`)** — the caller (a card holder, running client-side) always holds their own card's private key, so it now constructs and signs a minimal self-attestation envelope locally (`buildRoomDiscoveryEnvelope`, exported from `client-sdk/packages/client-sdk/src/matrix/discovery.ts`) and calls `verifyEnvelope`, not `verifyCard` — the same shape Step 10/12's join-attestation chain-walk already correctly uses.
- **Step 16c (`wallet-service`)** — this one is *not* a simple call-site swap: `wallet-service` never holds a card's private key (by design — private keys stay client-side across this whole protocol), so it structurally cannot construct or sign an envelope itself, even though it's the one doing the chain-walk. The actual fix changes the endpoint's request shape: `POST /matrix/discover-rooms` now requires the caller to submit an already-signed envelope in the request body (built client-side via the same exported `buildRoomDiscoveryEnvelope` — signing needs only the local private key, no RPC/IPFS access, so this doesn't reintroduce the "needs local chain-walk capability" problem this fallback endpoint exists to avoid). The server then verifies the envelope's signature is genuinely valid *and* that its recovered `signer_card` matches the authenticated session's own `card_hash` (mirroring `matrix-policy-module/attestation.py`'s sender-binding discipline — never trust a claimed identity when the verified value is available) before trusting its chain data. This was a real gap in `room_discovery.md §3`'s own spec text, not just an implementation shortcut — the spec's original `{ "card_hash": "..." }`-only request body assumed the server could chain-walk from an identity alone, which was never actually possible once you trace through what `verifyEnvelope`/`verifyCard` each need.

**Recommendation for whenever this is revisited:** give `verifyCard`/`verify_card` an optional parameter (e.g. a caller-supplied public key, or an already-known `CardDocument`) that lets it populate a real chain when the caller *does* have more than a bare address available — falling back to today's `chain: []` behavior only when no such extra input is supplied. This would remove an entire class of "which function do I call" mistake for any future caller in either language who has the pubkey in hand but reaches for the address-only entry point instead, exactly as happened here. Not urgent — no current caller is broken by the *absence* of this option now that Step 16b/16c call the correct function instead; this is about closing the footgun for the next caller, not an active bug today.

**Raised:** 2026-07-12, during Phase 4 (`discoverRooms`/`discover-rooms` bugfix) — David's request.
