"""Card login checks (process_specs/card_login.md). Mirrors the JS verifier's login/ module."""

from .chain import (
    ChainContext,
    DcqlMatch,
    PolicyRef,
    effective_preferred_services,
    match_mcard_query,
    norm_address,
    policy_lineage,
    policy_of,
    read_card_fields,
    read_sub_card_document,
)
from .domain_binding import DomainBindingResult, check_domain_binding, check_domain_binding_signature
from .encoding import domain_covers, https_origin, request_hash, signing_bytes
from .verify import (
    LoginDeps,
    LoginVerificationResult,
    ServerCardVerificationResult,
    verify_login_response,
    verify_server_card,
)

__all__ = [
    "ChainContext",
    "DcqlMatch",
    "PolicyRef",
    "effective_preferred_services",
    "match_mcard_query",
    "norm_address",
    "policy_lineage",
    "policy_of",
    "read_card_fields",
    "read_sub_card_document",
    "DomainBindingResult",
    "check_domain_binding",
    "check_domain_binding_signature",
    "domain_covers",
    "https_origin",
    "request_hash",
    "signing_bytes",
    "LoginDeps",
    "LoginVerificationResult",
    "ServerCardVerificationResult",
    "verify_login_response",
    "verify_server_card",
]
