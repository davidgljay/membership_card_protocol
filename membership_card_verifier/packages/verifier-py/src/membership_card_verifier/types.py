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

    async def get_card_event_log(self, card_address: str) -> list[CardChainEvent]:
        """
        Replays the on-chain event log for a card address and returns the ground-truth,
        oldest-first sequence of every IPFS object CID this card has ever pointed to,
        each paired with the authoritative on-chain timestamp it became the head.

        The registry contract has no on-chain-enumerable per-entry log — `CardEntries`
        stores only the current `log_head_cid` (`registry_contract.md §3.1`). This
        method reconstructs the ground-truth CID sequence by filtering that card
        address's `CardRegistered` (genesis, `initial_log_cid`) and `CardHeadUpdated`
        (each subsequent entry, `new_log_cid`) events and ordering by block
        (`registry_contract.md §7`). It returns CIDs and timestamps only — never
        decrypted card content, which lives on IPFS and is fetched via `IpfsProvider`.
        """
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
class CardChainEvent:
    """
    One entry in the on-chain event-replay sequence for a card (see
    `RpcProvider.get_card_event_log`). `cid` is the IPFS object that became the head
    as of `timestamp` — the genesis `CardDocument` CID for the first entry, or a
    post-genesis `LogEntry` CID for every subsequent entry. Does not carry
    `update_code`/`entry_type` — those live only in the IPFS content itself, not
    on chain; see `stages/stage4.py` for how content and event-replay are combined.
    """
    cid: str
    timestamp: str  # ISO 8601 — on-chain block timestamp


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
class PolicyMatchResult:
    matched: bool
    reason: Optional[Literal["no_policy_match", "field_mismatch"]] = None


@dataclass
class VerifierConfig:
    rpc: RpcProvider
    ipfs: IpfsProvider
    # The on-chain address (bytes32 hex) of the governance authority's
    # app-certification policy root. Used by Stage 2 to independently re-walk
    # a sub-card's app_card ancestry_pubkeys chain at runtime. Optional —
    # required only for verifier instances that expect to verify signatures
    # from sub-cards. If a sub-card signature is encountered on a verifier
    # instance where this is not configured, Stage 2 hard-rejects with
    # APP_CERTIFICATION_ROOT_NOT_CONFIGURED rather than skipping the check.
    app_certification_root: Optional[str] = None
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
    pubkey: Optional[str] = None  # base64url-encoded public key for card_address, if the
    # caller has it — enables real chain population the same way verify_envelope's
    # signature-carried pubkey does. Omit to keep today's chain: [] behavior.


# ─── Result Types ─────────────────────────────────────────────────────────────

@dataclass
class EnvelopeVerificationResult:
    envelope_id: str
    verified_at: str
    protocol_version: str
    signatures: list[SignatureVerificationResult]
    policy_match: Optional[PolicyMatchResult] = None


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
    chain_card_addresses: list[str]
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
    policy_match: Optional[PolicyMatchResult] = None
    chain: Optional[list[ChainLink]] = None


@dataclass
class CardVerificationResult:
    signer_card: str
    protocol_version: str
    scope_clean: bool | Literal["skipped"]
    chain_reaches_trusted_root: bool | Literal["skipped"]
    chain_card_addresses: list[str]
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
    policy_match: Optional[PolicyMatchResult] = None
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
