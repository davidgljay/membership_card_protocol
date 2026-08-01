# sdk-providers-rn — Deployment (npm publish)

Publishes `@membership-card-protocol/sdk-providers-rn`.

## Publish order

Depends on `@membership-card-protocol/app-sdk` via a committed `file:`
reference, rewritten to a real npm version at publish time — see
`app-sdk/DEPLOYMENT.md`'s "Publish order" section for how and why. Must
publish **after** `app-sdk` (dev publishes will fail loudly if `app-sdk`
hasn't published its `next` version yet). See `app-sdk/DEPLOYMENT.md` for
the full six-package order.

## Running the publish script

```bash
cd sdk-providers-rn
./scripts/publish.sh dev     # or: prod
```

Add `--dry-run` to build/test/pack without actually publishing. See
`membership_card_verifier/DEPLOYMENT.md` for exactly what the script does.

Note: this package's `test` script runs Jest, not Vitest (React Native's
tooling) — the shared publish script calls `pnpm run test` generically, so
this difference is transparent to it.

## Required environment variables

| Variable | Description |
|---|---|
| `NODE_AUTH_TOKEN` | npm auth token with publish rights to `@membership-card-protocol/*`. |
