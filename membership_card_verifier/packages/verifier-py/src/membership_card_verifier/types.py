from __future__ import annotations

# Provider interfaces: typing.Protocol. CardDocument/EnvelopePayload: TypedDict (index-signature types). Everything else: dataclass.

from dataclasses import dataclass
from typing import (
    Any,
    Literal,
    Optional,
    Protocol,
    TypedDict,
)


# ─── Provider Interfaces ────────────────────────────────────────────────────

class RpcProvider(Protocol):
    async def get_card_entry(self, address: str) -> Optional[CardEntry]:
        ...

    async def is_policy_authorizer(self, address: str) -> bool:
        ...

    async def get_press_authorization(
        self, policy_address: str, press_address: str
    ) -> Optional[PressAuthEntry]:
        ...

    async def get_sub_card_entry(self, sub_card_address: str) -> Optional[SubCardEntry]:
        ...

    async def get_log_entries(self, card_address: str) -> list[LogEntry]:
        ...

    async def get_eas_annotations(
        self, card_address: str, annotator_addresses: list[str]
    ) -> list[EasAttestation]:
        ...


class IpfsProvider(Protocol):
    async def fetch(self, cid: str) -> bytes:
        ...


# ─── On-Chain Registry Types ─────────────────────────────────────────────────

@dataclass
class CardEntry:
    log_head_cid: str
    policy_address: str
    last_press_address: str
    exists: bool
    forward_to: Optional[str] = None


@dataclass
class PressAuthEntry:
    press_public_key: str
    mldsa44_key_hash: str
    active: bool
    authorized_at: str
    revoked_at: Optional[str] = None


@dataclass
class SubCardEntry:
    master_card_address: str
    registration_log_head: str
    sub_card_doc_cid: str
    active: bool
    registered_at: str
    deregistered_at: Optional[str] = None


@dataclass
class LogEntry:
    update_code: int
    effective_date: str
    cid: str


@dataclass
class EasAttestation:
    uid: str
    attester: str
    cid: str
    update_code: int
    effective_date: str


# ─── IPFS Document Types ──────────────────────────────────────────────────────

class CardDocument(TypedDict, total=False):
    policy_id: str
    issuer_card: str
    press_card: str
    press_signature: str
    protocol_version: str
    recipient_pubkey: str
    issued_at: str
    ancestry_pubkeys: list[str]
    active_subcards: list[str]
    past_keys: list[PastKey]
    issuer_signature: str
    holder_signature: str


@dataclass
class PastKey:
    pubkey: str
    valid_from: str
    rotated_at: str


@dataclass
class SubCardDocument:
    holder_primary_card: str
    holder_primary_card_pubkey: str
    app_card: str
    app_card_pubkey: str
    capabilities: list[str]
    recipient_pubkey: str
    issued_at: str
    attestation_level: Literal["T1", "T2"]
    app_signature: str
    holder_signature: str
    limitations: Optional[list[SubCardLimitation]] = None
    valid_until: Optional[str] = None
    attestation_proof: Optional[str] = None


@dataclass
class SubCardLimitation:
    applies_to: Optional[list[str]] = None
    field_requirements: Optional[list[FieldRequirement]] = None


@dataclass
class FieldRequirement:
    field: str
    regex: str


# ─── Configuration ────────────────────────────────────────────────────────────

@dataclass
class ChainLink:
    card_address: str  # keccak256(pubkey) — same as chain_card_addresses today
    public_key: str  # base64url — the raw ML-DSA-44 public key ("public id")
    card_content: dict[str, Any]  # the decrypted CardDocument's fields


@dataclass
class PolicyMatchConditions:
    policy_id: str  # CID — checked via issued_under_template semantics
    field_match: Optional[dict[str, str | dict[str, str]]] = None  # plain string = exact-match shorthand; { regex } = full regex


@dataclass
class VerifierConfig:
    rpc: RpcProvider
    ipfs: IpfsProvider
    app_certification_root: str
    trusted_roots: Optional[list[str]] = None
    revocation_freshness_window_seconds: Optional[int] = None
    reject_stale_revocation: Optional[bool] = None
    max_chain_depth: Optional[int] = None
    registry_endpoint: Optional[str] = None
    fetch_annotations: Optional[bool] = None
    additional_annotators: Optional[list[str]] = None
    return_chain: Optional[bool] = None
    conditions: Optional[PolicyMatchConditions] = None


# ─── API Input Types ──────────────────────────────────────────────────────────

class EnvelopePayload(TypedDict, total=False):
    message: str
    protocol_version: str
    timestamp: str


@dataclass
class SignedMessageEnvelope:
    payload: EnvelopePayload
    signatures: list[SignatureEntry]


@dataclass
class SignatureEntry:
    public_key: str
    signature: str
    key_scheme: Optional[Literal["mldsa44", "secp256r1_phase1"]] = None


@dataclass
class VerifyCardOptions:
    as_of: Optional[str] = None


# ─── Result Types ─────────────────────────────────────────────────────────────

@dataclass
class EnvelopeVerificationResult:
    envelope_id: str
    verified_at: str
    protocol_version: str
    signatures: list[SignatureVerificationResult]
    policy_match: Optional[bool] = None


@dataclass
class RevocationStatus:
    status: Literal["not_revoked", "revoked", "loud_revocation", "unknown"]
    code: Optional[int] = None
    effective_date: Optional[str] = None
    data_freshness_seconds: int = 0


@dataclass
class LogUpdate:
    card_address: str
    update_code: int
    cid: str
    effective_date: str


@dataclass
class VerificationError:
    stage: Literal[1, 2, 3, 4, 5, 6]
    code: str
    message: str


@dataclass
class EasAnnotation:
    eas_uid: str
    annotator_card: str
    annotator_chain_trusted: bool
    is_recommended_annotator: bool
    update_code: int
    cid: str
    content: dict[str, Any]
    effective_date: str


@dataclass
class SignatureVerificationResult:
    signer_card: str
    scope_clean: bool | Literal["skipped"]
    chain_reaches_trusted_root: bool | Literal["skipped"]
    app_card_chain_valid: bool | Literal["skipped"]
    revocation: RevocationStatus
    was_valid_at_signing_time: bool | Literal["skipped"]
    is_currently_valid: bool | Literal["skipped"]
    log_updates: list[LogUpdate]
    press_subsequently_revoked: bool
    non_compliance_reported: bool
    addressed_to_verifier: bool
    errors: list[VerificationError]
    annotations: list[EasAnnotation]
    signature_valid: Optional[bool] = None
    policy_compliant: bool | Literal["skipped"] | None = None
    policy_match: Optional[bool] = None
    chain: Optional[list[ChainLink]] = None


@dataclass
class CardVerificationResult:
    signer_card: str
    protocol_version: str
    scope_clean: bool | Literal["skipped"]
    chain_reaches_trusted_root: bool | Literal["skipped"]
    app_card_chain_valid: bool | Literal["skipped"]
    revocation: RevocationStatus
    was_valid_at_signing_time: bool | Literal["skipped"]
    is_currently_valid: bool | Literal["skipped"]
    log_updates: list[LogUpdate]
    press_subsequently_revoked: bool
    non_compliance_reported: bool
    addressed_to_verifier: bool
    errors: list[VerificationError]
    annotations: list[EasAnnotation]
    signature_valid: None = None
    policy_compliant: bool | Literal["skipped"] | None = None
    policy_match: Optional[bool] = None
    chain: Optional[list[ChainLink]] = None


# ─── Non-Compliance Reporting ─────────────────────────────────────────────────

@dataclass
class NonComplianceReport:
    card_address: str
    press_address: str
    ipfs_card_document: str
    ipfs_cid: str
    failed_checks: list[FailedCheck]
    verified_at: str


@dataclass
class FailedCheck:
    check: Literal["FIELD_POLICY_VIOLATION", "NO_PRESS_AUTHORIZATION"]
    detail: str
    field: Optional[str] = None
