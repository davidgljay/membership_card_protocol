"""card_verifier.md §7.2 step 16f — login service branch and scope rule.
Port of the JS verifier's test/stages/stage2-login-service.test.ts."""

import json
from types import SimpleNamespace
from typing import Optional

from membership_card_verifier.stages.stage2 import verify_stage2
from membership_card_verifier.types import CardEntry, SubCardEntry
from tests.fixtures import _b64url_encode, encrypt_for_card, generate_keypair, make_card_doc, make_sub_card_doc


def scenario(self_scoped: bool, attestation: str = "T2"):
    """root ← branch ← app card; a master card; a sub-card of the master
    certified by the app card. When self_scoped, the app card IS the master."""
    root, branch, app, sub, press = (generate_keypair() for _ in range(5))
    holder = app if self_scoped else generate_keypair()
    b64 = lambda k: _b64url_encode(k.public_key)  # noqa: E731

    sub_doc = make_sub_card_doc(holder.public_key, holder.secret_key, app.public_key, app.secret_key, sub.public_key, {"attestation_level": attestation})
    app_doc = make_card_doc(app.public_key, branch.secret_key, app.secret_key, press.secret_key, [b64(branch)])
    branch_doc = make_card_doc(branch.public_key, root.secret_key, branch.secret_key, press.secret_key, [b64(root)])
    master_doc = app_doc if self_scoped else make_card_doc(holder.public_key, root.secret_key, holder.secret_key, press.secret_key)
    master_doc["active_subcards"] = [b64(sub)]
    docs = {sub.address: (sub, sub_doc), holder.address: (holder, master_doc), app.address: (app, app_doc), branch.address: (branch, branch_doc)}

    class Rpc:
        async def get_card_entry(self, addr: str) -> Optional[CardEntry]:
            return CardEntry(log_head_cid=f"Qm{addr}", policy_address="0x", last_press_address="0x", exists=True) if addr in docs else None

        async def get_sub_card_entry(self, addr: str) -> SubCardEntry:
            return SubCardEntry(master_card_address=holder.address, registration_log_head="0x", sub_card_doc_cid="QmSub", active=True, registered_at="2026-01-01T00:00:00Z")

    class Ipfs:
        async def fetch(self, cid: str) -> bytes:
            kp, doc = docs[cid[2:]]
            return encrypt_for_card(kp.public_key, json.dumps(doc).encode("utf-8"))

    return SimpleNamespace(root=root, branch=branch, sub=sub, rpc=Rpc(), ipfs=Ipfs())


def cfg(root: str, login_root: Optional[str]) -> SimpleNamespace:
    return SimpleNamespace(app_certification_root=root, login_service_certification_root=login_root, max_chain_depth=None)


async def test_server_card_is_scope_clean_on_login_service_branch():
    s = scenario(self_scoped=True, attestation="S1")
    r = await verify_stage2(s.sub.public_key, s.rpc, s.ipfs, cfg(s.root.address, s.branch.address))
    assert r.errors == []
    assert (r.scope_clean, r.app_card_branch) == (True, "login_service")
    assert r.sub_card_doc and r.sub_card_doc["attestation_level"] == "S1"


async def test_login_service_card_certifying_another_master_is_rejected():
    s = scenario(self_scoped=False)
    r = await verify_stage2(s.sub.public_key, s.rpc, s.ipfs, cfg(s.root.address, s.branch.address))
    assert r.scope_clean is False
    assert "LOGIN_SERVICE_SCOPE" in [e.code for e in r.errors]


async def test_other_branch_is_scope_clean():
    s = scenario(self_scoped=False)
    r = await verify_stage2(s.sub.public_key, s.rpc, s.ipfs, cfg(s.root.address, "5e" * 32))
    assert (r.scope_clean, r.app_card_branch) == (True, "other")


async def test_s1_on_ordinary_sub_card_is_rejected():
    s = scenario(self_scoped=False, attestation="S1")
    r = await verify_stage2(s.sub.public_key, s.rpc, s.ipfs, cfg(s.root.address, "5e" * 32))
    assert "ATTESTATION_LEVEL_INSUFFICIENT" in [e.code for e in r.errors]


async def test_missing_login_root_is_a_hard_failure():
    s = scenario(self_scoped=False)
    r = await verify_stage2(s.sub.public_key, s.rpc, s.ipfs, cfg(s.root.address, None))
    assert r.scope_clean is False
    assert "LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED" in [e.code for e in r.errors]
