"""DomainBindingAttestation checks — protocol-objects.md §17: binding checks,
signature, currency rule (against DomainRegistrations), coverage rule.
Mirrors login/domainBinding.ts."""

import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from ..crypto import keccak256, ml_dsa44_verify
from ..errors import CardProtocolError
from ..types import RpcProvider
from .chain import norm_address
from .encoding import b64url_decode, domain_covers, signing_bytes

_FIELDS = ("admin_card", "admin_card_pubkey", "admin_signature", "domain", "issued_at", "login_service_card", "login_service_card_pubkey")


@dataclass
class DomainBindingResult:
    ok: bool
    domain: Optional[str] = None
    monitored: bool = False
    code: Optional[str] = None
    reason: Optional[str] = None


def check_domain_binding_signature(binding: Any, login_service_card_address: str) -> tuple[bool, str]:
    """Signature and binding checks only — no chain reads. Returns (ok, reason)."""
    if not isinstance(binding, dict):
        return False, "domain_binding is not an object"
    for f in _FIELDS:
        if not isinstance(binding.get(f), str) or not binding[f]:
            return False, f"domain_binding.{f} missing"
    domain = binding["domain"]
    if domain != domain.lower() or domain.endswith("."):
        return False, "domain must be lowercase with no trailing dot"
    try:
        service_pk = b64url_decode(binding["login_service_card_pubkey"])
        admin_pk = b64url_decode(binding["admin_card_pubkey"])
        if keccak256(service_pk) != norm_address(binding["login_service_card"]):
            return False, "login_service_card_pubkey does not bind to login_service_card"
        if norm_address(binding["login_service_card"]) != norm_address(login_service_card_address):
            return False, "binding names a different login service card"
        if keccak256(admin_pk) != norm_address(binding["admin_card"]):
            return False, "admin_card_pubkey does not bind to admin_card"
        sig = b64url_decode(binding["admin_signature"])
        if not ml_dsa44_verify(admin_pk, signing_bytes(binding, "admin_signature"), sig):
            return False, "admin_signature does not verify"
    except Exception as e:  # malformed base64 or key
        return False, f"malformed key or signature: {e}"
    return True, ""


async def check_domain_binding(
    binding: Any,
    login_service_card_address: str,
    origin: str,
    rpc: RpcProvider,
    is_card_currently_valid: Callable[[str], Awaitable[bool]],
    now: Optional[float] = None,
) -> DomainBindingResult:
    """Full §17 check of a login service card's binding for `origin`."""
    if binding is None:
        return DomainBindingResult(ok=False, code="LOGIN_DOMAIN_BINDING_MISSING", reason="login service card has no domain_binding")
    ok, reason = check_domain_binding_signature(binding, login_service_card_address)
    if not ok:
        return DomainBindingResult(ok=False, code="LOGIN_DOMAIN_BINDING_INVALID", reason=reason)
    getter = getattr(rpc, "get_domain_registration", None)
    if getter is None:
        raise CardProtocolError("MISSING_RPC_METHOD", "RpcProvider.get_domain_registration is required for card login")
    domain = binding["domain"]
    reg = await getter(domain)
    if not reg or norm_address(reg.admin_card_address) != norm_address(binding["admin_card"]):
        return DomainBindingResult(ok=False, code="LOGIN_DOMAIN_BINDING_STALE", reason=f"{binding['admin_card']} is no longer the admin card for {domain}")
    if not await is_card_currently_valid(norm_address(binding["admin_card"])):
        return DomainBindingResult(ok=False, code="LOGIN_DOMAIN_BINDING_STALE", reason="the signing admin card is revoked")
    now_sec = int(now if now is not None else time.time())
    if reg.fraud_risk == 2 and now_sec < reg.suspension_expires_at:
        return DomainBindingResult(ok=False, code="DOMAIN_SUSPENDED", reason=f"{domain} is suspended")
    if not domain_covers(domain, origin):
        return DomainBindingResult(ok=False, code="LOGIN_ORIGIN_NOT_BOUND", reason=f"{origin} is not covered by a binding to {domain}")
    return DomainBindingResult(ok=True, domain=domain, monitored=reg.fraud_risk == 1)
