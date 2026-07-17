# Matrix Server — Strategic Plan

**Date:** 2026-07-10 (amended 2026-07-11)
**Status:** Draft
**Companion document:** [matrix-implementation-plan.md](./matrix-implementation-plan.md)
**Source note:** `raw_notes/matrix.md` — treated as inspiration, not spec. It was written without a real understanding of the protocol as built (it assumes a P2P/DHT wallet layer, a hand-rolled hybrid-AES encryption scheme, and an ad hoc `m.card.policy` predicate language, none of which match `card_protocol_spec.md` or the implemented `wallet-service`). This plan reconciles the note's intent — card-gated Matrix rooms, server operators blind to content — with the protocol as it actually exists today.

**Amended 2026-07-11:** Following a review of how much the module actually needs to depend on and be told (vs. verify itself), two mechanism changes and one new goal were added: join authorization moved from a live `wallet-service` resolver call to a client-presented signed attestation; revocation detection moved from a 60-second TTL cache to an event-driven watcher that also force-parts a revoked card immediately, on every revocation, rather than only denying its next post; and a sixth goal (card-based room discovery) was added, since nothing in the original five goals gave a card holder a way to learn which rooms their card qualifies for. See `specs/process_specs/matrix_join_attestation_and_revocation.md` and `specs/process_specs/room_discovery.md` for the full mechanism specs — this document reflects only the goal- and rationale-level implications.

---

## Goals

### 1. Stand up a single-node Matrix (Synapse) deployment as a new component of the protocol

Add a Synapse homeserver, containerized alongside the existing `wallet-service`, that can hold room state and message history for card-gated group chat. This is infrastructure only in this pass — one operator, no cross-server federation yet. Multi-operator federation (raw_notes/matrix.md's "Federation" section) is explicitly deferred to a follow-on plan.

### 2. Gate room membership and posting with the protocol's existing predicate system, not a new one

`raw_notes/matrix.md` invents an `m.card.policy` predicate grammar (`any_of` / `issued_by` / `inherits_from`) that duplicates, imperfectly, the predicate system already specified in `card_protocol_spec.md §The Predicate System` (`any_of`/`all_of`/`none_of` combinators over `issued_under_template`, `chain_includes`, `card_field_matches`, `is_holder`, `is_issuer`, `chain_depth_at_most`). A Matrix room's access policy should be a `policy_id` evaluated by the same predicate engine every other protocol surface uses — not a parallel implementation that can drift out of sync or be independently exploited.

### 3. Preserve the protocol's identity and non-repudiation model inside Matrix rooms

Every message elsewhere in the protocol carries an ML-DSA-44 signature over a canonical (RFC 8785) payload, addressed by card hash (`keccak256(pubkey)`), per `messaging_protocol.md`. A card-gated Matrix room must not become a side channel where messages are only as authentic as "whichever Matrix account posted this." Card signatures must remain the source of truth for who said what, with Matrix accounts as a thin, bridge-managed shadow of card identity — not the other way around.

**Every message in a room must be signed by a card, and once a card has joined or been revealed in a room, every subsequent message attributed to that participant in that room must be signed by that same card.** A card holder may hold several cards, but within a single room, identity is not permitted to drift message-to-message between different cards they hold — the card that entered the room is the card that speaks in it. Because shadow Matrix accounts are derived 1:1 from `card_hash` (Goal 3's identity model), this is enforceable even under E2EE: recipients verify, on decrypt, that the embedded card signature's card hash matches the card hash derivable from the message's Matrix sender ID. A mismatch — a message whose Matrix sender resolves to card A but whose embedded signature is from card B — is rejected by receiving clients, not silently accepted. This check must live client-side, since the Synapse operator cannot decrypt Megolm content to enforce it server-side; server-side enforcement is limited to the structural guarantee (one Matrix account per card) established in Goal 3.

### 4. Keep Synapse operators blind to plaintext, consistent with the rest of the protocol's trust model

The protocol's design goal (per `ARCHITECTURE.md` and `message_routing.md`) is that infrastructure operators see routing metadata but not content. Whatever encryption approach is chosen for Matrix rooms must uphold that same property for the Synapse operator, without requiring the protocol to reinvent E2EE cryptography that Matrix's own client libraries already implement and have been audited.

### 5. Fit the existing deployment and operational patterns of the protocol's other services

`wallet-service` and `relay` are both Docker Compose services with a documented container topology, environment-variable configuration, and a `docs/operations.md`-style runbook. The Matrix addition should look like a natural sibling to those — not a bespoke system with its own conventions.

### 6. Let a card holder discover which rooms their card can access

Nothing in Goals 1–5 gives a card holder a way to learn what card-gated rooms exist and which ones their card qualifies for — a card only ever finds out by being told a `room_id` out of band. Since a room's `policy_id` and a card's chain are both already public by the protocol's own design (only message content and room membership are meant to be confidential, per Goal 4), this is answerable from public data alone and should default to a client-side computation, not a privileged server query. Added 2026-07-11 — see `specs/process_specs/room_discovery.md`.

---

## Rationale

**Why reconcile instead of implement the note as written?** The note's architecture (P2P/DHT-routed wallet services, a custom hybrid-AES room-key scheme, a hand-rolled `matrix-compat-proxy`) describes a system that isn't what's running. The real `wallet-service` is a Postgres-backed Nitro app with card-hash routing via signed `CardBindingAnnouncement`s, sub-card UUID pools, and relay-based push/WebSocket delivery (`message_routing.md` v0.5). Building the note's P2P layer from scratch would duplicate work that already exists in a different, working form, and would leave two incompatible routing systems in the codebase. Fitting Matrix into the real system is less work and produces one coherent architecture.

**Why Synapse's own extension points instead of a custom reverse proxy?** The note proposes a `matrix-compat-proxy` container that all client traffic flows through, presumably to enforce card-policy gating and translate the wallet service's auth into Matrix's. Synapse already has first-class extension points for exactly this: a **Module API** (Python, loaded in-process by Synapse) exposes callbacks like `on_new_event`, `check_event_for_spam`, and room-membership callbacks that can enforce card policy at the moment of join or post — no separate proxy process needs to sit in the request path for every message. This is a materially smaller, more standard piece of software than an HTTP-level Matrix protocol proxy, and it's the point of failure Matrix operators already know how to reason about. This plan defaults to a Synapse module; see Open Questions if you'd rather have the standalone proxy the note describes.

**Why native Matrix E2EE (Olm/Megolm) instead of the note's custom AES scheme?** The note's hybrid model (room creator generates an AES-256 key, distributes it out-of-band, rotates it on leave) is a simplified reimplementation of what Matrix's Olm (1:1) and Megolm (group) ratchets already do, with forward secrecy and standard client-library support that a from-scratch scheme won't have on day one. Layering the protocol's card signatures *inside* the Megolm-encrypted event body (so Synapse still can't read them, but so authenticity is still anchored to a card, not a Matrix account) gets both properties without reinventing group-ratchet cryptography. See Open Questions — this is a real design choice, not a foregone conclusion.

**Why a shadow Matrix account per card, managed by a bridge, rather than exposing Matrix accounts to users directly?** Synapse's membership, invite, and E2EE machinery all operate on Matrix user IDs (`@user:server`), not card hashes. Rather than teaching users a second identity system, an Application Service (a privileged Synapse client, already a standard Matrix extension mechanism) provisions and controls one shadow Matrix account per card, deterministically derived from `card_hash`. Users never see or manage the Matrix account directly; they interact through wallet-service/client-sdk, which the AS bridge translates on their behalf. This keeps "the card is the identity" true from the user's perspective while satisfying Synapse's data model.

**Why Postgres for Synapse, and why a separate instance from `wallet-service`'s Postgres?** Synapse's SQLite backend is explicitly not recommended by the Matrix.org project for anything beyond small single-user testing; Postgres is required for acceptable performance and is what every other Postgres-backed service in this repo already uses. A separate Postgres instance (not a shared one with `wallet-service`) keeps Synapse's large, fast-growing, Matrix-internal schema isolated from the protocol's own data — matching the `relay` pattern of giving each service its own datastore rather than sharing.

**Why single-node first?** `raw_notes/matrix.md`'s federation section (card-network-operated Matrix servers, P2P discovery, replicated rooms, key distribution across servers) is a second, substantial piece of design work layered on top of a working single-node deployment. Federation done first, on top of an unproven integration, means debugging both problems at once. Get one Synapse instance correctly enforcing card policy and preserving card-anchored signatures end to end; federation is a follow-on plan once that's solid.

---

## Key Objectives

### Goal 1 — Single-node Synapse deployment
- `docker compose up` brings up Synapse + its Postgres instance as new services alongside the existing `wallet-service` stack, with no manual Synapse admin-console steps required for first boot.
- Synapse is not reachable by end-user clients directly (mirrors `synapse: # NOT exposed publicly` in the note) — only the wallet-service/bridge and the operator's admin tooling can reach it.
- A documented `docs/operations.md`-style runbook exists for the Matrix component (start, stop, backup, restore, rotate credentials).

### Goal 2 — Predicate-based room policy
- Creating a card-gated room requires supplying an existing protocol `policy_id`; there is no separate policy grammar to author.
- A card attempting to join or post to a room is evaluated by the same `evaluate(card, policy.rules)` logic used elsewhere in the protocol, re-derived from on-chain/IPFS data, not from a cached or duplicated policy representation.
- A card that no longer satisfies a room's policy (e.g., revoked) cannot post new messages, and this is enforced server-side (in the Synapse module or bridge), not only client-side.
- **Amended 2026-07-11:** revocation enforcement is not limited to blocking future posts. On any detected revocation, the card's shadow Matrix account is removed from the room immediately (force-parted), not left as a member until its next post is denied. A passive, post-denial-only posture leaves a revoked account able to keep reading the room — see the amended Goal 4 below for why that's treated as unacceptable rather than a minor gap. Detection itself is event-driven (a persistent subscription to the registry contract's `CardHeadUpdated` event), not a polling/TTL cache — see `specs/process_specs/matrix_join_attestation_and_revocation.md`.

### Goal 3 — Card-anchored identity and signatures
- Every message posted to a card-gated room carries a card signature (ML-DSA-44 over canonical payload) that any client can verify independently of Synapse or the shadow Matrix account. Messages with no signature, or an unverifiable one, are rejected by receiving clients, not surfaced as legitimate content.
- The mapping from `card_hash` → shadow Matrix user ID is deterministic and documented, so any wallet-service instance can derive it without a lookup table.
- Every message's embedded signer card hash is checked, on receipt, against the card hash derived from the message's Matrix sender ID. A card that has joined or posted in a room cannot have later messages in that room attributed to it under a different card's signature — receiving clients reject any such mismatch.
- A compromised or malicious Synapse operator cannot forge a message attributed to a card they don't control (they can, at most, refuse to relay it).

### Goal 4 — Confidential message content
- Synapse's Postgres database stores only ciphertext for room message bodies; the chosen encryption scheme (native Megolm or protocol-native, per Open Questions) is documented with an explicit statement of what the Synapse operator can and cannot see, matching the "What the Server Operator Can See" table style in the note.
- Room key / session-key distribution to a newly joining card does not require server-operator involvement.
- **Amended 2026-07-11:** confidentiality-on-paper isn't enough if a revoked card can keep decrypting messages sent after its revocation simply by remaining a room member. This wasn't visible as a gap until the revocation-enforcement mechanism was worked through concretely — a revoked-but-not-removed account is still eligible to receive new Megolm session keys under ordinary client behavior. Immediate force-part on revocation (Goal 2) is what actually closes this; it belongs here as much as there, since the property being protected is confidentiality, not just write-access control.
- **Amended 2026-07-11 (second amendment, same day):** this goal was originally scoped around message *content* — "Synapse's Postgres stores only ciphertext." Working through join authorization concretely (the attestation redesign, `matrix_join_attestation_and_revocation.md`) surfaced that the Synapse module now also needs a **persistent, server-side membership registry** (`(room_id, matrix_user_id) → card_hash`, for post-time identity resolution — see that document's §2a) — real sensitive metadata this goal didn't originally account for, distinct from message content. **Decision (David, 2026-07-11): encrypt this registry at rest, using the same secrets-backend pattern as every other credential in this deployment, rather than leave it as plaintext server state or as an ephemeral in-memory cache that forces a mass rejoin on every restart.** Encryption at rest is real mitigation against a passive/incidental exposure (a stolen disk snapshot, a misconfigured backup) but does not, and cannot, protect this data from whoever operates the live `synapse` instance holding the decryption key — the same limit every encryption-at-rest scheme in this protocol already has. **This is a broader, explicit acknowledgment worth stating as project-level context, not just a footnote on one registry:** a card-gated Matrix deployment is accumulating real sensitive server-side state beyond ciphertext (this registry now; possibly more as federation and other follow-ons are designed) — the protocol's actual privacy property is "an honest, encryption-at-rest-practicing operator can't be casually read by a passive third party," not "no operator, including the one running the instance, can ever see this." A community or individual that wants stronger assurance than "trust the operator" needs to run (or fully control) their own Synapse instance. This doesn't change any goal's technical requirements — it changes how those requirements should be *described* to anyone deciding whether to rely on a third-party-operated instance versus self-hosting.

### Goal 5 — Operational fit
- New services follow the existing `.env`-driven config pattern (`loadConfig()`-style validation, fail-fast on missing required vars) used by `wallet-service` and `relay`.
- New containers are added to a Compose file consistent with the existing `wallet-service/docker-compose.yml` and `relay-old` Dockerfile conventions (multi-stage builds where applicable, named volumes, no host network exposure beyond what's required).

### Goal 6 — Card-based room discovery (added 2026-07-11)
- A card holder can learn which existing card-gated rooms their card qualifies for, without joining each room's policy to find out by trial.
- The default path is a pure client-side computation against public data (a published room index of `{room_id, policy_id}` pairs, plus the same public IPFS/RPC reads a chain walk already requires) — no server ever needs to see the card's identity to answer this question.
- A server-hosted convenience endpoint is available as a secondary path for clients that can't do local RPC/IPFS work, explicitly treated as a new metadata exposure (it tells `wallet-service` which card is asking about which rooms) rather than a free equivalent to the client-side path — no persistent query log beyond what abuse rate-limiting needs.
- See `specs/process_specs/room_discovery.md`.

---

## Open Questions

These need answers — or explicit "proceed with the recommended default" sign-off — before the implementation plan can be written without guessing.

1. **Policy enforcement point: Synapse module vs. standalone proxy.** This plan recommends a Synapse Module API integration (in-process Python module) over the note's standalone `matrix-compat-proxy` container. You mentioned wanting "a proxy" as part of the container set — is that a hard requirement (e.g., because you want a language/stack other than Synapse's Python module system, or want the enforcement logic physically separable from Synapse), or is the module approach acceptable if it gets the same policy-gating result with less new infrastructure?

2. **Encryption: native Matrix E2EE (Olm/Megolm) vs. the note's custom hybrid-AES room-key scheme.** Recommend native Megolm, with card signatures carried inside the encrypted event body. Native E2EE means using a Matrix client SDK's crypto stack (e.g., `matrix-rust-sdk` bindings) inside `client-sdk`, which is new dependency surface for that package. Confirm this tradeoff is acceptable, or if a from-scratch scheme (more control, more crypto to audit and maintain) is actually preferred.

3. **Shadow Matrix account provisioning.** Recommend: the wallet-service creates and holds the credentials for a card's shadow Matrix account (via an Application Service) automatically the first time a card interacts with any Matrix room, deterministically derived from `card_hash`. Confirm this belongs in `wallet-service` itself rather than a new standalone service — it needs the wallet-service's existing card auth (`session-token.ts`) and card cache to work.

4. **Where does room/message data live relative to existing message routing?** Matrix rooms are a new, parallel path alongside the existing `POST /messages` → routing table → relay flow (`message_routing.md`). Confirm that 1:1 and small-group messaging keep using the existing relay-based path unchanged, and Matrix is additive for room-style group chat specifically — not a replacement for the existing message routing system.

5. ~~**Card revocation propagation into Synapse.**~~ **Resolved 2026-07-11.** Event-driven, not TTL-cached: a watcher daemon subscribes to the registry contract's `CardHeadUpdated` event for every address relevant to an active room membership (leaf card plus full ancestor chain), and force-parts the affected account immediately on any detected revocation rather than waiting for a staleness window to lapse. A coarse hourly backstop re-walk guards against a missed or malformed event. See `specs/process_specs/matrix_join_attestation_and_revocation.md §3`.

6. **Environment/hosting target for this pass.** Is this Synapse deployment meant to run in the same environment as the current `wallet-service` (implying it should follow that service's `docker-compose.yml`/env-var conventions exactly), or is it destined for different infrastructure (e.g., a separate host/VM) where only the container images need to match, not the orchestration file?

---

## Forward-Looking: Federation (added 2026-07-11 — not in scope for this plan)

This plan explicitly defers multi-operator federation (Goal 1, "Why single-node first?"). The two items below are design intent surfaced during a discussion with David after Phase 1 was otherwise complete — captured here so the eventual federation follow-on plan doesn't have to re-derive them, **not** as a commitment to build against in this plan's scope. Neither changes any Phase 1–6 deliverable.

### What federation would expose, beyond what this plan's confidentiality goals cover

Goal 4's amendments already establish that this deployment holds more server-side sensitive state than "ciphertext only" (the membership registry). Federation adds a second, distinct exposure: **standard Matrix federation replicates room state and event metadata to every homeserver with a member in the room**, regardless of any of this protocol's own confidentiality mechanisms, because that metadata was never covered by Megolm encryption in the first place — only event `content` is encrypted.

- **Room membership** (`m.room.member`) is federated to every participating server — a peer operator sees the full membership list (as one-way-commitment Matrix IDs, not `card_hash`) for any room they share a member with.
- **Message frequency and timing** — `sender`, `room_id`, `event_id`, `origin_server_ts` are federated in the clear on every event, encrypted or not. A peer server sees exactly who posted and when, pseudonymously, for every message in a shared room. This is already true for the single operator today; federation just means as many operators as have a member in the room see it, not one.
- **Typing notifications, read receipts, and presence** are federated by default and are a materially bigger leak than message metadata alone — presence in particular is account-wide, not per-room, so a peer sharing just one room with a user can observe that user's overall activity pattern across every room they're in.
- **Backfill**, depending on a room's `history_visibility` setting, can let a newly-federating server pull historical event metadata (sender + timestamp for every past message) further back than "since this server's user joined."
- **What stays protected regardless:** message content, `card_hash` itself (the one-way commitment holds no matter who's watching), and the membership registry (per-homeserver module-internal state, never a federated Matrix protocol object).

**The harder problem, not just a metadata question:** policy *enforcement* is per-homeserver plugin logic. The Synapse module only runs `user_may_join_room`/`check_event_for_spam` for users whose shadow accounts live on the server running it. For a federated room, whether a *remote* homeserver's own users actually satisfy the room's predicate depends entirely on that remote operator running an equivalent, correctly-functioning module — Matrix's baseline federation trust model authorizes each homeserver for its own users' events, not this protocol's custom policy check. Running your own server protects your own users' metadata and guarantees your own enforcement; it does not, by itself, guarantee a shared federated room is actually gated the way its `policy_id` claims once other operators' users are members.

### Proposed mitigation: client-verifiable join receipts, not server-trusted joins

Extend the same posture the sender-binding check already takes (don't trust the server's word, verify independently, client-side) to the join decision itself:

- **A joining member posts their join attestation (`matrix_join_attestation_and_revocation.md §1`) into the room itself** (a receipt message, not just an out-of-band value handed to the local Synapse module). Any client can then independently re-run the same check the local module was supposed to run — signature, `verifyMatrixUserIdBinding`, chain-walk, predicate evaluation — using the same public RPC/IPFS reads and the same evaluator logic `room_discovery.md`'s client-side function already needs. No new cryptographic primitive; reuse of existing pieces.
- **Should apply universally, not just to federated joins** — including the room creator's own auto-join, which currently skips `user_may_join_room` entirely and is trusted by local convention only. Applying it everywhere avoids a two-tier trust model (locally-joined members implicitly trusted, federated members specially checked) and catches a bug in your own module too, not just a misbehaving peer's.
- **Verified once per `(room, matrix_user_id)`, not per message** — mirrors the membership registry's own shape, just held client-side: cache the verification result, then apply the existing per-message sender-binding check as normal.
- **Join-time proof alone is insufficient — revocation needs the same treatment.** A join receipt only proves eligibility at join time. A federated peer could simply decline to honor a force-part (never relay the leave, keep showing its user as a member). Clients need to periodically re-run the eligibility check against a member's *current* chain data, not just their original receipt, to detect a peer server silently failing to enforce revocation — reusing the same evaluator, just invoked again later rather than once.
- **Governance precedent already exists in the protocol for exactly this shape of problem.** A press that posts non-compliant content is reportable to the Press Registry Body, which can revoke it (`card_protocol_spec.md`, `RevokePress`). A homeserver that admits or retains a member without a valid, currently-satisfying join receipt produces the same kind of independently-reproducible evidence (the room, the predicate document, the member's ID, the absent/invalid/stale receipt) that any client can generate without needing to be a trusted reporter. Whether the consequence should be fully automatic (client software stops accepting events relayed via that server) or governance-mediated (parallel to the Press Registry Body, a deliberate decision with review) is a real open design choice for the federation follow-on plan, not resolved here.
