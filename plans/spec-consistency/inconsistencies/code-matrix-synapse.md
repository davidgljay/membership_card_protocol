# Spec-vs-Code Diff: `matrix_synapse_module.md` vs. `wallet-service/matrix-policy-module/`

**Unit:** code-matrix-synapse (Phase 3, Step A)
**Spec:** `specs/object_specs/matrix_synapse_module.md` (v0.2 draft, header dated 2026-07-10, amended 2026-07-11; Phase 1/2 spec-consistency changelog entries present)
**Code:** `wallet-service/matrix-policy-module/` (Python package, src + test)
**Review type:** read-only, spec-vs-code. No spec or code file modified.

Scope per assignment: callback selection (`check_event_for_spam` vs. `user_may_join_room`), the Module Config Schema, and the watcher/`CardHeadUpdated` event-driven revocation component. Metadata-only Phase 2 amendments (header version bump, companion-doc list, citation fix) were not re-verified — out of scope per instructions.

---

## Finding 1 — ESCALATE TO DAVID: Spec's callback-selection design is now known-wrong; code has moved on to a different (and less-safe-by-default) mechanism the spec never mentions

**Spec says** (`§Callback Selection`, `§Registration Order`): the module uses only the Spam Checker category. `user_may_join_room` is a deliberate permissive no-op. Real join authorization *and* post authorization both happen inside `check_event_for_spam`, because (per the spec's own text) "state events (including `m.room.member`) already pass through `check_event_for_spam`, which *does* receive the full event object," and this "runs *instead of* `user_may_join_room`, not in addition to any real check there." `§Registration Order` shows only `api.register_spam_checker_callbacks(user_may_join_room=..., check_event_for_spam=...)` — no other registration call.

**Code says** (`module.py`, lines 1–56 module docstring, and `PolicyModule.__init__` lines 168–198): this was tested live against a real Synapse process (Step 20, dated 2026-07-16 — *after* the spec's last substantive amendment) and found to be **factually wrong**. Traced through Synapse's own source: `check_event_for_spam` is only ever called from `handlers/message.py`'s non-member event path; Synapse's join path (`room_member.py`) never calls it at all, and only ever invokes the structurally-blind `user_may_join_room`. The code's own docstring states plainly: "every join (attestation present or not, valid or not) was silently allowed" under the spec's design — confirmed live, a join with no attestation and a join with an empty signature array both returned Matrix's `200`, not `403`.

The code's fix: register a *second* callback category the spec explicitly rejected — `check_event_allowed` (Synapse's ThirdPartyEventRules "very experimental... can and will break without notice" callback, the same one the spec's `§Callback Selection` intro cites Synapse's own docs to reject). `check_event_allowed` is now the actual, sole join gate in production. `check_event_for_spam`'s join branch (`_authorize_join_event`) is retained only for unit-test coverage of shared decision logic and is confirmed unreachable via any real `/join` request against the installed Synapse version.

**Which side is correct:** the code's underlying factual claim (Synapse's join path never calls `check_event_for_spam`) is corroborated by Synapse's own module-development docs cited in the spec itself, and — per the code's own account — was confirmed against a live, running Synapse process, not just read from documentation. The spec's design is very likely the one that's wrong now, and dangerously so: the spec's Registration Order section, if followed literally without the code's `check_event_allowed` addition, describes a module that authorizes zero real joins (everything falls through to allow). This is a live enforcement-bypass difference between what the spec instructs and what actually gates access, discovered by the implementation after the spec was last touched. **This is a security-critical, load-bearing divergence and must be escalated, not silently reconciled** — resolving it requires either (a) confirming the code's live-testing finding and rewriting the spec's `§Callback Selection`/`§Registration Order` sections around `check_event_allowed` as the real join gate (noting Synapse's own "very experimental, can break without notice" caveat now becomes a real operational risk the spec must carry forward, not dismiss), or (b) if there's reason to doubt the 2026-07-16 finding, re-verifying it before trusting either side.

Secondary, lower-stakes note: the spec's "Known limitation" paragraph about admin/room-creation joins bypassing both callbacks should be re-examined once the callback story is fixed, since it was written against the old (per the code, wrong) model.

---

## Finding 2 — ESCALATE TO DAVID: The watcher (event-driven revocation) is fully implemented and tested but is never started anywhere; the module runs less strictly than either the spec or the code's own design intends

**Spec says** (`§Module Package Layout`, `watcher.py` entry; also `§Module Config Schema`'s `watcher_backstop_interval_seconds`): a "long-running `CardHeadUpdated` subscription daemon" performs watch-set construction/reference-counting, invalidates and refreshes the chain-walk cache on a detected on-chain event, force-parts revoked members, and runs a periodic backstop re-walk — this is explicitly called out as "exactly the mechanism `matrix_room_membership.md §2` relies on to make revocation enforcement work."

**Code has** a fully built and unit-tested `watcher.py` (`Watcher` class: `handle_card_head_updated`, `run_subscription_loop`, `run_backstop_loop`, `catch_up`, force-part-with-retry — matches the spec's description closely) plus `MembershipRegistry.reconcile()` (startup reconciliation against Synapse's live membership list). **But nothing in the codebase ever instantiates or starts a `Watcher`.**

Verified by direct search:
- `module.py`'s `PolicyModule.__init__` (the only production entrypoint — this is what Synapse's module loader calls) never imports or constructs `Watcher`, never calls `run_subscription_loop`/`run_backstop_loop`, and never calls `MembershipRegistry.reconcile()` at startup.
- `wallet-service/matrix/Dockerfile` only `pip install`s the module and precompiles bytecode; it never launches a separate watcher process.
- `wallet-service/docker-compose.yml`'s `synapse` service `command` is only `["run", "--config-path=...", ...]` — the base image's standard Synapse start command, nothing watcher-related. The compose file's own comment (line ~79-82) *asserts* "the container also runs a long-running watcher process (not a separate Compose service)" needing outbound access to `ARBITRUM_RPC_WS_URL" — but no code anywhere actually starts such a process; the comment describes an intent that isn't implemented.
- Nothing else in the repo references `run_subscription_loop`, `run_backstop_loop`, or constructs `Watcher`/calls `reconcile()` outside `test/test_watcher.py` and `test/test_membership_registry.py`.

**Consequence, confirmed by reading `cache.py`:** `ChainWalkCache.get()` returns whatever is already cached with **no expiry and no revalidation** — the only thing that ever refreshes a cached revocation status is `invalidate_and_refresh`, which is called exclusively from the (never-started) watcher's `handle_card_head_updated`. A card revoked on-chain *after* a member joins a room will therefore never be detected: the post-time check in `module.py`'s `check_event_for_spam` (`cached = await self._cache.get(card_hash)`) will keep returning the stale, still-valid status indefinitely, and no force-part will ever be triggered. `MembershipRegistry.reconcile()` — meant to run once at startup to prune stale registry entries against Synapse's live membership list — is likewise dead code.

**Which side is correct:** the *code's own design* (watcher.py, cache.py, membership_registry.py) is internally consistent with the spec's intent — the pieces exist and are unit-tested exactly as the spec describes. What's missing is the wiring/entrypoint: no process anywhere starts the daemon. This is not a spec-vs-code disagreement about what *should* happen — both sides agree revocation should be event-driven and continuously enforced — it is a gap where the code is silently less strict than **both** the spec and its own internal design. This is the core purpose of the entire "event-driven revocation" section of this spec and of `matrix_join_attestation_and_revocation.md §3`; without it, revocation enforcement silently degrades to "whatever was true at join time, forever." **Must be escalated** — this needs either a real process supervisor entry (a second container/process in `docker-compose.yml`, or a startup hook inside `PolicyModule.__init__`/Synapse's module lifecycle that spawns `run_subscription_loop`/`run_backstop_loop` as background asyncio tasks, plus a `reconcile()` call at startup) or, if this was intentionally deferred to a later phase, the spec and the docker-compose comment should say so explicitly rather than asserting it already runs.

Related, smaller instance of the same class of gap: `Watcher.catch_up()` sets `is_catching_up = True/False` and the watcher's own docstring says "`is_catching_up`... should be checked by module.py's join/post hooks and treated as deny-worthy staleness" during a reconnect gap — but since no `Watcher` is ever constructed in `module.py` at all, this flag is never wired to anything either. Folding this into the same escalation rather than filing separately, since fixing Finding 2 properly (wiring up a real watcher instance) is the natural place to also wire this check.

---

## Finding 3 — No divergence: Module Config Schema

Compared every key in the spec's `§Module Config Schema` table against `config.py`'s `_REQUIRED_KEYS` tuple and `PolicyModuleConfig` dataclass field-by-field:

| Key | Spec | Code | Match |
|---|---|---|---|
| `arbitrum_rpc_url` | required | required | yes |
| `arbitrum_rpc_ws_url` | required | required | yes |
| `registry_contract_address` | required | required | yes |
| `ipfs_gateway_url` | required | required | yes |
| `matrix_server_name` | required | required | yes |
| `join_attestation_freshness_seconds` | optional, default 300 | optional, default 300 | yes |
| `watcher_backstop_interval_seconds` | optional, default 3600 | optional, default 3600 | yes |
| `membership_registry_path` | required | required | yes |
| `membership_registry_key_path` | required | required | yes |
| `enforcement_matrix_user_id` | required | required | yes |

Removed keys (`card_cache_ttl_seconds`, `wallet_service_internal_url`, `wallet_service_module_shared_secret`) are correctly absent from `config.py`, with a docstring cross-reference matching the spec's own removal note. `config.py`'s `ConfigError` on missing/malformed required keys matches the spec's "fails Synapse startup loudly... deny-by-default posture" requirement. **No action needed here** — this section of the spec is accurate as of both the 2026-07-11 amendment and current code.

---

## Finding 4 — Module Package Layout: structurally matches, but two spec citations are stale by the same 2026-07-16 findings as Finding 1

Every file the spec's `§Module Package Layout` lists (`module.py`, `config.py`, `rpc_provider.py`, `ipfs_provider.py`, `predicates.py`, `chain_context.py`, `cache.py`, `attestation.py`, `watcher.py`, `membership_registry.py`) exists exactly as named, with responsibilities matching the spec's one-line descriptions (verified by reading each file's module docstring and primary class/functions). `chain_context.py`'s "open item" about the verifier package's `chain_card_addresses` not being on its public result type is still live in the code (`extract_chain`'s comment references `signatures[0].chain`, consistent, and `chain_context.py`'s own docstring still describes the `verify_card()`-always-empty-chain limitation as unresolved) — no divergence there.

The one thing worth flagging (not escalating — it's a documentation-freshness issue riding on Finding 1, not a new independent risk): the package layout's docstring text at the top of the spec section ("this module now depends on `membership-card-verifier`...") is accurate and matches `pyproject.toml`'s dependency and `chain_context.py`'s usage. No divergence found here.

---

## Summary

| # | Area | Verdict | Severity |
|---|---|---|---|
| 1 | Callback selection (`check_event_for_spam` vs. `user_may_join_room` vs. `check_event_allowed`) | Code has moved past the spec's design based on live-testing findings dated *after* the spec's last substantive edit; spec's registration-order description no longer matches what actually gates joins in production | **ESCALATE** |
| 2 | Watcher / event-driven revocation wiring | Fully built and tested, but never instantiated or started anywhere — revocation enforcement silently degrades to join-time-only in production | **ESCALATE** |
| 3 | Module Config Schema | Exact match, both keys and defaults | No action |
| 4 | Module Package Layout | Exact structural match; open items in code match open items acknowledged in spec | No action |

Both escalated findings share a root cause worth naming explicitly: this module's own commit history (visible in `module.py`'s and `ModuleApiRoomPolicyResolver`'s docstrings) shows a repeated pattern — components that pass unit tests against fakes/mocks but were never actually exercised against a live Synapse process, and turned out to be silently inert or wrong once they were. Findings 1 and 2 are, respectively, an already-caught instance of that pattern (Finding 1, fixed 2026-07-16, but the spec wasn't updated to match) and an apparently-not-yet-caught instance of the same pattern (Finding 2, the watcher is untested in the live-integration sense — `test/test_watcher.py` only exercises the class directly, not whether anything in the real deployment ever calls it).
