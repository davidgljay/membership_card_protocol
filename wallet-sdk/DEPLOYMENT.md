# wallet-sdk — Deployment (npm publish)

Publishes `@membership-card-protocol/wallet-sdk`.

## Publish order

Depends on `@membership-card-protocol/app-sdk` via a committed `file:`
reference, rewritten to a real npm version at publish time — see
`app-sdk/DEPLOYMENT.md`'s "Publish order" section for how and why. Must
publish **after** `app-sdk` (dev publishes will fail loudly if `app-sdk`
hasn't published its `next` version yet). This is the last package in the
six-package dependency chain — see `app-sdk/DEPLOYMENT.md` for the full
order.

(`sdk-providers-rn`/`sdk-providers-web` appear as `devDependencies` here, for
this package's own test suite only — not a publish-order constraint on
`wallet-sdk` itself, since devDependencies aren't installed by consumers.)

## Running the publish script

```bash
cd wallet-sdk
./scripts/publish.sh dev     # or: prod
```

Add `--dry-run` to build/test/pack without actually publishing. See
`membership_card_verifier/DEPLOYMENT.md` for exactly what the script does.

## Required environment variables

| Variable | Description |
|---|---|
| `NODE_AUTH_TOKEN` | npm auth token with publish rights to `@membership-card-protocol/*`. |
