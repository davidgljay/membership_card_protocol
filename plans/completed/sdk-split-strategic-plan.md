# App SDK / Wallet SDK Split — Strategic Plan

**Date:** 2026-07-05
**Status:** Draft for review
**Companion doc:** `sdk-split-implementation-plan.md`

## Context

`client-sdk/` (spec: `specs/object_specs/client_sdk.md`) currently bundles every holder-side capability the protocol specs assign to "the client" into one package: key generation, keyring/backup custody, offer construction *and* acceptance, subcard requesting *and* authorizing, messaging, and UUID/relay management. It's fully implemented through Phase 5 (243 core tests passing) with only Phase 6 (cross-platform hardening, docs, pre-production security review) outstanding.

The split divides this into two packages along a security boundary, not just a convenience boundary: an **App SDK** that a third-party app (or a server-side integrator — press, wallet-service, relay) can safely link against without ever touching a card's private key or backup material, and a **Wallet SDK** that holds custody and therefore imports the App SDK rather than duplicating any of its logic.

## Goals

1. **Make "no card private key or backup ever reaches app code" a structural property of the package boundary, not a documented convention.** Today this is true by discipline within one codebase; splitting means an app integrator physically cannot import `keyring.ts` or `recovery.ts` because that code doesn't exist in the package they depend on.

2. **Preserve all shipped, tested functionality with zero regression.** `client-sdk` has 243+ passing tests across three platform packages and a security review (CP-1) already behind it. The split must carry that work forward, not re-derive it — salvage, don't rewrite.

3. **Shape the dependency graph to match how it will actually be consumed.** Wallet SDK imports App SDK (+ verifier); App SDK imports only verifier. This isn't arbitrary — per the follow-on integration plan, the wallet-service, press, and relay each need *only* a subcard identity (an App SDK capability) to cosign/authenticate their own traffic; only an actual wallet integrator needs custody (Wallet SDK). Getting this shape right now avoids those three services depending on a package that also pulls in keyring/backup code they'll never use.

4. **Get both packages independently publishable to npm**, each with its own spec, so future changes to one don't force a review of the other's surface.

## Rationale

The current single-package design was reasonable while the SDK was being built by one team against one spec — but it means every app-facing integration guide has to explain "here's this whole SDK, but please never call these specific functions," which is a security footgun in an SDK explicitly designed around "no independently re-derived trust logic" and "never leave a private key recoverable-but-unpersisted" as structural invariants (§2 of the current spec). A structural invariant enforced by a type signature inside one package is not the same guarantee as one enforced by what a package even exposes to `npm install`.

The split is also a prerequisite for the integration work described after it (wallet-service, press, and relay each self-registering a subcard on initialization) — those three services should never gain transitive access to keyring/backup code just because they need to sign their own outbound traffic.

## Key Objectives

**Goal 1 — structural boundary:**
- App SDK package contains zero references to keyring encryption, backup wrap/unwrap, or recovery — verifiable by `grep`, not just code review.
- Wallet SDK is the only package that imports/re-exports `wallet/keyring.ts`, `wallet/backupRegistration.ts`, `wallet/recovery.ts`, and the offer-*acceptance* functions (`accept*OfferAndCountersign`, `acceptOpenOfferForNewWallet`, `acceptOpenOfferForExistingWallet`, `acceptTargetedOffer`) and the subcard-*authorization* functions (`handleSubCardRequest`, `assembleSubCardConsent`, `countersignSubCardRequest`).

**Goal 2 — no regression:**
- Every test currently passing in `client-sdk`/`client-sdk-web`/`client-sdk-rn` has an equivalent passing test in whichever new package inherits that module.
- `client-sdk-old/` retains the current codebase, untouched, as a reference and rollback point.

**Goal 3 — dependency shape:**
- `wallet-sdk`'s `package.json` lists `app-sdk` as a dependency; `app-sdk`'s lists only the verifier packages.
- No circular import between the two.

**Goal 4 — publishable:**
- Both packages have their own spec document, their own `package.json` with a real name/version, and pass `pnpm build && pnpm test` cleanly in CI before an npm publish is attempted.

## Proposed Capability Split

Based on the module boundaries already in `client_sdk.md`, and your stated split:

| Capability | Module today | Goes to |
|---|---|---|
| Provider interfaces, crypto/canonicalization core, `CardVerifier` factory, `ObliviousProtocolTransport` | `providers/`, `crypto/`, `verification/`, `transport/` | **App SDK** (shared foundation both packages build on) |
| Private key generation (master keypair, per-card keypairs) | `wallet/setupWallet.ts` (master), `offers/*.ts` (per-card) | Split: master-key generation is Wallet SDK only; per-card keypair generation for *offer construction* is App SDK |
| Subcard request + signing (requester side) | `subcards/requestSubCard.ts`, `wallet/deviceSubCard.ts` | **App SDK** |
| Subcard request *authorization* (granter side: validate, consent, countersign) | `subcards/handleSubCardRequest.ts`, `consent.ts`, `countersign.ts` | **Wallet SDK** |
| Sign arbitrary data with a subcard | new, thin wrapper over `SecureKeyProvider.sign` | **App SDK** |
| Messaging (envelope, fan-out, inbound decrypt) | `messaging/envelope.ts`, `fanout.ts`, `inbound.ts`, `decrypt.ts` | **App SDK** |
| UUID registration/deregistration, replenishment, realtime delivery | `messaging/uuid*.ts`, `replenishment.ts`, `delivery.ts` | **App SDK** |
| Offer construction + press finalization (offerer side) | `offers/targetedOffer.ts`, `openOffer.ts`, `forwardCountersignedTargetedOffer` | **App SDK** |
| Offer review + countersign + acceptance (recipient side) | `offers/offerVerification.ts`, `countersign.ts`, `*OfferAcceptance.ts` | **Wallet SDK** |
| Backup create/retrieve | `wallet/backupRegistration.ts`, `recovery.ts`'s fetch/decrypt half | **Wallet SDK** |
| Wallet setup, keyring, recovery, post-recovery deregistration | `wallet/setupWallet.ts`, `keyring.ts`, `kdf.ts`, `recovery.ts`, `subCardDeregistration.ts` | **Wallet SDK** |

The one real design fork this surfaces: **`wallet/deviceSubCard.ts`'s "self-signing" shortcut** (the wallet registers its own subcard without going through the request/consent/countersign pipeline, since it's both requester and granter). Once App SDK is a separate package the Wallet SDK depends on, this shortcut may no longer be the right shape — the wallet could instead call App SDK's ordinary `requestSubCard` and self-authorize the consent step, collapsing `deviceSubCard.ts` into a thin Wallet SDK wrapper around two App SDK primitives instead of a parallel code path. Flagged as Open Question 3 below.

## Open Questions

1. **Package names.** Proposing `@membership-card-protocol/app-sdk` and `@membership-card-protocol/wallet-sdk`, mirroring `@membership-card-protocol/verifier`'s naming. Confirm before scaffolding.

2. **Keystore/secret-service abstraction for server-side App SDK use.** You noted the App SDK's secure keystore needs to "account for a server-based tool" and "allow a keystore service or other integrated way of holding secrets." Today `SecureKeyProvider` is one interface with browser/RN defaults. For press/wallet-service/relay (Node.js, no WebCrypto/Keychain), does this mean: (a) a third default implementation (e.g., backed by a KMS or an in-process encrypted file, shipped in App SDK), or (b) leaving it host-app-supplied with only the interface defined in App SDK and no Node default shipped yet? This affects how much new provider code the App SDK build needs versus how much is deferred to the later wallet-service/press/relay integration work.

3. **`deviceSubCard.ts`'s fate**, per the fork noted above — keep as Wallet SDK convenience wrapper, or fully collapse into App SDK's ordinary request/consent primitives called back-to-back by the wallet itself.

4. **Where does `YubiKeyProvider` live?** It's backup-specific (Wallet SDK concern) but structurally sits with the other provider interfaces (App SDK, per the table above). Recommend: interface stays in App SDK for consistency with the other five providers; only wallet-side *usage* of it lives in Wallet SDK.

5. **Test/CI split.** `client-sdk-web`/`client-sdk-rn` currently hold *default provider implementations* for both app- and wallet-side concerns in one platform package each. Does each new SDK get its own `-web`/`-rn` sibling packages (4 new platform packages total), or do `client-sdk-web`/`-rn` become shared "default providers" packages that both App SDK and Wallet SDK depend on? Recommend the latter to avoid duplicating provider implementations — but this needs your confirmation since it changes the package count from 3 to potentially 3 (core split two ways + one shared providers package) rather than 6.

## Resolved Decisions

- **Package names:** `@membership-card-protocol/app-sdk` and `@membership-card-protocol/wallet-sdk`.
- **Server-side keystore:** interface only for now. App SDK ships the `SecureKeyProvider`-shaped interface with no Node default implementation; press/wallet-service/relay each supply their own until the later wallet-service/press/relay integration plan picks a concrete backing (KMS, encrypted file, etc.).
- **`deviceSubCard.ts`:** collapsed. Wallet SDK's own subcard registration becomes a thin wrapper calling App SDK's ordinary `requestSubCard` + self-authorizing the consent/countersign step, rather than a parallel self-signing implementation. This is a real code change during the split, not a straight port — flagged explicitly in the implementation plan.
- **Platform packages:** one shared "default providers" package per platform. `client-sdk-web`/`client-sdk-rn` become shared dependencies both App SDK and Wallet SDK consume, rather than being duplicated into four platform packages.
