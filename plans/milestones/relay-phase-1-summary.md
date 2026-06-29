# Relay Phase 1 — Milestone Summary

**Date:** 2026-06-28
**Status:** Complete — ready for David review

---

## Documents Produced

- `specs/object_specs/relay.md` — API spec: all three endpoints, error codes, UUID lifecycle, re-registration flow
- `specs/object_specs/relay_data_model.md` — Data model: Redis schema, UUID state machine, SQLite DDL, app registry config schema, environment variables

---

## Cross-Check: Process Flows vs. API Spec

| Process (notification_relay.md) | Covered by | Status |
|---|---|---|
| Process 1: UUID Registration | `POST /register` (§6.1) | ✓ All steps mapped |
| Process 2: Push Notification Delivery | `POST /notify/{uuid}` (§6.2) | ✓ All steps mapped; discrepancy resolved (see below) |
| Process 3: WebSocket Delivery | `GET /ws/{uuid}` (§6.3) | ✓ All steps mapped, including wallet-side outbound connection |
| Failure Handling table (all 5 rows) | §6.2, §6.3, TTL expiry | ✓ All rows covered |
| Registration Privacy constraints | Client-side behavior; noted in §4 | ✓ Relay design does not violate these constraints |

---

## Discrepancy Resolved: Push UUID Consumed Before vs. After Delivery

The process spec (Process 2, step 4) marks a UUID consumed before dispatching the push (step 5). The implementation specs deviate from this deliberately:

**Problem with pre-consumption:** If the push fails after the UUID is consumed, the UUID is permanently wasted. The wallet service receives a non-502 response and cannot distinguish "UUID spent, push delivered" from "UUID spent, push failed." This conflicts with the failure handling table row "UUID is not consumed on failed delivery."

**Resolution:** A four-state machine with an `in_flight` transient state:

1. `unused → in_flight` atomically before dispatch (prevents double-delivery race condition)
2. `in_flight → consumed` on success
3. `in_flight → unused` on APNs/FCM failure (wallet service may retry the same UUID or advance to the next)

On startup scan, `in_flight` UUIDs (crash mid-dispatch) are treated conservatively as `consumed`.

This is a deliberate improvement over the process spec's intent, not a contradiction of it. The process spec's step order was likely written for clarity, not to mandate pre-consumption semantics.

---

## Consistency Check: API Spec vs. Data Model

All UUID record fields referenced in `relay.md` are defined in `relay_data_model.md`. All state machine transitions documented in `relay.md` endpoints match the transitions table in `relay_data_model.md §5.2`. All error codes in `relay.md §9` are consistent with endpoint error response tables.

One minor clarification added: `in_flight` is only valid for push UUIDs; WebSocket UUIDs go directly from `unused` to `active`. The data model documents this; the state machine diagram reflects it.

---

## Open Questions Carried Forward

Four low-to-medium priority open questions are recorded in `relay.md §10`. None block implementation:

- **OQ-RLY-1:** Batch registration (one call per device vs. one per card's UUID pool) — deferred
- **OQ-RLY-2:** Rate limiting on `POST /register` — deferred to pre-production hardening
- **OQ-RLY-3:** APNs sandbox vs. production env selection (per-app config field recommended) — low priority
- **OQ-RLY-4:** Health check endpoint (`GET /health`) — recommended, low effort; add during Phase 2 scaffolding

---

## Ready for Phase 2

No open engineering decisions remain. Phase 2 (project scaffolding) may proceed on David's approval.
