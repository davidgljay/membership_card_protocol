# membership_card_verifier — Deployment (npm publish)

This workspace holds four packages under `packages/`. Three are npm
packages in scope for automated publish; the fourth, `verifier-py`, is a
Python package published to PyPI separately and is **not** covered by this
document or by `scripts/publish.sh`.

| Package | Publishable via this doc? | Depended on by (in-repo) |
|---|---|---|
| `@membership-card-protocol/verifier` | Yes | `app-sdk`, `press`, `wallet-service` (all via `file:` — see their own package.json) |
| `@membership-card-protocol/verifier-ipfs-provider` | Yes | `app-sdk` (via `file:`) |
| `@membership-card-protocol/verifier-rpc-provider` | Yes | No current in-repo dependent — publish for external consumers |
| `verifier-py` | No — PyPI, out of scope | `matrix-policy-module` (Python) |

**This is a scope note vs. the deployment strategic/implementation plans**:
those documents refer to "membership_card_verifier" as a single npm package.
It is actually three. `verifier-ipfs-provider` in particular has a real
in-repo dependent (`app-sdk`) and must be published before `app-sdk` — see
`plans/deployment/phase-1-summary.md` for the correction.

## Running the publish script

```bash
cd membership_card_verifier
./scripts/publish.sh verifier dev              # or: prod
./scripts/publish.sh verifier-ipfs-provider dev
./scripts/publish.sh verifier-rpc-provider dev
```

Add `--dry-run` to build/test/pack without actually publishing to npm — use
this to validate the pipeline before a real publish.

Each invocation:
1. Installs the workspace (`pnpm install --frozen-lockfile`).
2. **Dev only:** bumps the package's version to
   `<version>-dev.<git-sha>.<timestamp>` (never a fixed dev version — avoids
   colliding with a prior dev publish), then reverts `package.json` on exit
   so the working tree is unchanged afterward. **Prod:** publishes whatever
   version is already committed in `package.json` — matches
   `publish-verifier.yml`'s existing tag-triggered convention, where a human
   bumps the version and creates a `verifier/vX` tag before publish runs.
3. Builds (`pnpm run build`) and tests (`pnpm run test`).
4. `npm publish --tag next` (dev) or `--tag latest` (prod). Adds
   `--provenance` automatically when run inside GitHub Actions
   (`GITHUB_ACTIONS` env var set), matching `publish-verifier.yml`.

## Required environment variables

| Variable | Description |
|---|---|
| `NODE_AUTH_TOKEN` | npm auth token with publish rights to `@membership-card-protocol/*`. Same secret name `publish-verifier.yml` already uses (`secrets.NPM_TOKEN` mapped to this env var in CI). |

## Publish order

Within this workspace: `verifier` has no dependency on the other two and
should publish first. `verifier-ipfs-provider` depends on `verifier` at
**build time** only (`workspace:*` devDependency, for its own tests) — it
does not need `verifier` published to npm first, only built locally, which
`pnpm install` + workspace linking already provides.
`verifier-rpc-provider` is independent (only `ethers` as a peer dependency).

Across the full six-package graph (see `app-sdk/DEPLOYMENT.md` for the
complete order), `verifier` and `verifier-ipfs-provider` must both be
published to npm **before** `app-sdk`, since `app-sdk`'s `dependencies`
resolve them by npm version, not `file:`, once published.
