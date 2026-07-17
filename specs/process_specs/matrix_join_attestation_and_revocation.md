# Matrix Join Attestation & Event-Driven Revocation — Process Spec

**Version:** 0.2 (draft, amended 2026-07-12)
**Date:** 2026-07-11 (amended 2026-07-12)
**Status:** Draft

**Amended 2026-07-12:** wire transport for the join attestation and the force-part mechanism were both resolved (see §1 and §3.1) — the attestation rides in the `m.room.member` join event's own content, verified inside `check_event_for_spam`, and force-part uses an in-process `ModuleApi.update_room_membership` call rather than a Synapse Admin API token.

**Changelog (spec-consistency Phase 2):** Fix #41 — reworded §2's opening line and the "Creator auto-join" paragraph to name `check_event_for_spam` as the triggering callback. Fix #42 — added an explicit rule for server-administrator-forced joins (no registry entry, deny-on-next-post accepted as intentional). Fix #44 — bumped header to 0.2 (draft, amended 2026-07-12) with this summary note. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changelog (spec-consistency Phase 3):** Tier 3 item (e) — added status notes to §2a and §3.1 clarifying that the watcher daemon and `MembershipRegistry.reconcile()` are built and unit-tested but not yet started/called from `PolicyModule.__init__`; a TODO is filed in `module.py` rather than this document continuing to describe the wiring as already running. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md`.

**Companion documents:** `specs/process_specs/matrix_room_membership.md`, `specs/object_specs/matrix_synapse_module.md`, `specs/object_specs/matrix_encryption.md`, `specs/object_specs/registry_contract.md §7 Events`

**This document supersedes `matrix_room_membership.md §1 step 2` (the wallet-service card-binding resolver call), `matrix_room_membership.md §3` (Card Cache and TTL) in full, and the "wallet-service unreachable" row of `matrix_room_membership.md §4`.** Those sections should be read as historical context for why the design changed, not current behavior — see the changelog note added to `matrix_room_membership.md`.

---

## Overview

Two changes to how the Synapse policy module authorizes room joins and detects revocation, both aimed at reducing what the module depends on and what it needs to be told rather than can verify itself:

1. **Join attestation.** The module no longer asks `wallet-service`'s internal card-binding resolver "which card does this Matrix ID belong to." Instead, the joining client presents a signed attestation, and the module verifies it directly using the same forward-verification primitive (`verifyMatrixUserIdBinding`, `matrix_encryption.md §3`) already used client-side for message receipt. This removes a live cross-service dependency and a failure mode (`wallet-service` unreachable → deny) that had nothing to do with the actual access-control question.
2. **Event-driven revocation.** The 60-second chain-walk TTL cache (`matrix_room_membership.md §3`) is replaced by a persistent subscription to the registry contract's `CardHeadUpdated` event, filtered to the set of addresses currently relevant to active room memberships. This resolves `registry_contract.md`'s **OQ-6** ("efficient log head change detection... polling vs. subscribing") — this module is the first concrete consumer that needs an answer.

Neither change touches the predicate evaluation logic itself (`matrix_room.md`'s predicate document, `issued_under_template`/`card_field_matches` semantics) or the post-time re-evaluation requirement (`matrix_room_membership.md §2`) — both are unchanged.

---

## 1. The Join Attestation

A card holder's client signs a short-lived statement asserting which card is about to join which room, under which shadow Matrix account. Reuses the existing envelope shape and signing machinery (`messaging_protocol.md §Common Envelope`, ML-DSA-44 over canonical RFC 8785 JSON — the same signing call site used everywhere else in the protocol) rather than inventing a new format.

```json
{
  "payload": {
    "type":             "room_join_attestation",
    "card_hash":         "<base64url — keccak256(recipient_pubkey); included for readability, not trusted>",
    "matrix_user_id":    "<the shadow-account Matrix ID the client is about to join with>",
    "room_id":           "<Matrix room ID being joined>",
    "server_name":       "<homeserver domain; must match the module's configured matrix_server_name>",
    "protocol_version":  "<string, same as elsewhere>",
    "timestamp":         "<ISO 8601>"
  },
  "signatures": [
    {
      "public_key":  "<ML-DSA-44 public key, base64url>",
      "signature":   "<ML-DSA-44 signature over canonical RFC 8785 JSON of payload, base64url>"
    }
  ]
}
```

- **`payload.card_hash` is never trusted at face value.** The module always recomputes `card_hash = keccak256(signatures[0].public_key)` and requires it to match the stated field — same discipline as every other signed statement in the protocol. A mismatch is treated as a malformed attestation (§3.3).
- **`payload.matrix_user_id` is self-declared, checked, not trusted.** The check is `verifyMatrixUserIdBinding(card_hash, payload.matrix_user_id, server_name)`, §2 step 4 below.
- **`server_name`** prevents an attestation minted against one deployment from being replayed against a different deployment running the same module code.
- **`timestamp`** is checked against a short freshness window (recommend a few minutes, consistent with other freshness checks in the protocol). This is a freshness bound, not a replay-nonce cache: a duplicate submission inside the window is harmless, since a join is idempotent — a second identical attestation just re-confirms membership the module already granted.

**Wire transport — resolved 2026-07-12.** The attestation rides as a custom, namespaced key (`io.cardprotocol.join_attestation`) in the `m.room.member` join event's own content. This was settled, not merely defaulted to, once Phase 3 implementation exposed a hard constraint the earlier candidates didn't account for: Synapse's `user_may_join_room(user, room, is_invited)` callback — the one the original design assumed would receive the attestation — has no parameter carrying arbitrary request content, so a custom `/join` request parameter can never reach it regardless of what the client sends; and a pre-join out-of-band call would reintroduce a stateful side-channel mapping, which is exactly what the join-attestation redesign eliminated in the first place. The event-content approach instead uses Matrix's existing extensibility (arbitrary additional event-content keys are permitted and ignored by clients that don't understand them) — the same mechanism MSC3083 (restricted rooms) already uses to carry a signed join authorization inside the join event itself, so this isn't a new protocol extension. Concretely: `user_may_join_room` becomes a permissive no-op (it structurally cannot see the attestation), and the actual authorization runs inside `check_event_for_spam` when it observes an `m.room.member` event with `content.membership == "join"` in a card-gated room — state events, including membership events, already pass through that callback per `matrix_synapse_module.md`'s own note. See `matrix_policy_module/module.py`'s `_authorize_join_event` for the implementation.

---

## 2. Revised Join Sequence (supersedes `matrix_room_membership.md §1`)

Triggered by `check_event_for_spam` observing an `m.room.member` event with `content.membership == "join"` in a card-gated room (`user_may_join_room` is now a permissive no-op — see §1's "Wire transport, resolved 2026-07-12" note and `matrix_synapse_module.md`'s "`user_may_join_room` — always a permissive no-op" section for why) — but step 2 no longer calls out to `wallet-service`.

1. Receive the join attestation alongside the join request.
2. **Verify the attestation signature.** Standard ML-DSA-44 verification over the canonical payload (`card_validation.md` Stage 1 mechanics, applied here). Recover `card_hash` from `signatures[0].public_key`.
3. **Verify freshness and deployment binding.** Reject if `payload.timestamp` is outside the freshness window, or `payload.server_name` doesn't match this module's configured `matrix_server_name`.
4. **Verify the sender-binding.** `verifyMatrixUserIdBinding(card_hash, payload.matrix_user_id, server_name)` must hold, and `payload.matrix_user_id` must equal the Matrix user ID Synapse's callback reports as actually attempting the join (the `user` parameter). Any mismatch is a hard deny. This is the exact same forward-recomputation check `matrix_encryption.md §4` already specifies for message receipt — applied here at join time instead of receive time, no new cryptographic machinery.
5. **Chain-walk the card**, unchanged in mechanics from `matrix_room_membership.md §1` step 3 — but now sourced from the event-driven cache (§3 below) rather than a TTL cache.
6. **Fetch and evaluate the predicate document** — unchanged, `matrix_room_membership.md §1` steps 4–5.
7. **Allow or deny** — unchanged.
8. **On allow, register the membership in the module's membership registry** (§2a) — `(room_id, matrix_user_id) → card_hash` — **and** register `card_hash`'s full chain (leaf + every ancestor address) in the event watcher's watch-set for this membership (§3.2). Both are new: previously nothing needed to happen here, since the TTL cache handled staleness implicitly on the next request, and a wallet-service query could always re-derive `card_hash` from `matrix_user_id` on demand.

`wallet-service` is not called anywhere in this sequence. Its only remaining role in the Matrix subsystem is shadow-account provisioning (Application Service bridge, at card-holder authentication) and room creation (`matrix_room.md §Room Creation`) — neither is in this module's runtime authorization path.

**Creator auto-join, carried over unchanged.** `matrix_synapse_module.md`'s existing note that neither `user_may_join_room` nor `check_event_for_spam` is invoked for a room creator's own auto-join still applies (Synapse does not run spam-checker callbacks for room-creation joins at all). A creator's attestation, if a client submits one anyway, can be verified defensively, but it isn't required — the creator is still trusted by virtue of having authenticated to `wallet-service` to create the room in the first place. **The creator's membership must still be entered into the membership registry (§2a)** — since their own join never reaches `check_event_for_spam`, whatever code path handles their auto-join has to register the entry directly (from the room-creation call's own known `card_hash`), or their first post would have no registry entry to resolve against.

**Server-administrator-forced joins — no membership-registry entry, deny-on-next-post accepted as intentional (new, Fix #42).** Distinct from the creator's own auto-join above: a server administrator can force a Matrix user into a room via Synapse's Admin API independently of any card-holder action. Per `matrix_synapse_module.md`'s "Known limitation" note, **neither** `user_may_join_room` nor `check_event_for_spam` fires for an admin-forced join, so such a join produces no membership-registry entry (§2a) — there is no join-time attestation, and no code path (unlike the creator's, which is driven by the known-`card_hash` room-creation call) has a `card_hash` to register on the admin's behalf. The account is a Matrix room member with no registry entry. Consistent with this document's deny-by-default posture (§2a, §3.3): **this is accepted, deliberate behavior, not a gap to close.** The account's next post hits the post-time membership-registry lookup (§2a step 3), finds no entry, and is denied (`"membership_not_registered"`) exactly as any other unregistered member would be. Admin-forced joins into card-gated rooms are therefore operationally pointless — they grant Matrix-level membership but no posting ability — and this document does not add a mechanism to register them; an administrator who wants a card holder to have working access to a card-gated room should have that holder join normally, through the attested join path.

---

## 2a. Post-Time Identity Resolution (new — not covered by the pre-2026-07-11 spec set)

**This is a gap in the original restructuring that this document did not previously address: nothing specified how `check_event_for_spam` (the post hook, `matrix_room_membership.md §2`) learns which card is posting, once the wallet-service resolver it used to call no longer exists.** The join attestation (§1) is presented once, at join time — there is no per-message attestation, and re-deriving `card_hash` from a bare Matrix user ID is exactly the operation `matrix_encryption.md §3` makes deliberately infeasible. Something has to answer this question at post time, and it isn't computation and isn't a fresh attestation.

**Resolution: the post hook looks up `card_hash` from the same membership registry the join hook populates (§2, step 8), keyed by `(room_id, matrix_user_id)`.** This is not a new component — `matrix_synapse_module.md`'s Step 12a already requires a shared membership registry for watch-set reference counting (tracking which memberships depend on which addresses, so an address can be dropped from the watch-set when the last dependent membership ends). That registry already necessarily associates a room membership with the `card_hash` whose chain is being watched on its behalf. Post-time resolution reuses that same association rather than introducing a second one:

1. On `check_event_for_spam`, look up `(event.room_id, event.sender)` in the membership registry.
2. **If found:** use the associated `card_hash` for chain-cache lookup (`matrix_room_membership.md §2` steps 3–6, unchanged) — no re-verification of the original attestation, no fresh signature check. The attestation was already verified once, at join; the registry entry is what carries that verified fact forward.
3. **If not found** (no registry entry for this `(room_id, sender)` pair): **deny.** This is a new failure mode, not an edge case to paper over — see §3.3's updated failure table.

**Why a missing registry entry must deny, not fall back to some other resolution:** the only two ways a room member could lack a registry entry are (a) they were never validly joined by this module (shouldn't be possible if Matrix's own membership state and this registry are kept consistent) or (b) the registry lost state it once had (see the persistence question immediately below). Neither case should be treated as "assume they're fine" — that would silently reintroduce exactly the fail-open risk the rest of this spec set works to avoid.

**Resolved 2026-07-11: the registry is persisted, encrypted at rest.** Not in-process memory only. A Synapse/module restart must not force a mass rejoin across every card-gated room — that availability cliff was judged unacceptable once it was visible as a real consequence, the same way the original TTL-cache-based revocation model was judged unacceptable once its read-access gap was worked through concretely (Goal 4's 2026-07-11 amendment, `matrix-strategic-plan.md`).

- **Storage:** a local encrypted store — a SQLite file (or equivalent) on a persistent volume mounted into the `synapse` container, distinct from Synapse's own Postgres (this is module-internal state, not Matrix protocol state; it doesn't belong in Synapse's schema). Rows: `(room_id, matrix_user_id, card_hash, joined_at)`.
- **Encryption:** the `card_hash` column (and, for simplicity, the row as a whole) is encrypted at rest using a key managed through the **same secrets abstraction already used for every other generated credential in this deployment** (`SECRETS_BACKEND` — webcrypto vs. KMS, per Step 7's pattern for the Synapse signing key) — not a new, one-off key-management scheme. The module holds the decryption key in memory for as long as it's running, the same way it already holds its RPC credentials.
- **On startup, reconcile against Synapse's own live room-membership list**, not just load-and-trust the persisted file: for each room-membership Synapse reports, confirm a corresponding registry entry exists. **Status (noted 2026-07-16): `MembershipRegistry.reconcile()` implementing this is built and unit-tested, but `PolicyModule.__init__` never calls it — see §3.1's status note above.** A membership Synapse still lists but the registry has no entry for (the file was lost, corrupted, or predates this feature) is treated exactly like any other registry miss (§4's `"membership_not_registered"` row, deny that specific member's posts until they rejoin) — this is a targeted, per-member gap, not the mass-rejoin-on-every-restart failure mode this design change exists to avoid. A registry entry for a room the member has since left (per Synapse) is pruned — no reason to retain a card-identity binding for a membership that no longer exists, consistent with the protocol's general data-minimization posture.
- **What this protects against, and what it doesn't — stated with the same honesty as `matrix_encryption.md §3`'s "honest limit" section:** encryption at rest protects this file's contents from a disk-only exposure — a stolen backup, a misconfigured volume snapshot exported elsewhere, a party with filesystem read access but no access to the running module process or its in-memory key. It does **not** protect against a compromised or malicious *running* Synapse deployment, which necessarily holds the decryption key in memory to do its job (verify posts, resolve identities) — the same limit every encryption-at-rest scheme in this protocol already has (e.g. `wallet-service`'s own secrets backend). **This registry is real sensitive data the Synapse operator's infrastructure now durably holds** (`(room_id, matrix_user_id, card_hash)` triples, for every currently-active membership, for as long as memberships persist) — a genuine expansion of what a card-gated Matrix deployment accumulates server-side, beyond the ciphertext-only Postgres contents Goal 4 originally described. An operator, or a community, that wants strong assurance this data is protected needs to trust (or be) whoever runs the `synapse` container and holds its secrets-backend key — the same trust boundary the rest of this deployment already asks for its other credentials, now extended to cover this registry too. This is the practical shape of "if you want this protected, run your own": encryption at rest raises the bar against passive/incidental exposure, but the operator of a running instance is still the party who can read this data, by design, because the alternative (the module being unable to resolve identity at all) breaks the feature.

---

## 3. Event-Driven Chain-Walk Cache (supersedes `matrix_room_membership.md §3`)

### 3.1 Watcher daemon

**Status (noted 2026-07-16, spec-consistency review): this daemon is implemented and unit-tested (`matrix_policy_module/watcher.py`'s `Watcher`, `rpc_provider.py`'s `CardHeadEventSubscription` over a real web3 WebSocket subscription to the registry contract's `CardHeadUpdated` event), but is not yet wired into the production entrypoint.** `matrix_policy_module/module.py`'s `PolicyModule.__init__` — the only entrypoint Synapse's module loader calls — does not currently construct or start a `Watcher`, and no other process or container starts one either; a TODO documenting the required wiring is filed at the construction site in `module.py`. Until that lands, everything below describes the intended, not-yet-running behavior. See `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (e).

A long-running process — not a Synapse callback, since callbacks are request-scoped and can't hold a persistent subscription. Runs alongside the Synapse module (same container/process group) and:

- Holds a push subscription (`eth_subscribe("logs", ...)` or equivalent) to the registry's **logic contract** (per `registry_contract.md §7`, all events are emitted by the logic contract, not storage — subscriptions must be re-pointed on `LogicUpgradeConfirmed`, same caveat the registry spec already calls out for other event consumers), filtered to `CardHeadUpdated` events where `card_address` is in the current watch-set (§3.2).
- On a matching event: refetch and re-walk **only the affected card's chain**, update the shared cache, and re-evaluate any membership or pending post that depends on that address. Note the contract does not distinguish revocations from ordinary updates in the event itself (`registry_contract.md §4.2`) — the watcher still has to fetch `new_log_cid` from IPFS and check for an 8xx/9xx entry, exactly as `card_validation.md` Stage 4 already specifies.
- **On any detected revocation — 8xx or 9xx, no distinction — the watcher immediately force-parts the affected Matrix account from every room whose policy it no longer satisfies**, via an in-process `ModuleApi.update_room_membership` call (resolved 2026-07-12 — there is no Synapse Admin API HTTP endpoint for this; see §3.1's note below), rather than waiting for the account's next post to be denied. This is a deliberate choice, not a default: passive next-post denial only blocks the revoked account from *posting* — it remains a room member and, per ordinary Matrix client behavior, would likely keep receiving new Megolm session keys and so keep *reading* messages sent after revocation. There's no expectation that a rejected card should still be able to read a room it no longer qualifies for, so read access is treated as the thing that has to be cut off immediately, and force-part (which removes membership, which is what actually stops future key distribution) is the only one of the two options that does that. This applies uniformly regardless of revocation code — `card_updates.md`'s 8xx ("quiet"/not-an-active-risk) vs. 9xx ("loud"/possible-risk-to-other-communities) distinction affects how the revocation is *signaled elsewhere* in the protocol, not whether room access is cut off here.
- Publishes updates to the module via shared in-process state, or a small IPC/shared-memory layer if the watcher runs as a sidecar rather than in the same process.

**Force-part mechanism, resolved 2026-07-12 (supersedes every "Synapse admin API" reference above and below):** there is no Synapse Admin API HTTP endpoint to force-remove a user from a room — the Room Membership admin API only forces a *join* (confirmed against current Synapse docs/source; a 2024 GitHub issue asking for exactly this, `element-hq/synapse#17885`, was closed "not planned"). Since the watcher runs in-process alongside the module, it uses `ModuleApi.update_room_membership(sender, target, room_id, new_membership, content=None) -> EventBase` (confirmed against current `synapse/module_api/__init__.py`) — a privileged in-process call, not an HTTP request, so **no admin token is needed** (the previously-planned "watcher's Synapse admin-API token" is unnecessary and should not be built). `update_room_membership` still enforces ordinary Matrix power-level auth on `sender`, so a dedicated enforcement account (not a card-holder's own shadow account) must be granted kick-level power in every card-gated room's initial `m.room.power_levels` at creation time — a new requirement on the room-creation endpoint, not something this watcher can retrofit after the fact.

### 3.2 Watch-set construction

The watch-set for a given room membership is **every address touched by that card's chain walk** — the card's own address, plus every ancestor address visited resolving `ancestry_pubkeys` up to the trusted root (`card_validation.md` Stage 3). This mirrors Stage 4's revocation check, which reads the log of *every* card in the chain, not only the leaf — an ancestor's revocation invalidates descendants too, so the watch-set has to cover ancestors or it would miss exactly the case that matters most.

The watch-set is a **single union across every currently-joined card in every card-gated room this server hosts** — one subscription filter, not one per room or per membership. It's reference-counted: an address stays in the watch-set as long as at least one active membership's chain includes it, and is removed when the last such membership ends (room leave, or a force-part per §3.1). This bounds the watch-set's size and lifetime to current membership rather than accumulating indefinitely — see the retention discussion carried over from the server-knowledge review.

### 3.3 Freshness and failure-mode guarantees (revises `matrix_room_membership.md §4`)

The event-driven model has to preserve the same deny-by-default posture the TTL model had — "faster and event-driven" can't mean "eventually consistent with no floor."

| Failure | Behavior |
|---|---|
| Join attestation fails signature check, freshness check, `server_name` check, or sender-binding check | Deny. Log `room_id`, the claimed `matrix_user_id`, and `"attestation_invalid"` — no `card_hash` is trusted yet at this point, so none is logged (same discipline as the removed `"card_binding_unresolvable"` case). |
| **Post-time membership-registry lookup (§2a) finds no entry for `(room_id, event.sender)`** | Deny. Log `room_id`, `event.sender`, and `"membership_not_registered"`. Do not fall back to any other resolution (no wallet-service query exists to fall back to, and re-deriving `card_hash` from the Matrix ID is infeasible by design). With the registry now persisted (§2a), this should be rare in practice — limited to a genuinely new member who hasn't joined yet, or a startup-reconciliation gap for a member whose entry was lost despite persistence (corruption, a pre-persistence-era membership) — rather than the routine post-every-restart occurrence it would have been under the in-memory-only design. |
| **Encrypted membership-registry file unreadable or its decryption key unavailable at startup** | The module must not start up able to authorize joins/posts while blind to its own membership state — treat this the same as any other "can't confirm my own config/state is correct" startup failure (§Module Config Schema's existing posture in `matrix_synapse_module.md`). Fail loudly at startup rather than starting with an empty registry and silently forcing every member to rejoin without operator visibility into why. |
| WebSocket subscription drops or a gap is detected in received block numbers | The watcher performs a catch-up `eth_getLogs` query over the outage window (last-known-processed block through current) for the full watch-set before resuming the live subscription. Any join or post evaluated using cache data spanning a known, not-yet-caught-up outage window is treated as stale — deny. |
| Coarse backstop re-walk (independent of events; recommended hourly — a correctness backstop now, not the primary mechanism) finds a discrepancy from cached state | Cache is corrected; this is not itself a deny condition, just confirms the event path didn't miss anything. If it *does* find a missed revocation, that membership is force-parted immediately per §3.1, the same as if the event had arrived on time. |
| Force-part call (`ModuleApi.update_room_membership`) fails (e.g. the enforcement account lacks sufficient power level in that room, or an internal Synapse error) | Retry with backoff; a failed force-part must not be treated as "handled." Until it succeeds, the affected account remains a room member (the underlying Matrix-level risk §3.1 exists to close), so post-time denial (`matrix_room_membership.md §2`, now sourced from the already-updated cache) still applies as a floor — a revoked card cannot post even if it hasn't yet been removed, but the read-access exposure this section exists to close persists until the retry succeeds. |
| RPC unreachable or errors during a triggered re-walk (event-driven or backstop) | Deny for any request evaluated against that card in the meantime — same handling as `matrix_room_membership.md §4`'s existing `rpc_unreachable` row, unchanged. |
| IPFS gateway timeout fetching chain content or the predicate document | Unchanged from `matrix_room_membership.md §4`. |
| Malformed chain data, malformed predicate document, predicate evaluator error | Unchanged from `matrix_room_membership.md §4`. |
| ~~`wallet-service` binding resolver unreachable~~ | **Removed.** No longer a dependency of the join or post path. |

**Backstop re-walk**, stated once more for emphasis: independent of the event subscription, every address in the watch-set is re-walked on a coarse interval (hourly is a reasonable default — far less frequent than the old 60-second TTL, since its job now is to catch a missed or malformed event, not to be the primary detection mechanism). This is what keeps the deny-by-default guarantee intact even if the event pipeline itself has a silent bug.

---

## 4. What This Changes About `matrix_synapse_module.md`

- `wallet_service_internal_url` and `wallet_service_module_shared_secret` are removed from the module's required config — nothing in the join or post path calls `wallet-service` anymore.
- `binding_client.py` is removed from the module package layout; its role is replaced by the attestation-verification logic in §2 (which needs no new file beyond what `predicates.py`/`chain_context.py` already provide — see `matrix_synapse_module.md`'s 2026-07-11 revision for why the latter is now a thin `membership-card-verifier` integration rather than a from-scratch chain walk — plus the signature/freshness checks, which can live in `module.py` or a new small `attestation.py`).
- New config and a new long-running watcher component are needed — see the companion edit to `matrix_synapse_module.md` for the concrete config schema and package layout changes.
- **A membership registry (`(room_id, matrix_user_id) → card_hash`) is required infrastructure, not an implementation detail of Step 12a alone** — §2a establishes that it is also the sole mechanism for post-time identity resolution, not just watch-set reference counting. It is **persisted, encrypted at rest** (resolved 2026-07-11, §2a), via the same secrets-backend pattern as every other credential in this deployment — this is new standing state the module owns, not just an in-process cache, and needs its own storage file/volume and config (see the companion edit to `matrix_synapse_module.md`).

---

## 5. Open Questions

- **Resolved 2026-07-11 — eager force-part on all revocations.** Every detected revocation (8xx and 9xx alike) triggers an immediate force-part, not just a future-post denial (§3.1). Decided on the basis that a rejected card shouldn't be expected to retain read access to a room it no longer qualifies for, and that this outweighs the lower-visibility/lower-disruption profile of passive denial for the "quiet" 8xx case.
- **Self-hosted vs. third-party Arbitrum RPC for the watcher subscription.** A third-party RPC provider (Alchemy, Infura, etc.) receiving this module's subscription filter list is handed, in one place, the full membership graph (as addresses) of every card-gated room this server hosts — a materially different exposure than the old per-request, per-card TTL lookups. Carried over from the server-knowledge review; not resolved by this document.
- ~~**Exact wire transport for the join attestation**~~ **Resolved 2026-07-12.** See §1's "Wire transport, resolved 2026-07-12" note — the attestation rides in the `m.room.member` join event's own content, verified in `check_event_for_spam`.
- ~~**Membership registry persistence across restarts (§2a, new).**~~ **Resolved 2026-07-11.** The registry is persisted, encrypted at rest, via the existing secrets-backend pattern, with startup reconciliation against Synapse's live membership list. See §2a.
- ~~**Force-part mechanism (which Synapse API performs it).**~~ **Resolved 2026-07-12.** There is no Synapse Admin API endpoint for this — confirmed against current docs/source/issue tracker. Force-part uses an in-process `ModuleApi.update_room_membership` call instead, with a dedicated enforcement account granted kick-level power in every card-gated room at creation time. See §3.1's "Force-part mechanism, resolved 2026-07-12" note. No admin token is needed — the previously-planned watcher admin-API token is unnecessary.

---

## Summary: What Changed

| | Before (`matrix_room_membership.md` v0.1) | After (this document) |
|---|---|---|
| How the module learns `card_hash` for a joining Matrix ID | Private query to `wallet-service`'s binding resolver | Self-verified from a signed attestation the client presents (`verifyMatrixUserIdBinding`) |
| How the module learns `card_hash` for a **posting** (already-joined) Matrix ID | Same private query, re-run per message | Looked up from the membership registry populated at join time (§2a) — no re-verification, no wallet-service call |
| Dependency on `wallet-service` at join/post time | Yes — deny on unreachable | None |
| Revocation detection latency | Up to 60s (TTL) after on-chain visibility | Near-immediate (event-driven), hourly backstop as a correctness floor |
| Chain-walk trigger | Every request past TTL expiry | Only on a `CardHeadUpdated` event for a watched address, or the backstop interval |
| Room access on revocation | Continues until the revoked card's next post is denied — membership and read access unaffected until then | Force-parted immediately on any detected revocation (8xx or 9xx) — membership and read access cut off at detection, not at next post |
| New standing infrastructure | None beyond the module itself | Watcher daemon; persistent RPC subscription; watch-set index; an in-process `ModuleApi.update_room_membership` call for force-part (no separate admin-API credential — resolved 2026-07-12) plus a dedicated enforcement account granted kick-level power in every card-gated room; **an encrypted, persisted membership registry (`(room_id, matrix_user_id) → card_hash`), surviving restarts** |
