from typing import Literal

PRESS_REGISTRY_BODY_ENDPOINT = "PRESS_REGISTRY_BODY_ENDPOINT_PLACEHOLDER"

RECOMMENDED_ANNOTATORS_ENDPOINT = "RECOMMENDED_ANNOTATORS_ENDPOINT_PLACEHOLDER"

PROTOCOL_VERSION_0_1 = "0.1"

# All protocol versions recognized by this verifier build.
KNOWN_PROTOCOL_VERSIONS: tuple[str, ...] = ("0.1",)

ProtocolVersion = Literal["0.1"]
