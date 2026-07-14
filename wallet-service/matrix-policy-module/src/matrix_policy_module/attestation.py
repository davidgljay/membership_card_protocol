"""Join-attestation verification (Step 12's attestation half) and the
shadow-account derivation primitives it depends on (matrix_encryption.md §3).

`deriveMatrixUserId`/`verifyMatrixUserIdBinding` here are the Python mirror
of Step 13's `wallet-service/src/matrix/account-id.ts` — both implementations
must agree on every input (a shared fixture file is Step 13's own
done-when-criterion; this module doesn't own that fixture, but must produce
identical output). There is deliberately no inverse — see matrix_encryption.md
§3's "Honest limit" section: a Matrix user ID alone can never be turned back
into a card_hash, by design.

Verifies a client-presented join attestation against
specs/process_specs/matrix_join_attestation_and_revocation.md §1-2: signature
validity, freshness, server_name binding, and sender-binding — reusing
CardVerifier.verify_envelope() (via chain_context.py) for signature/chain
verification rather than hand-rolling ML-DSA-44 verification a second time.
Replaces the original binding_client.py (removed 2026-07-11).
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from membership_card_verifier import CardVerifier, ChainLink, RevocationStatus
from membership_card_verifier.crypto import keccak256

from matrix_policy_module.chain_context import extract_chain, walk_join_attestation_chain

_SHADOW_ACCOUNT_DOMAIN_TAG = "matrix-shadow-account-v1"


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _hex_to_bytes(value: str) -> bytes:
    return bytes.fromhex(value[2:] if value.startswith("0x") else value)


def shadow_account_commitment(card_hash: str, server_name: str) -> str:
    """keccak256(card_hash || domain_tag || server_name) — domain-separated,
    matrix_encryption.md §3."""
    data = _hex_to_bytes(card_hash) + _SHADOW_ACCOUNT_DOMAIN_TAG.encode("utf-8") + server_name.encode("utf-8")
    return keccak256(data)


def derive_matrix_user_id(card_hash: str, server_name: str) -> str:
    return f"@card_{shadow_account_commitment(card_hash, server_name).lower()}:{server_name}"


def verify_matrix_user_id_binding(candidate_card_hash: str, matrix_user_id: str, server_name: str) -> bool:
    """Forward recomputation only — no inverse exists or should be added
    (matrix_encryption.md §3)."""
    return derive_matrix_user_id(candidate_card_hash, server_name) == matrix_user_id


@dataclass
class AttestationResult:
    valid: bool
    card_hash: Optional[str] = None
    chain: list[ChainLink] = None  # type: ignore[assignment]
    deny_reason: Optional[str] = None
    # Carried straight through from the same verify_envelope call that
    # produced `chain` — lets module.py seed cache.py's entry (Step 11)
    # without a second verifier call for the leaf's own initial state.
    revocation: Optional[RevocationStatus] = None
    is_currently_valid: Optional[bool | str] = None

    def __post_init__(self) -> None:
        if self.chain is None:
            self.chain = []


async def verify_join_attestation(
    envelope: dict[str, Any],
    joining_matrix_user_id: str,
    server_name: str,
    freshness_seconds: int,
    verifier: CardVerifier,
    now: Optional[datetime] = None,
) -> AttestationResult:
    """`joining_matrix_user_id` is the `user` parameter Synapse's
    `user_may_join_room` callback reports as actually attempting the join —
    per §2 step 4, this must equal `payload.matrix_user_id`, not just satisfy
    `verifyMatrixUserIdBinding` in isolation."""
    payload = envelope.get("payload", {})
    now = now or datetime.now(timezone.utc)

    signatures = envelope.get("signatures", [])
    if not signatures:
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    result = await walk_join_attestation_chain(verifier, envelope)
    if not result.signatures or result.signatures[0].signature_valid is not True:
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    recomputed_card_hash = keccak256(_b64url_decode(signatures[0]["public_key"]))

    claimed_card_hash_bytes = _b64url_decode(payload["card_hash"]) if "card_hash" in payload else None
    if claimed_card_hash_bytes is None or claimed_card_hash_bytes != _hex_to_bytes(recomputed_card_hash):
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    try:
        timestamp = datetime.fromisoformat(payload["timestamp"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return AttestationResult(valid=False, deny_reason="attestation_invalid")
    age_seconds = abs((now - timestamp).total_seconds())
    if age_seconds > freshness_seconds:
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    if payload.get("server_name") != server_name:
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    declared_matrix_user_id = payload.get("matrix_user_id")
    if declared_matrix_user_id != joining_matrix_user_id:
        return AttestationResult(valid=False, deny_reason="attestation_invalid")
    if not verify_matrix_user_id_binding(recomputed_card_hash, declared_matrix_user_id, server_name):
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    return AttestationResult(
        valid=True,
        card_hash=recomputed_card_hash,
        chain=extract_chain(result),
        revocation=result.signatures[0].revocation,
        is_currently_valid=result.signatures[0].is_currently_valid,
    )
