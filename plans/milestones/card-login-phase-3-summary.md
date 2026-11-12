# Card Login — Phase 3 Summary (Plan the code changes)

> **Renamed 2026-11-09:** "developer card" is now **login service card**, and the app-certification root has three branches (wallet, app, login service). This document is a historical record and keeps the old terms; see `plans/card-login-spec-changes.md` §Amendment 2026-11-09.

Date: 2026-11-09 · Output: [card-login-code-plan.md](../card-login-code-plan.md)

Phase 3 mapped every approved spec change to code. Login touches the TypeScript verifier and its RPC provider, the press, both SDKs, a new `login-router/` package, and the integration fixtures and harness, with Python verifier parity at the end. The wallet service, relay, and contracts need no changes: the contract already exposes the domain-registration read, so CP4 is not triggered by code. Every acceptance criterion in the login specs maps to a named unit, browser, or integration test, and the build order lets the press, app-sdk, and Python tracks run in parallel once the verifier lands. Reading the code turned up two existing gaps that decide how much Stage 2 and press work Phase 4 includes. The verifier implements none of the spec'd sub-card capability, expiry, or attestation checks (F1), and the press accepts an app card whose chain reaches any trusted root rather than the app-certification root (F2). Also, the `dev-tests` suite runs on Sepolia, so its login suite waits for David to provision the developer branch there (CP4).

**Decisions needed before Phase 4:** F1 (recommended: implement the missing Stage 2 checks for all sub-cards) and F2 (recommended: give the press explicit app-certification and developer-branch roots and require the app-certification root). No approval is otherwise required to start the build.
