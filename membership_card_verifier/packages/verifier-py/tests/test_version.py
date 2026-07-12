from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.version import extract_protocol_version


def test_returns_0_1_for_a_valid_v0_1_document() -> None:
    assert extract_protocol_version({"protocol_version": "0.1"}) == "0.1"


def test_raises_missing_protocol_version_when_field_is_absent() -> None:
    try:
        extract_protocol_version({})
        assert False, "expected CardProtocolError"
    except CardProtocolError as e:
        assert e.code == "MISSING_PROTOCOL_VERSION"


def test_raises_unknown_protocol_version_for_unrecognized_version_string() -> None:
    try:
        extract_protocol_version({"protocol_version": "99.0"})
        assert False, "expected CardProtocolError"
    except CardProtocolError as e:
        assert e.code == "UNKNOWN_PROTOCOL_VERSION"


def test_raises_missing_protocol_version_when_field_is_a_number() -> None:
    try:
        extract_protocol_version({"protocol_version": 1})
        assert False, "expected CardProtocolError"
    except CardProtocolError as e:
        assert e.code == "MISSING_PROTOCOL_VERSION"
