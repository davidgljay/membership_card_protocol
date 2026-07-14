"""Thin integration wrapper around membership_card_verifier.CardVerifier
(Step 10). Builds a VerifierConfig from this module's own config/providers and
exposes the two call shapes this module needs: a join attestation's full
chain walk, and a post-time bare-address revocation re-check.

**Read this before wiring the watcher (Step 11a) or the post hook (Step 12):**
`CardVerifier.verify_card()` — the call the watcher uses for its per-address
re-checks — cannot decrypt a CardDocument for a bare address with no known
public key, so its `chain` field is **always empty** by construction (see
that method's own comments in card_verifier.py). It still correctly reports
that *one* address's own revocation status (`revocation`, `is_currently_valid`,
`log_updates`) via Stage 4, which is all the watcher actually needs: the
watch-set (matrix_join_attestation_and_revocation.md §3.2) already stores the
full ancestor chain as individual watched addresses, established once at
join time via `walk_join_attestation_chain` below — the watcher doesn't need
to re-derive chain topology on every event, only re-check each watched
address's own revocation status. Do not expect `verify_card_revocation`'s
result to carry a non-empty `chain`; if a caller needs one, it must come from
`walk_join_attestation_chain` (join time) instead.
"""

from __future__ import annotations

from typing import Optional

from membership_card_verifier import (
    CardVerificationResult,
    CardVerifier,
    ChainLink,
    EnvelopeVerificationResult,
    SignedMessageEnvelope,
    VerifierConfig,
    VerifyCardOptions,
)

from matrix_policy_module.config import PolicyModuleConfig
from matrix_policy_module.ipfs_provider import HttpxIpfsProvider
from matrix_policy_module.rpc_provider import Web3RpcProvider

# Per matrix_room.md, all trust roots for room-gating purposes are the
# protocol's own policy cards — there is no additional app-certification
# concept in this module's evaluation path, so app_certification_root is a
# fixed sentinel, not a configurable value. If a future phase needs this to
# be real, it belongs in PolicyModuleConfig, not hardcoded here.
_APP_CERTIFICATION_ROOT = "matrix-policy-module:no-app-certification"


def build_verifier(config: PolicyModuleConfig, trusted_roots: list[str]) -> CardVerifier:
    rpc = Web3RpcProvider(
        rpc_url=config.arbitrum_rpc_url,
        registry_contract_address=config.registry_contract_address,
        ipfs_gateway_url=config.ipfs_gateway_url,
    )
    ipfs = HttpxIpfsProvider(config.ipfs_gateway_url)
    return CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=_APP_CERTIFICATION_ROOT,
            trusted_roots=trusted_roots,
            return_chain=True,
        )
    )


async def walk_join_attestation_chain(
    verifier: CardVerifier, envelope: SignedMessageEnvelope
) -> EnvelopeVerificationResult:
    """Join-time path: full verify_envelope() call over a join attestation
    (already SignedMessageEnvelope-shaped per
    matrix_join_attestation_and_revocation.md §1). The predicate evaluator
    (predicates.py) reads `chain` off `result.signatures[0].chain` — do not
    pass `conditions` to this call; the room predicate document's any_of
    across possibly-several policy entries is evaluated by predicates.py
    itself, not by a single verifier-level `conditions` check (which only
    checks one policy_id)."""
    return await verifier.verify_envelope(envelope.__dict__ if hasattr(envelope, "__dict__") else envelope)


async def verify_card_revocation(
    verifier: CardVerifier, card_address: str, as_of: Optional[str] = None
) -> CardVerificationResult:
    """Post-time / watcher path: a bare-address re-check for one address in
    the watch-set. See module docstring — `result.chain` is always empty
    here; only `result.revocation`/`is_currently_valid`/`log_updates` are
    meaningful for this call shape."""
    options = VerifyCardOptions(as_of=as_of) if as_of is not None else None
    return await verifier.verify_card(card_address, options)


def extract_chain(result: EnvelopeVerificationResult) -> list[ChainLink]:
    """Convenience accessor for predicates.py: the envelope-level chain is
    carried per-signature; a join attestation carries exactly one signature
    (the joining card's own), so signatures[0] is authoritative."""
    if not result.signatures:
        return []
    return result.signatures[0].chain or []
