import base64
import json
from dataclasses import dataclass
from typing import Any, Optional

from membership_card_verifier.crypto import aes256gcm_decrypt, hkdf_sha3_256, keccak256
from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.types import ChainLink, IpfsProvider, RpcProvider, VerificationError


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


@dataclass
class Stage3Result:
    chain_reaches_trusted_root: bool
    chain_card_addresses: list[str]
    chain: list[ChainLink]
    errors: list[VerificationError]


async def verify_stage3(
    start_card_doc: dict,
    start_card_address: str,
    rpc: RpcProvider,
    ipfs: IpfsProvider,
    config: Any,
    start_card_pubkey: Optional[bytes] = None,
) -> Stage3Result:
    trusted_roots = config.trusted_roots if config.trusted_roots is not None else []
    max_depth = config.max_chain_depth if config.max_chain_depth is not None else 64
    errors: list[VerificationError] = []
    chain_addresses: list[str] = [start_card_address]
    chain: list[ChainLink] = [
        ChainLink(
            card_address=start_card_address,
            public_key=_b64url_encode(start_card_pubkey) if start_card_pubkey else "",
            card_content=start_card_doc,
        )
    ]

    current_doc = start_card_doc
    current_address = start_card_address

    for depth in range(max_depth):
        ancestry_pubkeys = current_doc.get("ancestry_pubkeys", [])

        if len(ancestry_pubkeys) == 0:
            is_root = (
                current_address in trusted_roots
                or await rpc.is_policy_authorizer(current_address)
            )
            return Stage3Result(
                chain_reaches_trusted_root=is_root,
                chain_card_addresses=chain_addresses,
                chain=chain,
                errors=errors,
            )

        next_pubkey_b64 = ancestry_pubkeys[0]
        if not next_pubkey_b64:
            break

        next_pubkey_bytes = _b64url_decode(next_pubkey_b64)
        next_address = keccak256(next_pubkey_bytes)

        is_next_root = (
            next_address in trusted_roots
            or await rpc.is_policy_authorizer(next_address)
        )

        if is_next_root:
            chain_addresses.append(next_address)
            # Note: the root's CardDocument is not fetched/decrypted here (no new I/O per
            # the plan's constraint), so it is not added to `chain` — only to
            # `chain_card_addresses`, which already tracked addresses-only.
            return Stage3Result(
                chain_reaches_trusted_root=True,
                chain_card_addresses=chain_addresses,
                chain=chain,
                errors=errors,
            )

        card_entry = await rpc.get_card_entry(next_address)
        if not card_entry or not card_entry.exists:
            errors.append(
                VerificationError(
                    stage=3,
                    code="CARD_NOT_FOUND",
                    message=f"Ancestor card not found: {next_address}",
                )
            )
            return Stage3Result(
                chain_reaches_trusted_root=False,
                chain_card_addresses=chain_addresses,
                chain=chain,
                errors=errors,
            )

        content_key = hkdf_sha3_256(next_pubkey_bytes, "card-content-v1")
        try:
            encrypted = await ipfs.fetch(card_entry.log_head_cid)
            decrypted = aes256gcm_decrypt(content_key, encrypted)
            ancestor_doc = json.loads(decrypted.decode("utf-8"))
        except CardProtocolError as e:
            errors.append(
                VerificationError(
                    stage=3,
                    code=e.code,
                    message=str(e),
                )
            )
            return Stage3Result(
                chain_reaches_trusted_root=False,
                chain_card_addresses=chain_addresses,
                chain=chain,
                errors=errors,
            )
        except Exception as e:
            errors.append(
                VerificationError(
                    stage=3,
                    code="DECRYPTION_FAILED",
                    message=str(e),
                )
            )
            return Stage3Result(
                chain_reaches_trusted_root=False,
                chain_card_addresses=chain_addresses,
                chain=chain,
                errors=errors,
            )

        chain_addresses.append(next_address)
        chain.append(
            ChainLink(
                card_address=next_address,
                public_key=next_pubkey_b64,
                card_content=ancestor_doc,
            )
        )
        current_doc = ancestor_doc
        current_address = next_address

    errors.append(
        VerificationError(
            stage=3,
            code="CHAIN_DEPTH_EXCEEDED",
            message=f"Chain walk exceeded maxChainDepth ({max_depth})",
        )
    )
    return Stage3Result(
        chain_reaches_trusted_root=False,
        chain_card_addresses=chain_addresses,
        chain=chain,
        errors=errors,
    )
