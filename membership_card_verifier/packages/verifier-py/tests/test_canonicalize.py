import json
from pathlib import Path

import pytest

from membership_card_verifier.canonicalize import canonicalize

CONFORMANCE_PATH = (
    Path(__file__).resolve().parents[4] / "specs" / "serialization-conformance.json"
)
CONFORMANCE = json.loads(CONFORMANCE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "case", CONFORMANCE["cases"], ids=[c["id"] for c in CONFORMANCE["cases"]]
)
def test_conformance_case(case: dict) -> None:
    result = canonicalize(case["input"]).decode("utf-8")
    assert result == case["expected_json"]


def test_rejects_non_finite_numbers() -> None:
    with pytest.raises(ValueError):
        canonicalize({"x": float("inf")})
    with pytest.raises(ValueError):
        canonicalize({"x": float("nan")})


def test_negative_zero_serializes_as_zero() -> None:
    assert canonicalize({"x": -0.0}) == b'{"x":0}'


def test_large_integer_no_exponential_notation_below_1e21() -> None:
    assert canonicalize({"x": 999999999999999999}) == b'{"x":999999999999999999}'
