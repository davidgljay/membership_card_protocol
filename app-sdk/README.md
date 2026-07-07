# Card Protocol — App SDK

Monorepo for `@membership-card-protocol/app-sdk`, the app-side, key-independent
half of holder-side functionality split out of the unified `client-sdk`. See
[`specs/object_specs/app_sdk.md`](../specs/object_specs/app_sdk.md) and
[`plans/sdk-split-strategic-plan.md`](../plans/sdk-split-strategic-plan.md) /
[`plans/sdk-split-implementation-plan.md`](../plans/sdk-split-implementation-plan.md)
for the design and split this workspace follows.

## Packages

- `packages/app-sdk` — `@membership-card-protocol/app-sdk`, the core package: provider interfaces, crypto, verifier integration, offer construction, sub-card requests, and messaging. Platform-independent. Does not custody any private key or backup material — see `specs/object_specs/wallet_sdk.md` for the counterpart package that does.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm -r lint
```
