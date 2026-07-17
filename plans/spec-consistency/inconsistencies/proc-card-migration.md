# Inconsistencies — `proc-card-migration` (`specs/process_specs/card_migration.md`)

Reviewed against: `wallet.md`, `wallet_sdk.md`, `message_routing.md`, `protocol-objects.md`, `registry_contract.md`, `ARCHITECTURE.md`, `card_protocol_spec.md`, and (grep-level) `relay.md`/`relay_data_model.md`/`card_verifier.md`/`app_sdk.md`/`press.md`/matrix object specs (no migration-related references found in the latter group).

---

## Finding 1: `card_migration.md`'s "410 Gone with no forwarding hint" case is internally unsupported and unimplemented

**Where:** `card_migration.md` §"In-Flight Messages During Migration" vs. its own §6 ("Old wallet service behavior on receiving the announcement") and `wallet.md` §7.6/§8.

**Conflict:** §"In-Flight Messages" states:

> The old wallet service returns `410 Gone`, including the new `wallet_service_id` if it has already processed the announcement, **or `410 Gone` with no forwarding hint if it has not**.

This second branch doesn't follow from the document's own model. Per §6, the old wallet service only starts rejecting/redirecting traffic for the migrated card *after* it has processed the announcement (§6 step 1: "It stops accepting new inbound routing envelopes for the migrated card"). Before it has processed the announcement, it is, by the document's own logic, still the card's current wallet service and has no basis to return `410` at all — it should accept the message normally. As written, the "410 with no hint" branch describes a state transition (rejecting traffic) that the document elsewhere says hasn't happened yet.

This is also unimplemented: `wallet.md` §7.6 (`POST /messages`) and §8 (error codes) only document one migration-related `410` shape — `{ error: "card_migrated", wallet_service_id, endpoint }` — always carrying a hint. There is no documented or implemented "410, no hint" case anywhere in `wallet.md`.

**Recommended resolution:** Either (a) correct `card_migration.md`'s "In-Flight Messages" section to remove the unsupported "not yet processed → 410 with no hint" branch (the old wallet service should just accept/queue normally in that case, since from its perspective it is still current), or (b) if a genuine "processed but no hint available" scenario was intended (e.g., a race where the old service knows a migration occurred but hasn't yet resolved the new endpoint), state that scenario explicitly and add a matching endpoint/response shape to `wallet.md` §7.6/§8. As written, the two documents don't agree on when a hint-less 410 can occur or whether it's implemented at all.

---

## Finding 2: `wallet.md` doesn't document verification of the dual-signature requirement for `card_migration` announcements

**Where:** `wallet.md` §6.5 ("Peer wallet-service signature") and §7.5 (`POST /bindings/announce`) vs. `card_migration.md` §3 ("Dual signing") and §5 (peer verification steps 1–3).

**Conflict:** `card_migration.md` requires peers receiving a `card_migration`-type `CardBindingAnnouncement` to verify **two** signatures — the `wallet_service` signer and the `cardholder` signer (the latter possibly via a sub-card-chain resolution, per §3/§5.3 and MIG-OQ-1). `wallet.md` §7.5 lists this endpoint's authentication as simply "Peer wallet-service signature (§6.5)," and §6.5 itself only defines verification of the `wallet_service`-role signer (`keccak256(public_key)` must equal `wallet_service_id`). Neither §6.5 nor §7.5 describes how (or whether) this service verifies the `cardholder`-role signature, or resolves a device-sub-card signer's chain back to `card_hash` — the exact mechanism `card_migration.md` §5.3 says "verifying peers" must perform. `wallet.md` §7.5's prose ("verifies signatures... applies conflict resolution") gestures at plural signature verification but doesn't specify it, and its named auth mechanism (§6.5) covers only one of the two required signatures.

**Recommended resolution:** Add cardholder-signature verification (including the sub-card-chain-resolution case) to `wallet.md` §6.5 or as a new subsection, and update §7.5's endpoint description to cite it alongside the peer wallet-service signature — so the dual-signature requirement `card_migration.md` mandates has a documented implementing mechanism on the receiving side, not just the sending side.

---

## Finding 3: `message_routing.md`'s cardholder-signer verification rule doesn't account for the sub-card-key exception `card_migration.md` introduces

**Where:** `message_routing.md` §"Binding Announcements" ("The cardholder signer is verified by checking that `keccak256(public_key)` matches the `card_hash` in the payload") vs. `card_migration.md` §3 and §5.3 (cardholder may sign with a device sub-card key whose chain resolves to `card_hash`; MIG-OQ-1 is still open on whether the chain must be inlined or looked up).

**Conflict:** `message_routing.md` is the sole normative definition of `CardBindingAnnouncement` signature verification, and `card_migration.md` explicitly defers to it ("See `process_specs/card_migration.md` for the migration protocol" / Related Specs cross-reference). But `message_routing.md`'s stated verification rule for the `cardholder` signer only covers the direct-master-key case (`keccak256(public_key) == card_hash`); it says nothing about the sub-card-chain-resolution alternative that `card_migration.md` treats as a first-class option. Since `card_registration` announcements never carry a `cardholder` signature (only `card_migration` ones do, per `message_routing.md`'s own text), this verification rule exists *specifically* for the migration case, yet doesn't reflect migration's own stated flexibility.

**Recommended resolution:** Update `message_routing.md`'s cardholder-signer verification rule to explicitly allow the sub-card-chain case (mirroring `card_migration.md` §5.3's wording), or have `card_migration.md` state plainly that it is amending/extending `message_routing.md`'s verification rule rather than assuming it's already covered. This is related to, but distinct from, open question MIG-OQ-1 (which is about self-containment of the chain proof, not about whether the alternate signer type is acknowledged at all in the routing spec).

---

## Confirmed accurate: `wallet.md` OQ-WALLET-7 and `wallet_sdk.md`'s migration-related claims

Per this task's specific request, I re-read `card_migration.md` §6 and re-derived the client-side-initiation requirement fresh before checking the Phase-1 acknowledgments:

- **`wallet.md` OQ-WALLET-7** states that §6's requirement — the old wallet service (a) forwarding queued undelivered messages to the new wallet service by re-posting each routing envelope, and (b) removing the card from its local store — "is not confirmed as implemented," and separately notes the service "has no per-card 'local store' concept distinct from `message_queue`/`uuid_pools` rows keyed by `card_hash` to remove." This accurately reflects `card_migration.md` §6's actual text (both sub-requirements quoted correctly), and accurately identifies that `wallet.md`'s own §5 data model has no unified "local store" abstraction — it's a fair characterization, not a mischaracterization.
- **`wallet_sdk.md`'s Implementation Status row and §15 Related Specs entry** characterize client-side migration initiation as requiring "master-key or device-sub-card-key signing over a `CardBindingAnnouncement` payload," citing `card_migration.md` "Steps 1 and 3." This matches: Step 1 (cardholder authenticates to the new wallet service via a signed nonce) and Step 3 (dual signing of the announcement payload) are indeed the two points where the cardholder's master or device-sub-card key signs something, and no other in-scope object spec (`app_sdk.md`, `card_verifier.md`, `press.md`, matrix specs — confirmed via grep, no migration references) claims this capability. The acknowledgment is accurate, not a mischaracterization.

No fix needed for either acknowledgment; both hold up against a fresh reading of `card_migration.md`.

---

## No other contradictions found

- Payload field names/types (`type`, `card_hash`, `wallet_service_id`, `endpoint`, `timestamp`, `nonce`) are identical between `card_migration.md` and `message_routing.md`.
- Conflict-resolution rule ("`card_migration` always supersedes `card_registration`," 24-hour nonce window) matches `message_routing.md` §"Binding Conflict Resolution" exactly.
- `wallet.md`'s `routing_table`/`routing_nonces` schema (§5) supports the fields and semantics `card_migration.md` requires (type discriminator, nonce uniqueness, signature-array replay for `GET /bindings`).
- `ARCHITECTURE.md`'s "off-chain, no on-chain migration event" framing matches `card_migration.md`'s own closing note ("No on-chain event is posted for card migration; routing state is entirely off-chain").
- No stale references to superseded specs (e.g. `client_sdk.md`) found in `card_migration.md`.
