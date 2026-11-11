import base64
import json
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.crypto import (
    aes256gcm_decrypt,
    hkdf_sha3_256,
    keccak256,
    ml_dsa44_verify,
)
from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.head import decrypt_card_head
from membership_card_verifier.types import IpfsProvider, RpcProvider, VerificationError


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


@dataclass
class Stage2Result:
    scope_clean: bool | Literal["skipped"]
    signer_card: str
    app_card_chain_valid: bool | Literal["skipped"]
    errors: list[VerificationError] = field(default_factory=list)
    master_card_doc: Optional[dict[str, Any]] = None
    master_card_pubkey: Optional[bytes] = None
    # Set once the app card chain walk completes (step 16f).
    app_card_branch: Optional[Literal["login_service", "other"]] = None
    # The decrypted SubCardDocument, when the signer is a sub-card.
    sub_card_doc: Optional[dict[str, Any]] = None


async def verify_stage2(
    public_key_bytes: bytes,
    rpc: RpcProvider,
    ipfs: IpfsProvider,
    config: Any,
) -> Stage2Result:
    errors: list[VerificationError] = []
    signer_card = keccak256(public_key_bytes)

    # Step 2: locate the sub-card document. The registry contract's
    # RegisterSubCard records a SubCardEntry (sub_card_doc_cid) rather than a
    # CardEntry, and the press pins the document as plain canonical JSON; a
    # CardEntry whose head is the encrypted document is also accepted.
    card_entry = await rpc.get_card_entry(signer_card)
    doc_cid: Optional[str] = card_entry.log_head_cid if card_entry and card_entry.exists else None
    if not doc_cid:
        sub = await rpc.get_sub_card_entry(signer_card)
        doc_cid = (sub.sub_card_doc_cid if sub else None) or None
    if not doc_cid:
        errors.append(
            VerificationError(
                stage=2,
                code="CARD_NOT_FOUND",
                message=f"No card or sub-card entry for {signer_card}",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 3: derive leaf content key
    leaf_content_key = hkdf_sha3_256(public_key_bytes, "card-content-v1")

    # Step 4: fetch the sub-card document (encrypted under the leaf key, or plain)
    sub_card_doc: dict[str, Any]
    try:
        raw = await ipfs.fetch(doc_cid)
        try:
            text = aes256gcm_decrypt(leaf_content_key, raw).decode("utf-8")
        except CardProtocolError:
            text = raw.decode("utf-8")
        sub_card_doc = json.loads(text)
    except CardProtocolError as e:
        errors.append(
            VerificationError(stage=2, code=e.code, message=str(e))
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )
    except Exception as e:
        errors.append(
            VerificationError(
                stage=2, code="DECRYPTION_FAILED", message=str(e)
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )
    # The document must be this signer's: its recipient_pubkey is the signing key.
    recipient = sub_card_doc.get("recipient_pubkey")
    if not isinstance(recipient, str) or keccak256(_b64url_decode(recipient)) != signer_card:
        errors.append(
            VerificationError(
                stage=2,
                code="ADDRESS_BINDING_MISMATCH",
                message="sub-card document recipient_pubkey is not the signing key",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 5 & 6: binding checks on holder_primary_card and app_card
    holder_pubkey_bytes = _b64url_decode(sub_card_doc["holder_primary_card_pubkey"])
    holder_card_address = keccak256(holder_pubkey_bytes)
    if holder_card_address != sub_card_doc["holder_primary_card"]:
        errors.append(
            VerificationError(
                stage=2,
                code="ADDRESS_BINDING_MISMATCH",
                message="keccak256(holder_primary_card_pubkey) does not match holder_primary_card pointer",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    app_pubkey_bytes = _b64url_decode(sub_card_doc["app_card_pubkey"])
    app_card_address = keccak256(app_pubkey_bytes)
    if app_card_address != sub_card_doc["app_card"]:
        errors.append(
            VerificationError(
                stage=2,
                code="ADDRESS_BINDING_MISMATCH",
                message="keccak256(app_card_pubkey) does not match app_card pointer",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 7: derive master card content key
    master_content_key = hkdf_sha3_256(holder_pubkey_bytes, "card-content-v1")

    # Step 8: fetch and decrypt master card document
    master_card_entry = await rpc.get_card_entry(holder_card_address)
    if not master_card_entry or not master_card_entry.exists:
        errors.append(
            VerificationError(
                stage=2,
                code="CARD_NOT_FOUND",
                message=f"Master card not found: {holder_card_address}",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    master_card_doc: dict[str, Any]
    try:
        master_card_doc = await decrypt_card_head(master_card_entry.log_head_cid, master_content_key, ipfs)
    except CardProtocolError as e:
        errors.append(
            VerificationError(stage=2, code=e.code, message=str(e))
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )
    except Exception as e:
        errors.append(
            VerificationError(
                stage=2, code="DECRYPTION_FAILED", message=str(e)
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 9: confirm sub-card appears in master's active_subcards field
    active_subcards_array = master_card_doc.get("active_subcards") or []
    found_in_active_subcards = False
    for subcard_pubkey_b64 in active_subcards_array:
        try:
            subcard_pubkey_bytes = _b64url_decode(subcard_pubkey_b64)
            subcard_address = keccak256(subcard_pubkey_bytes)
            if subcard_address == signer_card:
                found_in_active_subcards = True
                break
        except Exception:
            continue
    if not found_in_active_subcards:
        errors.append(
            VerificationError(
                stage=2,
                code="SUB_CARD_NOT_IN_ACTIVE_DIRECTORY",
                message=f"Sub-card {signer_card} not found in master card's active_subcards directory",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 10: confirm sub-card appears in master's registrations (via on-chain SubCardEntry)
    sub_card_entry = await rpc.get_sub_card_entry(signer_card)
    if not sub_card_entry or sub_card_entry.master_card_address != holder_card_address:
        errors.append(
            VerificationError(
                stage=2,
                code="ADDRESS_BINDING_MISMATCH",
                message="Sub-card on-chain entry does not link to expected master card",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 11: verify master card holder's ML-DSA-44 signature on sub-card registration
    holder_signature = sub_card_doc["holder_signature"]
    sub_card_doc_without_holder_sig = {
        k: v for k, v in sub_card_doc.items() if k != "holder_signature"
    }
    holder_sig_bytes = _b64url_decode(holder_signature)
    sub_card_canonical = canonicalize(sub_card_doc_without_holder_sig)
    holder_sig_valid = ml_dsa44_verify(
        holder_pubkey_bytes, sub_card_canonical, holder_sig_bytes
    )
    if not holder_sig_valid:
        errors.append(
            VerificationError(
                stage=2,
                code="INVALID_HOLDER_SIGNATURE",
                message="Holder signature on sub-card document is invalid",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 12: check on-chain active status
    if not sub_card_entry.active:
        errors.append(
            VerificationError(
                stage=2,
                code="SUB_CARD_INACTIVE",
                message="Sub-card is not active on-chain",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 13: verify app_signature using app_card_pubkey
    app_signature = sub_card_doc["app_signature"]
    sub_card_doc_without_sigs = {
        k: v
        for k, v in sub_card_doc.items()
        if k not in ("holder_signature", "app_signature")
    }
    app_sig_bytes = _b64url_decode(app_signature)
    app_sig_canonical = canonicalize(sub_card_doc_without_sigs)
    app_sig_valid = ml_dsa44_verify(
        app_pubkey_bytes, app_sig_canonical, app_sig_bytes
    )
    if not app_sig_valid:
        errors.append(
            VerificationError(
                stage=2,
                code="INVALID_APP_SIGNATURE",
                message="App signature on sub-card document is invalid",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 14: [Planned] sub-card limitations enforcement
    # TODO: Check that the message payload conforms to all limitations in subCardDoc.limitations
    # (This requires passing the message payload through the verification pipeline)
    # See: protocol-objects.md §16, messaging_protocol.md §9-11, subcards.md §Limitations

    # Step 15: app_card chain walk — confirm app_card chains to appCertificationRoot
    #
    # We've now confirmed this signer IS a sub-card (valid bindings, valid holder and
    # app signatures, active on-chain registration) — this is the point at which the
    # chain walk would otherwise run. If this verifier instance was never configured
    # with an app_certification_root, that is a hard, loud failure rather than a
    # silent skip: a verifier scoped to primary-card-only use can omit this config,
    # but any sub-card signature it actually encounters must be rejected, not waved
    # through.
    if not config.app_certification_root:
        errors.append(
            VerificationError(
                stage=2,
                code="APP_CERTIFICATION_ROOT_NOT_CONFIGURED",
                message=(
                    "Sub-card signature encountered but VerifierConfig.app_certification_root "
                    "is not configured on this verifier instance"
                ),
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    app_cert_root = config.app_certification_root
    max_depth = config.max_chain_depth or 64

    app_card_content_key = hkdf_sha3_256(app_pubkey_bytes, "card-content-v1")
    app_card_entry = await rpc.get_card_entry(app_card_address)
    if not app_card_entry or not app_card_entry.exists:
        errors.append(
            VerificationError(
                stage=2,
                code="APP_CARD_CHAIN_NOT_TRUSTED",
                message=f"app_card {app_card_address} not found on-chain",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    app_card_doc: dict[str, Any]
    try:
        app_card_doc = await decrypt_card_head(app_card_entry.log_head_cid, app_card_content_key, ipfs)
    except CardProtocolError as e:
        errors.append(
            VerificationError(stage=2, code=e.code, message=str(e))
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )
    except Exception as e:
        errors.append(
            VerificationError(
                stage=2, code="DECRYPTION_FAILED", message=str(e)
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    current_doc = app_card_doc
    current_address = app_card_address
    # Every address on the app card's chain below the root, for step 16f.
    visited: list[str] = [app_card_address]
    chain_reached = current_address == app_cert_root

    for depth in range(max_depth):
        if chain_reached:
            break

        if len(current_doc.get("ancestry_pubkeys", [])) == 0:
            chain_reached = current_address == app_cert_root
            break

        next_pubkey_b64 = current_doc["ancestry_pubkeys"][0]
        if not next_pubkey_b64:
            break

        next_pubkey_bytes = _b64url_decode(next_pubkey_b64)
        next_address = keccak256(next_pubkey_bytes)

        if next_address == app_cert_root:
            chain_reached = True
            break
        visited.append(next_address)

        next_entry = await rpc.get_card_entry(next_address)
        if not next_entry or not next_entry.exists:
            errors.append(
                VerificationError(
                    stage=2,
                    code="APP_CARD_CHAIN_NOT_TRUSTED",
                    message=f"Ancestor app card not found on-chain: {next_address}",
                )
            )
            return Stage2Result(
                scope_clean=False,
                signer_card=signer_card,
                app_card_chain_valid=False,
                errors=errors,
            )

        next_content_key = hkdf_sha3_256(next_pubkey_bytes, "card-content-v1")
        try:
            current_doc = await decrypt_card_head(next_entry.log_head_cid, next_content_key, ipfs)
            current_address = next_address
        except CardProtocolError as e:
            errors.append(
                VerificationError(stage=2, code=e.code, message=str(e))
            )
            return Stage2Result(
                scope_clean=False,
                signer_card=signer_card,
                app_card_chain_valid=False,
                errors=errors,
            )
        except Exception as e:
            errors.append(
                VerificationError(
                    stage=2, code="DECRYPTION_FAILED", message=str(e)
                )
            )
            return Stage2Result(
                scope_clean=False,
                signer_card=signer_card,
                app_card_chain_valid=False,
                errors=errors,
            )

    if not chain_reached:
        errors.append(
            VerificationError(
                stage=2,
                code="APP_CARD_CHAIN_NOT_TRUSTED",
                message=f"app_card chain for {app_card_address} does not reach appCertificationRoot ({app_cert_root})",
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=False,
            errors=errors,
        )

    # Step 16f (card_verifier.md §7.2): branch and login service scope rule.
    # Recognizing the login service branch is mandatory once sub-cards are being
    # verified: without it, a login service card could pose as an app or wallet card.
    login_root = getattr(config, "login_service_certification_root", None)
    if not login_root:
        errors.append(
            VerificationError(
                stage=2,
                code="LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED",
                message=(
                    "Sub-card signature encountered but VerifierConfig.login_service_certification_root "
                    "is not configured on this verifier instance"
                ),
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=True,
            errors=errors,
        )
    is_login_service = login_root in visited
    app_card_branch: Literal["login_service", "other"] = "login_service" if is_login_service else "other"
    self_scoped = app_card_address == holder_card_address
    if is_login_service and not self_scoped:
        errors.append(
            VerificationError(
                stage=2,
                code="LOGIN_SERVICE_SCOPE",
                message=(
                    f"app_card {app_card_address} is a login service card but the sub-card's master is "
                    f"{holder_card_address}; a login service card may only authorize its own server cards"
                ),
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=True,
            app_card_branch=app_card_branch,
            errors=errors,
        )
    if sub_card_doc.get("attestation_level") == "S1" and not (is_login_service and self_scoped):
        errors.append(
            VerificationError(
                stage=2,
                code="ATTESTATION_LEVEL_INSUFFICIENT",
                message='attestation_level "S1" is accepted only on server cards (login service card as both app_card and holder)',
            )
        )
        return Stage2Result(
            scope_clean=False,
            signer_card=signer_card,
            app_card_chain_valid=True,
            app_card_branch=app_card_branch,
            errors=errors,
        )

    return Stage2Result(
        scope_clean=True,
        signer_card=signer_card,
        master_card_doc=master_card_doc,
        master_card_pubkey=holder_pubkey_bytes,
        app_card_chain_valid=True,
        app_card_branch=app_card_branch,
        sub_card_doc=sub_card_doc,
        errors=errors,
    )
