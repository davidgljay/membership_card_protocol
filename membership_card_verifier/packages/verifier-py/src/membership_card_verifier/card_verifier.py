import asyncio
import hashlib
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Literal, Optional

from .canonicalize import canonicalize
from .constants import PROTOCOL_VERSION_0_1
from .crypto import keccak256
from .errors import CardProtocolError
from .policy_match import evaluate_policy_match
from .stages.stage1 import verify_stage1
from .stages.stage2 import verify_stage2
from .stages.stage3 import verify_stage3
from .stages.stage4 import verify_stage4
from .stages.stage5 import verify_stage5
from .stages.stage6 import verify_stage6
from .types import (
    CardVerificationResult,
    ChainLink,
    EnvelopeVerificationResult,
    PolicyMatchResult,
    RevocationStatus,
    SignatureEntry,
    SignatureVerificationResult,
    VerificationError,
    VerifierConfig,
    VerifyCardOptions,
)
from .version import extract_protocol_version

_DEFAULTS = SimpleNamespace(
    trusted_roots=[],
    revocation_freshness_window_seconds=300,
    reject_stale_revocation=True,
    max_chain_depth=64,
    fetch_annotations=False,
    additional_annotators=[],
    return_chain=False,
)


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _unknown_revocation() -> RevocationStatus:
    return RevocationStatus(
        status="unknown", code=None, effective_date=None, data_freshness_seconds=0
    )


class CardVerifier:
    def __init__(self, config: VerifierConfig) -> None:
        if not config.rpc:
            raise CardProtocolError("MISSING_RPC_PROVIDER", "VerifierConfig.rpc is required")
        if not config.ipfs:
            raise CardProtocolError("MISSING_IPFS_PROVIDER", "VerifierConfig.ipfs is required")
        # app_certification_root is intentionally NOT required here — it is only
        # needed whenever this verifier instance actually encounters a sub-card
        # signature. Stage 2 hard-rejects with APP_CERTIFICATION_ROOT_NOT_CONFIGURED
        # at the point it would otherwise attempt the app-cert chain walk, if unset.
        self.config = SimpleNamespace(
            rpc=config.rpc,
            ipfs=config.ipfs,
            app_certification_root=config.app_certification_root,
            trusted_roots=(
                config.trusted_roots
                if config.trusted_roots is not None
                else list(_DEFAULTS.trusted_roots)
            ),
            revocation_freshness_window_seconds=(
                config.revocation_freshness_window_seconds
                if config.revocation_freshness_window_seconds is not None
                else _DEFAULTS.revocation_freshness_window_seconds
            ),
            reject_stale_revocation=(
                config.reject_stale_revocation
                if config.reject_stale_revocation is not None
                else _DEFAULTS.reject_stale_revocation
            ),
            max_chain_depth=(
                config.max_chain_depth
                if config.max_chain_depth is not None
                else _DEFAULTS.max_chain_depth
            ),
            registry_endpoint=config.registry_endpoint,
            fetch_annotations=(
                config.fetch_annotations
                if config.fetch_annotations is not None
                else _DEFAULTS.fetch_annotations
            ),
            additional_annotators=(
                config.additional_annotators
                if config.additional_annotators is not None
                else list(_DEFAULTS.additional_annotators)
            ),
            return_chain=(
                config.return_chain
                if config.return_chain is not None
                else _DEFAULTS.return_chain
            ),
            conditions=config.conditions,
        )

    async def verify_envelope(self, envelope: dict[str, Any]) -> EnvelopeVerificationResult:
        verified_at = _now_iso()
        payload = envelope["payload"]

        try:
            protocol_version = extract_protocol_version(payload)
        except CardProtocolError as e:
            raw = payload.get("protocol_version")
            ver = raw if isinstance(raw, str) else "unknown"
            early_policy_match = evaluate_policy_match([], self.config.conditions)
            early_signature = SignatureVerificationResult(
                signer_card="",
                signature_valid=False,
                scope_clean="skipped",
                chain_reaches_trusted_root="skipped",
                chain_card_addresses=[],
                app_card_chain_valid="skipped",
                revocation=_unknown_revocation(),
                was_valid_at_signing_time="skipped",
                is_currently_valid="skipped",
                log_updates=[],
                policy_compliant="skipped",
                policy_match=early_policy_match,
                press_subsequently_revoked=False,
                non_compliance_reported=False,
                addressed_to_verifier=False,
                errors=[VerificationError(stage=1, code=e.code, message=str(e))],
                annotations=[],
                **({"chain": []} if self.config.return_chain else {}),
            )
            return EnvelopeVerificationResult(
                envelope_id="",
                verified_at=verified_at,
                protocol_version=ver,
                signatures=[early_signature],
                policy_match=self._aggregate_envelope_policy_match([early_signature]),
            )

        canonical_envelope = canonicalize(envelope)
        envelope_id = hashlib.sha256(canonical_envelope).hexdigest()

        signatures = await asyncio.gather(
            *(
                self._verify_signature_entry(entry, payload, payload["timestamp"])
                for entry in envelope["signatures"]
            )
        )

        return EnvelopeVerificationResult(
            envelope_id=envelope_id,
            verified_at=verified_at,
            protocol_version=protocol_version,
            signatures=list(signatures),
            policy_match=self._aggregate_envelope_policy_match(list(signatures)),
        )

    async def verify_card(
        self, card_address: str, options: Optional[VerifyCardOptions] = None
    ) -> CardVerificationResult:
        signing_timestamp = (
            options.as_of if options is not None and options.as_of is not None else _now_iso()
        )
        errors: list[VerificationError] = []

        # Stage 1 is skipped for verify_card
        # Stage 2: fetch card entry and master card doc starting from the given address
        card_entry = await self.config.rpc.get_card_entry(card_address)
        if not card_entry or not card_entry.exists:
            return self._skipped_result(
                card_address,
                [
                    VerificationError(
                        stage=2, code="CARD_NOT_FOUND", message=f"Card not found: {card_address}"
                    )
                ],
            )

        # For verify_card, we skip the sub-card doc path and go straight to the chain walk.
        # We need the card's CardDocument to start the chain walk.
        # The card IS the "master" card — derive content key from recipient_pubkey (unknown here).
        # Per spec §6.2: Stage 2 is skipped (scope_clean: "skipped"), start from Stage 3 directly.
        # We still need a CardDocument to pass to Stage 3. We fetch log_head_cid from IPFS,
        # but we can't decrypt it without the pubkey. So we use a fallback: for verify_card,
        # scope_clean is "skipped" and we synthesize a minimal doc from on-chain data.
        # Stage 3 chain walk requires ancestry_pubkeys from the card doc, which means we
        # need the pubkey. For verify_card, we accept the chain walk starting from the card
        # directly — if the card itself is a trusted root, chain_reaches_trusted_root = true.

        is_trusted_root = card_address in self.config.trusted_roots or (
            await self.config.rpc.is_policy_authorizer(card_address)
        )

        # Stage 3 result: simplified chain for verify_card (can't walk without pubkey)
        chain_addresses = [card_address]

        # Stage 4: revocation check. verify_card has no pubkey, so no card_content can
        # ever be decrypted here — Stage 4 falls back to `revocation.status: "unknown"`
        # for this path (see card_verifier.md §7.4 "verify_card limitation").
        stage4 = await verify_stage4(
            [ChainLink(card_address=card_address, public_key="", card_content={})],
            signing_timestamp,
            self.config.rpc,
            self.config,
        )

        # Stage 6: annotations
        stage6 = await verify_stage6(
            chain_addresses, self.config.rpc, self.config.ipfs, self.config
        )

        all_errors = errors + stage4.errors + stage6.errors

        # verify_card cannot decrypt any CardDocument (no pubkey available for the given
        # address alone), so no chain data is ever resolved here — chain is always empty.
        chain: list[ChainLink] = []

        return CardVerificationResult(
            signer_card=card_address,
            signature_valid=None,
            protocol_version=PROTOCOL_VERSION_0_1,
            scope_clean="skipped",
            chain_reaches_trusted_root=is_trusted_root,
            chain_card_addresses=chain_addresses,
            app_card_chain_valid="skipped",
            revocation=stage4.revocation,
            was_valid_at_signing_time=stage4.was_valid_at_signing_time,
            is_currently_valid=stage4.is_currently_valid,
            log_updates=stage4.log_updates,
            policy_compliant="skipped",
            policy_match=evaluate_policy_match(chain, self.config.conditions),
            press_subsequently_revoked=False,
            non_compliance_reported=False,
            addressed_to_verifier=False,
            errors=all_errors,
            annotations=stage6.annotations,
            **({"chain": chain} if self.config.return_chain else {}),
        )

    async def _verify_signature_entry(
        self,
        entry: dict[str, Any],
        payload: dict[str, Any],
        signing_timestamp: str,
    ) -> SignatureVerificationResult:
        errors: list[VerificationError] = []

        # Stage 1 — CardProtocolError from invalid key/signature length propagates uncaught,
        # matching the JS implementation's no-op try/catch that only rethrows.
        signature_entry = SignatureEntry(
            public_key=entry["public_key"],
            signature=entry["signature"],
            key_scheme=entry.get("key_scheme"),
        )
        s1 = verify_stage1(signature_entry, payload)
        public_key_bytes = s1.public_key_bytes
        signature_valid = s1.signature_valid

        signer_card = keccak256(public_key_bytes)

        # Stage 2
        stage2 = await verify_stage2(
            public_key_bytes,
            self.config.rpc,
            self.config.ipfs,
            SimpleNamespace(
                app_certification_root=self.config.app_certification_root,
                max_chain_depth=self.config.max_chain_depth,
            ),
        )
        errors.extend(stage2.errors)

        if stage2.scope_clean is False and not stage2.master_card_doc:
            # Hard rejection: skip stages 3-5. No CardDocument was ever resolved, so
            # there is no chain data to compute policy_match from beyond "not found".
            return self._build_result(
                signer_card,
                signature_valid,
                stage2.scope_clean,
                "skipped",
                stage2.app_card_chain_valid,
                errors,
                revocation=_unknown_revocation(),
                was_valid_at_signing_time="skipped",
                is_currently_valid="skipped",
                log_updates=[],
                policy_compliant="skipped",
                chain=[],
            )

        # Stage 3
        # The walk starts from the master card's own document, so it must also start from
        # the master card's own address — not stage2.signer_card, which identifies the
        # sub-card that actually signed (used below for the result's signer_card field).
        # A sub-card has no ancestry of its own; only the master does.
        assert stage2.master_card_doc is not None
        start_doc = stage2.master_card_doc
        start_pubkey = stage2.master_card_pubkey
        assert start_pubkey is not None
        start_address = keccak256(start_pubkey)
        stage3 = await verify_stage3(
            start_doc, start_address, self.config.rpc, self.config.ipfs, self.config, start_pubkey
        )
        errors.extend(stage3.errors)

        if stage3.chain_reaches_trusted_root is False and any(
            e.code in ("DECRYPTION_FAILED", "ADDRESS_BINDING_MISMATCH") for e in stage3.errors
        ):
            # Hard rejection mid-chain: skip stages 4-5. stage3.chain is partial (as far as
            # the walk got before the failure) — still exposed/used per the plan's decision
            # to keep partial chains rather than discard them.
            return self._build_result(
                signer_card,
                signature_valid,
                stage2.scope_clean,
                stage3.chain_reaches_trusted_root,
                stage2.app_card_chain_valid,
                errors,
                revocation=_unknown_revocation(),
                was_valid_at_signing_time="skipped",
                is_currently_valid="skipped",
                log_updates=[],
                policy_compliant="skipped",
                chain=stage3.chain,
            )

        # Stage 4. Reuses Stage 3's already-fetched-and-decrypted `chain` (no second
        # IPFS fetch pass) — see stage4.py's doc comment for how content + the
        # on-chain event-log replay are combined.
        stage4 = await verify_stage4(
            stage3.chain, signing_timestamp, self.config.rpc, self.config
        )
        errors.extend(stage4.errors)

        # Stage 5
        card_entry = await self.config.rpc.get_card_entry(signer_card)
        policy_compliant: bool | None | Literal["skipped"] = "skipped"
        press_subsequently_revoked = False
        non_compliance_reported = False

        if card_entry and card_entry.exists:
            raw_bytes = await self.config.ipfs.fetch(card_entry.log_head_cid)
            stage5 = await verify_stage5(
                start_doc,
                card_entry,
                signer_card,
                card_entry.log_head_cid,
                raw_bytes,
                self.config.rpc,
                self.config.ipfs,
                SimpleNamespace(registry_endpoint=self.config.registry_endpoint),
            )
            errors.extend(stage5.errors)
            policy_compliant = stage5.policy_compliant
            press_subsequently_revoked = stage5.press_subsequently_revoked
            non_compliance_reported = stage5.non_compliance_reported

        # policy_match: computed from Stage 3's already-walked chain data (Task 1) —
        # no second chain walk or IPFS fetch pass, per the plan's "avoid reproducing
        # logic" decision. Computed regardless of `return_chain`, which only controls
        # whether the chain itself is exposed on the result.
        policy_match = evaluate_policy_match(stage3.chain, self.config.conditions)

        # Stage 6
        stage6 = await verify_stage6(
            stage3.chain_card_addresses, self.config.rpc, self.config.ipfs, self.config
        )
        errors.extend(stage6.errors)

        return SignatureVerificationResult(
            signer_card=signer_card,
            signature_valid=signature_valid,
            scope_clean=stage2.scope_clean,
            chain_reaches_trusted_root=stage3.chain_reaches_trusted_root,
            chain_card_addresses=stage3.chain_card_addresses,
            app_card_chain_valid=stage2.app_card_chain_valid,
            revocation=stage4.revocation,
            was_valid_at_signing_time=stage4.was_valid_at_signing_time,
            is_currently_valid=stage4.is_currently_valid,
            log_updates=stage4.log_updates,
            policy_compliant=policy_compliant,
            policy_match=policy_match,
            press_subsequently_revoked=press_subsequently_revoked,
            non_compliance_reported=non_compliance_reported,
            addressed_to_verifier=False,
            errors=errors,
            annotations=stage6.annotations,
            **({"chain": stage3.chain} if self.config.return_chain else {}),
        )

    def _build_result(
        self,
        signer_card: str,
        signature_valid: bool,
        scope_clean: bool | Literal["skipped"],
        chain_reaches_trusted_root: bool | Literal["skipped"],
        app_card_chain_valid: bool | Literal["skipped"],
        errors: list[VerificationError],
        *,
        revocation: RevocationStatus,
        was_valid_at_signing_time: bool | Literal["skipped"],
        is_currently_valid: bool | Literal["skipped"],
        log_updates: list[Any],
        policy_compliant: bool | None | Literal["skipped"],
        chain: list[ChainLink],
    ) -> SignatureVerificationResult:
        return SignatureVerificationResult(
            signer_card=signer_card,
            signature_valid=signature_valid,
            scope_clean=scope_clean,
            chain_reaches_trusted_root=chain_reaches_trusted_root,
            chain_card_addresses=[link.card_address for link in chain],
            app_card_chain_valid=app_card_chain_valid,
            revocation=revocation,
            was_valid_at_signing_time=was_valid_at_signing_time,
            is_currently_valid=is_currently_valid,
            log_updates=log_updates,
            policy_compliant=policy_compliant,
            policy_match=evaluate_policy_match(chain, self.config.conditions),
            press_subsequently_revoked=False,
            non_compliance_reported=False,
            addressed_to_verifier=False,
            errors=errors,
            annotations=[],
            **({"chain": chain} if self.config.return_chain else {}),
        )

    def _skipped_result(
        self, card_address: str, errors: list[VerificationError]
    ) -> CardVerificationResult:
        return CardVerificationResult(
            signer_card=card_address,
            signature_valid=None,
            protocol_version=PROTOCOL_VERSION_0_1,
            scope_clean="skipped",
            chain_reaches_trusted_root="skipped",
            chain_card_addresses=[],
            app_card_chain_valid="skipped",
            revocation=_unknown_revocation(),
            was_valid_at_signing_time="skipped",
            is_currently_valid="skipped",
            log_updates=[],
            policy_compliant="skipped",
            policy_match=evaluate_policy_match([], self.config.conditions),
            press_subsequently_revoked=False,
            non_compliance_reported=False,
            addressed_to_verifier=False,
            errors=errors,
            annotations=[],
            **({"chain": []} if self.config.return_chain else {}),
        )

    def _aggregate_envelope_policy_match(
        self, signatures: list[SignatureVerificationResult]
    ) -> Optional[PolicyMatchResult]:
        """Aggregates policy_match across signatures as an OR on `matched`; when
        none matched, prefers surfacing `field_mismatch` over `no_policy_match`
        if any signature saw one, since it's the more specific/informative
        reason."""
        if not self.config.conditions:
            return None
        if any(s.policy_match is not None and s.policy_match.matched for s in signatures):
            return PolicyMatchResult(matched=True)
        any_field_mismatch = any(
            s.policy_match is not None and s.policy_match.reason == "field_mismatch"
            for s in signatures
        )
        return PolicyMatchResult(
            matched=False,
            reason="field_mismatch" if any_field_mismatch else "no_policy_match",
        )
