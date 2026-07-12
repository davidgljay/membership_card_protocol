import base64
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import httpx

from membership_card_verifier.constants import PRESS_REGISTRY_BODY_ENDPOINT
from membership_card_verifier.types import (
    CardEntry,
    FailedCheck,
    IpfsProvider,
    NonComplianceReport,
    RpcProvider,
    VerificationError,
)


@dataclass
class Stage5Result:
    policy_compliant: bool | None | Literal["skipped"]
    policy_match: Optional[bool]
    press_subsequently_revoked: bool
    non_compliance_reported: bool
    errors: list[VerificationError]


async def verify_stage5(
    card_doc: dict[str, Any],
    card_entry: CardEntry,
    card_address: str,
    card_cid: str,
    raw_card_bytes: bytes,
    rpc: RpcProvider,
    ipfs: IpfsProvider,
    config: Any,
) -> Stage5Result:
    errors: list[VerificationError] = []
    failed_checks: list[FailedCheck] = []

    # Step 1: fetch policy snapshot at the immutable policy_id CID
    policy_doc: dict[str, Any]
    try:
        policy_bytes = await ipfs.fetch(card_doc["policy_id"])
        policy_doc = json.loads(policy_bytes.decode("utf-8"))
    except Exception:
        errors.append(
            VerificationError(
                stage=5,
                code="POLICY_FETCH_FAILED",
                message="Could not fetch policy snapshot",
            )
        )
        return Stage5Result(
            policy_compliant=None,
            policy_match=None,
            press_subsequently_revoked=False,
            non_compliance_reported=False,
            errors=errors,
        )

    # Step 2: evaluate card field values against field_definitions
    field_definitions = policy_doc.get("field_definitions", {})
    for field_name, def_ in field_definitions.items():
        if def_.get("required") and field_name not in card_doc:
            failed_checks.append(
                FailedCheck(
                    check="FIELD_POLICY_VIOLATION",
                    field=field_name,
                    detail=f'Required field "{field_name}" is missing',
                )
            )

    # Step 3: check press authorization on-chain
    press_entry = await rpc.get_press_authorization(
        card_entry.policy_address, card_entry.last_press_address
    )

    press_subsequently_revoked = False
    if not press_entry:
        failed_checks.append(
            FailedCheck(
                check="NO_PRESS_AUTHORIZATION",
                detail=f"No press authorization found for policy={card_entry.policy_address} press={card_entry.last_press_address}",
            )
        )
    elif not press_entry.active:
        press_subsequently_revoked = True

    policy_compliant = len(failed_checks) == 0

    # Step 5: non-compliance reporting
    non_compliance_reported = False
    if not policy_compliant:
        ipfs_card_document = (
            base64.urlsafe_b64encode(raw_card_bytes).decode("ascii").rstrip("=")
        )
        verified_at = (
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        )

        report = NonComplianceReport(
            card_address=card_address,
            press_address=card_entry.last_press_address,
            ipfs_card_document=ipfs_card_document,
            ipfs_cid=card_cid,
            failed_checks=failed_checks,
            verified_at=verified_at,
        )

        endpoint = config.registry_endpoint or PRESS_REGISTRY_BODY_ENDPOINT
        try:
            async with httpx.AsyncClient() as client:
                res = await client.post(
                    f"{endpoint}/non-compliance",
                    json=asdict(report),
                )
            non_compliance_reported = res.is_success
            if not res.is_success:
                errors.append(
                    VerificationError(
                        stage=5,
                        code="NON_COMPLIANCE_REPORT_FAILED",
                        message=f"Registry Body returned HTTP {res.status_code}",
                    )
                )
        except Exception as e:
            errors.append(
                VerificationError(
                    stage=5,
                    code="NON_COMPLIANCE_REPORT_FAILED",
                    message=f"Failed to POST non-compliance report: {e}",
                )
            )

    return Stage5Result(
        policy_compliant=policy_compliant,
        policy_match=None,
        press_subsequently_revoked=press_subsequently_revoked,
        non_compliance_reported=non_compliance_reported,
        errors=errors,
    )
