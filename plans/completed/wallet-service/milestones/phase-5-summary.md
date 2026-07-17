# Phase 5 Milestone Summary — UUID Management

**Date:** 2026-06-30
**Status:** Complete

Phase 5 implements UUID pool registration, deregistration, and expiry cleanup. All three steps from `implementation-plan.md §Phase 5` are implemented and verified live, including the relay-restart retransmission scenario the milestone review specifically calls for.

- **Step 5.1 (registration + retransmission):** `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` — no authentication beyond a syntactically valid `card_hash` (unlinkable by design), UUID v4 format validated server-side, 30-day expiry. On registration, immediately redelivers any uncleared messages queued for that subcard — updated from the plan's original "re-encrypt and enqueue" wording (stale from before Phase 4's UMBRAL removal) to a straight redelivery of the unchanged, already-encrypted blob. Verified live end-to-end: registered a UUID pool, sent a message while a fake relay was deliberately down (queued, undelivered), brought the relay up, re-registered a fresh UUID batch (simulating a relay Redis restart), and confirmed the queued message was retransmitted synchronously during that re-registration call and successfully cleared afterward.
- **Step 5.2 (deregistration):** `DELETE /cards/{card_hash}/subcards/{subcard_hash}` — marks all UUIDs for a subcard consumed. Verified live: deregistration succeeds (204); re-deregistration is idempotent (204, since registration history still exists); deregistering a subcard with no registration history at all returns 404.
- **Step 5.3 (expiry cleanup):** `prune-expired-uuids` scheduled task (nightly, 04:00), deletes only rows that are both expired *and* consumed — an expired-but-unconsumed row is left alone, since `claimNextUuid`'s `expires_at > now()` check already makes it unclaimable; deletion here is cleanup, not a correctness requirement. Verified live via the task-invoke endpoint and with a unit test confirming the three-way split (expired+consumed pruned; expired+unconsumed kept; fresh+consumed kept).

100 automated tests pass in total (94 + the 6 new in `test/uuid-pools-registration.test.ts`), lint and typecheck are clean, both build presets succeed, and all migrations apply cleanly against a fresh database.

## Privacy audit (notification_relay.md §Registration Privacy, implementation-plan.md §Step 6.2)

Grepped every `console.*` call added this phase: all three log lines (`uuids registered`, `subcard uuid pool deregistered`, `pruned expired uuids`) reference only `card_hash` and aggregate counts — never `subcard_hash`, never an IP address, never a session identifier. This matches the existing pattern from Phase 4. `notification_relay.md`'s `§Registration Privacy` constraints (separate sessions per card, staggered timing, unlinkable replenishment) are device/client-side behaviors with no corresponding wallet-service code to verify — the wallet service's contribution to this property is simply *not requiring or recording any session/identity binding* at the registration endpoint, which Step 5.1 satisfies by construction (no auth at all beyond `card_hash`).

## Deviations from the plan as written

- Step 5.1's original wire description said the wallet should "re-encrypt and enqueue" uncleared messages on retransmission. That instruction predates the Phase 4 architecture change (sender-side per-subcard encryption replacing wallet-side UMBRAL re-encryption) and was stale. Updated in `implementation-plan.md` to describe a straight redelivery of the unchanged payload — consistent with how `deliverMessage` (Step 4.4) already works.

## Known gaps carried into Phase 6+

- ~~No rate limiting on `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`...~~ **Resolved in Phase 6, deliberately not as originally planned:** the per-day UUID registration cap this section flagged as forthcoming was implemented and then removed — each delivered message consumes a UUID, so capping registration directly caps message throughput, and 100/day is too low for active use. See Phase 6's summary. The 100-per-call cap (payload size, not rate) remains.
- `subcardHasAnyHistory`/`consumeAllForSubcard` give Step 5.2 an honest 404 for a truly-never-registered subcard, but there's no on-chain check that the `subcard_hash` actually corresponds to a real, currently-valid sub-card for the card in question — the wallet service trusts whatever `subcard_hash` is presented, consistent with the no-auth-by-design model, but worth noting this endpoint (and Step 5.1's) accept any syntactically valid pair.
