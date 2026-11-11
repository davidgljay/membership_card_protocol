"""card_verifier.md §6.4 verify_server_card — port of verifyServerCard.test.ts."""

from datetime import datetime, timezone

import pytest

from tests.login.world import NOW, ORIGIN, World, WorldOptions, b64


async def check(origin: str = ORIGIN, **opts):
    w = World(WorldOptions(**opts))
    return await w.verifier.verify_server_card(b64(w.keys["server"]), origin, now=NOW)


def _ts(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp())


async def test_valid_server_card_bound_domain_covers_subdomain():
    r = await check()
    assert (r.valid, r.domain, r.warnings) == (True, "example.org", [])


@pytest.mark.parametrize(
    "opts,code",
    [
        ({"server_attestation": "T2"}, "LOGIN_REQUESTER_NOT_SERVER_CARD"),
        ({"server_capabilities": ["auth_confirmation"]}, "LOGIN_REQUESTER_NOT_SERVER_CARD"),
        ({"service_under_other_branch": True, "server_attestation": "T2"}, "LOGIN_SERVICE_NOT_CERTIFIED"),
        ({"service_codes": [800]}, "LOGIN_SERVICE_REVOKED"),
        ({"service_codes": [101]}, "LOGIN_SERVICE_KEY_COMPROMISED"),
        ({"no_binding": True}, "LOGIN_DOMAIN_BINDING_MISSING"),
        ({"tamper_binding": True}, "LOGIN_DOMAIN_BINDING_INVALID"),
        ({"domain_reg": {"admin_card_address": "ab" * 32}}, "LOGIN_DOMAIN_BINDING_STALE"),
        ({"service_head_code": 801}, "LOGIN_SERVICE_REVOKED"),
    ],
)
async def test_rejections(opts, code):
    r = await check(**opts)
    assert (r.valid, r.code) == (False, code), r.reason


async def test_6xx_warns_but_stays_valid():
    r = await check(service_codes=[600])
    assert (r.valid, r.warnings) == (True, ["LOGIN_WARN_SERVICE_NEGATIVE"])


async def test_real_6xx_log_entry_at_head_warns():
    r = await check(service_head_code=600)
    assert (r.valid, r.warnings) == (True, ["LOGIN_WARN_SERVICE_NEGATIVE"])


async def test_rotation_and_monitored_domain_warn():
    r = await check(service_codes=[100], domain_reg={"fraud_risk": 1})
    assert r.valid
    assert sorted(r.warnings) == ["LOGIN_WARN_DOMAIN_MONITORED", "LOGIN_WARN_SERVICE_ROTATED"]


async def test_suspension_blocks_until_it_lapses():
    r = await check(domain_reg={"fraud_risk": 2, "suspension_expires_at": _ts("2027-01-01T00:00:00Z")})
    assert (r.valid, r.code) == (False, "DOMAIN_SUSPENDED")
    r = await check(domain_reg={"fraud_risk": 2, "suspension_expires_at": _ts("2026-01-01T00:00:00Z")})
    assert r.valid


@pytest.mark.parametrize("origin", ["https://forum.example.net", "http://forum.example.org", "https://forum.example.org:8443"])
async def test_origin_not_covered(origin):
    r = await check(origin)
    assert (r.valid, r.code) == (False, "LOGIN_ORIGIN_NOT_BOUND")
