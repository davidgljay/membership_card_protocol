"""Chain-reading helpers for card login: current card fields, a card's policy,
the policy issuance-chain walk (protocol-objects.md §8.1), DCQL `mcard`
matching, and effective `preferred_services` (§2). Mirrors login/chain.ts."""

import json
import re
from dataclasses import dataclass
from typing import Any, Optional

from ..crypto import aes256gcm_decrypt, hkdf_sha3_256, keccak256
from ..errors import CardProtocolError
from ..head import decrypt_card_head
from ..types import IpfsProvider, RpcProvider
from .encoding import b64url_decode


@dataclass
class ChainContext:
    rpc: RpcProvider
    ipfs: IpfsProvider
    max_chain_depth: Optional[int] = None


def norm_address(a: str) -> str:
    """Lowercase hex, no 0x."""
    return a.lower().removeprefix("0x")


async def read_card_fields(pubkey_b64: str, ctx: ChainContext) -> Optional[tuple[str, dict[str, Any]]]:
    """A card's current fields (genesis document overlaid with the latest
    LogEntry's card_state). Returns (address, fields) or None."""
    try:
        pubkey = b64url_decode(pubkey_b64)
    except Exception:
        return None
    address = keccak256(pubkey)
    entry = await ctx.rpc.get_card_entry(address)
    if not entry or not entry.exists:
        return None
    try:
        fields = await decrypt_card_head(entry.log_head_cid, hkdf_sha3_256(pubkey, "card-content-v1"), ctx.ipfs)
    except Exception:
        return None
    return address, fields


async def read_sub_card_document(pubkey_b64: str, ctx: ChainContext) -> Optional[dict[str, Any]]:
    """A sub-card's document, from its SubCardEntry (plain JSON) or a CardEntry
    head encrypted under the sub-card key. None unless recipient_pubkey is this key."""
    try:
        pubkey = b64url_decode(pubkey_b64)
    except Exception:
        return None
    address = keccak256(pubkey)
    entry = await ctx.rpc.get_card_entry(address)
    cid: Optional[str] = entry.log_head_cid if entry and entry.exists else None
    if not cid:
        sub = await ctx.rpc.get_sub_card_entry(address)
        cid = sub.sub_card_doc_cid if sub else None
    if not cid:
        return None
    try:
        raw = await ctx.ipfs.fetch(cid)
        try:
            text = aes256gcm_decrypt(hkdf_sha3_256(pubkey, "card-content-v1"), raw).decode("utf-8")
        except CardProtocolError:
            text = raw.decode("utf-8")
        doc = json.loads(text)
    except Exception:
        return None
    return doc if isinstance(doc, dict) and doc.get("recipient_pubkey") == pubkey_b64 else None


@dataclass
class PolicyRef:
    address: str  # registry address of the policy card
    snapshot: dict[str, Any]  # the policy snapshot at the card's policy_id CID


async def policy_of(card_fields: dict[str, Any], ctx: ChainContext) -> Optional[PolicyRef]:
    policy_id = card_fields.get("policy_id")
    if not isinstance(policy_id, str):
        return None
    try:
        snapshot = json.loads((await ctx.ipfs.fetch(policy_id)).decode("utf-8"))
    except Exception:
        return None
    pk = snapshot.get("recipient_pubkey") if isinstance(snapshot, dict) else None
    if not isinstance(pk, str):
        return None
    return PolicyRef(address=keccak256(b64url_decode(pk)), snapshot=snapshot)


async def parent_policy(policy: PolicyRef, ctx: ChainContext) -> Optional[PolicyRef]:
    """The policy card's issuer (ancestry_pubkeys[0]) → that card's own policy."""
    ancestry = policy.snapshot.get("ancestry_pubkeys")
    if not isinstance(ancestry, list) or not ancestry:
        return None
    issuer = await read_card_fields(ancestry[0], ctx)
    if not issuer:
        return None
    parent = await policy_of(issuer[1], ctx)
    if not parent or parent.address == policy.address:
        return None
    return parent


async def policy_lineage(card_fields: dict[str, Any], ctx: ChainContext) -> list[PolicyRef]:
    """The card's policy followed by its issuance-chain ancestors, nearest first."""
    out: list[PolicyRef] = []
    seen: set[str] = set()
    max_depth = ctx.max_chain_depth or 64
    current = await policy_of(card_fields, ctx)
    while current and current.address not in seen and len(out) < max_depth:
        out.append(current)
        seen.add(current.address)
        current = await parent_policy(current, ctx)
    return out


@dataclass
class DcqlMatch:
    matched: bool
    policy: Optional[str] = None
    reason: Optional[str] = None  # NO_POLICY_MATCH | POLICY_UNRESOLVED | PREDICATE_NOT_SUPPORTED


async def match_mcard_query(
    card_fields: dict[str, Any],
    query: dict[str, Any],
    ctx: ChainContext,
    card_address: Optional[str] = None,
) -> DcqlMatch:
    """§8.1 steps 1–2 for one card. Policies compare by registry address. When
    card_address is given, the card's own policy is the on-chain
    CardEntry.policy_address; ancestors still come from the snapshot chain."""
    lineage = await policy_lineage(card_fields, ctx)
    own = lineage[0].address if lineage else None
    if card_address:
        entry = await ctx.rpc.get_card_entry(norm_address(card_address))
        on_chain = norm_address(entry.policy_address) if entry and entry.exists and entry.policy_address else ""
        if on_chain and not re.fullmatch(r"0+", on_chain):
            own = on_chain
    if not own:
        return DcqlMatch(matched=False, reason="POLICY_UNRESOLVED")
    ancestors = {own, *(p.address for p in lineage)}
    meta = query.get("meta", {})
    for ref in meta.get("policies", []):
        pid = norm_address(ref["id"])
        if pid == own or (ref.get("include_children") and pid in ancestors):
            # The predicate engine lives in the press today; until it is shared,
            # a predicate never matches.
            if "predicate" in meta:
                return DcqlMatch(matched=False, reason="PREDICATE_NOT_SUPPORTED")
            return DcqlMatch(matched=True, policy=ref["id"])
    return DcqlMatch(matched=False, reason="NO_POLICY_MATCH")


async def live_policy_fields(policy: PolicyRef, ctx: ChainContext) -> Optional[dict[str, Any]]:
    """The live head of a policy card — preferred_services follows the live head."""
    pk = policy.snapshot.get("recipient_pubkey")
    if not isinstance(pk, str):
        return None
    r = await read_card_fields(pk, ctx)
    return r[1] if r else None


async def effective_preferred_services(card_fields: dict[str, Any], ctx: ChainContext) -> list[dict[str, Any]]:
    """§2: the first policy up the issuance chain whose live head has the field
    set — including [] — wins."""
    for policy in await policy_lineage(card_fields, ctx):
        live = await live_policy_fields(policy, ctx) or policy.snapshot
        lst = live.get("preferred_services")
        if isinstance(lst, list):
            return lst
    return []
