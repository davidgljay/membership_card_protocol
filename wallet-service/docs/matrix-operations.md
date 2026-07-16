# Matrix Subsystem — Operator Runbook

**Status:** Same production-approval gate as `docs/operations.md` — this component is not yet cleared for production by CP-3's independent security review. This runbook documents how to deploy, configure, and operate the Matrix (Synapse) subsystem once that review clears, and reflects Phase 3–5 as actually shipped (see `plans/milestones/matrix-phase-{3,4,5}-summary.md`), not the original implementation plan text where the two have since diverged.

---

## What this is

The Matrix subsystem adds a single-node Synapse homeserver, containerized alongside `wallet-service`, that hosts card-gated group chat rooms — see `plans/matrix-strategic-plan.md` for the full goal set. In short: room membership and posting are gated by the protocol's existing predicate system (a room's `policy_id` is evaluated the same way any other policy is evaluated elsewhere in the protocol), every message is anchored to a card's ML-DSA-44 signature rather than trusting "whichever Matrix account posted this," and the Synapse operator is kept blind to message plaintext via native Matrix E2EE (Megolm) — but **not** blind to everything; see "What is and isn't visible to the operator" below. A card holder never sees or manages a Matrix account directly: a wallet-service-run Application Service provisions one deterministic shadow Matrix account per card, and `wallet-service`/`client-sdk` translate on the card holder's behalf. Federation (multiple Matrix operators) is explicitly out of scope for this pass — one operator, one Synapse instance.

---

## Starting and stopping the Matrix stack

Order matters. Unlike the plain `wallet-service` container, Synapse's config isn't populated by Docker Compose's own `${VAR}` substitution — Synapse has no native `${VAR}` templating for arbitrary config keys (confirmed against `matrix-org/synapse#11489`/`#7758`; only a narrow, fixed set of values gets substituted during Synapse's own `--generate-config` flow, which this deployment doesn't use). Two scripts have to run, in this order, before `docker compose up` touches `synapse`:

1. **`docker compose up postgres` first**, if you haven't already — `generate-matrix-secrets.ts` needs `DATABASE_URL` reachable (it records an encrypted audit/recovery copy of each generated credential into `wallet-service`'s own `matrix_credentials` table) and migrations must already be applied.
2. **`npx tsx scripts/generate-matrix-secrets.ts`** — generates Synapse's signing key, `registration_shared_secret`, the AS `as_token`/`hs_token`, and the membership registry's encryption key, and writes them under `matrix/secrets/` (gitignored). Idempotent to run again only in the sense that it overwrites; it does not detect or preserve an existing key set, so don't re-run it against a live deployment without understanding you're rotating every credential at once.
3. **`npx tsx scripts/render-matrix-config.ts`** — renders `matrix/homeserver.yaml` from `matrix/homeserver.yaml.template` and `matrix/appservice-registration.yaml` from its template, substituting both plain `.env` values and the two AS token files Step 2 just wrote. Must run after Step 2 (it reads `matrix/secrets/appservice-as-token.txt` / `appservice-hs-token.txt` directly) and must be re-run after any change to either template or to the env vars/secret files they reference.
4. **`docker compose up synapse`** (or `docker compose up` for the whole stack) — brings up `synapse-postgres`, then `synapse` (`depends_on`). The `synapse` service's `command` passes `--config-path=/data/homeserver.yaml --config-path=/data/secrets/registration-shared-secret.yaml` to Synapse's own `start.py run` entrypoint — both rendered/generated files from Steps 2–3 must already exist on disk (bind-mounted, not baked into the image) or Synapse fails to start.

**Stopping:** ordinary `docker compose down` (or `docker compose stop synapse synapse-postgres` for just the Matrix pieces). Synapse is never exposed on a host port — it's reachable only from `wallet-service`'s Application Service bridge over the internal `card-net` Docker network (`MATRIX_SYNAPSE_URL=http://synapse:8008`), plus the module's own outbound connection to `ARBITRUM_RPC_WS_URL` for the revocation watcher's subscription. There is no public client-facing Matrix port in this pass.

**Re-rendering config:** after editing `matrix/homeserver.yaml.template` or `matrix/appservice-registration.yaml.template`, or any `.env` value they reference, re-run Step 3 and restart the `synapse` container — the rendered `.yaml` files are not watched or hot-reloaded.

---

## Environment variables (Matrix-related)

Full canonical list with inline docs: `wallet-service/.env.example`. Transcribed here for the Matrix-specific subset:

| Variable | Purpose |
|---|---|
| `MATRIX_SYNAPSE_URL` | Base URL wallet-service uses to reach Synapse's Client-Server API as the Application Service — the `synapse` Compose service's internal hostname:port (`http://synapse:8008`). Not publicly exposed. |
| `MATRIX_SERVER_NAME` | The homeserver's own domain name, used in shadow-account derivation (`deriveMatrixUserId`) and join-attestation verification (the attestation's `server_name` check). Example: `matrix.internal` (dev), a real domain in production. |
| `ARBITRUM_RPC_WS_URL` | WebSocket-capable (or push-capable) Arbitrum RPC endpoint for the watcher daemon's `CardHeadUpdated` subscription. May differ from `ARBITRUM_RPC_URL` if HTTP/WS are split across providers, but must observe the same network/contract. **Note:** the subscription filter exposes this server's full membership graph (as addresses) to whichever provider serves this endpoint — see `matrix_join_attestation_and_revocation.md §3.2` on self-hosted vs. third-party RPC tradeoffs here. |
| `JOIN_ATTESTATION_FRESHNESS_SECONDS` | Join-attestation freshness window. Attestations older than this are rejected as stale. Default `300` (5 minutes). |
| `WATCHER_BACKSTOP_INTERVAL_SECONDS` | Interval at which the watcher re-walks every address in its watch-set as a correctness floor, independent of the live event subscription (catches a missed or malformed `CardHeadUpdated` event). Default `3600` (1 hour). |
| `MATRIX_MEMBERSHIP_REGISTRY_PATH` | Filesystem path (inside the `synapse` container) to the encrypted, persistent `(room_id, matrix_user_id) → card_hash` registry — also used for watcher watch-set bookkeeping. Must live on a volume distinct from Synapse's own Postgres. Default `/data/membership_registry`. |
| `MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH` | Path to the base64url-encoded AES-256 key (generated by `generate-matrix-secrets.ts`) used to encrypt/decrypt the membership registry at rest. Default `/data/secrets/membership-registry.key`. |
| `MATRIX_ENFORCEMENT_USER_ID` | Matrix user ID of the dedicated account the watcher uses as `sender` when force-parting a revoked member via `ModuleApi.update_room_membership`. **Not a secret** — it's an account identifier, not a token; see "Credentials" below for why no token exists for this. Every card-gated room `POST /matrix/rooms` creates must grant this account at least kick-level power in its `m.room.power_levels`, or future force-parts in that room fail with a permission error. Default `@matrix-policy-bot:matrix.internal`. |

Also relevant but shared with the rest of `wallet-service` (see `docs/operations.md`'s Configuration reference for these): `ARBITRUM_RPC_URL`, `REGISTRY_CONTRACT_ADDRESS`, `IPFS_GATEWAY_URL`, `SECRETS_BACKEND`/`WEBCRYPTO_MASTER_KEY` (used to encrypt the audit-trail copies `generate-matrix-secrets.ts` writes into `matrix_credentials`).

---

## Creating a card-gated room

`POST /matrix/rooms`, session-token authenticated (`specs/object_specs/matrix_room.md §Room Creation`; implementation: `wallet-service/server/routes/matrix/rooms/index.post.ts` + `src/matrix/room-creation.ts`).

**Request:**

```json
{
  "card_hash": "<the creating card's registry address>",
  "policy_id": "<CID of an existing room predicate document>",
  "name": "<optional>",
  "topic": "<optional>"
}
```

`card_hash` must equal the authenticated session's own `card_hash` — the route calls `assertCardHashBelongsToSession` and returns `403` otherwise; a caller can never create a room "as" a shadow account that isn't their own. `policy_id` is only parsed, not evaluated, at creation time — the Synapse module is the sole authority on evaluating it against a joining/posting card.

**Response:**

```json
{
  "room_id": "<Matrix room ID, e.g. !xyz:matrix.internal>",
  "matrix_alias": "<optional>"
}
```

The room is registered into a public room index (`matrix_room_index` table, served read-only via `GET /matrix/room-index`) so cards can discover which rooms they qualify for (`specs/process_specs/room_discovery.md`) — it is not listed in Matrix's own public room directory.

**The power-level grant, and why it's not optional.** As of 2026-07-12, room creation must include an `m.room.power_levels` initial-state event that grants `MATRIX_ENFORCEMENT_USER_ID` at least kick-level power (`ROOM_KICK_POWER_LEVEL = 50` in `room-creation.ts`), alongside the creator at the normal owner level (100). This is load-bearing, not defensive boilerplate: the revocation watcher force-removes a revoked card's shadow account via an in-process `ModuleApi.update_room_membership(sender=<enforcement account>, ..., new_membership="leave")` call, and that call still runs through Synapse's ordinary Matrix power-level authorization on its `sender`. **Without this grant, every future force-part attempt in that room fails with a permission error**, and the room falls back to the weaker "deny future posts" enforcement floor instead of actually cutting off read access (see "What is and isn't visible" below). Because supplying an `initial_state` power-levels event *replaces* rather than merges with Synapse's `private_chat` preset defaults, `room-creation.ts` explicitly re-states the creator's ownership level alongside the enforcement grant — if you ever hand-construct a `createRoom` call outside this code path, you must do the same or the creator silently loses room-owner power.

If you ever see force-part failures in the watcher's logs (below) for a specific room, the first thing to check is whether that room's `m.room.power_levels` actually grants `MATRIX_ENFORCEMENT_USER_ID` kick-level power — a room created by any path other than `POST /matrix/rooms` (or one whose power levels were later edited) can silently lack this.

---

## Reading the policy module's logs: denied joins and posts

The policy module (`matrix-policy-module/src/matrix_policy_module/module.py`) logs every deny at `INFO` (predicate/attestation failures) or `WARNING` (unreachable dependencies), always including `room_id` and the acting `matrix_user_id`/`event.sender`. The exact log-call shapes, as shipped:

- **Join denied, no attestation presented:**
  `logger.info("join denied for %s in %s: no attestation presented", matrix_user_id, room_id)`
- **Join denied, attestation invalid** (bad signature, stale, wrong `server_name`, or sender-binding mismatch — all collapse to the same reason):
  `logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, attestation.deny_reason)` where `attestation.deny_reason` is the literal string `"attestation_invalid"` (set uniformly in `attestation.py` for every one of those failure modes — the log line does not distinguish which specific check failed).
- **Join denied, room has no `m.card.policy` state:**
  `logger.warning("join denied for %s in %s: room has no m.card.policy state", matrix_user_id, room_id)`
- **Join or post denied, predicate document unreachable (IPFS fetch failed):**
  `logger.warning("join denied for %s in %s: predicate document unreachable", ...)` / `logger.warning("post denied for %s in %s: predicate document unreachable", ...)`
- **Join or post denied, predicate evaluated and failed, or the evaluator itself threw:**
  `logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, reason)` / the post-time equivalent, where `reason` is `"policy_violation"` (predicate ran, returned `False`) or `"evaluation_error"` (the evaluator raised an exception, caught by `_safe_evaluate_predicate` and denied rather than allowed to propagate out of a Synapse callback with undefined consequences).
- **Post denied, no membership-registry entry for `(room_id, event.sender)`:**
  `logger.info("post denied for %s in %s: membership_not_registered", matrix_user_id, room_id)` — this is the post-time identity-resolution path (`matrix_join_attestation_and_revocation.md §2a`); with the registry now persisted across restarts, this should be rare — limited to a genuinely new member who hasn't joined yet, or a startup-reconciliation gap for an entry lost despite persistence.
- **Post denied, card revoked (registry resolved a card_hash, but the chain-walk cache shows it revoked):**
  `logger.info("post denied for %s in %s: card revoked", matrix_user_id, room_id)`

To triage a specific denial: grep Synapse's log output for the `matrix_user_id` or `room_id` in question, read the trailing reason string, and cross-reference against the table above. `"attestation_invalid"` and `"membership_not_registered"` are both terminal, expected-shape denials — no further chain-walk or predicate evaluation ran. `"policy_violation"` and `"evaluation_error"` mean the module got as far as fetching the predicate document and actually evaluating it; `"evaluation_error"` specifically warrants investigating the predicate document's content or the evaluator itself, since it means something threw rather than cleanly returning `False`.

---

## Reading the watcher's logs: force-part events

The watcher (`matrix-policy-module/src/matrix_policy_module/watcher.py`) does not log a distinct "force-part succeeded" line — success is silent (the registry is updated and the function returns). What it does log:

- **A force-part attempt failed, will retry** (exponential backoff, up to `force_part_max_retries`, default 5):
  `logger.warning("force-part failed for %s in %s (attempt %d/%d); retrying", matrix_user_id, room_id, attempt + 1, self._force_part_max_retries)`
- **A force-part permanently failed** (exhausted all retries):
  `logger.error("force-part permanently failed for %s in %s after %d attempts — post-time denial (module.py) remains the only enforcement floor until this succeeds", matrix_user_id, room_id, self._force_part_max_retries)`

Any occurrence of the `error`-level line above should be treated as a real operational incident: it means a revoked card's shadow account is still a room member — read access (via Megolm key distribution) may not have been cut off, and the only thing still protecting the room is the post-time `check_event_for_spam` deny (which stops the account from *posting*, not from *reading*). The single most common root cause is the power-level grant described above (`MATRIX_ENFORCEMENT_USER_ID` lacking kick-level power in that specific room) — check that first. A silent absence of both the warning and error lines for a room you expect activity in is not itself informative (it just means no revocation was detected); use the module's join/post logs and the room's current membership list to confirm a specific card's status if you need to check proactively rather than reactively.

---

## Credentials

`scripts/generate-matrix-secrets.ts` generates and stores (as gitignored files under `matrix/secrets/`, plus an encrypted audit/recovery row in `wallet-service`'s own `matrix_credentials` table via the existing `SecretsService`) the following:

| Credential | File | Purpose |
|---|---|---|
| Synapse signing key | `matrix/secrets/homeserver.signing.key` | Synapse's own Ed25519 event-signing key, read natively via `homeserver.yaml`'s `signing_key_path`. |
| `registration_shared_secret` | `matrix/secrets/registration-shared-secret.{yaml,txt}` | Synapse's shared secret for its own registration-secret-authenticated flows; passed as a second `--config-path` alongside `homeserver.yaml` (Synapse's config schema has no `_path` variant for this key, unlike the signing key). |
| Application Service `as_token` | `matrix/secrets/appservice-as-token.txt` | What `wallet-service` presents to Synapse's Client-Server API when acting as the Application Service (shadow-account provisioning, room creation on a card's behalf). |
| Application Service `hs_token` | `matrix/secrets/appservice-hs-token.txt` | What Synapse presents back to `wallet-service`'s AS transaction-push endpoint (`PUT /matrix/transactions/{txnId}`) so it can authenticate inbound calls. |
| Membership registry encryption key | `matrix/secrets/membership-registry.key` | 32 raw random bytes, base64url-encoded — AES-256 key the Python policy module uses to encrypt/decrypt the persistent `(room_id, matrix_user_id) → card_hash` registry at rest. |

**There is no watcher admin token, and none is needed.** An earlier design (implementation-plan.md's original Step 7b) assumed the watcher would need a Synapse server-admin API token to force-remove a revoked member from a room. That assumption was checked against current Synapse docs/source/issue tracker on 2026-07-12 and found wrong: Synapse's Admin API has no HTTP endpoint to force-remove a user from a room at all (`element-hq/synapse#17885`, filed for exactly this, closed "not planned"). Since the watcher runs in-process alongside the policy module, force-part instead uses `ModuleApi.update_room_membership(...)` — a privileged in-process call, not an HTTP request — which needs only an *account identifier* with sufficient room-level power (`MATRIX_ENFORCEMENT_USER_ID`, see above), not a bearer token of any kind. `.env.example` documents this explicitly: "Not a secret — there is no Synapse Admin API endpoint for force-removing a room member, so this is an in-process privileged call requiring no token."

**Known inconsistency worth flagging to whoever next touches `generate-matrix-secrets.ts`:** the script as currently shipped still generates a sixth file, `matrix/secrets/watcher-credential.json` (a login password for a `matrix-watcher-bot` account, under the heading "Step 7b: watcher's Synapse login credential"), left over from the pre-2026-07-12 design. Nothing in the current codebase reads this file — `watcher.py`'s `ModuleApiForcePartClient` uses `MATRIX_ENFORCEMENT_USER_ID` directly and has no login step, and no other module references `watcher-credential.json` or `matrix-watcher-bot`. It appears the script's Step 7b block was never removed when the design changed. It's harmless (an unused generated secret, still recorded to the audit table) but should not be treated as part of the real credential set, and is a good candidate for cleanup.

---

## Backup and restore

Two volumes must be backed up together, and restored together — restoring one without the other produces a broken deployment, not just a degraded one:

- **`synapse_pg_data`** — Synapse's own Postgres data (room state, event history, device/E2EE metadata). This is the volume backing the `synapse-postgres` service.
- **`synapse_membership_registry`** — the encrypted, persistent `(room_id, matrix_user_id) → card_hash` registry (plus watch-set bookkeeping), mounted at `MATRIX_MEMBERSHIP_REGISTRY_PATH` inside the `synapse` container.

(`synapse_media` — uploaded media/attachments — and `wallet_pg_data` — unrelated to Matrix — are also named volumes in `docker-compose.yml`, but are not part of this specific must-restore-together pair.)

**Why both, explicitly:** if you restore `synapse_pg_data` from a backup without restoring a matching `synapse_membership_registry` (e.g., you restore Postgres but leave the registry at its current, more up-to-date state, or vice versa), the two stores disagree about who is actually a member of what. A restored Synapse that still lists a room member Postgres-side, but whose registry no longer has (or never had) that member's `(room_id, matrix_user_id) → card_hash` entry, will deny that member's posts as `membership_not_registered` even though they're still a Matrix-level room member — and conversely, a registry entry for a membership Postgres no longer reports gets pruned at startup reconciliation, silently dropping watch-set coverage for that card. Neither failure mode is a crash; both are silent, incorrect enforcement behavior that's easy to miss until someone reports being denied for no visible reason. Always restore both volumes from the same point-in-time backup pair, and let the module's startup reconciliation (which checks its registry against Synapse's own live membership list) run before assuming the restore is complete.

The Synapse signing key, `registration_shared_secret`, AS tokens, and membership-registry encryption key (`matrix/secrets/`) are not part of either volume — they're host filesystem files outside Docker's volume boundary and must be backed up separately (or regenerated, which invalidates every existing room membership's registry entries and the AS's ability to act — regenerating in place of restoring is a last resort, not a routine option).

---

## What is and isn't visible to the operator

This section is deliberately blunt, matching `specs/object_specs/matrix_synapse_module.md` and `specs/process_specs/matrix_join_attestation_and_revocation.md §2a`'s own stated posture — this is not a "no one can ever see this" system, and presenting it as one to anyone deciding whether to rely on this deployment would be dishonest.

**What's visible to the Synapse operator** (per `matrix_room.md §What the Synapse Operator Can See`): room IDs, creation/join/leave timestamps, the `m.card.policy` state event (the `policy_id` CID itself — not necessarily the predicate content, though that content is public IPFS data anyone could fetch), and room membership as Matrix user IDs (a one-way commitment of `card_hash`, not invertible by a Synapse-only observer). **Not visible:** message plaintext, reactions, attachments (Megolm-encrypted), or the card signature embedded inside a message body (also inside the encrypted content).

**On revocation, access is cut off immediately, not lazily.** A card that's revoked does not linger as a room member until its next post is denied. The watcher force-parts it out of the room the moment a revocation is detected (event-driven via the registry contract's `CardHeadUpdated` subscription, with an hourly backstop re-walk as a correctness floor) — this was a deliberate 2026-07-11 design decision specifically because a revoked-but-still-a-member account would otherwise keep receiving new Megolm session keys under ordinary client behavior, and so keep reading messages sent after its revocation. Passive "deny future posts only" enforcement remains the floor while a force-part is retrying (see the watcher log section above), but it is the fallback, not the intended steady state.

**The membership registry is real sensitive server-side data, not just bookkeeping.** `(room_id, matrix_user_id, card_hash)` triples, for every currently-active membership, are held durably by this deployment — a genuine expansion beyond "Synapse's Postgres stores only ciphertext." It is encrypted at rest, using the same secrets-backend pattern as every other credential here. That encryption protects against a passive or incidental exposure — a stolen disk snapshot, a misconfigured backup pulled elsewhere. **It does not, and cannot, protect this data from whoever operates the live Synapse instance holding the decryption key** — the running module necessarily holds that key in memory to do its job (resolve identity on every post, verify joins), the same limit every encryption-at-rest scheme in this protocol already has. The property this deployment actually provides is "an honest, encryption-at-rest-practicing operator can't be casually read by a passive third party" — not "no operator, including the one running this instance, can ever see this." Anyone who needs stronger assurance than "trust the operator" needs to run, or fully control, their own Synapse instance.

---

## Known gaps (carried from Phase 3–5 milestone summaries)

- **Room-policy state read is unconfirmed.** The exact Synapse `ModuleApi` call for reading a room's live `m.card.policy` state event content was never confirmed against current Synapse docs (unlike `check_event_for_spam` vs. `check_event_allowed`, which was). `_resolve_policy_id` currently can't distinguish "room genuinely has no policy" (should pass through) from "state read failed" (should deny) — both collapse to the same `None` today. Isolated behind the `RoomPolicyResolver` interface, but worth resolving before relying on this in production.
- **`wallet-service`'s server-side room discovery (`POST /matrix/discover-rooms`) has no production `RpcProvider` wired.** `discoverEligibleRooms`'s algorithm is fully implemented and tested against an injected verifier, but the production wiring seam (`src/matrix/card-chain-verifier.ts`) throws `CardChainVerifierNotConfiguredError` until a full `RpcProvider` implementation (mirroring `press/src/context.ts` or the Python module's already-complete `rpc_provider.py`) is ported to TypeScript. Client-side discovery (`client-sdk`'s `discoverRooms`) does not have this gap — it runs against a real `CardVerifier` end-to-end.
- **`client-sdk-rn`'s Matrix crypto is an honest scaffold, not a working implementation.** `UnimplementedRNMegolmCryptoProvider` throws on every method by design — the actual native crypto module (Rust cross-compilation, `uniffi-bindgen-react-native` codegen, iOS/Android Turbo Module packaging) is unbuilt. Web (`client-sdk-web`, via `@matrix-org/matrix-sdk-crypto-wasm`) is a real, tested implementation; React Native is not yet usable for encrypted Matrix rooms.
- **No live-Synapse end-to-end testing has been run against this stack.** Every Phase 3–5 claim about join-attestation rejection, force-part behavior, etc., has been verified against unit tests and mock servers, not a real `docker compose up` stack with a live Synapse + `matrix-policy-module` — this sandbox never had Docker available during implementation. This should be the first thing re-verified against a real deployment before relying on this runbook's log-message guidance in production.
- **`matrix/secrets/watcher-credential.json`** — see the Credentials section above; generated but unused, a leftover of the pre-2026-07-12 design.
