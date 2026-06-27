# @membership-card-protocol/verifier

A Node.js library for verifying signed messages and card status in the Card Protocol. Given a `SignedMessageEnvelope`, it answers four questions per signature:

1. Is the cryptographic signature valid?
2. Was the signing card valid at the moment of signing?
3. Is the signing card currently valid?
4. Does the card satisfy the relying party's policy requirements?

Verification is fully independent. No contact with the signer, issuer, or press is required — any party with access to IPFS and the Arbitrum One registry can verify a card.

**Node.js ≥ 22 · ESM only**

---

## Contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Providers](#providers)
- [Configuration](#configuration)
- [Reading a result](#reading-a-result)
- [The verification pipeline](#the-verification-pipeline)
- [Error handling](#error-handling)
- [Non-compliance reporting](#non-compliance-reporting)
- [Serialization utility](#serialization-utility)
- [Cryptographic notice](#cryptographic-notice)
- [Before going to production](#before-going-to-production)

---

## How it works

The Card Protocol uses a chain-of-trust model. Every card that can sign a message holds a credential issued by a parent card, which was issued by that card's parent, all the way to a governance-recognized trusted root. Cards are stored encrypted on IPFS; their status (active, revoked, forwarded) is maintained in an Arbitrum One registry contract.

When a message arrives signed by a sub-card, the verifier:

1. Checks the cryptographic signature against the envelope payload.
2. Decrypts the sub-card's IPFS document and confirms it is properly bound to the holder's primary (master) card.
3. Walks the chain of ancestor public keys from the master card up to a trusted root.
4. Reads the on-chain revocation log for every card in the chain.
5. Fetches the policy snapshot the card was issued under and confirms the card's fields comply with it.

All five stages always run. A hard rejection in an earlier stage marks dependent downstream stages as `"skipped"` in the result, but stages that don't depend on the failed output continue regardless. Callers receive the full picture and decide what to do with it.

---

## Installation

```sh
npm install @membership-card-protocol/verifier
```

The package has no bundled RPC client or IPFS client. You supply those via the provider interfaces described below — or install the ready-made wrappers:

```sh
# ethers.js v6 RPC wrapper
npm install @membership-card-protocol/verifier-rpc-provider

# Filebase IPFS wrapper (default) — or web3.storage-compatible alternative
npm install @membership-card-protocol/verifier-ipfs-provider
```

---

## Quick start

```typescript
import { CardVerifier } from "@membership-card-protocol/verifier";
import { EthersRpcProvider } from "@membership-card-protocol/verifier-rpc-provider";
import { FilebaseIpfsProvider } from "@membership-card-protocol/verifier-ipfs-provider";

const rpc = new EthersRpcProvider(registryContract);
const ipfs = new FilebaseIpfsProvider();

const verifier = new CardVerifier({ rpc, ipfs });

// Verify a signed message envelope
const result = await verifier.verifyEnvelope(envelope);

for (const sig of result.signatures) {
  if (sig.signature_valid && sig.scope_clean === true && sig.is_currently_valid === true) {
    // Accept the message
  }
}
```

To check a card's status without a full envelope — useful for pre-flight checks before accepting a credential:

```typescript
const status = await verifier.verifyCard(cardAddress);

if (status.is_currently_valid === true && status.chain_reaches_trusted_root === true) {
  // Card is in good standing
}
```

---

## Providers

The package is transport-agnostic. All Arbitrum One reads and IPFS fetches go through two interfaces you supply at construction time. This means the same package works in a Next.js API route, an AWS Lambda, a CLI tool, or a test suite with mock providers — no environment-specific builds required.

### RpcProvider

Abstracts all Arbitrum One registry reads:

```typescript
interface RpcProvider {
  getCardEntry(address: string): Promise<CardEntry | null>;
  isPolicyAuthorizer(address: string): Promise<boolean>;
  getPressAuthorization(policyAddress: string, pressAddress: string): Promise<PressAuthEntry | null>;
  getSubCardEntry(subCardAddress: string): Promise<SubCardEntry | null>;
  getLogEntries(cardAddress: string): Promise<LogEntry[]>;
  getEasAnnotations(cardAddress: string, annotatorAddresses: string[]): Promise<EasAttestation[]>;
}
```

The ready-made ethers.js v6 wrapper accepts any contract object that implements the registry ABI:

```typescript
import { EthersRpcProvider } from "@membership-card-protocol/verifier-rpc-provider";

const rpc = new EthersRpcProvider(registryContract);
```

### IpfsProvider

```typescript
interface IpfsProvider {
  fetch(cid: string): Promise<Uint8Array>;
}
```

Must throw if the CID cannot be resolved — the package treats a thrown error as a provider failure, not a verification failure. Implement your own caching policy inside the provider; the core package makes no assumptions about caching.

```typescript
import { FilebaseIpfsProvider } from "@membership-card-protocol/verifier-ipfs-provider";

// Default: Filebase public IPFS gateway with a 30s timeout
const ipfs = new FilebaseIpfsProvider();

// Custom gateway (e.g. a dedicated Filebase bucket gateway) with a custom timeout
const ipfs = new FilebaseIpfsProvider({
  gatewayUrl: "https://mybucket.myfilebase.com/ipfs",
  timeoutMs: 15_000,
});
```

`FilebaseIpfsProvider` resolves CIDs through Filebase's public IPFS gateway (`https://ipfs.filebase.io/ipfs`) with no credentials required. Pass a `gatewayUrl` to point at a different gateway.

A web3.storage-compatible alternative is also available for existing deployments:

```typescript
import { Web3StorageIpfsProvider } from "@membership-card-protocol/verifier-ipfs-provider";

const ipfs = new Web3StorageIpfsProvider(storageClient, 30_000);
```

---

## Configuration

```typescript
const verifier = new CardVerifier({
  // Required
  rpc,
  ipfs,

  // Optional — defaults shown
  trustedRoots: [],                      // Supplement the on-chain PolicyAuthorizerKeys table
  revocationFreshnessWindowSeconds: 300, // Flag revocation data older than this as stale
  rejectStaleRevocation: true,           // Stale data → is_currently_valid: false
  maxChainDepth: 64,                     // Abort chain walk after this many hops
  registryEndpoint: undefined,           // Override the Press Registry Body endpoint
  fetchAnnotations: false,               // Enable Stage 6 EAS annotation lookup
  additionalAnnotators: [],              // Extra annotator addresses to include in Stage 6
});
```

`trustedRoots` is useful when you have a local copy of known governance roots and want to skip the on-chain lookup for them — for example when building a CLI that operates against a known deployment. It supplements the on-chain table; it does not replace it.

---

## Reading a result

`verifyEnvelope` returns one `SignatureVerificationResult` per entry in `envelope.signatures`. Each result is a flat object — no nested stage objects, just fields:

```typescript
interface SignatureVerificationResult {
  signer_card: string;                           // on-chain address of the signing card

  // Stage 1
  signature_valid: boolean | null;               // null if Stage 1 was skipped (verifyCard)

  // Stage 2
  scope_clean: boolean | "skipped";              // sub-card properly bound to master card

  // Stage 3
  chain_reaches_trusted_root: boolean | "skipped";

  // Stage 4
  revocation: {
    status: "not_revoked" | "revoked" | "loud_revocation" | "unknown";
    code: number | null;                         // 8xx / 9xx code, or null
    effective_date: string | null;               // ISO 8601
    data_freshness_seconds: number;
  };
  was_valid_at_signing_time: boolean | "skipped";
  is_currently_valid: boolean | "skipped";
  log_updates: LogUpdate[];                      // non-revocation history (1xx–7xx entries)

  // Stage 5
  policy_compliant: boolean | null | "skipped";
  policy_match: boolean | null;                  // null if no per-call predicate supplied
  press_subsequently_revoked: boolean;           // informational — does not affect compliance
  non_compliance_reported: boolean;

  // Cross-cutting
  addressed_to_verifier: boolean;
  errors: VerificationError[];
  annotations: EasAnnotation[];                  // empty unless fetchAnnotations: true
}
```

The `"skipped"` sentinel means a stage did not run because a hard rejection in an upstream stage made its output meaningless. `false` means the stage ran and the card failed it. These are different situations.

`log_updates` is always populated regardless of pass or fail — it contains the card's non-revocation history (field updates, key rotations, successor designations) which you may want to surface for audit or display purposes.

---

## The verification pipeline

Stages run in order for each signature entry. The result always contains all fields for all stages — callers decide which fields matter for their use case.

```
Stage 1 — Signature Validity
  Decode public_key and signature from base64url.
  Canonicalize the envelope payload (RFC 8785).
  Verify the ML-DSA-44 signature.
  → signature_valid: true | false

Stage 2 — Sub-Card to Master Link
  Derive the signer's on-chain address (keccak256 of public key).
  Fetch and decrypt the sub-card document from IPFS.
  Confirm the holder_primary_card and app_card binding checks pass.
  Fetch and decrypt the master card document.
  Confirm on-chain sub-card registration is active.
  Verify the holder's and app's signatures on the sub-card document.
  → scope_clean: true | false

  Hard rejection: card not found, decryption failure, or binding mismatch
  causes scope_clean: false and skips Stage 3–5.

Stage 3 — Chain Walk
  Starting from the master card's ancestry_pubkeys, walk each ancestor.
  At each hop: confirm keccak256(pubkey) matches the expected address,
  decrypt the ancestor's card from IPFS, check isPolicyAuthorizer.
  Stop when a trusted root is found or ancestry_pubkeys is exhausted.
  → chain_reaches_trusted_root: true | false

Stage 4 — Revocation Check
  Fetch the on-chain log for every card in the chain in parallel.
  Partition entries: 1xx–7xx go to log_updates; 8xx/9xx are revocations.
  The earliest revocation effective_date governs.
  → was_valid_at_signing_time, is_currently_valid, revocation

Stage 5 — Policy Compliance
  Fetch the policy snapshot at the immutable policy_id CID.
  Check the card's field values against the policy's field_definitions.
  Confirm on-chain press authorization for (policy_address, press_address).
  If non-compliant, POST a report to the Press Registry Body.
  → policy_compliant, press_subsequently_revoked, non_compliance_reported

Stage 6 — EAS Annotations (opt-in)
  Fetch the governing body's recommended annotator list.
  Merge with config.additionalAnnotators.
  Fetch EAS attestations for each card in the chain.
  Walk each annotator's chain to check if it reaches a trusted root.
  → annotations
```

---

## Error handling

The package distinguishes three classes of error:

### Protocol errors — thrown as `CardProtocolError`

These indicate malformed input: a public key of the wrong length, a signature that can't be base64url-decoded, a missing required field. They represent caller error rather than a verification outcome, so they throw rather than appear in the result.

```typescript
import { CardProtocolError } from "@membership-card-protocol/verifier";

try {
  const result = await verifier.verifyEnvelope(envelope);
} catch (e) {
  if (e instanceof CardProtocolError) {
    console.error(e.code);    // e.g. "INVALID_PUBLIC_KEY_LENGTH"
    console.error(e.message);
  }
}
```

In a well-integrated system these should never occur — they fire on input that could not have been produced by a correct protocol implementation.

### Verification failures — in the result, never thrown

Failed stages appear as `false` (or `"skipped"`) in the result fields. Machine-readable codes are in `result.signatures[i].errors`:

```typescript
for (const err of result.signatures[0].errors) {
  console.log(err.stage, err.code, err.message);
}
```

### Provider errors — thrown from your providers

Network timeouts, CIDs not found, RPC node failures — these propagate through `verifyEnvelope` as-is. Wrap the call in a try/catch and handle them alongside `CardProtocolError`.

### Error code reference

| Code | Stage | Meaning |
|---|---|---|
| `INVALID_PUBLIC_KEY_LENGTH` | 1 | `public_key` is not 1,312 bytes after base64url decode |
| `INVALID_SIGNATURE_LENGTH` | 1 | `signature` is not 2,420 bytes after base64url decode |
| `CARD_NOT_FOUND` | 2 | No on-chain `CardEntry` for the derived address |
| `DECRYPTION_FAILED` | 2, 3 | AES-GCM authentication failure — document is corrupt or key is wrong |
| `ADDRESS_BINDING_MISMATCH` | 2, 3 | `keccak256(pubkey)` does not match the expected on-chain address |
| `CHAIN_DEPTH_EXCEEDED` | 3 | Chain walk exceeded `maxChainDepth` without reaching a trusted root |
| `STALE_REVOCATION_DATA` | 4 | Revocation data is older than `revocationFreshnessWindowSeconds` |
| `POLICY_FETCH_FAILED` | 5 | Policy snapshot CID could not be fetched from IPFS |
| `NO_PRESS_AUTHORIZATION` | 5 | No on-chain press authorization for `(policy_address, press_address)` |
| `NON_COMPLIANCE_REPORT_FAILED` | 5 | POST to the Press Registry Body endpoint failed |

---

## Non-compliance reporting

When `policy_compliant: false`, the package automatically POSTs a non-compliance report to the Press Registry Body. This happens once per non-compliant result; there is no retry. The `non_compliance_reported` field tells you whether it succeeded.

This call is not optional and is not mediated through `IpfsProvider` or `RpcProvider`. It enforces a governing-body requirement that must not be skippable by the caller. A reporting failure does not affect the verification result — the card is still assessed as non-compliant regardless.

The report body includes the card's on-chain address, the raw IPFS document bytes, the press address, and the list of failed checks. The Registry Body cross-checks this against on-chain state independently; the report is unauthenticated in v1.

---

## Serialization utility

`canonicalize()` is exported independently for callers who need RFC 8785 JSON Canonicalization Scheme (JCS) outside of verification — for example when building signing tooling or computing content-addressed identifiers.

```typescript
import { canonicalize } from "@membership-card-protocol/verifier";

const bytes = canonicalize({ message: "hello", timestamp: "2026-06-20T00:00:00Z" });
// Uint8Array of UTF-8 bytes: {"message":"hello","timestamp":"2026-06-20T00:00:00Z"}
```

Keys are sorted by Unicode code point, output is compact UTF-8 with no BOM. Null values are preserved as the JSON literal `null`. Optional fields that should be absent must be omitted from the input object before calling `canonicalize` — the serializer does not strip null-valued keys.

---

## Cryptographic notice

This package uses [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) for ML-DSA-44 (FIPS 204) signature verification and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) for keccak256 and HKDF-SHA3-256. AES-256-GCM decryption uses Node.js's built-in `crypto` module.

**No independent security audit.** `@noble/post-quantum` has not been independently audited at the time of this release. Monitor [its repository](https://github.com/paulmillr/noble-post-quantum) for audit announcements before deploying in environments with stringent security requirements.

**No side-channel protection.** This is a documented limitation of all JavaScript post-quantum implementations and is lower risk here because this package only performs signature *verification* — no private key material is ever handled.

---

## Before going to production

Two endpoint constants are compiled in as placeholder strings and must be replaced before release:

- **`PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER`** — the non-compliance reporting endpoint. Override with `registryEndpoint` in `VerifierConfig`.
- **`RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER`** — the governing body's annotator list, fetched during Stage 6. No config override; use `additionalAnnotators` to supplement it.

Search the built output for these strings before shipping — their presence means the package is not yet connected to a live governance deployment.
