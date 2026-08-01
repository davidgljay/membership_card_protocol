# Phase 1 Summary — Per-package deploy scripts + READMEs

Strategic plan: [strategic-plan.md](./strategic-plan.md) · Implementation plan: [implementation-plan.md](./implementation-plan.md)

## What shipped

Every deployable package now has a `deploy.sh`/`publish.sh` taking an
explicit `dev`/`prod` argument (never inferred from branch/hostname), and a
`DEPLOYMENT.md` documenting required env vars and setup steps:

- **press** — `press/scripts/deploy.sh`, `press/DEPLOYMENT.md`. Added
  `[env.dev]`/`[env.prod]` blocks to `wrangler.toml` (didn't exist before).
- **wallet-service** — `wallet-service/scripts/deploy.sh`,
  `wallet-service/DEPLOYMENT.md`. Added `[env.dev]`/`[env.prod]` blocks; fixed
  a real bug (see below).
- **relay** — `relay/scripts/deploy.sh`, `relay/.do/app.dev.yaml`,
  `relay/.do/app.prod.yaml`, `relay/DEPLOYMENT.md`. Added
  `relay/docker-entrypoint.sh` + `relay/scripts/materialize-secrets.mjs` to
  bridge a real App Platform gap (see below). No real DigitalOcean resources
  were created — per the Phase 1 clarification checkpoint, that requires
  David's go-ahead first.
- **membership_card_verifier, app-sdk, wallet-sdk, sdk-providers-web,
  sdk-providers-rn** — a shared `scripts/publish-npm-package.sh` at repo
  root plus a thin `<package>/scripts/publish.sh` wrapper per package (six
  total — see below on why five became six), and a `DEPLOYMENT.md` per
  package. No real npm publish was performed; the pipeline was verified with
  `--dry-run` against `@membership-card-protocol/verifier`.

All scripts fail loudly (`::error::` prefixed, full list of every missing
var in one pass) on missing config, matching the existing
`relay-deploy.yml`/`wallet-service-ci.yml` `validate-secrets` pattern. Env
var naming is consistent across scripts and docs — no package refers to the
same concept by two different names (`CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_ACCOUNT_ID` identical in press and wallet-service;
`NODE_AUTH_TOKEN` identical across all npm publish scripts).

## Real bugs found and fixed along the way

0. **(Found during Phase 3, corrected here) `press/scripts/deploy.sh` and
   `press/DEPLOYMENT.md` were missing four required env vars.** Both were
   built from `OPERATOR.md`'s "Required" table, which turned out to be stale
   relative to `press/src/config.ts`'s actual `loadConfig()` —
   `PRESS_GAS_WALLET_PRIVATE_KEY`, `PRESS_OHTTP_PRIVATE_KEY`,
   `STORAGE_CONTRACT_ADDRESS`, and `PRESS_ADMIN_API_KEY` are all
   unconditionally `requireEnv()`'d (press exits at startup without them),
   but none appeared in `OPERATOR.md` or the original deploy script/docs. A
   real deploy with the original script would have pushed a Worker that
   crash-loops on every request. Found while porting
   `dev-tests/suites/extended/subcard_creation_policy.spec.ts`, which calls
   press's admin API and needed `PRESS_ADMIN_API_KEY` to exist as a concept
   at all. Fixed in both files; see `phase-3-summary.md` for the discovery
   context.
1. **`wallet-service/wrangler.toml` pointed `main` at a build path that
   never existed.** `nitro.config.ts` keys the build output directory off
   `NITRO_PRESET` (`.output-${NITRO_PRESET}`) specifically to stop the
   cloudflare/node/lambda presets from overwriting each other's artifact —
   but `wrangler.toml`'s `main` still pointed at the old shared
   `.output/server/index.mjs` path. `wrangler deploy` would have failed with
   a missing-file error on every real deploy attempt. Fixed: `main` now
   points at `.output-cloudflare-module/server/index.mjs`, confirmed against
   an actual `pnpm run build:cloudflare` run. `.gitignore` was also missing
   a `.output-*/` pattern (only had `.output/`) — fixed alongside.
2. **DigitalOcean App Platform has no persistent-volume mechanism**, but
   `relay`'s docker-compose deployment relies on volume mounts for both the
   SQLite device registry and the app-registry/push-credential config files.
   Config/credentials: resolved by materializing both from env vars at
   container start (`docker-entrypoint.sh` + `scripts/materialize-secrets.mjs`,
   a no-op under docker-compose since the relevant env vars are unset there).
   SQLite device registry: **not resolved** — flagged as a blocker to
   correct before Phase 2/4 treats relay prod deploys as safe (see
   `strategic-plan.md`'s corrected Open Question 2).

## Corrections to the strategic/implementation plans

- **`membership_card_verifier` is three npm packages, not one** (`verifier`,
  `verifier-ipfs-provider`, `verifier-rpc-provider`, plus the out-of-scope
  Python `verifier-py`). `verifier-ipfs-provider` is a real runtime
  dependency of `app-sdk` and must publish before it. Corrected in
  `strategic-plan.md` Goal 1.
- **`relay/README.md` §2.2 ("Required secrets")**, referenced by both
  `relay-deploy.yml`'s validate-secrets step and the implementation plan's
  Context-needed list for 1.3, does not exist in the current README — it's a
  stale reference from before a refactor (current README has no numbered
  sections at all). Used `relay/.env.example` as the source of truth for
  actual required env vars instead.
- **`relay-deploy.yml`'s secret list is for the old Cloudflare-era relay,
  not the current Docker one.** It checks `REDIS_PRIMARY_URL`,
  `INTERNAL_API_SECRET`, `APP_REGISTRY_JSON`, `CLOUDFLARE_*` — but the
  current `relay/.env.example` has `REDIS_URL` (not `REDIS_PRIMARY_URL`), no
  `INTERNAL_API_SECRET`, and `APP_REGISTRY_PATH` as a file path rather than
  `APP_REGISTRY_JSON` as a pre-existing env var (that name is now used
  instead for the new env-var materialization path added in this phase).
  The implementation plan's instruction to "reuse its secret list" doesn't
  hold; `relay/scripts/deploy.sh` and `.do/app.*.yaml` use the current
  `.env.example` as ground truth instead.
- **Open Question 5 (secret storage mechanism) is resolved**: non-secret
  config is pushed via `doctl`/the checked-in app spec; real secrets are set
  once, out-of-band, directly on the DO app — never through CI or the
  deploy script.

## Outstanding items before Phase 2

- ~~`file:` dependencies would break published tarballs~~ **Resolved**:
  added `scripts/rewrite-file-deps.mjs`, called from
  `scripts/publish-npm-package.sh` right before `npm publish`. It rewrites
  any `@membership-card-protocol/*` `file:` dependency to a real
  npm-resolvable version — a caret range against the dependency's current
  local version for prod, or the exact version currently published under
  `next` for dev (which also enforces publish order for free: publishing a
  dependent before its dependency has a `next` version now fails loudly with
  a clear message instead of silently embedding a broken path). The `file:`
  references stay in the committed `package.json` files on purpose (that's
  still the only way to link an unpublished package across these five
  separate pnpm workspaces for local dev/build/test) — only the packed
  tarball ever sees the rewritten version. Verified end-to-end with
  `--dry-run` for all five dependent packages.

  **Bug found and fixed during this work**: the original revert mechanism
  used `git checkout -- package.json` on exit to undo the script's own
  mutations. That's wrong whenever `package.json` already had an unrelated
  uncommitted edit before the script ran — `git checkout` discards *all*
  uncommitted changes, not just the script's own, silently destroying
  unrelated work sitting in the working tree (caught live: an in-progress
  doc-comment edit to `wallet-sdk/package.json` was wiped by a later,
  unrelated package's publish run). Fixed by snapshotting the exact
  pre-mutation bytes to a temp file and restoring that exact snapshot on
  exit, regardless of git state.
- relay's SQLite device-registry persistence gap on App Platform (above).
- Real DigitalOcean App Platform apps and real npm publishes still need to
  happen at least once to fully satisfy each 1.1–1.4 "Done when" criteria
  (dry-run/config-only verification was done in this phase; actual
  first-deploys need David's go-ahead per the clarification checkpoint).
