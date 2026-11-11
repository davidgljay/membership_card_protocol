"""A complete card-login world for verifier tests — a port of the JS
verifier's test/login/world.ts (process_specs/card_login.md):

  app_root (app-certification root, trusted)
   └── login_branch (VerifierConfig.login_service_certification_root)
        └── service (login service card; head is a LogEntry carrying
             active_subcards + domain_binding)
             └── server (server card: app_card = holder = service, S1)
  admin (full-domain DNS admin card for example.org)

  user_root (trusted)
   └── issuer (card under policy "root"); policy "child" is issued by issuer
   └── user card (issued under policy "child"), with a device sub-card

All crypto is real; RPC and IPFS are in-memory.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from membership_card_verifier import CardVerifier, VerifierConfig
from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.login.encoding import request_hash
from membership_card_verifier.types import CardEntry, DomainRegistration, LogUpdate, PressAuthEntry, SubCardEntry
from tests.fixtures import Keypair, _b64url_encode, encrypt_for_card, generate_keypair, make_card_doc, make_sub_card_doc, sign

ORIGIN = "https://forum.example.org"
NOW = "2026-11-09T12:05:00Z"


def b64(k: Keypair | bytes) -> str:
    return _b64url_encode(k if isinstance(k, bytes) else k.public_key)


def _json(o: Any) -> bytes:
    return json.dumps(o).encode("utf-8")


@dataclass
class WorldOptions:
    server_attestation: str = "S1"
    server_capabilities: list[str] = field(default_factory=lambda: ["auth_request", "auth_confirmation", "error"])
    service_under_other_branch: bool = False
    binding_domain: str = "example.org"
    no_binding: bool = False
    tamper_binding: bool = False
    domain_reg: Optional[dict[str, Any]] = field(default_factory=dict)  # None → no registration
    service_codes: list[int] = field(default_factory=list)
    service_head_code: int = 520
    user_policy: str = "child"


class _Rpc:
    def __init__(self, w: "World") -> None:
        self.w = w

    async def get_card_entry(self, addr: str) -> Optional[CardEntry]:
        cid = self.w.entries.get(addr)
        if not cid:
            return None
        return CardEntry(log_head_cid=cid, policy_address="0x", last_press_address=self.w.keys["press"].address, exists=True)

    async def is_policy_authorizer(self, addr: str) -> bool:
        return addr in (self.w.keys["app_root"].address, self.w.keys["user_root"].address)

    async def get_press_authorization(self, policy_address: str, press_address: str) -> PressAuthEntry:
        return PressAuthEntry(press_public_key="", mldsa44_key_hash="0x", active=True, authorized_at="2026-01-01T00:00:00Z")

    async def get_sub_card_entry(self, addr: str) -> Optional[SubCardEntry]:
        k = self.w.keys
        if addr == k["server"].address:
            return SubCardEntry(master_card_address=k["service"].address, registration_log_head="0x", sub_card_doc_cid="QmServer", active=True, registered_at="2026-01-01T00:00:00Z")
        if addr == k["device"].address:
            return SubCardEntry(master_card_address=k["user"].address, registration_log_head="0x", sub_card_doc_cid="QmDevice", active=True, registered_at="2026-01-01T00:00:00Z")
        return None

    async def get_card_event_log(self, card_address: str) -> list[Any]:
        return []

    async def get_eas_annotations(self, card_address: str, annotator_addresses: list[str]) -> list[Any]:
        return []

    async def get_domain_registration(self, domain: str) -> Optional[DomainRegistration]:
        o = self.w.opts
        if o.domain_reg is None or domain != o.binding_domain:
            return None
        reg = {"admin_card_address": self.w.keys["admin"].address, "fraud_risk": 0, "suspension_expires_at": 0, **o.domain_reg}
        return DomainRegistration(**reg)


class _Ipfs:
    def __init__(self, blobs: dict[str, bytes]) -> None:
        self.blobs = blobs

    async def fetch(self, cid: str) -> bytes:
        if cid not in self.blobs:
            raise KeyError(f"CID not found: {cid}")
        return self.blobs[cid]


class World:
    def __init__(self, opts: Optional[WorldOptions] = None) -> None:
        o = self.opts = opts or WorldOptions()
        names = ["app_root", "login_branch", "other_branch", "service", "server", "admin", "user_root", "issuer", "user",
                 "device", "wallet_card", "press", "policy_root", "policy_child", "policy_other"]
        k = self.keys = {n: generate_keypair() for n in names}
        self.blobs: dict[str, bytes] = {}
        self.entries: dict[str, str] = {}

        def register(kp: Keypair, doc: Any, cid: str) -> None:
            self.blobs[cid] = encrypt_for_card(kp.public_key, _json(doc))
            self.entries[kp.address] = cid

        def policy_doc(kp: Keypair, ancestry: list[str]) -> dict[str, Any]:
            return {"recipient_pubkey": b64(kp), "ancestry_pubkeys": ancestry, "field_definitions": {}}

        self.policies = {
            "root": (k["policy_root"], "QmPolicyRoot", policy_doc(k["policy_root"], [b64(k["user_root"])])),
            "child": (k["policy_child"], "QmPolicyChild", policy_doc(k["policy_child"], [b64(k["issuer"])])),
            "unrelated": (k["policy_other"], "QmPolicyOther", policy_doc(k["policy_other"], [b64(k["user_root"])])),
        }
        for kp, cid, doc in self.policies.values():
            self.blobs[cid] = _json(doc)
            register(kp, doc, f"{cid}-head")
        self.blobs["QmPolicyPlain"] = _json({"field_definitions": {}})
        plain = {"policy_id": "QmPolicyPlain"}

        # User side.
        register(k["issuer"], make_card_doc(k["issuer"].public_key, k["user_root"].secret_key, k["issuer"].secret_key, k["press"].secret_key, [b64(k["user_root"])], {"policy_id": "QmPolicyRoot"}), "QmIssuer")
        user_policy_cid = self.policies[o.user_policy][1]
        register(k["user"], make_card_doc(k["user"].public_key, k["issuer"].secret_key, k["user"].secret_key, k["press"].secret_key, [b64(k["issuer"])], {"policy_id": user_policy_cid, "active_subcards": [b64(k["device"])]}), "QmUser")

        # Login service side.
        branch = k["other_branch"] if o.service_under_other_branch else k["login_branch"]
        register(k["login_branch"], make_card_doc(k["login_branch"].public_key, k["app_root"].secret_key, k["login_branch"].secret_key, k["press"].secret_key, [b64(k["app_root"])], plain), "QmLoginBranch")
        register(k["other_branch"], make_card_doc(k["other_branch"].public_key, k["app_root"].secret_key, k["other_branch"].secret_key, k["press"].secret_key, [b64(k["app_root"])], plain), "QmOtherBranch")
        register(k["wallet_card"], make_card_doc(k["wallet_card"].public_key, k["other_branch"].secret_key, k["wallet_card"].secret_key, k["press"].secret_key, [b64(k["other_branch"])], plain), "QmWalletCard")
        register(k["device"], make_sub_card_doc(k["user"].public_key, k["user"].secret_key, k["wallet_card"].public_key, k["wallet_card"].secret_key, k["device"].public_key, {"capabilities": ["auth_response"]}), "QmDevice")
        register(k["admin"], make_card_doc(k["admin"].public_key, k["user_root"].secret_key, k["admin"].secret_key, k["press"].secret_key, [b64(k["user_root"])], plain), "QmAdmin")

        unsigned = {
            "admin_card": k["admin"].address,
            "admin_card_pubkey": b64(k["admin"]),
            "domain": o.binding_domain,
            "issued_at": "2026-11-01T00:00:00Z",
            "login_service_card": k["service"].address,
            "login_service_card_pubkey": b64(k["service"]),
        }
        binding = {**unsigned, "admin_signature": sign(k["admin"].secret_key, unsigned)}
        if o.tamper_binding:
            binding["issued_at"] = "2026-11-02T00:00:00Z"

        genesis = make_card_doc(k["service"].public_key, branch.secret_key, k["service"].secret_key, k["press"].secret_key, [b64(branch)], plain)
        self.blobs["QmServiceGenesis"] = encrypt_for_card(k["service"].public_key, _json(genesis))
        code = o.service_head_code
        head: dict[str, Any] = {
            "version": 2,
            "code": code,
            "entry_type": "revocation" if code >= 800 else "field_update",
            **({"revocation": {"effective_date": "2026-11-01T00:00:00Z"}} if code >= 800 else {}),
            "history": ["QmServiceGenesis"],
            "card_state": {"active_subcards": [b64(k["server"])], **({} if o.no_binding else {"domain_binding": binding})},
        }
        self.blobs["QmServiceHead"] = encrypt_for_card(k["service"].public_key, _json(head))
        self.entries[k["service"].address] = "QmServiceHead"

        server_doc = make_sub_card_doc(k["service"].public_key, k["service"].secret_key, k["service"].public_key, k["service"].secret_key, k["server"].public_key,
                                       {"attestation_level": o.server_attestation, "capabilities": o.server_capabilities})
        register(k["server"], server_doc, "QmServer")

        self.rpc = _Rpc(self)
        self.ipfs = _Ipfs(self.blobs)
        self.verifier = CardVerifier(VerifierConfig(
            rpc=self.rpc,
            ipfs=self.ipfs,
            trusted_roots=[k["app_root"].address, k["user_root"].address],
            app_certification_root=k["app_root"].address,
            login_service_certification_root=k["login_branch"].address,
        ))
        # Stage 4 reads revocations from the event log, which these tests don't
        # model; inject the service card's update codes into verify_card.
        if o.service_codes:
            updates = [LogUpdate(card_address=k["service"].address, update_code=c, cid=f"QmServiceUpdate{i}", effective_date="2026-11-01T00:00:00Z")
                       for i, c in enumerate(o.service_codes)]
            original = self.verifier.verify_card

            async def patched(address: str, options: Any = None) -> Any:
                r = await original(address, options)
                if address != k["service"].address:
                    return r
                r.log_updates = [*r.log_updates, *updates]
                if any(u.update_code >= 800 for u in updates):
                    r.is_currently_valid = False
                return r

            self.verifier.verify_card = patched  # type: ignore[method-assign]

    def make_request(self, **over: Any) -> dict[str, Any]:
        k = self.keys
        unsigned = {
            "dcql_query": {"credentials": [{"id": "m", "format": "mcard", "meta": {"policies": [{"id": k["policy_root"].address, "include_children": True}]}}]},
            "expires_at": "2026-11-09T12:10:00Z",
            "nonce": b64(bytes([1]) * 32),
            "purpose": "Log in",
            "requester_card": k["server"].address,
            "requester_pubkey": b64(k["server"]),
            "response_mode": "form_post",
            "response_uri": "https://forum.example.org/login/cb",
            "state": b64(bytes([2]) * 16),
            "statement": "Log in to https://forum.example.org",
            "version": "2",
            **over,
        }
        return {**unsigned, "request_signature": sign(k["server"].secret_key, unsigned)}

    def make_response(self, request: dict[str, Any], content: Optional[dict[str, Any]] = None,
                      payload: Optional[dict[str, Any]] = None, signer: Optional[Keypair] = None) -> dict[str, Any]:
        k = self.keys
        body = {
            "type": "auth_response",
            "content": {
                "audience": ORIGIN,
                "nonce": request["nonce"],
                "request_hash": request_hash(request),
                "state": request["state"],
                "statement": request["statement"],
                **(content or {}),
            },
            "protocol_version": "0.1",
            "recipients": [k["service"].address],
            "senders": [k["user"].address],
            "timestamp": "2026-11-09T12:04:00Z",
            **(payload or {}),
        }
        s = signer or k["device"]
        signature = _b64url_encode(s.secret_key.sign(canonicalize(body)))
        return {"state": request["state"], "signed_statement": {"payload": body, "signatures": [{"public_key": b64(s), "signature": signature}]}}
