# Press Phase 2 Milestone Summary

**Date:** 2026-06-25
**Status:** Complete

## Modules delivered

| File | Description |
|---|---|
| `src/serialization.ts` | Re-exports `canonicalize` from the verifier package; adds `canonicalizeExcluding` for signing steps that must omit the field being produced |
| `src/functions/crypto.ts` | Press-side signing: `mlDsa44Sign` (noble/post-quantum, arg order: `sign(msg, sk)`), `secp256r1Sign` (compact r\|\|s, 64 bytes), `aes256gcmEncrypt` (12-byte random nonce), `deriveContentKey` (HKDF-SHA3-256 info="card-content-v1"), `mlDsa44PublicKeyFromPrivate` (via `ml_dsa44.getPublicKey`), `keccak256`, `toBase64url`/`fromBase64url` |
| `src/ipfs/client.ts` | Piñata SDK v2 client; upload via `upload.public.file()`; CID validation by re-fetching content from gateway and comparing bytes; P-10 on mismatch, P-24 on upload failure |
| `src/chain/registry.ts` | viem-based Arbitrum One registry client; wraps all 6 write operations and 4 read operations; `buildAndSignPayload` always fetches `next_sequence` from chain (never cached); retry on E-07 (SEQUENCE_MISMATCH); `updateCardHead` additionally retries once on E-08 (STALE_PREV_CID) and surfaces P-12 on second failure |
| `src/chain/gas.ts` | `checkGasBalance` (P-20, 20% buffer warning); `checkAppGasBalance` (sufficient/sponsor paths per spec §5.9); `creditAppGasAccount`/`debitAppGasAccount` (KV-backed); `pollEthTransfers` (block iteration, 100-block batches, extracts 32-byte hex app address from calldata) |
| `src/kv.ts` | Updated: `KvStore` interface with `getItem`/`setItem`/`removeItem`/`increment`; `createInMemoryKv` for tests |

## Spec deviations from the Phase 2 implementation plan

The implementation plan was written against spec v0.2. Spec v0.3 removed several items, which are not implemented here:

- **Step 2.4 (`resolveCard`, `verifyCardChain`, `checkRevocationStatus`)** — removed in v0.3; now delegated to `@membership-card-protocol/verifier`
- **Step 2.5 (AEK wrap/unwrap, `audit_epoch_aeks`)** — removed in v0.3; audit epochs replaced by direct E2E auditor messaging (spec §5.5)
- **Step 2.6 (SQLite-backed gas monitor)** — replaced with KV-backed gas management (`src/chain/gas.ts`); ETH transfer monitoring uses block polling (CP-4 resolved: polling chosen over WebSocket as better fit for stateless Nitro serverless)

## Key decisions

- **CID validation**: re-fetch from Piñata gateway and byte-compare rather than locally re-deriving the UnixFS DAG-PB CID. Correct regardless of Piñata's internal chunking behavior.
- **secp256r1 signing prehash**: `keccak256(payload_bytes)` is passed directly to P-256 `sign()` with `prehash: false`. The contract verifies via RIP-7212 against the raw keccak256 digest (not a double-hash).
- **App gas calldata format**: exactly 64 hex characters (32 bytes) with or without `0x` prefix; anything else is ignored.
- **Static gas estimates**: used in Phase 2 per CP-3 (not yet replaced by `eth_estimateGas`); operator can tune via `GAS_ESTIMATES` in `gas.ts` once real contract gas data is available.

## Test coverage

73 tests pass (5 test files). All Phase 2 modules have unit tests covering happy paths and key error paths:
- P-10 (CID mismatch after upload)
- P-20 (insufficient press ETH balance)
- P-24 (Piñata upload failure)
- ML-DSA-44 sign/verify round-trip
- secp256r1 sign/verify round-trip
- AES-256-GCM encrypt/decrypt + tamper detection
- App gas: credit, debit, floor-at-zero, sponsor path
- ETH transfer polling: qualifying/non-qualifying tx filtering
- All 26 RFC 8785 conformance cases pass
