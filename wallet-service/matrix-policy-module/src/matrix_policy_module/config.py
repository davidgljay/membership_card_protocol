"""Typed config for the `modules:` block in homeserver.yaml.

Schema per specs/object_specs/matrix_synapse_module.md (2026-07-11 version).
`card_cache_ttl_seconds`, `wallet_service_internal_url`, and
`wallet_service_module_shared_secret` are deliberately not fields here — they
were removed from scope on 2026-07-11 along with the TTL cache and the
wallet-service resolver call.
"""

from __future__ import annotations

from dataclasses import dataclass

_REQUIRED_KEYS = (
    "arbitrum_rpc_url",
    "arbitrum_rpc_ws_url",
    "registry_contract_address",
    "ipfs_gateway_url",
    "matrix_server_name",
    "membership_registry_path",
    "membership_registry_key_path",
    # Added 2026-07-12 — the watcher's force-part sender (Step 7d). Not a
    # secret (no token exists for this — see watcher.py's module docstring),
    # just an identifier: the Matrix user ID of the account Step 16 grants
    # kick-level power in every card-gated room it creates.
    "enforcement_matrix_user_id",
)


class ConfigError(ValueError):
    """Raised when the module's config block is missing or malformed.

    Synapse module init lets this propagate to fail startup loudly, matching
    the deny-by-default posture of the rest of the module (matrix_synapse_module.md).
    """


@dataclass(frozen=True)
class PolicyModuleConfig:
    arbitrum_rpc_url: str
    arbitrum_rpc_ws_url: str
    registry_contract_address: str
    ipfs_gateway_url: str
    matrix_server_name: str
    membership_registry_path: str
    membership_registry_key_path: str
    enforcement_matrix_user_id: str
    join_attestation_freshness_seconds: int = 300
    watcher_backstop_interval_seconds: int = 3600

    @classmethod
    def parse(cls, raw: dict) -> "PolicyModuleConfig":
        missing = [key for key in _REQUIRED_KEYS if not raw.get(key)]
        if missing:
            raise ConfigError(
                f"matrix_policy_module config is missing required key(s): {', '.join(missing)}"
            )
        return cls(
            arbitrum_rpc_url=raw["arbitrum_rpc_url"],
            arbitrum_rpc_ws_url=raw["arbitrum_rpc_ws_url"],
            registry_contract_address=raw["registry_contract_address"],
            ipfs_gateway_url=raw["ipfs_gateway_url"],
            matrix_server_name=raw["matrix_server_name"],
            membership_registry_path=raw["membership_registry_path"],
            membership_registry_key_path=raw["membership_registry_key_path"],
            enforcement_matrix_user_id=raw["enforcement_matrix_user_id"],
            join_attestation_freshness_seconds=int(
                raw.get("join_attestation_freshness_seconds", 300)
            ),
            watcher_backstop_interval_seconds=int(
                raw.get("watcher_backstop_interval_seconds", 3600)
            ),
        )
