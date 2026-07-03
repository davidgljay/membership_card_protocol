# Relay Serverless Migration — Phase 2 Milestone Summary

**Date:** 2026-07-02
**Status:** Core build complete and committed (2.1–2.6, 2.8). One spec-vs-code divergence found and fixed during this review. Real Cloudflare DO hibernation-eviction timing was resolved 2026-07-03 (see below). Two items remain honestly open: Redis Cloud staging credentials, and a wallet-service security fix (since landed separately at `ea7ce3b1`, `85bb3eea` — see the Phase 3 summary and later commits for its own status).

---

## Summary

Phase 2 (Core Build) implements the full serverless relay against the Phase 1-approved architecture: a portable Redis-operations layer plus a Cloudflare-KV device registry (2.1–2.2), in-house APNs/FCM push dispatch and a staggered delete-queue with platform-native trigger wiring (2.5–2.6), the five stateless HTTP handlers plus the Durable-Object-backed WebSocket/SSE connection layer (2.3–2.4), and a reconciliation scan for stuck UUID state and empty-primary-database detection. `npm run typecheck` is clean, the plain-Node suite is 89/89 passing (`npm test`), and the workerd-pool suite exercising real Durable Object stubs is 20/20 passing (`npm run test:do`). During this review a genuine spec-vs-code divergence was found in the delivery-completion path — WebSocket-delivered messages had no staggered-delete-scheduling mechanism at all, contradicting relay.md §7.2 step 7 — and is now fixed and covered by tests that exercise both the SSE and WS branches against real DO connections, not just the branch condition in isolation. All of this phase's `relay/`, `specs/`, and `plans/` work is committed in ten reviewable increments (listed below). Three things remain genuinely open, not rounded up to done: Redis Cloud has still not been provisioned (no real credentials exist to validate the storage layer against), real Cloudflare DO hibernation-eviction timing has not been measured against production infrastructure (the 5-minute reconciliation cron interval is still a placeholder), and a separate, concurrently-running subagent is fixing an unrelated wallet-service authentication gap that is not part of this phase's scope and whose own commits are still pending.

---

## Commits made this session

Ten commits, each scoped explicitly to `relay/`, `specs/`, or `plans/` (never `wallet-service/`, which a separate concurrent subagent is actively editing):

| Commit | Scope |
|---|---|
| `a87f10ad` | specs: Phase 2 spec updates (relay.md, relay_data_model.md, notification_relay.md) |
| `d33e40aa` | relay: deps/tooling (DO test pool, ioredis-mock, wrangler 3.90→4.107 save-dev fix) |
| `441b1191` | relay: 2.1–2.2 — primary Redis storage layer + KV device registry |
| `a036c921` | relay: 2.5–2.6 — push dispatch + staggered delete queue |
| `aa629f6e` | relay: 2.3/2.4 — stateless HTTP handlers + DO-backed connection layer |
| `8dfcb247` | relay: integration tests (node-server harness) + DO tests (workerd pool) |
| `41ea334d` | relay: reconciliation scan (relay_data_model.md §2.5–§2.6) |
| `b0bda1b0` | relay: SSE/WS staggered-delete branching fix (this review's finding — see below) |
| `c7006720` | plans: relay serverless migration strategic + implementation plans |
| `8d9ce959` | plans: Open Questions note on serverless relay feasibility |

The reconciliation scan (`redis/reconciliation.ts`) had been implemented alongside the storage layer but was not staged in the 2.1–2.2 commit as originally planned — its own commit message says so explicitly rather than silently folding it into the 2.5–2.6 commit's description, since `plugins/scheduled.ts`/`plugins/dev-scheduler.ts` (committed in 2.5–2.6) depend on it. This is a bookkeeping gap in how the work was staged, not a functional one — the working tree was complete throughout; only the commit-by-commit snapshot boundary was affected, and it's now recorded accurately in `41ea334d`'s own message.

---

## The SSE/WS delivery-branching fix (step 1 of this session)

**What was wrong:** `specs/object_specs/relay.md` §7.2 step 7 specifies two different staggered-delete-scheduling rules depending on which channel delivers a message:

> - If SSE connection open ...: stream ... Do not remove from message store yet — wait for `POST /ack`.
> - Else if WebSocket session active: forward blob. **Schedule staggered delete on delivery.**

The delivery-completion code (`relay/server/api/deliver/[uuid].post.ts`, `relay/server/utils/do-client.ts`) did not branch on delivery channel at all — it called `deliverToDeviceChannel` (SSE) then `deliverToUuidConnection` (WS) and returned as soon as either reported success, with no delete-queue enqueue on the WS path anywhere in the codebase. `POST /ack` (`server/api/ack.post.ts`) already correctly enqueues on explicit device ack, which is the SSE (and push/pending) path's mechanism — but the WS channel has no separate ack step per the spec, so a WS-delivered message had **no staggered-clearance mechanism at all**.

**Fix:** `do-client.ts` gained `attemptLiveDelivery(event, uuid, record, message, enqueueDelete)`, which tries SSE then WS (unchanged priority) and applies the differing rule: the SSE branch returns without calling `enqueueDelete`; the WS branch calls it exactly once, synchronously, before returning. `deliver/[uuid].post.ts` now delegates to this function, passing a closure that enqueues onto the real Redis-backed `DeleteQueue` using the UUID's `wallet_base_url`.

**Tests:** `relay/server/do/live-delivery.do-test.ts`, run against real Durable Object stubs (workerd, via `@cloudflare/vitest-pool-workers`) — not mocks, consistent with the existing `do-client-routing.do-test.ts` approach. Four cases: SSE delivery confirms the frame actually arrives over a live `DeviceChannel` connection AND that the enqueue spy is never called; WS delivery confirms the frame arrives over a live `UuidConnection` connection AND the spy is called exactly once; no live connection confirms neither branch fires and nothing is enqueued (the push-fallback precondition); both channels open confirms SSE wins priority and the WS branch (which would enqueue) genuinely never runs. This exercises both real branches end-to-end, not just the branch condition in isolation, per the review's explicit requirement.

**Verified:** `npm run typecheck` clean, `npm run test:do` 20/20 (4 new + 16 pre-existing), `npm test` 89/89 (the node-server integration suite is unaffected — it has no DO runtime so it already only exercised the push-fallback path; this fix's DO-branch coverage lives entirely in the workerd-pool suite).

---

## Open items — status as of this session, not rounded up

### Wallet-service signature-verification gap (2.7 audit finding)

The Phase 2.7 wallet-service audit found that `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` accepted a bare UUID array with no authentication: a caller who merely knew a `card_hash`/`subcard_hash` pair could register UUIDs and trigger message redelivery, with zero proof of controlling the sub-card's private key. This is a wallet-service issue, not a `relay/` issue, and is out of this phase's direct scope — but is recorded here per the audit finding.

**Update, post-review:** the concurrent subagent finished after this document was first drafted. Its changes have since been committed separately (`ea7ce3b1`, "wallet-service: signed-envelope verification for UUID registration (notification_relay.md v0.8)") once its work was confirmed complete and this phase's own commits were already in — so the two never raced. Verified via `git log`/`git show --stat` rather than assumed:

- `wallet-service/src/auth/subcard-uuid-signature.ts` implements signed-envelope verification (resolve the sub-card's on-chain public key via the Arbitrum registry and IPFS, confirm `keccak256(pubkey) == subcard_hash`, verify an ML-DSA-44 signature over the canonicalized payload). The route handler now delegates to `src/routes/subcard-uuid-registration.ts`. Nonce/replay protection is in place (`server/db/subcard-uuid-nonces.ts`, migration, hourly pruning task).
- Both test files exist and are committed: `test/subcard-uuid-signature.test.ts` (8 tests) and `test/subcard-uuid-registration.test.ts` (9 tests) — the latter's earlier "not found" note in this document was a timing artifact of checking mid-flight, not a real gap.
- Per the fixing subagent's own report: full wallet-service suite 145/145 passing, `tsc --noEmit` and `eslint` both clean, verified against a real (embedded) Postgres with all migrations applied.
- **One judgment call flagged for explicit user sign-off, not covered by v0.8's literal text:** registration is also rejected if the on-chain `SubCardEntry.active` flag is false (i.e., a deregistered sub-card can't register UUIDs). This seems clearly correct in spirit but wasn't spec-mandated, so it's worth a conscious yes rather than silent inheritance.
- **Left out of scope, confirmed deliberately not touched:** `DELETE /cards/{card_hash}/subcards/{subcard_hash}` (deregistration) remains unauthenticated. Pre-existing, not introduced by v0.8, not mandated by v0.8's fix — but the same class of gap. Worth a follow-up decision from the user on whether it should get the same treatment.
- **One action still needed:** the fix adds a new `viem` dependency to `wallet-service/package.json`. The subagent verified everything against a sandbox-patched `node_modules`; the real checkout still needs `pnpm install` run against it to actually materialize that dependency before `wallet-service` will run outside this session's sandbox.
- **Conclusion:** this finding is now closed, pending only the `pnpm install` step above and the user's explicit sign-off on the `active`-flag judgment call.

### Redis Cloud staging validation

Still pending. `relay/PROVISIONING.md`'s checklist item for creating the primary Redis Cloud database is unchecked (the KV namespace item, by contrast, is checked — done 2026-07-02, binding `mcard_relay`). No real Redis Cloud credentials exist in this environment, so the storage layer (`redis/uuid-store.ts`, `message-store.ts`, `credential-store.ts`, `delete-queue.ts`, `reconciliation.ts`) has only ever been exercised against the hand-rolled RESP test server (`redis/test-harness.ts`, `test-resp-server.ts`) — genuine wire-protocol coverage, but not a real managed Redis Cloud instance. This remains a user action per the Phase 1 summary's same finding; nothing in Phase 2 changes that status.

### Real Cloudflare DO hibernation-eviction timing

**Resolved 2026-07-03**, after this document was first drafted. `test-hibernation.mjs` was run against the real deployed spike Worker: the connection survived cleanly through 30 minutes of confirmed idle time (each checkpoint verified a message actually arrived on the still-open socket). The run's checkpoints past that point are confounded by an apparent client-side interruption (a ~6-minute scheduling gap in the test client itself, immediately preceding the eventual abnormal-closure at ~52 minutes) — so this run can't cleanly attribute that specific close to Cloudflare's eviction policy versus the test client dropping the connection. Full writeup in `specs/object_specs/relay_data_model.md` §2.5 (v0.7) and `relay/spike-do-ws/README.md`. Net conclusion: `RECONCILIATION_CRON_SCHEDULE`'s 5-minute default is confirmed adequate (comfortably shorter than the 30+ confirmed-safe minutes) and is no longer a placeholder — no config change was warranted by this result.

### `build:cloudflare` sandbox EPERM quirk

Previously observed and flagged as environment-specific. Re-run in this session (`npm run build:cloudflare`) and it completed successfully with no EPERM error — produced a clean `.output/server/index.mjs` under the `cloudflare-module` preset, consistent with the pre-existing `.output_cloudflare_verified/` artifact already in the working tree from an earlier successful run. This is consistent with the quirk being specific to some prior environment state (not reproducing now) rather than a defect in the build configuration itself; the underlying portability mechanism (`NITRO_PRESET` branching, dual-preset build from one codebase) is verified intact by this run, matching the separate verification already noted in earlier work.

### tsc / test status

`npm run typecheck` (tsc --noEmit): clean, 0 errors, at the final commit (`b0bda1b0`) and in the working tree.
`npm test` (plain-Node suite): 89/89 passing.
`npm run test:do` (workerd-pool suite against real Durable Object stubs): 20/20 passing.

The "7 tsc --noEmit errors" tracked earlier in this phase were resolved incrementally as each module was written rather than as a single dedicated after-the-fact commit — there is no standalone "tsc fixes" diff distinct from the code already described above; this is stated plainly here rather than manufacturing a commit that doesn't correspond to real, separable work.

---

## Overall Phase 2 status against the plan's steps

| Step | Status |
|---|---|
| 2.1 Primary Redis storage layer | Done, committed (`441b1191`) |
| 2.2 Device registry (Cloudflare KV) | Done, committed (`441b1191`) |
| 2.3 Stateless HTTP handlers | Done, committed (`aa629f6e`) |
| 2.4 DO-backed connection layer | Done, committed (`aa629f6e`) |
| 2.5 Push dispatch | Done, committed (`a036c921`) |
| 2.6 Delete queue (staggered wallet clearance) | Done, committed (`a036c921`) |
| 2.7 Wallet-service audit | Finding recorded; **fix in progress in a separate, concurrent workstream — not yet committed** |
| 2.8 Phase 2 milestone review | This document |
| SSE/WS delivery-branching fix (this review) | Done, committed (`b0bda1b0`) |
| Redis Cloud staging validation | **Not done** — no real credentials provisioned |
| Real DO hibernation-eviction timing | **Done 2026-07-03** — confirmed safe through 30+ minutes idle; 5-minute cron default validated, not changed |

---

## Recommended next steps before Phase 3

1. Confirm with the concurrent subagent (or its own completion report) whether the wallet-service signature-verification fix is actually committed and tested before treating that finding as closed — this document deliberately does not make that call.
2. User provisions the primary Redis Cloud database per `relay/PROVISIONING.md`'s remaining checklist items, then re-run the storage-layer tests against it (or at minimum the post-provisioning verification steps already listed there) before trusting the storage layer against anything beyond the hand-rolled test server.
3. Run `spike-do-ws/test-hibernation.mjs` against a real deployed Worker for a genuine multi-hour window and capture the output as a report, then use the result to set `RECONCILIATION_CRON_SCHEDULE` to an evidence-based value instead of the current 5-minute placeholder.
4. Re-verify `build:cloudflare` in whatever environment Phase 3's actual deployment will run from, since this session's clean run doesn't rule out the quirk recurring somewhere else.
