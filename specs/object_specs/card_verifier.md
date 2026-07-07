# Card Protocol — `@membership-card-protocol/verifier` npm Package Spec

**Version:** 0.1 (draft)  
**Date:** 2026-06-20  
**Status:** Draft

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
   - 7.7 [Non-Compliance Reporting](#77-non-compliance-reporting)
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

The package is **thin**, with two categories of network access. **Provider-mediated I/O** — all Arbitrum One RPC reads and IPFS fetches — is performed through caller-supplied provider interfaces; the package supplies the protocol logic and the caller supplies the transport. **Package-internal HTTP calls** are the deliberate exceptions: the non-compliance POST to the Press Registry Body (§7.7) and the recommended annotators GET (§7.6) are made directly by the package and cannot be intercepted or skipped by the caller. This is intentional — both calls enforce governing-body requirements that must not be delegatable to the implementer.

---

## 2. Design Principles

**Injected providers.** The package accepts an `RpcProvider` and an `IpfsProvider` at construction time. It has no opinion on which ethers/viem version the caller uses, which IPFS gateway they prefer, or how they handle caching.

**All stages run.** Verification does not short-circuit on a failed stage (except within a stage where a hard rejection is defined — see §7). All five stages run, and the structured result reflects the outcome of each independently. Callers decide how to interpret the combined result.

**Hard rejections are explicit.** Where the spec defines a hard rejection (address binding mismatch, AES-GCM auth failure), the affected stage is marked failed and remaining within-stage steps are skipped. Subsequent stages that depend on that stage's output are also skipped and marked `"skipped"`.

**Result per signature.** The `verifyEnvelope` call returns one `SignatureVerificationResult` per entry in the envelope's `signatures` array.

**Freshness is configurable.** Revocation data freshness tolerance is set at construction time via `VerifierConfig`. Stale data causes a `data_freshness_seconds` flag; whether to treat it as a hard failure is caller-controlled via `config.rejectStaleRevocation`.

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
   * Returns all log entries for the given card address, in append order.
   * Used for revocation checks (8xx/9xx codes).
   */
  getLogEntries(cardAddress: string): Promise<LogEntry[]>;

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

interface LogEntry {
  update_code: number;
  effective_date: string;          // ISO 8601
  cid: string;
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
}
```

A `CardVerifier` instance is constructed once and reused across verifications:

```typescript
class CardVerifier {
  constructor(config: VerifierConfig);
  verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult>;
  verifyCard(cardAddress: string, options?: VerifyCardOptions): Promise<CardVerificationResult>;
}
```

---

## 6. Primary API

### 6.1 verifyEnvelope

Verifies a `SignedMessageEnvelope`. Returns one `SignatureVerificationResult` per entry in `envelope.signatures`.

```typescript
verifyEnvelope(
  envelope: SignedMessageEnvelope
): Promise<EnvelopeVerificationResult>
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
7. Derive the master card content key: `HKDF-SHA3-256(holder_primary_card_pubkey, info="card-content-v1")`.
8. Fetch and decrypt the master card document from IPFS. AES-GCM auth failure is a **hard reject** (`scope_clean: false`).
9. Confirm the sub-card address appears in the master card's `active_subcards` field (`protocol-objects.md §1.1`): for each entry, derive `keccak256(entry_pubkey)` and confirm one matches the sub-card's own address (from step 1). **Hard reject** (`scope_clean: false`) if absent — this check is independent of the on-chain `SubCardRegistrations[sub_card_address].active` flag checked in step 11; either failing alone is sufficient to reject. If `active_subcards` is absent from the master card entirely, treat it as an empty directory (no sub-card passes this check).
10. Verify the master card holder's ML-DSA-44 signature on the sub-card registration using `holder_primary_card_pubkey`.
11. Check on-chain: `SubCardRegistrations[sub_card_address].active == true`. If `false`, record `scope_clean: false`.
12. Verify `app_signature` using `app_card_pubkey`. The app-card's own certification chain is **not** re-walked at runtime — the press validated this at `RegisterSubCard` time, and on-chain registration is the proof.
13. If all checks pass, record `scope_clean: true`.

### 7.3 Stage 3 — Chain Walk

**Input:** Decrypted master card from Stage 2 (if successful); falls back to the signer's card if Stage 2 was skipped (e.g., in `verifyCard`).  
**Network:** Arbitrum One (`getCardEntry`, `isPolicyAuthorizer`), IPFS (ancestor card docs).

1. Read `ancestry_pubkeys` from the master card. This array is ordered from immediate parent toward the trusted root.
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

### 7.4 Stage 4 — Revocation Check

**Input:** All card addresses resolved during Stage 3.  
**Network:** Arbitrum One (`getLogEntries`) — all mutable pointer resolutions are done in parallel.

1. Resolve all mutable pointers in the chain on Arbitrum One in parallel.
2. For each card in the chain, read its full append-only log. Partition entries by code range:
   - **1xx–7xx (non-revocation updates):** Collect all entries into `log_updates` in the result. These are returned regardless of whether the card passes or fails verification — they provide context about the card's history (e.g., field updates, key rotations, successor designations) that callers may surface to users or use for audit purposes.
   - **8xx (quiet revocation):** Things before `effective_date` are trusted; the card is not currently valid on or after `effective_date`.
   - **9xx (loud revocation):** Things on or after `effective_date` are suspect. Verifiers should surface this to allow issuers of other cards held by the same holder to investigate.
   - If multiple 8xx or 9xx entries exist, the earliest `effective_date` governs.
3. Determine `was_valid_at_signing_time`: if no revocation entry has `effective_date ≤ envelope.payload.timestamp`, record `true`; otherwise `false`.
4. Determine `is_currently_valid`: if no revocation entry has `effective_date ≤ now`, record `true`; otherwise `false`.
5. Record `revocation.data_freshness_seconds` — the age in seconds of the revocation data at the time of the check.
6. If `data_freshness_seconds` exceeds `config.revocationFreshnessWindowSeconds`:
   - Always record the staleness in the result.
   - If `config.rejectStaleRevocation == true`, set `is_currently_valid: false`.

### 7.5 Stage 5 — Policy Compliance

**Input:** Card's `policy_id` CID (from the CardDocument), press address from `CardEntry.last_press_address`.  
**Network:** IPFS (policy snapshot at `policy_id` CID), Arbitrum One (`getPressAuthorization`).

1. Fetch the policy snapshot at the immutable `policy_id` CID from IPFS. The policy at issuance governs — the policy's current mutable pointer head is not used.
2. Evaluate the card's **declared-field** values against `field_definitions` in the policy snapshot. Any violation → `policy_compliant: false`. A card carrying additional fields not declared in `field_definitions` is not itself a violation — the policy's schema is a floor (required fields plus declared fields), not a closed allow-list; see `card_protocol_spec.md` §Background Concepts, *A Card's Schema Is a Floor, Not a Closed Allow-List*. The package does not attempt to validate undeclared fields against anything and must not choke on or reject a card for their presence.
3. Look up `PressAuthorizations[policy_id_address][press_address]` on-chain:
   - If no entry exists, record `policy_compliant: false`. (No entry means the press was never authorized; the card could not have been validly registered.)
   - If an entry exists, on-chain registration is proof of write-time authorization. A press that is currently `active == false` (subsequently revoked) does **not** retroactively invalidate the card. Record `policy_compliant: true` if field values also passed; surface the subsequent revocation as informational context (`press_subsequently_revoked: true`) in the result.
4. If any relying-party-specific `requiredPredicate` or `requiredPolicy` is configured (passed in as a call-site option — not part of `VerifierConfig`), evaluate it against the signer's chain. Predicate failure sets `policy_match: false` but does not affect `policy_compliant`.
5. **Non-compliance reporting:** If `policy_compliant: false`, the package automatically POSTs a non-compliance report to the Press Registry Body endpoint (see §7.7). This is not optional and requires no caller action. The result field `non_compliance_reported` reflects whether the POST succeeded.

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

### 7.7 Non-Compliance Reporting

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

  // Stage 3
  chain_reaches_trusted_root: boolean | "skipped";

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
  non_compliance_reported: boolean;             // true if POST to Registry Body succeeded

  // Cross-cutting
  addressed_to_verifier: boolean;               // true if the envelope names the verifier's card
  errors: VerificationError[];
  annotations: EasAnnotation[];                 // Stage 6 — empty if annotation lookup not requested
}

interface CardVerificationResult extends Omit<SignatureVerificationResult, "signature_valid"> {
  signature_valid: null;
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
| `CHAIN_DEPTH_EXCEEDED` | 3 | Walk exceeded `config.maxChainDepth` |
| `STALE_REVOCATION_DATA` | 4 | Revocation data exceeds `config.revocationFreshnessWindowSeconds` |
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

6. **Hardcoded endpoints.** Two endpoints are compiled into the package and replaced with production URLs before release: `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` (non-compliance reporting, §7.7) and `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` (Stage 6 annotator list, §7.6). Both can be overridden at construction time: `registryEndpoint` in `VerifierConfig` overrides the non-compliance endpoint; no override is provided for the recommended annotators endpoint (callers may supplement but not replace it via `additionalAnnotators`).
