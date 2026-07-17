# Matrix Synapse Policy Module — Object Spec

**Version:** 0.2 (draft)
**Date:** 2026-07-10 (amended 2026-07-11)
**Status:** Draft
**Targets:** Synapse's Module API **Spam Checker Callbacks** category, current as of the Synapse release line documented at `element-hq.github.io/synapse/latest/modules/spam_checker_callbacks.html` (confirmed live 2026-07-10; that page documents callback changes as recent as Synapse v1.133.0, so this spec targets a Synapse version at or above that line — `wallet-service/matrix/Dockerfile`, per Step 5, pins `matrixdotorg/synapse:latest`, so re-confirm these callback names against the pinned image's actual version at build time rather than assuming they remain stable indefinitely).
**Companion documents:** `specs/object_specs/matrix_room.md`, `specs/object_specs/matrix_encryption.md` (cited substantively, e.g. `verifyMatrixUserIdBinding`), `specs/process_specs/matrix_room_membership.md`, `specs/process_specs/matrix_join_attestation_and_revocation.md`, `specs/process_specs/room_discovery.md` (its §2 step 3b client-side discovery algorithm depends on `predicates.py`'s exact evaluation semantics — see the note by that file in §Module Package Layout)

**Amended 2026-07-11:** `wallet_service_internal_url` / `wallet_service_module_shared_secret` and `binding_client.py` are removed per `matrix_join_attestation_and_revocation.md`, which replaces the live wallet-service resolver call with a client-presented signed attestation. New config and a new watcher component are added for the event-driven revocation model — see §Module Config Schema and §Module Package Layout below.

**Changelog (spec-consistency Phase 1):** Fix #37 — added `matrix_encryption.md` to companion documents. See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 2):** Fix #43 — corrected the `check_event_for_spam` post-time `card_hash` lookup citation to `matrix_join_attestation_and_revocation.md §2a`. Fix #50 — added `room_discovery.md` to companion documents and noted its dependency on `predicates.py`'s semantics. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3, Tier 3 item (f)):** corrected `§Callback Selection` and `§Registration Order` — live testing against a real Synapse process found `check_event_for_spam` is never invoked for joins at all; `check_event_allowed` (Third-Party Rules category) is now documented as the real, sole join-authorization gate, alongside the accepted operational risk of depending on a Synapse-documented "very experimental" callback. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3):** Tier 3 item (e) — noted in §Module Package Layout that `watcher.py`'s `Watcher` is built and unit-tested but not yet constructed/started by `PolicyModule.__init__`; a TODO is filed at the wiring site in `module.py` rather than the spec continuing to imply it already runs. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

---

## Callback Selection

**Corrected 2026-07-16 (Step 20 live-stack integration test) — this section previously said the module uses only the Spam Checker category (`check_event_for_spam`, `user_may_join_room`) and deliberately avoids `check_event_allowed` on the strength of Synapse's own docs calling it "very experimental." That decision was based on an assumption — "state events (including `m.room.member`) already pass through `check_event_for_spam`" — that live testing against a real Synapse process found to be false.** Traced through Synapse's own source: `check_event_for_spam` is called from exactly one place, `handlers/message.py`'s `_create_and_send_nonmember_event_locked`. Joins never reach it — `room_member.py`'s membership-update path calls `event_creation_handler.create_event` directly and only ever invokes the Spam Checker category's `user_may_join_room` (structurally blind to event content) before persisting the join. **`check_event_for_spam` is never invoked for a join, full stop.** Confirmed live: a join with no attestation content, and separately one with an empty `signatures` array, both returned Matrix's `200` success rather than the intended `403` — every "join denied" log line the original design could produce was dead code in production.

Synapse exposes two overlapping event-authorization mechanisms: the **Spam Checker** category (`check_event_for_spam`, `user_may_join_room`) and the older **Third-Party Rules** category (`check_event_allowed`). This module now registers callbacks in **both** categories, with different roles:

- **`check_event_allowed` (Third-Party Rules) is the real, sole join-authorization gate.** `create_event` — which membership updates *do* call — runs this callback, so it is the only one of the two categories actually invoked on the join path.
- **`check_event_for_spam` (Spam Checker) continues to authorize posts** (`m.room.message`), exactly as originally designed and unchanged by this correction — see that subsection below.
- **`user_may_join_room` (Spam Checker) remains a permissive no-op**, registered only because Synapse's Spam Checker API expects it when a module registers for join-related checks at all.

**Accepted operational risk:** Synapse's own module documentation describes `check_event_allowed` as "very experimental and can and will break without notice." The original design avoided it for exactly this reason and chose `check_event_for_spam` instead — a choice that turned out not to work at all for joins, for the structural reason above. Since `check_event_allowed` is the *only* callback Synapse actually invokes on the join path in the currently-deployed Synapse version, this module now depends on it as load-bearing infrastructure despite Synapse's own warning. A future Synapse release could change or remove this callback's contract without notice; re-verify `check_event_allowed`'s behavior against any Synapse version upgrade (see this spec's header note on re-confirming callback names/behavior at build time), not just at initial deployment.

### `user_may_join_room` — always a permissive no-op (resolved 2026-07-12, re-confirmed 2026-07-16)

```python
async def user_may_join_room(
    user: str,
    room: str,
    is_invited: bool,
) -> Union["synapse.module_api.NOT_SPAM", "synapse.module_api.errors.Codes", bool]
```

**This callback structurally cannot authorize a card-gated join and always returns `NOT_SPAM`.** Its signature carries no request content, so a client-presented join attestation (`matrix_join_attestation_and_revocation.md §1`) can never reach it, regardless of wire format. **Corrected 2026-07-16:** the real join gate is `check_event_allowed` below, not `check_event_for_spam` — the 2026-07-12 resolution's assumption that `check_event_for_spam` could see joins does not hold against a real Synapse process (see §Callback Selection above). This callback is retained (rather than left unregistered) only because Synapse's Spam Checker API expects it if a module registers for join-related checks at all; it performs no card-policy logic of its own.

### `check_event_allowed` — the real join-authorization gate (added 2026-07-16, corrects the 2026-07-12 design)

```python
async def check_event_allowed(
    event: "synapse.module_api.EventBase",
    state_events: dict,
) -> tuple[bool, Optional[dict]]
```

- Registered against Synapse's **Third-Party Rules** callback category (`api.register_third_party_rules_callbacks(check_event_allowed=...)`), not the Spam Checker category `check_event_for_spam`/`user_may_join_room` are registered against.
- `event` — the incoming event, prior to persistence. `state_events` — the room's state immediately prior to this event, keyed `(event_type, state_key)`, handed to this callback directly by Synapse (no extra `ModuleApi` round-trip needed to read `m.card.policy`, unlike `check_event_for_spam`'s post-time path).
- Passes through unchanged (`return (True, None)`) for any event that isn't an `m.room.member` event with `content.membership == "join"`, and for a join in a room whose prior state has no `m.card.policy` entry (not a card-gated room).
- For a join in a card-gated room: reads the join attestation from `content["io.cardprotocol.join_attestation"]`, verifies it (signature, freshness, server_name, sender-binding — `matrix_join_attestation_and_revocation.md §2`), evaluates the room predicate against its chain, and on success registers the membership (`membership_registry.py`) and seeds the chain-walk cache — the same decision logic (`_decide_join`) the original design specified, now reached via this callback instead of `check_event_for_spam`. A join event with no attestation in its content, an invalid attestation, or a chain that doesn't satisfy the room's predicate is denied by returning `(False, None)`.
- **This callback is invoked on every join**, in both card-gated and non-card-gated rooms (passing through immediately for the latter) — this is the mechanism that makes join-time enforcement work at all; without it, every join would silently fall through to allowed regardless of attestation validity (see §Callback Selection's operational-risk note on what happens if this callback's contract ever changes).

### `check_event_for_spam` — post authorization only (join-authorization role removed 2026-07-16; unchanged otherwise since 2026-07-12)

```python
async def check_event_for_spam(
    event: "synapse.module_api.EventBase",
) -> Union["synapse.module_api.NOT_SPAM", "synapse.module_api.errors.Codes", str, bool]
```

- `event` — the incoming event, prior to persistence. The module reads `event.sender` (a shadow-account Matrix user ID), `event.room_id`, `event.type`, and `event.content`.
- The module only applies its card-policy check to events in rooms that carry an `m.card.policy` state event; for any other room (there should be none, in this deployment, since all rooms this module manages are created via `POST /matrix/rooms` — but the module must not assume that invariant blindly) the callback returns `NOT_SPAM` unconditionally, deferring to Synapse's normal event-auth.
- For a **post** (`m.room.message`) in a card-gated room, the module runs the post sequence from `matrix_room_membership.md §2` (resolve `card_hash` from the membership registry, per `matrix_join_attestation_and_revocation.md §2a` — no fresh attestation — check cached revocation status, evaluate the predicate; `matrix_room_membership.md §2` itself is superseded on this specific point, see that document's amendment note) and **returns `synapse.module_api.errors.Codes.FORBIDDEN` on any deny path (predicate false, or any failure-mode deny per `matrix_room_membership.md §4`), and `NOT_SPAM` otherwise.** The module does not use the deprecated string/boolean return forms.
- **This callback is invoked per event, on every message** — this is exactly the mechanism `matrix_room_membership.md §2` relies on to make revocation enforcement work without a separate polling loop.
- **Corrected 2026-07-16:** this callback also still contains an `m.room.member`/join-shaped branch (`_authorize_join_event`, sharing the same `_decide_join` logic `check_event_allowed` uses) inherited from the pre-correction design. It is **confirmed unreachable via any real `/join` request** against the currently-deployed Synapse version — Synapse's membership-update path never calls `check_event_for_spam` at all (see §Callback Selection). It is kept only for direct unit-test coverage of the shared `_decide_join` logic, and as a safety net should some future Synapse version route membership events through `check_event_for_spam` after all. **Do not rely on this branch running in production.**

Other room state events (`m.room.name`, `m.room.topic`, `m.room.encryption`, and `m.card.policy` itself) pass through unchanged. The module's card-policy check applies only to `m.room.message` (via `check_event_for_spam`) and to `m.room.member`/join events (via `check_event_allowed`); other state events are passed through provided their sender already holds current room membership (state-event authorship authorization is otherwise handled by Synapse's own room-power-level model, which this module does not touch).

**Known limitation, stated in Synapse's own docs and inherited here:** the Spam Checker callbacks are not invoked for joins performed by a server administrator, or in the context of room creation (the creator's own auto-join) — Synapse admits these without running Spam Checker callbacks at all. This module's own testing of `check_event_allowed` has not separately re-confirmed whether the same admin/creator-auto-join exemption applies to the Third-Party Rules category — treat that as unconfirmed rather than assumed either way. Either way, the room-creation flow (`matrix_room.md §Room Creation`) does not rely on any callback to authorize the creator's own join — the creator is trusted to have a valid card by virtue of having authenticated to `wallet-service` and provisioned their shadow account through the Application Service bridge, per `matrix_room_membership.md`'s framing of what is and isn't in the module's authority. The creator's membership must still be entered into the membership registry directly by the room-creation code path (`matrix_join_attestation_and_revocation.md §2`'s "Creator auto-join" note), since their join is not guaranteed to reach either callback.

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
      enforcement_matrix_user_id: "${MATRIX_ENFORCEMENT_USER_ID}"
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
| `enforcement_matrix_user_id` | string (Matrix user ID) | Yes (added 2026-07-12) | The Matrix user ID `watcher.py`'s `ModuleApiForcePartClient` passes as `sender` to `ModuleApi.update_room_membership` for force-part. **Not a secret** — there is no Synapse Admin API endpoint for force-removing a room member (confirmed 2026-07-12; a prior draft of this schema assumed one and provisioned a token for it, which is now known to be unnecessary — see `matrix_join_attestation_and_revocation.md §3.1`'s force-part note). This account instead needs kick-level power in every card-gated room, granted at room creation (`matrix_room.md §Room Creation`'s `m.room.power_levels` initial state, Step 16) — a permission grant, not a credential to protect. |

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
      module.py         — PolicyModule class; registers user_may_join_room and check_event_for_spam (Spam Checker category) plus check_event_allowed (Third-Party Rules category, the real join-authorization gate — see §Callback Selection, corrected 2026-07-16)
      config.py         — typed config dataclass; parses the modules: config block above
      rpc_provider.py    — implements membership_card_verifier.RpcProvider's async methods (Step 9a) against the registry contract via web3.py; also exposes a separate WS-subscription interface for the watcher's CardHeadUpdated needs, which is genuinely new code — RpcProvider has no concept of event subscriptions, only point reads
      ipfs_provider.py    — implements membership_card_verifier.IpfsProvider's single `async def fetch(cid) -> bytes` (Step 9b) via httpx — much smaller than a from-scratch IPFS client, since the package handles everything past the raw bytes
      predicates.py      — the room-predicate-document evaluator (Step 9c): `any_of`/`issued_under_template`/`card_field_matches` over `matrix_room.md`'s fixed schema, evaluated against the verifier package's result types (`CardVerificationResult`/`SignatureVerificationResult` — real field names: `chain_reaches_trusted_root`, `revocation.status`, etc.) plus the chain address list from `chain_context.py` below. **This module's semantics are also relied on client-side:** `room_discovery.md §2` step 3b reimplements this same evaluation logic for its client-side `discoverRooms()` function and calls for the two to share logic (or at minimum be tested against the same fixtures) rather than drift apart — any change to this file's evaluation semantics should be checked against that document.
      chain_context.py   — (renamed from `chain_walk.py`, Step 10) a thin wrapper: builds a `VerifierConfig` from this module's config, calls `CardVerifier.verify_envelope()` (join attestations, which are already `SignedMessageEnvelope`-shaped per `matrix_join_attestation_and_revocation.md §1`) or `verify_card()` (post-time re-checks against a bare address) as appropriate. **Open item, not resolved by this spec:** the verifier package's public result types expose `chain_reaches_trusted_root` (a bool) but not the underlying `chain_card_addresses` list — needed here for `chain_includes`/`card_field_matches` (which must check every card in the chain, not just whether it reaches a root) and for the watcher's watch-set construction (Step 11a). Until/unless the verifier package exposes this on its public result types (it's already computed internally by Stage 3 — an additive change, not a redesign), this module has to reach into `membership_card_verifier.stages.stage3` directly, which isn't part of the package's documented public API (`__init__.py`'s `__all__` doesn't include it).
      cache.py           — event-invalidated cache, keyed by address, storing whatever `chain_context.py` produces; updated by `watcher.py` (matrix_join_attestation_and_revocation.md §3)
      attestation.py     — verifies join attestations by calling `CardVerifier.verify_envelope()` for signature validity, chain-reaches-root, and revocation (reused from the verifier package, not hand-rolled), plus the matrix-specific checks the verifier package has no reason to know about: `payload.timestamp` freshness, `server_name` match, `verifyMatrixUserIdBinding` (matrix_encryption.md §3, matrix_join_attestation_and_revocation.md §1-2); replaces the original `binding_client.py`
      watcher.py         — long-running CardHeadUpdated subscription daemon; watch-set construction and reference-counting, backstop re-walk, subscription-loss catch-up (matrix_join_attestation_and_revocation.md §3.1-3.3). **Status (noted 2026-07-16, spec-consistency review): built and unit-tested, but not yet wired into the production entrypoint.** `module.py`'s `PolicyModule.__init__` — the only entrypoint Synapse's module loader calls — does not construct or start a `Watcher` instance, and does not call `MembershipRegistry.reconcile()` at startup; no other process starts one either. A TODO documenting the exact wiring needed is filed at the construction site in `module.py`. Until this lands, revocations occurring after join are not detected until the affected member's next post is evaluated against a stale cache — see `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (e).
      membership_registry.py — persistent, encrypted `(room_id, matrix_user_id) → card_hash` store (matrix_join_attestation_and_revocation.md §2a); read by module.py's post hook and watcher.py's watch-set logic, written by the join hook; encryption key obtained via the shared secrets abstraction (Step 7's pattern), not a module-local key
  test/
    __init__.py
```

~~`binding_client.py`~~ is removed (superseded 2026-07-11) — it called `wallet-service`'s internal card-binding resolver, which the join-attestation model no longer needs.

Mounted into the Synapse container image **at build time** (`COPY`'d in `wallet-service/matrix/Dockerfile`, per Step 5), not fetched at runtime — this keeps the deployed module version pinned to the image build, matching the "no manual admin-console steps on first boot" goal in the strategic plan's Goal 1.

---

## Registration Order

**Corrected 2026-07-16 (Step 20 live-stack integration test) — this section previously showed only a single `register_spam_checker_callbacks` call.** `module.py`'s `PolicyModule.__init__` registers callbacks against **two separate callback categories** on the `ModuleApi` it receives from Synapse at load time — the Spam Checker registration alone is not sufficient, since `check_event_allowed` (§Callback Selection) is the only one of the two categories actually invoked on the join path:

```python
class PolicyModule:
    def __init__(self, config: PolicyModuleConfig, api: "synapse.module_api.ModuleApi"):
        self.config = config
        self.api = api
        api.register_spam_checker_callbacks(
            user_may_join_room=self.user_may_join_room,
            check_event_for_spam=self.check_event_for_spam,
        )
        # check_event_allowed is the real join gate — see §Callback Selection
        # (corrected 2026-07-16) for why check_event_for_spam alone, as
        # originally designed, can never see a join at all.
        api.register_third_party_rules_callbacks(
            check_event_allowed=self.check_event_allowed,
        )
```

`register_spam_checker_callbacks` (keyword arguments matching callback names) is Synapse's standard module registration pattern for the Spam Checker category and is what Step 8's scaffold stubs against; `register_third_party_rules_callbacks` is the equivalent registration call for the Third-Party Rules category, added to the scaffold 2026-07-16 alongside `check_event_allowed` itself. Both calls must run for the module to function — omitting the second one leaves join authorization entirely unregistered, silently defeating card-gating for every join (the module would still start and log nothing indicating a problem).
