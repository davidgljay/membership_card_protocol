# Phase 2 Milestone Review — Codebase Division (Scaffold + Salvage)

**Date:** 2026-07-07
**Status:** Complete

Four new pnpm workspaces — `app-sdk/`, `wallet-sdk/`, `sdk-providers-web/`, `sdk-providers-rn/` — were scaffolded and salvaged module-for-module from the frozen `client-sdk-old/` reference copy (Steps 2.1–2.4), with `client-sdk/` left untouched throughout. All four packages build and test independently (verified under Node 22, the minimum each package's `engines` field declares — a stray failure surfaced mid-review under this environment's default Node 18.19.1 and resolved cleanly on Node 22, confirmed as a pure environment artifact, not a code defect, since 18.19.1 predates global `WebCrypto` and Babel's synchronous ESM config loading that this SDK relies on). Combined: **297 tests passing** (162 app-sdk, 88 wallet-sdk, 25 sdk-providers-web, 22 sdk-providers-rn), above the original unified `client-sdk`'s 243.

## Import graph

Exactly as targeted, no cycle, no unexpected edge:

```
wallet-sdk        → app-sdk → verifier (+ verifier-ipfs-provider)
sdk-providers-web  → app-sdk
sdk-providers-rn   → app-sdk
```

`app-sdk` and `wallet-sdk` have zero dependency on either platform package (provider implementations are host-app-injected, never a hard dependency of the SDK core packages — confirmed by direct inspection of all four `package.json` dependency lists).

## Duplication checks (all clean)

- All seven provider interfaces (`StorageProvider`, `SecureKeyProvider`, `PasskeyProvider`, `YubiKeyProvider`, `RealtimeTransportProvider`, `MultiInstanceLock`, `ObliviousProtocolTransport`) are defined in exactly one place — `app-sdk/packages/app-sdk/src/providers/` — confirmed by grep across all four packages' source trees.
- Core crypto primitives (`canonicalize`, `keccak256`, `mlDsa44GenerateKeypair`, `hpkeSeal`/`hpkeOpen`) are each defined in exactly one place, `app-sdk/packages/app-sdk/src/crypto/`.
- `CardVerifier` is never redefined anywhere in the split — every package that needs it imports the class directly from `@membership-card-protocol/verifier` (via `app-sdk`'s re-export), matching the "no independently re-derived trust logic" invariant carried forward from the original spec.
- The two platform packages' provider *implementations* diverge only in genuinely platform-specific ways (IndexedDB vs. AsyncStorage, WebCrypto vs. `react-native-keychain`, WebAuthn vs. `react-native-passkey`, native `EventSource`/`WebSocket` vs. `react-native-sse`, `BroadcastChannel` vs. no-op) — spot-diffed file-by-file, no copy-paste duplication found.

## Findings surfaced and corrected during this phase

Beyond the plan's own listed steps, review work across Phases 1–2 caught and fixed:

1. **Three spec misattributions** (Phase 1, already closed): offer countersign, offer review, and sub-card press-registration submission had each initially landed in the wrong package's spec.
2. **Step 2.4's original scope description had the platform-package dependency direction backwards** — rewritten before dispatch (see `plans/sdk-split-implementation-plan.md` Step 2.4's inline scope-correction note).
3. **`resolveActiveSubCardTargets`** — fully working, tested code in `client-sdk-old` that Step 2.3's salvage missed and that `wallet_sdk.md` §8.1 incorrectly still marked "Planned." Ported into `wallet-sdk/src/messaging/`, and the spec corrected to match the actual implementation's signature (`pubkey: string`, base64url-encoded — not `Uint8Array` as originally documented).
4. **An agent execution failure, not a spec/code defect**: the first attempt at Step 2.2 stalled when an agent misread the plan's "using a subagent" phrasing as an instruction to spawn a child agent, reporting false progress for an extended period before the work was redone directly. The plan file's step descriptions were subsequently edited to remove that phrasing throughout, to prevent recurrence in later phases.

## Test count reconciliation

| Package | Tests | Notes |
|---|---|---|
| app-sdk | 162 | 161 salvaged (1 wallet-only test correctly excluded from the original 3-test `targetedOfferAcceptance.test.ts`) + 2 new (`signWithSubCard`) |
| wallet-sdk | 88 | 81 salvaged (exact 1:1 match against the 15 `client-sdk-old` modules it draws from, including the rewritten `deviceSubCard` self-signing test folded into `subcards/countersign.test.ts`) + 7 newly ported (`resolveActiveSubCardTargets`, missed by the original Step 2.3 pass) |
| sdk-providers-web | 25 | 1:1 port of `client-sdk-web`'s 7 test files |
| sdk-providers-rn | 22 | 1:1 port of `client-sdk-rn`'s 7 test files |
| **Total** | **297** | vs. original 243 |

No capability's tests were dropped without an explicit, reviewed reason (wallet-only tests excluded from app-sdk's port, and vice versa, per the capability split each spec documents).

## Clarification checkpoint

Per the plan: before deleting anything from `client-sdk/` itself, check in with the user. Recommendation stands as written in the plan — leave `client-sdk/` in place, unpublished and unmaintained, until both `app-sdk` and `wallet-sdk` are verified and published (Phase 4), then remove it in one final, explicitly-approved cleanup step. `client-sdk/` has been confirmed untouched (byte-identical to its Step 2.1 state) throughout all of Phase 2's work.

## Ready for Phase 3

Phase 3 (Completion and Verification Against Spec) can begin: Step 3.1 (`app-sdk` to full `app_sdk.md` compliance) and Step 3.2 (`wallet-sdk` to full `wallet_sdk.md` compliance, including the CP-2 security review) run independently in parallel.
