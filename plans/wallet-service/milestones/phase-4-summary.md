# Phase 4 Milestone Summary — Message Routing and Queue

**Date:** 2026-06-30
**Status:** Complete

Phase 4 implements the federation layer (binding announcements, conflict resolution, keyring blob replication) and message routing/delivery. All steps from `implementation-plan.md §Phase 4` are implemented and verified — most live against two independent wallet-service instances with separate databases, not just unit tests.

## Mid-phase architecture change: UMBRAL removed

Steps 4.3 and 4.4 were originally specified around UMBRAL proxy re-encryption at the wallet service. Partway through this phase, discussing the only available UMBRAL implementation's GPL-3.0 license, we agreed on a better design: **the sender encrypts independently to each of the recipient's currently-registered sub-card public keys** (visible in the on-chain storage contract) and sends one routing envelope per sub-card, rather than one envelope re-encrypted N ways at the wallet. This was a net improvement independent of the license question — it removes an entire key-custody subsystem from the wallet service, not just a dependency problem.

Updated as part of this change: `specs/process_specs/message_routing.md` (v0.3 → v0.4), `specs/ARCHITECTURE.md` ADR-007 and the proxy-re-encryption note near ADR-004, `specs/process_specs/notification_relay.md` (v0.6 → v0.7), `specs/key_rotation.md`, and `plans/wallet-service/strategic-plan.md`'s OQ-WS-4 resolution — all marked to show what changed and why, not silently rewritten. `implementation-plan.md`'s Step 4.3 is now a resolution note (no separate sub-card registration endpoint exists — Phase 5's UUID pool registration is sufficient on its own) and Step 4.4 dropped the re-encryption step entirely.

This also simplified the schema considerably: `reencryption_keys` and `message_deliveries` (a join table added mid-phase, then found unnecessary) were both dropped; `message_queue` gained `subcard_hash` (each row is now already scoped to one device) and `delivery_uuid` (the most recent relay UUID a message was handed to, replacing the join table).

## What's implemented and verified

- **Step 4.1 (binding announcements):** `POST /bindings/announce`, `GET /bindings`, nonce replay cache, weekly prune task. Conflict resolution (migration-always-supersedes-registration, later-timestamp-wins-within-type) verified with **real signed announcements against a live instance**, including out-of-order delivery (a stale registration arriving after a newer one is correctly rejected) and nonce replay rejection (409).
- **Step 4.1a (keyring replication):** `POST /federation/keyrings`, `POST /federation/keyrings/delete`, `GET /keyrings/{keyring_id}`. Verified with **two full wallet-service instances running simultaneously against separate Postgres databases**: account creation on instance A replicates to B; instance A was killed entirely and instance B still served the keyring blob (the core "recovery doesn't depend on the primary service" property); keyring rotation on A both replicated the new blob to B and deleted B's copy of the superseded one.
- **Step 4.2 (inbound message receipt):** `POST /messages`, now carrying `subcard_hash` per the architecture change. Verified live: valid delivery → 202; unknown card → 404; a card with a live `card_migration` announcement applied → 410 with the correct peer `wallet_service_id` in the response body.
- **Step 4.3:** No code — see architecture change above. Sub-card "registration" is just UUID pool registration (Phase 5).
- **Step 4.4 (delivery):** `server/utils/message-delivery.ts` claims a UUID, hands the (already sender-encrypted) payload to the relay unchanged, and advances to the next UUID on 404/410/5xx/network-error. Verified live against a real (minimal, hand-rolled) HTTP relay server: 15ms delivery latency (well under the 500ms target), correct UUID tracking in `message_queue.delivery_uuid`, and two independently-addressed sub-card envelopes for the same card both delivered independently.
- **Step 4.5 (clearance):** `DELETE /messages/{uuid}`. Verified live: correct message cleared; double-DELETE → 404; unknown UUID → 404.

98 automated tests pass in total (88 + the relay-client network-failure test added below), lint and typecheck are clean, and both build presets succeed.

## Bugs found and fixed during this phase

- **`deliverToRelay` didn't catch network-level failures.** A relay being unreachable (connection refused, DNS failure, timeout) threw an uncaught exception that propagated out of `POST /messages` as a 500 — discovered via the live two-subcard delivery test, where no relay was running yet. Fixed by wrapping the fetch call in try/catch and treating any network-level failure the same as a 5xx response (advance to the next UUID). Added a regression test (`test/relay-client.test.ts`: "returns server_error (not a throw) when the relay is unreachable").
- **Nitro's `experimental: { tasks: true }` requirement** (already found and fixed in Phase 3) applied again here for `prune-routing-nonces` — no new bug, just confirms the earlier fix generalizes.
- **`h3`'s `null`-body 204 override** (already found and fixed in Phase 3's `DELETE /messages/{uuid}`... actually first found there) was re-confirmed not to be an issue for `POST /messages`' 202 response, since h3 only overrides the *default* 200 status, not an explicitly-set non-200 one — worth noting since it's easy to assume the rule applies uniformly.

## Privacy audit (strategic-plan.md §Goal 3, implementation-plan.md §Phase 4 Milestone Review)

Grepped every `console.*` call in `server/` and `src/` (excluding tests): no log line interpolates a `subcard_hash` value anywhere in the codebase. The two log lines that mention "subcard_hash" as text describe its *absence* ("message has no subcard_hash") rather than logging a value. No log line combines `subcard_hash`, `device_key`, IP address, or session token identifiers. `subcard_hash` is now visible in the inbound routing header (a deliberate, documented trade from removing UMBRAL — see the updated `message_routing.md §What Wallet Services Observe`), but remains opaque and is never correlated to anything device-identifying in any log, metric, or admin output this phase added.

## Known gaps carried into Phase 5+

- Sub-card UUID pool registration itself (`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`) is Phase 5 Step 5.1, not yet built — this phase's live tests seeded `uuid_pools` rows directly via SQL to exercise delivery. Phase 5 is also where the unlinkability constraint needs to be (re-)enforced at that actual registration endpoint, since Step 4.3's removal moved that responsibility there.
- `message-routing.md`'s `Transport Extensibility` (OHTTP/Nym) and `Sender Anonymity Constraint` sections are unaffected by this phase's changes but remain unimplemented — out of scope for the wallet-service backend specifically (they're sender/transport-layer concerns).
- Federation tests in this phase used a hand-rolled two-instance setup (`.env.peer-a`/`.env.peer-b`, separate Postgres databases, manual peer-list config) for verification, then were torn down — there's no repeatable automated two-instance test in CI. Phase 6's "federation smoke test" step is the natural place to formalize this as a repeatable harness rather than ad hoc manual verification each time.
