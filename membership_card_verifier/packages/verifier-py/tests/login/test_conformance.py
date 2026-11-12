"""specs/login-conformance.json — the same vectors the JS verifier passes
(test/login/conformance.test.ts, chain.test.ts)."""

import json
from pathlib import Path
from typing import Any

import pytest

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.crypto import ml_dsa44_verify
from membership_card_verifier.login.chain import ChainContext, effective_preferred_services, match_mcard_query
from membership_card_verifier.login.encoding import b64url_decode, domain_covers, https_origin, request_hash, signing_bytes
from membership_card_verifier.types import CardEntry
from tests.fixtures import _b64url_encode, encrypt_for_card, generate_keypair

VECTORS = json.loads((Path(__file__).resolve().parents[5] / "specs" / "login-conformance.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("c", VECTORS["request_hash"], ids=lambda c: c["id"])
def test_request_hash(c):
    assert canonicalize(c["input"]).decode("utf-8") == c["expected_canonical"]
    assert request_hash(c["input"]) == c["expected_request_hash"]


@pytest.mark.parametrize("c", VECTORS["signatures"], ids=lambda c: c["id"])
def test_signatures(c):
    if c.get("signature_field"):
        data = signing_bytes(c["object"], c["signature_field"])
        sig = c["object"][c["signature_field"]]
    else:
        body = c["object"]["metadata"] if c["kind"] == "LoginServiceMetadata" else c["object"]["token"]
        data = signing_bytes(body)
        sig = c["object"]["signature"]
    assert ml_dsa44_verify(b64url_decode(c["public_key"]), data, b64url_decode(sig)) is c["expected_valid"]


@pytest.mark.parametrize("c", VECTORS["domain_coverage"], ids=lambda c: c["id"])
def test_domain_coverage(c):
    assert domain_covers(c["domain"], c["origin"]) is c["expected_covered"]


def test_https_origin_rules():
    assert https_origin("https://a.example:443/x?y") == "https://a.example"
    assert https_origin("https://a.example:8443/x") == "https://a.example:8443"
    for bad in ("http://a.example/x", "https://u:p@a.example/x", "https://a.example/x#f", "not a url"):
        assert https_origin(bad) is None


# ─── §8.1 / §2 against policy_tree ───────────────────────────────────────────

class _TreeRpc:
    def __init__(self, heads: dict[str, str]):
        self.heads = heads

    async def get_card_entry(self, a: str):
        cid = self.heads.get(a)
        return CardEntry(log_head_cid=cid, policy_address="0x", last_press_address="0x", exists=True) if cid else None

    async def get_sub_card_entry(self, a: str):
        return None


class _Blobs:
    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs

    async def fetch(self, cid: str) -> bytes:
        return self.blobs[cid]


def _build_tree(tree: dict[str, Any]):
    blobs: dict[str, bytes] = {}
    heads: dict[str, str] = {}
    kp = {name: generate_keypair() for name in tree}
    enc = lambda o: json.dumps(o).encode("utf-8")  # noqa: E731
    for name, node in tree.items():
        ancestry: list[str] = []
        if node.get("parent"):
            issuer = generate_keypair()
            issuer_doc = {"policy_id": f"Qm-{node['parent']}", "ancestry_pubkeys": [], "recipient_pubkey": _b64url_encode(issuer.public_key)}
            blobs[f"Qm-issuer-{name}"] = encrypt_for_card(issuer.public_key, enc(issuer_doc))
            heads[issuer.address] = f"Qm-issuer-{name}"
            ancestry.append(_b64url_encode(issuer.public_key))
        snap = {"recipient_pubkey": _b64url_encode(kp[name].public_key), "ancestry_pubkeys": ancestry}
        if "preferred_services" in node:
            snap["preferred_services"] = node["preferred_services"]
        blobs[f"Qm-{name}"] = enc(snap)
        blobs[f"Qm-{name}-head"] = encrypt_for_card(kp[name].public_key, enc(snap))
        heads[kp[name].address] = f"Qm-{name}-head"
    ctx = ChainContext(rpc=_TreeRpc(heads), ipfs=_Blobs(blobs))
    return ctx, (lambda n: kp[n].address), (lambda n: {"policy_id": f"Qm-{n}"})


TREE = _build_tree(VECTORS["policy_tree"])


@pytest.mark.parametrize("c", VECTORS["dcql_match"], ids=lambda c: c["id"])
async def test_dcql_match(c):
    ctx, address, card = TREE
    query = {"id": "m", "format": "mcard", "meta": {"policies": [{"id": address(q["id"]), "include_children": q["include_children"]} for q in c["query"]]}}
    r = await match_mcard_query(card(c["card_policy"]), query, ctx)
    if c["expected_match"] is None:
        assert r.matched is False
    else:
        assert (r.matched, r.policy) == (True, address(c["expected_match"]))


async def test_predicate_never_matches():
    ctx, address, card = TREE
    query = {"id": "m", "format": "mcard", "meta": {"policies": [{"id": address("root"), "include_children": True}], "predicate": {"is_holder": True}}}
    r = await match_mcard_query(card("root"), query, ctx)
    assert (r.matched, r.reason) == (False, "PREDICATE_NOT_SUPPORTED")


@pytest.mark.parametrize("c", VECTORS["preferred_services"], ids=lambda c: c["id"])
async def test_preferred_services(c):
    ctx, _address, card = TREE
    assert await effective_preferred_services(card(c["card_policy"]), ctx) == c["expected"]


async def test_own_policy_from_on_chain_policy_address():
    class Rpc:
        async def get_card_entry(self, a):
            return CardEntry(log_head_cid="x", policy_address="0x" + "ab" * 32, last_press_address="0x", exists=True)

    class Ipfs:
        async def fetch(self, cid):
            return json.dumps({"field_definitions": {}}).encode()

    ctx = ChainContext(rpc=Rpc(), ipfs=Ipfs())
    q = lambda inc: {"id": "m", "format": "mcard", "meta": {"policies": [{"id": "ab" * 32, "include_children": inc}]}}  # noqa: E731
    r = await match_mcard_query({"policy_id": "bafy"}, q(False), ctx, "cd" * 32)
    assert (r.matched, r.policy) == (True, "ab" * 32)
    r = await match_mcard_query({"policy_id": "bafy"}, q(False), ctx)
    assert (r.matched, r.reason) == (False, "POLICY_UNRESOLVED")
