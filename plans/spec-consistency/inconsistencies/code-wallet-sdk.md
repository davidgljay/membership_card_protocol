# Phase 3, Step A — Spec-vs-Code Diff: `wallet_sdk.md` vs. `wallet-sdk/`

**Unit:** `code-wallet-sdk`
**Spec:** `specs/object_specs/wallet_sdk.md`
**Code:** `wallet-sdk/packages/wallet-sdk/src/`
**Review type:** Read-only. No spec or code files modified.

This unit specifically re-checks the three corrections this initiative made to `wallet_sdk.md` (Phase 1 fix #30 on §4's provider claims, Phase 1 fix #31 on §6.5's `deregisterSubCard` description, and Phase 2 fix #32 on §5.3's step ordering) against the actual implementation, to determine whether each correction is a documentation-only fix (code already behaved correctly) or whether it exposed a real code bug that still matches the spec's old, now-corrected-away text.

---

## Finding 1 — `setupWallet.ts` executes backup registration *before* device sub-card registration, contradicting the spec's corrected §5.3 step order (fix #32) — CODE BUG, spec correction is right, code was never updated to match

**Verdict: code is wrong; the newly-corrected spec text is correct. This is a real, pre-existing mismatch fix #32 did not (and could not, being a doc-only fix) address.**

`specs/object_specs/wallet_sdk.md` §5.3, as corrected by fix #32, now reads: *"device sub-card generation and registration (§5.4, Steps 7–10)"* happens *"→ synced-passkey backup registration (always) → optional YubiKey backup (Steps 14–15)"* — i.e., device sub-card registration precedes backup registration, matching `wallet_backup_and_recovery.md §Process 1`'s canonical numbered steps: Steps 7–10 ("Device sub-card setup") are listed and described before Steps 11–15 ("Synced passkey backup registration" / "YubiKey backup registration").

The actual code in `wallet-sdk/packages/wallet-sdk/src/wallet/setupWallet.ts` does the **opposite**:

- Lines 344–393: synced-passkey backup registration (`registerBackup(...)`, labeled in a code comment as "Steps 11–13")
- Lines 395–415: optional YubiKey backup registration (labeled "Step 14")
- Lines 417–434: **only after both backup steps** — device sub-card generation/registration (`registerDeviceSubCard(...)`, labeled "Steps 7–9")

So the code's own inline comments even carry the old step numbers in the old (pre-correction) order, executed in that literal sequence — backups first, device sub-card last. This is exactly the "code still matches the OLD, now-corrected-away description" scenario the task called out to watch for.

**Does it matter functionally / security-wise?** Not a key-exposure issue: both `masterSecretKey` and `decryptionKey` remain valid local variables for the whole function body regardless of order (cleared together in the single `finally` at the end), so no key is exposed or discarded prematurely by this ordering. The impact is process/consistency, not confidentiality:
- If backup registration succeeds but device sub-card registration then fails (throws), `setupWallet` throws out of the function (see `deviceSubCard.ts`'s `registerDeviceSubCard` — it throws on validation or countersign failure, it does not return a soft-fail result) — leaving a wallet with registered backups but no device sub-card, whereas the spec's canonical order would leave a wallet with a device sub-card but no backups in the equivalent failure case. Which partial-failure state is preferable is a product judgment call, but the code's current order does not match either what the spec says or what `wallet_backup_and_recovery.md`'s canonical steps describe.
- No test in `test/wallet/setupWallet.test.ts` asserts call order between `registerBackup` and `registerDeviceSubCard` (confirmed via grep — no `toHaveBeenCalledBefore`/order-sensitive assertions), so this divergence would not be caught by the existing test suite.

**Recommended resolution:** Reorder `setupWallet.ts` so `registerDeviceSubCard(...)` (currently lines 417–434) runs before the synced-passkey/YubiKey backup registration block (currently lines 344–415), matching both the corrected `wallet_sdk.md` §5.3 and `wallet_backup_and_recovery.md §Process 1`'s Steps 7–10 → 11–15 order. Update the misleading in-code step-number comments accordingly. This is a code fix, not a further spec correction — the spec is already right after fix #32.

**Files:**
- `/Users/davidjay/Projects/Claude/card_protocol/wallet-sdk/packages/wallet-sdk/src/wallet/setupWallet.ts` (lines 344–434)
- `/Users/davidjay/Projects/Claude/card_protocol/specs/object_specs/wallet_sdk.md` §5.3 (already correct post-fix-#32)
- `/Users/davidjay/Projects/Claude/card_protocol/specs/process_specs/wallet_backup_and_recovery.md` (Steps 7–15, the canonical order both should match)

*(Note: `recoverWallet` in `wallet/recovery.ts` does not have this problem — it doesn't re-register backups at all during recovery, and correctly does deregistration → keyring re-registration → device sub-card, in that order, so this finding is scoped to `setupWallet.ts` only.)*

---

## Finding 2 — §6.5 `deregisterSubCard`: code matches the spec's corrected description; no divergence

**Verdict: code and the newly-corrected spec agree. No finding requiring action.**

Fix #31 corrected `wallet_sdk.md` §6.5 to describe `deregisterSubCard` as "the on-chain, master-key-signed sub-card deregistration," calling `POST /sub-card/deregister` and matching `press.md` §5.4's `processSubCardDeregistration`, distinct from App SDK's wallet-service-local `deregisterCardUuids`.

Checked `wallet-sdk/packages/wallet-sdk/src/wallet/subCardDeregistration.ts` directly:
- `deregisterSubCard(options: DeregisterSubCardOptions)` takes `masterSecretKey: Uint8Array` as a **direct, required parameter** — there is no signer-callback parameter of any kind on this function's type signature, so no code path can construct a deregistration request signed by anything other than the master key. This structurally matches the spec's "requires and is signed by the primary card key only" claim and the security invariant in §10.
- It calls `POST /sub-card/deregister` (line 60 in the file) with `sub_card_address`, `sig_payload`, and `master_signature` — exactly the on-chain-facing shape `press.md` §5.4 describes.
- `deregisterSubCardsAfterRecovery` (the batch helper used by `recovery.ts`) also only ever takes a single `masterSecretKey` parameter and forwards it to `deregisterSubCard` for each sub-card — no per-sub-card alternate signer.

Checked git history (`git log -- wallet-sdk/packages/wallet-sdk/src/wallet/subCardDeregistration.ts`): only one commit exists for this file (the initial salvage-from-`client-sdk-old` commit `c74c881c`). There is no prior version of this code that ever supported a non-master-key signer — the master-key-only design has been in place since this file's introduction. **This means the "master-key-only vs. multi-signer, changed in Phase 2" scenario the task asked me to escalate does not apply here**: the code was never a multi-signer implementation; it has always matched the corrected (and only ever correct, in code) description. Nothing to escalate.

**Files reviewed:** `/Users/davidjay/Projects/Claude/card_protocol/wallet-sdk/packages/wallet-sdk/src/wallet/subCardDeregistration.ts`

---

## Finding 3 — §4 provider claims: code matches the spec's corrected description; no divergence

**Verdict: code and the newly-corrected spec agree. No finding requiring action.**

Fix #30 removed §4's incorrect claim that `SecureKeyProvider` and `RealtimeTransportProvider` are "key providers for wallet-specific flows," replacing it with: neither is consumed directly by this package for master-key operations; `SecureKeyProvider` is used only by App SDK (for requester-side sub-card keys); `RealtimeTransportProvider`-based messaging delivery lives entirely in `app_sdk.md` §9.5.

Checked via grep across `wallet-sdk/packages/wallet-sdk/src/`:
- `RealtimeTransportProvider` — **zero references** anywhere in wallet-sdk's source. Matches the spec exactly.
- `SecureKeyProvider` — referenced as a type in `setupWallet.ts`, `deviceSubCard.ts`, and `recovery.ts`, but in every case it is only accepted as a parameter and passed straight through to App SDK's `requestSubCard` (confirmed the real implementation lives at `app-sdk/packages/app-sdk/src/subcards/requestSubCard.ts`) to generate/manage the **device sub-card's** key — a sub-card key, not the master key. No function in wallet-sdk calls `secureKeyProvider.sign()` or any other `SecureKeyProvider` method directly on the master key; every master-key-consuming function (`deregisterSubCard`, `countersignSubCardRequest`, `postSubCardAddedToDirectory`/`postSubCardRemovedFromDirectory`, `cancelRecovery`, the two `mlDsa44Sign` calls inside `setupWallet`/`recoverWallet`) takes `masterSecretKey: Uint8Array` as a direct parameter, exactly as §10's invariant states.

This matches the spec's carve-out precisely: "`SecureKeyProvider` is still used elsewhere — by App SDK, for requester-side sub-card keys" — wallet-sdk's own device sub-card is generated via App SDK's requester-side `requestSubCard` path (per the deviceSubCard collapse decision, Split-SDK-3), so wallet-sdk merely threads the provider through rather than consuming it itself. No divergence.

**Files reviewed:** `wallet/setupWallet.ts`, `wallet/deviceSubCard.ts`, `wallet/recovery.ts`, `app-sdk/packages/app-sdk/src/subcards/requestSubCard.ts`

---

## Summary

| Corrected spec section | Verdict | Action needed |
|---|---|---|
| §5.3 step order (fix #32) | Spec correction is right; **code still runs the old (wrong) order** | **Code fix needed** — reorder `setupWallet.ts` (Finding 1) |
| §6.5 `deregisterSubCard` (fix #31) | Spec correction matches code; always has | None |
| §4 provider claims (fix #30) | Spec correction matches code; always has | None |

No security-relevant divergence around `deregisterSubCard`'s master-key-only authorization was found — it has been master-key-only since introduction, with no multi-signer precursor in this repo's history. **Nothing here rises to "ESCALATE TO DAVID."** Finding 1 is a real code/spec mismatch worth fixing but is a process-ordering issue, not a security or correctness-of-authorization issue.
