# Card Protocol — Client SDK

> **⚠️ DEPRECATED (2026-07-31).** This package is superseded by the split
> `app-sdk`/`wallet-sdk` packages and should not be used for new work. Its
> Matrix module has been ported to `app-sdk`/`wallet-sdk` (see
> `plans/deployment/client-sdk-deprecation-plan.md`), `integration_tests` no
> longer depends on it, and it has been renamed from `client-sdk/` to
> `client-sdk-old/` and dropped from CI (`.github/workflows/client-sdk-ci.yml`
> removed, `run.sh`'s client-sdk step removed) as the first step of retiring
> it. It is kept around only in case something outside this repo still
> depends on the published package; do not build on it further.

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
