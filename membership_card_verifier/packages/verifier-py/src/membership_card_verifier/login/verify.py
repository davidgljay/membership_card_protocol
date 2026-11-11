"""Card login entry points — card_verifier.md §6.3 verify_login_response and
§6.4 verify_server_card. Error codes: process_specs/card_login.md §Error Codes.
Mirrors login/verify.ts."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Optional

from ..crypto import keccak256
from ..stages.stage2 import verify_stage2
from ..types import (
    CardVerificationResult,
    EnvelopeVerificationResult,
    SignatureVerificationResult,
    VerifyCardOptions,
)
from .chain import ChainContext, match_mcard_query, norm_address, read_card_fields, read_sub_card_document
from .domain_binding import check_domain_binding
from .encoding import b64url_decode, https_origin, request_hash


@dataclass
class LoginDeps:
    rpc: Any
    ipfs: Any
    config: Any  # app_certification_root, login_service_certification_root, max_chain_depth
    verify_card: Callable[..., Awaitable[CardVerificationResult]]
    verify_envelope: Callable[[dict[str, Any]], Awaitable[EnvelopeVerificationResult]]

    @property
    def ctx(self) -> ChainContext:
        return ChainContext(rpc=self.rpc, ipfs=self.ipfs, max_chain_depth=getattr(self.config, "max_chain_depth", None))


def _parse_ms(s: Any) -> Optional[float]:
    if not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


def _now_ms(now: Optional[str]) -> float:
    parsed = _parse_ms(now) if now else None
    return parsed if parsed is not None else datetime.now(timezone.utc).timestamp() * 1000


# ─── §6.4 verify_server_card ─────────────────────────────────────────────────

@dataclass
class ServerCardVerificationResult:
    valid: bool
    code: Optional[str] = None
    reason: Optional[str] = None
    server_card: Optional[str] = None
    login_service_card: Optional[str] = None
    login_service_card_pubkey: Optional[str] = None
    domain: Optional[str] = None
    login_service: Optional[CardVerificationResult] = None
    warnings: list[str] = field(default_factory=list)


def _fail(code: str, reason: str) -> ServerCardVerificationResult:
    return ServerCardVerificationResult(valid=False, code=code, reason=reason)


async def verify_server_card(
    deps: LoginDeps,
    server_card_pubkey: str,
    origin: str,
    required_capability: str = "auth_request",
    now: Optional[str] = None,
) -> ServerCardVerificationResult:
    now_ms = _now_ms(now)
    try:
        pk = b64url_decode(server_card_pubkey)
    except Exception:
        return _fail("LOGIN_REQUESTER_NOT_SERVER_CARD", "server card public key is not base64url")
    server_card = keccak256(pk)

    # Step 1 — Stage 2 as a sub-card, then the server-card shape.
    s2 = await verify_stage2(pk, deps.rpc, deps.ipfs, deps.config)
    if s2.scope_clean is not True or not s2.sub_card_doc:
        codes = [e.code for e in s2.errors]
        reason = ", ".join(codes) or "not a sub-card"
        if "APP_CARD_CHAIN_NOT_TRUSTED" in codes:
            return _fail("LOGIN_SERVICE_NOT_CERTIFIED", reason)
        if "SUB_CARD_INACTIVE" in codes:
            return _fail("LOGIN_SERVICE_REVOKED", reason)
        return _fail("LOGIN_REQUESTER_NOT_SERVER_CARD", reason)
    doc = s2.sub_card_doc
    if s2.app_card_branch != "login_service":
        return _fail("LOGIN_SERVICE_NOT_CERTIFIED", "the certifying card is not under the login service branch")
    if norm_address(doc["app_card"]) != norm_address(doc["holder_primary_card"]):
        return _fail("LOGIN_REQUESTER_NOT_SERVER_CARD", "app_card differs from holder_primary_card")
    if doc.get("attestation_level") != "S1":
        return _fail("LOGIN_REQUESTER_NOT_SERVER_CARD", f"attestation_level is {doc.get('attestation_level')}, expected S1")
    if required_capability not in (doc.get("capabilities") or []):
        return _fail("LOGIN_REQUESTER_NOT_SERVER_CARD", f"server card lacks the {required_capability} capability")
    valid_until = _parse_ms(doc.get("valid_until"))
    if valid_until is not None and valid_until <= now_ms:
        return _fail("LOGIN_SERVICE_REVOKED", "server card has expired")

    # Step 2 — the login service card's own status.
    service_card = norm_address(doc["holder_primary_card"])
    service = await deps.verify_card(service_card, VerifyCardOptions(pubkey=doc["holder_primary_card_pubkey"]))
    if service.chain_reaches_trusted_root is not True:
        return _fail("LOGIN_SERVICE_NOT_CERTIFIED", "login service card chain does not reach a trusted root")
    if service.is_currently_valid is not True:
        return _fail("LOGIN_SERVICE_REVOKED", "login service card or an ancestor is revoked")
    own_updates = [u for u in service.log_updates if norm_address(u.card_address) == service_card]
    if any(u.update_code == 101 for u in own_updates):
        return _fail("LOGIN_SERVICE_KEY_COMPROMISED", "login service card was rotated for possible key compromise (code 101)")

    # Steps 3–5 — domain binding.
    fields = await read_card_fields(doc["holder_primary_card_pubkey"], deps.ctx)

    async def admin_valid(address: str) -> bool:
        return (await deps.verify_card(address)).is_currently_valid is not False

    binding = await check_domain_binding(
        fields[1].get("domain_binding") if fields else None,
        service_card,
        origin,
        deps.rpc,
        admin_valid,
        now=now_ms / 1000,
    )
    if not binding.ok:
        return _fail(binding.code or "LOGIN_DOMAIN_BINDING_INVALID", binding.reason or "")

    # Step 6 — warnings.
    warnings: list[str] = []
    if any(600 <= u.update_code < 800 for u in own_updates):
        warnings.append("LOGIN_WARN_SERVICE_NEGATIVE")
    if binding.monitored:
        warnings.append("LOGIN_WARN_DOMAIN_MONITORED")
    if any(u.update_code == 100 for u in own_updates):
        warnings.append("LOGIN_WARN_SERVICE_ROTATED")

    return ServerCardVerificationResult(
        valid=True,
        server_card=server_card,
        login_service_card=service_card,
        login_service_card_pubkey=doc["holder_primary_card_pubkey"],
        domain=binding.domain,
        login_service=service,
        warnings=warnings,
    )


# ─── §6.3 verify_login_response ──────────────────────────────────────────────

@dataclass
class LoginVerificationResult:
    valid: bool
    code: Optional[str] = None
    reason: Optional[str] = None
    presented_card: Optional[str] = None
    login_service_card: Optional[str] = None
    matched_policy: Optional[str] = None
    verification: Optional[SignatureVerificationResult] = None


_REQUEST_MAX_LIFETIME_MS = 10 * 60 * 1000


def _lfail(code: str, reason: str, verification: Optional[SignatureVerificationResult] = None) -> LoginVerificationResult:
    return LoginVerificationResult(valid=False, code=code, reason=reason, verification=verification)


async def verify_login_response(
    deps: LoginDeps,
    response: dict[str, Any],
    request: dict[str, Any],
    expected_origin: str,
    now: Optional[str] = None,
    max_response_age_seconds: int = 300,
    clock_skew_seconds: int = 60,
) -> LoginVerificationResult:
    """`response` is the form_post AuthenticationResponse wrapper or, for
    mcard_message, the received envelope; `request` is the AuthenticationRequest
    exactly as the site issued it."""
    now_ms = _now_ms(now)
    skew_ms = clock_skew_seconds * 1000
    max_age_ms = max_response_age_seconds * 1000

    wrapped = "signed_statement" in response
    wrapper_state = response.get("state") if wrapped else None
    envelope = response["signed_statement"] if wrapped else response
    payload = envelope.get("payload") or {}
    content = payload.get("content") or {}

    # 1. type
    if payload.get("type") != "auth_response":
        return _lfail("LOGIN_WRONG_TYPE", f"type is {payload.get('type')}")
    # 2. state (signed and unsigned copies)
    if content.get("state") != request.get("state") or (wrapped and wrapper_state != request.get("state")):
        return _lfail("LOGIN_STATE_MISMATCH", "state does not match the issued request")
    # 3. nonce, statement
    if content.get("nonce") != request.get("nonce"):
        return _lfail("LOGIN_NONCE_MISMATCH", "nonce does not match")
    if content.get("statement") != request.get("statement"):
        return _lfail("LOGIN_STATEMENT_MISMATCH", "statement does not match")
    # 4. request hash
    if content.get("request_hash") != request_hash(request):
        return _lfail("LOGIN_REQUEST_HASH_MISMATCH", "request_hash does not match the issued request")
    # 5. audience
    request_origin = https_origin(request.get("response_uri", ""))
    if not request_origin or content.get("audience") != expected_origin or request_origin != expected_origin:
        return _lfail("LOGIN_AUDIENCE_MISMATCH", f"audience {content.get('audience')} is not {expected_origin}")
    # 6. recipients = [login service card]; exactly one sender
    server = await read_sub_card_document(request.get("requester_pubkey", ""), deps.ctx)
    holder = server.get("holder_primary_card") if server else None
    login_service_card = norm_address(holder) if isinstance(holder, str) else None
    recipients = payload.get("recipients")
    if not login_service_card or not isinstance(recipients, list) or len(recipients) != 1 or norm_address(str(recipients[0])) != login_service_card:
        return _lfail("LOGIN_RECIPIENT_MISMATCH", "recipients must be exactly the login service card")
    senders = payload.get("senders")
    if not isinstance(senders, list) or len(senders) != 1 or not isinstance(senders[0], str):
        return _lfail("LOGIN_SENDER_MISMATCH", "senders must contain exactly one card")
    presented = norm_address(senders[0])
    # 7. freshness
    ts = _parse_ms(payload.get("timestamp"))
    expires = _parse_ms(request.get("expires_at"))
    if (
        ts is None
        or expires is None
        or ts > expires + skew_ms
        or ts < expires - _REQUEST_MAX_LIFETIME_MS - skew_ms
        or now_ms - ts > max_age_ms + skew_ms
    ):
        return _lfail("LOGIN_RESPONSE_STALE", "response timestamp is outside the allowed window")
    # 8. envelope signature, sub-card link, chain, revocation
    env = await deps.verify_envelope(envelope)
    if len(env.signatures) != 1:
        return _lfail("LOGIN_PRESENTED_CARD_INVALID", "expected exactly one signature")
    sig = env.signatures[0]
    if sig.signature_valid is not True or sig.scope_clean is False or sig.chain_reaches_trusted_root is not True or sig.is_currently_valid is not True:
        return _lfail("LOGIN_PRESENTED_CARD_INVALID", sig.errors[0].code if sig.errors else "verification failed", sig)
    signed_as = norm_address(sig.chain_card_addresses[0] if sig.chain_card_addresses else sig.signer_card)
    if signed_as != presented:
        return _lfail("LOGIN_SENDER_MISMATCH", f"signed by {signed_as}, senders says {presented}", sig)
    # 9. DCQL match on the presented card
    first = sig.chain[0] if sig.chain else None
    presented_fields: Optional[dict[str, Any]] = None
    if first is not None and first.public_key:
        r = await read_card_fields(first.public_key, deps.ctx)
        presented_fields = r[1] if r else None
    elif first is not None:
        presented_fields = first.card_content
    credentials = (request.get("dcql_query") or {}).get("credentials") or []
    if not presented_fields or not credentials:
        return _lfail("LOGIN_CARD_NOT_ACCEPTED", "presented card could not be read", sig)
    match = await match_mcard_query(presented_fields, credentials[0], deps.ctx, presented)
    if not match.matched:
        return _lfail("LOGIN_CARD_NOT_ACCEPTED", match.reason or "NO_POLICY_MATCH", sig)

    return LoginVerificationResult(
        valid=True,
        presented_card=presented,
        login_service_card=login_service_card,
        matched_policy=match.policy,
        verification=sig,
    )


def login_config(config: Any) -> SimpleNamespace:
    """The Stage 2 config subset card login needs."""
    return SimpleNamespace(
        app_certification_root=config.app_certification_root,
        login_service_certification_root=config.login_service_certification_root,
        max_chain_depth=config.max_chain_depth,
    )
