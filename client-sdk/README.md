# Card Protocol — Client SDK

> **⚠️ DEPRECATED (2026-07-16).** This package is superseded by the split
> `app-sdk`/`wallet-sdk` packages and should not be used for new work. It is
> **not** the same as `client-sdk-old/` (a pre-split reference/rollback point) —
> this package is still the actual, currently-working implementation of the
> protocol's Matrix client-side functionality (`packages/client-sdk/src/matrix/` —
> signed room events, shadow-account-id derivation, the sender-binding security
> check), which has not yet been ported to `app-sdk`/`wallet-sdk`. Do not delete
> or stop maintaining this package's Matrix code until that port happens — see
> `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3
> item (h) for the full context and the still-open question of what "ported"
> should mean here.

Monorepo for `@membership-card-protocol/client-sdk` and its default platform
providers. See [`plans/client-sdk/strategic-plan.md`](../plans/client-sdk/strategic-plan.md)
and [`plans/client-sdk/implementation-plan.md`](../plans/client-sdk/implementation-plan.md)
for the design and phased build-out this workspace follows.

## Packages

- `packages/client-sdk` — `@membership-card-protocol/client-sdk`, the core package: protocol logic, provider interfaces, crypto, verifier integration. Platform-independent.
- `packages/client-sdk-web` — `@membership-card-protocol/client-sdk-web`, default browser provider implementations.
- `packages/client-sdk-rn` — `@membership-card-protocol/client-sdk-rn`, default React Native provider implementations.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm -r lint
```

`packages/client-sdk` and `packages/client-sdk-web` are tested with Vitest;
`packages/client-sdk-rn` is tested with Jest under the React Native preset.
This workspace pins `node-linker=hoisted` (see `.npmrc`) because the React
Native Jest preset's `transformIgnorePatterns` assumes a flat `node_modules`
layout.
