"""card_verifier.md §6.3 verify_login_response — port of verifyLoginResponse.test.ts."""

import pytest

from tests.fixtures import generate_keypair
from tests.login.world import NOW, ORIGIN, World, WorldOptions


def setup(**opts):
    w = World(WorldOptions(**opts))
    return w, w.make_request()


async def verify(w, response, request, now=NOW):
    return await w.verifier.verify_login_response(response, request, ORIGIN, now=now)


async def test_valid_form_post_response_child_policy_include_children():
    w, req = setup()
    r = await verify(w, w.make_response(req), req)
    assert r.valid, r.reason
    assert (r.presented_card, r.login_service_card) == (w.keys["user"].address, w.keys["service"].address)


async def test_accepts_bare_envelope():
    w, req = setup()
    r = await verify(w, w.make_response(req)["signed_statement"], req)
    assert r.valid, r.reason


@pytest.mark.parametrize(
    "content,code",
    [
        ({"state": "x"}, "LOGIN_STATE_MISMATCH"),
        ({"nonce": "x"}, "LOGIN_NONCE_MISMATCH"),
        ({"statement": "x"}, "LOGIN_STATEMENT_MISMATCH"),
        ({"request_hash": "x"}, "LOGIN_REQUEST_HASH_MISMATCH"),
        ({"audience": "https://evil.example.net"}, "LOGIN_AUDIENCE_MISMATCH"),
    ],
)
async def test_tampered_content(content, code):
    w, req = setup()
    r = await verify(w, w.make_response(req, content=content), req)
    assert (r.valid, r.code) == (False, code)


async def test_recipient_mismatch():
    w, req = setup()
    r = await verify(w, w.make_response(req, payload={"recipients": [w.keys["server"].address]}), req)
    assert r.code == "LOGIN_RECIPIENT_MISMATCH"


async def test_wrong_type():
    w, req = setup()
    r = await verify(w, w.make_response(req, payload={"type": "text"}), req)
    assert r.code == "LOGIN_WRONG_TYPE"


async def test_stale_response():
    w, req = setup()
    r = await verify(w, w.make_response(req), req, now="2026-11-09T12:20:00Z")
    assert r.code == "LOGIN_RESPONSE_STALE"


async def test_sender_mismatch():
    w, req = setup()
    r = await verify(w, w.make_response(req, payload={"senders": [w.keys["issuer"].address]}), req)
    assert r.code == "LOGIN_SENDER_MISMATCH"


async def test_unregistered_signer():
    w, req = setup()
    stranger = generate_keypair()
    r = await verify(w, w.make_response(req, signer=stranger, payload={"senders": [stranger.address]}), req)
    assert r.code == "LOGIN_PRESENTED_CARD_INVALID"


def _exact(w):
    return {"credentials": [{"id": "m", "format": "mcard", "meta": {"policies": [{"id": w.keys["policy_root"].address, "include_children": False}]}}]}


async def test_child_policy_card_rejected_without_include_children():
    w = World()
    req = w.make_request(dcql_query=_exact(w))
    r = await verify(w, w.make_response(req), req)
    assert r.code == "LOGIN_CARD_NOT_ACCEPTED"


async def test_unrelated_policy_rejected():
    w, req = setup(user_policy="unrelated")
    r = await verify(w, w.make_response(req), req)
    assert r.code == "LOGIN_CARD_NOT_ACCEPTED"


async def test_card_directly_under_requested_policy_exact_match():
    w = World(WorldOptions(user_policy="root"))
    req = w.make_request(dcql_query=_exact(w))
    r = await verify(w, w.make_response(req), req)
    assert r.valid, r.reason
