# code-press: `specs/object_specs/press.md` vs. `press/` — Spec-vs-Code Diff

Reviewed: `press.md` (v0.3 draft, amended 2026-07-16 x3) in full, against `press/src/`, `press/server/`.

Per the Phase 3 instructions: each finding states which side is correct. Items marked **ESCALATE TO DAVID** are security-relevant divergences. Everything else marked "code needs to catch up" is an expected gap from the very recent (same-day) Phase 1/2 spec amendments and is not a spec error.

---

## 1. IPFS pinning provider: spec says Piñata, code implements Filebase — SUBSTANTIAL ARCHITECTURE DIVERGENCE (not security, but high priority)

**Spec** (§3.4, §3.2 config table, §3.5, §10 dependencies): the press uses **Piñata** (`pinata` npm SDK v2) for all IPFS upload/pin/fetch, configured via `PINATA_JWT` and `PINATA_GATEWAY_URL`. `pinata.pinByHash(cid)` is named explicitly as the reconciliation-job primitive.

**Code**: `press/src/ipfs/client.ts`, `press/server/tasks/reconcile-cids.ts`, and `press/src/config.ts` implement and require **Filebase** (S3-compatible object storage + Filebase's IPFS Pinning Services API), using entirely different env vars: `FILEBASE_KEY`, `FILEBASE_SECRET`, `FILEBASE_GATEWAY_URL`. There is no Piñata SDK usage anywhere in `press/`, and no `PINATA_JWT`/`PINATA_GATEWAY_URL` in `config.ts`.

This isn't a field-naming drift — it's a different vendor, different SDK (`@aws-sdk/client-s3` vs. `pinata`), different health-check mechanic (`checkFilebaseHealth` vs. the spec's Piñata "test pin health check"), and a different reconciliation API surface (`POST https://api.filebase.io/v1/ipfs/pins` vs. `pinata.pinByHash`).

**Recommended resolution:** This is not one of the recent Phase 1/2 spec-consistency amendments (§3.4's Piñata choice predates this initiative — see the v0.2→v0.3 changelog at the top of the file), so it doesn't fit the usual "code hasn't caught up yet" pattern. Either (a) the operator/implementer independently switched the running system to Filebase after v0.3 was drafted and the spec was never updated, or (b) the code was written against an earlier plan and never reconciled with the v0.3 Piñata decision. Recommend confirming with David/the press implementer which vendor is actually intended for production, then updating whichever side is stale — this affects the dependency table, config docs, and operator runbooks, not just prose.

---

## 2. `appendLogEntry` — `LogEntry` full-repost redesign (`card_state`/`history`) not implemented

**Spec** (§5.3 `appendLogEntry`, amended 2026-07-16 same-day): requires the press to fetch and decrypt the current head (genesis `CardDocument` or prior `LogEntry`) before assembling a new entry, and to populate:
- `history`: the current head's own `history` array (or `[]`) with the current head's CID appended.
- `card_state`: the current head's field state with `field_updates` applied.
- `version`: current log length + 1.

**Code** (`press/src/functions/log.ts` `appendLogEntry`): does none of this. It never fetches/decrypts the current head object, never assembles `card_state` or `history`, and hardcodes `version = 1` with an explicit comment: `// Increment logic requires full chain walk; placeholder for Phase 3.` Only `field_updates`/`revocation` (the pre-redesign diff-only shape) are carried.

**Recommended resolution:** Code needs to catch up — this is the exact redesign the spec amendment (same day, 2026-07-16) describes, and the code comment ("placeholder for Phase 3") confirms this was already known/tracked as incomplete rather than a deliberate divergence. Not a security issue (it doesn't skip an auth check); it's a data-shape/completeness gap that will break any reader (verifier, wallet-service) built against the new `LogEntry` shape. Flag as a functional bug to fix, not a spec error.

---

## 3. Sub-card deregistration — three-signer model not implemented (code is *more* restrictive, not less)

**Spec** (§5.4 `processSubCardDeregistration`, amended 2026-07-16 Phase 2 Step C, Decision (b)): accepts a valid signature from **any one of three** signers — sub-card's own key, requesting app's card key, or master card holder key (fallback) — for both 810 and 811 deregistration.

**Code** (`press/src/handlers/sub-card.ts` `handleSubCardDeregister`, and `SubCardDeregistrationRequest` in `press/src/types.ts`): only accepts and verifies `master_signature` against the master card's holder pubkey. There is no code path for verifying against the sub-card's own key or the app card's key, and the request type has no field for a generic `signature`/`sig_payload` distinguishing which signer type was used.

**Recommended resolution:** Code needs to catch up — this is the Phase 2 three-signer decision landing same-day. Not security-relevant in the "auth bypass" sense (the code is strictly *more* restrictive than the spec, requiring the master key when the spec would also accept two additional valid signers) — it's a missing feature, not a hole. Flag as a functional gap: apps and sub-cards currently cannot self-deregister without going through the master-key path, which the new spec is meant to no longer require as the only route.

**Related code bug spotted in passing (not spec-vs-spec, but worth filing):** in `handleSubCardDeregister`, `ctx.gas.checkAppGasBalance(subCardAddress, 'DeregisterSubCard')` is called with `subCardAddress`, but `checkAppGasBalance`'s KV key (`press:app_gas:<appCardAddress>`) is keyed by **app card address**, per both the spec (§3.3, §5.9) and the function's own JSDoc. There's also a dead `const appCardAddress = ''; // resolve from SubCardDocument in Phase 4` right above it — the code already fetches the `SubCardDocument` (which contains `app_card_pubkey`/`app_card`) two steps earlier and could resolve the real app card address, but doesn't. Net effect: gas balance is checked/would-be-debited against the wrong KV key, so app gas accounting for deregistration is currently broken (not a security issue — likely causes incorrect sponsor-fallback behavior or balance drift, not unauthorized access).

---

## 4. DNS-admin secp256r1 co-authorization — partially implemented, press-side step 5a check missing

**Spec** (§5.4 `processSubCardRegistration` step 5a, Fix #2): the press must read `DnsAdminCardKeys[master_card_address]` on-chain (`GetDnsAdminCardKey`) to determine if the master card is a DNS admin card, and if so, *require* `adminSecpPayload`/`adminSecpSignature` in the request and validate the payload's `sub_card_address`/`sub_card_doc_cid` match before passing through to the contract.

**Code**:
- **Wire-level plumbing is present**: `SubCardRegistrationRequest` has optional `admin_secp_payload`/`admin_secp_signature` fields (`press/src/types.ts`); `handleSubCardRegister` (`press/src/handlers/sub-card.ts`) passes them through to `registerSubCard` (defaulting to zero-value/empty when absent) — matching Fix #2's 8-argument `RegisterSubCard` call shape.
- **The step 5a gate itself is missing**: there is no `GetDnsAdminCardKey`/`DnsAdminCardKeys` read anywhere in `press/src/chain/registry.ts` (the ABI has no such function), and `handleSubCardRegister` never checks whether the master card is a DNS admin card. It always passes through whatever `admin_secp_payload`/`admin_secp_signature` the caller supplied (or zero-value if omitted), with no pre-check.

**Recommended resolution:** Code needs to catch up — this is the same-day Phase 1 Fix #2 change. Not immediately exploitable as an auth bypass because the actual authorization decision is enforced on-chain by the contract's RIP-7212 verification (per the spec's own note: "the press does not verify the secp256r1 signature itself; the contract does" — a missing/invalid signature for a DNS-admin master card will revert with `E-47`). The practical effect of the gap is: the press fails *late* (contract revert) rather than fast (a clean `P`-level press error), and doesn't validate that `adminSecpPayload`'s embedded `sub_card_address`/`sub_card_doc_cid` actually matches the request before spending gas on a transaction that will revert. This is a UX/cost gap, not a security hole — the contract remains the enforcement boundary either way. Recommend as a normal fix-it item, not an escalation.

---

## 5. `protocol_version` at issuance — implemented correctly

**Spec** (§5.1 `assembleCardDocument` step 7, Fix #8): must call `getProtocolVersion()` and add `protocol_version` to the `CardDocument` before signing.

**Code**: confirmed implemented in both issuance paths — `press/src/handlers/issue.ts` (`handleIssueFinalize`) and `press/src/handlers/open-offer.ts` (`handleOpenOfferClaim`) both call `ctx.registry.getProtocolVersion()` and pass the result into `assembleCardDocument`, which sets `protocol_version` on the document (`press/src/functions/issuance.ts`). `registry.ts` implements the read as `get_protocol_version()` on-chain. No divergence — code has caught up to this same-day fix. (Note: the spec's own §10 "Open item" already flags that `registry_contract.md` doesn't yet define this read operation — that's a spec-side gap tracked separately in the spec itself, not a code issue.)

---

## 6. OHTTP gateway endpoints (§4) — implemented

**Spec** (§4, Fix #7): `GET /ohttp/key-config` and `POST /ohttp/gateway`, implemented per Nitro's `server/api/` convention.

**Code**: both endpoints exist exactly as named — `press/server/api/ohttp/key-config.get.ts` and `press/server/api/ohttp/gateway.post.ts` — backed by `press/src/ohttp-gateway.ts` (encapsulate/decapsulate) and `press/src/ohttp-router.ts` (dispatch to in-process handlers). No divergence found in the surface shape (key-config is unauthenticated and returns the HPKE key config; gateway decapsulates, dispatches, and re-encapsulates). Full behavioral correctness against `oblivious_transport.md`'s wire format was not exhaustively re-derived here (out of scope for a press-only unit) but the endpoint existence and basic shape match the spec.

One undocumented addition: `PressConfig.PRESS_OHTTP_PRIVATE_KEY` (X25519 HPKE key, `press/src/config.ts`) has no corresponding entry in the spec's §3.2 configuration table. Minor spec gap — should be added to keep the config table complete, not a functional issue.

---

## 7. E-14/P-05 alias — no divergence

**Spec** (§7, Fix #13): `P-05` is documented as an alias of the on-chain-adjacent `E-14` naming; both refer to the identical invalid-issuer-signature check.

**Code**: `P-05` is used consistently everywhere the check applies (`press/src/handlers/issue.ts`, `press/src/handlers/open-offer.ts`), and no code path emits a bare `E-14`. Since this is documentation of an equivalence rather than a required code change, there's nothing for the code to implement differently. No divergence.

---

## 8. `E-47` on-chain revert — surfaced without retry, as required

**Spec** (§5.4 `registerSubCardOnChain`, Fix #2): on `E-47` (`INVALID_ADMIN_CARD_SIGNATURE`) revert, surface the error without retrying.

**Code**: `press/src/chain/registry.ts`'s `submitWithRetry` only special-cases `E-07` (`SEQUENCE_MISMATCH`) for retry (and `updateCardHead` additionally retries `E-08`). Any other revert, including `E-47`, propagates unmodified on the first attempt. This satisfies the "do not retry" requirement, though the code doesn't do anything E-47-specific to attach a friendlier message — it just falls through the generic catch-and-rethrow. No functional divergence; acceptable as-is.

---

## 9. Rate limiting (§5.8) and gas management (§5.9) — implemented, matches spec's tables and thresholds

**Code**: `press/src/functions/predicates.ts` (`checkRateLimits`/`recordWrite`/`sendSuspiciousActivityAlert`) implements the 7-day rolling window (`floor(now/7days)*7days`), the exact limits from §6's table (`register_card: 1000`, `update_card_head: 20`, `register_sub_card: 10` per holder / `500` per app, `policy_total: 1000`), and the 80% alert threshold. `press/src/chain/gas.ts` implements `checkGasBalance` (20% buffer, `P-20` on insufficient) and `checkAppGasBalance` (zero-balance sponsor fallback for `DeregisterSubCard`), matching §5.9. No divergence found here beyond the wrong-address bug noted in finding 3 above (that's a call-site bug in `sub-card.ts`, not a gap in the rate-limiting/gas-management functions themselves).

---

## 10. Undocumented gas-wallet / signing-key split

**Code**: `press/src/chain/registry.ts` and `press/src/chain/gas.ts` implement a two-key architecture not described in the spec: `PRESS_SECP256R1_PRIVATE_KEY` signs payloads only (never submits transactions, per explicit code comments), while a separate `PRESS_GAS_WALLET_PRIVATE_KEY` is the actual `msg.sender`/gas-paying account for every on-chain write. The spec (§2, §3.2) describes a single secp256r1 key serving both the authorization-signing role and (implicitly) the on-chain-submitting role, with no mention of a second gas wallet or its env var.

**Recommended resolution:** This looks like a deliberate, reasonable operational improvement (separating the key whose pubkey is registered in `PressAuthorizations` from the hot wallet that pays gas, so a gas-wallet compromise doesn't also compromise write-authorization). It is not called out anywhere in the spec's four amendment notes, so it predates or sits outside this initiative's tracked changes. Recommend updating `press.md` §2/§3.2 to document this two-key split as current, confirmed behavior — this is a "spec is outdated" case, not a code bug, assuming this split is in fact the intended production design (worth a quick confirmation, since it does change the trust model described in §2).

---

## Summary

| # | Area | Divergence | Verdict |
|---|---|---|---|
| 1 | IPFS provider | Spec: Piñata; Code: Filebase | Needs reconciliation — not a Phase 1/2 same-day change, unclear which side is stale |
| 2 | `appendLogEntry` | `card_state`/`history`/`version` redesign not implemented | Code needs to catch up (expected, same-day) |
| 3 | Sub-card deregistration | Three-signer model not implemented; code more restrictive than spec | Code needs to catch up (expected, same-day); plus an unrelated gas-key bug |
| 4 | DNS-admin secp256r1 check | Wire fields plumbed through; press-side step 5a gate (DnsAdminCardKeys check) missing | Code needs to catch up (expected, same-day); not exploitable — contract still enforces |
| 5 | `protocol_version` at issuance | Implemented | No divergence |
| 6 | OHTTP endpoints | Implemented; minor config-table doc gap for `PRESS_OHTTP_PRIVATE_KEY` | No functional divergence |
| 7 | E-14/P-05 alias | Consistent usage | No divergence |
| 8 | E-47 no-retry | Implemented correctly | No divergence |
| 9 | Rate limiting / gas mgmt | Implemented, matches tables | No divergence (aside from #3's bug) |
| 10 | Gas-wallet key split | Undocumented architecture addition in code | Spec should be updated to document it |

No findings in this unit rise to **ESCALATE TO DAVID** under the "auth check the spec requires but the code skips" bar — the closest candidate (finding 4, DNS-admin check) is a fail-fast/UX gap rather than an authorization bypass, since the registry contract is confirmed (via the 8-arg `RegisterSubCard` ABI already in `registry.ts`) to independently enforce the RIP-7212 signature check regardless of what the press does or doesn't pre-check.
