# Matrix Synapse Policy Module — Object Spec

**Version:** 0.2 (draft)
**Date:** 2026-07-10 (amended 2026-07-11)
**Status:** Draft
**Targets:** Synapse's Module API **Spam Checker Callbacks** category, current as of the Synapse release line documented at `element-hq.github.io/synapse/latest/modules/spam_checker_callbacks.html` (confirmed live 2026-07-10; that page documents callback changes as recent as Synapse v1.133.0, so this spec targets a Synapse version at or above that line — `wallet-service/matrix/Dockerfile`, per Step 5, pins `matrixdotorg/synapse:latest`, so re-confirm these callback names against the pinned image's actual version at build time rather than assuming they remain stable indefinitely).
**Companion documents:** `specs/object_specs/matrix_room.md`, `specs/process_specs/matrix_room_membership.md`, `specs/process_specs/matrix_join_attestation_and_revocation.md`

**Amended 2026-07-11:** `wallet_service_internal_url` / `wallet_service_module_shared_secret` and `binding_client.py` are removed per `matrix_join_attestation_and_revocation.md`, which replaces the live wallet-service resolver call with a client-presented signed attestation. New config and a new watcher component are added for the event-driven revocation model — see §Module Config Schema and §Module Package Layout below.

---

## Callback Selection

Synapse exposes two overlapping event-authorization mechanisms: the older, explicitly experimental **Third-Party Rules** category (`check_event_allowed`) and the **Spam Checker** category (`check_event_for_spam`, `user_may_join_room`). Synapse's own module documentation states `check_event_allowed` "is very experimental and can and will break without notice," and directs module developers to `check_event_for_spam` instead. This module therefore uses the **Spam Checker** callbacks, not `check_event_allowed`, reversing the implementation plan's original assumption (which named `check_event_allowed` as a candidate) based on this doc check.

### `user_may_join_room` — join authorization

```python
async def user_may_join_room(
    user: str,
    room: str,
    is_invited: bool,
) -> Union["synapse.module_api.NOT_SPAM", "synapse.module_api.errors.Codes", bool]
```

- `user` — the joining Matrix user ID (a shadow-account ID; the module resolves `card_hash` from this via a private call to `wallet-service`'s card-binding resolver, **not** by computation — the shadow-account derivation is a one-way commitment with no inverse, see `matrix_encryption.md §3` and `matrix_room_membership.md §1`).
- `room` — the room ID being joined.
- `is_invited` — whether the user currently holds a pending invite. The policy module ignores this distinction: card-gated rooms are evaluated the same way whether the joiner was invited or is joining an open/discoverable room — an invite does not bypass the predicate.
- **Return `synapse.module_api.NOT_SPAM`** to allow the join, or a `synapse.module_api.errors.Codes` value (e.g. `Codes.FORBIDDEN`) to deny it. The module does not use the deprecated bare-boolean return form.
- **Known limitation, stated in Synapse's own docs and inherited here:** this callback is *not* called for joins performed by a server administrator, or in the context of room creation (the creator's own auto-join). The room-creation flow (`matrix_room.md §Room Creation`) therefore does not rely on this callback to authorize the creator's own join — the creator is trusted to have a valid card by virtue of having authenticated to `wallet-service` and provisioned their shadow account through the Application Service bridge, per `matrix_room_membership.md`'s framing of what is and isn't in the module's authority.

### `check_event_for_spam` — post authorization (every message)

```python
async def check_event_for_spam(
    event: "synapse.module_api.EventBase",
) -> Union["synapse.module_api.NOT_SPAM", "synapse.module_api.errors.Codes", str, bool]
```

- `event` — the incoming event, prior to persistence. The module reads `event.sender` (a shadow-account Matrix user ID) and `event.room_id`.
- The module only applies its card-policy check to events in rooms that carry an `m.card.policy` state event; for any other room (there should be none, in this deployment, since all rooms this module manages are created via `POST /matrix/rooms` — but the module must not assume that invariant blindly) the callback returns `NOT_SPAM` unconditionally, deferring to Synapse's normal event-auth.
- For a room with an `m.card.policy` state event, the module runs the full post sequence from `matrix_room_membership.md §2` and **returns `synapse.module_api.errors.Codes.FORBIDDEN` on any deny path (predicate false, or any failure-mode deny per `matrix_room_membership.md §4`), and `NOT_SPAM` otherwise.** The module does not use the deprecated string/boolean return forms.
- **This callback is invoked per event, on every message** — this is exactly the mechanism `matrix_room_membership.md §2` relies on to make revocation enforcement work without a separate polling loop.

Room state events (`m.room.name`, `m.room.topic`, `m.room.encryption`, and `m.card.policy` itself) also pass through `check_event_for_spam`. The module's card-policy check applies only to `m.room.message` (and other content-bearing message-like event types); state events are passed through to `NOT_SPAM` provided their sender already holds current room membership (state-event authorship authorization is otherwise handled by Synapse's own room-power-level model, which this module does not touch).

---

## Module Config Schema

Configured under `modules:` in `homeserver.yaml`:

```yaml
modules:
  - module: "matrix_policy_module.module.PolicyModule"
    config:
      arbitrum_rpc_url: "${ARBITRUM_RPC_URL}"
      arbitrum_rpc_ws_url: "${ARBITRUM_RPC_WS_URL}"
      registry_contract_address: "${REGISTRY_CONTRACT_ADDRESS}"
      ipfs_gateway_url: "${IPFS_GATEWAY_URL}"
      matrix_server_name: "${MATRIX_SERVER_NAME}"
      join_attestation_freshness_seconds: 300
      watcher_backstop_interval_seconds: 3600
      membership_registry_path: "${MATRIX_MEMBERSHIP_REGISTRY_PATH}"
      membership_registry_key_path: "${MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH}"
```

| Key | Type | Required | Notes |
|---|---|---|---|
| `membership_registry_path` | string (filesystem path) | Yes | Path to the encrypted, persistent membership registry file (`(room_id, matrix_user_id, card_hash, joined_at)`, per `matrix_join_attestation_and_revocation.md §2a`) — a SQLite file (or equivalent) on a volume distinct from Synapse's own Postgres. |
| `membership_registry_key_path` | string (filesystem path) | Yes | **Corrected 2026-07-11 — was previously (incorrectly) described as "not a config value, obtained from the secrets abstraction."** That phrasing didn't survive contact with the actual cross-language mechanics: the module is a Python process with no way to call wallet-service's TypeScript `SecretsService.decryptSecret` to unwrap a DEK at its own startup, the same problem the Synapse signing key and watcher credential already had (Steps 7/7b). The resolution used for all of these uniformly (`wallet-service/scripts/generate-matrix-secrets.ts`): the raw key is generated once, written to a gitignored, volume-mounted file, and the module reads it directly at startup via this path — an audit-trail copy is *separately* kept in wallet-service's `matrix_credentials` table via the normal secrets abstraction, but that copy is recovery/rotation bookkeeping only, not part of the module's runtime boot path. |
| `arbitrum_rpc_url` | string (URL) | Yes | Read-only Arbitrum RPC endpoint (HTTP), used for one-off chain-walk fetches triggered by an event or the backstop re-walk. Mirrors `wallet-service`'s `ARBITRUM_RPC_URL` (`wallet-service/src/config.ts`) — same value, same network, so the module and `wallet-service` observe identical on-chain state. |
| `arbitrum_rpc_ws_url` | string (URL) | Yes | WebSocket (or other push-capable) endpoint used by the watcher daemon (`matrix_join_attestation_and_revocation.md §3.1`) for the persistent `CardHeadUpdated` subscription. May point at a different provider than `arbitrum_rpc_url` if the HTTP and WS endpoints are split, but must observe the same network/contract. See that document's open item on self-hosted vs. third-party RPC for this endpoint specifically — the subscription filter list is a standing exposure of the server's full membership graph to whichever provider serves it. |
| `registry_contract_address` | string (address) | Yes | Mirrors `wallet-service`'s `REGISTRY_CONTRACT_ADDRESS`. Also the address the watcher subscribes against — per `registry_contract.md §7`, events are emitted by the **logic** contract, which is upgradeable; the watcher must re-point its subscription on `LogicUpgradeConfirmed`, same caveat other event consumers of this contract already have to handle. |
| `ipfs_gateway_url` | string (URL) | Yes | Mirrors `wallet-service`'s `IPFS_GATEWAY_URL`. |
| `matrix_server_name` | string | Yes | The homeserver's own domain, passed to `verifyMatrixUserIdBinding` (`matrix_encryption.md §3`) both for join-attestation verification (`matrix_join_attestation_and_revocation.md §2` step 4) and, unchanged, for any other forward-verification the module performs. |
| `join_attestation_freshness_seconds` | integer | No, default `300` | Maximum age of a join attestation's `payload.timestamp` before the module rejects it as stale (`matrix_join_attestation_and_revocation.md §1`). |
| `watcher_backstop_interval_seconds` | integer | No, default `3600` | Interval for the watcher's coarse backstop re-walk of the full watch-set, independent of events (`matrix_join_attestation_and_revocation.md §3.3`) — a correctness floor, not the primary detection path. |

~~`card_cache_ttl_seconds`~~, ~~`wallet_service_internal_url`~~, and ~~`wallet_service_module_shared_secret`~~ are **removed** (superseded 2026-07-11) — the TTL cache and the wallet-service resolver dependency they configured no longer exist; see `matrix_join_attestation_and_revocation.md`.

`membership_registry_path` is **new** (2026-07-11, resolved during Phase 1 review) — the membership registry (needed both for watch-set reference counting, Step 12a, and post-time identity resolution, `matrix_join_attestation_and_revocation.md §2a`) is persisted and encrypted at rest, not held in process memory only, so it survives a container restart without forcing every current room member to rejoin.

**Corrected 2026-07-11 (Phase 2 review) — this section previously claimed "Synapse substitutes `${VAR}` from the process environment when parsing `homeserver.yaml` (standard Synapse config templating)." That is false.** Verified against Synapse's own docs and issue tracker (e.g. `matrix-org/synapse#11489`, `#7758`): general `${VAR}`-style substitution in arbitrary config keys is a long-requested, never-shipped feature, not something Synapse actually does. The only env-var templating the official docker image performs natively is a narrow, fixed set of values applied during its own `--generate-config` first-run flow — irrelevant here, since this deployment supplies its own custom `homeserver.yaml` (with the `modules:` block that flow doesn't know about) rather than using generate-config. Docker Compose's own `${VAR}` substitution doesn't reach this either — it only resolves variables inside `docker-compose.yml` itself, not inside the contents of a file it bind-mounts.

**Actual mechanism:** the `${VAR}` placeholders shown above live in `wallet-service/matrix/homeserver.yaml.template` (committed to git). `wallet-service/scripts/render-matrix-config.ts` renders the real, concrete `wallet-service/matrix/homeserver.yaml` (gitignored) from that template by substituting each `${VAR_NAME}` with `process.env.VAR_NAME`, failing fast (same convention as `src/config.ts`) if a referenced variable is missing. This script must be run once — alongside `scripts/generate-matrix-secrets.ts` — before `docker compose up synapse`, and re-run after any change to the template or the env vars it references. The chain/IPFS values above are still read from the **same** environment variables already defined for `wallet-service` (`ARBITRUM_RPC_URL`, `REGISTRY_CONTRACT_ADDRESS`, `IPFS_GATEWAY_URL`), so the two components cannot silently drift onto different RPC/IPFS endpoints or contract addresses — that property holds regardless of which component performs the substitution. `ARBITRUM_RPC_WS_URL` is new and does not mirror an existing `wallet-service` variable, since `wallet-service` has no equivalent standing-subscription need today.

`config.py` (Step 8) parses this block into a typed dataclass at module load time and fails Synapse startup loudly (raises during module init) if any required key is missing or malformed — consistent with the deny-by-default posture of the rest of this module; a module that can't confirm its own config is correct must not silently start up in some partially-configured state.

---

## Module Package Layout

**Revised 2026-07-11 (Phase 3 planning) — this module now depends on `membership-card-verifier`, a Python port of `@membership-card-protocol/verifier`, rather than hand-porting card verification/chain-walk logic itself.** The port is behaviorally identical to the JS package (same six-stage pipeline, same result shapes, same error codes) and is validated against shared cross-language interop vectors as part of its own test suite — the drift risk that originally made "port the chain walk" the highest-risk step in this plan is the verifier package's responsibility to manage, not something this module's own tests need to re-establish from scratch. See `plans/matrix-implementation-plan.md`'s revised Steps 9/10 for what changed and why.

```
matrix-policy-module/
  pyproject.toml       — package metadata; deps: membership-card-verifier (path or git dependency until PyPI publish approval lands — see below), web3 (for the RpcProvider adapter and the watcher's WS subscription, which the verifier package doesn't cover), httpx (for the IpfsProvider adapter); synapse as a type-check-only dev dependency
  src/
    matrix_policy_module/
      __init__.py
      module.py         — PolicyModule class; registers user_may_join_room and check_event_for_spam
      config.py         — typed config dataclass; parses the modules: config block above
      rpc_provider.py    — implements membership_card_verifier.RpcProvider's async methods (Step 9a) against the registry contract via web3.py; also exposes a separate WS-subscription interface for the watcher's CardHeadUpdated needs, which is genuinely new code — RpcProvider has no concept of event subscriptions, only point reads
      ipfs_provider.py    — implements membership_card_verifier.IpfsProvider's single `async def fetch(cid) -> bytes` (Step 9b) via httpx — much smaller than a from-scratch IPFS client, since the package handles everything past the raw bytes
      predicates.py      — the room-predicate-document evaluator (Step 9c): `any_of`/`issued_under_template`/`card_field_matches` over `matrix_room.md`'s fixed schema, evaluated against the verifier package's result types (`CardVerificationResult`/`SignatureVerificationResult` — real field names: `chain_reaches_trusted_root`, `revocation.status`, etc.) plus the chain address list from `chain_context.py` below
      chain_context.py   — (renamed from `chain_walk.py`, Step 10) a thin wrapper: builds a `VerifierConfig` from this module's config, calls `CardVerifier.verify_envelope()` (join attestations, which are already `SignedMessageEnvelope`-shaped per `matrix_join_attestation_and_revocation.md §1`) or `verify_card()` (post-time re-checks against a bare address) as appropriate. **Open item, not resolved by this spec:** the verifier package's public result types expose `chain_reaches_trusted_root` (a bool) but not the underlying `chain_card_addresses` list — needed here for `chain_includes`/`card_field_matches` (which must check every card in the chain, not just whether it reaches a root) and for the watcher's watch-set construction (Step 11a). Until/unless the verifier package exposes this on its public result types (it's already computed internally by Stage 3 — an additive change, not a redesign), this module has to reach into `membership_card_verifier.stages.stage3` directly, which isn't part of the package's documented public API (`__init__.py`'s `__all__` doesn't include it).
      cache.py           — event-invalidated cache, keyed by address, storing whatever `chain_context.py` produces; updated by `watcher.py` (matrix_join_attestation_and_revocation.md §3)
      attestation.py     — verifies join attestations by calling `CardVerifier.verify_envelope()` for signature validity, chain-reaches-root, and revocation (reused from the verifier package, not hand-rolled), plus the matrix-specific checks the verifier package has no reason to know about: `payload.timestamp` freshness, `server_name` match, `verifyMatrixUserIdBinding` (matrix_encryption.md §3, matrix_join_attestation_and_revocation.md §1-2); replaces the original `binding_client.py`
      watcher.py         — long-running CardHeadUpdated subscription daemon; watch-set construction and reference-counting, backstop re-walk, subscription-loss catch-up (matrix_join_attestation_and_revocation.md §3.1-3.3)
      membership_registry.py — persistent, encrypted `(room_id, matrix_user_id) → card_hash` store (matrix_join_attestation_and_revocation.md §2a); read by module.py's post hook and watcher.py's watch-set logic, written by the join hook; encryption key obtained via the shared secrets abstraction (Step 7's pattern), not a module-local key
  test/
    __init__.py
```

~~`binding_client.py`~~ is removed (superseded 2026-07-11) — it called `wallet-service`'s internal card-binding resolver, which the join-attestation model no longer needs.

Mounted into the Synapse container image **at build time** (`COPY`'d in `wallet-service/matrix/Dockerfile`, per Step 5), not fetched at runtime — this keeps the deployed module version pinned to the image build, matching the "no manual admin-console steps on first boot" goal in the strategic plan's Goal 1.

---

## Registration Order

`module.py`'s `PolicyModule.__init__` registers both callbacks against the `ModuleApi` it receives from Synapse at load time:

```python
class PolicyModule:
    def __init__(self, config: PolicyModuleConfig, api: "synapse.module_api.ModuleApi"):
        self.config = config
        self.api = api
        api.register_spam_checker_callbacks(
            user_may_join_room=self.user_may_join_room,
            check_event_for_spam=self.check_event_for_spam,
        )
```

This registration shape (`register_spam_checker_callbacks`, keyword arguments matching callback names) is Synapse's standard module registration pattern for this callback category and is what Step 8's scaffold stubs against.
