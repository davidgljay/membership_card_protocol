"""Pure helpers shared by every login component: the request hash, origin
normalization, and the domain-binding coverage rule. Mirrors login/encoding.ts."""

import base64
import ipaddress
from typing import Any, Optional
from urllib.parse import urlsplit

from Crypto.Hash import keccak

from ..canonicalize import canonicalize

_DEFAULT_PORTS = {"https": 443, "http": 80}


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def request_hash(request: dict[str, Any]) -> str:
    """protocol-objects.md §8 — base64url(keccak256(canonical RFC 8785 JSON of
    the complete AuthenticationRequest, including request_signature))."""
    h = keccak.new(digest_bits=256)
    h.update(canonicalize(request))
    return b64url_encode(h.digest())


def signing_bytes(obj: dict[str, Any], signature_field: Optional[str] = None) -> bytes:
    """Canonical bytes a signer signs: the object without its signature field
    (request_signature §8, admin_signature §17), or the whole wrapped body
    (`metadata` §18, `token` §19) when no field is given."""
    if signature_field is None:
        return canonicalize(obj)
    return canonicalize({k: v for k, v in obj.items() if k != signature_field})


def _split(url: str) -> Optional[tuple[str, str, Optional[int], Any]]:
    try:
        u = urlsplit(url.strip())
        port = u.port  # raises on a malformed port
    except ValueError:
        return None
    if not u.scheme or not u.hostname:
        return None
    return u.scheme.lower(), u.hostname.lower(), port, u


def https_origin(url: str, allow_fragment: bool = False) -> Optional[str]:
    """Origin of an absolute https URL meeting the response_uri rules (§8):
    https scheme, no userinfo, no fragment. Default port is omitted."""
    parts = _split(url)
    if parts is None:
        return None
    scheme, host, port, u = parts
    if scheme != "https" or u.username is not None or u.password is not None:
        return None
    if not allow_fragment and u.fragment:
        return None
    if port is not None and port != _DEFAULT_PORTS["https"]:
        return f"https://{host}:{port}"
    return f"https://{host}"


def domain_covers(domain: str, origin: str) -> bool:
    """§17 coverage rule: https, default port, host equals `domain` or ends with
    "." + domain. IP literals are never covered."""
    d = domain.lower()
    if d.endswith("."):
        d = d[:-1]
    if not d or "/" in d or ":" in d:
        return False
    parts = _split(origin)
    if parts is None:
        return False
    scheme, host, port, _u = parts
    if scheme != "https" or (port is not None and port != 443):
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return host == d or host.endswith("." + d)
