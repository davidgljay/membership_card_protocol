from membership_card_verifier.errors import CardProtocolError


def test_is_instance_of_exception_and_card_protocol_error() -> None:
    err = CardProtocolError("INVALID_PUBLIC_KEY_LENGTH", "key must be 1312 bytes")
    assert isinstance(err, Exception)
    assert isinstance(err, CardProtocolError)


def test_exposes_code_and_message() -> None:
    err = CardProtocolError("DECRYPTION_FAILED", "auth failure")
    assert err.code == "DECRYPTION_FAILED"
    assert str(err) == "auth failure"
