# app-sdk — Deployment (npm publish)

Publishes `@membership-card-protocol/app-sdk`.

## Publish order (all six packages)

`app-sdk`'s `dependencies` declare `verifier` and `verifier-ipfs-provider`
via `file:../../../membership_card_verifier/...` — this is intentional and
stays that way in the committed tree (see the `"//"` comment in
`package.json`), since these five packages are separate pnpm workspaces and
`file:` is the only way to reference an unpublished package living in a
different top-level directory. `scripts/publish.sh` rewrites these to real
npm-resolvable versions right before packing, via the repo-root
`scripts/rewrite-file-deps.mjs` (called from `scripts/publish-npm-package.sh`):
dev publishes pin the exact version currently published under each
dependency's `next` tag (and fail loudly if that dependency hasn't been
dev-published yet — enforcing the order below); prod publishes use a caret
range against the dependency's current local version. `package.json` is
reverted via `git checkout` immediately after publish either way, so the
rewrite never lands in the committed tree.

Full dependency order across all six in-scope npm packages — dev publishes
must happen in this order since each step's rewrite depends on the previous
step's package already being published under `next`:

1. `@membership-card-protocol/verifier` (`membership_card_verifier/scripts/publish.sh verifier`)
2. `@membership-card-protocol/verifier-ipfs-provider` (`membership_card_verifier/scripts/publish.sh verifier-ipfs-provider`)
3. **`@membership-card-protocol/app-sdk`** (this package — depends on both of the above)
4. `@membership-card-protocol/sdk-providers-web` (depends on `app-sdk`)
5. `@membership-card-protocol/sdk-providers-rn` (depends on `app-sdk`)
6. `@membership-card-protocol/wallet-sdk` (depends on `app-sdk`; dev-depends on both providers packages for its own tests, not a publish-order constraint)

## Running the publish script

```bash
cd app-sdk
./scripts/publish.sh dev     # or: prod
```

Add `--dry-run` to build/test/pack without actually publishing.

See `membership_card_verifier/DEPLOYMENT.md` for exactly what the script
does (dev prerelease versioning, build/test, dist-tag selection,
provenance).

## Required environment variables

| Variable | Description |
|---|---|
| `NODE_AUTH_TOKEN` | npm auth token with publish rights to `@membership-card-protocol/*`. |
