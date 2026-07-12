# membership-card-verifier

A Python library for verifying signed messages and card status in the Card Protocol. Given a `SignedMessageEnvelope`, it answers four questions per signature:

1. Is the cryptographic signature valid?
2. Was the signing card valid at the moment of signing?
3. Is the signing card currently valid?
4. Does the card satisfy the relying party's policy requirements?

Verification is fully independent. No contact with the signer, issuer, or press is required — any party with access to IPFS and the Arbitrum One registry can verify a card.

This is a Python port of [`@membership-card-protocol/verifier`](https://www.npmjs.com/package/@membership-card-protocol/verifier), behaviorally identical to the JS package: same six-stage pipeline, same result shape, same error codes.

**Python ≥ 3.11 · asyncio**

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
pip install -e /path/to/membership_card_verifier/packages/verifier-py
```

This package is not yet published to PyPI (see [Before going to production](#before-going-to-production)). Install from a local checkout or a git URL:

```sh
pip install git+https://example.com/membership-card-protocol.git#subdirectory=membership_card_verifier/packages/verifier-py
```

The package has no bundled RPC client or IPFS client. Unlike the JS package, there are no ready-made provider wrapper packages for Python yet — implement the two provider protocols described below against whatever RPC/IPFS client you already use.

---

## Quick start

```python
import asyncio
from membership_card_verifier import CardVerifier, VerifierConfig

async def main():
    verifier = CardVerifier(VerifierConfig(rpc=my_rpc_provider, ipfs=my_ipfs_provider, app_certification_root=APP_CERT_ROOT))

    # Verify a signed message envelope
    result = await verifier.verify_envelope(envelope)

    for sig in result.signatures:
        if sig.signature_valid and sig.scope_clean is True and sig.is_currently_valid is True:
            ...  # Accept the message

asyncio.run(main())
```

To check a card's status without a full envelope — useful for pre-flight checks before accepting a credential:

```python
status = await verifier.verify_card(card_address)

if status.is_currently_valid is True and status.chain_reaches_trusted_root is True:
    ...  # Card is in good standing
```

To check whether a signer meets a relying party's policy requirements:

```python
verifier = CardVerifier(VerifierConfig(
    rpc=my_rpc_provider,
    ipfs=my_ipfs_provider,
    app_certification_root=APP_CERT_ROOT,
    conditions=PolicyMatchConditions(
        policy_id="QmIssuancePolicyCID",
        field_match={"user_type": "admin"},
    ),
))

result = await verifier.verify_envelope(envelope)

if result.policy_match is True:
    ...  # At least one signer's card was issued under this policy with user_type == "admin"
elif result.policy_match is False:
    ...  # No signer met the policy requirement
```

---

## Providers

The package is transport-agnostic. All Arbitrum One reads and IPFS fetches go through two `typing.Protocol` interfaces you supply at construction time. This means the same package works in an ASGI service, an AWS Lambda, a CLI tool, or a test suite with mock providers — no environment-specific builds required.

### RpcProvider

Abstracts all Arbitrum One registry reads. Implement this `Protocol` with `async def` methods against whichever Python web3 client you use (e.g. `web3.py`):

```python
from typing import Protocol
from membership_card_verifier import CardEntry, PressAuthEntry, SubCardEntry, LogEntry, EasAttestation

class RpcProvider(Protocol):
    async def get_card_entry(self, address: str) -> CardEntry | None: ...
    async def is_policy_authorizer(self, address: str) -> bool: ...
    async def get_press_authorization(self, policy_address: str, press_address: str) -> PressAuthEntry | None: ...
    async def get_sub_card_entry(self, sub_card_address: str) -> SubCardEntry | None: ...
    async def get_log_entries(self, card_address: str) -> list[LogEntry]: ...
    async def get_eas_annotations(self, card_address: str, annotator_addresses: list[str]) -> list[EasAttestation]: ...
```

You don't need to subclass anything — any object with matching `async def` methods satisfies the protocol structurally.

### IpfsProvider

```python
class IpfsProvider(Protocol):
    async def fetch(self, cid: str) -> bytes: ...
```

Must raise if the CID cannot be resolved — the package treats a raised exception as a provider failure, not a verification failure. Implement your own caching policy inside the provider; the core package makes no assumptions about caching.

```python
import httpx
from membership_card_verifier import IpfsProvider

class FilebaseIpfsProvider:
    def __init__(self, gateway_url: str = "https://ipfs.filebase.io/ipfs", timeout: float = 30.0):
        self._gateway_url = gateway_url
        self._timeout = timeout

    async def fetch(self, cid: str) -> bytes:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            res = await client.get(f"{self._gateway_url}/{cid}")
            res.raise_for_status()
            return res.content
```

---

## Configuration

```python
from membership_card_verifier import VerifierConfig

config = VerifierConfig(
    # Required
    rpc=rpc,
    ipfs=ipfs,
    app_certification_root=APP_CERT_ROOT,

    # Optional — defaults shown
    trusted_roots=[],                            # Supplement the on-chain PolicyAuthorizerKeys table
    revocation_freshness_window_seconds=300,      # Flag revocation data older than this as stale
    reject_stale_revocation=True,                 # Stale data -> is_currently_valid: False
    max_chain_depth=64,                           # Abort chain walk after this many hops
    registry_endpoint=None,                       # Override the Press Registry Body endpoint
    fetch_annotations=False,                      # Enable Stage 6 EAS annotation lookup
    additional_annotators=[],                     # Extra annotator addresses to include in Stage 6
    return_chain=False,                           # Include full chain data in the result
    conditions=None,                              # Policy-matching conditions for the policy_match field
)

verifier = CardVerifier(config)
```

`trusted_roots` is useful when you have a local copy of known governance roots and want to skip the on-chain lookup for them — for example when building a CLI that operates against a known deployment. It supplements the on-chain table; it does not replace it.

### Checking policy requirements with `conditions`

To evaluate whether a card meets a relying party's policy requirements, pass a `conditions` object:

```python
from membership_card_verifier import PolicyMatchConditions

config = VerifierConfig(
    rpc=rpc,
    ipfs=ipfs,
    app_certification_root=APP_CERT_ROOT,
    conditions=PolicyMatchConditions(
        policy_id="QmPolicyDocumentCID",              # CID of the policy the card was issued under
        field_match={
            "user_type": "admin",                     # exact-match shorthand
            "department": {"regex": "^(eng|product)$"},  # regex escape hatch
        },
    ),
)

result = await verifier.verify_envelope(envelope)
for sig in result.signatures:
    if sig.policy_match is True:
        ...  # This signer's card was issued under the specified policy
             # and all field values matched the conditions.
```

The `policy_id` is checked against each card's `policy_id` field as the chain is walked. All `field_match` entries must match against the same card (the first one in the chain matching `policy_id`). Field values are matched exactly by default; use `{"regex": "..."}` for pattern matching.

### Retrieving chain data with `return_chain`

Pass `return_chain=True` to inspect the full chain of cards from the signer back to the trusted root:

```python
config = VerifierConfig(rpc=rpc, ipfs=ipfs, app_certification_root=APP_CERT_ROOT, return_chain=True)
verifier = CardVerifier(config)

result = await verifier.verify_envelope(envelope)
for sig in result.signatures:
    for link in sig.chain or []:
        print(link.card_address)   # On-chain address of this card
        print(link.public_key)     # base64url-encoded public key
        print(link.card_content)   # Decrypted card document fields
```

This is useful for building policy-enforcement logic, auditing, or displaying card details to the user. The chain is ordered from the signer's master card outward toward the trusted root. If the walk fails partway through, `chain` contains a partial list up to the point of failure.

---

## Reading a result

`verify_envelope` returns one `SignatureVerificationResult` per entry in `envelope["signatures"]`. Each result is a flat dataclass — no nested stage objects, just fields:

```python
@dataclass
class SignatureVerificationResult:
    signer_card: str                                        # on-chain address of the signing card

    # Stage 1
    signature_valid: bool | None                            # None if Stage 1 was skipped (verify_card)

    # Stage 2
    scope_clean: bool | Literal["skipped"]                  # sub-card properly bound to master card

    # Stage 3
    chain_reaches_trusted_root: bool | Literal["skipped"]
    chain: list[ChainLink] | None                           # present only when return_chain=True

    # Stage 4
    revocation: RevocationStatus                            # status, code, effective_date, data_freshness_seconds
    was_valid_at_signing_time: bool | Literal["skipped"]
    is_currently_valid: bool | Literal["skipped"]
    log_updates: list[LogUpdate]                            # non-revocation history (1xx-7xx entries)

    # Stage 5
    policy_compliant: bool | None | Literal["skipped"]
    policy_match: bool | None                               # result of `conditions` check (None if not supplied)
    press_subsequently_revoked: bool                        # informational — does not affect compliance
    non_compliance_reported: bool

    # Cross-cutting
    addressed_to_verifier: bool
    errors: list[VerificationError]
    annotations: list[EasAnnotation]                        # empty unless fetch_annotations=True
```

The `"skipped"` sentinel means a stage did not run because a hard rejection in an upstream stage made its output meaningless. `False` means the stage ran and the card failed it. These are different situations — check for `is False` / `== "skipped"` explicitly rather than relying on truthiness.

`log_updates` is always populated regardless of pass or fail — it contains the card's non-revocation history (field updates, key rotations, successor designations) which you may want to surface for audit or display purposes.

### Chain data (`chain`)

Present on `SignatureVerificationResult`/`CardVerificationResult` only when `return_chain=True` (absent, not an empty list, when not requested):

```python
@dataclass
class ChainLink:
    card_address: str                  # keccak256(pubkey) — same value as chain_card_addresses
    public_key: str                    # base64url — the raw ML-DSA-44 public key
    card_content: dict[str, Any]        # the decrypted CardDocument's fields
```

Ordered from the signer's master card outward toward the trusted root. If the chain walk fails partway through, `chain` contains the partial list up to the point of failure rather than being empty — useful for policy checks that need to know what was actually resolved even when overall verification fails. `verify_card()` never resolves any chain data (no pubkey is available from a bare address alone), so its `chain` is always an empty list.

### Policy matching (`policy_match`)

`policy_match` reflects whether the `conditions` you supplied (if any) were satisfied — per-signature on `SignatureVerificationResult`/`CardVerificationResult`, and as an OR-aggregate across every signature on the top-level `EnvelopeVerificationResult`:

```python
@dataclass
class EnvelopeVerificationResult:
    envelope_id: str
    verified_at: str
    protocol_version: str
    signatures: list[SignatureVerificationResult]
    policy_match: bool | None    # True if at least one signer's card met conditions
```

- `None` — `conditions` wasn't supplied.
- `True`/`False` — whether that signer's card (per-signature) or at least one signer's card (envelope-level) was issued under `conditions.policy_id` and satisfied every `field_match` entry.
- For `verify_card()`, `policy_match` is computed against that call's (always empty, per above) chain — so it's `False` whenever `conditions` is supplied and `None` otherwise; `verify_card()` is not the right call for a `conditions` check on anything but the bare card itself.

---

## The verification pipeline

Stages run in order for each signature entry. The result always contains all fields for all stages — callers decide which fields matter for their use case.

```
Stage 1 — Signature Validity
  Decode public_key and signature from base64url.
  Canonicalize the envelope payload (RFC 8785).
  Verify the ML-DSA-44 signature.
  -> signature_valid: True | False

Stage 2 — Sub-Card to Master Link
  Derive the signer's on-chain address (keccak256 of public key).
  Fetch and decrypt the sub-card document from IPFS.
  Confirm the holder_primary_card and app_card binding checks pass.
  Fetch and decrypt the master card document.
  Confirm on-chain sub-card registration is active.
  Verify the holder's and app's signatures on the sub-card document.
  -> scope_clean: True | False

  Hard rejection: card not found, decryption failure, or binding mismatch
  causes scope_clean: False and skips Stage 3-5.

Stage 3 — Chain Walk
  Starting from the master card's ancestry_pubkeys, walk each ancestor.
  At each hop: confirm keccak256(pubkey) matches the expected address,
  decrypt the ancestor's card from IPFS, check is_policy_authorizer.
  Stop when a trusted root is found or ancestry_pubkeys is exhausted.
  -> chain_reaches_trusted_root: True | False

Stage 4 — Revocation Check
  Fetch the on-chain log for every card in the chain in parallel (asyncio.gather).
  Partition entries: 1xx-7xx go to log_updates; 8xx/9xx are revocations.
  The earliest revocation effective_date governs.
  -> was_valid_at_signing_time, is_currently_valid, revocation

Stage 5 — Policy Compliance
  Fetch the policy snapshot at the immutable policy_id CID.
  Check the card's field values against the policy's field_definitions.
  Confirm on-chain press authorization for (policy_address, press_address).
  If non-compliant, POST a report to the Press Registry Body.
  -> policy_compliant, press_subsequently_revoked, non_compliance_reported

Stage 6 — EAS Annotations (opt-in)
  Fetch the governing body's recommended annotator list.
  Merge with config.additional_annotators.
  Fetch EAS attestations for each card in the chain.
  Walk each annotator's chain to check if it reaches a trusted root.
  -> annotations
```

---

## Error handling

The package distinguishes three classes of error:

### Protocol errors — raised as `CardProtocolError`

These indicate malformed input: a public key of the wrong length, a signature that can't be base64url-decoded, a missing required field. They represent caller error rather than a verification outcome, so they raise rather than appear in the result.

```python
from membership_card_verifier import CardProtocolError

try:
    result = await verifier.verify_envelope(envelope)
except CardProtocolError as e:
    print(e.code)     # e.g. "INVALID_PUBLIC_KEY_LENGTH"
    print(str(e))      # the message
```

In a well-integrated system these should never occur — they fire on input that could not have been produced by a correct protocol implementation.

### Verification failures — in the result, never raised

Failed stages appear as `False` (or `"skipped"`) in the result fields. Machine-readable codes are in `result.signatures[i].errors`:

```python
for err in result.signatures[0].errors:
    print(err.stage, err.code, err.message)
```

### Provider errors — raised from your providers

Network timeouts, CIDs not found, RPC node failures — these propagate through `verify_envelope` as-is. Wrap the call in a try/except and handle them alongside `CardProtocolError`.

### Error code reference

| Code | Stage | Meaning |
|---|---|---|
| `INVALID_PUBLIC_KEY_LENGTH` | 1 | `public_key` is not 1,312 bytes after base64url decode |
| `INVALID_SIGNATURE_LENGTH` | 1 | `signature` is not 2,420 bytes after base64url decode |
| `CARD_NOT_FOUND` | 2 | No on-chain `CardEntry` for the derived address |
| `DECRYPTION_FAILED` | 2, 3 | AES-GCM authentication failure — document is corrupt or key is wrong |
| `ADDRESS_BINDING_MISMATCH` | 2 | `keccak256(pubkey)` does not match the expected on-chain address |
| `SUB_CARD_NOT_IN_ACTIVE_DIRECTORY` | 2 | Sub-card is not listed in the master card's `active_subcards` |
| `INVALID_HOLDER_SIGNATURE` | 2 | Master card holder's signature on the sub-card document is invalid |
| `SUB_CARD_INACTIVE` | 2 | Sub-card is not active on-chain |
| `INVALID_APP_SIGNATURE` | 2 | App's signature on the sub-card document is invalid |
| `APP_CARD_CHAIN_NOT_TRUSTED` | 2 | The app card's ancestry does not reach `app_certification_root` |
| `CHAIN_DEPTH_EXCEEDED` | 3 | Chain walk exceeded `max_chain_depth` without reaching a trusted root |
| `STALE_REVOCATION_DATA` | 4 | Revocation data is older than `revocation_freshness_window_seconds` |
| `POLICY_FETCH_FAILED` | 5 | Policy snapshot CID could not be fetched from IPFS |
| `NO_PRESS_AUTHORIZATION` | 5 | No on-chain press authorization for `(policy_address, press_address)` |
| `NON_COMPLIANCE_REPORT_FAILED` | 5 | POST to the Press Registry Body endpoint failed |
| `RECOMMENDED_ANNOTATORS_FETCH_FAILED` | 6 | Could not fetch the governing body's recommended annotator list |
| `ANNOTATION_FETCH_FAILED` | 6 | Could not fetch or decode an EAS annotation document from IPFS |
| `ANNOTATOR_CHAIN_WALK_FAILED` | 6 | Error while checking whether an annotator's card is trusted |

---

## Non-compliance reporting

When `policy_compliant: False`, the package automatically POSTs a non-compliance report to the Press Registry Body. This happens once per non-compliant result; there is no retry. The `non_compliance_reported` field tells you whether it succeeded.

This call is not optional and is not mediated through `IpfsProvider` or `RpcProvider`. It enforces a governing-body requirement that must not be skippable by the caller. A reporting failure does not affect the verification result — the card is still assessed as non-compliant regardless.

The report body includes the card's on-chain address, the raw IPFS document bytes, the press address, and the list of failed checks. The Registry Body cross-checks this against on-chain state independently; the report is unauthenticated in v1.

---

## Serialization utility

`canonicalize()` is exported independently for callers who need RFC 8785 JSON Canonicalization Scheme (JCS) outside of verification — for example when building signing tooling or computing content-addressed identifiers.

```python
from membership_card_verifier import canonicalize

data = canonicalize({"message": "hello", "timestamp": "2026-06-20T00:00:00Z"})
# bytes of UTF-8: b'{"message":"hello","timestamp":"2026-06-20T00:00:00Z"}'
```

Keys are sorted by Unicode code point, output is compact UTF-8 with no BOM. Null values are preserved as the JSON literal `null`. Optional fields that should be absent must be omitted from the input dict before calling `canonicalize` — the serializer does not strip null-valued keys. Output is byte-identical to the JS package's `canonicalize()` for the same input — see `vectors/` for the cross-language conformance suite.

---

## Cryptographic notice

This package uses the [`cryptography`](https://cryptography.io/) library (backed by AWS-LC/BoringSSL) for ML-DSA-44 (FIPS 204) signature verification, AES-256-GCM decryption, secp256r1/ECDSA verification, and HKDF. It uses [`pycryptodome`](https://pycryptodome.readthedocs.io/) for keccak256 (Ethereum-style Keccak, distinct from NIST SHA3-256 — `cryptography` does not provide this variant).

**No independent audit called out for this specific build.** Monitor the `cryptography` project for security advisories before deploying in environments with stringent security requirements.

**No side-channel protection guarantee.** This is lower risk here because this package only performs signature *verification* — no private key material is ever handled.

---

## Before going to production

Two endpoint constants are compiled in as placeholder strings and must be replaced before release:

- **`PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER`** — the non-compliance reporting endpoint. Override with `registry_endpoint` in `VerifierConfig`.
- **`RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER`** — the governing body's annotator list, fetched during Stage 6. No config override; use `additional_annotators` to supplement it.

Search the package for these strings before shipping — their presence means the package is not yet connected to a live governance deployment.

This package is not published to PyPI. The deliverable is a fully-tested, locally installable package (`pip install -e .` or install from a git URL).
