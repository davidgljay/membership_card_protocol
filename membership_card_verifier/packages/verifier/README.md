# @membership-card-protocol/verifier

Verifies `SignedMessageEnvelope` objects produced by the Card Protocol.

**Node.js ≥ 22 · ESM only**

---

## Quick start

```typescript
import { CardVerifier } from "@membership-card-protocol/verifier";

// Supply your own provider implementations (see §Providers below)
const verifier = new CardVerifier({ rpc, ipfs });

const result = await verifier.verifyEnvelope(envelope);
console.log(result.signatures[0].signature_valid);     // true | false
console.log(result.signatures[0].chain_reaches_trusted_root); // true | false | "skipped"
console.log(result.signatures[0].is_currently_valid);  // true | false | "skipped"
```

For pre-flight checks without a full envelope:

```typescript
const status = await verifier.verifyCard(cardAddress);
console.log(status.is_currently_valid); // true | false | "skipped"
```

---

## Providers

The package makes no network calls itself. You supply two providers at construction time:

### RpcProvider

Abstracts Arbitrum One registry reads. Implement all six methods:

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

A ready-made ethers.js v6 wrapper is available as a separate package:

```
npm install @membership-card-protocol/verifier-rpc-provider
```

### IpfsProvider

```typescript
interface IpfsProvider {
  fetch(cid: string): Promise<Uint8Array>;
}
```

Must throw if the CID cannot be resolved within the caller's timeout. A web3.storage-compatible wrapper is available:

```
npm install @membership-card-protocol/verifier-ipfs-provider
```

---

## Configuration

All fields are optional except `rpc` and `ipfs`.

| Field | Default | Description |
|---|---|---|
| `rpc` | *required* | Arbitrum One RPC provider |
| `ipfs` | *required* | IPFS content provider |
| `trustedRoots` | `[]` | Local override for trusted root addresses (bytes32 hex). Supplements the on-chain `PolicyAuthorizerKeys` table. |
| `revocationFreshnessWindowSeconds` | `300` | Max age (seconds) of revocation data before it is flagged stale. |
| `rejectStaleRevocation` | `true` | If `true`, stale revocation data causes `is_currently_valid: false`. |
| `maxChainDepth` | `64` | Maximum chain walk hops before aborting with `CHAIN_DEPTH_EXCEEDED`. |
| `registryEndpoint` | `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` | Override the Press Registry Body endpoint for non-compliance reports. **Replace with a production URL before shipping.** |
| `fetchAnnotations` | `false` | Set `true` to enable Stage 6 EAS annotation lookup. |
| `additionalAnnotators` | `[]` | Extra annotator card addresses (bytes32 hex) to include in Stage 6. |

---

## Verification pipeline

Each call runs up to six stages per signature entry. Stages always run in order; a hard rejection within a stage causes dependent downstream stages to be marked `"skipped"`. All stages run even if an earlier one failed — callers decide how to interpret the combined result.

| Stage | Name | Result fields |
|---|---|---|
| 1 | Signature validity | `signature_valid` |
| 2 | Sub-card to master link | `scope_clean` |
| 3 | Chain walk to trusted root | `chain_reaches_trusted_root` |
| 4 | Revocation check | `revocation`, `was_valid_at_signing_time`, `is_currently_valid`, `log_updates` |
| 5 | Policy compliance | `policy_compliant`, `press_subsequently_revoked`, `non_compliance_reported` |
| 6 | EAS annotation lookup | `annotations` (opt-in via `fetchAnnotations`) |

---

## Error handling

Three classes of error:

**Protocol errors** — thrown as `CardProtocolError` with a `code` string. Indicate malformed input (wrong key length, missing required fields). Should not occur in production if the caller handles envelopes produced by the protocol correctly.

```typescript
import { CardProtocolError } from "@membership-card-protocol/verifier";

try {
  await verifier.verifyEnvelope(envelope);
} catch (e) {
  if (e instanceof CardProtocolError) {
    console.error(e.code, e.message);
  }
}
```

**Verification failures** — represented in the result object, never thrown. A `false` value in `signature_valid`, `scope_clean`, `chain_reaches_trusted_root`, etc. means the card failed that stage. Check `result.signatures[i].errors` for machine-readable error codes.

**Provider errors** — thrown from `RpcProvider` or `IpfsProvider` calls (network timeouts, CID not found, etc.). These propagate through `verifyEnvelope`; catch them at the call site.

### Error codes

| Code | Stage | Meaning |
|---|---|---|
| `INVALID_PUBLIC_KEY_LENGTH` | 1 | `public_key` is not 1,312 bytes after base64url decode |
| `INVALID_SIGNATURE_LENGTH` | 1 | `signature` is not 2,420 bytes after base64url decode |
| `CARD_NOT_FOUND` | 2 | On-chain `CardEntry` does not exist |
| `DECRYPTION_FAILED` | 2, 3 | AES-GCM authentication failure on an IPFS document |
| `ADDRESS_BINDING_MISMATCH` | 2, 3 | `keccak256(pubkey)` does not match the expected on-chain address |
| `CHAIN_DEPTH_EXCEEDED` | 3 | Walk exceeded `maxChainDepth` |
| `STALE_REVOCATION_DATA` | 4 | Revocation data older than `revocationFreshnessWindowSeconds` |
| `POLICY_FETCH_FAILED` | 5 | Policy snapshot CID could not be fetched |
| `NO_PRESS_AUTHORIZATION` | 5 | No on-chain press authorization for `(policy_id, press_address)` |
| `NON_COMPLIANCE_REPORT_FAILED` | 5 | POST to Press Registry Body endpoint failed |

---

## Non-compliance reporting

When `policy_compliant: false`, the package automatically POSTs a non-compliance report to the Press Registry Body endpoint. This is not optional and requires no caller action. The `non_compliance_reported` field in the result indicates whether the POST succeeded.

**The endpoint is a placeholder** (`PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER`) and must be replaced with the production URL before shipping. Override it with `registryEndpoint` in `VerifierConfig`.

---

## Cryptographic dependency notice

This package uses [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) for ML-DSA-44 (FIPS-204) signature verification.

**⚠ No independent security audit:** `@noble/post-quantum` has no independent security audit at the time this package was released. Monitor the library's issue tracker for audit announcements before using this package in production environments with high security requirements.

**⚠ No side-channel protection:** All JS post-quantum implementations share this limitation. It is lower risk here because this package only verifies signatures — no private key material is handled.

The `canonicalize()` function (RFC 8785 JCS) is exported for callers who need deterministic serialization independently of verification.

---

## Placeholder endpoints

Two endpoints are compiled in as placeholder strings and must be replaced before production:

- `PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER` — Non-compliance reporting (§7.7). Override via `VerifierConfig.registryEndpoint`.
- `RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER` — Stage 6 recommended annotator list. No caller override; use `additionalAnnotators` to supplement.
