# `code-matrix-encryption` — spec vs. code

**Spec:** `specs/object_specs/matrix_encryption.md`
**Scope:** `wallet-service/matrix-policy-module/` (Synapse-side Python), `wallet-service/src/matrix*` (wallet-service's own endpoints), and the client-side ML-DSA-44 signing/canonicalization/sender-binding code the spec cites in `app-sdk/`.

## Summary

The cryptographic *design* described in the spec — Megolm-as-transport, the card-signature envelope (§2), shadow-account derivation (§3), and the sender-binding check (§4) — is faithfully and correctly implemented, with one significant exception: **the spec's own citations for where the client-side implementation lives are wrong.** The Phase 1 fix (changelog: "Fix #28 — corrected the retired `client-sdk` signing-call-site citation to `app-sdk`") pointed the spec at the wrong package. The actual, working, security-critical implementation of §2/§3/§4 for Matrix room messages lives in a *different*, still-actively-developed `client-sdk/` package — not in `app-sdk/` or `wallet-sdk/`, which contain no Matrix code at all.

## 1. `wallet-service/matrix-policy-module/` — matches spec, well

- `src/matrix_policy_module/attestation.py` implements `shadow_account_commitment`, `derive_matrix_user_id`, and `verify_matrix_user_id_binding` exactly per §3's pseudocode (`keccak256(card_hash || "matrix-shadow-account-v1" || server_name)`, domain-separated, forward-only, no inverse). `verify_join_attestation` correctly performs signature validity, `card_hash` recomputation, freshness, `server_name` binding, and `matrix_user_id` equality/binding checks per `matrix_join_attestation_and_revocation.md` §1–2, which this spec's §3 (2026-07-11 "Superseded" note) defers to.
- `src/matrix_policy_module/module.py` confirms the spec's central §3 claim — **`wallet-service` is never queried by the Synapse module at authorization time, for either join or post.** Join authorization (`check_event_allowed` → `_decide_join`) uses the client-presented attestation plus its own `MembershipRegistry`; post authorization (`check_event_for_spam`) resolves `card_hash` purely from `MembershipRegistry.resolve_card_hash`, populated once at join time. No HTTP/RPC call to wallet-service appears anywhere in the authorization path. This matches §3's "Honest limit" claim precisely.
- `src/matrix_policy_module/membership_registry.py` implements the encrypted-at-rest `(room_id, matrix_user_id) -> card_hash` registry the spec's §3 describes as replacing the removed wallet-service resolver.
- No Megolm-specific logic exists in the Python module (correctly — §1 says Megolm is handled entirely by Matrix client crypto stacks, and the module never decrypts room-message plaintext, consistent with §4's enforcement-boundary paragraph).
- **Verdict: code matches spec.** No divergence found in this half.

## 2. `app-sdk/packages/app-sdk/src/crypto/mldsa.ts` and `canonicalize.ts` — files exist, are individually correct, but are not the actual call site

Both files exist at exactly the cited paths and implement exactly what §2 describes:
- `mldsa.ts` exports `mlDsa44Sign`/`mlDsa44Verify` as thin wrappers over `@noble/post-quantum`'s `ml_dsa44`.
- `canonicalize.ts` implements RFC 8785 JCS (sorted keys, no whitespace, UTF-8) exactly as described.

So *in isolation*, the Phase 1 fix's citation is not a fabrication — these files exist and do what the spec says. **However, they are not the code path that actually runs when a Matrix room message is signed or verified.**

The concrete implementation of §2 (envelope construction), §3 (account-id derivation) and §4 (the sender-binding check) for Matrix specifically lives in:

- `client-sdk/packages/client-sdk/src/matrix/signed-room-events.ts` — `sendCardSignedRoomEvent()` / `receiveCardSignedRoomEvent()`, which is the literal, only implementation of §4's `on_receive` pseudocode found anywhere in the repo (two-check sequence, `InvalidSignatureError` vs. `SenderBindingMismatchError`, exactly per spec).
- `client-sdk/packages/client-sdk/src/matrix/account-id.ts` — a third copy of `deriveMatrixUserId`/`verifyMatrixUserIdBinding` (alongside wallet-service's TS copy and the Python mirror), explicitly documented as needing to stay byte-identical, and cross-tested via a shared fixture (`wallet-service/test/account-id.test.ts` / `client-sdk`'s own `test/matrix/account-id.test.ts`).
- These import `client-sdk`'s **own local** `../crypto/mldsa.js` and `../crypto/canonicalize.js` — not `app-sdk`'s.

**Confirmed via `git log`:** `app-sdk/`/`wallet-sdk/` were created in commit `c74c881c` ("Scaffold and salvage app-sdk/ and wallet-sdk/ from client-sdk-old/", 2026-07-05), per `plans/sdk-split-strategic-plan.md`, which explicitly frames the split as: *"`client-sdk-old/` retains the current codebase, untouched, as a reference and rollback point"* — i.e., the pre-split package was meant to be superseded, with `app-sdk`+`wallet-sdk` as its replacement going forward. But **all of the Matrix work (Phase 3 through Phase 5, commits `7bd2f3a5` and `0daebcbe`, dated 2026-07-14 — nine days *after* the split) was built into `client-sdk/` (not `client-sdk-old/`, and not `app-sdk/`)**, a package with its own live README and its own `plans/client-sdk/` plan, still under active development. `app-sdk/` and `wallet-sdk/` contain **zero** Matrix-related files (`find ... -iname "*matrix*"` returns nothing in either).

`client-sdk`'s copies of `mldsa.ts` and `canonicalize.ts` are today functionally identical to `app-sdk`'s (`canonicalize.ts` is byte-for-byte identical; `mldsa.ts` differs only in a doc comment) — so there is no *current* behavioral bug. But they are two independently-maintained copies of the exact signature-verification/canonicalization code this spec's whole document exists to make trustworthy, with **no shared test or CI check enforcing they stay in sync** (unlike the account-id.ts triple, which does have an explicit cross-fixture test). A future fix or hardening change applied to one (e.g., a `@noble/post-quantum` upgrade, a canonicalization edge-case fix) could silently fail to propagate to the other.

### Which side is correct

- **The spec's Phase 1 citation is factually inaccurate as applied to this document's own subject matter.** It correctly identifies files that exist and behave as described, but those files are not where Matrix room-message signing/verification actually happens. The spec should cite `client-sdk/packages/client-sdk/src/crypto/mldsa.ts` and `client-sdk/packages/client-sdk/src/crypto/canonicalize.ts` (and, ideally, `client-sdk/packages/client-sdk/src/matrix/signed-room-events.ts` for §4's actual `on_receive` implementation) instead of, or in addition to, the `app-sdk` paths.
- This is not simply a stale citation the way most Phase 1 fixes were — it reflects a real repo-structure ambiguity: **two non-"old"-suffixed client packages (`app-sdk`+`wallet-sdk` vs. `client-sdk`) both currently exist, both are under active development, and it is not clear from any spec or plan which one is meant to be canonical going forward.** `app_sdk.md` narrates the split as if `client-sdk` were retired; `client-sdk/README.md` and `plans/client-sdk/` plans describe `client-sdk` as the live, current package. Both READMEs currently read as authoritative.

### ESCALATE TO DAVID

**This is a security-relevant divergence and should be escalated:**
1. `matrix_encryption.md` §4 (the sender-binding check) is the security boundary this entire document exists to protect against identity-drift attacks. Its only real implementation (`client-sdk/packages/client-sdk/src/matrix/signed-room-events.ts`) sits in a package the spec doesn't cite at all, and that the SDK-split plan's own language ("reference and rollback point" for the *old* package) suggests should have been phased out in favor of `app-sdk`/`wallet-sdk`.
2. There are now three independent copies of the shadow-account derivation (`wallet-service/src/matrix/account-id.ts`, the Python mirror, and `client-sdk`'s copy) and two independent copies of the ML-DSA-44 sign/verify + canonicalization primitives (`app-sdk`'s and `client-sdk`'s). The account-id triple has an explicit cross-fixture test; the crypto-primitive duplication (`mldsa.ts`/`canonicalize.ts`) does **not** — nothing currently catches silent divergence between `app-sdk`'s and `client-sdk`'s copies of the code that verifies every signature this protocol relies on.
3. It needs a decision, not just a spec-text fix: is `client-sdk` going to be merged/retired into `app-sdk`+`wallet-sdk` (matching the split plan's original intent, requiring the Matrix work to be ported), or is `client-sdk` now the canonical home for Matrix-integrated client code going forward (requiring `app-sdk.md`, the sdk-split plan, and `matrix_encryption.md`'s citations all to be corrected to say so)? Either answer is a real, non-trivial follow-up; simply editing the citation without resolving which package is canonical would just re-encode the same ambiguity in different words.

## 3. Other structural claims checked

- **Shadow Matrix account derivation (§3):** implemented identically (modulo trivial hex/byte-concat style differences) in all three locations — `wallet-service/src/matrix/account-id.ts`, `wallet-service/matrix-policy-module/src/matrix_policy_module/attestation.py`, and `client-sdk/packages/client-sdk/src/matrix/account-id.ts`. All three pass the same fixture. **Matches spec.**
- **Card-signature envelope (§2):** `client-sdk/packages/client-sdk/src/matrix/signed-room-events.ts`'s `RoomMessagePayload`/`RoomMessageEnvelope` types match the spec's JSON shape exactly, including the correctly-omitted `recipients`/`senders` and the optional `matrix_event_id`. `sendCardSignedRoomEvent` also enforces an additional hard constraint not mentioned in the spec text (`SigningCardSessionMismatchError`: refusing to sign unless the signing card's derived Matrix user ID matches the active session) — this is a reasonable defense-in-depth addition, not a contradiction of the spec, but the spec doesn't document this client-side guard; worth a minor spec addition, not an inconsistency.
- **Sender-binding check (§4):** implemented exactly per the spec's pseudocode and rejection-reason semantics (see §2 above) — but only in `client-sdk`, per the citation issue above.
- **Key management:** no separate key-management logic beyond what's already covered by `mlDsa44Sign`/`mlDsa44Verify` and the shadow-account derivation was found; nothing in the spec claims more than that, so nothing further to check here.

## Files reviewed

- `specs/object_specs/matrix_encryption.md` (full)
- `wallet-service/matrix-policy-module/src/matrix_policy_module/attestation.py`
- `wallet-service/matrix-policy-module/src/matrix_policy_module/membership_registry.py`
- `wallet-service/matrix-policy-module/src/matrix_policy_module/module.py`
- `wallet-service/src/matrix/account-id.ts`
- `app-sdk/packages/app-sdk/src/crypto/mldsa.ts`
- `app-sdk/packages/app-sdk/src/crypto/canonicalize.ts`
- `client-sdk/packages/client-sdk/src/matrix/signed-room-events.ts`
- `client-sdk/packages/client-sdk/src/matrix/account-id.ts`
- `client-sdk/README.md`, `app-sdk` structure, `plans/sdk-split-strategic-plan.md`, `plans/client-sdk/strategic-plan.md` (for the package-provenance question)
- `git log` for `app-sdk/`, `client-sdk/packages/client-sdk/`, and the split commit (`c74c881c`) vs. the Matrix-integration commits (`7bd2f3a5`, `0daebcbe`)
