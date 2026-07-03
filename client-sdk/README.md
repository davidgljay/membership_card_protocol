# Card Protocol — Client SDK

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
