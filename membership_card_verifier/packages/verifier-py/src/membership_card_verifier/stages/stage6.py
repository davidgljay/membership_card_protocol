import asyncio
import json
from dataclasses import dataclass

import httpx

from membership_card_verifier.constants import RECOMMENDED_ANNOTATORS_ENDPOINT
from membership_card_verifier.types import (
    EasAnnotation,
    IpfsProvider,
    RpcProvider,
    VerificationError,
)


@dataclass
class Stage6Result:
    annotations: list[EasAnnotation]
    errors: list[VerificationError]


async def verify_stage6(
    chain_card_addresses: list[str],
    rpc: RpcProvider,
    ipfs: IpfsProvider,
    config,
) -> Stage6Result:
    if not config.fetch_annotations:
        return Stage6Result(annotations=[], errors=[])

    errors: list[VerificationError] = []

    # Step 1: fetch recommended annotators list
    recommended_annotators: list[str] = []
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(RECOMMENDED_ANNOTATORS_ENDPOINT)
        if res.is_success:
            recommended_annotators = res.json()
        else:
            errors.append(
                VerificationError(
                    stage=6,
                    code="RECOMMENDED_ANNOTATORS_FETCH_FAILED",
                    message=f"Annotators endpoint returned HTTP {res.status_code}",
                )
            )
    except Exception as e:
        errors.append(
            VerificationError(
                stage=6,
                code="RECOMMENDED_ANNOTATORS_FETCH_FAILED",
                message=f"Failed to fetch recommended annotators: {e}",
            )
        )

    # Step 2: merge with additionalAnnotators
    additional_annotators = config.additional_annotators or []
    active_annotator_set = list(
        dict.fromkeys([*recommended_annotators, *additional_annotators])
    )

    if len(active_annotator_set) == 0:
        return Stage6Result(annotations=[], errors=errors)

    # Step 3: fetch EAS attestations for all cards in chain
    all_attestations = await asyncio.gather(
        *(rpc.get_eas_annotations(addr, active_annotator_set) for addr in chain_card_addresses)
    )
    attestations = [a for sublist in all_attestations for a in sublist]

    # Step 4: process each attestation
    annotations: list[EasAnnotation] = []
    for attest in attestations:
        # Fetch and decode annotation content document from IPFS
        # TODO: clarify whether annotation documents are encrypted once spec is finalized.
        # Currently treating them as plaintext public IPFS content.
        try:
            content_bytes = await ipfs.fetch(attest.cid)
            content = json.loads(content_bytes.decode("utf-8"))
        except Exception as e:
            errors.append(
                VerificationError(
                    stage=6,
                    code="ANNOTATION_FETCH_FAILED",
                    message=f"Failed to fetch annotation {attest.uid}: {e}",
                )
            )
            continue

        # Walk annotator's chain to check if it reaches a trusted root
        # Derive annotator's card address and fetch their card doc for chain walk
        annotator_chain_trusted = False
        try:
            annotator_entry = await rpc.get_card_entry(attest.attester)
            if annotator_entry is not None and annotator_entry.exists:
                # Minimal chain walk: just check if the annotator card's address is itself trusted
                annotator_chain_trusted = (
                    attest.attester in (config.trusted_roots or [])
                ) or (await rpc.is_policy_authorizer(attest.attester))

                if not annotator_chain_trusted and annotator_entry.log_head_cid:
                    # Attempt to walk the annotator's chain using stage3 logic.
                    # We need the annotator's card doc, but we don't have the pubkey to decrypt it here.
                    # The annotator's address is derived from their pubkey via keccak256, but we don't
                    # have the pubkey stored anywhere without decrypting their card.
                    # For now, mark as not trusted unless directly in trusted roots or PolicyAuthorizerKeys.
                    # TODO: full chain walk requires annotator pubkey — needs spec clarification.
                    annotator_chain_trusted = False
        except Exception as e:
            errors.append(
                VerificationError(
                    stage=6,
                    code="ANNOTATOR_CHAIN_WALK_FAILED",
                    message=f"Failed to walk annotator chain for {attest.attester}: {e}",
                )
            )

        annotations.append(
            EasAnnotation(
                eas_uid=attest.uid,
                annotator_card=attest.attester,
                annotator_chain_trusted=annotator_chain_trusted,
                is_recommended_annotator=attest.attester in recommended_annotators,
                update_code=attest.update_code,
                cid=attest.cid,
                content=content,
                effective_date=attest.effective_date,
            )
        )

    return Stage6Result(annotations=annotations, errors=errors)
