"""Cross-language interop vector for `policy_match`/`return_chain`.

See ../../verifier/scripts/gen-policy-match-chain-vectors.mjs for the generator.
Unlike the primitive-level interop vectors (test_interop_vectors.py), this
exercises the full pipeline: a deterministic multi-card chain, a serialized
mock RPC/IPFS provider dataset, and the real TS CardVerifier's actual computed
result (chain + policy_match) as the expected output. Any failure here means
the Python port's policy_match/return_chain behavior has diverged from the JS
package's, on data both sides are replaying identically (not independently
constructed).
"""

import base64
import json
from pathlib import Path
from typing import Any, Optional

import pytest

from membership_card_verifier import (
    CardEntry,
    CardVerifier,
    PolicyMatchConditions,
    PolicyMatchResult,
    PressAuthEntry,
    SubCardEntry,
    VerifierConfig,
)

VECTORS_DIR = Path(__file__).resolve().parent.parent / "vectors"
VECTOR_FILE = VECTORS_DIR / "policy_match_chain_vectors.json"
CASES = json.loads(VECTOR_FILE.read_text(encoding="utf-8"))["cases"]


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


class DatasetRpcProvider:
    """Generic RpcProvider backed by a serialized provider_dataset, replaying
    exactly what the TS generator recorded — not a scenario-specific mock."""

    def __init__(self, dataset: dict[str, Any]):
        self._dataset = dataset

    async def get_card_entry(self, address: str) -> Optional[CardEntry]:
        raw = self._dataset["card_entries"].get(address)
        if raw is None:
            return None
        return CardEntry(
            log_head_cid=raw["log_head_cid"],
            policy_address=raw["policy_address"],
            last_press_address=raw["last_press_address"],
            forward_to=raw["forward_to"],
            exists=raw["exists"],
        )

    async def is_policy_authorizer(self, address: str) -> bool:
        return address in self._dataset["policy_authorizers"]

    async def get_press_authorization(
        self, policy_address: str, press_address: str
    ) -> Optional[PressAuthEntry]:
        raw = self._dataset["press_authorizations"].get(f"{policy_address}|{press_address}")
        if raw is None:
            return None
        return PressAuthEntry(
            press_public_key=raw["press_public_key"],
            mldsa44_key_hash=raw["mldsa44_key_hash"],
            active=raw["active"],
            authorized_at=raw["authorized_at"],
            revoked_at=raw["revoked_at"],
        )

    async def get_sub_card_entry(self, sub_card_address: str) -> Optional[SubCardEntry]:
        raw = self._dataset["sub_card_entries"].get(sub_card_address)
        if raw is None:
            return None
        return SubCardEntry(
            master_card_address=raw["master_card_address"],
            registration_log_head=raw["registration_log_head"],
            sub_card_doc_cid=raw["sub_card_doc_cid"],
            active=raw["active"],
            registered_at=raw["registered_at"],
            deregistered_at=raw["deregistered_at"],
        )

    async def get_card_event_log(self, card_address: str) -> list:
        return []

    async def get_eas_annotations(self, card_address: str, annotator_addresses: list[str]) -> list:
        return []


class DatasetIpfsProvider:
    def __init__(self, dataset: dict[str, Any]):
        self._dataset = dataset

    async def fetch(self, cid: str) -> bytes:
        b64 = self._dataset["ipfs"].get(cid)
        if b64 is None:
            raise ValueError(f"CID not found: {cid}")
        return _b64url_decode(b64)


def _conditions_from_json(raw: Optional[dict[str, Any]]) -> Optional[PolicyMatchConditions]:
    if raw is None:
        return None
    return PolicyMatchConditions(policy_id=raw["policy_id"], field_match=raw.get("field_match"))


def _chain_to_comparable(chain: Optional[list]) -> Optional[list[dict[str, Any]]]:
    if chain is None:
        return None
    return [
        {"card_address": link.card_address, "public_key": link.public_key, "card_content": link.card_content}
        for link in chain
    ]


def _policy_match_to_comparable(expected: Optional[Any]) -> Optional[PolicyMatchResult]:
    """Convert expected policy_match value from JSON to PolicyMatchResult for comparison.

    Handles both old boolean format (from stale vectors) and new dict format.
    """
    if expected is None:
        return None
    if isinstance(expected, dict):
        return PolicyMatchResult(**expected)
    if isinstance(expected, bool):
        # Handle stale vectors file with boolean values
        if expected is True:
            return PolicyMatchResult(matched=True)
        else:
            # Old format doesn't have the reason, so we can't know if it was
            # field_mismatch or no_policy_match. Return no_policy_match as default.
            return PolicyMatchResult(matched=False, reason="no_policy_match")
    # If it's already a PolicyMatchResult, return as-is
    return expected


@pytest.mark.parametrize("case", [c for c in CASES if c["id"] != "PMC-05"], ids=lambda c: c["id"])
async def test_policy_match_and_chain_match_ts_output(case: dict) -> None:
    dataset = case["provider_dataset"]
    rpc = DatasetRpcProvider(dataset)
    ipfs = DatasetIpfsProvider(dataset)
    config = case["config"]

    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=config["app_certification_root"],
            trusted_roots=config["trusted_roots"],
            return_chain=config["return_chain"],
            conditions=_conditions_from_json(config["conditions"]),
        )
    )

    envelope = case["envelope"]
    result = await verifier.verify_envelope(envelope)

    expected = case["expected"]
    assert result.policy_match == _policy_match_to_comparable(expected["envelope_policy_match"])
    assert result.signatures[0].policy_match == _policy_match_to_comparable(expected["signature_policy_match"])
    assert _chain_to_comparable(result.signatures[0].chain) == expected["chain"]


async def test_policy_match_envelope_level_or_matches_ts_output() -> None:
    case = next(c for c in CASES if c["id"] == "PMC-05")
    dataset = case["provider_dataset"]
    rpc = DatasetRpcProvider(dataset)
    ipfs = DatasetIpfsProvider(dataset)
    config = case["config"]

    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=config["app_certification_root"],
            trusted_roots=config["trusted_roots"],
            return_chain=config["return_chain"],
            conditions=_conditions_from_json(config["conditions"]),
        )
    )

    result = await verifier.verify_envelope(case["envelope"])
    expected = case["expected"]

    assert result.policy_match == _policy_match_to_comparable(expected["envelope_policy_match"])
    assert [s.policy_match for s in result.signatures] == [_policy_match_to_comparable(pm) for pm in expected["per_signature_policy_match"]]
    assert [_chain_to_comparable(s.chain) for s in result.signatures] == expected["chains"]
