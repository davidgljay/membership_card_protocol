# Login router

The static site that forwards a card-login request from a website to the user's registered wallet. Spec: [`specs/object_specs/login_router.md`](../specs/object_specs/login_router.md). Flow: [`specs/process_specs/card_login.md`](../specs/process_specs/card_login.md).

- `src/core.ts` — all router rules (choosing a wallet, add-only registration, token validation, storage). Pure functions, unit-tested.
- `src/pages.ts` — browser glue for `/login`, `/register`, and `/settings`.
- `public/` — the three pages, stylesheet, and `_headers` (CSP, no referrer, no framing).
- `wallets.json` — the certified wallet list baked into the build (§5). Empty in the repo; generated from wallet cards under the wallet branch as part of deployment.

## Commands

```bash
npm install
npm test            # unit tests (src/core.ts)
npm run build       # dist/
npm run test:e2e    # Playwright in Chromium, Firefox, WebKit (needs `npx playwright install` once)
```

The browser tests build a separate copy (`dist-test/`) with two test wallets baked in, and intercept the `https://*.test` hosts they use for wallet pages, so they make no external requests.

Tests: 23 unit tests, 27 browser tests (all passing 2026-11-10). The integration harness (`integration_tests/harnesses/web/test/login.spec.ts`) also runs a full same-device login through a built router.

## Not done yet

- Generating `wallets.json` from the chain (needs the wallet branch address and an RPC/IPFS endpoint; part of deployment, checkpoint CP5).
- Choosing the router's domain and deploying it (CP5).
