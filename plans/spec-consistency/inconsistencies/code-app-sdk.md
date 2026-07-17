# Spec-vs-Code Diff: `specs/object_specs/app_sdk.md` vs. `app-sdk/`

**Unit:** `code-app-sdk` (Phase 3, Step A)
**Method:** Read the spec in full; read every file under `app-sdk/packages/app-sdk/src/` referenced by §3–§9 (providers, crypto, verification, offers, subcards, messaging, transport, util); cross-checked against `specs/messaging_protocol.md` and `specs/object_specs/card_verifier.md` for the semantics the App SDK is supposed to be delegating to.

---

## 1. §9.7 Room Discovery — confirmed unimplemented (expected, no new finding)

Spec §9.7 (added today, self-flagged "(Not implemented)" with an Implementation Status row in §13) describes a `discoverRooms()` function. Verified: no `discoverRooms`, no `room-index`, no `room_discovery` string, and no `DiscoverRooms*` type appears anywhere in `app-sdk/packages/app-sdk/src/` (recursive grep, zero hits). `src/index.ts`'s barrel exports confirm nothing from a `matrix/` or `rooms/` module is exported — no such module exists. **Spec is correct as written; this is a confirmed, already-tracked gap, not a new issue.**

## 2. Crypto module paths cited by other specs — confirmed correct

- `app-sdk/packages/app-sdk/src/crypto/mldsa.ts` — exists, exports `mlDsa44GenerateKeypair`/`mlDsa44Sign`/`mlDsa44GetPublicKey`/`mlDsa44Verify`, matching §5's table exactly.
- `app-sdk/packages/app-sdk/src/crypto/canonicalize.ts` — exists, exports `canonicalize`, an RFC 8785 implementation vendored from the verifier package, matching §5's description.

Both paths cited by `matrix_encryption.md` (per the Phase 1 fix) resolve to real files with the cited exports. **No divergence — confirms the Phase 1 fix was correct.**

Also spot-checked the rest of §5's table against `src/crypto/`: `hashes.ts` (`keccak256`, `hkdfSha3256`), `mlkem.ts` (`mlKem768*`), `hpke.ts` (`hpkeGenerateKeyConfig`/`hpkeSeal`/`hpkeOpen`) — all present with matching signatures and behavior as described.

---

## 3. New finding — ESCALATE TO DAVID: inbound message acceptance gate discards chain/revocation/policy results, checks only raw signature validity

**Which side is correct:** The spec (§9.2 and §11) is correct in intent; **the code (`app-sdk/packages/app-sdk/src/messaging/inbound.ts`) does not implement what the spec describes**, and the gap is security-relevant.

**What the spec says:** §9.2 states `handleInboundRoutingEnvelope` "verifies the recovered `CardMessageEnvelope`'s signature(s) via the shared `CardVerifier`'s `verifyEnvelope()` — never a hand-rolled signature check." §11's cross-cutting invariant is stronger: "No verification logic is re-derived outside `CardVerifier` calls — chain walking, revocation checking, and policy-compliance evaluation are delegated entirely to the shared verifier instance." The clear intent is that a message is only ever surfaced to a user/caller if it is currently valid per the verifier's full pipeline (signature, chain-to-trusted-root, revocation, policy), not merely cryptographically signed by *some* keypair.

**What `card_verifier.md` promises `verifyEnvelope()` returns:** Per `card_verifier.md` §6.1/§8, `EnvelopeVerificationResult.signatures[]` is a `SignatureVerificationResult` per signer carrying, independently: `signature_valid` (Stage 1 — raw crypto check only), `chain_reaches_trusted_root` (Stage 3), `revocation.status` / `is_currently_valid` (Stage 4), and `policy_compliant` (Stage 5). A signer can pass Stage 1 (a real ML-DSA signature over the payload) while failing every later stage — e.g. a subcard whose chain never reaches a `PolicyAuthorizerKeys` root, or a card that has since been revoked (8xx/9xx).

**What the code actually checks** (`inbound.ts`, `handleInboundRoutingEnvelope`):

```ts
const anySignatureValid = verification.signatures.some((sig) => sig.signature_valid === true);
if (!anySignatureValid) {
  return { accepted: false, code: 'no_valid_signature', ... };
}
...
return { accepted: true, envelope, messageId: id, verification, duplicate };
```

This inspects **only** `signature_valid` (Stage 1) — never `chain_reaches_trusted_root`, `is_currently_valid`/`revocation.status`, or `policy_compliant`. The full `verification` object (with all the discarded stage results) is passed back to the caller inside the returned `InboundMessage`, so a sufficiently careful caller *could* re-check those fields itself — but the module's own gate, the one thing standing between "signature exists" and `accepted: true`, does not enforce them. A message signed with a raw-valid ML-DSA signature by a card whose chain does not reach a trusted root, or by a card that has since been revoked, is still reported as `accepted: true`.

**Second, related gap in the same function:** the `some(...)` check also means that for a multi-signer ("co-signed") envelope — `messaging_protocol.md`: "`senders` lists the card hashes of the cards whose identity is being asserted by this message, parallel to the `signatures` array... co-signed messages may have several [senders]" — the envelope is accepted as long as **any one** of the N signatures is valid, not all of them. A message asserting co-signature by cards A and B, where B's entry is a forged/invalid signature, is still `accepted: true` and would be displayed as jointly signed by both A and B.

**Why this matters:** this function is the *only* gate the SDK provides before treating a decrypted message as safe to display (per its own doc comment: "an envelope with an invalid signature must never be displayed to the user"). Both `auth_request`/`auth_response` (used for authorization/consent flows) and ordinary `card_offer`/`card_update_notification` messages route through this same function. Bypassing chain/revocation checks at this layer means a revoked card, or a card that never validly chained to a trusted root, can still have its messages accepted and surfaced to the user — silently defeating the "delegate everything to `CardVerifier`" invariant §11 promises.

**Recommended resolution:** Either (a) the code should be fixed to require, per accepted sender, that `signature_valid === true && chain_reaches_trusted_root === true && is_currently_valid !== false` (and arguably `policy_compliant !== false`, though that may be intentionally left to the caller) before returning `accepted: true` — and require this for every entry in `senders`, not just one of `signatures` — or (b) if partial/best-effort acceptance really is the intended behavior for this layer, the spec's §9.2 and §11 wording needs to be corrected to say so explicitly, since as written both sections promise stronger behavior than the code delivers. Given the doc comment inside `inbound.ts` itself asserts "an envelope with an invalid signature must never be displayed to the user," (a) — fixing the code — appears to be the intended direction, not (b).

---

## 4. Minor, non-security findings (informational only)

- **Stale package-name references in code comments.** §3 of the spec states the platform default packages were "renamed from `client-sdk-web`/`client-sdk-rn`" to `sdk-providers-web`/`sdk-providers-rn` as part of this split. However, the doc comments in `src/providers/StorageProvider.ts`, `SecureKeyProvider.ts`, and `PasskeyProvider.ts` still refer to the old names (`@membership-card-protocol/client-sdk-web`, `client-sdk-rn`) as the "Default implementations" source. This is a leftover from before the rename and doesn't affect runtime behavior (these are doc comments only, and the actual default-implementation packages live in `sdk-providers-web`/`sdk-providers-rn`, confirmed by directory listing), but the code comments should be updated to match the renamed packages for consistency. Not security-relevant — cosmetic/documentation drift within the code itself, not a spec-vs-code behavioral divergence.

- **`ReplenishmentScheduler`/`registerMultipleCardsUuids` deduplication caveat.** `messaging/inbound.ts`'s own doc comment discloses that its "exactly one write ever made for that ID" dedup guarantee (matching spec §9.2) assumes serial, non-concurrent invocation per device — this is disclosed candidly in the code's own comments and is a reasonable assumption for a single JS event loop, not a hidden divergence. Noting only for completeness; no action recommended.

Everything else checked — §3 package structure, §4 all seven provider interfaces, §7.1–7.3 (subcard request/signing/press-submission), §8.1–8.2 (offer construction/finalization, including the offerer-side `holder_signature` re-verification which is a positive addition beyond what §8.2's prose describes but consistent with it), §9.1/9.3–9.6 (envelope construction/fan-out, UUID registration+staggering, replenishment scheduling, realtime delivery's ack-isolation invariant, UUID deregistration) — matches the spec's descriptions in both shape and behavior.
