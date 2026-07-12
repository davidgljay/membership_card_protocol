# Matrix Server — Implementation Plan

**Date:** 2026-07-10 (restructured 2026-07-11)
**Status:** Draft
**Strategic plan:** [matrix-strategic-plan.md](./matrix-strategic-plan.md)

**Restructured 2026-07-11:** Phase 1 produced two additional spec documents beyond the original four (`matrix_join_attestation_and_revocation.md`, `room_discovery.md`), which changed the join-authorization mechanism, replaced the TTL revocation cache with an event-driven watcher that force-parts on every revocation, and added room discovery as new scope. Rather than patch step numbers throughout, this revision **edits affected steps in place and inserts lettered sub-steps** (e.g. `11a`) for genuinely new work — the same convention `registry_contract.md` uses for its own amendments — so existing cross-references (checkpoints, milestone reviews) mostly still resolve. Steps with no lettered marker and no inline note are unchanged from the original plan.

**Decisions locked in during strategic review:**
- Policy enforcement lives entirely in a **Synapse Module** written in Python — including a full reimplementation of the protocol's predicate evaluator and card chain walk. No standalone proxy container. Synapse itself stays a stock, unmodified `matrixdotorg/synapse` image; the module is a plugin file mounted in and referenced from `homeserver.yaml`.
- Encryption is **native Matrix E2EE (Megolm)**, not a custom AES scheme. Card signatures are embedded inside the Megolm-encrypted event body.
- The card ↔ shadow-Matrix-account bridge lives **inside `wallet-service`** (new module, reuses existing card auth/session-token machinery), as a Matrix Application Service.
- Matrix rooms are **additive** — the existing `POST /messages` → routing table → relay path for 1:1/small-group messaging is untouched. Matrix is new infrastructure specifically for group/room chat.
- Single Synapse node this pass; no cross-server federation (deferred to a follow-on plan).

**Decisions locked in 2026-07-11 (supersede the "unresolved" TTL assumption below):**
- Join authorization uses a **client-signed attestation**, verified by the module directly (`verifyMatrixUserIdBinding`) — not a live call to a `wallet-service` card-binding resolver. That resolver endpoint is **removed from scope entirely**; it was flagged as a to-be-built Phase 4 item in the original `matrix_synapse_module.md` and is no longer needed.
- Revocation detection is **event-driven** (a persistent subscription to the registry contract's `CardHeadUpdated` event, per-address watch-set), with an hourly backstop re-walk as a correctness floor — not a 60-second TTL cache.
- **Every** detected revocation (8xx or 9xx, no distinction) triggers an **immediate force-part** of the affected Matrix account from any room it no longer qualifies for. This is not conditional on severity — see `matrix_join_attestation_and_revocation.md §3.1` for the reasoning (a revoked card retaining read access via undisturbed room membership was judged unacceptable regardless of how "quiet" the revocation is).
- Room discovery is in scope: a public room index plus a client-side default discovery path, with a server-hosted endpoint as an explicitly-flagged secondary option.

**~~Unresolved from the strategic plan, treated as assumptions per the intake~~ — superseded 2026-07-11:**
- ~~Card revocation staleness in the Python module's card cache: 60 seconds~~ — replaced by the event-driven model above.
- Hosting target: assumed to be the **same environment as the existing `wallet-service` stack**, so new services are added to `wallet-service/docker-compose.yml` directly rather than a separate orchestration file, and follow the same `.env`-driven config convention. *(Still an open assumption — unaffected by 2026-07-11 changes.)*

## Note on agent usage for every step below

Steps are written to be handed to a single, focused agent — usually a Haiku-tier agent — with everything it needs to act without further research or delegation. **No step in this plan should itself spawn another agent.** If a step's instructions seem to require judgment calls beyond what's written, that is a signal to escalate to Claude (Sonnet/Opus) or to the user — not to have the executing agent create a sub-agent of its own.

"Suggested agent" per step reflects task complexity:
- **Haiku** — mechanical: scaffolding, boilerplate, config files, following an exact schema, writing tests against a fully-specified behavior.
- **Sonnet (general-purpose)** — requires synthesizing multiple existing files, non-trivial logic, or judgment about how to fit new code into existing patterns.
- **Opus/Claude (you)** — architectural judgment calls, anything touching cryptography design, or steps explicitly marked as checkpoints.

---

## Clarification Checkpoints

Before proceeding past these points, pause and get explicit confirmation from David:

- **Before Phase 2 (any container/infra work):** confirm Phase 1 spec documents — including the two 2026-07-11 additions — have been reviewed and approved.
- ~~**Before Phase 3, Step 9 (predicate evaluator port):** confirm the 60-second card cache TTL assumption~~ — **superseded.** Before Phase 3, Step 9, confirm instead: (a) the `watcher_backstop_interval_seconds` default (3600) is acceptable as the correctness-floor interval, and (b) force-part-on-every-revocation (no 8xx/9xx distinction) is still the intended behavior, since it's the more disruptive of the two options that was considered and should be re-confirmed once it's actually being built, not just decided in planning.
- **Before Phase 3, Step 10 (chain walk port):** confirm reading `plans/app-card-chain-walk-implementation-plan.md` and `client-sdk/packages/client-sdk/src` (wherever the existing TypeScript chain walk lives) has surfaced a complete picture — a subtly incorrect Python re-implementation of the chain walk is a security bug, not a cosmetic one. **Added 2026-07-11:** also confirm the chain walk's return shape includes the full list of ancestor addresses visited (Step 10's updated Done-when criterion) — this is a new requirement the watcher (Step 11a) depends on and is easy to miss if Step 10 is implemented purely from the pre-2026-07-11 spec text.
- **Before Phase 4, Step 15 (Application Service registration):** confirm the AS's access token / homeserver secrets are being generated and stored the same way other secrets are handled in `wallet-service` (`SECRETS_BACKEND` — webcrypto vs KMS), not as a new one-off convention. **Added 2026-07-11:** the same applies to the watcher's Synapse admin-API token (Step 7b) — confirm it follows the same pattern before Step 11a is built.
- **Before Phase 5 (client-sdk Megolm integration):** confirm the choice of Matrix crypto binding (`matrix-rust-sdk` via WASM/napi, or an alternative) works across all three client-sdk targets (`client-sdk-web`, `client-sdk-rn`, and the core `client-sdk` package) before committing to it — this is a real cross-platform build risk flagged in the strategic plan.
- ~~**Added 2026-07-11 (surfaced during Phase 1 milestone review), before Phase 3, Step 12a (membership registry):** confirm whether the registry must survive a restart~~ — **Resolved 2026-07-11 by David.** The registry is persisted, encrypted at rest, via the same secrets-backend pattern used for the Synapse signing key and watcher admin token — not ephemeral, not a new key-management convention. See `matrix_join_attestation_and_revocation.md §2a` and `matrix_synapse_module.md`'s `membership_registry_path` config. **David's stated rationale, worth carrying forward as design context for this whole subsystem, not just this one decision:** a card-gated Matrix deployment now durably holds real sensitive metadata server-side (this registry), beyond the ciphertext-only Postgres contents the strategic plan's Goal 4 originally scoped — encryption at rest is the mitigation against passive/incidental exposure, but an operator (or community) that wants strong protection of this data is the party that needs to run (or fully trust) the Synapse instance holding it. This isn't a new goal to add to the strategic plan mechanically — it's a trust-model observation that should inform how Phase 2's runbook (Step 21) and any future federation follow-on plan talk about operator trust, since it's now true of more than just message content.
- **Before any file deletion, schema migration, or edit to files outside the new Matrix-specific paths:** show the change and get confirmation.

---

## Phase 1: Spec Completion

*Goal: Every ambiguity closed on paper before any code or container work begins.*

### Step 1: Write the Matrix room policy object spec

**Status: Done.** `specs/object_specs/matrix_room.md` — see file for content. Amended 2026-07-11 to point to `room_discovery.md` instead of asserting rooms are simply unlisted with no discovery path.

### Step 2: Write the room membership/authorization process spec

**Status: Done, partially superseded.** `specs/process_specs/matrix_room_membership.md` — join-resolution (§1 step 2) and the TTL cache (§3) are superseded by Step 4b's output; post-sequence re-evaluation (§2) and per-room card binding (§5) are still current.

### Step 3: Write the Synapse module interface spec

**Status: Done, amended.** `specs/object_specs/matrix_synapse_module.md` — config schema and package layout updated 2026-07-11 to drop the wallet-service resolver config/`binding_client.py` and add the watcher's config/`watcher.py`/`attestation.py`.

### Step 4: Write the Megolm encryption and card-signature spec

**Status: Done.** `specs/object_specs/matrix_encryption.md` — unaffected by the 2026-07-11 changes; its `verifyMatrixUserIdBinding` primitive is what Step 4b's join attestation reuses.

### Step 4b: Write the join-attestation & event-driven revocation spec (added 2026-07-11)

**Status: Done, amended during Phase 1 milestone review (2026-07-11).** `specs/process_specs/matrix_join_attestation_and_revocation.md` — the join attestation object and verification sequence, the event-driven watcher design (watch-set construction, backstop, reconnect catch-up), and the force-part-on-every-revocation decision. **The milestone review found a real gap: the original version of this document specified join-time identity resolution but never specified how the post hook resolves an already-joined member's `card_hash`, since posts carry no attestation and the wallet-service resolver it used to rely on was removed.** A new §2a ("Post-Time Identity Resolution") was added, specifying that the module's membership registry (already required by Step 12a for watch-set bookkeeping) is reused for this, and surfacing an open question — registry persistence across restarts — that wasn't previously visible as a decision point. This is the document Steps 8–12a below now implement against, alongside the original Step 2/3 outputs.

### Step 4c: Write the room-discovery spec (added 2026-07-11)

**Status: Done.** `specs/process_specs/room_discovery.md` — the room index shape, the client-side discovery function (default), and the server-hosted discovery endpoint (secondary, opt-in, no persistent query log). Steps 16a/16b below implement this.

---

### Phase 1 Milestone Review

**Context needed:** All six Phase 1 documents above, `matrix-strategic-plan.md`.

**Check:**
- Does every reference to "policy" across all documents point to the same predicate grammar (no doc reintroduces `m.card.policy`'s original ad hoc rules format)?
- Is the shadow Matrix account derivation function identical across `matrix_encryption.md`, `matrix_synapse_module.md`, and `matrix_join_attestation_and_revocation.md` (all three now need it)?
- Does the deny-by-default failure handling in `matrix_room_membership.md` §4 and `matrix_join_attestation_and_revocation.md` §3.3 together cover every external dependency the Synapse module and watcher have (RPC — both HTTP and WS, IPFS, Synapse's own admin API for force-part)?
- Are Synapse module callback names confirmed against real, current documentation rather than assumed? **(Note: `matrix_synapse_module.md §Callback Selection` already flags that this plan's Step 12 originally assumed `check_event_allowed` when `check_event_for_spam` is actually correct — confirm Step 12 below has been corrected to match, not just the object spec.)**
- Does `room_discovery.md`'s room index shape match what Step 16a's endpoint and Step 16b's client-side function both expect? **(Corrected 2026-07-11: this bullet previously said "Step 17a," which is the join-attestation signing step, not the discovery function — a clerical mislabel caught during the Phase 1 milestone review itself.)**
- **Added 2026-07-11:** does the post hook (Step 12) have a specified mechanism for resolving `card_hash` for an already-joined member, distinct from join-time attestation verification? (It didn't, until this review — see Step 4b's amendment and `matrix_join_attestation_and_revocation.md §2a`.)

**Done when:** A one-paragraph summary is written to `plans/milestones/matrix-phase-1-summary.md` (update the existing one if already written), contradictions (if any) are resolved in-place in the spec docs, and all six spec documents are internally consistent.

> **Checkpoint:** Pause here and present Phase 1 documents (including the two 2026-07-11 additions) to David for review before any code or container work begins.

---

## Phase 2: Infrastructure Scaffolding

*Goal: `docker compose up` brings up a working, empty Synapse instance alongside the existing wallet-service stack. No policy logic yet — the module loads but always allows (stubbed).*

### Step 5: Add Synapse and its Postgres to the Compose stack

**What:** Extend `wallet-service/docker-compose.yml` with two new services:

```yaml
  synapse-postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: synapse
      POSTGRES_DB: synapse
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
    volumes:
      - synapse_pg_data:/var/lib/postgresql/data
    networks:
      - card-net

  synapse:
    build: ./matrix
    volumes:
      - ./matrix/homeserver.yaml:/data/homeserver.yaml:ro
      - ./matrix-policy-module:/data/matrix-policy-module:ro
      - synapse_media:/data/media
    environment:
      SYNAPSE_SERVER_NAME: ${MATRIX_SERVER_NAME}
    depends_on:
      - synapse-postgres
    networks:
      - card-net
    # NOT exposed publicly; not in `ports:` — only the wallet-service AS
    # bridge and, once client-sdk connects directly for E2EE sync, an
    # internal-only network path reach it.
```

Add `synapse_pg_data` and `synapse_media` to the top-level `volumes:` block.

**Sub-steps:**
- **5a.** Create the `wallet-service/matrix/` directory with a minimal `Dockerfile`: `FROM matrixdotorg/synapse:latest`, then `COPY` in the module package at build time so the module is baked into the image rather than fetched at runtime (per Step 3's spec).
- **5b.** Add `MATRIX_SERVER_NAME` to `wallet-service/.env.example` with a comment explaining it's the Matrix homeserver domain (e.g. `matrix.internal`).

**Who:** Haiku — this is mechanical YAML/Dockerfile authoring against an exact spec.

**Data needed:** `wallet-service/docker-compose.yml` (current contents, to append to — do not replace existing services), `specs/object_specs/matrix_synapse_module.md` (Step 3 output, for the module mount path).

**Done when:** `docker compose config` validates the file with no syntax errors. The `synapse` and `synapse-postgres` services are present without modifying any existing service definition.

### Step 5c: Add watcher config and network access (added 2026-07-11)

**What:** The watcher (Step 11a) runs as a long-running process alongside the module — same container/process group as `synapse`, per `matrix_join_attestation_and_revocation.md §3.1`, not a separate Compose service. Add:
- `ARBITRUM_RPC_WS_URL` to `wallet-service/.env.example`, alongside the existing `ARBITRUM_RPC_URL` — comment noting this must point at a WebSocket-capable (or otherwise push-capable) RPC endpoint, which not every provider offers on every tier.
- `JOIN_ATTESTATION_FRESHNESS_SECONDS` (default `300`) and `WATCHER_BACKSTOP_INTERVAL_SECONDS` (default `3600`) to the same file, matching `matrix_synapse_module.md`'s config schema.
- `MATRIX_MEMBERSHIP_REGISTRY_PATH` (**added 2026-07-11**, persistence decision) — the filesystem path to the encrypted membership registry (`matrix_join_attestation_and_revocation.md §2a`). Add a named volume (e.g. `synapse_membership_registry`) mounted at this path, distinct from `synapse_pg_data`/`synapse_media` — this file is module-internal state, not Matrix protocol state, and shouldn't share a volume with either.
- A note in the `synapse` service's comment block (Step 5's YAML) that the container now also runs the watcher process, and therefore needs outbound network access to `ARBITRUM_RPC_WS_URL` in addition to the existing RPC/IPFS reads.

**Who:** Haiku.

**Data needed:** `specs/object_specs/matrix_synapse_module.md` (2026-07-11 config schema), Step 5 output.

**Done when:** `.env.example` documents all four new variables with comments; the new named volume is added to the top-level `volumes:` block and mounted into the `synapse` service; `docker compose config` still validates.

### Step 6: Generate the base `homeserver.yaml` (template + render script, corrected 2026-07-11)

**What:** Produce `wallet-service/matrix/homeserver.yaml.template` (committed to git, `${VAR}`-templated) configured for:
- Postgres backend pointing at the `synapse-postgres` service (`host: synapse-postgres`, `database: synapse`, credentials matching Step 5).
- `federation_domain_whitelist: []` (empty — no federation this pass, per strategic plan scope).
- `enable_registration: false` (only the Application Service, added in Phase 4, may create users).
- A `modules:` block referencing the policy module's class path (from Step 3's spec) with a config stanza matching `matrix_synapse_module.md`'s **current (2026-07-11)** schema: `arbitrum_rpc_url`, `arbitrum_rpc_ws_url`, `registry_contract_address`, `ipfs_gateway_url`, `matrix_server_name`, `join_attestation_freshness_seconds`, `watcher_backstop_interval_seconds`, `membership_registry_path`, `membership_registry_key_path`. **Do not include `card_cache_ttl_seconds`, `wallet_service_internal_url`, or `wallet_service_module_shared_secret`** — all three are removed as of 2026-07-11 and including them would silently resurrect the dependency this restructuring removed.
- `media_store_path: /data/media`.
- `signing_key_path: /data/secrets/homeserver.signing.key` (Step 7's output). `registration_shared_secret` is deliberately **not** in this file — see below.

**Corrected 2026-07-11 (found during Step 6's own execution, not before):** the original text of this step said Synapse itself substitutes `${VAR}` from the process environment when loading `homeserver.yaml`. **That's false** — verified against Synapse's docs/issue tracker; general `${VAR}` substitution in arbitrary config keys has never shipped in Synapse, and Docker Compose's own `${VAR}` resolution doesn't reach into the contents of a bind-mounted file either. So a `homeserver.yaml` written with literal `${MATRIX_SERVER_NAME}`-style placeholders and mounted directly would load into Synapse as those literal strings — a real bug, not a cosmetic one, since it silently breaks every templated value including the entire `modules:` block. **Fix:** a new script, `wallet-service/scripts/render-matrix-config.ts`, renders the concrete `wallet-service/matrix/homeserver.yaml` (gitignored) from the template by substituting `process.env` values directly, failing fast on any missing variable (same convention as `src/config.ts`). Must be run once, alongside `scripts/generate-matrix-secrets.ts` (Step 7), before `docker compose up synapse`, and re-run after any template or env-var change. `specs/object_specs/matrix_synapse_module.md` is corrected to match.

**`registration_shared_secret` handling (resolved 2026-07-11, was previously left as two options for this step to pick between):** Synapse's config schema has no `_path` variant for this key, unlike the signing key — it must be a literal value in a config file Synapse loads. `scripts/generate-matrix-secrets.ts` (Step 7) writes it pre-wrapped as its own tiny YAML file (`matrix/secrets/registration-shared-secret.yaml`). Synapse's docker image entrypoint (`start.py`) supports repeated `--config-path`/`-c` flags (confirmed via Synapse's own docs, not assumed) — so `docker-compose.yml`'s `synapse` service needs a `command:` override: `["run", "--config-path=/data/homeserver.yaml", "--config-path=/data/secrets/registration-shared-secret.yaml"]`. **Do not override `command:` to invoke `python -m synapse.app.homeserver` directly** — the base image's `ENTRYPOINT` is `/start.py`, unchanged by `matrix/Dockerfile` (which only `FROM`+`COPY`s); `command:` supplies *arguments to that entrypoint*, and `start.py` expects a mode keyword (`run`, `generate`, ...) as its first argument, not a replacement executable. This exact mistake was made once during this step's own execution and caught in review — worth calling out explicitly since it's an easy trap.

**Who:** Haiku, once the two items above (env-var rendering approach, `registration_shared_secret` wiring) are resolved by Sonnet/Claude first — as written now, with both resolved, this step has no remaining judgment calls and is pure mechanical transcription.

**Data needed:** `specs/object_specs/matrix_synapse_module.md` (current version), Step 5/5c output (service names/credentials/env vars to reference), Step 7's output (`matrix/secrets/` file paths and names).

**Done when:** `matrix/homeserver.yaml.template` exists with every value above. `scripts/render-matrix-config.ts` exists and, given a real environment, renders a valid `matrix/homeserver.yaml` with every `${VAR}` resolved (test with dummy env values if real ones aren't available yet — confirm both the success path and the fail-fast-on-missing-var path). `docker-compose.yml`'s `synapse` service has the corrected `command:` override and mounts `./matrix/secrets:/data/secrets:ro`. `docker compose config` validates. `docker compose up synapse-postgres synapse` starts Synapse without a config-parse error once both scripts have been run (the module itself doesn't need to exist yet for this step — comment out the `modules:` block if needed and note that Step 8 re-enables it).

### Step 7: Generate and store Synapse signing keys and secrets

**What:** Generate the Synapse server's Ed25519 signing key and registration shared secret. Store them the way other secrets are handled in this repo — check `wallet-service/src/secrets/` for the existing pattern (`SECRETS_BACKEND=webcrypto` vs `kms`) and follow it rather than writing keys to a plain file checked into git. Add a `.gitignore` entry for any generated key material path.

**Who:** Sonnet — requires reading the existing secrets backend code to fit the pattern correctly rather than guessing.

**Data needed:** `wallet-service/src/secrets/backend.ts`, `wallet-service/src/secrets/webcrypto-backend.ts`, `wallet-service/src/secrets/kms-backend.ts`.

**Done when:** Signing key material is generated and stored via the existing secrets abstraction (or, if that's not a fit for Synapse's own key format, a documented equivalent pattern is used and the deviation is explained in a code comment). No key material is committed to the repository.

### Step 7b: Generate the watcher's Synapse admin-API token (added 2026-07-11)

**What:** The watcher (Step 11a) needs a Synapse admin-API token to perform force-part calls. Generate this token using the **same secrets pattern established in Step 7** — this is exactly the kind of one-off-convention risk the existing Step 15 checkpoint already warns about for the AS token, and it applies equally here.

**Who:** Sonnet.

**Data needed:** Step 7 output (pattern to reuse), Synapse admin API docs for the token's required scope (room membership management — confirm the minimum scope rather than granting a full admin token if Synapse's permission model allows narrower).

**Done when:** The token is generated and stored via the existing secrets abstraction; not committed to git; documented in the operator runbook (Step 21) as a credential that exists and what it's for.

### Step 7c: Generate the membership registry's encryption key (added 2026-07-11, persistence decision)

**What:** The membership registry (Step 12a, `matrix_join_attestation_and_revocation.md §2a`) is encrypted at rest. Generate its encryption key using the **same secrets pattern established in Step 7** — same caution as Step 7b: this is a new credential, and the whole point of Steps 7/7b/7c all reusing one pattern is that nobody has to re-derive "is this stored safely" from scratch per credential.

**Who:** Sonnet.

**Data needed:** Step 7 output (pattern to reuse).

**Done when:** The key is generated and stored via the existing secrets abstraction; not committed to git; documented in the operator runbook (Step 21) alongside the other two Matrix-specific credentials (AS token, watcher admin token).

---

### Phase 2 Milestone Review

**Context needed:** Steps 5–7b outputs.

**Check:**
- Does `docker compose up` start `synapse-postgres` and `synapse` cleanly alongside the existing `wallet-service` and its own `postgres`?
- Is Synapse's admin API reachable only from inside the Docker network (not published to the host), matching the "not client-facing" design goal? **This matters more than it did before 2026-07-11** — the admin API is no longer just an operator convenience, it's now something the watcher calls programmatically for force-part, so its exposure surface deserves the same scrutiny as any other internal-only credential path.
- Are all generated secrets (Synapse signing key, AS token pattern precedent, the watcher's admin token, and — new, 2026-07-11 — the membership registry's encryption key, Step 7c) handled through the existing secrets abstraction, with nothing sensitive committed to git?

**Done when:** Summary written to `plans/milestones/matrix-phase-2-summary.md`.

---

## Phase 3: Synapse Policy Module

*Goal: The Python module correctly allows/denies room join and message post based on real on-chain/IPFS card data, with revocation enforced by immediate force-part, not just future-post denial.*

### Step 8: Scaffold the module package

**What:** Create `matrix-policy-module/` as a standalone Python package:
```
matrix-policy-module/
  pyproject.toml       — package metadata, deps: web3, requests (or httpx), a websocket client
                          for the watcher (e.g. websockets or web3.py's own provider), synapse
                          (as a dev/type-check dep only)
  src/
    matrix_policy_module/
      __init__.py
      module.py         — the Synapse module entrypoint class, stubbed callbacks returning "allow" unconditionally
      config.py         — typed config dataclass, parses the modules: config block from Step 6
      rpc_client.py      — stub, filled in Step 9a (both HTTP and WS variants — see Step 9a)
      ipfs_client.py      — stub, filled in Step 9b
      predicates.py      — stub, filled in Step 9c
      chain_walk.py      — stub, filled in Step 10
      cache.py           — stub, filled in Step 11 (event-invalidated, not TTL-driven)
      attestation.py      — stub, filled in Step 12; verifies join attestations (signature, freshness, verifyMatrixUserIdBinding)
      watcher.py          — stub, filled in Step 11a; long-running CardHeadUpdated subscription + force-part
  test/
    __init__.py
```

**Note (2026-07-11):** this list replaces the original, which had no `attestation.py`/`watcher.py` and instead listed a `binding_client.py` (called `wallet-service`'s resolver — removed, no longer needed).

**Who:** Haiku.

**Data needed:** `specs/object_specs/matrix_synapse_module.md` (current package layout section — do not scaffold against the pre-2026-07-11 version).

**Done when:** `pip install -e matrix-policy-module` succeeds. The module loads in a local Synapse test instance (or `python -c "from matrix_policy_module.module import PolicyModule"` succeeds) with all callbacks present and returning permissive stub results.

### Step 9: Port the on-chain/IPFS read clients and predicate evaluator

**What:** Three sub-steps, each independently testable.

- **9a. RPC client (`rpc_client.py`).** A read-only Arbitrum client using `web3.py`, mirroring what `ARBITRUM_RPC_URL` / `REGISTRY_CONTRACT_ADDRESS` are used for in `wallet-service/src/config.ts` and wherever the TypeScript registry read calls live (find and read that code first — do not guess the contract ABI or call shape). Exposes a function to resolve a card hash's current log head CID from the registry contract. **Added 2026-07-11:** also exposes a WebSocket-subscription-capable interface (`arbitrum_rpc_ws_url`) for Step 11a's watcher to filter `CardHeadUpdated` events by address — this is a second connection type, not just a second URL, so budget for it as real scope, not a config-only change.

- **9b. IPFS client (`ipfs_client.py`).** Fetches a card document (or policy document) by CID from `IPFS_GATEWAY_URL`, mirroring `wallet-service/src/ipfs/fetch-subcard-document.ts`. Read that file first for the exact URL shape and error handling (timeouts, non-200 status, malformed JSON) before writing the Python equivalent.

- **9c. Predicate evaluator (`predicates.py`).** A direct, careful port of `card_protocol_spec.md §The Predicate System`: `any_of`/`all_of`/`none_of` combinators, and leaf predicates `issued_under_template`, `chain_includes`, `card_field_matches`, `is_holder`, `is_issuer`, `chain_depth_at_most`, `code_equals` (note: `code_equals` is only meaningful in `revocation_permissions` context, not room policy — implement it but document that room policies should not use it, per the spec's own scoping note). Every leaf predicate needs a corresponding unit test with both a true and a false case.

**Who:** Sonnet for 9a and 9b (requires reading and faithfully mirroring existing TypeScript). Haiku is acceptable for 9c *only if* Step 1's spec plus the direct quote from `card_protocol_spec.md` lines 138–186 is provided verbatim as context — the predicate grammar is fully specified there and this becomes a mechanical translation.

**Data needed:** `wallet-service/src/config.ts`, the TypeScript registry-read call site (locate via search — likely near `wallet-service/src/chain/subcard-registry.ts`), `wallet-service/src/ipfs/fetch-subcard-document.ts`, `card_protocol_spec.md` lines 138–186 verbatim.

**Done when:** All three modules have passing unit tests. The predicate evaluator's test suite covers every leaf predicate type and at least one nested combinator case (e.g. `all_of` containing an `any_of`). RPC and IPFS clients are tested against a local mock/fixture, not live network calls — **for 9a's WS variant, test against a mock event stream, not a live subscription.**

> **Checkpoint (revised 2026-07-11):** Before starting 9c, confirm the `watcher_backstop_interval_seconds` default and the force-part-on-every-revocation behavior (see the revised Clarification Checkpoint above) — the original checkpoint asked about a 60-second TTL that no longer exists.

### Step 10: Port the card chain walk

**What:** Implement `chain_walk.py`: given a card hash, walk its full chain (following the append-only log structure and any parent/issuer references) to produce the data structure the predicate evaluator in Step 9c needs to check `chain_includes`, `chain_depth_at_most`, and `card_field_matches` against. This must faithfully reproduce the logic in the existing TypeScript chain walk — **do not re-derive chain-walking semantics from the general spec alone**; read the actual verifier-side implementation and its plan first, since `plans/app-card-chain-walk-implementation-plan.md` documents a specific, hardened version of this logic (including the `app_card` certification fix) that a naive re-read of `card_protocol_spec.md` alone would miss.

**Added 2026-07-11:** the returned data structure must also include the **full list of every address visited during the walk** (the card's own address plus every ancestor address resolved via `ancestry_pubkeys`) — not just the pass/fail chain-walk result. This is a new requirement: Step 11a's watch-set construction (`matrix_join_attestation_and_revocation.md §3.2`) needs this list directly, and mirroring Stage 4's revocation check (which reads every card in the chain, not just the leaf) means the watcher has to watch the same set the walk already visits. If Step 10 is implemented from the pre-2026-07-11 spec text alone, this field will be missing.

**Who:** Sonnet — this is the highest-risk mechanical-translation step in the plan; a subtly wrong chain walk is a security hole, not a bug, so it should not go to Haiku even though the shape of the work (porting existing logic) looks mechanical.

**Data needed:** `plans/app-card-chain-walk-implementation-plan.md`, `plans/app-card-chain-walk-strategic-plan.md`, the TypeScript chain walk implementation in `client-sdk/packages/client-sdk/src` (locate exact file via search first), Step 9a/9b outputs (this step calls them).

**Done when:** Given a set of fixture card chains (including at least one that should fail `chain_includes`, one that should pass, and one exercising `app_card` certification), the Python chain walk produces results matching the TypeScript implementation's output on the same fixtures, **and the visited-address list matches the expected ancestor set for each fixture.** Consider generating the fixtures once in TypeScript and checking the same expected outputs into the Python test suite, so both implementations are tested against one shared source of truth.

> **Checkpoint:** Confirm with David that this step's output has been cross-checked against the real TypeScript chain walk, not just against the spec prose, before marking it done — **and confirm the visited-address list addition specifically**, since it's easy to treat as a footnote and miss.

### Step 11: Event-invalidated chain-walk cache

**What (rewritten 2026-07-11 — this step originally specified a simple TTL cache; that design is superseded):** Implement `cache.py`: an in-process cache keyed by `card_address`, storing the most recent chain-walk result. Unlike the original TTL design, this cache is **invalidated by the watcher (Step 11a)**, not by expiry — `get(card_address)` returns the cached value if present, and the watcher is responsible for calling `invalidate_and_refresh(card_address)` whenever a `CardHeadUpdated` event (or the backstop re-walk) indicates the cached value may be stale. A cache miss (address never walked before, e.g. a first-time joiner) triggers a synchronous chain walk via Step 10, same as the original design.

**Who:** Haiku — the cache itself is a straightforward keyed store; the complexity moved to Step 11a's watcher, which owns invalidation logic.

**Data needed:** Step 10's function signature (including the 2026-07-11 visited-address addition), `specs/process_specs/matrix_join_attestation_and_revocation.md §3`.

**Done when:** A unit test confirms a cache miss triggers a chain walk and populates the cache; a subsequent read for the same address returns the cached value without re-walking; an explicit `invalidate_and_refresh` call re-walks and updates the cached value.

### Step 11a: Watcher daemon (added 2026-07-11)

**What:** Implement `watcher.py`: a long-running process, started alongside the Synapse module (same container/process group), that:
1. Maintains the **watch-set**: a reference-counted union of every address (leaf + full ancestor chain, from Step 10's visited-address list) touched by any currently-active room membership. Addresses are added when Step 12's join hook admits a member, and removed when the last membership referencing that address ends (room leave or this step's own force-part).
2. Holds a push subscription (`arbitrum_rpc_ws_url`, via Step 9a's WS client) to the registry's **logic contract**'s `CardHeadUpdated` event, filtered to the current watch-set. Re-points the subscription on `LogicUpgradeConfirmed` (per `registry_contract.md §7`'s note that events are emitted by the logic contract, which is upgradeable).
3. On a matching event: calls `cache.invalidate_and_refresh(card_address)` (Step 11), then checks the refreshed chain-walk result for an 8xx/9xx entry on **any** card in that address's chain (not just the leaf). If found, calls **force-part** (below) for every room membership depending on that address.
4. **Force-part:** removes the affected Matrix account from the room via Synapse's admin API, using the token from Step 7b. Applies uniformly to every detected revocation, 8xx or 9xx — no severity-based branching (see the 2026-07-11 decisions section at the top of this document).
5. Runs a **backstop re-walk** on `watcher_backstop_interval_seconds` (default 3600) — independent of the event subscription, re-walks every address in the watch-set, to catch anything a missed or malformed event would otherwise miss.
6. On WebSocket disconnect or a detected gap in processed block numbers, performs a catch-up `eth_getLogs` query over the outage window before resuming the live subscription — join/post requests evaluated against cache data spanning an uncaught-up outage window are treated as stale (deny), per `matrix_join_attestation_and_revocation.md §3.3`.

**Who:** Sonnet — this is new, non-trivial concurrent/long-running-process logic with real failure modes (subscription loss, partial force-part failure) that need careful handling, not a mechanical port.

**Data needed:** `specs/process_specs/matrix_join_attestation_and_revocation.md §3` (full), Step 7b output (admin token), Step 9a output (WS client), Step 10 output (visited-address list), Step 11 output (cache interface).

**Done when:**
- A unit/integration test confirms: a `CardHeadUpdated` event for a watched address triggers a re-walk and, if the new chain data includes a revocation, a force-part call for every room membership depending on that address.
- A test confirms force-part is triggered identically for a fixture 8xx revocation and a fixture 9xx revocation — no code-range branching in the force-part decision.
- A test confirms a simulated subscription drop followed by a reconnect triggers a catch-up query covering the gap, and that requests evaluated during the gap (before catch-up completes) are denied.
- A test confirms the backstop interval re-walks the full watch-set and would catch a revocation whose event was (simulated as) missed entirely.
- A test confirms watch-set reference counting: an address is removed from the subscription filter once no active membership depends on it, and re-added if a new membership starts depending on it again.

### Step 12: Wire the join attestation and post hooks

**What (rewritten 2026-07-11):**
- **Join hook (`user_may_join_room`):** verify the client-presented join attestation via `attestation.py` — signature check, freshness check (`join_attestation_freshness_seconds`), `server_name` match, and `verifyMatrixUserIdBinding(card_hash, matrix_user_id, server_name)` against the Matrix user ID the callback reports as actually joining. **This replaces the original text's "card hash derived from the joining Matrix user ID via the inverse of the shadow-account derivation" — no such inverse exists** (`matrix_encryption.md §3` is explicit about this; the original Step 12 text was already inconsistent with its own referenced spec before the 2026-07-11 changes, and is corrected here rather than carried forward). On successful verification, resolve the room's `policy_id` from room state, call `cache.get(card_hash)` (Step 11; triggers a walk on miss), evaluate the predicate, allow or deny, and — on allow — register the card's chain (Step 10's visited-address list) in the watcher's watch-set (Step 11a).
- **Post hook:** uses **`check_event_for_spam`, not `check_event_allowed`** — `matrix_synapse_module.md §Callback Selection` already documents that Synapse's own module docs mark `check_event_allowed` as "very experimental," but the original text of this step still named it; corrected here. **Identity resolution differs from the join hook, corrected 2026-07-11 during Phase 1 review:** a post carries no attestation of its own, so `card_hash` is looked up from the membership registry (Step 12a) populated once at join — not re-verified via a fresh attestation, and not (re-)resolvable any other way (`matrix_join_attestation_and_revocation.md §2a`). A `(room_id, event.sender)` pair with no registry entry is a hard deny (`"membership_not_registered"`), not a fallback to some other resolution. Predicate evaluation itself, once `card_hash` is known, runs the same way as the join hook — every call, not cached at the room level (only the per-address chain-walk result is cached, per Step 11 — the `policy_id`-to-room lookup should be cheap and re-read from room state each time to avoid stale-policy bugs if a room's `m.card.policy` is ever updated).
- Every deny path logs `card_hash` (or, for a join-attestation failure specifically, no `card_hash` at all — see `matrix_join_attestation_and_revocation.md §3.3`'s `"attestation_invalid"` row), `room_id`, and the deny reason (not the full chain data), consistent with the protocol's existing "operators see metadata, not content" posture.

**Who:** Sonnet — integrates several prior steps and needs judgment about Synapse's actual module API call signatures.

**Data needed:** Steps 9–11a outputs, `specs/object_specs/matrix_synapse_module.md` (current), `specs/process_specs/matrix_room_membership.md`, `specs/process_specs/matrix_join_attestation_and_revocation.md`.

**Done when:** Against a local Synapse test instance (or Synapse's module test harness, if available) with a real fixture policy: a card with a valid attestation satisfying the policy can join and post; a card with an invalid or missing attestation cannot join regardless of chain eligibility; a card that doesn't satisfy the policy cannot join or post; a card whose chain changes to newly violate the policy is force-parted (per Step 11a) without a Synapse restart and without waiting on any polling interval.

### Step 12a: Wire force-part into the join/post module state (added 2026-07-11; scope widened during 2026-07-11 Phase 1 review)

**What:** Step 11a's watcher and Step 12's join/post hooks both need a shared, consistent view of "which room memberships currently depend on which addresses" — the join hook adds entries, the watcher's force-part removes them (and triggers the actual Synapse membership removal), and a room leave (a Matrix-level event independent of revocation) also has to remove entries or the watch-set leaks. Implement this as `membership_registry.py` per `matrix_synapse_module.md`'s package layout, read/written by both Step 11a and Step 12 rather than each maintaining its own partial view.

**This registry is not solely watch-set bookkeeping** (discovered during the 2026-07-11 Phase 1 milestone review, `matrix_join_attestation_and_revocation.md §2a`): it is also the **only** mechanism by which the post hook (Step 12) resolves `card_hash` for an already-joined member, since posts carry no attestation of their own and the shadow-account derivation has no inverse. It must therefore store, per membership, the full `(room_id, matrix_user_id) → card_hash` association — not just the set of watched addresses — and a lookup miss on this mapping is a hard deny for the post path, not only a watch-set inefficiency.

**Persistence: resolved 2026-07-11 by David — encrypted, persisted, not ephemeral.** A Synapse/module restart must not force a mass rejoin across every card-gated room. Implement as a local SQLite file (or equivalent) at `membership_registry_path` (`matrix_synapse_module.md`'s config), encrypted at rest using a key obtained through the **same secrets abstraction as Step 7/7b** (not a new key-management convention), with startup reconciliation against Synapse's live room-membership list — a Synapse-known membership with no registry entry (file loss/corruption, or predates this feature) denies that specific member's posts (`"membership_not_registered"`) until they rejoin, rather than blocking the whole room or silently starting empty. See `matrix_join_attestation_and_revocation.md §2a` for the full design and its stated threat model (protects against disk-only exposure, not a compromised running instance).

**Who:** Sonnet.

**Data needed:** Step 11a and Step 12 outputs (this step is integration glue between them), `matrix_join_attestation_and_revocation.md §2a`, Step 7's secrets-backend pattern (to reuse for the registry's encryption key).

**Done when:** A test confirms that after a card joins two rooms, then leaves one voluntarily, the watch-set still contains its addresses (still a member of the other room); after it's force-parted from the remaining room, the watch-set no longer contains its addresses (no active membership depends on them). A test confirms the post hook successfully resolves `card_hash` for a message from an already-joined member via this registry (no attestation re-verification). A test confirms a post from a `(room_id, sender)` pair with no registry entry is denied with `"membership_not_registered"`, not silently allowed or misattributed. **Added:** a test confirms the registry survives a simulated module restart (reload from the encrypted file, reconciled against a mock Synapse membership list) without losing any entry that was present before the restart, and that the file's contents are unreadable without the secrets-backend key.

---

### Phase 3 Milestone Review

**Context needed:** Steps 8–12a outputs, all Phase 1 spec documents.

**Check:**
- Does the module's behavior match `specs/process_specs/matrix_room_membership.md` §2/§5 and `matrix_join_attestation_and_revocation.md` exactly, including every deny-by-default failure case in both documents' failure tables?
- Is the chain walk verified against the real TypeScript implementation's output, not just spec prose (per Step 10's checkpoint), **including the visited-address list**?
- Are there any predicate types from `card_protocol_spec.md §The Predicate System` left unimplemented or untested?
- ~~Does revocation actually take effect within the documented TTL window in a live test?~~ **Revised:** does revocation trigger an immediate force-part in a live test (not just a future-post denial), for both an 8xx and a 9xx fixture, with no observable delay beyond event-propagation latency plus one chain re-walk?
- Does `check_event_for_spam` (not `check_event_allowed`) actually appear in the shipped module code?

**Done when:** Summary written to `plans/milestones/matrix-phase-3-summary.md`. Any gaps are fixed before Phase 4 begins.

---

## Phase 4: Wallet-Service Bridge (Application Service)

*Goal: A card holder can go from "authenticated to wallet-service" to "has a working, policy-gated Matrix account, can create/join rooms, and can discover which rooms their card qualifies for" without ever handling Matrix credentials directly.*

### Step 13: Define the shadow account derivation function

**What (corrected 2026-07-11):** Implement `wallet-service/src/matrix/account-id.ts`: a pure function `deriveMatrixUserId(cardHash: string, serverName: string): string` implementing the exact derivation specified in `specs/object_specs/matrix_encryption.md §3`. Also implement `verifyMatrixUserIdBinding(candidateCardHash: string, matrixUserId: string, serverName: string): boolean` — a **forward recomputation** (`deriveMatrixUserId(candidateCardHash, serverName) === matrixUserId`), not an inverse. **The original text of this step described a `matrixUserIdToCardHash` function that "extracts the card hash" from a bare Matrix user ID — no such function exists or should be implemented.** `matrix_encryption.md §3` is explicit that there is deliberately no general inverse (the derivation is a one-way commitment); the original Step 13 text was inconsistent with its own referenced spec, in the same way the original Step 12 was (see that step's 2026-07-11 note) — likely the same underlying misunderstanding propagated to both steps when first written. Both TypeScript (this step) and Python (Step 9c/12's `attestation.py`) must implement `verifyMatrixUserIdBinding` identically; a shared fixture file of `(card_hash, matrix_user_id, server_name, expected_bool)` triples — including negative cases — is what the two sides should be tested against, not a round-trip property (there is no round trip).

**Who:** Haiku — pure function against an exact spec.

**Data needed:** `specs/object_specs/matrix_encryption.md §3` (exact derivation and `verifyMatrixUserIdBinding` formula).

**Done when:** Unit tests confirm `verifyMatrixUserIdBinding` returns `true` for matching `(card_hash, matrix_user_id, server_name)` triples and `false` for at least one mismatched case (different card, different server name), and that the fixture file matches what the Python side (Step 12) expects. **No test asserts a round-trip or inverse property — if one exists in the test suite, it's testing something that shouldn't exist and should be removed.**

### Step 14: Application Service registration

**What:** Produce `wallet-service/matrix/appservice-registration.yaml` (the standard Matrix AS registration file format: `id`, `as_token`, `hs_token`, `namespaces.users` regex matching the shadow-account ID pattern from Step 13, `url` pointing at wallet-service's new AS endpoint from Step 15). Reference this file from `homeserver.yaml`'s `app_service_config_files:` (update Step 6's file). Generate `as_token`/`hs_token` via the same secrets pattern used in Step 7.

**Who:** Haiku for the YAML structure; the token generation/storage should follow Step 7's already-reviewed pattern.

**Data needed:** Step 13 output (namespace regex), Step 6 output (`homeserver.yaml` to update), Step 7 output (secrets pattern to reuse).

**Done when:** Synapse starts with the AS registration loaded (check Synapse startup logs for AS registration confirmation, no errors).

### Step 15: Wallet-service AS endpoint and account provisioning

**What:** Implement the wallet-service side of the Application Service protocol:

- **15a.** New route `wallet-service/server/routes/matrix/transactions/[txnId].put.ts` (or wherever this repo's routing convention puts AS transaction-push endpoints) implementing the minimal AS callback Synapse requires (`PUT /transactions/{txnId}` receiving pushed events — for this phase, the handler can simply acknowledge with `{}`; full event-driven bridge logic is out of scope for this pass since clients talk to Synapse directly for sync/send).
- **15b.** New function `provisionShadowAccount(cardHash, sessionToken)` in `wallet-service/src/matrix/provisioning.ts`: given an authenticated card holder (verified via the existing `requireSessionToken` helper from `wallet-service/server/utils/auth.ts`), calls Synapse's Client-Server `/register` endpoint with `type: m.login.application_service`, the derived user ID from Step 13, and the AS token from Step 14, to create the shadow account on first use. Idempotent — calling twice for the same card is a no-op success. **Note (2026-07-11): this remains wallet-service's only runtime role in the Matrix subsystem** — the join/post-time card-binding resolver originally implied as a future Phase 4 item in `matrix_synapse_module.md` is no longer needed (see the decisions section at the top of this document); do not build it.
- **15c.** New route `wallet-service/server/routes/matrix/token.post.ts`: given an authenticated card holder, mints (or returns a cached, still-valid) Matrix access token for their shadow account, so `client-sdk` can talk to Synapse's Client-Server API directly for sync/send without ever seeing the AS token itself.

**Who:** Sonnet — needs to fit the existing Nitro route conventions and auth helper correctly.

**Data needed:** `wallet-service/server/utils/auth.ts`, `wallet-service/src/auth/session-token.ts`, `wallet-service/server/routes/accounts-challenge.ts` (as a style reference for a similar auth-gated endpoint), Step 13 and 14 outputs.

**Done when:** An authenticated card holder can call `POST /matrix/token` and receive a working Matrix access token that successfully authenticates against Synapse's `/_matrix/client/v3/account/whoami` endpoint, resolving to the expected shadow user ID.

> **Checkpoint:** Confirm AS secrets (from Step 14) are stored via the existing secrets backend before this step is marked done — do not let a token end up in a plain env var or committed config.

### Step 16: Room creation endpoint

**What (amended 2026-07-11):** Implement `wallet-service/server/routes/matrix/rooms/index.post.ts` per the shape defined in `specs/object_specs/matrix_room.md`: given `{ card_hash, policy_id, name?, topic? }` from an authenticated card holder, this endpoint (a) provisions the creator's shadow account if needed (Step 15b), (b) calls Synapse's Client-Server `/createRoom` API as that shadow account, with `preset: private_chat`, `m.room.encryption` initial state set to `m.megolm.v1.aes-sha2` (per `matrix_encryption.md`), and an `m.card.policy` initial state event containing `{ policy_id }`, (c) **appends `{ room_id, policy_id, created_at }` to the public room index** (`specs/process_specs/room_discovery.md §1` — this is new; the original step had no awareness the index exists), (d) returns `{ room_id }`.

**Who:** Sonnet.

**Data needed:** `specs/object_specs/matrix_room.md`, `specs/object_specs/matrix_encryption.md`, `specs/process_specs/room_discovery.md §1`, Step 15 output.

**Done when:** A test call creates a room, and a subsequent Synapse Admin API query (or direct read via `synapse-postgres`) confirms the room has the correct `m.card.policy` and `m.room.encryption` state events set, **and a subsequent `GET /matrix/room-index` call (Step 16a) includes the new room.**

### Step 16a: Room index endpoint (added 2026-07-11)

**What:** Implement `wallet-service/server/routes/matrix/room-index.get.ts` per `specs/process_specs/room_discovery.md §1`: an **unauthenticated, publicly cacheable** endpoint returning `{ rooms: [{ room_id, policy_id, created_at }, ...], updated_at }`. Backed by whatever storage Step 16's append writes to (a dedicated table, or a simple flat file/KV entry — this doesn't need the durability guarantees of the card registry itself, since the room index is explicitly non-sensitive and reconstructable in principle from Synapse's own room list if ever lost). Set standard HTTP caching headers (this is identical for every requester by design — no per-user variation, so it's cache-friendly).

**Who:** Haiku.

**Data needed:** `specs/process_specs/room_discovery.md §1`, Step 16 output (the write side this reads from).

**Done when:** `GET /matrix/room-index` returns the expected shape with no authentication required; a room created via Step 16 appears in the response without needing a server restart.

### Step 16b: Client-side discovery library function (added 2026-07-11)

**What:** Implement `discoverRooms(cardHash, roomIndexUrl, ipfsGatewayUrl, arbitrumRpcUrl)` in `client-sdk/packages/client-sdk/src/matrix/discovery.ts`, per `specs/process_specs/room_discovery.md §2`: chain-walk the card (reusing the existing TypeScript chain walk, same one Step 10's Python port is checked against), fetch the room index (Step 16a), and for each `{room_id, policy_id}` entry, fetch and evaluate the predicate document using the **same evaluator semantics** `predicates.py` (Step 9c) uses server-side — `any_of` across `policies`, `issued_under_template` plus optional `card_field_matches` per entry. Return the list of eligible `room_id`s.

**Who:** Sonnet — needs to faithfully mirror the predicate evaluator's semantics from a different implementation (Step 9c is Python); consider whether a shared fixture set (policy documents + expected eligible/ineligible results) can be tested against both, the same pattern used for the chain walk (Step 10) and `verifyMatrixUserIdBinding` (Step 13).

**Data needed:** `specs/process_specs/room_discovery.md §2`, the existing TypeScript chain walk (Step 10's reference implementation), `specs/object_specs/matrix_room.md §The Room Predicate Document` (evaluator semantics).

**Done when:** Given a fixture room index and a fixture card chain, `discoverRooms` returns the expected room list, matching what Step 9c's evaluator would return for the same inputs server-side. **No network call in this function's implementation is authenticated or bound to the card's identity** — confirm this explicitly as an acceptance criterion, not just a design intent, since it's the whole point of the client-side default.

### Step 16c: Server-hosted discovery endpoint (added 2026-07-11, secondary/optional)

**What:** Implement `wallet-service/server/routes/matrix/discover-rooms.post.ts` per `specs/process_specs/room_discovery.md §3`: authenticated (existing session-token auth), runs the identical computation to Step 16b server-side, returns the eligible room list. **Constraints from the spec, not optional:** no persistent query log beyond a short-window abuse rate-limit counter; this endpoint is documented (in Step 21's runbook) as a fallback for clients that can't do local RPC/IPFS work, not a default path — `client-sdk` should attempt Step 16b first.

**Who:** Sonnet.

**Data needed:** `specs/process_specs/room_discovery.md §3`, Step 16a output (shares the room index), Step 9c-equivalent evaluator logic (this reimplements Step 16b's algorithm server-side in TypeScript — consider whether it can literally call the same code Step 16b uses, run server-side, rather than a third independent implementation).

**Done when:** An authenticated card holder gets the same result from `POST /matrix/discover-rooms` as `discoverRooms` (Step 16b) would compute locally for the same card and room index state; a query log inspection confirms only a rate-limit counter is retained, not a durable per-query record.

---

### Phase 4 Milestone Review

**Context needed:** Steps 13–16c outputs, Phase 3 outputs.

**Check:**
- Does `verifyMatrixUserIdBinding` agree exactly between the TypeScript (Step 13) and Python (Step 12/`attestation.py`) implementations, verified against the shared fixture file — and has any lingering "inverse function" code or test been confirmed absent from both sides?
- Can an authenticated card holder go end-to-end: get a token (Step 15c) → create a room (Step 16, now also writing the room index) → construct and the module accept their own join attestation (Step 17a below, since room creators are auto-joined and the "auto-join skips `user_may_join_room`" caveat from `matrix_synapse_module.md` still applies — confirm the creator's own attestation, if submitted, is still verified defensively) → appear correctly in `GET /matrix/room-index` (Step 16a) → be discoverable via both `discoverRooms` (Step 16b) and `POST /matrix/discover-rooms` (Step 16c)?
- Are all AS secrets, plus the new watcher admin token (Step 7b), confirmed stored via the existing secrets backend?
- Does Step 16c's query log genuinely contain no durable per-card record?

**Done when:** Summary written to `plans/milestones/matrix-phase-4-summary.md`.

---

## Phase 5: Client-SDK Integration

*Goal: A client can discover, join, and read/write in a room, talking to Synapse directly for the Matrix protocol parts.*

### Step 17: Evaluate and select the Matrix crypto binding

**What:** Research current options for a Megolm/Olm crypto implementation usable across `client-sdk` (Node/server-side use, if any), `client-sdk-web`, and `client-sdk-rn`. The leading candidate is `matrix-rust-sdk`'s crypto crate exposed via WASM (web) and native bindings (RN) — confirm current packaging status, bundle size impact, and whether a single crate can realistically target both, or whether two different bindings are needed per platform. Web-search current documentation; do not rely on possibly-stale training knowledge about this fast-moving ecosystem.

**Who:** Sonnet (research-heavy; needs live web search, not just repo context).

**Data needed:** `client-sdk/packages/client-sdk-web/package.json`, `client-sdk/packages/client-sdk-rn/package.json` (to check what's already there — e.g. `react-native-keychain` suggests native module tooling is already set up for RN).

**Done when:** A short decision writeup (`plans/milestones/matrix-crypto-binding-decision.md`) names the specific package(s)/version(s) for each target, with confirmed current bundle-size and platform-support facts, not assumptions.

> **Checkpoint:** Present this decision to David before writing any client-sdk code — this is the checkpoint flagged in the strategic plan as a real cross-platform build risk.

### Step 17a: Construct and sign the join attestation (added 2026-07-11)

**What:** In `client-sdk/packages/client-sdk/src/matrix/attestation.ts`, implement construction and signing of the join attestation object (`specs/process_specs/matrix_join_attestation_and_revocation.md §1`): `{ payload: { type: "room_join_attestation", card_hash, matrix_user_id, room_id, server_name, protocol_version, timestamp }, signatures: [...] }`, signed via the **same ML-DSA-44 signing call site** the rest of `client-sdk` already uses for message envelopes (reuse, don't reimplement — see `messaging_protocol.md §Common Envelope`'s existing signing path). This is independent of Step 17's crypto-binding decision (Megolm/Olm) — attestation signing uses the protocol's existing card-signature machinery, not Matrix's own crypto stack — so it doesn't need to wait on that checkpoint.

**Who:** Sonnet — touches the existing signing code path and must not diverge from it (same caution as the original Step 19, now Step 19 below, already called out for message signing).

**Data needed:** `specs/process_specs/matrix_join_attestation_and_revocation.md §1`, the existing ML-DSA-44 signing call site (locate via search — likely near `wallet-service/src/crypto.ts` or an equivalent in `client-sdk`), Step 13 output (`deriveMatrixUserId`, to populate `matrix_user_id` correctly before signing).

**Done when:** Given a card's signing key and a target `room_id`, the function produces an attestation that passes Step 12's server-side verification (signature, freshness, `verifyMatrixUserIdBinding`) against a running module instance; an attestation with a tampered `matrix_user_id` field is correctly rejected by the same verification (confirms the client can't accidentally or maliciously claim a different card's shadow account).

### Step 18: Wire Megolm session management

**What (amended 2026-07-11):** In `client-sdk/packages/client-sdk/src/matrix/` (new directory), implement the client-side session lifecycle using the binding chosen in Step 17: joining a room via a Matrix access token (from wallet-service Step 15c) **and the join attestation from Step 17a, attached to the join call** (exact wire transport is an open item in `matrix_join_attestation_and_revocation.md §1` — coordinate with however Step 12's server side expects to receive it once that's settled), establishing/receiving the room's Megolm session, and exposing `encryptRoomEvent(roomId, plaintext) -> ciphertextEvent` / `decryptRoomEvent(roomId, ciphertextEvent) -> plaintext`.

**Who:** Sonnet.

**Data needed:** Step 17's decision doc, Step 17a output, `specs/object_specs/matrix_encryption.md`.

**Done when:** Two test client instances (using the same shadow-account-derived credentials pattern, or two fixture cards) can exchange an encrypted message in a test room and both decrypt it correctly, **and joining without a valid attestation is confirmed to fail against the real module (Step 12), not just against a mock.**

### Step 19: Embed card signatures inside encrypted events

**What:** Wrap Step 18's `encryptRoomEvent`/`decryptRoomEvent` so that, before encryption, the plaintext is the card-signature envelope specified in `specs/object_specs/matrix_encryption.md` (built the same way `messaging_protocol.md`'s envelope is built — reuse `canonicalize()` and the existing ML-DSA-44 signing call site rather than writing a new one). On the sending side, the SDK must only ever sign with the card whose shadow-account Matrix session (Step 15c token) is being used to post — reject at the API boundary if a caller tries to pass a different signing card than the one the active room session belongs to.

On the receiving side, after decryption and before the message is surfaced to the caller, run two checks in order and reject (surface a clear, distinct error for each) on failure:
1. **Signature validity** — the embedded ML-DSA-44 signature verifies against the embedded public key, over the canonical payload (existing verification logic).
2. **Sender-binding check** — `verifyMatrixUserIdBinding(signer_card_hash, event.sender, server_name)` (Step 13's forward-verification function — **not** an inverse lookup; see Step 13's 2026-07-11 correction) holds for the card hash recovered from the verified signature in check 1. This is the "once revealed in a room, always signed by that card" enforcement from `matrix-strategic-plan.md §Goal 3` and `matrix_room_membership.md §5`. A message that passes check 1 but fails check 2 (valid signature, wrong card for this sender) must be treated as an attack, not a formatting error, and logged distinctly from an ordinary invalid-signature rejection.

**Who:** Sonnet — touches the existing signing code path and must not diverge from it.

**Data needed:** `specs/messaging_protocol.md §Common Envelope`, the existing signing call site (locate via search — likely near `wallet-service/src/crypto.ts` or an equivalent in `client-sdk`), `specs/object_specs/matrix_encryption.md`, Step 13 output (`verifyMatrixUserIdBinding`).

**Done when:** A message posted by one test card and read by another is confirmed both content-correct (decrypted) and signature-valid (card-verified). A tampered ciphertext is rejected. A message with a signature that doesn't verify is rejected. A message with a *valid* signature from a card other than the one implied by the Matrix sender ID (simulate by crafting a fixture event) is rejected specifically by the sender-binding check, with a distinct error/log signature from a plain invalid-signature rejection.

---

### Phase 5 Milestone Review

**Context needed:** Steps 17–19 outputs.

**Check:**
- Does the chosen crypto binding actually build and run on all three targets, not just the one it was prototyped on?
- Is signature verification actually enforced on decrypt (not just present in code but unreachable/unused)?
- Are there any plaintext leaks — does anything log the decrypted message body anywhere in the stack (Synapse, wallet-service, or client-sdk logs)?
- **Added 2026-07-11:** does joining without a valid attestation actually fail end-to-end (Step 18's done-when), and does `discoverRooms` (Step 16b) work from a real client-sdk build, not just the wallet-service-side test fixtures from Phase 4?

**Done when:** Summary written to `plans/milestones/matrix-phase-5-summary.md`.

---

## Phase 6: End-to-End Testing and Documentation

### Step 20: Integration test — full room lifecycle

**What (amended 2026-07-11):** `wallet-service/test/integration/matrix-room-lifecycle.test.ts` (or the repo's existing integration test location/convention): create a policy fixture, create a room under that policy (confirm it appears in the room index), have a satisfying card discover it (`discoverRooms`), join with a valid attestation and post, have a non-satisfying card attempt to join (expect denial), have a card with an invalid/missing attestation attempt to join (expect denial regardless of chain eligibility), revoke the satisfying card's qualifying credential and confirm **it is force-parted from the room immediately** (not just denied on next post) — test this for both an 8xx and a 9xx fixture revocation to confirm no severity-based branching exists.

**Who:** Sonnet.

**Data needed:** All prior phase outputs; existing test fixture patterns from `wallet-service/test/`.

**Done when:** All scenarios pass in CI (or locally via `docker compose up` + test runner) with no manual steps.

### Step 21: Write the operator runbook

**What (amended 2026-07-11):** `wallet-service/docs/matrix-operations.md` covering: what the Matrix component does (one paragraph, referencing `matrix-strategic-plan.md`), how to start/stop it, environment variables (table — now including `ARBITRUM_RPC_WS_URL`, `JOIN_ATTESTATION_FRESHNESS_SECONDS`, `WATCHER_BACKSTOP_INTERVAL_SECONDS`, and `MATRIX_MEMBERSHIP_REGISTRY_PATH`), how to create a card-gated room via the API, how to inspect the policy module's logs for a denied join/post and interpret the reason (including the `"attestation_invalid"` and `"membership_not_registered"` reasons), how to inspect the watcher's logs for a force-part event, what credentials exist and what each is for (Synapse signing key, AS token, the watcher's admin-API token from Step 7b, **and the membership registry's encryption key from Step 7c**), backup/restore for `synapse_pg_data` **and the membership registry's volume** (a restore must include both, or a restored Synapse with a stale/missing registry will deny posts from members it still lists), and an explicit statement of what is and isn't visible to the operator (drawn from Step 1 and Step 4's spec tables, **updated to reflect that a revoked card's room access is now cut off immediately rather than lingering until its next post, and to state plainly that the membership registry is real sensitive data this deployment now holds server-side — encrypted at rest, but readable by whoever runs the live instance, per the trust-model note added to this plan's Clarification Checkpoints**).

**Who:** Haiku, given the prior docs to summarize from — this is a synthesis-and-format task against fully-specified source material, not new design.

**Data needed:** All Phase 1 spec documents (all six), `wallet-service/docs/operations.md` (existing runbook, for house style).

**Done when:** A developer unfamiliar with the Matrix component can follow the doc to run it locally, create a room, discover it by card, diagnose a denied join (including an attestation failure specifically), and diagnose a force-part event, without reading any other document.

### Step 22: Final verification

**What (amended 2026-07-11):** End-to-end smoke test using `docker compose up`:
1. Start the full stack (wallet-service, its Postgres, relay, synapse, synapse-postgres) — confirm no errors, including the watcher process starting alongside the module.
2. Authenticate as a test card holder, call `POST /matrix/token`, confirm a valid Matrix token.
3. Create a policy-gated room via `POST /matrix/rooms`; confirm it appears in `GET /matrix/room-index`.
4. As a second, satisfying test card, run `discoverRooms` client-side and confirm the room appears in the result — **with no server call bound to that card's identity**, per `room_discovery.md`'s design intent (inspect network traffic during this step to confirm).
5. Join with a satisfying card via client-sdk, presenting a valid attestation — confirm success.
6. Attempt to join with a satisfying card but a **tampered or missing attestation** — confirm denial, distinct from a policy-based denial.
7. Join with a non-satisfying card (valid attestation, chain doesn't satisfy policy) — confirm denial with the expected reason logged.
8. Post an encrypted, card-signed message; confirm a second satisfying card can read and verify it.
9. Craft a fixture message signed by a different card than the one implied by its Matrix sender (simulating a compromised client trying to spoof identity within an already-joined session); confirm the receiving client's sender-binding check (Step 19) rejects it.
10. Revoke the first card's qualifying credential; confirm it is **force-parted from the room within roughly one event-propagation cycle** (not waiting for any polling interval), and confirm its Matrix account no longer appears in the room's membership list — not just that its next post would be denied.
11. Repeat step 10 with a 9xx-coded revocation instead of 8xx; confirm identical force-part behavior (no severity-based difference).
12. Restart the `synapse` container; confirm room state and message history survive (Postgres-backed), and confirm the watcher correctly rebuilds its watch-set from current room membership on restart rather than starting empty and missing existing members' revocation status until they next post.

**Who:** Claude (Sonnet) + David (confirm the operator-visibility claims in Step 21's doc match reality by inspecting `synapse-postgres` directly for a test message and confirming only ciphertext is visible; confirm step 4's "no server call bound to card identity" claim by inspecting actual network traffic, not just trusting the implementation's intent).

**Data needed:** All prior phase outputs.

**Done when:** All twelve smoke test steps pass. Any failures are fixed before marking the plan complete.
