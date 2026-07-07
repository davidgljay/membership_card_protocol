# Card Protocol — Wallet SDK

Monorepo for `@membership-card-protocol/wallet-sdk`, the wallet-side,
key-custody half of holder-side functionality split out of the unified
`client-sdk`. See
[`specs/object_specs/wallet_sdk.md`](../specs/object_specs/wallet_sdk.md) and
[`plans/sdk-split-strategic-plan.md`](../plans/sdk-split-strategic-plan.md) /
[`plans/sdk-split-implementation-plan.md`](../plans/sdk-split-implementation-plan.md)
for the design and split this workspace follows.

## Packages

- `packages/wallet-sdk` — `@membership-card-protocol/wallet-sdk`, the core package: wallet setup, keyring, backup/recovery, sub-card authorization (granter side), and card offer review/countersign/acceptance (recipient side). Depends on `@membership-card-protocol/app-sdk`.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm -r lint
```
