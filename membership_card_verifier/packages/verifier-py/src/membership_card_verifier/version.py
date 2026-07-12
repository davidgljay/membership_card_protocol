from typing import Any

from .constants import KNOWN_PROTOCOL_VERSIONS, ProtocolVersion
from .errors import CardProtocolError


def extract_protocol_version(doc: dict[str, Any]) -> ProtocolVersion:
    """Extract and validate the protocol_version field from a card document
    or message payload.

    Raises MISSING_PROTOCOL_VERSION if the field is missing or not a string.
    Raises UNKNOWN_PROTOCOL_VERSION if the version is not in KNOWN_PROTOCOL_VERSIONS.
    """
    v = doc.get("protocol_version")
    if not isinstance(v, str):
        raise CardProtocolError(
            "MISSING_PROTOCOL_VERSION",
            "protocol_version field is missing or not a string",
        )
    if v not in KNOWN_PROTOCOL_VERSIONS:
        raise CardProtocolError(
            "UNKNOWN_PROTOCOL_VERSION",
            f'Unrecognized protocol version: "{v}". '
            f"Known versions: {', '.join(KNOWN_PROTOCOL_VERSIONS)}",
        )
    return v  # type: ignore[return-value]
