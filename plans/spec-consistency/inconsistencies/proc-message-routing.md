# Inconsistency Log — `proc-message-routing` (`specs/process_specs/message_routing.md`)

Reviewed against: all 15 in-scope Phase 2 process specs and all 15 in-scope (now-fixed) Phase 1 object specs, plus `specs/messaging_protocol.md`, `specs/protocol-objects.md`, and `specs/ARCHITECTURE.md` where directly referenced.

---

## Finding 1 (Major/load-bearing): "Resolve the sub-card list from the storage contract" contradicts `registry_contract.md`'s actual on-chain surface

**Conflicting specs:** `specs/process_specs/message_routing.md` (§Overview changelog, §Message Delivery intro, §Sender-Side Fan-out) vs. `specs/object_specs/registry_contract.md` (§2 "Relationship to Existing Specs", §5 Read Operations) and `specs/object_specs/ipfs_card.md` (§2, §5).

**Description:** `message_routing.md` states, in four separate places, that the sender determines a recipient card's current set of registered sub-cards by querying the **on-chain storage contract**:

- Changelog (v0.4): "the sender resolves the recipient's current sub-card list from the storage contract"
- §Message Delivery: "the sender encrypts independently to each of the recipient's currently-registered sub-card public keys (visible in the on-chain storage contract)"
- §Sender-Side Fan-out (heading text and pseudocode): "the sender's client resolves the recipient card's current sub-card list from the on-chain storage contract" / "resolve recipient_hash's registered sub-cards from the storage contract"

This is factually inconsistent with the authoritative (Phase-1-fixed) `registry_contract.md`:

- §2 states explicitly: "The holder's `active_subcards` field ... is maintained **entirely off-chain in the card's IPFS log**. ... The contract itself plays no special role for 510/511/512 — it **neither validates nor stores `active_subcards`**."
- §5 Read Operations lists only `GetCardEntry(card_address)` and `GetSubCardEntry(sub_card_address)`. The latter maps a **sub-card address to its single master card** (one direction only) — there is no read operation that maps a master card address to the list of its currently-active sub-cards. `SubCardRegistrations` (§3.4) is keyed by `sub_card_address`, not `master_card_address`, and has no reverse index.
- `ipfs_card.md` §2 corroborates: `active_subcards` "is **not present at genesis** on any card. Added only by a post-genesis code-510 `LogEntry` on the card's own log," i.e. it lives in IPFS content, not on-chain storage.

The actual source of a card's current sub-card list is the `active_subcards` field of the master card's decrypted IPFS document (maintained by holder-signed 510/511/512 `LogEntry` codes per `protocol-objects.md §1.1`), not any on-chain mapping. `message_routing.md`'s repeated "storage contract" phrasing describes a capability the registry contract does not have.

**Recommended resolution:** Correct `message_routing.md`'s Sender-Side Fan-out section (and its v0.4 changelog line) to say the sender resolves the sub-card list by fetching and decrypting the recipient's current card head from IPFS (via the on-chain `log_head_cid` pointer) and reading `active_subcards` from it — not by "querying the storage contract" directly. This is load-bearing: it describes the actual mechanism a client implementation must use to find delivery targets, and as written it points implementers at a contract read operation that doesn't exist.

---

## Finding 2 (One-sided claim): Keyring-blob federation broadcast vs. `CardBindingAnnouncement` fanout

**Conflicting specs:** `specs/process_specs/wallet_backup_and_recovery.md` (§Keyring Storage and Replication) vs. `specs/process_specs/message_routing.md` (§Wallet Service Registry) and `specs/object_specs/wallet.md` (§7.5).

**Description:** `wallet_backup_and_recovery.md` states the keyring blob is broadcast to the federation "using the **same broadcast channel** already used for `CardBindingAnnouncement` fanout (`specs/process_specs/message_routing.md`)."

`message_routing.md` itself never mentions keyring blobs at all — its "Wallet Service Registry" section (Peer List, Binding Announcements, Conflict Resolution, Startup Sync) is scoped entirely to `CardBindingAnnouncement` objects (`card_registration`/`card_migration` types) delivered to each peer's `/bindings/announce` endpoint. `wallet.md` §7.5 (authoritative, Phase-1-fixed) documents keyring replication as **structurally separate** endpoints — `POST /federation/keyrings` and `POST /federation/keyrings/delete` — with their own message shape and their own verification function (`verifySignedKeyringMessage`, distinct from `verifyAnnouncementEnvelope` used for bindings).

So the claim "same broadcast channel" is one-sided and imprecise: the two mechanisms share the same **peer list** (the set of wallet services to fan out to) but are not the same channel/endpoint/message type. `message_routing.md` provides no generic reusable broadcast primitive that `wallet_backup_and_recovery.md` could be pointing to.

**Recommended resolution:** Reword `wallet_backup_and_recovery.md` §Keyring Storage and Replication to say the keyring broadcast reuses **the same peer list** the Wallet Service Registry maintains (not the same broadcast channel/endpoint), and cross-reference `wallet.md §7.5`'s `/federation/keyrings` endpoints as the actual mechanism, rather than implying `message_routing.md`'s `/bindings/announce` path carries keyring data.

---

## Finding 3 (Self-consistency / stale phrasing within the unit): "Local Routing Tables" section reads as deferred but the design is already specified above it

**Location:** `specs/process_specs/message_routing.md` §Local Routing Tables, items 1–3.

**Description:** This section describes routing-table population as happening "through the off-chain Wallet Service Registry mechanism (**design deferred to the wallet service spec**)" (item 1), "through the same off-chain mechanism" (item 2), and "from the off-chain Wallet Service Registry" (item 3, Startup Sync). But the Wallet Service Registry mechanism — Peer List, Binding Announcements (with full payload/envelope schema), Binding Conflict Resolution, and Startup Sync via `GET /bindings` — is fully specified earlier in this **same document**, not deferred to any other spec. The parenthetical "(design deferred to the wallet service spec)" appears to be a leftover from an earlier draft state before the Wallet Service Registry section was written out in full, and is now stale/redundant — it undersells that this very document is authoritative for the mechanism.

**Recommended resolution:** Remove or update the "(design deferred to the wallet service spec)" parenthetical in §Local Routing Tables item 1, and tighten items 1–3 to cross-reference the §Wallet Service Registry section above by name rather than re-describing it as an external/deferred mechanism.

---

## Finding 4 (Minor documentation gap): Peer List `endpoint` field description omits keyring-federation use

**Location:** `specs/process_specs/message_routing.md` §Wallet Service Registry → Peer List table vs. `specs/object_specs/wallet.md` §7.5.

**Description:** The Peer List table describes the `endpoint` field only as "Base HTTPS URL for inbound routing envelopes and binding announcements." In practice (per `wallet.md` §7.5 and `wallet_backup_and_recovery.md`), the same peer endpoint base URL is also the target for keyring-blob federation calls (`POST /federation/keyrings`, `POST /federation/keyrings/delete`). This isn't a contradiction, but the field description in the authoritative peer-list schema is incomplete relative to how the endpoint is actually used elsewhere in the spec set.

**Recommended resolution:** Expand the `endpoint` field description to note it is also used for federation/keyring-replication calls, or explicitly note that additional peer-to-peer traffic beyond routing/bindings shares this same base URL.

---

## Finding 5 (Lifecycle gap, per Phase 2 instructions): No removal/deregistration stage for a card's wallet-service binding

**Description:** `message_routing.md` fully specifies **creation** (`card_registration` binding announcement) and **update** (`card_migration` binding announcement, which supersedes the prior binding) of a card's wallet-service-routing state. There is no **removal** stage: no message type or process exists for a card's binding to be removed from the network's routing tables entirely (e.g., on account closure/card retirement), as distinct from migrating it to a different wallet service. This may be an intentional omission (a card's registry address is presumably always "live" and routable for as long as it exists, with revocation handled at the card/log level rather than the routing level), but the spec does not say so explicitly — it simply has no removal case, which per the Phase 2 review instructions should be logged rather than silently passed over.

Separately, at the **peer** level (not the per-card level), the spec states: "Adding or removing a wallet service from the network requires updating peer lists out-of-band across all operators" (§Wallet Service Registry → Peer List). Unlike card bindings — which have a fully signed, broadcast, conflict-resolved protocol — peer list changes have **no protocol mechanism at all**: no signed announcement, no broadcast, no conflict resolution. This is acknowledged as out-of-band but is a genuine gap in an otherwise fully-specified area (every other state transition in this document is signed and broadcast; this one is manual operator coordination with no spec-level guarantees).

**Recommended resolution:** Either (a) add an explicit sentence stating that card bindings are not intended to ever be "removed" outright — only migrated or left in place, with card-level revocation handled elsewhere — to close the ambiguity, or (b) if a removal case is expected to exist (e.g. a wallet service permanently shutting down and no longer answering for any of its cards), specify it. For peer-list changes, at minimum note this as a known manual/out-of-protocol operational gap rather than leaving it implicit.

---

## Non-findings (checked, consistent)

- **UMBRAL removal / sender-side per-subcard encryption**: consistently described across `message_routing.md`, `notification_relay.md` (process spec), `wallet.md` (§1, §4, §5 `reencryption_keys` historical note), and `ARCHITECTURE.md`. No drift found.
- **`device_key` removal**: consistently stated as removed (message_routing.md v0.3, corroborated by `wallet.md` §4 and `notification_relay.md` changelog) — different documents cite different version numbers for when *they* stopped using the term, which is expected since each has its own version history, not a contradiction.
- **UUID registration/deregistration endpoint path** (`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`, `DELETE /cards/{card_hash}/subcards/{subcard_hash}`): identical across `message_routing.md`, `notification_relay.md` (process spec), and `wallet.md` §7.7.
- **UUID retry bound (5 attempts per delivery pass)** and **staggered delete window (0–6 hours)**: consistent across `message_routing.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, and `notification_relay.md`.
- **`410 Gone` retry mechanics for card migration**: `message_routing.md` and `card_migration.md` (`process_specs/card_migration.md`) agree in full, including the old-wallet-service forwarding/local-store-removal behavior (§6). Note: `wallet.md` OQ-WALLET-7 flags that this behavior is *not confirmed implemented* in code — but that is a spec-vs-code (Phase 3) concern, not a spec-vs-spec inconsistency, since the two process specs agree with each other.
- **`POST /messages` lacking sender authentication** (`wallet.md` OQ-WALLET-1): `message_routing.md`'s Delivery Flow doesn't specify sender-side auth on that call either way, so there's no contradiction — this is purely a wallet-service implementation open question, out of scope for this spec-vs-spec pass.
- **Card/registry address derivation** (`keccak256(recipient_pubkey)`), **subcard_hash** (`keccak256(subcard_pubkey)`), and **transport_flags** bit values (`0x01`/`0x02`/`0x04`): consistent across `message_routing.md`, `registry_contract.md`, `ipfs_card.md`, `protocol-objects.md`, and `ARCHITECTURE.md`.
- **`oblivious_transport.md`**: correctly extends `message_routing.md §Transport Extensibility`'s OHTTP precedent (`transport_flags 0x02`) to a different traffic class (device-to-wallet-service/press) without conflicting with it — the two are clearly scoped as sibling mechanisms, not overlapping ones.
- **`subcard_creation_policy.md`**: governs sub-card content/lifecycle privileges (annotations, 8xx/9xx revocation) and is correctly treated by both `wallet.md` and `notification_relay.md` (process spec) as **independent of** wallet-service-local UUID-pool bookkeeping — `message_routing.md` doesn't touch this distinction directly (it's not its concern), and there's no contradiction.
