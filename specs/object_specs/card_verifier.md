# Card Protocol — `@membership-card-protocol/verifier` npm Package Spec

**Version:** 0.1 (draft)  
**Date:** 2026-06-20  
**Status:** Draft

**Changelog (spec-consistency Phase 1):** Fixes #4, #18–#25, and Decision A (runtime app-certification chain re-walk: new `VerifierConfig.appCertificationRoot`, `APP_CARD_CHAIN_NOT_TRUSTED` error code, Stage 2 pipeline addition). See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 2):** Fixes #29, #30, and Decision (a) (Stage 2 additions for `capabilities`/`valid_until`/`attestation_level` checks — new `VerifierConfig.acceptedAttestationLevels`, error codes `CAPABILITY_NOT_GRANTED`, `SUBCARD_EXPIRED`, `ATTESTATION_LEVEL_INSUFFICIENT`; Stage 2 step reordering so `scope_clean: true` is recorded only after the app-certification chain walk completes, see §13 Decision 7; Stage 3 cached-chain-array note). See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, 2026-07-16):** Fix Tier 3 item (c) — Stage 2 step 15 (`app_signature` verification) is now explicitly a hard reject with error code `INVALID_APP_SIGNATURE`, matching every other check in the stage; both the TypeScript (`stage2.ts`) and Python (`stage2.py`) verifier ports were missing the `return` after recording this error, allowing execution to fall through to the app-certification chain walk and potentially still record `scope_clean: true`. Tier 3 item (l) — formalized `app_card_chain_valid` in §8's result type (already present in both language ports, previously undocumented), letting callers distinguish an app-certification chain failure from any other Stage 2 rejection. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, 2026-07-16, Tier 3 item (k)):** `VerifierConfig.appCertificationRoot` (§5) was unconditionally required in both language ports' constructors, contradicting this spec's own "optional, required only for sub-card verification" description. Code now matches spec: the field is optional at construction; Stage 2 step 16 (§7.2) hard rejects with the new error code `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` (§9) if a sub-card signature is actually encountered on a verifier instance where it isn't configured, rather than silently skipping the chain walk. See `plans/spec-consistency/inconsistencies/code-verifier-sdk.md` Finding 1 and `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (k).

**Changelog (spec-consistency Phase 3, 2026-07-16, Tier 3 item (i)):** `RpcProvider.getLogEntries(cardAddress): Promise<LogEntry[]>` (§4.1) modeled a fictional on-chain-enumerable per-entry log that doesn't exist in `registry_contract.md`'s actual ABI — the contract only ever stores the current `log_head_cid`. Replaced with `RpcProvider.getCardEventLog(cardAddress): Promise<CardChainEvent[]>`, which replays the registry's real `CardRegistered`/`CardHeadUpdated` events to reconstruct the ground-truth, oldest-first CID/timestamp sequence. Stage 4 (§7.4) is rewritten around this: it now takes Stage 3's already-decrypted `chain` (`ChainLink[]`) as input, cross-checks each `LogEntry` head's self-reported `history` array against the on-chain event replay (new error code `HISTORY_MISMATCH`, §9), and uses the matching on-chain event's timestamp — not the IPFS content's self-reported date — as the authoritative revocation effective-date (new fallback error code `NO_ONCHAIN_EVENT_FOR_HEAD`, §9). Both language ports (`membership_card_verifier/packages/verifier` and `verifier-py`) and the `verifier-rpc-provider` companion package were updated to match; full test suites pass in both ports. See `plans/spec-consistency/inconsistencies/code-card.md` Finding 2b and `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (i).

**Changelog (spec-consistency Phase 3, 2026-07-16, Tier 1 items 6–7):** `chain_card_addresses` (§8) is now actually exposed on the public result — it was computed internally by Stage 3 but never threaded through to the four result-construction sites in either language port; fixed in both, with the field added to every code path (`verifyEnvelope`'s main path, `verifyCard`, the internal `#buildResult`/`_build_result` helper, and the skipped-result fallback). Also documented several already-implemented, previously-undocumented features: `VerifierConfig.returnChain` and the corresponding `chain`/`ChainLink` result fields (§5, §8), `VerifierConfig.conditions`/`PolicyMatchConditions` (§5) — resolving a real contradiction where §7.5 step 4 described an unimplemented call-site `requiredPredicate`/`requiredPolicy` shape instead of the actual, tested construction-time-config design — `CardVerificationResult.protocol_version` (§8), and `SignatureEntry.key_scheme` (§6.1). See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 1 items 6–7.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Installation and Environment](#3-installation-and-environment)
4. [Provider Interfaces](#4-provider-interfaces)
   - 4.1 [RpcProvider](#41-rpcprovider)
   - 4.2 [IpfsProvider](#42-ipfsprovider)
5. [Configuration](#5-configuration)
6. [Primary API](#6-primary-api)
   - 6.1 [verifyEnvelope](#61-verifyenvelope)
   - 6.2 [verifyCard](#62-verifycard)
7. [Verification Pipeline](#7-verification-pipeline)
   - 7.1 [Stage 1 — Signature Validity](#71-stage-1--signature-validity)
   - 7.2 [Stage 2 — Sub-Card to Master Link](#72-stage-2--sub-card-to-master-link)
   - 7.3 [Stage 3 — Chain Walk](#73-stage-3--chain-walk)
   - 7.4 [Stage 4 — Revocation Check](#74-stage-4--revocation-check)
   - 7.5 [Stage 5 — Policy Compliance](#75-stage-5--policy-compliance)
   - 7.6 [Stage 6 — EAS Annotation Lookup](#76-stage-6--eas-annotation-lookup)
   - 7.7 [Stage 7 — Recipient-Set Check](#77-stage-7--recipient-set-check)
   - 7.8 [Non-Compliance Reporting](#78-non-compliance-reporting)
8. [Result Types](#8-result-types)
9. [Error Handling](#9-error-handling)
10. [Serialization](#10-serialization)
11. [Cryptographic Primitives](#11-cryptographic-primitives)
12. [Dependencies](#12-dependencies)
13. [Decisions](#13-decisions)

---

## 1. Overview

`@membership-card-protocol/verifier` is a Node.js library that verifies `SignedMessageEnvelope` objects produced by the Card Protocol. A verifier answers four questions per signature:

1. Is the signature cryptographically valid?
2. Was the signing card valid at the time of signing?
3. Is the signing card currently valid?
4. Does the card meet the relying party's policy requirements?

Verification is fully independent — no contact with the signer, issuer, or press is required. Any party with access to IPFS and the Arbitrum One registry can verify a card.

The package is **thin**, with two categories of network access. **Provider-mediated I/O** — all Arbitrum One RPC reads and IPFS fetches — is performed through caller-supplied provider interfaces; the package supplies the protocol logic and the caller supplies the transport. **Package-internal HTTP calls** are the deliberate exceptions: the non-compliance POST to the Press Registry Body (§7.8) and the recommended annotators GET (§7.6) are made directly by the package and cannot be intercepted or skipped by the caller. This is intentional — both calls enforce governing-body requirements that must not be delegatable to the implementer.

**Scope boundary — replay and freshness.** This package does not perform replay or freshness checking (`card_validation.md` Stage 8: message-ID computation, timestamp-freshness-window checks, or replay detection against message history). That responsibility is left to the caller's own storage/dedup layer — consistent with how `app_sdk.md` §9.2 already implements message deduplication via a caller-supplied `StorageProvider` rather than any logic internal to the verifier. Callers that need replay protection should compute the message ID (per `card_validation.md` Stage 8 step 33) and check it against their own history before or after calling `verifyEnvelope`.

**Scope boundary — policy-creation-chain verification.** This package's `verifyCard`/`verifyEnvelope` do not implement `card_validation.md`/`card_protocol_spec.md`'s Stage 5a (Policy Creation Compliance) — walking a policy card's own policy-creation chain and collecting inherited `field_definitions` restrictions is out of scope. Stage 5 (§7.5) evaluates an issued card's field values against the policy snapshot in effect at issuance; it does not separately verify that the policy itself was validly created. A caller needing policy-level verification (e.g., when verifying a policy card rather than an ordinary issued card) is responsible for performing that check separately.

---

## 2. Design Principles

**Injected providers.** The package accepts an `RpcProvider` and an `IpfsProvider` at construction time. It has no opinion on which ethers/viem version the caller uses, which IPFS gateway they prefer, or how they handle caching.

**All stages run.** Verification does not short-circuit on a failed stage (except within a stage where a hard rejection is defined — see §7). All five stages run, and the structured result reflects the outcome of each independently. Callers decide how to interpret the combined result.

**Hard rejections are explicit.** Where the spec defines a hard rejection (address binding mismatch, AES-GCM auth failure), the affected stage is marked failed and remaining within-stage steps are skipped. Subsequent stages that depend on that stage's output are also skipped and marked `"skipped"`.

**Result per signature.** The `verifyEnvelope` call returns one `SignatureVerificationResult` per entry in the envelope's `signatures` array.

**Freshness is configurable.** Revocation data freshness tolerance is set at construction time via `VerifierConfig`. Stale data causes a `data_freshness_seconds` flag; whether to treat it as a hard failure is caller-controlled via `config.rejectStaleRevocation`.

**Language bindings.** This document — describing the npm package `@membership-card-protocol/verifier` — is the canonical source of truth for this API's behavior. The Python port at `membership_card_verifier/packages/verifier-py` (used with an equivalent snake_case API by `matrix_synapse_module.md`) must track it field-for-field: every provider method, config option, pipeline stage, result field, and error code described here has a corresponding Python member, differing only in naming convention (`snake_case` instead of `camelCase`/`PascalCase`, e.g. `chain_card_addresses` rather than `chainCardAddresses`). That naming difference is expected and intentional for this binding; any behavioral divergence beyond naming convention is a bug in the Python port, not an alternate spec.

---

## 3. Installation and Environment

**Runtime:** Node.js ≥ 22.  
**Module system:** ESM only (`.mjs` / `"type": "module"`).  
**Package name:** `@membership-card-protocol/verifier`

No bundled RPC client or IPFS client is included. Callers install and configure their own.

---

## 4. Provider Interfaces

### 4.1 RpcProvider

The `RpcProvider` interface abstracts all Arbitrum One registry reads.

```typescript
interface RpcProvider {
  /**
   * Returns the CardEntry for the given on-chain address (bytes32 hex string),
   * or null if no entry exists.
   */
  getCardEntry(address: string): Promise<CardEntry | null>;

  /**
   * Returns whether the given address is registered in PolicyAuthorizerKeys
   * (i.e., is a trusted root).
   */
  isPolicyAuthorizer(address: string): Promise<boolean>;

  /**
   * Returns the PressAuthEntry for the given (policyAddress, pressAddress) pair,
   * or null if no entry exists.
   */
  getPressAuthorization(
    policyAddress: string,
    pressAddress: string
  ): Promise<PressAuthEntry | null>;

  /**
   * Returns the SubCardEntry for the given sub-card address, or null.
   */
  getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null>;

  /**
   * Replays the on-chain event log for a card address and returns the ground-truth,
   * oldest-first sequence of every IPFS object CID this card has ever pointed to,
   * each paired with the authoritative on-chain timestamp it became the head.
   *
   * The registry contract has no on-chain-enumerable per-entry log — `CardEntries`
   * stores only the current `log_head_cid` (`registry_contract.md §3.1`). This
   * method reconstructs the ground-truth CID sequence by filtering that card
   * address's `CardRegistered` (genesis, `initial_log_cid`) and `CardHeadUpdated`
   * (each subsequent entry, `new_log_cid`) events and ordering by block
   * (`registry_contract.md §7`). It returns CIDs and timestamps only — never
   * decrypted card content, which lives on IPFS and is fetched via `IpfsProvider`.
   * Stage 4 (§7.4) combines this with the IPFS-fetched head content (already
   * available from Stage 3's chain walk) to determine revocation status.
   */
  getCardEventLog(cardAddress: string): Promise<CardChainEvent[]>;

  /**
   * Returns all EAS attestations targeting the given card address
   * where the attester is one of the provided annotator card addresses.
   * Returns an empty array if no matching attestations exist.
   * Used for Stage 6 annotation lookup.
   */
  getEasAnnotations(
    cardAddress: string,
    annotatorAddresses: string[]
  ): Promise<EasAttestation[]>;
}

interface EasAttestation {
  uid: string;              // EAS attestation UID (bytes32 hex)
  attester: string;         // annotator card address (bytes32 hex)
  cid: string;              // IPFS CID of the annotation content document
  update_code: number;      // 2xx | 4xx | 6xx — annotation valence
  effective_date: string;   // ISO 8601
}

interface CardEntry {
  log_head_cid: string;
  policy_address: string;
  last_press_address: string;
  forward_to: string | null;
  exists: boolean;
}

// This is a client-side projection of a subset of the on-chain `PressAuthEntry`
// struct (`registry_contract.md §3.3`) — `key_scheme` and `next_sequence` are
// omitted as not currently useful to a runtime verifier.
interface PressAuthEntry {
  press_public_key: string;        // secp256r1, 64-byte hex (x||y)
  mldsa44_key_hash: string;        // bytes32 hex
  active: boolean;
  authorized_at: string;           // ISO 8601
  revoked_at: string | null;       // ISO 8601, null if still active
}

interface SubCardEntry {
  master_card_address: string;
  registration_log_head: string;
  sub_card_doc_cid: string;
  active: boolean;
  registered_at: string;
  deregistered_at: string | null;
}

// One entry in the on-chain event-replay sequence for a card (see
// `RpcProvider.getCardEventLog`). `cid` is the IPFS object that became the head
// as of `timestamp` — the genesis `CardDocument` CID for the first entry, or a
// post-genesis `LogEntry` CID for every subsequent entry. Does not carry
// `update_code`/`entry_type` — those live only in the IPFS content itself, not
// on chain; Stage 4 (§7.4) combines the two.
interface CardChainEvent {
  cid: string;
  timestamp: string;                // ISO 8601 — on-chain block timestamp
}
```

### 4.2 IpfsProvider

The `IpfsProvider` interface abstracts all IPFS content fetches.

```typescript
interface IpfsProvider {
  /**
   * Fetches raw bytes for a given CID.
   * Implementations may use any IPFS gateway or local node.
   * Must throw if the CID cannot be resolved within the caller's timeout.
   */
  fetch(cid: string): Promise<Uint8Array>;
}
```

---

## 5. Configuration

```typescript
interface VerifierConfig {
  /** Injected Arbitrum One RPC provider. Required. */
  rpc: RpcProvider;

  /** Injected IPFS provider. Required. */
  ipfs: IpfsProvider;

  /**
   * Trusted root addresses (bytes32 hex strings). These supplement the
   * on-chain PolicyAuthorizerKeys table. Callers may supply a known set
   * of trusted roots as a local override or cache.
   * Default: [] (on-chain table is authoritative).
   */
  trustedRoots?: string[];

  /**
   * Maximum age in seconds of revocation data before it is considered stale.
   * Default: 300 (5 minutes).
   */
  revocationFreshnessWindowSeconds?: number;

  /**
   * If true, stale revocation data is treated as a hard failure
   * (is_currently_valid: false). If false, stale data is flagged but
   * is_currently_valid is determined from cached data with a warning.
   * Default: true.
   */
  rejectStaleRevocation?: boolean;

  /**
   * Maximum number of chain hops before the walk is aborted.
   * Prevents infinite loops on malformed ancestry_pubkeys arrays.
   * Default: 64.
   */
  maxChainDepth?: number;

  /**
   * The on-chain address (bytes32 hex) of the governance authority's
   * app-certification policy root. Used by Stage 2 (§7.2) to independently
   * re-walk a sub-card's app_card ancestry_pubkeys chain at runtime — see
   * §7.2 step 16 and error code APP_CARD_CHAIN_NOT_TRUSTED (§9). Optional at
   * construction — required only whenever the caller expects to verify
   * signatures from sub-cards. A verifier instance that only ever verifies
   * primary-card signatures may omit it. If this verifier instance actually
   * encounters a sub-card signature and this field is not configured, Stage 2
   * step 16 hard rejects with error code APP_CERTIFICATION_ROOT_NOT_CONFIGURED
   * (§9) rather than silently skipping the chain walk — omitting this field is
   * not a way to bypass app-certification enforcement, only a way to avoid
   * configuring it for verifier instances that never need it.
   */
  appCertificationRoot?: string;

  /**
   * Attestation levels this verifier accepts from sub-cards. Per
   * protocol-objects.md §16 step 11, a sub-card's attestation_level must be
   * "T2" unless the governing policy explicitly accepts "T1" — see §7.2
   * step 14 and error code ATTESTATION_LEVEL_INSUFFICIENT (§9). Callers
   * whose governing policy accepts T1 sub-cards should include "T1" here;
   * callers governing multiple policies with different acceptance rules
   * should construct separate CardVerifier instances per policy, or a
   * per-call override, rather than relaxing this globally.
   * Default: ["T2"].
   */
  acceptedAttestationLevels?: ("T1" | "T2")[];

  /**
   * This verifier's own card on-chain address (bytes32 hex). Used to
   * compute addressed_to_verifier (§7, Stage 7 — Recipient-Set Check) by
   * checking whether this address appears in the envelope's recipient set.
   * If omitted, addressed_to_verifier is always false and a caller-supplied
   * per-call override (VerifyCardOptions / verifyEnvelope options,
   * verifierCardAddress) is required to compute it for that call.
   */
  verifierCardAddress?: string;

  /**
   * Endpoint for submitting non-compliance reports to the Press Registry Body.
   * Hardcoded to the governing body's production URL before release.
   * Default: PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER
   */
  registryEndpoint?: string;

  /**
   * Whether to fetch EAS annotations during Stage 6.
   * When false, annotations is always [] in the result.
   * Default: false.
   */
  fetchAnnotations?: boolean;

  /**
   * Additional EAS annotator card addresses (bytes32 hex) to include
   * when filtering Stage 6 results, beyond the governing body's recommended
   * list fetched from RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER.
   * Default: [].
   */
  additionalAnnotators?: string[];

  /**
   * Documented 2026-07-16 (spec-consistency Phase 3, Tier 1 item 7 — this
   * field was already implemented and tested; only undocumented). If true,
   * the full resolved chain (ChainLink[] — each link's card_address,
   * public_key, and decrypted card_content) is included on the result as
   * `chain` (§8). `chain_card_addresses` (address-only) is always present
   * regardless of this setting; `chain` additionally exposes full card
   * content for callers that need it (e.g. building a UI showing the
   * resolved ancestry). Default: false.
   */
  returnChain?: boolean;

  /**
   * Documented 2026-07-16 (spec-consistency Phase 3, Tier 1 item 7 —
   * resolves a prior contradiction: an earlier draft of this document
   * described the equivalent option as a call-site parameter on
   * verifyEnvelope/verifyCard rather than construction-time config. The
   * implemented, tested design — construction-time config, evaluated fresh
   * on every call against that call's resolved chain — is confirmed
   * correct; §7.5 step 4 below has been corrected to match.) The relying
   * party's policy-match predicate, evaluated in §7.5 step 4 against the
   * signer's resolved chain to produce the top-level `policy_match` result
   * field. A verifier instance with no `conditions` configured always
   * produces `policy_match: null` (predicate not evaluated, not "evaluated
   * and failed"). Callers governing multiple policies with different
   * predicates should construct separate CardVerifier instances per
   * policy rather than expecting per-call predicate overrides — none exist.
   */
  conditions?: PolicyMatchConditions;
}
```

```typescript
// Documented 2026-07-16 (Tier 1 item 7) — the shape of VerifierConfig.conditions.
interface PolicyMatchConditions {
  policy_id: string;                              // CID — checked via issued_under_template
                                                    // semantics against the resolved chain
  field_match?: Record<string, string | { regex: string }>;
  // Per-field constraint on the chain member issued under policy_id. A plain
  // string value is exact-match shorthand; { regex } is evaluated as a full
  // regular expression against the field's string value.
}
```

A `CardVerifier` instance is constructed once and reused across verifications:

```typescript
class CardVerifier {
  constructor(config: VerifierConfig);
  verifyEnvelope(envelope: SignedMessageEnvelope, options?: VerifyEnvelopeOptions): Promise<EnvelopeVerificationResult>;
  verifyCard(cardAddress: string, options?: VerifyCardOptions): Promise<CardVerificationResult>;
}
```

---

## 6. Primary API

### 6.1 verifyEnvelope

Verifies a `SignedMessageEnvelope`. Returns one `SignatureVerificationResult` per entry in `envelope.signatures`.

```typescript
verifyEnvelope(
  envelope: SignedMessageEnvelope,
  options?: VerifyEnvelopeOptions
): Promise<EnvelopeVerificationResult>

interface VerifyEnvelopeOptions {
  /**
   * Overrides config.verifierCardAddress for this call only. Used to compute
   * addressed_to_verifier (§7, Stage 7 — Recipient-Set Check).
   */
  verifierCardAddress?: string;
}
```

**Input:**

```typescript
interface SignedMessageEnvelope {
  payload: {
    message: string;
    timestamp: string;         // ISO 8601 — used for was_valid_at_signing_time
    [key: string]: unknown;
  };
  signatures: SignatureEntry[];
}

interface SignatureEntry {
  public_key: string;          // base64url ML-DSA-44 public key, 1312 bytes
  signature: string;           // base64url ML-DSA-44 signature, 2420 bytes
  key_scheme?: "mldsa44" | "secp256r1_phase1";  // documented 2026-07-16 (Tier 1 item 7).
                                // Optional; defaults to "mldsa44" when absent (every card-level
                                // signature in the protocol is ML-DSA-44 today). Present to carry
                                // forward the on-chain key-scheme distinction registry_contract.md
                                // §3.3's PressAuthEntry.key_scheme makes for a press's on-chain
                                // write-authorization key during the Phase 1→2 secp256r1→ML-DSA-44
                                // upgrade window (ADR-012) — this field is about that separate
                                // on-chain key, not about re-typing Stage 1's signature verification,
                                // which remains ML-DSA-44-only for every SignatureEntry this package
                                // verifies.
}
```

**Output:** See §8.

### 6.2 verifyCard

Verifies a card's chain and current status without a `SignedMessageEnvelope`. Useful for pre-flight checks (e.g., checking whether a card is currently valid before accepting a presentation).

Runs Stages 2–5 only (no `payload` to verify a signature against). Stage 1 is skipped; `signature_valid` is `null` in the result.

```typescript
verifyCard(
  cardAddress: string,
  options?: VerifyCardOptions
): Promise<CardVerificationResult>

interface VerifyCardOptions {
  /** ISO 8601 timestamp to use as "signing time" for revocation checks. Defaults to now. */
  asOf?: string;
}
```

---

## 7. Verification Pipeline

Stages run in order. A hard rejection within a stage skips remaining steps in that stage and marks dependent downstream stages as `"skipped"`. Stages that do not depend on failed output still run.

### 7.1 Stage 1 — Signature Validity

**Input:** `SignatureEntry`, `envelope.payload`  
**Network:** None.

1. Decode `public_key` from base64url (must be exactly 1,312 bytes; reject otherwise).
2. Decode `signature` from base64url (must be exactly 2,420 bytes; reject otherwise).
3. Canonicalize `envelope.payload` per RFC 8785 (see §10).
4. Verify the ML-DSA-44 signature over the canonical bytes using `public_key`.
5. Record `signature_valid: true | false`.

A `signature_valid: false` result does not abort subsequent stages. The chain walk may still produce useful context (e.g., for audit logging).

### 7.2 Stage 2 — Sub-Card to Master Link

**Input:** `public_key` from `SignatureEntry`  
**Network:** Arbitrum One (`getCardEntry`, `getSubCardEntry`), IPFS (sub-card doc, master card doc).

1. Derive the signer's on-chain address: `keccak256(public_key)` (bytes32 hex).
2. Fetch `CardEntry` from the registry. If `entry.exists == false`, **hard reject** (`scope_clean: false`), skip Stage 2 remaining steps.
3. Derive the leaf content key: `HKDF-SHA3-256(public_key, info="card-content-v1")`.
4. Fetch and decrypt the sub-card document from IPFS using the leaf content key (AES-256-GCM). If decryption fails, **hard reject** (`scope_clean: false`).
5. Read `holder_primary_card_pubkey` and `app_card_pubkey` from the decrypted `SubCardDocument`.
6. Binding checks (both are hard rejections on failure):
   - `keccak256(holder_primary_card_pubkey)` must equal the `holder_primary_card` pointer address in the sub-card document.
   - `keccak256(app_card_pubkey)` must equal the `app_card` pointer address in the sub-card document.
7. **Capability check** (`protocol-objects.md §16` step 1): confirm the message type being verified (`envelope.payload.message`) appears in the sub-card's `capabilities` array. **Hard reject** with error code `CAPABILITY_NOT_GRANTED` and record `scope_clean: false` if it does not. This check applies only when verifying a `SignedMessageEnvelope` (`verifyEnvelope`) — there is no message type to check against when running `verifyCard()`, so this check is skipped (not evaluated, not treated as a pass) in that path.
8. **Expiry check** (`protocol-objects.md §16` step 2): if `valid_until` is present on the sub-card document, confirm it has not passed as of now. **Hard reject** with error code `SUBCARD_EXPIRED` and record `scope_clean: false` if it has. Absent `valid_until` means no expiry.
9. Derive the master card content key: `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")`.
10. Fetch and decrypt the master card document from IPFS. AES-GCM auth failure is a **hard reject** (`scope_clean: false`).
11. Confirm the sub-card address appears in the master card's `active_subcards` field (`protocol-objects.md §1.1`): for each entry, derive `keccak256(entry_pubkey)` and confirm one matches the sub-card's own address (from step 1). **Hard reject** (`scope_clean: false`) if absent — this check is independent of the on-chain `SubCardRegistrations[sub_card_address].active` flag checked in step 13; either failing alone is sufficient to reject. If `active_subcards` is absent from the master card entirely, treat it as an empty directory (no sub-card passes this check).

    When processing any code-510/511/512 `LogEntry` encountered on the master card's own log while resolving `active_subcards` (e.g., during an audit of how the directory reached its current state), confirm the entry's `intent_signature` was produced by the master card's own holder key — i.e., `keccak256` of the `intent_signature`'s public key must equal the master card's own on-chain address. This authorization is hardcoded per `protocol-objects.md §1.1` and is **not** subject to the governing policy's `update_policy`. **Hard reject that log entry** (do not apply it) if the check fails, regardless of any policy predicate — this is a MUST, matching `card_validation.md` step 9.
12. Verify the master card holder's ML-DSA-44 signature on the sub-card registration using `holder_primary_card_pubkey`.
13. Check on-chain: `SubCardRegistrations[sub_card_address].active == true`. If `false`, record `scope_clean: false`.
14. **Attestation-level check** (`protocol-objects.md §16` step 11): confirm `attestation_level` is `"T2"`, unless it is `"T1"` and `"T1"` appears in `config.acceptedAttestationLevels` (default `["T2"]` — see §5). **Hard reject** with error code `ATTESTATION_LEVEL_INSUFFICIENT` and record `scope_clean: false` otherwise.
15. Verify `app_signature` using `app_card_pubkey`. **Hard reject** with error code `INVALID_APP_SIGNATURE` and record `scope_clean: false` if the signature does not verify — this is a MUST, matching the hard-reject pattern of every other check in this stage; verification must not fall through to step 16 or reach a `scope_clean: true` conclusion (step 17) when this check fails.
16. **App-certification chain walk (runtime, independent of press registration-time check).** This is the point at which the pipeline has confirmed the signer is in fact a sub-card (steps 1–15 have all passed). **If `config.appCertificationRoot` is not configured on this verifier instance, hard reject** with error code `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` and record `scope_clean: false` — do not silently skip this step or fall through to a `scope_clean: true` conclusion. `appCertificationRoot` is optional at construction (see §5) precisely so that verifier instances scoped to primary-card-only use are not forced to configure a governance root they will never use; the tradeoff is that any sub-card signature such an instance actually encounters must be rejected loudly, not waved through. Otherwise, regardless of whatever check a press already performed at sub-card registration time — the press's check is an early gate, not a substitute for this runtime check — independently walk the `app_card`'s `ancestry_pubkeys` chain to confirm it reaches `config.appCertificationRoot`:
    a. Derive the app card's content key: `HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")`.
    b. Fetch and decrypt the app card document from IPFS.
    c. Walk `ancestry_pubkeys` hop by hop: for each entry, derive the expected on-chain address via `keccak256(entry_pubkey)` and confirm it matches the on-chain address being resolved from the prior link (the same keccak256 binding check used in Stage 3's chain walk), fetching and decrypting each ancestor in turn.
    d. Continue until the chain reaches `config.appCertificationRoot`, or the walk exhausts `ancestry_pubkeys` without reaching it, or the walk exceeds `config.maxChainDepth` — whichever comes first.
    e. **Hard reject** with error code `APP_CARD_CHAIN_NOT_TRUSTED` and record `scope_clean: false` if the chain exhausts without reaching `config.appCertificationRoot` or exceeds `config.maxChainDepth`.
    This stage runs on every signature from a sub-card, unconditionally — it is not skipped because a press accepted the sub-card at registration time.
17. If all checks above — including the step 16 app-certification chain walk — pass, record `scope_clean: true`. This is recorded only after step 16 completes; a failure discovered during the step 16 chain walk overrides any provisional pass from steps 1–15 (see `§13 Decision 7`).

### 7.3 Stage 3 — Chain Walk

**Input:** Decrypted master card from Stage 2 (if successful); falls back to the signer's card if Stage 2 was skipped (e.g., in `verifyCard`).  
**Network:** Arbitrum One (`getCardEntry`, `isPolicyAuthorizer`), IPFS (ancestor card docs).

1. Read `ancestry_pubkeys` from the master card. This array is ordered from immediate parent toward the trusted root. As the walk proceeds, append each resolved on-chain address (starting with the card itself, then each successfully resolved ancestor) to `chain_card_addresses` in the result (§8) — ordered from the card itself up to the trusted root.
2. Before each iteration, check whether the next on-chain address is present in `PolicyAuthorizerKeys` (via `isPolicyAuthorizer`) or in `config.trustedRoots`. If yes, the chain has reached a trusted root — terminate successfully.
3. For each entry in `ancestry_pubkeys`:
   a. Derive expected on-chain address: `keccak256(entry_pubkey)`. If this does not match the on-chain address being resolved from the prior link, **hard reject** the walk (`chain_reaches_trusted_root: false`).
   b. Derive the ancestor's content key: `HKDF-SHA3-256(entry_pubkey, info="card-content-v1")`.
   c. Fetch and decrypt the ancestor card from IPFS. AES-GCM auth failure is a **hard reject**.
   d. Verify the issuer's ML-DSA-44 signature on the ancestor document using `entry_pubkey`.
   e. Confirm scope attenuation: the sub-card's registered scope does not exceed the master card's scope at registration time (using `registration_log_head` from the on-chain `SubCardEntry`).
4. If `ancestry_pubkeys` is exhausted (`[]`) and the current card's address is in `PolicyAuthorizerKeys`, record `chain_reaches_trusted_root: true`.
5. If `ancestry_pubkeys` is exhausted and the current card's address is **not** in `PolicyAuthorizerKeys`, record `chain_reaches_trusted_root: false`.
6. If the walk exceeds `config.maxChainDepth`, abort and record `chain_reaches_trusted_root: false` with error code `CHAIN_DEPTH_EXCEEDED`.

**Cached chain array (optimization, not a caller-visible input).** `card_validation.md` step 15 describes resolving the chain using both `ancestry_pubkeys` (for pubkey/content-key derivation) and a "cached chain array" of version CIDs, so that IPFS fetches for the whole chain can be issued in parallel rather than strictly sequentially. This package does not expose an equivalent caller-visible parameter — `IpfsProvider` (§4.2) is a single `fetch(cid)` method, and any batching or pre-fetch caching of chain CIDs is an implementation detail left entirely to the `IpfsProvider` the caller supplies (consistent with §13 Decision 4, "Caching"). If such a cache is used and its entries diverge from the per-link on-chain addresses resolved during the walk above, **the per-link on-chain addresses are authoritative** — use those and flag the discrepancy in `errors`, matching `card_validation.md`'s discrepancy-resolution rule exactly.

### 7.4 Stage 4 — Revocation Check

**Input:** Stage 3's `chain` (`ChainLink[]` — each already-fetched-and-decrypted card's on-chain address, public key, and IPFS head content; see §7.3, §8).  
**Network:** Arbitrum One (`getCardEntry`, `getCardEventLog`) — resolved in parallel for every chain member; no second IPFS fetch pass (Stage 3's decrypted content is reused).

There is no on-chain-enumerable per-entry log: the registry contract's `CardEntries` mapping stores only the current `log_head_cid` (`registry_contract.md §3.1`). "The log" for a card is reconstructed from two independent sources (`ipfs_card.md §5`, `protocol-objects.md §3` "Provenance verification"):

- The card's current head content (Stage 3's `ChainLink.card_content`) — either the genesis `CardDocument` (never updated) or the most recent `LogEntry` (`entry_type`, `code`, `history`, `card_state`, `revocation`).
- The ground-truth on-chain event replay (`RpcProvider.getCardEventLog`), which returns only `{cid, timestamp}` pairs, never content.

The head content tells us *what* the current state is (revoked or not, which field-update code if any); the on-chain event replay tells us *when* that became true (authoritative block timestamp) and lets the verifier cross-check that the head's self-reported `history` claim matches the real on-chain record.

1. For every `ChainLink` in the chain, call `getCardEntry` and `getCardEventLog` in parallel to obtain the current `log_head_cid` and the full oldest-first on-chain CID/timestamp sequence.
2. If a chain member has no decrypted `card_content` available (the `verifyCard` limitation — see below), skip revocation-status determination for it but still use its event log for provenance bookkeeping.
3. For a chain member whose head content is a `LogEntry` (`entry_type` is `"field_update"` or `"revocation"`) and carries a `history` array: reconstruct `history + [own head CID]` and compare it, in order and count, against the on-chain event replay's CID sequence. On any mismatch, record error code `HISTORY_MISMATCH` (stage 4) — this is the provenance cross-check that catches a press misreporting or truncating `history`.
4. Determine the authoritative effective date for the head entry from the on-chain event matching `log_head_cid`, not the IPFS content's self-reported date — a compromised or buggy press could misreport the latter, but the on-chain block timestamp cannot be forged after the fact. If no on-chain event matches the head CID, fall back to the content's self-reported `effective_date` and record error code `NO_ONCHAIN_EVENT_FOR_HEAD` (stage 4).
5. Partition each chain member's head entry by `entry_type`/`code`:
   - **`field_update` (1xx–7xx):** Add one entry to `log_updates` in the result, dated by the on-chain event's timestamp. These are returned regardless of whether the card passes or fails verification — they provide context about the card's history (e.g., field updates, key rotations, successor designations) that callers may surface to users or use for audit purposes.
   - **`revocation`, 8xx (quiet revocation):** Things before `effective_date` are trusted; the card is not currently valid on or after `effective_date`.
   - **`revocation`, 9xx (loud revocation):** Things on or after `effective_date` are suspect. Verifiers should surface this to allow issuers of other cards held by the same holder to investigate.
   - Genesis `CardDocument` head (never updated): not revoked, no field update.
   - If multiple chain members carry an 8xx or 9xx revocation, the earliest `effective_date` across the whole chain governs.
6. Determine `was_valid_at_signing_time`: if no revocation entry has `effective_date ≤ envelope.payload.timestamp`, record `true`; otherwise `false`.
7. Determine `is_currently_valid`: if no revocation entry has `effective_date ≤ now`, record `true`; otherwise `false`.
8. Record `revocation.data_freshness_seconds` — the age in seconds of the revocation data at the time of the check.
9. If `data_freshness_seconds` exceeds `config.revocationFreshnessWindowSeconds`:
   - Always record the staleness in the result (error code `STALE_REVOCATION_DATA`).
   - If `config.rejectStaleRevocation == true`, set `is_currently_valid: false`.

**`verifyCard` limitation.** `verifyCard(cardAddress)` has no recipient public key and therefore cannot decrypt any card content — its `chain` has exactly one `ChainLink` with an empty `card_content`. In this path, no chain member's revocation status can be determined from content, so Stage 4 returns `revocation.status: "unknown"`, `was_valid_at_signing_time: "skipped"`, and `is_currently_valid: "skipped"` (the on-chain event log is still fetched, but only for provenance bookkeeping, not a status determination).

### 7.5 Stage 5 — Policy Compliance

**Input:** Card's `policy_id` CID (from the CardDocument), press address from `CardEntry.last_press_address`.  
**Network:** IPFS (policy snapshot at `policy_id` CID), Arbitrum One (`getPressAuthorization`).

1. Fetch the policy snapshot at the immutable `policy_id` CID from IPFS. The policy at issuance governs — the policy's current mutable pointer head is not used.
2. Evaluate the card's **declared-field** values against `field_definitions` in the policy snapshot. Any violation → `policy_compliant: false`. A card carrying additional fields not declared in `field_definitions` is not itself a violation — the policy's schema is a floor (required fields plus declared fields), not a closed allow-list; see `card_protocol_spec.md` §Background Concepts, *A Card's Schema Is a Floor, Not a Closed Allow-List*. The package does not attempt to validate undeclared fields against anything and must not choke on or reject a card for their presence.
3. Look up `PressAuthorizations[policy_id_address][press_address]` on-chain:
   - If no entry exists, record `policy_compliant: false`. (No entry means the press was never authorized; the card could not have been validly registered.)
   - If an entry exists, on-chain registration is proof of write-time authorization. A press that is currently `active == false` (subsequently revoked) does **not** retroactively invalidate the card. Record `policy_compliant: true` if field values also passed; surface the subsequent revocation as informational context (`press_subsequently_revoked: true`) in the result.
4. **Corrected 2026-07-16 (Tier 1 item 7):** if `VerifierConfig.conditions` (§5) is configured — construction-time config, not a call-site option; an earlier draft of this section described a call-site `requiredPredicate`/`requiredPolicy` shape that was never implemented and is not the correct API — evaluate it against the signer's resolved chain. Predicate failure sets `policy_match: false` but does not affect `policy_compliant`. If no `conditions` is configured, `policy_match` is `null` (not evaluated), regardless of the signer's actual compliance.
5. **Non-compliance reporting:** If `policy_compliant: false`, the package automatically POSTs a non-compliance report to the Press Registry Body endpoint (see §7.8). This is not optional and requires no caller action. The result field `non_compliance_reported` reflects whether the POST succeeded.

### 7.6 Stage 6 — EAS Annotation Lookup

**Input:** All card addresses resolved during Stage 3.  
**Network:** Arbitrum One (`getEasAnnotations`), IPFS (annotation content documents), HTTP (`RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER`).

Stage 6 is opt-in. If `config.fetchAnnotations` is `false` (the default), this stage is skipped and `annotations` is `[]` in the result.

1. Fetch the governing body's recommended annotator list from `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER`. This is a GET request returning a JSON array of annotator card addresses (bytes32 hex strings). If the fetch fails, record the error and proceed with an empty recommended list.
2. Merge the recommended list with `config.additionalAnnotators` (deduplicating by address). This is the **active annotator set** for this verification.
3. For each card address in the chain, call `rpc.getEasAnnotations(cardAddress, activeAnnotatorSet)` in parallel.
4. For each returned `EasAttestation`:
   a. Fetch and decode the annotation content document from IPFS using the `cid`.
   b. Walk the annotator's chain using the same logic as Stage 3 (derive address from `attester`, fetch and decrypt annotator's card doc, check `ancestry_pubkeys`). Record `annotator_chain_trusted: true` if the walk reaches a trusted root.
   c. Record `is_recommended_annotator: true` if the attester address appears in the governing body's recommended list (not just `config.additionalAnnotators`).
5. Assemble one `EasAnnotation` per attestation and collect into `annotations`.

A failure to fetch or decrypt any individual annotation document is recorded as a non-fatal error in `errors` (stage 6); that annotation is omitted from the result. Stage 6 failures do not affect any other stage outcome.

### 7.7 Stage 7 — Recipient-Set Check

**Input:** `envelope.payload`, `config.verifierCardAddress` (or the per-call `options.verifierCardAddress` override — see §6.1).  
**Network:** None.

Mirrors `card_validation.md` Stage 7 exactly (same recipient-set semantics, no new rules invented here):

1. Confirm the verifier's card address (`options.verifierCardAddress` if supplied for this call, otherwise `config.verifierCardAddress`) appears in the `payload.recipients` array.
2. If absent, record `addressed_to_verifier: false` (the message is valid but was forwarded to this party rather than addressed directly).
3. If no verifier card address was configured (neither `config.verifierCardAddress` nor a per-call override), record `addressed_to_verifier: false` — the check cannot be evaluated without knowing which address to look for.

### 7.8 Non-Compliance Reporting

**Endpoint:** `https://PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER/non-compliance` *(placeholder — to be replaced before production)*

The package makes a single `POST` to this endpoint whenever `policy_compliant: false`. The request body is JSON:

```typescript
interface NonComplianceReport {
  /** On-chain address (bytes32 hex) of the non-compliant card. */
  card_address: string;

  /** On-chain address of the press that registered the card. */
  press_address: string;

  /** The raw card document bytes as fetched from IPFS, base64url-encoded.
   *  This is the unmodified content retrieved from the CID — evidence of
   *  what the press posted. */
  ipfs_card_document: string;

  /** The CID from which ipfs_card_document was fetched. */
  ipfs_cid: string;

  /** The specific check(s) that failed. */
  failed_checks: FailedCheck[];

  /** ISO 8601 timestamp of when verification was performed. */
  verified_at: string;
}

interface FailedCheck {
  /** Machine-readable check identifier. */
  check: "FIELD_POLICY_VIOLATION" | "NO_PRESS_AUTHORIZATION";

  /** For FIELD_POLICY_VIOLATION: the name of the field that failed. */
  field?: string;

  /** Human-readable description of the failure. */
  detail: string;
}
```

**Retry behavior:** The package makes one attempt. If the POST fails (network error or non-2xx response), `non_compliance_reported` is set to `false` in the result and the error is recorded in `errors` with code `NON_COMPLIANCE_REPORT_FAILED`. The verification result is still returned normally — a reporting failure does not affect the verification outcome.

**No authentication:** The report is unauthenticated in v1. The Registry Body authenticates reports by inspecting the included `ipfs_card_document` and `card_address` against on-chain state directly. Signed reports are deferred to v2 (see §13, decision 5).

---

## 8. Result Types

```typescript
interface EnvelopeVerificationResult {
  envelope_id: string;                          // SHA-256 of canonical envelope bytes, hex
  verified_at: string;                          // ISO 8601
  signatures: SignatureVerificationResult[];
}

interface SignatureVerificationResult {
  signer_card: string;                          // on-chain address (bytes32 hex)

  // Stage 1
  signature_valid: boolean | null;              // null if Stage 1 was skipped

  // Stage 2
  scope_clean: boolean | "skipped";
  app_card_chain_valid: boolean | "skipped";     // formalized 2026-07-16 (Tier 3 item (l)): whether
                                                  // the sub-card's app-certification chain walk
                                                  // (step 16, `APP_CARD_CHAIN_NOT_TRUSTED` on failure)
                                                  // specifically passed, independent of any other
                                                  // Stage 2 check. "skipped" when the signer is not
                                                  // a sub-card (no app-card chain to walk) or when
                                                  // Stage 2 itself was skipped. Lets a caller
                                                  // distinguish "this app isn't certified" from any
                                                  // other reason `scope_clean` is false (e.g. an
                                                  // invalid `app_signature`, per `INVALID_APP_SIGNATURE`).
                                                  // Does not replace `scope_clean` — a caller checking
                                                  // only `scope_clean` still gets the correct overall
                                                  // hard-reject behavior; this field is additive.

  // Stage 3
  chain_reaches_trusted_root: boolean | "skipped";
  chain_card_addresses: string[];               // on-chain addresses (bytes32 hex) resolved during
                                                 // the Stage 3 chain walk, ordered from the card
                                                 // itself up to the trusted root

  // Stage 4
  revocation: {
    status: "not_revoked" | "revoked" | "loud_revocation" | "unknown";
    code: number | null;                        // 8xx/9xx update code, or null
    effective_date: string | null;              // ISO 8601
    data_freshness_seconds: number;
  };
  was_valid_at_signing_time: boolean | "skipped";
  is_currently_valid: boolean | "skipped";
  log_updates: LogUpdate[];                     // all 1xx–7xx entries, always populated

  // Stage 5
  policy_compliant: boolean | null | "skipped"; // null if not evaluable
  policy_match: boolean | null;                 // null if no predicate was supplied
  press_subsequently_revoked: boolean;
  non_compliance_reported: boolean | null;      // null = no report was needed (policy_compliant
                                                 // was true); false = a report was needed but the
                                                 // POST failed; true = reported successfully

  // Cross-cutting
  addressed_to_verifier: boolean;               // true if config.verifierCardAddress (or the
                                                 // per-call override) appears in payload.recipients
                                                 // — see §7.7, Stage 7 Recipient-Set Check
  errors: VerificationError[];
  annotations: EasAnnotation[];                 // Stage 6 — empty if annotation lookup not requested
  chain?: ChainLink[];                          // documented 2026-07-16 (Tier 1 item 7): present only
                                                 // when config.returnChain (§5) is true. The full
                                                 // resolved chain — each link's card_address,
                                                 // public_key, and decrypted card_content — in the
                                                 // same order as chain_card_addresses.
}

interface ChainLink {
  card_address: string;                         // keccak256(public_key) — same value that appears
                                                 // in chain_card_addresses at this position
  public_key: string;                           // base64url — the raw ML-DSA-44 public key
  card_content: Record<string, unknown>;        // the decrypted CardDocument's (or LogEntry's
                                                 // card_state's) fields at this point in the chain
}

interface CardVerificationResult extends Omit<SignatureVerificationResult, "signature_valid"> {
  signature_valid: null;
  protocol_version: string;                     // documented 2026-07-16 (Tier 1 item 7): the
                                                 // protocol_version this card_verifier instance
                                                 // resolved for the verified card, via
                                                 // extractProtocolVersion() against the package's
                                                 // own KNOWN_PROTOCOL_VERSIONS list. verifyCard()
                                                 // always populates this (there is no envelope
                                                 // payload to read protocol_version from); it is
                                                 // absent from SignatureVerificationResult since
                                                 // that shape's protocol_version instead comes from
                                                 // SignedMessageEnvelope.payload.protocol_version,
                                                 // read directly by the caller.
}

interface LogUpdate {
  card_address: string;                         // which card in the chain this entry belongs to
  update_code: number;                          // 1xx–7xx
  cid: string;                                  // log entry CID
  effective_date: string;                       // ISO 8601
}

interface VerificationError {
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  code: string;                                 // e.g. "HARD_REJECT_ADDRESS_MISMATCH"
  message: string;
}

interface EasAnnotation {
  /** EAS attestation UID (bytes32 hex) */
  eas_uid: string;
  /** On-chain address of the annotating card (bytes32 hex) */
  annotator_card: string;
  /** Whether the annotator's chain walks to a trusted root */
  annotator_chain_trusted: boolean;
  /** Whether this annotator appears on the governing body's recommended T&S list */
  is_recommended_annotator: boolean;
  /** 2xx (positive) | 4xx (neutral) | 6xx (negative) */
  update_code: number;
  /** IPFS CID of the annotation content document */
  cid: string;
  /** Decoded annotation content document */
  content: Record<string, unknown>;
  /** ISO 8601 */
  effective_date: string;
}
```

---

## 9. Error Handling

The package distinguishes three classes of error:

**Protocol errors** — the envelope or card document is malformed, a required field is missing, or a binary field is the wrong length. These throw a `CardProtocolError` with a machine-readable `code` string. They are not returned in the result object; they propagate as thrown exceptions, because they indicate caller error rather than a verification outcome.

**Verification failures** — a signature doesn't verify, a chain link fails a binding check, a card is revoked. These are represented in the result object and never throw.

**Provider errors** — an `RpcProvider` or `IpfsProvider` call fails (network timeout, CID not found, etc.). These propagate as thrown exceptions from the provider; the package does not swallow them. Callers should handle provider errors at the call site.

**Error codes (non-exhaustive):**

| Code | Stage | Meaning |
|---|---|---|
| `INVALID_PUBLIC_KEY_LENGTH` | 1 | `public_key` is not 1,312 bytes after base64url decode |
| `INVALID_SIGNATURE_LENGTH` | 1 | `signature` is not 2,420 bytes after base64url decode |
| `CARD_NOT_FOUND` | 2 | On-chain `CardEntry` does not exist for the derived address |
| `DECRYPTION_FAILED` | 2, 3 | AES-GCM authentication failure on an IPFS document |
| `ADDRESS_BINDING_MISMATCH` | 2, 3 | `keccak256(pubkey)` does not match the expected on-chain address |
| `CAPABILITY_NOT_GRANTED` | 2 | The message type being verified does not appear in the signing sub-card's `capabilities` array (Stage 2 step 7; `protocol-objects.md §16` step 1) |
| `SUBCARD_EXPIRED` | 2 | The signing sub-card's `valid_until` has passed (Stage 2 step 8; `protocol-objects.md §16` step 2) |
| `ATTESTATION_LEVEL_INSUFFICIENT` | 2 | The signing sub-card's `attestation_level` is `"T1"` and `"T1"` is not in `config.acceptedAttestationLevels` (Stage 2 step 14; `protocol-objects.md §16` step 11) |
| `INVALID_APP_SIGNATURE` | 2 | `app_signature` on the sub-card document does not verify against `app_card_pubkey` (Stage 2 step 15) — hard reject; verification must not proceed to the step 16 chain walk |
| `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` | 2 | Steps 1–15 confirmed the signer is a sub-card, but this verifier instance was constructed without `VerifierConfig.appCertificationRoot` (Stage 2 step 16) — hard reject rather than skipping the app-certification chain walk; does not apply to primary-card signatures, which never reach this check |
| `APP_CARD_CHAIN_NOT_TRUSTED` | 2 | A sub-card signature's `app_card` ancestry chain does not reach `config.appCertificationRoot` within `config.maxChainDepth` (Stage 2 step 16) — this runtime re-walk runs independently of whatever check the press performed at sub-card registration time |
| `CHAIN_DEPTH_EXCEEDED` | 2, 3 | Walk exceeded `config.maxChainDepth` |
| `STALE_REVOCATION_DATA` | 4 | Revocation data exceeds `config.revocationFreshnessWindowSeconds` |
| `HISTORY_MISMATCH` | 4 | A `LogEntry`'s self-reported `history` (+ own head CID) does not match, in count or order, the ground-truth CID sequence replayed from `getCardEventLog` — indicates a press misreporting or truncating provenance |
| `NO_ONCHAIN_EVENT_FOR_HEAD` | 4 | No on-chain event (`CardRegistered`/`CardHeadUpdated`) matches the chain member's current `log_head_cid`; the effective date falls back to the IPFS content's self-reported value |
| `POLICY_FETCH_FAILED` | 5 | Policy snapshot CID could not be fetched from IPFS |
| `NO_PRESS_AUTHORIZATION` | 5 | No `PressAuthorizations` entry for `(policy_id, press_address)` |
| `NON_COMPLIANCE_REPORT_FAILED` | 5 | POST to Press Registry Body endpoint failed (network error or non-2xx response) |

---

## 10. Serialization

All canonical serialization uses **RFC 8785 JSON Canonicalization Scheme (JCS)**:

- Keys sorted by Unicode code point.
- No whitespace.
- UTF-8 output, no BOM.
- Binary fields and timestamps are plain JSON strings (base64url and ISO 8601 respectively).
- No base64 padding.

The package exports a `canonicalize(obj: unknown): Uint8Array` function that callers may use independently. It has no library dependencies (~30 lines, per ADR-010).

Conformance is verified against the test vectors in `specs/serialization-conformance.json`.

---

## 11. Cryptographic Primitives

| Primitive | Purpose | Note |
|---|---|---|
| ML-DSA-44 (FIPS 204) | All IPFS-side signature verification | Signatures are 2,420 bytes; public keys are 1,312 bytes |
| AES-256-GCM | Card document decryption | 96-bit nonce; tag is verified by the GCM algorithm itself |
| HKDF-SHA3-256 | Content key derivation from public key | `ikm = recipient_pubkey`, `info = "card-content-v1"` |
| keccak256 | On-chain address derivation from public key | `address = keccak256(ml_dsa_44_public_key)` |

All operations are performed using the Node.js `crypto` module and/or a FIPS 204 implementation. No browser-specific APIs are used.

The package does **not** verify secp256r1 signatures. On-chain write authorization (secp256r1 via RIP-7212) was enforced by the registry contract at write time; on-chain registration is the proof. The verifier reads on-chain state; it does not re-verify the write authorization signatures.

---

## 12. Dependencies

The package aims to be dependency-light. Anticipated direct dependencies:

| Package | Purpose |
|---|---|
| `@noble/post-quantum` | ML-DSA-44 signature verification (FIPS-204) |
| `@noble/hashes` | keccak256, HKDF-SHA3-256 (also a transitive dep of `@noble/post-quantum`) |

No ethers.js, viem, or IPFS client is bundled. These are caller-supplied via the provider interfaces (§4).

No direct dependency on any specific Arbitrum One ABI is included. The `RpcProvider` interface is ABI-agnostic — callers wrap whichever contract client they use.

**Open question:** Whether to ship a reference `RpcProvider` implementation (wrapping ethers.js or viem) as a separate companion package `@card-protocol/verifier-rpc-provider`. See §13.

---

## 13. Decisions

1. **Reference provider packages.** Yes — ship `@membership-card-protocol/verifier-rpc-provider` (ethers.js wrapper) and `@membership-card-protocol/verifier-ipfs-provider` (web3.storage wrapper) as optional companion packages in the same repo. They are not dependencies of the core package and are independently versioned. Integrators who bring their own transport ignore them entirely.

2. **FIPS 204 library.** Use [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum). It provides explicit `ml_dsa44` support from FIPS-204, is actively maintained (v0.5.4, Dec 2025), has only two runtime dependencies (both also `noble` packages), and ships PGP-signed releases with npm provenance attestations. Two known limitations to track: (a) **no independent security audit at time of writing** — monitor for a future audit before production launch; (b) **no side-channel protection** — this is a documented limitation of all JS post-quantum implementations and is lower risk for verification-only use (no private key material is handled by this package). Do not vendor a WASM fallback; if `@noble/post-quantum` becomes unmaintained, re-evaluate at that time.

3. **Stage 6 — EAS annotation lookup.** Included as an opt-in in the core package via `VerifierConfig.fetchAnnotations` (default `false`). When disabled, `annotations` is always `[]`. The package fetches a governing-body-maintained list of recommended T&S annotators from `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` at verification time and merges it with `VerifierConfig.additionalAnnotators` supplied by the caller. Annotations are filtered to this merged set before chain-walking the annotators. This avoids a separate package boundary for a feature closely coupled to the verification result.

4. **Caching.** Leave entirely to the caller's `IpfsProvider` and `RpcProvider` implementations. The core package makes no assumptions about caching. Callers who need it wrap their providers with a caching layer. The reference provider companion packages (decision 1) may include optional caching as a configuration option.

5. **Non-compliance report authentication.** Unauthenticated for v1. The Registry Body validates reports by cross-checking `card_address` and `ipfs_card_document` against on-chain state independently. Signed reports (using the verifier's ML-DSA-44 key) are deferred to v2, pending definition of the verifier card registration flow.

6. **Hardcoded endpoints.** Two endpoints are compiled into the package and replaced with production URLs before release: `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` (non-compliance reporting, §7.8) and `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` (Stage 6 annotator list, §7.6). Both can be overridden at construction time: `registryEndpoint` in `VerifierConfig` overrides the non-compliance endpoint; no override is provided for the recommended annotators endpoint (callers may supplement but not replace it via `additionalAnnotators`).

7. **`scope_clean: true` is recorded only after the app-certification chain walk completes.** Stage 2 (§7.2) records `scope_clean: true` as its final step (step 17), after the app-certification chain walk (step 16) has already run to completion. The chain walk is itself capable of hard-rejecting (`APP_CARD_CHAIN_NOT_TRUSTED`), so ordering it before the `scope_clean: true` write is intentional and load-bearing, not incidental — a provisional pass through steps 1–15 must never be recorded as `scope_clean: true` if the subsequent chain walk then fails. Implementations must not reorder these two steps for either sub-card or ordinary (non-sub-card) verification paths.
