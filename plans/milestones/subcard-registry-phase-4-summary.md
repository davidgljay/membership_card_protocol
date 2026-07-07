# Sub-Card Registry Phase 4 Milestone: Client SDK

**Date:** 2026-07-06
**Status:** Complete

## Summary

Phase 4 successfully implements the client-SDK layer for active-subcards directory resolution and message targeting. All 3 steps (4.1–4.3) complete; all SDK tests pass (250 core + 25 web + 22 RN).

## Step 4.1: `resolveActiveSubCardTargets` Helper

**What was implemented:**
- New function `resolveActiveSubCardTargets(masterCard: CardDocument): SubCardMessageTarget[]` in `client-sdk/packages/client-sdk/src/subcards/resolveActiveSubcardTargets.ts`.
- Reads `active_subcards` from a decrypted master card.
- Derives `keccak256(pubkey)` for each entry to produce hex-prefixed address.
- Returns `SubCardMessageTarget[]` with `{ pubkey, address }` tuples.
- Pure, synchronous function — no network I/O, composable with existing message-sending paths.
- Handles edge cases: missing/empty `active_subcards` returns `[]`; malformed entries are silently skipped; non-array `active_subcards` treated as "no sub-cards."
- Exported from core SDK barrel via `subcards/index.ts`.

**Spec compliance:**
- Matches `object_specs/client_sdk.md` §10.1 signature and behavior.
- No platform-specific duplication of address derivation.
- Uses verifier's `keccak256` helper for consistent address computation.

## Step 4.2: Platform SDK Propagation

**What was implemented:**
- Re-exported `resolveActiveSubCardTargets` and `SubCardMessageTarget` from `client-sdk-web/src/index.ts`.
- Re-exported `resolveActiveSubCardTargets` and `SubCardMessageTarget` from `client-sdk-rn/src/index.ts`.
- Both packages re-export identically from core SDK (no duplication, no wrapper).
- Naming and signatures consistent across all three packages.

**Spec compliance:**
- Matches `object_specs/client_sdk.md` §10.1 re-export requirement.
- No platform-specific variations of the address-derivation logic.
- Web and RN packages expose the same capability with consistent naming.

## Step 4.3: Test Coverage

**What was implemented:**
- Comprehensive unit test suite in `client-sdk/packages/client-sdk/test/subcards/resolveActiveSubcardTargets.test.ts`.
- Test cases:
  - Empty array for missing `active_subcards` field.
  - Empty array for empty `active_subcards`.
  - Single active sub-card: correct pubkey and address derivation.
  - Multiple sub-cards: distinct addresses, correct ordering.
  - Edge case: non-array `active_subcards` treated as no sub-cards.
  - Address format validation: hex-prefixed, lowercase, 64 hex chars.
- All 7 tests pass; no regressions in existing suite (250 core tests pass).

**Spec compliance:**
- Covers absent-field edge case per Phase 1 "absence = no active sub-cards" convention.
- Includes multiple-entry case to verify distinct address derivation.

## Consistency Against Prior Phases

| Layer | Decision | Status |
|-------|----------|--------|
| **Spec (Phase 1)** | `active_subcards` is flat array of base64url ML-DSA-44 public keys | ✅ Verified |
| **Verifier (Phase 3)** | Derives `keccak256(pubkey)` for membership check | ✅ Matches |
| **Client SDK (Phase 4)** | Derives `keccak256(pubkey)` for address tuples | ✅ Matches |
| **Address format** | Hex-prefixed, case-insensitive | ✅ Consistent |

## Integration Point

The `SubCardMessageTarget[]` returned by `resolveActiveSubCardTargets` feeds directly into the existing `fanOutMessageToSubCards` messaging API (once the caller separately resolves the ML-KEM public keys from device registration, per the broader messaging layer design). The function introduces no new RPC round trips — the caller provides the already-decrypted master card, and the function returns pure-synchronous targets.

## Test Results

- **client-sdk**: 250 tests pass (39 suites)
- **client-sdk-web**: 25 tests pass (7 suites)
- **client-sdk-rn**: 22 tests pass (7 suites)
- **Verifier** (Phase 3 regression check): 86 tests pass
- **No regressions** across any package.

## Files Changed

- `client-sdk/packages/client-sdk/src/subcards/resolveActiveSubcardTargets.ts` (new)
- `client-sdk/packages/client-sdk/src/subcards/index.ts` (export added)
- `client-sdk/packages/client-sdk/test/subcards/resolveActiveSubcardTargets.test.ts` (new)
- `client-sdk/packages/client-sdk-web/src/index.ts` (re-export added)
- `client-sdk/packages/client-sdk-rn/src/index.ts` (re-export added)

---

**Next Step:** Phase 5 (Cross-Cutting Consistency Pass) — update red-team plan, final end-to-end consistency check across all layers.
