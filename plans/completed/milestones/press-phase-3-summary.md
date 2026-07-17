# Press Phase 3 Milestone Summary

**Date:** 2026-06-26
**Status:** Complete

## Modules delivered

| File | Description |
|---|---|
| `src/types.ts` | All shared request/response/domain types: PolicyDocument, IssuerOffer, IssuanceRequest/Response, FinalizeRequest/Response, OpenOfferClaimSubmission, UpdateRequest/Response, SubCardRegistration/DeregistrationRequest, ScipObject |
| `src/context.ts` | PressContext singleton; RpcProvider adapter bridging RegistryClient → CardVerifier (with CID-linked log chain walker for `getLogEntries`); IpfsProvider adapter; `buildCardVerifier` factory |
| `src/functions/predicates.ts` | `evaluatePredicates` (chain trust, revocation, staleness, predicate evaluation); `checkRateLimits` (P-18, P-19); `recordWrite` (atomic increment + 80% alert threshold); `sendSuspiciousActivityAlert` |
| `src/functions/issuance.ts` | `validateIssuanceRequest`, `assembleCardDocument`, `signCardDocument` (RFC 8785 excl. press_signature + ML-DSA-44), `publishCard` (HKDF-SHA3-256 content key + AES-256-GCM encrypt), `issueScip`, `verifyIssuerSignature`, `verifyHolderSignature`, `fetchPolicyCard` |
| `src/functions/mlDsaVerify.ts` | ML-DSA-44 verification helper (noble/post-quantum; verifier index does not re-export this) |
| `src/functions/log.ts` | `getLogHead` (KV-first, on-chain fallback); `appendLogEntry` (assemble + sign + pin + updateCardHead); `appendIssuanceRecord` (per-auditor HTTPS notify, 30s timeout, non-blocking on failure) |
| `src/handlers/issue.ts` | `handleIssue` (validate, verify issuer sig, stale timestamp P-22, store offer in KV); `handleIssueFinalize` (retrieve offer, verify holder sig, assemble+sign+publish+register+SCIP) |
| `src/handlers/open-offer.ts` | `handleOpenOfferClaim` (issuer binding check P-05, issuer/recipient sig verify, evaluatePredicates, on-chain use-count pre-flight P-07/P-08, claimOpenOffer, SCIP) |
| `src/handlers/update.ts` | `handleUpdate` (intent sig verify P-09, staleness check, appendLogEntry, rate limit for 1xx codes) |
| `src/handlers/sub-card.ts` | `handleSubCardRegister` (app sig P-13, binding checks P-13, holder sig P-14, app cert chain P-15, gas check P-16, rate limits, pin + registerSubCard); `handleSubCardDeregister` (active check, master sig P-14, gas sponsor path) |
| `server/plugins/startup.ts` | Fully initializes PressContext: config, ipfs, registry, KV, CardVerifier, GasManager, press public key derivation |
| `server/api/*.ts` | All route stubs wired to real handlers (replaced 501 stubs) |

## Error codes covered

P-01 (missing fields / not in approved_presses), P-02 (requester chain/predicate), P-03 (recipient chain/predicate), P-04 (revoked card), P-05 (invalid issuer/app/binding signature), P-06 (invalid recipient signature), P-07 (open offer expired), P-08 (open offer at capacity), P-09 (invalid intent signature), P-13 (pubkey binding check), P-14 (holder/master signature), P-15 (app cert chain), P-16 (app gas insufficient), P-17 (stale revocation data), P-18 (entity rate limit), P-19 (policy rate limit), P-20 (press ETH balance), P-21 (policy expired), P-22 (stale offer/intent timestamp)

## Known Phase 3 limitations (deferred to Phase 4)

- **`ancestry_pubkeys`**: chain walk to populate is a Phase 4 task (requires fetching and decrypting ancestor cards, which the press cannot do — holders provide their own chain in Phase 4).
- **`getLogEntries` log walk**: implemented but shallow; full historical walk with CID decoding is Phase 4.
- **`field_match` predicates**: logged as warning and treated as passing; full field evaluation requires card decryption.
- **`update_policy` predicate evaluation** for field updates: passes in Phase 3; full enforcement is Phase 4.
- **KV backend**: in-memory KV used in Phase 3; replaced with Nitro `useStorage('press')` driver in Phase 4.
- **Auditor issuance record delivery**: sends plain JSON; E2E encryption to auditor pubkeys is Phase 4.

## Test coverage

90 tests pass (7 test files). New Phase 3 tests:
- `predicates.test.ts` (10 tests): P-02, P-03, P-04, P-17 error paths; P-18, P-19 rate limit enforcement; recordWrite counter increments
- `issuance.test.ts` (6 tests): signCardDocument ML-DSA-44 signature roundtrip; publishCard HKDF-key derivation and AES-256-GCM encrypt/decrypt roundtrip; verifyIssuerSignature valid/tampered; verifyHolderSignature valid/invalid
