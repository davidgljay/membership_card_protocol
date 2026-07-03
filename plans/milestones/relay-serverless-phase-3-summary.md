# Relay Serverless Migration — Phase 3 Milestone Summary

**Date:** 2026-07-03
**Status:** Documentation and CI/CD written and committed (3.1, 3.2). Docker/Compose retirement (3.3) is proposed-only, per the plan's explicit Clarification Checkpoint — not executed, awaiting user confirmation. Several items carried forward from Phase 1/2 remain genuinely open and are restated here rather than rounded up to done.

---

## Summary

Phase 3 (Documentation & CI/CD) produced a top-level operational README for
`relay/` (3.1) and a GitHub Actions deployment workflow that runs the
full test suite, validates required secrets, and only then deploys via
`wrangler deploy` (3.2). The README consolidates provisioning steps
(pointing to `PROVISIONING.md` as the authoritative source for Redis
Cloud/KV rather than duplicating it), documents Cloudflare Workers/Durable
Object/Cron provisioning that had not been written down anywhere before,
covers local development under the `node-server` preset, and includes a
troubleshooting section combining the Phase 1 DO+WS findings with two new
`wrangler deploy` gotchas discovered and fixed during this session (both
undocumented anywhere else in the repo until now). The CI workflow's
missing-secret failure path was tested live — its actual shell logic was
extracted and run under `bash` against three scenarios (all secrets
missing, one missing, all present) and behaved correctly in all three; the
full GitHub Actions job-dependency wiring (`needs:`) was not tested live
(`act` was unavailable in this environment) and was instead verified by
parsing the YAML and confirming the `deploy` job's `needs: [test,
validate-secrets]` graph is structurally correct — a real but weaker form
of verification than a live run, stated plainly rather than conflated with
the shell-logic test. Docker/Compose retirement (3.3) produced the required
exact file list and rationale in a new pending-removal document but made
no changes to `relay-old/` at all, per the plan's own Clarification Checkpoint
requiring explicit user sign-off before deletion — this is deliberately
incomplete, not an oversight.

---

## Step-by-step results

### 3.1 — README: Complete

Written to `relay/README.md` (did not exist before this session).
Location and convention: matched the existing pattern of `relay/README.md`,
`press/` (which has no top-level README of its own, but follows the same
monorepo-service convention), and `wallet-service/`'s directory structure —
a top-level `README.md` inside the service's own directory, not a doc under
`plans/` or `specs/`.

Covers, per the task brief's explicit checklist:

- **Redis Cloud provisioning:** links to `relay/PROVISIONING.md` as
  the explicitly-stated authoritative source, summarizing only the
  headline steps (persistence-off verification via `CONFIG GET`, TLS
  enforcement, secret storage) rather than forking a second copy that could
  drift out of sync.
- **Cloudflare provisioning:** Workers/DO bindings and the `mcard_relay` KV
  namespace binding (already provisioned, per `PROVISIONING.md` — the
  README states this status rather than presenting it as a to-do),
  `wrangler.toml` structure (including the three separate wrangler configs
  in this codebase and what each is for — the real deploy config, the
  DO-test-only config, and the Phase 1 spike's own throwaway config), the
  full required-secrets table (names cross-checked against
  `relay_data_model.md` §9 and the actual code that reads them via
  `server/utils/env.ts`, `push/dispatch.ts`, `reregistration.ts`), and
  custom-domain steps via `routes` in `wrangler.toml`.
- **Local development under `node-server`:** `npm install` / `npm test` /
  `npm run typecheck` / `npm run build:node` / running the built server,
  plus the separate `test:do` workerd-pool suite and a `wrangler dev
  --local` path for exercising the real DO/WebSocket layer without a live
  Cloudflare account.
- **Troubleshooting:** summarizes the two Phase 1 DO+WS ecosystem findings
  (Nitro's single-fixed-DO-instance `cloudflare-durable` preset limitation,
  the `crossws` adapter export-path version-skew) with a link to
  `spike-do-ws/README.md` for full detail, plus the two new gotchas from
  this session's own lived experience, written down for the first time
  anywhere in this repo:
  - `wrangler deploy` failing with `workers.dev subdomain ... [code:
    10063]` even after visiting the Cloudflare dashboard — the actual fix
    was `workers_dev = true` in the relevant `wrangler.toml`, not a
    dashboard action. Documented with the specific trap that caused it here
    (a spike/test config with `workers_dev` hardcoded `false` for
    local-only `wrangler dev` use, easily confused with the real deploy
    config).
  - `wrangler deploy` succeeding with "Uploaded ... / No targets deployed
    for ..." — not an error, easy to miss, means the script uploaded but
    isn't attached to any route/`workers_dev` target.

The README closes with an explicit "What this document has not been
validated against" section — no real Redis Cloud database connected, no
real `wrangler deploy` of the actual `relay` Worker (as opposed to the
Phase 1 spike) performed, and the document itself not yet followed
end-to-end by anyone but its author. (Real DO hibernation-eviction timing,
listed as unmeasured when this document was first drafted, was resolved
2026-07-03 — see the update below.) This matches the plan's own "done when" bar for 3.1
("gets someone to a working deployment without needing to ask a question
the document doesn't already answer") as an aspiration the document is
written to meet, not as a claim that bar has been independently confirmed
met.

### 3.2 — GitHub Actions deployment workflow: Complete

Written to `.github/workflows/relay-deploy.yml`.

**Trigger branch:** `main`. Confirmed via `git branch -a` (only `main`
plus three `worktree-agent-*` branches belonging to concurrent sessions
exist; no separate `release`/`production`/`prod` branch) and `git log`
(all prior Phase 1/2 commits for this migration are on `main`). Not
ambiguous enough to warrant pausing for a check-in — recorded here per the
task brief's instruction to state the reasoning rather than guess silently.

**Structure:** three jobs — `test` (typecheck, `npm test`, `npm run
test:do`) → `validate-secrets` (fails loudly if any of
`REDIS_PRIMARY_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`RELAY_ID`, `INTERNAL_API_SECRET`, `APP_REGISTRY_JSON` are unset, listing
every missing one rather than stopping at the first) → `deploy` (`needs:
[test, validate-secrets]`; builds via `npm run build:cloudflare`, sets
runtime secrets via `wrangler secret put`, deploys via `wrangler deploy`,
then re-runs `wrangler deploy` once more and greps its output for "No
targets deployed" to turn Phase 3's second undocumented gotcha into a hard
CI failure instead of a silent no-op).

Secret names are cross-checked against `relay_data_model.md` §9 and the
actual reading code, not assumed from the task brief's shorthand list
("Redis Cloud connection string, Cloudflare API token, APNs/FCM
credentials") — the real set is broader (`RELAY_ID`,
`INTERNAL_API_SECRET`, `APP_REGISTRY_JSON` are also required; per-app
`APNS_KEY_<APP_ID>`/`FCM_SERVICE_ACCOUNT_<APP_ID>` secrets are
deliberately *not* enumerated in the fixed check, since they're
dynamically named per app_id and can't be listed ahead of time by a
static script — this gap is called out in the workflow's own comments,
not silently swept under "APNs/FCM credentials present").

**What was actually tested vs. reasoned through — stated plainly, not
rounded up:**

- **Tested live:** the `validate-secrets` job's exact shell logic (the
  same `bash` body, extracted verbatim) was run directly under `bash` in
  this session against three scenarios: all six secrets unset, five of
  six set (one missing), and all six set. Results: exit code 1 with a
  correctly itemized `::error::` list in the first two cases, exit code 0
  with "All required secrets are present." in the third. This confirms
  the validation logic itself is correct.
- **Reasoned through, not live-tested:** the surrounding GitHub Actions
  YAML wiring — whether `deploy` is actually skipped by GitHub Actions
  when `validate-secrets` fails, whether `${{ secrets.X }}` interpolation
  behaves as expected, whether the `paths:` filter and `on: push:
  branches: [main]` trigger correctly. `act` (the standard tool for
  locally emulating a GitHub Actions run) was not available in this
  environment (`which act` found nothing). In its place: the YAML was
  parsed with `PyYAML` to confirm it's syntactically valid and that the
  `deploy` job's `needs: [test, validate-secrets]` list is present and
  correctly named — `needs:` causing a dependent job to be skipped when a
  dependency fails is standard, well-documented GitHub Actions behavior,
  not something specific to this workflow's logic, so this is a reasonable
  substitute for a live test of that specific mechanism, but it is a live
  test of the YAML's *structure*, not of the *runtime behavior* on GitHub's
  actual infrastructure. **This distinction matters and should not be
  glossed over:** a genuinely first real push to `main` with a
  deliberately-incomplete secret set, on GitHub's actual infrastructure,
  has not happened and is recommended before fully trusting this workflow
  (see "What's left" below).

### 3.3 — Docker/Compose retirement: Proposed only, not executed

Per the task's explicit scope limit ("REPORT ONLY, DO NOT DELETE") and the
implementation plan's own Clarification Checkpoint ("before deleting the
Docker/Compose files, show the user the exact file list and get explicit
confirmation before removal") — no files were deleted or modified.

**Exact file list, recorded in
`plans/milestones/relay-serverless-docker-retirement-pending.md`:**

```
relay/Dockerfile
relay/docker-compose.yml
relay/docker-compose.dev.yml
```

No `.dockerignore` file exists anywhere under `relay-old/` (checked, none
found). No separate self-hosted-Redis container config file exists either
— the `redis:7-alpine` image and its `--save "" --appendonly no
--maxmemory-policy noeviction` flags are inlined directly in
`docker-compose.yml`'s own `redis:` service block, not a standalone file —
so there is nothing beyond the three files above to add to the list.
`relay/.env`, `relay/.env.example`, `relay/config/apps.json`, and
`relay/config/secrets/` were deliberately excluded: they're read directly
by the plain Node process (`node dist/server.js`) as much as by the Docker
path, so retiring Docker doesn't make them obsolete on their own — full
reasoning is in the pending-removal document.

The pending-removal document also flags, for completeness, that
`relay/README.md` itself documents the Docker/Compose flow in detail and
would need to be rewritten or removed alongside these three files if/when
removal is confirmed — that rewrite is explicitly not attempted here,
consistent with "do not touch anything else under `relay-old/` at all" from
this task's constraints.

Nothing else under `relay-old/` was read, modified, or otherwise touched
beyond what was needed to produce this file list (a directory listing and
a check for `.dockerignore`/redis-container-config files).

### 3.4 — Phase 3 Milestone Review: This document

---

## Overall Phase 3 status against the plan's "done when" criteria

| Criterion (from the implementation plan's Phase 3 milestone review) | Status |
|---|---|
| README followed end-to-end by someone other than its author | **Not done** — written to meet the bar, but not independently walked through yet; explicitly flagged in the README's own closing section |
| CI workflow's missing-secret failure case tested | **Partially done** — the validation shell logic itself was tested live; the surrounding GitHub Actions job-skip behavior was reasoned through via YAML structure validation, not a live `act`/GitHub run |
| Final summary written | This document |

---

## What's left before this migration is genuinely done

Restating and consolidating open items from the Phase 1 and Phase 2
summaries, plus what Phase 3 itself surfaced — nothing here is rounded up
to done:

1. **Redis Cloud staging validation.** Still not provisioned. The storage
   layer (`redis/uuid-store.ts`, `message-store.ts`, `credential-store.ts`,
   `delete-queue.ts`, `reconciliation.ts`) has only ever been exercised
   against the hand-rolled RESP test server and `ioredis-mock`, never a
   real managed Redis Cloud instance. `relay/PROVISIONING.md`'s
   primary-database checklist item is still unchecked. This is a
   prerequisite for trusting the storage layer beyond unit-test coverage.

2. **Real Cloudflare DO hibernation-eviction timing — resolved 2026-07-03,
   after this document was first drafted.** `test-hibernation.mjs` was run
   against the real deployed spike Worker: confirmed clean survival through
   30 minutes of genuine idle time; later checkpoints are confounded by an
   apparent client-side interruption (a ~6-minute scheduling gap in the
   test client, shortly before an abnormal-closure at ~52 minutes), so the
   exact eviction boundary isn't cleanly pinned down — but nothing in the
   design needs that exact number. `RECONCILIATION_CRON_SCHEDULE`'s
   5-minute default is confirmed comfortably adequate (5 minutes vs. 30+
   confirmed-safe minutes) and was left unchanged. Full writeup:
   `specs/object_specs/relay_data_model.md` §2.5 (v0.7) and
   `relay/spike-do-ws/README.md`.

3. **Docker retirement confirmation (this phase's 3.3).** The exact file
   list is recorded in
   `plans/milestones/relay-serverless-docker-retirement-pending.md` and
   above. Awaiting the user's explicit go-ahead before
   `relay/Dockerfile`, `relay/docker-compose.yml`, and
   `relay/docker-compose.dev.yml` are removed, and before
   `relay/README.md`'s Docker-flow documentation is addressed.

4. **A first real `wrangler deploy` of `relay` itself to a live
   Cloudflare account.** Everything about Cloudflare provisioning in the
   README and the two deploy gotchas in its troubleshooting section come
   from getting the Phase 1 *spike* deployed — the main `relay`
   Worker (with its real KV binding, two DO classes, and cron trigger) has
   not yet gone through a first real deploy. There may be more to find
   once it does.

5. **A genuine live run of the CI workflow on GitHub's actual
   infrastructure**, both with secrets deliberately missing (to confirm
   the job-skip behavior this session could only reason through) and with
   a full, correct secret set (to confirm an actual successful deploy path
   end-to-end) — see 3.2 above for exactly what was and wasn't tested this
   session.

6. **The wallet-service signature-verification follow-ups noted in the
   Phase 2 summary** (the `active`-flag judgment call needing explicit
   user sign-off, `DELETE /cards/.../subcards/...` deregistration remaining
   unauthenticated, and the `pnpm install` step for the new `viem`
   dependency) are outside this phase's scope but remain open per that
   document — restated here only as a pointer, not re-investigated, since
   a separate concurrent workstream is actively continuing that work as of
   this writing (confirmed via the shared task list — do not treat as
   closed without checking that workstream's own completion report).

7. **The README itself has not been followed end-to-end by anyone other
   than its author**, per the plan's own "done when" bar for step 3.1 —
   the most direct next step, and the one most likely to surface anything
   this summary hasn't anticipated.
