# Protocol Versioning

## Version format

Protocol versions are dot-separated strings of the form `"MAJOR.MINOR"`. The current version is `"0.1"`. Versions are compared as strings — there is no numeric coercion. Unknown version strings are always rejected.

## Where `protocol_version` appears

`protocol_version` is a required field on two artifact types:

**CardDocument** (IPFS-stored card documents):
```json
{
  "policy_id": "...",
  "issuer_card": "...",
  "press_card": "...",
  "press_signature": "...",
  "protocol_version": "0.1",
  "recipient_pubkey": "...",
  ...
}
```

**SignedMessageEnvelope.payload** (signed message payloads):
```json
{
  "message": "...",
  "protocol_version": "0.1",
  "timestamp": "..."
}
```

## RFC 8785 canonical field ordering

Canonicalization (RFC 8785) sorts object keys lexicographically by Unicode code point. This determines where `protocol_version` appears in the canonical byte string used for signing and envelope ID computation.

In **CardDocument**: `press_signature` (`press_s`) < `protocol_version` (`proto`) < `recipient_pubkey` (`r`).

In **message payload**: `message` (`m`) < `protocol_version` (`p`) < `timestamp` (`t`).

Signing tools must include `protocol_version` in the object before canonicalizing — the RFC 8785 canonicalizer places it in the correct position automatically regardless of insertion order.

## What v0.1 covers

Version `"0.1"` describes the initial card protocol schema:

- **Signing scheme**: ML-DSA-44 signatures over RFC 8785 canonical JSON.
- **Phase 1 approximation**: secp256r1/SHA-256 may be used for on-chain registry lookups during Phase 1 transition (see `sign_card_message.rs`).
- **Card storage**: IPFS-stored `CardDocument` encrypted with AES-256-GCM derived from the recipient public key via HKDF-SHA3-256.
- **Message envelope schema**: `{ message, protocol_version, timestamp }` payload with per-signer `SignatureEntry` array.
- **Chain walk**: 6-stage verification pipeline as defined in the verifier.

## Rejection policy

Artifacts with a missing or unrecognized `protocol_version` are rejected at stage 1 without throwing. The verifier returns a structured result containing a `VerificationError` with one of these codes:

| Code | Cause |
|------|-------|
| `MISSING_PROTOCOL_VERSION` | Field is absent or not a string |
| `UNKNOWN_PROTOCOL_VERSION` | Field is a string not in `KNOWN_PROTOCOL_VERSIONS` |

Callers receive a structured result rather than an unhandled exception, allowing them to log and report the error.

## How to add a new version

1. Add the new version string to `KNOWN_PROTOCOL_VERSIONS` in `src/constants.ts`.
2. Add a handler branch in `CardVerifier.verifyEnvelope` and `CardVerifier.verifyCard` for the new version (dispatch on `protocol_version`).
3. Add a new set of test vectors to `specs/versioning-test-vectors.json`.
4. Add unit and integration tests covering the new version's behavior.
5. Update this document with what the new version covers.

Each version must remain supported until explicitly dropped from `KNOWN_PROTOCOL_VERSIONS` — removal is a breaking change.
